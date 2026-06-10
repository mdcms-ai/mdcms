import type {
  ContentDocumentResponse,
  ContentReferenceResolveError,
  ResolveErrorsMap,
  SchemaRegistryFieldSnapshot,
} from "@mdcms/shared";
import { RuntimeError } from "@mdcms/shared";

import type { ApiKeyOperationScope } from "../auth.js";

import { toDocumentResponse } from "./responses.js";
import type {
  ContentRequestAuthorizer,
  ContentScope,
  ContentStore,
} from "./types.js";

type ResolvePathPlan = {
  segments: string[];
  fullPath: string;
  targetType: string;
};

type ResolveResult =
  | {
      kind: "resolved";
      document: ContentDocumentResponse;
    }
  | {
      kind: "unresolved";
      error: ContentReferenceResolveError;
    };

type ResolvedDocumentShaper = (input: {
  document: ContentDocumentResponse;
  fullPath: string;
  targetType: string;
}) => Promise<ContentDocumentResponse>;

type TargetSlot =
  | {
      kind: "slot";
      parent: Record<string, unknown>;
      key: string;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "invalid";
    };

function createInvalidResolveQueryError(
  path: string,
  message: string,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_QUERY_PARAM",
    message,
    statusCode: 400,
    details: {
      field: "resolve",
      value: path,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseResolvePaths(
  value: string | string[] | undefined,
): string[] {
  if (value === undefined) {
    return [];
  }

  const rawValues = Array.isArray(value) ? value : [value];
  const normalizedValues = rawValues.map((candidate) => {
    if (typeof candidate !== "string") {
      throw createInvalidResolveQueryError(
        String(candidate),
        'Query parameter "resolve" must be a string or repeated string list.',
      );
    }

    const trimmed = candidate.trim();

    if (trimmed.length === 0) {
      throw createInvalidResolveQueryError(
        candidate,
        'Query parameter "resolve" must not include empty field paths.',
      );
    }

    if (
      trimmed.startsWith(".") ||
      trimmed.endsWith(".") ||
      trimmed.includes("..")
    ) {
      throw createInvalidResolveQueryError(
        candidate,
        'Query parameter "resolve" must use dot-delimited field paths relative to frontmatter.',
      );
    }

    return trimmed;
  });

  return [...new Set(normalizedValues)];
}

function resolveReferenceFieldPlan(input: {
  documentType: string;
  path: string;
  fields: Record<string, SchemaRegistryFieldSnapshot>;
}): ResolvePathPlan {
  const segments = input.path.split(".");
  let currentFields = input.fields;
  let currentField: SchemaRegistryFieldSnapshot | undefined;

  for (const [index, segment] of segments.entries()) {
    currentField = currentFields[segment];

    if (!currentField) {
      throw createInvalidResolveQueryError(
        input.path,
        `Query parameter "resolve" references unknown field "${input.path}" for type "${input.documentType}".`,
      );
    }

    const isLast = index === segments.length - 1;

    if (isLast) {
      if (!currentField.reference) {
        throw createInvalidResolveQueryError(
          input.path,
          `Query parameter "resolve" must target a reference field; "${input.path}" on type "${input.documentType}" is not a reference.`,
        );
      }

      return {
        segments,
        fullPath: `frontmatter.${input.path}`,
        targetType: currentField.reference.targetType,
      };
    }

    if (currentField.kind !== "object" || !currentField.fields) {
      throw createInvalidResolveQueryError(
        input.path,
        `Query parameter "resolve" references invalid nested field "${input.path}" for type "${input.documentType}".`,
      );
    }

    currentFields = currentField.fields;
  }

  throw createInvalidResolveQueryError(
    input.path,
    `Query parameter "resolve" references invalid field "${input.path}".`,
  );
}

function getTargetSlot(
  frontmatter: Record<string, unknown>,
  segments: string[],
): TargetSlot {
  let current: unknown = frontmatter;

  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current)) {
      return {
        kind: "invalid",
      };
    }

    const next = current[segment];

    if (next === undefined || next === null) {
      return {
        kind: "missing",
      };
    }

    current = next;
  }

  if (!isRecord(current)) {
    return {
      kind: "invalid",
    };
  }

  const key = segments[segments.length - 1];

  if (!key) {
    return {
      kind: "invalid",
    };
  }

  return {
    kind: "slot",
    parent: current,
    key,
  };
}

function setTargetSlotValue(
  frontmatter: Record<string, unknown>,
  segments: string[],
  value: unknown,
): void {
  let current = frontmatter;

  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];

    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  const key = segments[segments.length - 1];

  if (!key) {
    return;
  }

  current[key] = value;
}

function createResolveError(
  code: ContentReferenceResolveError["code"],
  documentId: string,
  type: string,
): ContentReferenceResolveError {
  const messageByCode: Record<ContentReferenceResolveError["code"], string> = {
    REFERENCE_NOT_FOUND:
      "Referenced document could not be resolved in the target project/environment.",
    REFERENCE_DELETED:
      "Referenced document has been deleted in the target project/environment.",
    REFERENCE_TYPE_MISMATCH:
      "Referenced document type does not match the reference field target type.",
    REFERENCE_FORBIDDEN:
      "Referenced document is not readable in the target project/environment.",
  };

  return {
    code,
    message: messageByCode[code],
    ref: {
      documentId,
      type,
    },
  };
}

function isForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeError && error.code === "FORBIDDEN";
}

async function authorizeReferencePath(input: {
  authorize: ContentRequestAuthorizer;
  request: Request;
  requiredScope: ApiKeyOperationScope;
  scope: ContentScope;
  path: string;
}): Promise<boolean> {
  try {
    await input.authorize(input.request, {
      requiredScope: input.requiredScope,
      project: input.scope.project,
      environment: input.scope.environment,
      documentPath: input.path,
    });
    return true;
  } catch (error) {
    if (isForbiddenError(error)) {
      return false;
    }

    throw error;
  }
}

async function resolveReferenceValue(input: {
  authorize: ContentRequestAuthorizer;
  request: Request;
  requiredScope: ApiKeyOperationScope;
  scope: ContentScope;
  store: Pick<ContentStore, "getById">;
  draft: boolean;
  documentId: string;
  expectedType: string;
}): Promise<ResolveResult> {
  const unresolved = (
    code: ContentReferenceResolveError["code"],
  ): ResolveResult => ({
    kind: "unresolved",
    error: createResolveError(code, input.documentId, input.expectedType),
  });

  if (input.draft) {
    const draftDocument = await input.store.getById(
      input.scope,
      input.documentId,
      {
        draft: true,
      },
    );

    if (!draftDocument) {
      return unresolved("REFERENCE_NOT_FOUND");
    }

    const authorized = await authorizeReferencePath({
      authorize: input.authorize,
      request: input.request,
      requiredScope: input.requiredScope,
      scope: input.scope,
      path: draftDocument.path,
    });

    if (!authorized) {
      return unresolved("REFERENCE_FORBIDDEN");
    }

    if (draftDocument.isDeleted) {
      return unresolved("REFERENCE_DELETED");
    }

    if (draftDocument.type !== input.expectedType) {
      return unresolved("REFERENCE_TYPE_MISMATCH");
    }

    return {
      kind: "resolved",
      document: toDocumentResponse(draftDocument),
    };
  }

  const publishedDocument = await input.store.getById(
    input.scope,
    input.documentId,
    {
      draft: false,
    },
  );

  if (publishedDocument) {
    const authorized = await authorizeReferencePath({
      authorize: input.authorize,
      request: input.request,
      requiredScope: input.requiredScope,
      scope: input.scope,
      path: publishedDocument.path,
    });

    if (!authorized) {
      return unresolved("REFERENCE_FORBIDDEN");
    }

    if (publishedDocument.type !== input.expectedType) {
      return unresolved("REFERENCE_TYPE_MISMATCH");
    }

    return {
      kind: "resolved",
      document: toDocumentResponse(publishedDocument),
    };
  }

  return unresolved("REFERENCE_NOT_FOUND");
}

export function parseRequestedResolvePaths(input: {
  query: {
    resolve?: string | string[];
    type?: string;
  };
  requireType: boolean;
}): string[] {
  const paths = parseResolvePaths(input.query.resolve);

  if (
    paths.length > 0 &&
    input.requireType &&
    (!input.query.type || input.query.type.trim().length === 0)
  ) {
    throw createInvalidResolveQueryError(
      "resolve",
      'Query parameter "type" is required when "resolve" is used on the content list endpoint.',
    );
  }

  return paths;
}

export async function prepareResolvePlan(input: {
  scope: ContentScope;
  store: Pick<ContentStore, "getSchema">;
  documentType: string;
  paths: string[];
}): Promise<ResolvePathPlan[]> {
  if (input.paths.length === 0) {
    return [];
  }

  const schema = await input.store.getSchema(input.scope, input.documentType);

  if (!schema) {
    throw createInvalidResolveQueryError(
      input.paths[0] ?? input.documentType,
      `Query parameter "resolve" cannot be validated because type "${input.documentType}" has no resolved schema in the target environment.`,
    );
  }

  return input.paths.map((path) =>
    resolveReferenceFieldPlan({
      documentType: input.documentType,
      path,
      fields: schema.fields,
    }),
  );
}

export async function applyResolvePlan<
  TDocument extends {
    frontmatter: Record<string, unknown>;
  },
>(input: {
  authorize: ContentRequestAuthorizer;
  request: Request;
  requiredScope: ApiKeyOperationScope;
  scope: ContentScope;
  store: Pick<ContentStore, "getById">;
  draft: boolean;
  document: TDocument;
  plan: ResolvePathPlan[];
  shapeResolvedDocument?: ResolvedDocumentShaper;
}): Promise<TDocument & { resolveErrors?: ResolveErrorsMap }> {
  if (input.plan.length === 0) {
    return input.document;
  }

  const resolvedDocument = {
    ...input.document,
    frontmatter: structuredClone(input.document.frontmatter),
  };
  const resolveErrors: ResolveErrorsMap = {};

  for (const field of input.plan) {
    const slot = getTargetSlot(resolvedDocument.frontmatter, field.segments);

    if (slot.kind === "missing") {
      continue;
    }

    if (slot.kind === "invalid") {
      setTargetSlotValue(resolvedDocument.frontmatter, field.segments, null);
      resolveErrors[field.fullPath] = createResolveError(
        "REFERENCE_NOT_FOUND",
        "",
        field.targetType,
      );
      continue;
    }

    const referenceValue = slot.parent[slot.key];

    if (referenceValue === undefined || referenceValue === null) {
      continue;
    }

    if (typeof referenceValue !== "string") {
      slot.parent[slot.key] = null;
      resolveErrors[field.fullPath] = createResolveError(
        "REFERENCE_NOT_FOUND",
        "",
        field.targetType,
      );
      continue;
    }

    const normalizedReferenceValue = referenceValue.trim();

    if (normalizedReferenceValue.length === 0) {
      slot.parent[slot.key] = null;
      resolveErrors[field.fullPath] = createResolveError(
        "REFERENCE_NOT_FOUND",
        "",
        field.targetType,
      );
      continue;
    }

    const result = await resolveReferenceValue({
      authorize: input.authorize,
      request: input.request,
      requiredScope: input.requiredScope,
      scope: input.scope,
      store: input.store,
      draft: input.draft,
      documentId: normalizedReferenceValue,
      expectedType: field.targetType,
    });

    if (result.kind === "resolved") {
      slot.parent[slot.key] = input.shapeResolvedDocument
        ? await input.shapeResolvedDocument({
            document: result.document,
            fullPath: field.fullPath,
            targetType: field.targetType,
          })
        : result.document;
      continue;
    }

    slot.parent[slot.key] = null;
    resolveErrors[field.fullPath] = result.error;
  }

  if (Object.keys(resolveErrors).length === 0) {
    return resolvedDocument;
  }

  return {
    ...resolvedDocument,
    resolveErrors,
  };
}
