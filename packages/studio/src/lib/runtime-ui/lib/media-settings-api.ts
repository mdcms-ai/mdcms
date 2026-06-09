import {
  assertMediaSettingsResponse,
  RuntimeError,
  type MediaSettings,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "../../request-auth.js";
import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export type StudioMediaSettingsApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioMediaSettingsApiOptions = {
  auth?: StudioRuntimeAuth;
  csrfToken?: string | null;
  fetcher?: typeof fetch;
};

export type StudioMediaSettingsApi = {
  getSettings: () => Promise<MediaSettings>;
  updateSettings: (input: MediaSettings) => Promise<MediaSettings>;
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
      : "MEDIA_SETTINGS_REQUEST_FAILED";
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
    code: "MEDIA_SETTINGS_RESPONSE_INVALID",
    message: "Media settings response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

function createScopedHeaders(
  config: StudioMediaSettingsApiConfig,
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
  options: StudioMediaSettingsApiOptions,
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

export function createStudioMediaSettingsApi(
  config: StudioMediaSettingsApiConfig,
  options: StudioMediaSettingsApiOptions = {},
): StudioMediaSettingsApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async getSettings() {
      const operation = "GET /api/v1/media/settings";
      const url = resolveStudioRelativeUrl(
        "/api/v1/media/settings",
        config.serverUrl,
      );
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
          "Media settings request failed.",
        );
      }

      try {
        assertMediaSettingsResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },

    async updateSettings(input) {
      const operation = "PUT /api/v1/media/settings";
      const csrfToken = requireMutationCsrfToken(options);
      const url = resolveStudioRelativeUrl(
        "/api/v1/media/settings",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "PUT",
          headers: createScopedHeaders(config, {
            "content-type": "application/json",
            "x-mdcms-csrf-token": csrfToken,
          }),
          body: JSON.stringify(input),
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          operation,
          response,
          payload,
          "Media settings update request failed.",
        );
      }

      try {
        assertMediaSettingsResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },
  };
}
