import type {
  ApiDataEnvelope,
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
  ErrorEnvelope,
  MdcmsPreviewTokenExpectedClaims,
  MdcmsPreviewVerificationResult,
} from "@mdcms/shared";
import {
  readMdcmsPreviewTokenFromUrl,
  verifyMdcmsPreviewToken,
} from "@mdcms/shared";

export type MdcmsClientOptions = {
  serverUrl: string;
  apiKey: string;
  project: string;
  environment: string;
  fetch?: typeof fetch;
};

export type MdcmsListInput = {
  project?: string;
  environment?: string;
  locale?: string;
  q?: string;
  resolve?: string[];
  draft?: boolean;
  fileFields?: "raw";
  path?: string;
  slug?: string;
  published?: boolean;
  isDeleted?: boolean;
  hasUnpublishedChanges?: boolean;
  limit?: number;
  offset?: number;
  sort?: "createdAt" | "updatedAt" | "path";
  order?: "asc" | "desc";
};

export type MdcmsClient = {
  get: (type: string, input: MdcmsGetInput) => Promise<ContentDocumentResponse>;
  list: (
    type: string,
    input?: MdcmsListInput,
  ) => Promise<ApiPaginatedEnvelope<ContentDocumentResponse>>;
  getPreviewDocumentFromRequest: (
    request: MdcmsPreviewRequest,
    input: MdcmsPreviewDocumentFromRequestInput,
  ) => Promise<ContentDocumentResponse>;
};

export type MdcmsGetInput = {
  project?: string;
  environment?: string;
  locale?: string;
  resolve?: string[];
  draft?: boolean;
  fileFields?: "raw";
} & ({ id: string; slug?: never } | { slug: string; id?: never });

export type MdcmsPreviewRequest = Request | URL | string;

export type VerifyMdcmsPreviewRequestOptions = {
  secret: string;
  now?: Date;
  expected?: MdcmsPreviewTokenExpectedClaims;
};

export type MdcmsPreviewDocumentFromRequestInput =
  VerifyMdcmsPreviewRequestOptions & {
    resolve?: string[];
  };

export type MdcmsClientErrorCode =
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "AMBIGUOUS_RESULT"
  | "PREVIEW_TOKEN_INVALID";

export class MdcmsApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  readonly timestamp?: string;

  constructor(input: {
    statusCode: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    timestamp?: string;
  }) {
    super(input.message);
    this.name = "MdcmsApiError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
    this.timestamp = input.timestamp;
  }
}

export class MdcmsClientError extends Error {
  readonly code: MdcmsClientErrorCode;
  override readonly cause?: unknown;

  constructor(input: {
    code: MdcmsClientErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "MdcmsClientError";
    this.code = input.code;
    this.cause = input.cause;
  }
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
}

function toRequestUrl(request: MdcmsPreviewRequest): URL {
  if (typeof request === "string") {
    return new URL(request);
  }

  if (request instanceof URL) {
    return request;
  }

  return new URL(request.url);
}

function appendQueryParam(
  searchParams: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined) {
    return;
  }

  searchParams.set(key, String(value));
}

function appendRepeatedQueryParam(
  searchParams: URLSearchParams,
  key: string,
  values: string[] | undefined,
): void {
  if (!values) {
    return;
  }

  for (const value of values) {
    searchParams.append(key, value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonBody(response: Response): Promise<unknown> {
  return response.json().catch((error: unknown) => {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected a JSON response body.",
      cause: error,
    });
  });
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.status === "error" &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.details === undefined || isRecord(value.details)) &&
    (value.requestId === undefined || typeof value.requestId === "string") &&
    typeof value.timestamp === "string"
  );
}

function assertPaginatedContentEnvelope(
  value: unknown,
): asserts value is ApiPaginatedEnvelope<ContentDocumentResponse> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected a paginated content response object.",
    });
  }

  const candidate = value as {
    data?: unknown;
    pagination?: unknown;
  };

  if (!Array.isArray(candidate.data)) {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected response.data to be an array.",
    });
  }

  if (
    typeof candidate.pagination !== "object" ||
    candidate.pagination === null ||
    Array.isArray(candidate.pagination)
  ) {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected response.pagination to be an object.",
    });
  }
}

function assertDocumentEnvelope(
  value: unknown,
): asserts value is ApiDataEnvelope<ContentDocumentResponse> {
  if (!isRecord(value)) {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected a content response object.",
    });
  }

  if (!isRecord(value.data)) {
    throw new MdcmsClientError({
      code: "INVALID_RESPONSE",
      message: "Expected response.data to be an object.",
    });
  }
}

async function requestJson(
  fetcher: typeof fetch,
  url: URL,
  apiKey: string,
  scope: {
    project: string;
    environment: string;
  },
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: new Headers({
        authorization: `Bearer ${apiKey}`,
        "x-mdcms-project": scope.project,
        "x-mdcms-environment": scope.environment,
      }),
    });

    const body = await parseJsonBody(response);

    if (!response.ok) {
      if (isErrorEnvelope(body)) {
        throw new MdcmsApiError({
          statusCode: response.status,
          code: body.code,
          message: body.message,
          details: body.details,
          requestId: body.requestId,
          timestamp: body.timestamp,
        });
      }

      throw new MdcmsClientError({
        code: "INVALID_RESPONSE",
        message: "Expected an MDCMS error envelope response.",
      });
    }

    return body;
  } catch (error) {
    if (error instanceof MdcmsApiError || error instanceof MdcmsClientError) {
      throw error;
    }

    throw new MdcmsClientError({
      code: "NETWORK_ERROR",
      message: "Request failed before a valid MDCMS response was received.",
      cause: error,
    });
  }
}

export async function verifyMdcmsPreviewRequest(
  request: MdcmsPreviewRequest,
  options: VerifyMdcmsPreviewRequestOptions,
): Promise<MdcmsPreviewVerificationResult> {
  let url: URL;

  try {
    url = toRequestUrl(request);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  return verifyMdcmsPreviewToken(readMdcmsPreviewTokenFromUrl(url), {
    secret: options.secret,
    now: options.now,
    expected: options.expected,
  });
}

export function createClient(options: MdcmsClientOptions): MdcmsClient {
  const baseUrl = normalizeServerUrl(options.serverUrl);
  const fetcher = options.fetch ?? fetch;

  async function listDocuments(
    type: string,
    input: MdcmsListInput = {},
  ): Promise<ApiPaginatedEnvelope<ContentDocumentResponse>> {
    const scope = {
      project: input.project ?? options.project,
      environment: input.environment ?? options.environment,
    };

    const url = new URL(`${baseUrl}/api/v1/content`);
    url.searchParams.set("type", type);
    appendQueryParam(url.searchParams, "q", input.q);
    appendQueryParam(url.searchParams, "locale", input.locale);
    appendRepeatedQueryParam(url.searchParams, "resolve", input.resolve);
    appendQueryParam(url.searchParams, "draft", input.draft);
    appendQueryParam(url.searchParams, "path", input.path);
    appendQueryParam(url.searchParams, "slug", input.slug);
    appendQueryParam(url.searchParams, "fileFields", input.fileFields);
    appendQueryParam(url.searchParams, "published", input.published);
    appendQueryParam(url.searchParams, "isDeleted", input.isDeleted);
    appendQueryParam(
      url.searchParams,
      "hasUnpublishedChanges",
      input.hasUnpublishedChanges,
    );
    appendQueryParam(url.searchParams, "limit", input.limit);
    appendQueryParam(url.searchParams, "offset", input.offset);
    appendQueryParam(url.searchParams, "sort", input.sort);
    appendQueryParam(url.searchParams, "order", input.order);

    const body = await requestJson(fetcher, url, options.apiKey, scope);
    assertPaginatedContentEnvelope(body);
    return body;
  }

  async function getDocumentById(
    _type: string,
    input: Extract<MdcmsGetInput, { id: string }>,
  ): Promise<ContentDocumentResponse> {
    const scope = {
      project: input.project ?? options.project,
      environment: input.environment ?? options.environment,
    };

    const url = new URL(`${baseUrl}/api/v1/content/${input.id}`);
    appendQueryParam(url.searchParams, "locale", input.locale);
    appendRepeatedQueryParam(url.searchParams, "resolve", input.resolve);
    appendQueryParam(url.searchParams, "draft", input.draft);
    appendQueryParam(url.searchParams, "fileFields", input.fileFields);

    const body = await requestJson(fetcher, url, options.apiKey, scope);
    assertDocumentEnvelope(body);
    return body.data;
  }

  async function getDocument(
    type: string,
    input: MdcmsGetInput,
  ): Promise<ContentDocumentResponse> {
    if ("slug" in input && input.slug !== undefined) {
      const result = await listDocuments(type, {
        project: input.project,
        environment: input.environment,
        locale: input.locale,
        resolve: input.resolve,
        draft: input.draft,
        slug: input.slug,
        fileFields: input.fileFields,
      });

      if (result.data.length === 0) {
        throw new MdcmsClientError({
          code: "NOT_FOUND",
          message: `No ${type} document matched slug "${input.slug}".`,
        });
      }

      if (result.data.length > 1) {
        throw new MdcmsClientError({
          code: "AMBIGUOUS_RESULT",
          message: `Multiple ${type} documents matched slug "${input.slug}".`,
        });
      }

      return result.data[0]!;
    }

    return getDocumentById(type, input);
  }

  return {
    get: getDocument,
    async getPreviewDocumentFromRequest(request, input) {
      const preview = await verifyMdcmsPreviewRequest(request, input);

      if (!preview.ok) {
        throw new MdcmsClientError({
          code: "PREVIEW_TOKEN_INVALID",
          message: `Preview token verification failed: ${preview.reason}.`,
        });
      }

      return getDocumentById(preview.claims.type, {
        id: preview.claims.documentId,
        project: preview.claims.project,
        environment: preview.claims.environment,
        locale: preview.claims.locale,
        resolve: input.resolve,
        draft: true,
      });
    },
    async list(type, input = {}) {
      return listDocuments(type, input);
    },
  };
}
