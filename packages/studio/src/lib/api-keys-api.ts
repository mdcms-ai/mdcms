import { RuntimeError } from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

const API_KEY_OPERATION_SCOPES = [
  "content:read",
  "content:read:draft",
  "content:write",
  "content:write:draft",
  "content:publish",
  "content:delete",
  "schema:read",
  "schema:write",
  "media:upload",
  "media:delete",
  "webhooks:read",
  "webhooks:write",
  "environments:clone",
  "environments:promote",
  "migrations:run",
  "projects:read",
  "projects:write",
] as const;

export type ApiKeyOperationScope = (typeof API_KEY_OPERATION_SCOPES)[number];

export type ApiKeyScopeTuple = {
  project: string;
  environment: string;
};

export type ApiKeyMetadata = {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: ApiKeyOperationScope[];
  contextAllowlist: ApiKeyScopeTuple[];
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type ApiKeyCreateInput = {
  label: string;
  scopes: ApiKeyOperationScope[];
  contextAllowlist: ApiKeyScopeTuple[];
  expiresAt?: string;
};

export type ApiKeyCreateResult = {
  key: string;
} & ApiKeyMetadata;

export type StudioApiKeysApiConfig = {
  serverUrl: string;
};

export type StudioApiKeysApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioApiKeysApi = {
  list: () => Promise<ApiKeyMetadata[]>;
  create: (
    input: ApiKeyCreateInput,
    csrfToken: string,
  ) => Promise<ApiKeyCreateResult>;
  revoke: (keyId: string, csrfToken: string) => Promise<ApiKeyMetadata>;
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
      : "API_KEYS_REQUEST_FAILED";
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
    code: "API_KEYS_RESPONSE_INVALID",
    message: "API keys response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

export function createStudioApiKeysApi(
  config: StudioApiKeysApiConfig,
  options: StudioApiKeysApiOptions = {},
): StudioApiKeysApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async list() {
      const url = resolveStudioRelativeUrl(
        "/api/v1/auth/api-keys",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, { method: "GET" }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          "GET /api/v1/auth/api-keys",
          response,
          payload,
          "API keys list request failed.",
        );
      }

      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw toInvalidResponseError("GET /api/v1/auth/api-keys", payload);
      }

      return payload.data as ApiKeyMetadata[];
    },

    async create(
      input: ApiKeyCreateInput,
      csrfToken: string,
    ): Promise<ApiKeyCreateResult> {
      const url = resolveStudioRelativeUrl(
        "/api/v1/auth/api-keys",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mdcms-csrf-token": csrfToken,
          },
          body: JSON.stringify(input),
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          "POST /api/v1/auth/api-keys",
          response,
          payload,
          "API key create request failed.",
        );
      }

      if (
        !isRecord(payload) ||
        !isRecord(payload.data) ||
        typeof (payload.data as Record<string, unknown>).key !== "string"
      ) {
        throw toInvalidResponseError("POST /api/v1/auth/api-keys", payload);
      }

      return payload.data as ApiKeyCreateResult;
    },

    async revoke(keyId: string, csrfToken: string): Promise<ApiKeyMetadata> {
      const url = resolveStudioRelativeUrl(
        `/api/v1/auth/api-keys/${encodeURIComponent(keyId)}/revoke`,
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "POST",
          headers: {
            "x-mdcms-csrf-token": csrfToken,
          },
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          `POST /api/v1/auth/api-keys/${keyId}/revoke`,
          response,
          payload,
          "API key revoke request failed.",
        );
      }

      if (!isRecord(payload) || !isRecord(payload.data)) {
        throw toInvalidResponseError(
          `POST /api/v1/auth/api-keys/${keyId}/revoke`,
          payload,
        );
      }

      return payload.data as ApiKeyMetadata;
    },
  };
}
