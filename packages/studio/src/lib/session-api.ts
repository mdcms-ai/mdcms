import { RuntimeError } from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

export type StudioSessionInfo = {
  id: string;
  userId: string;
  email: string;
  issuedAt: string;
  expiresAt: string;
};

export type StudioSessionResponse = {
  session: StudioSessionInfo;
  csrfToken: string;
};

export type StudioSessionApiConfig = {
  serverUrl: string;
};

export type StudioSessionApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioSessionApi = {
  get: () => Promise<StudioSessionResponse>;
  signOut: (csrfToken: string) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
      : "SESSION_REQUEST_FAILED";
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
    code: "SESSION_RESPONSE_INVALID",
    message: "Session response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

function validateSessionResponse(
  operation: string,
  payload: unknown,
): StudioSessionResponse {
  if (!isRecord(payload)) {
    throw toInvalidResponseError(operation, payload);
  }

  const data = payload.data;
  if (!isRecord(data)) {
    throw toInvalidResponseError(operation, payload);
  }

  const csrfToken = data.csrfToken;
  if (!isNonEmptyString(csrfToken)) {
    throw toInvalidResponseError(operation, payload);
  }

  const session = data.session;
  if (!isRecord(session)) {
    throw toInvalidResponseError(operation, payload);
  }

  if (
    !isNonEmptyString(session.id) ||
    !isNonEmptyString(session.userId) ||
    !isNonEmptyString(session.email) ||
    !isNonEmptyString(session.issuedAt) ||
    !isNonEmptyString(session.expiresAt)
  ) {
    throw toInvalidResponseError(operation, payload);
  }

  return {
    csrfToken,
    session: {
      id: session.id,
      userId: session.userId,
      email: session.email,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    },
  };
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createStudioSessionApi(
  config: StudioSessionApiConfig,
  options: StudioSessionApiOptions = {},
): StudioSessionApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async get() {
      const url = resolveStudioRelativeUrl(
        "/api/v1/auth/session",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, { method: "GET" }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          "GET /api/v1/auth/session",
          response,
          payload,
          "Session request failed.",
        );
      }

      return validateSessionResponse("GET /api/v1/auth/session", payload);
    },

    async signOut(csrfToken: string) {
      const url = resolveStudioRelativeUrl(
        "/api/v1/auth/logout",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "POST",
          headers: { "x-mdcms-csrf-token": csrfToken },
        }),
      );

      if (!response.ok) {
        const payload = await readResponsePayload(response);
        throw toRouteFailureError(
          "POST /api/v1/auth/logout",
          response,
          payload,
          "Sign-out request failed.",
        );
      }
    },
  };
}
