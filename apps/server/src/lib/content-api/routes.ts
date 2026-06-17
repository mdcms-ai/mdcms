import type {
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
  ContentPreviewTokenRequest,
  ContentVersionDocumentResponse,
  PaginationMetadata,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
import {
  ContentBulkOperationInputSchema,
  RuntimeError,
  isRuntimeErrorLike,
  signMdcmsPreviewToken,
} from "@mdcms/shared";
import { z } from "zod";

import type { ApiKeyOperationScope } from "../auth.js";
import { createDocumentCollaborationActiveError } from "../collaboration/errors.js";
import { executeWithRuntimeErrorsHandled } from "../http-utils.js";

import {
  assertRequiredString,
  isRecord,
  parseBoolean,
  parseContentListGroupBy,
  parseOptionalString,
  parsePathInt,
  parseRestoreTargetStatus,
  pickScope,
} from "./parsing.js";
import { requireMatchingWriteSchemaHash } from "./schema-hash.js";
import {
  applyResolvePlan,
  parseRequestedResolvePaths,
  prepareResolvePlan,
} from "./resolve.js";
import {
  applyMediaFieldExpansion,
  createCachedMediaAssetLookup,
  type FileFieldReadMode,
} from "./media-field-expansion.js";
import { createContentLifecycleMutationCommitter } from "./lifecycle-events.js";
import {
  stripUnknownFrontmatterFields,
  toDocumentResponse,
  toVersionDocumentResponse,
  toVersionSummaryResponse,
} from "./responses.js";
import type {
  ContentBulkAction,
  ContentBulkOperationInput,
  ContentBulkOperationItemError,
  ContentBulkOperationResponse,
  ContentBulkOperationResult,
  ContentDocument,
  ContentLifecycleEvent,
  ContentListResult,
  ContentListQuery,
  ContentPublishPayload,
  ContentRestoreVersionPayload,
  ContentRouteApp,
  ContentWritePayload,
  MountContentApiRoutesOptions,
} from "./types.js";

function resolveContentReadScope(
  query: ContentListQuery,
): ApiKeyOperationScope {
  const draft = parseBoolean(query.draft, "draft");
  return draft === true ? "content:read:draft" : "content:read";
}

function toPaginationMetadata(
  result: Pick<ContentListResult<unknown>, "total" | "limit" | "offset">,
): PaginationMetadata {
  return {
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    hasMore: result.offset + result.limit < result.total,
  };
}

function toPaginatedResponse<Row, Output>(
  result: ContentListResult<Row>,
  mapper: (row: Row) => Output,
): ApiPaginatedEnvelope<Output> {
  return {
    data: result.rows.map((row) => mapper(row)),
    pagination: toPaginationMetadata(result),
  };
}

function getResolveQueryValue(
  request: Request,
  query: ContentListQuery,
): ContentListQuery["resolve"] {
  const values = new URL(request.url).searchParams.getAll("resolve");

  if (values.length === 0) {
    return query.resolve;
  }

  return values.length === 1 ? values[0] : values;
}

function parseOverviewTypes(request: Request): string[] {
  const types = new URL(request.url).searchParams.getAll("type");

  if (types.length === 0) {
    throw new RuntimeError({
      code: "INVALID_QUERY_PARAM",
      message: 'Query parameter "type" is required.',
      statusCode: 400,
      details: { field: "type" },
    });
  }

  return types.map((type) => {
    const normalized = type.trim();

    if (normalized.length === 0) {
      throw new RuntimeError({
        code: "INVALID_QUERY_PARAM",
        message: 'Query parameter "type" is required.',
        statusCode: 400,
        details: { field: "type", value: type },
      });
    }

    return normalized;
  });
}

const FileFieldReadModeSchema = z.enum(["raw", "expanded"]);

export function parseFileFieldReadMode(request: Request): FileFieldReadMode {
  const values = new URL(request.url).searchParams.getAll("fileFields");

  if (values.length === 0) {
    return "expanded";
  }

  if (values.length > 1) {
    throw new RuntimeError({
      code: "INVALID_QUERY_PARAM",
      message: 'Query parameter "fileFields" must be specified at most once.',
      statusCode: 400,
      details: {
        field: "fileFields",
        value: values,
      },
    });
  }

  const [value] = values;
  const parsed = FileFieldReadModeSchema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new RuntimeError({
    code: "INVALID_QUERY_PARAM",
    message: 'Query parameter "fileFields" must be "raw" or "expanded".',
    statusCode: 400,
    details: {
      field: "fileFields",
      value,
    },
  });
}

function parsePreviewTokenRequestBody(
  body: unknown,
): ContentPreviewTokenRequest {
  if (body === undefined || body === null) {
    return {};
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: "Preview token request body must be an object.",
      statusCode: 400,
      details: { field: "body" },
    });
  }

  const previewUrl = (body as Record<string, unknown>).previewUrl;

  if (previewUrl === undefined) {
    return {};
  }

  if (typeof previewUrl !== "string" || previewUrl.trim().length === 0) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "previewUrl" must be a non-empty string when provided.',
      statusCode: 400,
      details: { field: "previewUrl" },
    });
  }

  return { previewUrl: previewUrl.trim() };
}

function createInvalidBulkInputError(
  message: string,
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    details,
  });
}

function hasInputField(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

const BulkActionInputSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  ContentBulkOperationInputSchema.shape.action,
);

const BulkOptionalStringInputSchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const BulkDocumentIdsInputSchema = z
  .array(z.string())
  .min(1, {
    message: 'Field "documentIds" must contain between 1 and 100 document IDs.',
  })
  .max(100, {
    message: 'Field "documentIds" must contain between 1 and 100 document IDs.',
  })
  .transform((documentIds) =>
    documentIds.map((documentId) => documentId.trim()),
  )
  .superRefine((documentIds, ctx) => {
    for (const [index, documentId] of documentIds.entries()) {
      if (documentId.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: 'Field "documentIds" must contain only non-empty strings.',
          path: [index],
        });
      }
    }

    if (new Set(documentIds).size !== documentIds.length) {
      ctx.addIssue({
        code: "custom",
        message: 'Field "documentIds" must contain unique document IDs.',
      });
    }
  });

const BulkMoveTargetDirectoryInputSchema = z
  .preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string(),
  )
  .superRefine((targetDirectory, ctx) => {
    if (targetDirectory.length === 0) {
      return;
    }

    if (targetDirectory.startsWith("/")) {
      ctx.addIssue({
        code: "custom",
        message:
          'Field "move.targetDirectory" must not start with a leading slash.',
      });
    }

    if (targetDirectory.endsWith("/")) {
      ctx.addIssue({
        code: "custom",
        message:
          'Field "move.targetDirectory" must not end with a trailing slash.',
      });
    }

    if (/(^|\/)\.\.(\/|$)/.test(targetDirectory)) {
      ctx.addIssue({
        code: "custom",
        message:
          'Field "move.targetDirectory" must not contain path traversal segments ("..").',
      });
    }
  });

const BulkMoveInputSchema = z.object({
  targetDirectory: BulkMoveTargetDirectoryInputSchema,
});

const ContentBulkOperationRouteInputSchema = z
  .object({
    action: BulkActionInputSchema,
    documentIds: BulkDocumentIdsInputSchema,
    changeSummary: z.unknown().optional(),
    actorId: z.unknown().optional(),
    move: z.unknown().optional(),
  })
  .superRefine((input, ctx) => {
    if (hasInputField(input, "changeSummary") && input.action !== "publish") {
      ctx.addIssue({
        code: "custom",
        message: `Field "changeSummary" is not accepted for "${input.action}" bulk operations.`,
        path: ["changeSummary"],
      });
    }

    if (
      hasInputField(input, "actorId") &&
      input.action !== "publish" &&
      input.action !== "unpublish"
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Field "actorId" is not accepted for "${input.action}" bulk operations.`,
        path: ["actorId"],
      });
    }

    if (hasInputField(input, "move") && input.action !== "move") {
      ctx.addIssue({
        code: "custom",
        message: `Field "move" is not accepted for "${input.action}" bulk operations.`,
        path: ["move"],
      });
    }

    if (input.action === "publish") {
      addNestedBulkIssues(
        ctx,
        BulkOptionalStringInputSchema.safeParse(input.changeSummary),
        ["changeSummary"],
      );
    }

    if (input.action === "publish" || input.action === "unpublish") {
      addNestedBulkIssues(
        ctx,
        BulkOptionalStringInputSchema.safeParse(input.actorId),
        ["actorId"],
      );
    }

    if (input.action === "move") {
      const move = BulkMoveInputSchema.safeParse(input.move);
      if (!move.success && input.move === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'Field "move.targetDirectory" is required for move.',
          path: ["move", "targetDirectory"],
        });
        return;
      }

      addNestedBulkIssues(ctx, move, ["move"]);
    }
  })
  .transform((input): ContentBulkOperationInput => {
    const changeSummary =
      input.action === "publish"
        ? BulkOptionalStringInputSchema.parse(input.changeSummary)
        : undefined;
    const actorId =
      input.action === "publish" || input.action === "unpublish"
        ? BulkOptionalStringInputSchema.parse(input.actorId)
        : undefined;

    return {
      action: input.action,
      documentIds: input.documentIds,
      ...(changeSummary ? { changeSummary } : undefined),
      ...(actorId ? { actorId } : undefined),
      ...(input.action === "move"
        ? { move: BulkMoveInputSchema.parse(input.move) }
        : undefined),
    };
  });

type BulkSafeParseResult =
  | { success: true }
  | { success: false; error: z.ZodError };

function addNestedBulkIssues(
  ctx: z.RefinementCtx,
  result: BulkSafeParseResult,
  path: Array<string | number>,
): void {
  if (result.success) {
    return;
  }

  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: "custom",
      message: issue.message,
      path:
        path[0] === "move" && issue.path.length === 0
          ? ["move", "targetDirectory"]
          : [...path, ...issue.path],
    });
  }
}

function bulkInputIssueField(issue: z.ZodIssue | undefined): string {
  const path = issue?.path ?? [];
  const first = path[0];

  if (first === "move" && path[1] === "targetDirectory") {
    return "move.targetDirectory";
  }

  if (first === "documentIds") {
    return "documentIds";
  }

  return typeof first === "string" ? first : "body";
}

function bulkInputAction(body: unknown): string | undefined {
  if (!isRecord(body) || typeof body.action !== "string") {
    return undefined;
  }

  return body.action.trim();
}

function createBulkInputParseError(
  body: unknown,
  error: z.ZodError,
): RuntimeError {
  const issue = error.issues[0];
  const field = bulkInputIssueField(issue);
  const action = bulkInputAction(body);

  return createInvalidBulkInputError(
    issue?.message ?? "Bulk content request body is invalid.",
    {
      field,
      ...(action !== undefined &&
      (field === "changeSummary" || field === "actorId" || field === "move")
        ? { action }
        : undefined),
    },
  );
}

function parseContentBulkOperationInput(
  body: unknown,
): ContentBulkOperationInput {
  const parsed = ContentBulkOperationRouteInputSchema.safeParse(body);
  if (!parsed.success) {
    throw createBulkInputParseError(body, parsed.error);
  }

  return parsed.data;
}

function getBulkRequiredScope(action: ContentBulkAction): ApiKeyOperationScope {
  switch (action) {
    case "publish":
    case "unpublish":
      return "content:publish";
    case "delete":
      return "content:delete";
    case "move":
      return "content:write";
  }
}

function getBulkLifecycleEvent(
  action: ContentBulkAction,
): ContentLifecycleEvent {
  switch (action) {
    case "publish":
      return "content.published";
    case "unpublish":
      return "content.unpublished";
    case "delete":
      return "content.deleted";
    case "move":
      return "content.updated";
  }
}

function getDocumentSlug(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function buildBulkMovePath(
  document: Pick<ContentDocument, "path">,
  targetDirectory: string,
): string {
  const slug = getDocumentSlug(document.path);
  return targetDirectory.length === 0 ? slug : `${targetDirectory}/${slug}`;
}

function createDocumentNotFoundError(documentId: string): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Document not found.",
    statusCode: 404,
    details: {
      documentId,
    },
  });
}

async function assertNoActiveCollaboration(
  activeCollaboration: MountContentApiRoutesOptions["activeCollaboration"],
  documentId: string,
): Promise<void> {
  if (!(await activeCollaboration?.isDocumentActive(documentId))) {
    return;
  }

  throw createDocumentCollaborationActiveError(documentId);
}

async function invalidateInactiveCollaborationCache(
  inactiveCollaborationCache: MountContentApiRoutesOptions["inactiveCollaborationCache"],
  documentId: string,
): Promise<void> {
  if (!inactiveCollaborationCache) {
    return;
  }

  try {
    await inactiveCollaborationCache.invalidateDocument(documentId);
  } catch {
    // The content mutation is already committed. Stale inactive Redis cache is
    // rejected by draft-revision/body-hash metadata on the next room load.
  }
}

const BULK_REQUEST_LEVEL_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "MISSING_TARGET_ROUTING",
  "TARGET_ROUTING_MISMATCH",
  "SCHEMA_HASH_REQUIRED",
  "SCHEMA_NOT_SYNCED",
  "SCHEMA_HASH_MISMATCH",
]);

function isBulkRequestLevelError(error: unknown): boolean {
  return (
    isRuntimeErrorLike(error) && BULK_REQUEST_LEVEL_ERROR_CODES.has(error.code)
  );
}

function toContentBulkOperationItemError(
  error: unknown,
): ContentBulkOperationItemError | undefined {
  if (!isRuntimeErrorLike(error)) {
    return undefined;
  }

  return {
    code: error.code,
    message: error.message,
    statusCode: error.statusCode,
    ...(error.details !== undefined ? { details: error.details } : undefined),
  };
}

export async function shapeContentDocumentResponse<
  TDocument extends ContentDocumentResponse | ContentVersionDocumentResponse,
>(input: {
  authorize: MountContentApiRoutesOptions["authorize"];
  request: Request;
  requiredScope: ApiKeyOperationScope;
  scope: Parameters<MountContentApiRoutesOptions["store"]["getSchema"]>[0];
  store: MountContentApiRoutesOptions["store"];
  draft: boolean;
  document: TDocument;
  schema: SchemaRegistryTypeSnapshot | undefined;
  resolvePlan?: Awaited<ReturnType<typeof prepareResolvePlan>>;
  fileFieldMode: FileFieldReadMode;
  lookupMediaAsset: MountContentApiRoutesOptions["lookupMediaAsset"];
}): Promise<TDocument> {
  const strippedDocument = {
    ...input.document,
    frontmatter: stripUnknownFrontmatterFields(
      input.document.frontmatter,
      input.schema,
    ),
  };
  const resolvedSchemaCache = new Map<
    string,
    SchemaRegistryTypeSnapshot | undefined
  >();
  const getResolvedDocumentSchema = async (
    type: string,
  ): Promise<SchemaRegistryTypeSnapshot | undefined> => {
    if (resolvedSchemaCache.has(type)) {
      return resolvedSchemaCache.get(type);
    }

    const schema = await input.store.getSchema(input.scope, type);
    resolvedSchemaCache.set(type, schema);
    return schema;
  };
  const resolvedDocument = await applyResolvePlan({
    authorize: input.authorize,
    document: strippedDocument,
    request: input.request,
    requiredScope: input.requiredScope,
    scope: input.scope,
    store: input.store,
    draft: input.draft,
    plan: input.resolvePlan ?? [],
    shapeResolvedDocument: async ({ document }) => {
      if (input.fileFieldMode === "raw") {
        return document;
      }

      return applyMediaFieldExpansion({
        schema: await getResolvedDocumentSchema(document.type),
        document,
        scope: input.scope,
        lookupMediaAsset: input.lookupMediaAsset,
        mode: input.fileFieldMode,
      });
    },
  });

  return applyMediaFieldExpansion({
    schema: input.schema,
    document: resolvedDocument,
    scope: input.scope,
    lookupMediaAsset: input.lookupMediaAsset,
    mode: input.fileFieldMode,
  });
}

export function mountContentApiRoutes(
  app: unknown,
  options: MountContentApiRoutesOptions,
): void {
  const contentApp = app as ContentRouteApp;
  const commitMutation = createContentLifecycleMutationCommitter(
    options.lifecycleEvents,
  );

  contentApp.get?.("/api/v1/content/overview", ({ request }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
      const types = parseOverviewTypes(request);

      await options.authorize(request, {
        requiredScope: "content:read",
        project: scope.project,
        environment: scope.environment,
      });

      return {
        data: await options.store.getOverviewCounts(scope, { types }),
      };
    });
  });

  contentApp.get?.("/api/v1/content", ({ request, query }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
      const typedQuery = query as ContentListQuery;
      const fileFieldMode = parseFileFieldReadMode(request);
      const lookupMediaAsset = createCachedMediaAssetLookup(
        options.lookupMediaAsset,
      );
      const requestedPath = typedQuery.path?.trim();
      const requiredScope = resolveContentReadScope(typedQuery);
      const draft = requiredScope === "content:read:draft";
      const resolvePaths = parseRequestedResolvePaths({
        query: {
          ...typedQuery,
          resolve: getResolveQueryValue(request, typedQuery),
        },
        requireType: true,
      });
      const groupBy = parseContentListGroupBy(typedQuery.groupBy);
      const resolvedType = typedQuery.type?.trim();
      await options.authorize(request, {
        requiredScope,
        project: scope.project,
        environment: scope.environment,
        documentPath:
          requestedPath && requestedPath.length > 0 ? requestedPath : undefined,
      });

      if (groupBy === "translationGroup") {
        if (!resolvedType) {
          throw new RuntimeError({
            code: "INVALID_QUERY_PARAM",
            message:
              'Query parameter "type" is required when "groupBy" is provided.',
            statusCode: 400,
            details: { field: "type" },
          });
        }

        const schema = await options.store.getSchema(scope, resolvedType);

        if (!schema?.localized) {
          throw new RuntimeError({
            code: "INVALID_QUERY_PARAM",
            message:
              'Query parameter "groupBy" is only valid for localized schema types.',
            statusCode: 400,
            details: { field: "groupBy", value: groupBy },
          });
        }
      }

      const result = await options.store.list(scope, typedQuery);
      const schemaCache = new Map<
        string,
        Awaited<ReturnType<typeof options.store.getSchema>>
      >();
      const response = toPaginatedResponse(result, (row) =>
        toDocumentResponse(row),
      );
      const resolvePlan =
        resolvePaths.length > 0
          ? await prepareResolvePlan({
              scope,
              store: options.store,
              documentType: resolvedType!,
              paths: resolvePaths,
            })
          : [];

      response.data = await Promise.all(
        response.data.map(async (document) => {
          if (!schemaCache.has(document.type)) {
            schemaCache.set(
              document.type,
              await options.store.getSchema(scope, document.type),
            );
          }

          return shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope,
            scope,
            store: options.store,
            draft,
            document,
            schema: schemaCache.get(document.type),
            resolvePlan,
            fileFieldMode,
            lookupMediaAsset,
          });
        }),
      );

      if (options.resolveUsers && response.data.length > 0) {
        try {
          const uniqueUserIds = [
            ...new Set(
              response.data.flatMap((d) => [d.createdBy, d.updatedBy]),
            ),
          ];
          const users = await options.resolveUsers(uniqueUserIds);
          (response as Record<string, unknown>).users = users;
        } catch {
          // User enrichment is best-effort; a lookup failure must not
          // break the content list response.
        }
      }

      return response;
    });
  });

  contentApp.get?.(
    "/api/v1/content/:documentId/variants",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);

        await options.authorize(request, {
          requiredScope: "content:read",
          project: scope.project,
          environment: scope.environment,
        });

        const variants = await options.store.listVariants(
          scope,
          params.documentId,
        );

        if (variants === undefined) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: { documentId: params.documentId },
          });
        }

        // Authorize each variant path individually for folder-level RBAC.
        // Variants in the same translation group may have divergent paths,
        // so the caller must be allowed to read each one.
        const authorized = [];
        for (const variant of variants) {
          try {
            await options.authorize(request, {
              requiredScope: "content:read",
              project: scope.project,
              environment: scope.environment,
              documentPath: variant.path,
            });
            authorized.push(variant);
          } catch (error) {
            // Silently omit variants the caller cannot access.
            // Rethrow non-auth errors so outages surface.
            if (!(error instanceof RuntimeError) || error.statusCode !== 403) {
              throw error;
            }
          }
        }

        return Response.json({ data: authorized });
      });
    },
  );

  contentApp.get?.(
    "/api/v1/content/:documentId",
    ({ request, params, query }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const typedQuery = query as ContentListQuery;
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        const requiredScope = resolveContentReadScope(typedQuery);
        const draft = parseBoolean(typedQuery.draft, "draft") === true;
        const resolvePaths = parseRequestedResolvePaths({
          query: {
            ...typedQuery,
            resolve: getResolveQueryValue(request, typedQuery),
          },
          requireType: false,
        });

        await options.authorize(request, {
          requiredScope,
          project: scope.project,
          environment: scope.environment,
        });
        const document = await options.store.getById(scope, params.documentId, {
          draft,
        });

        if (!document || document.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope,
          project: scope.project,
          environment: scope.environment,
          documentPath: document.path,
        });

        const responseDocument = toDocumentResponse(document);
        const typeSchema = await options.store.getSchema(scope, document.type);
        const resolvePlan = await prepareResolvePlan({
          scope,
          store: options.store,
          documentType: document.type,
          paths: resolvePaths,
        });

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            document: responseDocument,
            request,
            requiredScope,
            scope,
            store: options.store,
            draft,
            schema: typeSchema,
            resolvePlan,
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/preview-token",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        await options.requireCsrf(request);

        await options.authorize(request, {
          requiredScope: "content:read:draft",
          project: scope.project,
          environment: scope.environment,
        });

        const document = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!document || document.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:read:draft",
          project: scope.project,
          environment: scope.environment,
          documentPath: document.path,
        });

        if (!options.previewTokenSecret) {
          throw new RuntimeError({
            code: "PREVIEW_TOKEN_UNAVAILABLE",
            message: "Preview token signing is not configured.",
            statusCode: 503,
          });
        }

        const payload = parsePreviewTokenRequestBody(body);
        const token = await signMdcmsPreviewToken({
          secret: options.previewTokenSecret,
          ttlSeconds: options.previewTokenTtlSeconds,
          claims: {
            project: scope.project,
            environment: scope.environment,
            documentId: document.documentId,
            type: document.type,
            path: document.path,
            locale: document.locale,
            draftRevision: document.draftRevision,
            ...(payload.previewUrl
              ? { previewUrl: payload.previewUrl }
              : undefined),
          },
        });

        return { data: token };
      });
    },
  );

  contentApp.get?.(
    "/api/v1/content/:documentId/versions",
    ({ request, params, query }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const typedQuery = query as ContentListQuery;

        await options.authorize(request, {
          requiredScope: "content:read",
          project: scope.project,
          environment: scope.environment,
        });

        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:read",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        const versions = await options.store.listVersions(
          scope,
          params.documentId,
          typedQuery,
        );

        for (const path of new Set(
          versions.rows.map((version) => version.path),
        )) {
          if (path !== existing.path) {
            await options.authorize(request, {
              requiredScope: "content:read",
              project: scope.project,
              environment: scope.environment,
              documentPath: path,
            });
          }
        }

        return toPaginatedResponse(versions, (version) =>
          toVersionSummaryResponse(version),
        );
      });
    },
  );

  contentApp.get?.(
    "/api/v1/content/:documentId/versions/:version",
    ({ request, params, query }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const version = parsePathInt(params.version, "version");
        const typedQuery = query as ContentListQuery;
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        const resolvePaths = parseRequestedResolvePaths({
          query: {
            ...typedQuery,
            resolve: getResolveQueryValue(request, typedQuery),
          },
          requireType: false,
        });

        await options.authorize(request, {
          requiredScope: "content:read",
          project: scope.project,
          environment: scope.environment,
        });

        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:read",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        const versionDocument = await options.store.getVersion(
          scope,
          params.documentId,
          version,
        );

        if (versionDocument.path !== existing.path) {
          await options.authorize(request, {
            requiredScope: "content:read",
            project: scope.project,
            environment: scope.environment,
            documentPath: versionDocument.path,
          });
        }

        const responseDocument = toVersionDocumentResponse(versionDocument);
        const typeSchema = await options.store.getSchema(
          scope,
          versionDocument.type,
        );
        const resolvePlan = await prepareResolvePlan({
          scope,
          store: options.store,
          documentType: versionDocument.type,
          paths: resolvePaths,
        });

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            document: responseDocument,
            request,
            requiredScope: "content:read",
            scope,
            store: options.store,
            draft: false,
            schema: typeSchema,
            resolvePlan,
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.("/api/v1/content", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
      const fileFieldMode = parseFileFieldReadMode(request);
      const lookupMediaAsset = createCachedMediaAssetLookup(
        options.lookupMediaAsset,
      );
      await options.requireCsrf(request);
      const payload = (body ?? {}) as ContentWritePayload;
      const requestedPath =
        typeof payload.path === "string" ? payload.path.trim() : undefined;
      const authorization = await options.authorize(request, {
        requiredScope: "content:write",
        project: scope.project,
        environment: scope.environment,
        documentPath:
          requestedPath && requestedPath.length > 0 ? requestedPath : undefined,
      });
      const schemaHash = await requireMatchingWriteSchemaHash(
        request,
        scope,
        options.getWriteSchemaSyncState,
      );
      const document = await commitMutation(
        "content.created",
        scope,
        authorization,
        () =>
          options.store.create(scope, payload, {
            expectedSchemaHash: schemaHash,
          }),
      );

      return {
        data: await shapeContentDocumentResponse({
          authorize: options.authorize,
          request,
          requiredScope: "content:write",
          scope,
          store: options.store,
          draft: true,
          document: toDocumentResponse(document),
          schema: await options.store.getSchema(scope, document.type),
          fileFieldMode,
          lookupMediaAsset,
        }),
      };
    });
  });

  contentApp.post?.("/api/v1/content/bulk", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
      const fileFieldMode = parseFileFieldReadMode(request);
      const lookupMediaAsset = createCachedMediaAssetLookup(
        options.lookupMediaAsset,
      );
      await options.requireCsrf(request);
      const payload = parseContentBulkOperationInput(body);
      const requiredScope = getBulkRequiredScope(payload.action);
      const authorization = await options.authorize(request, {
        requiredScope,
        project: scope.project,
        environment: scope.environment,
      });
      const schemaHash =
        payload.action === "move"
          ? await requireMatchingWriteSchemaHash(
              request,
              scope,
              options.getWriteSchemaSyncState,
            )
          : undefined;
      const results: ContentBulkOperationResult[] = [];

      for (const documentId of payload.documentIds) {
        try {
          const existing = await options.store.getById(scope, documentId, {
            draft: true,
          });

          if (!existing || existing.isDeleted) {
            throw createDocumentNotFoundError(documentId);
          }

          await options.authorize(request, {
            requiredScope,
            project: scope.project,
            environment: scope.environment,
            documentPath: existing.path,
          });

          let nextPath: string | undefined;

          if (payload.action === "move") {
            const targetDirectory = payload.move?.targetDirectory ?? "";
            nextPath = buildBulkMovePath(existing, targetDirectory);

            await options.authorize(request, {
              requiredScope: "content:write",
              project: scope.project,
              environment: scope.environment,
              documentPath: nextPath,
            });
          }

          await assertNoActiveCollaboration(
            options.activeCollaboration,
            documentId,
          );

          let document: ContentDocument;

          if (payload.action === "publish") {
            document = await commitMutation(
              getBulkLifecycleEvent(payload.action),
              scope,
              authorization,
              () =>
                options.store.publish(scope, documentId, {
                  changeSummary: payload.changeSummary,
                  actorId: payload.actorId,
                }),
            );
          } else if (payload.action === "unpublish") {
            document = await commitMutation(
              getBulkLifecycleEvent(payload.action),
              scope,
              authorization,
              () =>
                options.store.unpublish(scope, documentId, {
                  actorId: payload.actorId,
                }),
            );
          } else if (payload.action === "delete") {
            document = await commitMutation(
              getBulkLifecycleEvent(payload.action),
              scope,
              authorization,
              () => options.store.softDelete(scope, documentId),
            );
          } else {
            document = await commitMutation(
              getBulkLifecycleEvent(payload.action),
              scope,
              authorization,
              () =>
                options.store.update(
                  scope,
                  documentId,
                  {
                    path: nextPath,
                  },
                  {
                    expectedSchemaHash: schemaHash,
                  },
                ),
            );
          }

          if (payload.action === "delete" || payload.action === "move") {
            await invalidateInactiveCollaborationCache(
              options.inactiveCollaborationCache,
              documentId,
            );
          }

          results.push({
            documentId,
            status: "succeeded",
            document: await shapeContentDocumentResponse({
              authorize: options.authorize,
              request,
              requiredScope,
              scope,
              store: options.store,
              draft: true,
              document: toDocumentResponse(document),
              schema: await options.store.getSchema(scope, document.type),
              fileFieldMode,
              lookupMediaAsset,
            }),
          });
        } catch (error) {
          if (isBulkRequestLevelError(error)) {
            throw error;
          }

          const itemError = toContentBulkOperationItemError(error);

          if (!itemError) {
            throw error;
          }

          results.push({
            documentId,
            status: "failed",
            error: itemError,
          });
        }
      }

      const succeeded = results.filter(
        (result) => result.status === "succeeded",
      ).length;
      const response: ContentBulkOperationResponse = {
        action: payload.action,
        requested: payload.documentIds.length,
        succeeded,
        failed: results.length - succeeded,
        results,
      };

      return {
        data: response,
      };
    });
  });

  contentApp.put?.(
    "/api/v1/content/:documentId",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const payload = (body ?? {}) as ContentWritePayload;

        const authorization = await options.authorize(request, {
          requiredScope: "content:write",
          project: scope.project,
          environment: scope.environment,
        });
        const schemaHash = await requireMatchingWriteSchemaHash(
          request,
          scope,
          options.getWriteSchemaSyncState,
        );
        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing || existing.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:write",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });
        const nextPath =
          payload.path !== undefined
            ? assertRequiredString(payload.path, "path")
            : existing.path;

        if (nextPath !== existing.path) {
          await options.authorize(request, {
            requiredScope: "content:write",
            project: scope.project,
            environment: scope.environment,
            documentPath: nextPath,
          });
        }
        const expectedDraftRevision =
          typeof payload.draftRevision === "number" &&
          Number.isInteger(payload.draftRevision) &&
          payload.draftRevision >= 0
            ? payload.draftRevision
            : undefined;

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          "content.updated",
          scope,
          authorization,
          () =>
            options.store.update(scope, params.documentId, payload, {
              expectedSchemaHash: schemaHash,
              expectedDraftRevision,
            }),
        );

        await invalidateInactiveCollaborationCache(
          options.inactiveCollaborationCache,
          params.documentId,
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope: "content:write",
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/restore",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);

        const authorization = await options.authorize(request, {
          requiredScope: "content:write",
          project: scope.project,
          environment: scope.environment,
        });

        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:write",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          "content.restored",
          scope,
          authorization,
          () => options.store.restore(scope, params.documentId),
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope: "content:write",
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/versions/:version/restore",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const payload = (body ?? {}) as ContentRestoreVersionPayload;
        const targetStatus = parseRestoreTargetStatus(payload.targetStatus);
        const requiredScope =
          targetStatus === "published" ? "content:publish" : "content:write";
        const version = parsePathInt(params.version, "version");

        const authorization = await options.authorize(request, {
          requiredScope,
          project: scope.project,
          environment: scope.environment,
        });

        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope,
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        const versionDocument = await options.store.getVersion(
          scope,
          params.documentId,
          version,
        );

        if (versionDocument.path !== existing.path) {
          await options.authorize(request, {
            requiredScope,
            project: scope.project,
            environment: scope.environment,
            documentPath: versionDocument.path,
          });
        }

        const changeSummary = parseOptionalString(
          payload.changeSummary ?? payload.change_summary,
          "changeSummary",
        );
        const actorId = parseOptionalString(payload.actorId, "actorId");

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          targetStatus === "published"
            ? "content.published"
            : "content.updated",
          scope,
          authorization,
          () =>
            options.store.restoreVersion(scope, params.documentId, version, {
              targetStatus,
              changeSummary,
              actorId,
            }),
        );

        await invalidateInactiveCollaborationCache(
          options.inactiveCollaborationCache,
          params.documentId,
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope,
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/publish",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const authorization = await options.authorize(request, {
          requiredScope: "content:publish",
          project: scope.project,
          environment: scope.environment,
        });
        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing || existing.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:publish",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        const payload = (body ?? {}) as ContentPublishPayload;
        const changeSummary = parseOptionalString(
          payload.changeSummary ?? payload.change_summary,
          "changeSummary",
        );
        const actorId = parseOptionalString(payload.actorId, "actorId");

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          "content.published",
          scope,
          authorization,
          () =>
            options.store.publish(scope, params.documentId, {
              changeSummary,
              actorId,
            }),
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope: "content:publish",
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/unpublish",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const authorization = await options.authorize(request, {
          requiredScope: "content:publish",
          project: scope.project,
          environment: scope.environment,
        });

        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing || existing.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:publish",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        const payload = (body ?? {}) as ContentPublishPayload;
        const actorId = parseOptionalString(payload.actorId, "actorId");

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          "content.unpublished",
          scope,
          authorization,
          () =>
            options.store.unpublish(scope, params.documentId, {
              actorId,
            }),
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope: "content:publish",
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/duplicate",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const authorization = await options.authorize(request, {
          requiredScope: "content:write",
          project: scope.project,
          environment: scope.environment,
        });

        const source = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!source || source.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:read:draft",
          project: scope.project,
          environment: scope.environment,
          documentPath: source.path,
        });

        const basePath = source.path.replace(/\/$/, "");
        let candidatePath = `${basePath}-copy`;
        let attempt = 1;
        const schemaHash = await requireMatchingWriteSchemaHash(
          request,
          scope,
          options.getWriteSchemaSyncState,
        );

        while (attempt < 100) {
          await options.authorize(request, {
            requiredScope: "content:write",
            project: scope.project,
            environment: scope.environment,
            documentPath: candidatePath,
          });

          try {
            const document = await commitMutation(
              "content.created",
              scope,
              authorization,
              () =>
                options.store.create(
                  scope,
                  {
                    path: candidatePath,
                    type: source.type,
                    locale: source.locale,
                    format: source.format,
                    frontmatter: source.frontmatter,
                    body: source.body,
                  },
                  {
                    expectedSchemaHash: schemaHash,
                  },
                ),
            );

            return {
              data: await shapeContentDocumentResponse({
                authorize: options.authorize,
                request,
                requiredScope: "content:write",
                scope,
                store: options.store,
                draft: true,
                document: toDocumentResponse(document),
                schema: await options.store.getSchema(scope, document.type),
                fileFieldMode,
                lookupMediaAsset,
              }),
            };
          } catch (error) {
            if (
              error instanceof RuntimeError &&
              error.code === "CONTENT_PATH_CONFLICT"
            ) {
              attempt++;
              candidatePath = `${basePath}-copy-${attempt}`;
              continue;
            }
            throw error;
          }
        }

        throw new RuntimeError({
          code: "DUPLICATE_PATH_EXHAUSTED",
          message: "Unable to generate a unique copy path after 99 attempts.",
          statusCode: 409,
          details: {
            documentId: params.documentId,
            basePath,
          },
        });
      });
    },
  );

  contentApp.delete?.(
    "/api/v1/content/:documentId",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        const fileFieldMode = parseFileFieldReadMode(request);
        const lookupMediaAsset = createCachedMediaAssetLookup(
          options.lookupMediaAsset,
        );
        await options.requireCsrf(request);
        const authorization = await options.authorize(request, {
          requiredScope: "content:delete",
          project: scope.project,
          environment: scope.environment,
        });
        const existing = await options.store.getById(scope, params.documentId, {
          draft: true,
        });

        if (!existing) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: {
              documentId: params.documentId,
            },
          });
        }

        await options.authorize(request, {
          requiredScope: "content:delete",
          project: scope.project,
          environment: scope.environment,
          documentPath: existing.path,
        });

        await assertNoActiveCollaboration(
          options.activeCollaboration,
          params.documentId,
        );

        const document = await commitMutation(
          "content.deleted",
          scope,
          authorization,
          () => options.store.softDelete(scope, params.documentId),
        );

        await invalidateInactiveCollaborationCache(
          options.inactiveCollaborationCache,
          params.documentId,
        );

        return {
          data: await shapeContentDocumentResponse({
            authorize: options.authorize,
            request,
            requiredScope: "content:delete",
            scope,
            store: options.store,
            draft: true,
            document: toDocumentResponse(document),
            schema: await options.store.getSchema(scope, document.type),
            fileFieldMode,
            lookupMediaAsset,
          }),
        };
      });
    },
  );
}
