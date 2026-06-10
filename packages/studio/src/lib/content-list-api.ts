import {
  RuntimeError,
  type ApiPaginatedEnvelope,
  type ContentBulkAction,
  type ContentBulkOperationInput,
  type ContentBulkOperationResponse,
  type ContentBulkOperationResult,
  type ContentDocumentResponse,
  type ContentUserSummary,
} from "@mdcms/shared";

import type { MdcmsConfig } from "./studio-component.js";
import {
  applyStudioAuthToRequestInit,
  isStudioCookieAuth,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

export type StudioContentListConfig = Pick<
  MdcmsConfig,
  "project" | "environment" | "serverUrl"
>;

export type StudioContentListApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioContentListQuery = {
  type?: string;
  groupBy?: "translationGroup";
  q?: string;
  draft?: boolean;
  published?: boolean;
  hasUnpublishedChanges?: boolean;
  isDeleted?: boolean;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type StudioContentListResult =
  ApiPaginatedEnvelope<ContentDocumentResponse> & {
    users?: Record<string, ContentUserSummary>;
  };

export type StudioContentBulkOperationInput = ContentBulkOperationInput & {
  schemaHash?: string;
  signal?: AbortSignal;
};

export type StudioContentBulkOperation = (
  input: StudioContentBulkOperationInput,
) => Promise<ContentBulkOperationResponse>;

export type StudioContentListApi = {
  list: (query?: StudioContentListQuery) => Promise<StudioContentListResult>;
  bulkOperation?: StudioContentBulkOperation;
};

export type StudioContentListApiWithBulkOperation = StudioContentListApi & {
  bulkOperation: StudioContentBulkOperation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isContentFormat(value: unknown): value is "md" | "mdx" {
  return value === "md" || value === "mdx";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isReferenceResolveErrorEntry(entry: Record<string, unknown>): boolean {
  return (
    isRecord(entry.ref) &&
    isString(entry.ref.documentId) &&
    isString(entry.ref.type)
  );
}

function isMediaResolveErrorEntry(entry: Record<string, unknown>): boolean {
  if (!isRecord(entry.media) || !isString(entry.media.assetId)) {
    return false;
  }

  return (
    (entry.media.expectedMime === undefined ||
      isStringArray(entry.media.expectedMime)) &&
    (entry.media.actualMimeType === undefined ||
      isString(entry.media.actualMimeType))
  );
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isContentBulkAction(value: unknown): value is ContentBulkAction {
  return (
    value === "publish" ||
    value === "unpublish" ||
    value === "delete" ||
    value === "move"
  );
}

function extractRoutePayload(payload: unknown): {
  code?: unknown;
  message?: unknown;
  data?: unknown;
} {
  if (!isRecord(payload)) {
    return {};
  }

  return {
    code: payload.code,
    message: payload.message,
    data: payload.data,
  };
}

function toContentListFailureError(
  operation: string,
  response: Response,
  payload: unknown,
  fallbackMessage: string,
): RuntimeError {
  const parsed = extractRoutePayload(payload);
  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : "CONTENT_LIST_REQUEST_FAILED";
  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : fallbackMessage;

  return new RuntimeError({
    code,
    message,
    statusCode: response.status,
    details: {
      operation,
      status: response.status,
      payload,
    },
  });
}

function toInvalidContentListResponseError(
  operation: string,
  fallbackMessage: string,
  payload: unknown,
): RuntimeError {
  return new RuntimeError({
    code: "CONTENT_LIST_RESPONSE_INVALID",
    message: fallbackMessage,
    statusCode: 500,
    details: {
      operation,
      payload,
    },
  });
}

function isResolveErrorsMap(
  value: unknown,
): value is ContentDocumentResponse["resolveErrors"] {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => {
    if (!isRecord(entry) || !isString(entry.code) || !isString(entry.message)) {
      return false;
    }

    return (
      isReferenceResolveErrorEntry(entry) || isMediaResolveErrorEntry(entry)
    );
  });
}

function isContentDocumentResponse(
  value: unknown,
): value is ContentDocumentResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.documentId) &&
    isNonEmptyString(value.translationGroupId) &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.environment) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.locale) &&
    isContentFormat(value.format) &&
    isBoolean(value.isDeleted) &&
    isBoolean(value.hasUnpublishedChanges) &&
    isFiniteNumber(value.version) &&
    (isFiniteNumber(value.publishedVersion) ||
      value.publishedVersion === null) &&
    isFiniteNumber(value.draftRevision) &&
    isRecord(value.frontmatter) &&
    !Array.isArray(value.frontmatter) &&
    isString(value.body) &&
    (value.resolveErrors === undefined ||
      isResolveErrorsMap(value.resolveErrors)) &&
    (value.localesPresent === undefined ||
      isStringArray(value.localesPresent)) &&
    (value.publishedLocales === undefined ||
      isStringArray(value.publishedLocales)) &&
    isNonEmptyString(value.createdBy) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedBy) &&
    isNonEmptyString(value.updatedAt)
  );
}

function isContentBulkOperationResult(
  value: unknown,
): value is ContentBulkOperationResult {
  if (!isRecord(value) || !isNonEmptyString(value.documentId)) {
    return false;
  }

  if (value.status === "succeeded") {
    return isContentDocumentResponse(value.document);
  }

  if (value.status === "failed") {
    return (
      isRecord(value.error) &&
      isNonEmptyString(value.error.code) &&
      isString(value.error.message) &&
      isFiniteNumber(value.error.statusCode)
    );
  }

  return false;
}

function toContentBulkOperationResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentBulkOperationResponse {
  const parsed = extractRoutePayload(payload);

  if (!isRecord(parsed.data)) {
    throw toInvalidContentListResponseError(
      operation,
      fallbackMessage,
      payload,
    );
  }

  const data = parsed.data;

  if (
    !isContentBulkAction(data.action) ||
    !isFiniteNumber(data.requested) ||
    !isFiniteNumber(data.succeeded) ||
    !isFiniteNumber(data.failed) ||
    !Array.isArray(data.results) ||
    !data.results.every(isContentBulkOperationResult)
  ) {
    throw toInvalidContentListResponseError(
      operation,
      fallbackMessage,
      payload,
    );
  }

  return data as ContentBulkOperationResponse;
}

async function requestContentListJson(
  options: StudioContentListApiOptions,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    input,
    applyStudioAuthToRequestInit(options.auth, init),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toContentListFailureError(
      init.method ?? "GET",
      response,
      payload,
      "Content list request failed.",
    );
  }

  return payload;
}

async function bootstrapStudioSessionCsrfToken(
  config: StudioContentListConfig,
  options: StudioContentListApiOptions,
): Promise<string | undefined> {
  if (!isStudioCookieAuth(options.auth)) {
    return undefined;
  }

  const payload = await requestContentListJson(
    options,
    resolveStudioRelativeUrl("/api/v1/auth/session", config.serverUrl),
    {
      method: "GET",
    },
  );

  const parsed = extractRoutePayload(payload);
  const csrfToken =
    isRecord(parsed.data) && typeof parsed.data.csrfToken === "string"
      ? parsed.data.csrfToken
      : undefined;

  if (!csrfToken) {
    throw toInvalidContentListResponseError(
      "GET /api/v1/auth/session",
      "Studio auth/session response did not include a CSRF token.",
      payload,
    );
  }

  return csrfToken;
}

export function createStudioContentListApi(
  config: StudioContentListConfig,
  options: StudioContentListApiOptions = {},
): StudioContentListApiWithBulkOperation {
  const fetcher = options.fetcher ?? fetch;

  return {
    async list(query = {}) {
      const url = resolveStudioRelativeUrl("/api/v1/content", config.serverUrl);

      if (query.type) url.searchParams.set("type", query.type);
      if (query.groupBy) url.searchParams.set("groupBy", query.groupBy);
      const trimmedQ = query.q?.trim();
      if (trimmedQ) url.searchParams.set("q", trimmedQ);
      if (query.draft !== undefined)
        url.searchParams.set("draft", String(query.draft));
      if (query.published !== undefined)
        url.searchParams.set("published", String(query.published));
      if (query.hasUnpublishedChanges !== undefined)
        url.searchParams.set(
          "hasUnpublishedChanges",
          String(query.hasUnpublishedChanges),
        );
      if (query.isDeleted !== undefined)
        url.searchParams.set("isDeleted", String(query.isDeleted));
      if (query.sort) url.searchParams.set("sort", query.sort);
      if (query.order) url.searchParams.set("order", query.order);
      if (query.limit !== undefined)
        url.searchParams.set("limit", String(query.limit));
      if (query.offset !== undefined)
        url.searchParams.set("offset", String(query.offset));

      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "GET",
          headers: {
            "x-mdcms-project": config.project,
            "x-mdcms-environment": config.environment,
          },
        }),
      );

      const payload = await readResponsePayload(response);

      if (!response.ok) {
        const parsed = isRecord(payload) ? payload : {};
        const code =
          typeof parsed.code === "string" && parsed.code.trim().length > 0
            ? parsed.code
            : "CONTENT_LIST_REQUEST_FAILED";
        const message =
          typeof parsed.message === "string" && parsed.message.trim().length > 0
            ? parsed.message
            : "Content list request failed.";

        throw new RuntimeError({
          code,
          message,
          statusCode: response.status,
          details: { status: response.status, payload },
        });
      }

      if (
        !isRecord(payload) ||
        !Array.isArray(payload.data) ||
        !isRecord(payload.pagination)
      ) {
        return {
          data: [],
          pagination: { total: 0, limit: 1, offset: 0, hasMore: false },
        };
      }

      const pagination = payload.pagination;

      const users = isRecord(payload.users)
        ? (payload.users as Record<string, ContentUserSummary>)
        : undefined;

      return {
        data: payload.data as ContentDocumentResponse[],
        pagination: {
          total: isFiniteNumber(pagination.total) ? pagination.total : 0,
          limit: isFiniteNumber(pagination.limit) ? pagination.limit : 1,
          offset: isFiniteNumber(pagination.offset) ? pagination.offset : 0,
          hasMore: isBoolean(pagination.hasMore) ? pagination.hasMore : false,
        },
        ...(users ? { users } : {}),
      };
    },
    async bulkOperation(input) {
      const { schemaHash, signal, ...payload } = input;
      const csrfToken = await bootstrapStudioSessionCsrfToken(config, options);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-mdcms-project": config.project,
        "x-mdcms-environment": config.environment,
      };

      if (csrfToken) {
        headers["x-mdcms-csrf-token"] = csrfToken;
      }

      if (schemaHash) {
        headers["x-mdcms-schema-hash"] = schemaHash;
      }

      const responsePayload = await requestContentListJson(
        options,
        resolveStudioRelativeUrl("/api/v1/content/bulk", config.serverUrl),
        {
          method: "POST",
          signal,
          headers,
          body: JSON.stringify(payload),
        },
      );

      return toContentBulkOperationResponse(
        "POST /api/v1/content/bulk",
        responsePayload,
        "Bulk content operation response was invalid.",
      );
    },
  };
}
