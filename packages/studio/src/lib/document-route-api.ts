import {
  RuntimeError,
  type ApiPaginatedEnvelope,
  type ContentDocumentResponse,
  type ContentPreviewTokenResponse,
  type ContentVersionDocumentResponse,
  type ContentVersionSummaryResponse,
  type TranslationVariantsResponse,
} from "@mdcms/shared";

import type { MdcmsConfig } from "./studio-component.js";
import {
  applyStudioAuthToRequestInit,
  isStudioCookieAuth,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import {
  isMediaResolveErrorEntry,
  isReferenceResolveErrorEntry,
} from "./resolve-error-validation.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

export type StudioDocumentRouteConfig = Pick<
  MdcmsConfig,
  "project" | "environment" | "serverUrl"
>;

export type StudioDocumentRouteWritePayload = {
  path?: string;
  type?: string;
  locale?: string;
  format?: "md" | "mdx";
  frontmatter?: Record<string, unknown>;
  body?: string;
  sourceDocumentId?: string;
  createdBy?: string;
  updatedBy?: string;
};

export type StudioDocumentRoutePublishPayload = {
  changeSummary?: string;
  actorId?: string;
};

export type StudioDocumentRouteLoadInput = {
  documentId: string;
  type: string;
  locale?: string;
};

export type StudioDocumentRouteMutationInput = {
  documentId: string;
  locale?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRouteVersionListInput =
  StudioDocumentRouteMutationInput & {
    limit?: number;
    offset?: number;
  };

export type StudioDocumentRouteVersionDetailInput =
  StudioDocumentRouteMutationInput & {
    version: number;
    resolve?: string | string[];
  };

export type StudioDocumentRouteRestoreVersionInput =
  StudioDocumentRouteMutationInput & {
    version: number;
    // The server defaults this to "draft" (see parseRestoreTargetStatus in
    // apps/server/src/lib/content-api/parsing.ts), which is the conservative
    // choice — restoring a published version straight to a new published
    // version requires `content:publish` rather than `content:write`.
    targetStatus?: "draft" | "published";
    changeSummary?: string;
    actorId?: string;
  };

export type StudioDocumentRouteCreateInput = {
  type: string;
  path: string;
  locale?: string;
  format?: "md" | "mdx";
  frontmatter?: Record<string, unknown>;
  body?: string;
  sourceDocumentId?: string;
  schemaHash?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRouteDuplicateInput = {
  documentId: string;
  locale?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRouteSoftDeleteInput = {
  documentId: string;
  locale?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRouteRestoreInput = {
  documentId: string;
  locale?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRoutePreviewTokenInput = {
  documentId: string;
  previewUrl?: string;
  signal?: AbortSignal;
};

export type StudioDocumentRouteApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioDocumentRouteListInput = {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
};

export type StudioDocumentRouteApi = {
  loadDraft: (
    input: StudioDocumentRouteLoadInput,
  ) => Promise<ContentDocumentResponse>;
  listContent: (
    input: StudioDocumentRouteListInput,
  ) => Promise<ApiPaginatedEnvelope<ContentDocumentResponse>>;
  bootstrapSessionCsrf: () => Promise<string | undefined>;
  updateDraft: (
    input: StudioDocumentRouteMutationInput & {
      payload: StudioDocumentRouteWritePayload;
      schemaHash?: string;
    },
  ) => Promise<ContentDocumentResponse>;
  publish: (
    input: StudioDocumentRouteMutationInput & {
      changeSummary?: string;
      actorId?: string;
    },
  ) => Promise<ContentDocumentResponse>;
  listVersions: (
    input: StudioDocumentRouteVersionListInput,
  ) => Promise<ApiPaginatedEnvelope<ContentVersionSummaryResponse>>;
  getVersion: (
    input: StudioDocumentRouteVersionDetailInput,
  ) => Promise<ContentVersionDocumentResponse>;
  create: (
    input: StudioDocumentRouteCreateInput,
  ) => Promise<ContentDocumentResponse>;
  duplicate: (
    input: StudioDocumentRouteDuplicateInput,
  ) => Promise<ContentDocumentResponse>;
  unpublish: (
    input: StudioDocumentRouteMutationInput & { actorId?: string },
  ) => Promise<ContentDocumentResponse>;
  softDelete: (
    input: StudioDocumentRouteSoftDeleteInput,
  ) => Promise<ContentDocumentResponse>;
  restore: (
    input: StudioDocumentRouteRestoreInput,
  ) => Promise<ContentDocumentResponse>;
  restoreVersion: (
    input: StudioDocumentRouteRestoreVersionInput,
  ) => Promise<ContentDocumentResponse>;
  listVariants: (input: {
    documentId: string;
    signal?: AbortSignal;
  }) => Promise<TranslationVariantsResponse>;
  createPreviewToken: (
    input: StudioDocumentRoutePreviewTokenInput,
  ) => Promise<ContentPreviewTokenResponse>;
};

type StudioDocumentRoutePayload = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
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

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isContentFormat(value: unknown): value is "md" | "mdx" {
  return value === "md" || value === "mdx";
}

function isResolveErrorsMap(value: unknown): value is Record<
  string,
  {
    code: string;
    message: string;
    ref?: {
      documentId: string;
      type: string;
    };
    media?: {
      assetId: string;
      expectedMime?: string[];
      actualMimeType?: string;
    };
  }
> {
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

function mergeHeaders(
  ...headerSets: Array<HeadersInit | undefined>
): HeadersInit | undefined {
  const headers = new Headers();

  for (const headerSet of headerSets) {
    if (!headerSet) {
      continue;
    }

    new Headers(headerSet).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return Array.from(headers.entries()).length > 0
    ? Object.fromEntries(headers.entries())
    : undefined;
}

function buildUrl(
  config: StudioDocumentRouteConfig,
  path: string,
  query?: Record<string, string | number | string[] | undefined>,
): URL {
  const url = resolveStudioRelativeUrl(path, config.serverUrl);

  if (!query) {
    return url;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function authoringDocumentQuery(
  query: Record<string, string | number | string[] | undefined> = {},
): Record<string, string | number | string[] | undefined> {
  return {
    ...query,
    fileFields: "raw",
  };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractRoutePayload(payload: unknown): StudioDocumentRoutePayload {
  if (!isRecord(payload)) {
    return {};
  }

  const data = payload.data;
  const code = payload.code;
  const message = payload.message;

  return {
    code,
    message,
    data,
  };
}

function toRouteFailureError(
  operation: string,
  response: Response,
  payload: unknown,
  fallbackMessage: string,
): RuntimeError {
  const parsed = extractRoutePayload(payload);
  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : "DOCUMENT_ROUTE_REQUEST_FAILED";
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

function toInvalidRouteResponseError(
  operation: string,
  fallbackMessage: string,
  payload: unknown,
): RuntimeError {
  return new RuntimeError({
    code: "DOCUMENT_ROUTE_RESPONSE_INVALID",
    message: fallbackMessage,
    statusCode: 500,
    details: {
      operation,
      payload,
    },
  });
}

function validateContentDocumentResponseData(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentDocumentResponse {
  const parsed = extractRoutePayload(payload);

  if (!isRecord(parsed.data)) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  const data = parsed.data;

  if (
    !isNonEmptyString(data.documentId) ||
    !isNonEmptyString(data.translationGroupId) ||
    !isNonEmptyString(data.project) ||
    !isNonEmptyString(data.environment) ||
    !isNonEmptyString(data.path) ||
    !isNonEmptyString(data.type) ||
    !isNonEmptyString(data.locale) ||
    !isContentFormat(data.format) ||
    !isBoolean(data.isDeleted) ||
    !isBoolean(data.hasUnpublishedChanges) ||
    !isFiniteNumber(data.version) ||
    !(
      isFiniteNumber(data.publishedVersion) || data.publishedVersion === null
    ) ||
    !isFiniteNumber(data.draftRevision) ||
    !isRecord(data.frontmatter) ||
    Array.isArray(data.frontmatter) ||
    !isString(data.body) ||
    !isNonEmptyString(data.createdBy) ||
    !isNonEmptyString(data.createdAt) ||
    !isNonEmptyString(data.updatedBy) ||
    !isNonEmptyString(data.updatedAt) ||
    (data.resolveErrors !== undefined &&
      !isResolveErrorsMap(data.resolveErrors))
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return data as ContentDocumentResponse;
}

function validateContentVersionSummaryResponseData(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentVersionSummaryResponse {
  const parsed = extractRoutePayload(payload);

  if (!isRecord(parsed.data)) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  const data = parsed.data;

  if (
    !isNonEmptyString(data.documentId) ||
    !isNonEmptyString(data.translationGroupId) ||
    !isNonEmptyString(data.project) ||
    !isNonEmptyString(data.environment) ||
    !isFiniteNumber(data.version) ||
    !isNonEmptyString(data.path) ||
    !isNonEmptyString(data.type) ||
    !isNonEmptyString(data.locale) ||
    !isContentFormat(data.format) ||
    !isNonEmptyString(data.publishedAt) ||
    !isNonEmptyString(data.publishedBy) ||
    (data.changeSummary !== undefined && !isString(data.changeSummary))
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return data as ContentVersionSummaryResponse;
}

function validateContentVersionDocumentResponseData(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentVersionDocumentResponse {
  const data = validateContentVersionSummaryResponseData(
    operation,
    payload,
    fallbackMessage,
  );
  const parsed = extractRoutePayload(payload);

  if (
    !isRecord(parsed.data) ||
    !isRecord(parsed.data.frontmatter) ||
    Array.isArray(parsed.data.frontmatter) ||
    !isString(parsed.data.body) ||
    (parsed.data.resolveErrors !== undefined &&
      !isResolveErrorsMap(parsed.data.resolveErrors))
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return {
    ...data,
    frontmatter: parsed.data.frontmatter as Record<string, unknown>,
    body: parsed.data.body as string,
    resolveErrors: parsed.data.resolveErrors as
      | ContentVersionDocumentResponse["resolveErrors"]
      | undefined,
  };
}

function validatePagination(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ApiPaginatedEnvelope<unknown>["pagination"] {
  if (
    !isRecord(payload) ||
    !isFiniteNumber(payload.total) ||
    !isFiniteNumber(payload.limit) ||
    !isFiniteNumber(payload.offset) ||
    !isBoolean(payload.hasMore)
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return {
    total: payload.total,
    limit: payload.limit,
    offset: payload.offset,
    hasMore: payload.hasMore,
  };
}

function toPaginatedVersionSummaryResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ApiPaginatedEnvelope<ContentVersionSummaryResponse> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return {
    data: payload.data.map((item) =>
      validateContentVersionSummaryResponseData(
        operation,
        { data: item },
        fallbackMessage,
      ),
    ),
    pagination: validatePagination(
      operation,
      payload.pagination,
      fallbackMessage,
    ),
  };
}

function toContentDocumentResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentDocumentResponse {
  return validateContentDocumentResponseData(
    operation,
    payload,
    fallbackMessage,
  );
}

function toContentPreviewTokenResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentPreviewTokenResponse {
  const parsed = extractRoutePayload(payload);

  if (
    !isRecord(parsed.data) ||
    !isNonEmptyString(parsed.data.token) ||
    !isNonEmptyString(parsed.data.expiresAt)
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return parsed.data as ContentPreviewTokenResponse;
}

function toPaginatedContentDocumentResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ApiPaginatedEnvelope<ContentDocumentResponse> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  return {
    data: payload.data.map((item) =>
      validateContentDocumentResponseData(
        operation,
        { data: item },
        fallbackMessage,
      ),
    ),
    pagination: validatePagination(
      operation,
      payload.pagination,
      fallbackMessage,
    ),
  };
}

function toContentVersionDocumentResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): ContentVersionDocumentResponse {
  return validateContentVersionDocumentResponseData(
    operation,
    payload,
    fallbackMessage,
  );
}

function toTranslationVariantsResponse(
  operation: string,
  payload: unknown,
  fallbackMessage: string,
): TranslationVariantsResponse {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray((payload as Record<string, unknown>).data)
  ) {
    throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
  }

  const data = (payload as Record<string, unknown>).data as unknown[];

  for (const row of data) {
    if (
      !row ||
      typeof row !== "object" ||
      typeof (row as Record<string, unknown>).documentId !== "string" ||
      typeof (row as Record<string, unknown>).locale !== "string" ||
      typeof (row as Record<string, unknown>).path !== "string" ||
      typeof (row as Record<string, unknown>).hasUnpublishedChanges !==
        "boolean"
    ) {
      throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
    }

    const publishedVersion = (row as Record<string, unknown>).publishedVersion;
    if (publishedVersion !== null && typeof publishedVersion !== "number") {
      throw toInvalidRouteResponseError(operation, fallbackMessage, payload);
    }
  }

  return payload as TranslationVariantsResponse;
}

async function requestRouteJson(
  config: StudioDocumentRouteConfig,
  options: StudioDocumentRouteApiOptions,
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
    throw toRouteFailureError(
      init.method ?? "GET",
      response,
      payload,
      "Document route request failed.",
    );
  }

  return payload;
}

async function bootstrapStudioSessionCsrfToken(
  config: StudioDocumentRouteConfig,
  options: StudioDocumentRouteApiOptions,
): Promise<string | undefined> {
  if (!isStudioCookieAuth(options.auth)) {
    return undefined;
  }

  const payload = await requestRouteJson(
    config,
    options,
    buildUrl(config, "/api/v1/auth/session"),
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
    throw new RuntimeError({
      code: "DOCUMENT_ROUTE_RESPONSE_INVALID",
      message: "Studio auth/session response did not include a CSRF token.",
      statusCode: 500,
      details: {
        operation: "GET /api/v1/auth/session",
        payload,
      },
    });
  }

  return csrfToken;
}

function withContentRouteHeaders(
  headers: HeadersInit | undefined,
  input: { locale?: string },
): HeadersInit | undefined {
  const nextHeaders = new Headers(headers);
  const locale = input.locale?.trim();

  if (locale) {
    nextHeaders.set("x-mdcms-locale", locale);
  }

  return Array.from(nextHeaders.entries()).length > 0
    ? Object.fromEntries(nextHeaders.entries())
    : undefined;
}

async function requestContentRouteJson(
  options: StudioDocumentRouteApiOptions,
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
    throw toRouteFailureError(
      init.method ?? "GET",
      response,
      payload,
      "Content route request failed.",
    );
  }

  return payload;
}

async function requestContentMutation(
  config: StudioDocumentRouteConfig,
  options: StudioDocumentRouteApiOptions,
  input: {
    method: "PUT" | "POST";
    path: string;
    query?: Record<string, string | number | string[] | undefined>;
    locale?: string;
    payload: unknown;
    signal?: AbortSignal;
    schemaHash?: string;
  },
): Promise<unknown> {
  const csrfToken = await bootstrapStudioSessionCsrfToken(config, options);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (csrfToken) {
    headers["x-mdcms-csrf-token"] = csrfToken;
  }

  if (input.schemaHash) {
    headers["x-mdcms-schema-hash"] = input.schemaHash;
  }

  const payload = await requestContentRouteJson(
    options,
    buildUrl(config, input.path, input.query),
    {
      method: input.method,
      signal: input.signal,
      headers: withContentRouteHeaders(
        mergeHeaders({
          ...headers,
          "x-mdcms-project": config.project,
          "x-mdcms-environment": config.environment,
        }),
        {
          locale: input.locale,
        },
      ),
      body: JSON.stringify(input.payload),
    },
  );

  return payload;
}

async function requestContentDeletion(
  config: StudioDocumentRouteConfig,
  options: StudioDocumentRouteApiOptions,
  input: {
    path: string;
    query?: Record<string, string | number | string[] | undefined>;
    locale?: string;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const csrfToken = await bootstrapStudioSessionCsrfToken(config, options);
  const headers: Record<string, string> = {};

  if (csrfToken) {
    headers["x-mdcms-csrf-token"] = csrfToken;
  }

  const payload = await requestContentRouteJson(
    options,
    buildUrl(config, input.path, input.query),
    {
      method: "DELETE",
      signal: input.signal,
      headers: withContentRouteHeaders(
        mergeHeaders({
          ...headers,
          "x-mdcms-project": config.project,
          "x-mdcms-environment": config.environment,
        }),
        { locale: input.locale },
      ),
    },
  );

  return payload;
}

/**
 * createStudioDocumentRouteApi centralizes Studio document route requests for
 * draft reads, draft writes, publish actions, and version history reads.
 */
export function createStudioDocumentRouteApi(
  config: StudioDocumentRouteConfig,
  options: StudioDocumentRouteApiOptions = {},
): StudioDocumentRouteApi {
  return {
    async loadDraft(input) {
      const payload = await requestContentRouteJson(
        options,
        buildUrl(
          config,
          `/api/v1/content/${encodeURIComponent(input.documentId)}`,
          authoringDocumentQuery({
            draft: "true",
          }),
        ),
        {
          method: "GET",
          headers: withContentRouteHeaders(
            mergeHeaders({
              "x-mdcms-project": config.project,
              "x-mdcms-environment": config.environment,
            }),
            {
              locale: input.locale ?? "en",
            },
          ),
        },
      );

      return toContentDocumentResponse(
        "GET /api/v1/content/:documentId?draft=true",
        payload,
        "Failed to load document draft.",
      );
    },
    async listContent(input) {
      const payload = await requestContentRouteJson(
        options,
        buildUrl(config, "/api/v1/content", {
          type: input.type,
          q: input.q,
          limit: input.limit,
          offset: input.offset,
          draft: "true",
        }),
        {
          method: "GET",
          signal: input.signal,
          headers: mergeHeaders({
            "x-mdcms-project": config.project,
            "x-mdcms-environment": config.environment,
          }),
        },
      );
      return toPaginatedContentDocumentResponse(
        "GET /api/v1/content",
        payload,
        "Failed to list documents.",
      );
    },
    async bootstrapSessionCsrf() {
      return bootstrapStudioSessionCsrfToken(config, options);
    },
    async updateDraft(input) {
      const payload = await requestContentMutation(config, options, {
        method: "PUT",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: input.payload,
        schemaHash: input.schemaHash,
      });

      return toContentDocumentResponse(
        "PUT /api/v1/content/:documentId",
        payload,
        "Failed to update document draft.",
      );
    },
    async createPreviewToken(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}/preview-token`,
        signal: input.signal,
        payload: {
          previewUrl: input.previewUrl,
        },
      });

      return toContentPreviewTokenResponse(
        "POST /api/v1/content/:documentId/preview-token",
        payload,
        "Failed to create preview token.",
      );
    },
    async publish(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}/publish`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: {
          changeSummary: input.changeSummary,
          actorId: input.actorId,
        },
      });

      return toContentDocumentResponse(
        "POST /api/v1/content/:documentId/publish",
        payload,
        "Failed to publish document.",
      );
    },
    async listVersions(input) {
      const payload = await requestContentRouteJson(
        options,
        buildUrl(
          config,
          `/api/v1/content/${encodeURIComponent(input.documentId)}/versions`,
          {
            limit: input.limit,
            offset: input.offset,
          },
        ),
        {
          method: "GET",
          signal: input.signal,
          headers: withContentRouteHeaders(
            mergeHeaders({
              "x-mdcms-project": config.project,
              "x-mdcms-environment": config.environment,
            }),
            {
              locale: input.locale,
            },
          ),
        },
      );

      return toPaginatedVersionSummaryResponse(
        "GET /api/v1/content/:documentId/versions",
        payload,
        "Failed to load document version history.",
      );
    },
    async getVersion(input) {
      const payload = await requestContentRouteJson(
        options,
        buildUrl(
          config,
          `/api/v1/content/${encodeURIComponent(input.documentId)}/versions/${encodeURIComponent(String(input.version))}`,
          {
            resolve: input.resolve,
          },
        ),
        {
          method: "GET",
          signal: input.signal,
          headers: withContentRouteHeaders(
            mergeHeaders({
              "x-mdcms-project": config.project,
              "x-mdcms-environment": config.environment,
            }),
            {
              locale: input.locale,
            },
          ),
        },
      );

      return toContentVersionDocumentResponse(
        "GET /api/v1/content/:documentId/versions/:version",
        payload,
        "Failed to load document version.",
      );
    },
    async create(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: "/api/v1/content",
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        schemaHash: input.schemaHash,
        payload: {
          type: input.type,
          path: input.path,
          locale: input.locale,
          format: input.format ?? "mdx",
          frontmatter: input.frontmatter ?? {},
          body: input.body ?? "",
          ...(input.sourceDocumentId
            ? { sourceDocumentId: input.sourceDocumentId }
            : {}),
        },
      });

      return toContentDocumentResponse(
        "POST /api/v1/content",
        payload,
        "Failed to create document.",
      );
    },
    async duplicate(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}/duplicate`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: {},
      });

      return toContentDocumentResponse(
        "POST /api/v1/content/:documentId/duplicate",
        payload,
        "Failed to duplicate document.",
      );
    },
    async unpublish(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}/unpublish`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: { actorId: input.actorId },
      });

      return toContentDocumentResponse(
        "POST /api/v1/content/:documentId/unpublish",
        payload,
        "Failed to unpublish document.",
      );
    },
    async softDelete(input) {
      const payload = await requestContentDeletion(config, options, {
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
      });

      return toContentDocumentResponse(
        "DELETE /api/v1/content/:documentId",
        payload,
        "Failed to delete document.",
      );
    },
    async restore(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(input.documentId)}/restore`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: {},
      });

      return toContentDocumentResponse(
        "POST /api/v1/content/:documentId/restore",
        payload,
        "Failed to restore document.",
      );
    },
    async restoreVersion(input) {
      const payload = await requestContentMutation(config, options, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(
          input.documentId,
        )}/versions/${encodeURIComponent(String(input.version))}/restore`,
        query: authoringDocumentQuery(),
        locale: input.locale,
        signal: input.signal,
        payload: {
          ...(input.targetStatus !== undefined
            ? { targetStatus: input.targetStatus }
            : {}),
          ...(input.changeSummary !== undefined
            ? { changeSummary: input.changeSummary }
            : {}),
          ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        },
      });

      return toContentDocumentResponse(
        "POST /api/v1/content/:documentId/versions/:version/restore",
        payload,
        "Failed to restore document version.",
      );
    },
    async listVariants(input) {
      const payload = await requestContentRouteJson(
        options,
        buildUrl(
          config,
          `/api/v1/content/${encodeURIComponent(input.documentId)}/variants`,
        ),
        {
          method: "GET",
          signal: input.signal,
          headers: withContentRouteHeaders(
            mergeHeaders({
              "x-mdcms-project": config.project,
              "x-mdcms-environment": config.environment,
            }),
            {},
          ),
        },
      );

      return toTranslationVariantsResponse(
        "GET /api/v1/content/:documentId/variants",
        payload,
        "Failed to load translation variants.",
      );
    },
  };
}
