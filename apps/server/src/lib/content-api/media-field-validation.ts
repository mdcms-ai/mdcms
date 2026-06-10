import {
  RuntimeError,
  type MdcmsFileFieldMetadata,
  type MediaAsset,
  type SchemaRegistryFieldSnapshot,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import type { ContentMediaAssetLookup, ContentScope } from "./types.js";

type MediaFieldValidationReason =
  | "MEDIA_REQUIRED"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_TYPE_MISMATCH"
  | "MEDIA_CONTAINER_TYPE_MISMATCH";

type NormalizedFieldValue =
  | {
      include: true;
      value: unknown;
    }
  | {
      include: false;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsFileField(field: SchemaRegistryFieldSnapshot): boolean {
  if (field.file) {
    return true;
  }

  if (field.kind === "array" && field.item) {
    return containsFileField(field.item);
  }

  if (field.kind === "object" && field.fields) {
    return Object.values(field.fields).some((entry) =>
      containsFileField(entry),
    );
  }

  return false;
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

    if (field.kind === "array" && field.item && containsFileField(field.item)) {
      return `${fieldPath}[0]`;
    }
  }

  return undefined;
}

function schemaContainsFileFields(
  schema: SchemaRegistryTypeSnapshot,
): string | undefined {
  return findFirstFileFieldPath(schema.fields);
}

function createLookupUnavailableError(field: string): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_ASSET_LOOKUP_UNAVAILABLE",
    message:
      "Media asset lookup is unavailable for schema file field validation.",
    statusCode: 500,
    details: { field },
  });
}

function createMediaFieldValidationError(input: {
  fieldPath: string;
  reason: MediaFieldValidationReason;
  mediaAssetId?: string;
  expectedMime?: string;
  actualMimeType?: string;
}): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message: `Field "${input.fieldPath}" must reference a media asset matching this file field.`,
    statusCode: 400,
    details: {
      field: input.fieldPath,
      ...(input.mediaAssetId ? { mediaAssetId: input.mediaAssetId } : {}),
      reason: input.reason,
      ...(input.expectedMime ? { expectedMime: input.expectedMime } : {}),
      ...(input.actualMimeType ? { actualMimeType: input.actualMimeType } : {}),
    },
  });
}

export function normalizeMimeType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

function matchesMimePattern(actualMimeType: string, pattern: string): boolean {
  const normalizedPattern = normalizeMimeType(pattern);

  if (normalizedPattern.endsWith("/*")) {
    return actualMimeType.startsWith(normalizedPattern.slice(0, -1));
  }

  return actualMimeType === normalizedPattern;
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

function expectedMimeForFileField(file: MdcmsFileFieldMetadata): string {
  if (file.accept.length > 0) {
    return file.accept.map((entry) => normalizeMimeType(entry)).join(",");
  }

  return presetExpectedMime(file) ?? "*/*";
}

export function mediaAssetMatchesFileField(
  asset: Pick<MediaAsset, "mimeType">,
  file: MdcmsFileFieldMetadata,
): boolean {
  const actualMimeType = normalizeMimeType(asset.mimeType);
  const expectedPreset = presetExpectedMime(file);

  if (expectedPreset && !matchesMimePattern(actualMimeType, expectedPreset)) {
    return false;
  }

  if (file.accept.length === 0) {
    return true;
  }

  return file.accept.some((entry) => matchesMimePattern(actualMimeType, entry));
}

function isUnsetByOptionalFileHelper(
  value: unknown,
  field: SchemaRegistryFieldSnapshot,
): boolean {
  if (!field.file?.emptyStringAsUnset || field.required) {
    return false;
  }

  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

async function validateConcreteFileField(input: {
  value: unknown;
  field: SchemaRegistryFieldSnapshot;
  fieldPath: string;
  scope: ContentScope;
  lookupMediaAsset: ContentMediaAssetLookup;
}): Promise<NormalizedFieldValue> {
  let value = input.value;

  if (value === undefined && input.field.default !== undefined) {
    value = input.field.default;
  }

  if (isUnsetByOptionalFileHelper(value, input.field)) {
    return { include: false };
  }

  if (value === undefined) {
    if (!input.field.required) {
      return { include: false };
    }

    throw createMediaFieldValidationError({
      fieldPath: input.fieldPath,
      reason: "MEDIA_REQUIRED",
    });
  }

  if (value === null) {
    if (input.field.nullable) {
      return { include: true, value: null };
    }

    throw createMediaFieldValidationError({
      fieldPath: input.fieldPath,
      reason: "MEDIA_REQUIRED",
    });
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw createMediaFieldValidationError({
      fieldPath: input.fieldPath,
      reason: "MEDIA_REQUIRED",
    });
  }

  const mediaAssetId = value.trim();
  const asset = await input.lookupMediaAsset(input.scope, mediaAssetId);

  if (!asset) {
    throw createMediaFieldValidationError({
      fieldPath: input.fieldPath,
      mediaAssetId,
      reason: "MEDIA_NOT_FOUND",
    });
  }

  if (!mediaAssetMatchesFileField(asset, input.field.file)) {
    throw createMediaFieldValidationError({
      fieldPath: input.fieldPath,
      mediaAssetId,
      reason: "MEDIA_TYPE_MISMATCH",
      expectedMime: expectedMimeForFileField(input.field.file),
      actualMimeType: normalizeMimeType(asset.mimeType),
    });
  }

  return { include: true, value: mediaAssetId };
}

async function normalizeFieldValue(input: {
  value: unknown;
  field: SchemaRegistryFieldSnapshot;
  fieldPath: string;
  scope: ContentScope;
  lookupMediaAsset: ContentMediaAssetLookup;
}): Promise<NormalizedFieldValue> {
  if (input.field.file) {
    return validateConcreteFileField(input);
  }

  if (input.field.kind === "object" && input.field.fields) {
    if (!containsFileField(input.field)) {
      return input.value === undefined
        ? { include: false }
        : { include: true, value: input.value };
    }

    if (input.value === undefined) {
      return { include: false };
    }

    if (input.value === null) {
      if (input.field.nullable) {
        return { include: true, value: null };
      }

      throw createMediaFieldValidationError({
        fieldPath: input.fieldPath,
        reason: "MEDIA_CONTAINER_TYPE_MISMATCH",
      });
    }

    if (!isRecord(input.value)) {
      throw createMediaFieldValidationError({
        fieldPath: input.fieldPath,
        reason: "MEDIA_CONTAINER_TYPE_MISMATCH",
      });
    }

    const normalizedObject: Record<string, unknown> = { ...input.value };

    for (const [fieldName, field] of Object.entries(input.field.fields)) {
      const normalized = await normalizeFieldValue({
        value: input.value[fieldName],
        field,
        fieldPath: `${input.fieldPath}.${fieldName}`,
        scope: input.scope,
        lookupMediaAsset: input.lookupMediaAsset,
      });

      if (normalized.include) {
        normalizedObject[fieldName] = normalized.value;
      } else {
        delete normalizedObject[fieldName];
      }
    }

    return { include: true, value: normalizedObject };
  }

  if (input.field.kind === "array" && input.field.item) {
    if (!containsFileField(input.field)) {
      return input.value === undefined
        ? { include: false }
        : { include: true, value: input.value };
    }

    if (input.value === undefined) {
      return { include: false };
    }

    if (input.value === null) {
      if (input.field.nullable) {
        return { include: true, value: null };
      }

      throw createMediaFieldValidationError({
        fieldPath: input.fieldPath,
        reason: "MEDIA_CONTAINER_TYPE_MISMATCH",
      });
    }

    if (!Array.isArray(input.value)) {
      throw createMediaFieldValidationError({
        fieldPath: input.fieldPath,
        reason: "MEDIA_CONTAINER_TYPE_MISMATCH",
      });
    }

    const normalizedArray = [];

    for (const [index, entry] of input.value.entries()) {
      const normalized = await normalizeFieldValue({
        value: entry,
        field: input.field.item,
        fieldPath: `${input.fieldPath}[${index}]`,
        scope: input.scope,
        lookupMediaAsset: input.lookupMediaAsset,
      });

      if (normalized.include) {
        normalizedArray.push(normalized.value);
      }
    }

    return { include: true, value: normalizedArray };
  }

  return input.value === undefined
    ? { include: false }
    : { include: true, value: input.value };
}

export async function validateMediaFieldIdentities(input: {
  schema: SchemaRegistryTypeSnapshot;
  frontmatter: Record<string, unknown>;
  scope: ContentScope;
  lookupMediaAsset?: ContentMediaAssetLookup;
}): Promise<{ frontmatter: Record<string, unknown> }> {
  const firstFileFieldPath = schemaContainsFileFields(input.schema);

  if (!firstFileFieldPath) {
    return { frontmatter: { ...input.frontmatter } };
  }

  if (!input.lookupMediaAsset) {
    throw createLookupUnavailableError(firstFileFieldPath);
  }

  const normalizedFrontmatter: Record<string, unknown> = {
    ...input.frontmatter,
  };

  for (const [fieldName, field] of Object.entries(input.schema.fields)) {
    const normalized = await normalizeFieldValue({
      value: input.frontmatter[fieldName],
      field,
      fieldPath: `frontmatter.${fieldName}`,
      scope: input.scope,
      lookupMediaAsset: input.lookupMediaAsset,
    });

    if (normalized.include) {
      normalizedFrontmatter[fieldName] = normalized.value;
    } else {
      delete normalizedFrontmatter[fieldName];
    }
  }

  return { frontmatter: normalizedFrontmatter };
}
