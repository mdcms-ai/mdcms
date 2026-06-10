import {
  RuntimeError,
  isRuntimeErrorLike,
  type ResolveErrorsMap,
  type MdcmsFileFieldMetadata,
  type MediaAsset,
  type SchemaRegistryFieldSnapshot,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import {
  mediaAssetMatchesFileField,
  normalizeMimeType,
} from "./media-field-validation.js";
import type { ContentMediaAssetLookup, ContentScope } from "./types.js";

export type FileFieldReadMode = "expanded" | "raw";

type ContentMediaResolveError = {
  code: "MEDIA_NOT_FOUND" | "MEDIA_TYPE_MISMATCH";
  message: string;
  media: {
    assetId: string;
    expectedMime?: string[];
    actualMimeType?: string;
  };
};

type ExpansionContext = {
  scope: ContentScope;
  lookupMediaAsset: ContentMediaAssetLookup;
  resolveErrors: ResolveErrorsMap;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldContainsFileField(field: SchemaRegistryFieldSnapshot): boolean {
  if (field.file) {
    return true;
  }

  if (field.kind === "object" && field.fields) {
    return Object.values(field.fields).some((nestedField) =>
      fieldContainsFileField(nestedField),
    );
  }

  if (field.kind === "array" && field.item) {
    return fieldContainsFileField(field.item);
  }

  return false;
}

function schemaContainsFileFields(schema: SchemaRegistryTypeSnapshot): boolean {
  return Object.values(schema.fields).some((field) =>
    fieldContainsFileField(field),
  );
}

function findFirstFileFieldPath(
  fields: Record<string, SchemaRegistryFieldSnapshot>,
  basePath = "frontmatter",
): string | undefined {
  for (const [fieldName, field] of Object.entries(fields)) {
    const fieldPath = `${basePath}.${fieldName}`;

    if (field.file) {
      return fieldPath;
    }

    if (field.kind === "object" && field.fields) {
      const nestedPath = findFirstFileFieldPath(field.fields, fieldPath);
      if (nestedPath) {
        return nestedPath;
      }
    }

    if (field.kind === "array" && field.item) {
      if (fieldContainsFileField(field.item)) {
        return `${fieldPath}[0]`;
      }
    }
  }

  return undefined;
}

function createLookupUnavailableError(
  schema: SchemaRegistryTypeSnapshot,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_ASSET_LOOKUP_UNAVAILABLE",
    message:
      "Media asset lookup is unavailable for schema file field expansion.",
    statusCode: 500,
    details: {
      field: findFirstFileFieldPath(schema.fields) ?? "frontmatter",
    },
  });
}

function presetExpectedMime(file: MdcmsFileFieldMetadata): string | undefined {
  if (file.preset === "image") {
    return "image/*";
  }

  if (file.preset === "video") {
    return "video/*";
  }

  return undefined;
}

function expectedMimeForFileField(file: MdcmsFileFieldMetadata): string[] {
  if (file.accept.length > 0) {
    return file.accept.map((entry) => normalizeMimeType(entry));
  }

  const preset = presetExpectedMime(file);
  return preset ? [preset] : ["*/*"];
}

function createMediaResolveError(input: {
  code: ContentMediaResolveError["code"];
  assetId: string;
  expectedMime?: string[];
  actualMimeType?: string;
}): ContentMediaResolveError {
  return {
    code: input.code,
    message:
      input.code === "MEDIA_NOT_FOUND"
        ? "Media asset could not be resolved in the target project/environment."
        : "Media asset MIME type does not match the schema file field.",
    media: {
      assetId: input.assetId,
      ...(input.expectedMime ? { expectedMime: input.expectedMime } : {}),
      ...(input.actualMimeType ? { actualMimeType: input.actualMimeType } : {}),
    },
  };
}

function setMediaResolveError(
  resolveErrors: ResolveErrorsMap,
  path: string,
  error: ContentMediaResolveError,
): void {
  resolveErrors[path] = error as unknown as ResolveErrorsMap[string];
}

function isMalformedMediaIdLookupError(error: unknown): boolean {
  return (
    isRuntimeErrorLike(error) &&
    error.code === "INVALID_INPUT" &&
    error.statusCode === 400 &&
    error.details?.field === "id"
  );
}

function isUnsetFileFieldValue(
  value: unknown,
  field: SchemaRegistryFieldSnapshot,
): boolean {
  if (value === undefined) {
    return !field.required;
  }

  if (value === null) {
    return field.nullable;
  }

  return (
    typeof value === "string" &&
    value.trim().length === 0 &&
    field.file?.emptyStringAsUnset === true
  );
}

async function lookupAsset(input: {
  value: string;
  field: SchemaRegistryFieldSnapshot;
  path: string;
  context: ExpansionContext;
}): Promise<MediaAsset | null> {
  const assetId = input.value.trim();
  let asset: MediaAsset | undefined;

  try {
    asset = await input.context.lookupMediaAsset(input.context.scope, assetId);
  } catch (error) {
    if (!isMalformedMediaIdLookupError(error)) {
      throw error;
    }
  }

  if (!asset) {
    setMediaResolveError(
      input.context.resolveErrors,
      input.path,
      createMediaResolveError({
        code: "MEDIA_NOT_FOUND",
        assetId,
      }),
    );
    return null;
  }

  if (!mediaAssetMatchesFileField(asset, input.field.file!)) {
    setMediaResolveError(
      input.context.resolveErrors,
      input.path,
      createMediaResolveError({
        code: "MEDIA_TYPE_MISMATCH",
        assetId,
        expectedMime: expectedMimeForFileField(input.field.file!),
        actualMimeType: normalizeMimeType(asset.mimeType),
      }),
    );
    return null;
  }

  return asset;
}

async function expandFileField(input: {
  value: unknown;
  field: SchemaRegistryFieldSnapshot;
  path: string;
  context: ExpansionContext;
}): Promise<unknown> {
  if (isUnsetFileFieldValue(input.value, input.field)) {
    return null;
  }

  if (typeof input.value !== "string" || input.value.trim().length === 0) {
    setMediaResolveError(
      input.context.resolveErrors,
      input.path,
      createMediaResolveError({
        code: "MEDIA_NOT_FOUND",
        assetId: typeof input.value === "string" ? input.value.trim() : "",
      }),
    );
    return null;
  }

  return lookupAsset({
    value: input.value,
    field: input.field,
    path: input.path,
    context: input.context,
  });
}

async function expandField(input: {
  value: unknown;
  field: SchemaRegistryFieldSnapshot;
  path: string;
  context: ExpansionContext;
}): Promise<unknown> {
  if (input.field.file) {
    return expandFileField(input);
  }

  if (!fieldContainsFileField(input.field)) {
    return input.value;
  }

  if (input.value === undefined || input.value === null) {
    return null;
  }

  if (input.field.kind === "object" && input.field.fields) {
    if (!isRecord(input.value)) {
      return null;
    }

    const expandedObject: Record<string, unknown> = { ...input.value };

    for (const [fieldName, field] of Object.entries(input.field.fields)) {
      expandedObject[fieldName] = await expandField({
        value: input.value[fieldName],
        field,
        path: `${input.path}.${fieldName}`,
        context: input.context,
      });
    }

    return expandedObject;
  }

  if (input.field.kind === "array" && input.field.item) {
    if (!Array.isArray(input.value)) {
      return null;
    }

    return Promise.all(
      input.value.map((entry, index) =>
        expandField({
          value: entry,
          field: input.field.item!,
          path: `${input.path}[${index}]`,
          context: input.context,
        }),
      ),
    );
  }

  return input.value;
}

export async function applyMediaFieldExpansion<
  TDocument extends {
    frontmatter: Record<string, unknown>;
    resolveErrors?: ResolveErrorsMap;
  },
>(input: {
  schema: SchemaRegistryTypeSnapshot | undefined;
  document: TDocument;
  scope: ContentScope;
  lookupMediaAsset?: ContentMediaAssetLookup;
  mode: FileFieldReadMode;
}): Promise<TDocument> {
  if (input.mode === "raw" || !input.schema) {
    return input.document;
  }

  if (!schemaContainsFileFields(input.schema)) {
    return input.document;
  }

  if (!input.lookupMediaAsset) {
    throw createLookupUnavailableError(input.schema);
  }

  const resolveErrors: ResolveErrorsMap = {
    ...(input.document.resolveErrors ?? {}),
  };
  const context: ExpansionContext = {
    scope: input.scope,
    lookupMediaAsset: input.lookupMediaAsset,
    resolveErrors,
  };
  const expandedDocument = {
    ...input.document,
    frontmatter: structuredClone(input.document.frontmatter),
  };

  for (const [fieldName, field] of Object.entries(input.schema.fields)) {
    if (!fieldContainsFileField(field)) {
      continue;
    }

    expandedDocument.frontmatter[fieldName] = await expandField({
      value: expandedDocument.frontmatter[fieldName],
      field,
      path: `frontmatter.${fieldName}`,
      context,
    });
  }

  if (Object.keys(resolveErrors).length === 0) {
    delete expandedDocument.resolveErrors;
    return expandedDocument;
  }

  return {
    ...expandedDocument,
    resolveErrors,
  };
}
