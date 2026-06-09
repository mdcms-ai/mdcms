import {
  assertMediaAssetListResponse,
  RuntimeError,
  type MediaAssetCategory,
  type MediaAssetListResponse,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "../../request-auth.js";
import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export type StudioMediaLibraryApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioMediaLibraryApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioMediaLibrarySort = "uploadedAt" | "filename" | "sizeBytes";

export type StudioMediaLibraryOrder = "asc" | "desc";

export type StudioMediaLibraryListQuery = {
  q?: string;
  category?: MediaAssetCategory;
  uploadedBy?: string;
  uploadedFrom?: string;
  uploadedTo?: string;
  sort?: StudioMediaLibrarySort;
  order?: StudioMediaLibraryOrder;
  limit?: number;
  offset?: number;
};

export type StudioMediaLibraryApi = {
  list: (
    query?: StudioMediaLibraryListQuery,
  ) => Promise<MediaAssetListResponse>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toRouteFailureError(
  operation: string,
  response: Response,
  payload: unknown,
  fallbackMessage: string,
): RuntimeError {
  const parsed = isRecord(payload) ? payload : {};
  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : "MEDIA_LIBRARY_REQUEST_FAILED";
  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : fallbackMessage;

  return new RuntimeError({
    code,
    message,
    statusCode: response.status,
    details: { operation, status: response.status, payload },
  });
}

function toInvalidResponseError(
  operation: string,
  payload: unknown,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_LIBRARY_RESPONSE_INVALID",
    message: "Media library response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

function createScopedHeaders(
  config: StudioMediaLibraryApiConfig,
): Record<string, string> {
  return {
    "x-mdcms-project": config.project,
    "x-mdcms-environment": config.environment,
  };
}

function appendQueryParam(
  url: URL,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    url.searchParams.set(name, trimmed);
    return;
  }

  url.searchParams.set(name, String(value));
}

function createMediaListUrl(
  config: StudioMediaLibraryApiConfig,
  query?: StudioMediaLibraryListQuery,
): URL {
  const url = resolveStudioRelativeUrl("/api/v1/media", config.serverUrl);

  appendQueryParam(url, "q", query?.q);
  appendQueryParam(url, "category", query?.category);
  appendQueryParam(url, "uploadedBy", query?.uploadedBy);
  appendQueryParam(url, "uploadedFrom", query?.uploadedFrom);
  appendQueryParam(url, "uploadedTo", query?.uploadedTo);
  appendQueryParam(url, "sort", query?.sort);
  appendQueryParam(url, "order", query?.order);
  appendQueryParam(url, "limit", query?.limit);
  appendQueryParam(url, "offset", query?.offset);

  return url;
}

export function createStudioMediaLibraryApi(
  config: StudioMediaLibraryApiConfig,
  options: StudioMediaLibraryApiOptions = {},
): StudioMediaLibraryApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async list(query) {
      const operation = "GET /api/v1/media";
      const url = createMediaListUrl(config, query);
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "GET",
          headers: createScopedHeaders(config),
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          operation,
          response,
          payload,
          "Media library request failed.",
        );
      }

      try {
        assertMediaAssetListResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload;
    },
  };
}
