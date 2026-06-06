import type {
  ApiPaginatedEnvelope,
  ContentPreviewTokenRequest,
  PaginationMetadata,
} from "@mdcms/shared";
import {
  RuntimeError,
  isRuntimeErrorLike,
  signMdcmsPreviewToken,
} from "@mdcms/shared";

import type { ApiKeyOperationScope } from "../auth.js";
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

const CONTENT_BULK_ACTIONS = new Set<ContentBulkAction>([
  "publish",
  "unpublish",
  "delete",
  "move",
]);

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

function parseBulkAction(value: unknown): ContentBulkAction {
  if (typeof value !== "string") {
    throw createInvalidBulkInputError(
      'Field "action" must be one of "publish", "unpublish", "delete", or "move".',
      { field: "action" },
    );
  }

  const action = value.trim();

  if (CONTENT_BULK_ACTIONS.has(action as ContentBulkAction)) {
    return action as ContentBulkAction;
  }

  throw createInvalidBulkInputError(
    'Field "action" must be one of "publish", "unpublish", "delete", or "move".',
    { field: "action", value },
  );
}

function parseBulkDocumentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw createInvalidBulkInputError('Field "documentIds" must be an array.', {
      field: "documentIds",
    });
  }

  if (value.length < 1 || value.length > 100) {
    throw createInvalidBulkInputError(
      'Field "documentIds" must contain between 1 and 100 document IDs.',
      { field: "documentIds" },
    );
  }

  const documentIds = value.map((documentId, index) => {
    if (typeof documentId !== "string") {
      throw createInvalidBulkInputError(
        'Field "documentIds" must contain only non-empty strings.',
        { field: "documentIds", index },
      );
    }

    const trimmed = documentId.trim();

    if (trimmed.length === 0) {
      throw createInvalidBulkInputError(
        'Field "documentIds" must contain only non-empty strings.',
        { field: "documentIds", index },
      );
    }

    return trimmed;
  });

  if (new Set(documentIds).size !== documentIds.length) {
    throw createInvalidBulkInputError(
      'Field "documentIds" must contain unique document IDs.',
      { field: "documentIds" },
    );
  }

  return documentIds;
}

function parseBulkMoveTargetDirectory(value: unknown): string {
  if (!isRecord(value)) {
    throw createInvalidBulkInputError(
      'Field "move.targetDirectory" is required for move.',
      { field: "move.targetDirectory" },
    );
  }

  const targetDirectory = value.targetDirectory;

  if (typeof targetDirectory !== "string") {
    throw createInvalidBulkInputError(
      'Field "move.targetDirectory" must be a string.',
      { field: "move.targetDirectory" },
    );
  }

  const trimmed = targetDirectory.trim();

  if (trimmed.length === 0) {
    return "";
  }

  if (trimmed.startsWith("/")) {
    throw createInvalidBulkInputError(
      'Field "move.targetDirectory" must not start with a leading slash.',
      { field: "move.targetDirectory", value: trimmed },
    );
  }

  if (trimmed.endsWith("/")) {
    throw createInvalidBulkInputError(
      'Field "move.targetDirectory" must not end with a trailing slash.',
      { field: "move.targetDirectory", value: trimmed },
    );
  }

  if (/(^|\/)\.\.(\/|$)/.test(trimmed)) {
    throw createInvalidBulkInputError(
      'Field "move.targetDirectory" must not contain path traversal segments ("..").',
      { field: "move.targetDirectory", value: trimmed },
    );
  }

  return trimmed;
}

function hasInputField(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function assertBulkActionFieldAllowed(input: {
  body: Record<string, unknown>;
  action: ContentBulkAction;
  field: "changeSummary" | "actorId" | "move";
  allowedActions: readonly ContentBulkAction[];
}): void {
  if (
    !hasInputField(input.body, input.field) ||
    input.allowedActions.includes(input.action)
  ) {
    return;
  }

  throw createInvalidBulkInputError(
    `Field "${input.field}" is not accepted for "${input.action}" bulk operations.`,
    { field: input.field, action: input.action },
  );
}

function parseContentBulkOperationInput(
  body: unknown,
): ContentBulkOperationInput {
  if (!isRecord(body)) {
    throw createInvalidBulkInputError(
      "Bulk content request body must be an object.",
      { field: "body" },
    );
  }

  const action = parseBulkAction(body.action);
  const documentIds = parseBulkDocumentIds(body.documentIds);
  assertBulkActionFieldAllowed({
    body,
    action,
    field: "changeSummary",
    allowedActions: ["publish"],
  });
  assertBulkActionFieldAllowed({
    body,
    action,
    field: "actorId",
    allowedActions: ["publish", "unpublish"],
  });
  assertBulkActionFieldAllowed({
    body,
    action,
    field: "move",
    allowedActions: ["move"],
  });
  const changeSummary =
    action === "publish"
      ? parseOptionalString(body.changeSummary, "changeSummary")
      : undefined;
  const actorId =
    action === "publish" || action === "unpublish"
      ? parseOptionalString(body.actorId, "actorId")
      : undefined;

  return {
    action,
    documentIds,
    ...(changeSummary ? { changeSummary } : undefined),
    ...(actorId ? { actorId } : undefined),
    ...(action === "move"
      ? {
          move: {
            targetDirectory: parseBulkMoveTargetDirectory(body.move),
          },
        }
      : undefined),
  };
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

      for (const doc of response.data) {
        if (!schemaCache.has(doc.type)) {
          schemaCache.set(
            doc.type,
            await options.store.getSchema(scope, doc.type),
          );
        }
        doc.frontmatter = stripUnknownFrontmatterFields(
          doc.frontmatter,
          schemaCache.get(doc.type),
        );
      }

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

      if (resolvePaths.length === 0) {
        return response;
      }

      const resolvePlan = await prepareResolvePlan({
        scope,
        store: options.store,
        documentType: resolvedType!,
        paths: resolvePaths,
      });

      return {
        ...response,
        data: await Promise.all(
          response.data.map((document) =>
            applyResolvePlan({
              authorize: options.authorize,
              request,
              requiredScope,
              scope,
              store: options.store,
              draft,
              document,
              plan: resolvePlan,
            }),
          ),
        ),
      };
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
        responseDocument.frontmatter = stripUnknownFrontmatterFields(
          responseDocument.frontmatter,
          typeSchema,
        );
        const resolvePlan = await prepareResolvePlan({
          scope,
          store: options.store,
          documentType: document.type,
          paths: resolvePaths,
        });

        return {
          data: await applyResolvePlan({
            authorize: options.authorize,
            document: responseDocument,
            request,
            requiredScope,
            scope,
            store: options.store,
            draft,
            plan: resolvePlan,
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
        const resolvePlan = await prepareResolvePlan({
          scope,
          store: options.store,
          documentType: versionDocument.type,
          paths: resolvePaths,
        });

        return {
          data: await applyResolvePlan({
            authorize: options.authorize,
            document: responseDocument,
            request,
            requiredScope: "content:read",
            scope,
            store: options.store,
            draft: false,
            plan: resolvePlan,
          }),
        };
      });
    },
  );

  contentApp.post?.("/api/v1/content", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
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
        data: toDocumentResponse(document),
      };
    });
  });

  contentApp.post?.("/api/v1/content/bulk", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickScope(request);
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
            const targetDirectory = payload.move?.targetDirectory ?? "";
            const nextPath = buildBulkMovePath(existing, targetDirectory);

            await options.authorize(request, {
              requiredScope: "content:write",
              project: scope.project,
              environment: scope.environment,
              documentPath: nextPath,
            });

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

          results.push({
            documentId,
            status: "succeeded",
            document: toDocumentResponse(document),
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

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/restore",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
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

        const document = await commitMutation(
          "content.restored",
          scope,
          authorization,
          () => options.store.restore(scope, params.documentId),
        );

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/versions/:version/restore",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
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

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/publish",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
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
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/unpublish",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
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
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/duplicate",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
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
        const syncState = await options.getWriteSchemaSyncState(scope);
        const schemaHash = syncState?.schemaHash;

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
                  schemaHash ? { expectedSchemaHash: schemaHash } : undefined,
                ),
            );

            return {
              data: toDocumentResponse(document),
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
        const document = await commitMutation(
          "content.deleted",
          scope,
          authorization,
          () => options.store.softDelete(scope, params.documentId),
        );

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );
}
