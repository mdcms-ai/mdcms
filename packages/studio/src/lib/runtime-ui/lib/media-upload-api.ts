import {
  assertMediaAssetResponse,
  RuntimeError,
  type MediaAsset,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "../../request-auth.js";
import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export type StudioMediaUploadApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioMediaUploadApiOptions = {
  auth?: StudioRuntimeAuth;
  csrfToken?: string | null;
  fetcher?: typeof fetch;
};

export type StudioMediaUploadProgress = {
  loaded: number;
  total: number;
};

export type StudioMediaUploadOptions = {
  /**
   * Receives byte-level upload progress when the request runs over
   * `XMLHttpRequest`. When the request falls back to `fetch` (an injected
   * `fetcher`, no `XMLHttpRequest`), it fires once at start (`0`) and once on a
   * successful response (`total`) so callers still see begin/end transitions.
   */
  onProgress?: (progress: StudioMediaUploadProgress) => void;
};

export type StudioMediaUploadApi = {
  upload: (
    file: File,
    options?: StudioMediaUploadOptions,
  ) => Promise<MediaAsset>;
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
      : "MEDIA_UPLOAD_REQUEST_FAILED";
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
    code: "MEDIA_UPLOAD_RESPONSE_INVALID",
    message: "Media upload response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

function createScopedHeaders(
  config: StudioMediaUploadApiConfig,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-mdcms-project": config.project,
    "x-mdcms-environment": config.environment,
  };

  for (const [name, value] of Object.entries(extra ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      headers[name] = value;
    }
  }

  return headers;
}

function createMissingCsrfError(): RuntimeError {
  return new RuntimeError({
    code: "CSRF_TOKEN_MISSING",
    message: "CSRF token is not available. You must be authenticated.",
    statusCode: 0,
  });
}

function requireMutationCsrfToken(
  options: StudioMediaUploadApiOptions,
): string | undefined {
  if (options.auth?.mode === "token") {
    return undefined;
  }

  const csrfToken = options.csrfToken?.trim();
  if (!csrfToken) {
    throw createMissingCsrfError();
  }

  return csrfToken;
}

function createNetworkError(operation: string): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_UPLOAD_REQUEST_FAILED",
    message: "Media upload request failed.",
    statusCode: 0,
    details: { operation },
  });
}

/**
 * Sends the multipart upload over `XMLHttpRequest` so that
 * `xhr.upload.onprogress` can report byte-level progress, then normalizes the
 * result into a `Response` so the success/error handling matches the fetch
 * path exactly. Auth is derived from {@link applyStudioAuthToRequestInit} and
 * translated to XHR (`withCredentials` for cookie auth, request headers for
 * token auth and routing). The browser sets the multipart `content-type`.
 */
function uploadWithXhr(input: {
  operation: string;
  url: URL;
  init: RequestInit;
  body: FormData;
  onProgress: (progress: StudioMediaUploadProgress) => void;
}): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", input.url.toString(), true);

    if (input.init.credentials === "include") {
      xhr.withCredentials = true;
    }

    const headers = input.init.headers;
    if (headers && !(headers instanceof Headers) && !Array.isArray(headers)) {
      for (const [name, value] of Object.entries(
        headers as Record<string, string>,
      )) {
        xhr.setRequestHeader(name, value);
      }
    }

    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          input.onProgress({ loaded: event.loaded, total: event.total });
        }
      };
    }

    xhr.onload = () => {
      // status 0 means the request never completed (network/CORS); a Response
      // cannot be constructed with status 0, so surface it as a network error.
      if (xhr.status === 0) {
        reject(createNetworkError(input.operation));
        return;
      }
      resolve(
        new Response(xhr.responseText || null, {
          status: xhr.status,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    xhr.onerror = () => reject(createNetworkError(input.operation));
    xhr.onabort = () => reject(createNetworkError(input.operation));
    xhr.ontimeout = () => reject(createNetworkError(input.operation));

    xhr.send(input.body);
  });
}

function canUseXhrProgress(
  options: StudioMediaUploadApiOptions,
  uploadOptions: StudioMediaUploadOptions | undefined,
): uploadOptions is Required<Pick<StudioMediaUploadOptions, "onProgress">> {
  return (
    typeof uploadOptions?.onProgress === "function" &&
    options.fetcher === undefined &&
    typeof XMLHttpRequest !== "undefined"
  );
}

export function createStudioMediaUploadApi(
  config: StudioMediaUploadApiConfig,
  options: StudioMediaUploadApiOptions = {},
): StudioMediaUploadApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async upload(file, uploadOptions) {
      const operation = "POST /api/v1/media/upload";
      const csrfToken = requireMutationCsrfToken(options);
      const url = resolveStudioRelativeUrl(
        "/api/v1/media/upload",
        config.serverUrl,
      );
      const body = new FormData();
      body.set("file", file);
      const init = applyStudioAuthToRequestInit(options.auth, {
        method: "POST",
        headers: createScopedHeaders(config, {
          "x-mdcms-csrf-token": csrfToken,
        }),
        body,
      });

      let response: Response;
      if (canUseXhrProgress(options, uploadOptions)) {
        try {
          response = await uploadWithXhr({
            operation,
            url,
            init,
            body,
            onProgress: uploadOptions.onProgress,
          });
        } catch {
          // The XHR transport (used for byte-level progress) failed at the
          // network layer. Retry once over fetch, which is the baseline upload
          // path, so progress reporting never costs us a working upload.
          uploadOptions.onProgress({ loaded: 0, total: file.size });
          response = await fetcher(url, init);
        }
      } else {
        uploadOptions?.onProgress?.({ loaded: 0, total: file.size });
        response = await fetcher(url, init);
      }
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          operation,
          response,
          payload,
          `Media upload failed (HTTP ${response.status}).`,
        );
      }

      try {
        assertMediaAssetResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      uploadOptions?.onProgress?.({ loaded: file.size, total: file.size });

      return payload.data;
    },
  };
}
