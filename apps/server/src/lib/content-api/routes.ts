import type {
  ApiPaginatedEnvelope,
  ContentPreviewTokenRequest,
  PaginationMetadata,
} from "@mdcms/shared";
import { RuntimeError, signMdcmsPreviewToken } from "@mdcms/shared";

import type { ApiKeyOperationScope } from "../auth.js";
import { executeWithRuntimeErrorsHandled } from "../http-utils.js";

import {
  assertRequiredString,
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
  stripUnknownFrontmatterFields,
  toDocumentResponse,
  toVersionDocumentResponse,
  toVersionSummaryResponse,
} from "./responses.js";
import type {
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

export function mountContentApiRoutes(
  app: unknown,
  options: MountContentApiRoutesOptions,
): void {
  const contentApp = app as ContentRouteApp;

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
      await options.authorize(request, {
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
      const document = await options.store.create(scope, payload, {
        expectedSchemaHash: schemaHash,
      });

      return {
        data: toDocumentResponse(document),
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

        await options.authorize(request, {
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

        const document = await options.store.update(
          scope,
          params.documentId,
          payload,
          {
            expectedSchemaHash: schemaHash,
            expectedDraftRevision,
          },
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

        await options.authorize(request, {
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

        const document = await options.store.restore(scope, params.documentId);

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

        await options.authorize(request, {
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
        const document = await options.store.restoreVersion(
          scope,
          params.documentId,
          version,
          {
            targetStatus,
            changeSummary,
            actorId,
          },
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
        await options.authorize(request, {
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
        const document = await options.store.publish(scope, params.documentId, {
          changeSummary,
          actorId,
        });

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
        await options.authorize(request, {
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
        const document = await options.store.unpublish(
          scope,
          params.documentId,
          {
            actorId,
          },
        );

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );

  contentApp.post?.(
    "/api/v1/content/:documentId/duplicate",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const scope = pickScope(request);
        await options.requireCsrf(request);
        await options.authorize(request, {
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
            const document = await options.store.create(
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
        await options.authorize(request, {
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
        const document = await options.store.softDelete(
          scope,
          params.documentId,
        );

        return {
          data: toDocumentResponse(document),
        };
      });
    },
  );
}
