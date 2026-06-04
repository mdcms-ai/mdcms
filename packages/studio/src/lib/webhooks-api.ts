import {
  RuntimeError,
  assertWebhookConfigResponse,
  assertWebhookDeleteResponse,
  assertWebhookDeliveryHistoryResponse,
  assertWebhookListResponse,
  type ParsedWebhookDeliveryHistoryQuery,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookDeliveryHistoryEntry,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";

export type StudioWebhooksApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioWebhooksApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

export type StudioWebhooksApi = {
  listConfigs: () => Promise<WebhookConfig[]>;
  createConfig: (
    input: WebhookCreateInput,
    csrfToken: string | undefined,
  ) => Promise<WebhookConfig>;
  updateConfig: (
    id: string,
    input: WebhookUpdateInput,
    csrfToken: string | undefined,
  ) => Promise<WebhookConfig>;
  deleteConfig: (
    id: string,
    csrfToken: string | undefined,
  ) => Promise<{ deleted: true; id: string }>;
  listDeliveryHistory: (
    filter: Partial<ParsedWebhookDeliveryHistoryQuery>,
  ) => Promise<WebhookDeliveryHistoryEntry[]>;
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
      : "WEBHOOKS_REQUEST_FAILED";
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
    code: "WEBHOOKS_RESPONSE_INVALID",
    message: "Webhook response is invalid.",
    statusCode: 500,
    details: { operation, payload },
  });
}

function createScopedHeaders(
  config: StudioWebhooksApiConfig,
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

function createDeliveryHistorySearchParams(
  filter: Partial<ParsedWebhookDeliveryHistoryQuery>,
): string {
  const params = new URLSearchParams();

  if (filter.webhookId) {
    params.set("webhookId", filter.webhookId);
  }
  if (filter.event) {
    params.set("event", filter.event);
  }
  if (filter.outcome) {
    params.set("outcome", filter.outcome);
  }
  if (filter.limit !== undefined) {
    params.set("limit", String(filter.limit));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function createStudioWebhooksApi(
  config: StudioWebhooksApiConfig,
  options: StudioWebhooksApiOptions = {},
): StudioWebhooksApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async listConfigs() {
      const operation = "GET /api/v1/webhooks";
      const url = resolveStudioRelativeUrl(
        "/api/v1/webhooks",
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
          "Webhook configuration list request failed.",
        );
      }

      try {
        assertWebhookListResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },

    async createConfig(input, csrfToken) {
      const operation = "POST /api/v1/webhooks";
      const url = resolveStudioRelativeUrl(
        "/api/v1/webhooks",
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "POST",
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
          "Webhook configuration create request failed.",
        );
      }

      try {
        assertWebhookConfigResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },

    async updateConfig(id, input, csrfToken) {
      const operation = `PUT /api/v1/webhooks/${id}`;
      const url = resolveStudioRelativeUrl(
        `/api/v1/webhooks/${encodeURIComponent(id)}`,
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
          "Webhook configuration update request failed.",
        );
      }

      try {
        assertWebhookConfigResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },

    async deleteConfig(id, csrfToken) {
      const operation = `DELETE /api/v1/webhooks/${id}`;
      const url = resolveStudioRelativeUrl(
        `/api/v1/webhooks/${encodeURIComponent(id)}`,
        config.serverUrl,
      );
      const response = await fetcher(
        url,
        applyStudioAuthToRequestInit(options.auth, {
          method: "DELETE",
          headers: createScopedHeaders(config, {
            "x-mdcms-csrf-token": csrfToken,
          }),
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(
          operation,
          response,
          payload,
          "Webhook configuration delete request failed.",
        );
      }

      try {
        assertWebhookDeleteResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },

    async listDeliveryHistory(filter) {
      const query = createDeliveryHistorySearchParams(filter);
      const operation = "GET /api/v1/webhooks/deliveries";
      const url = resolveStudioRelativeUrl(
        `/api/v1/webhooks/deliveries${query}`,
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
          "Webhook delivery history request failed.",
        );
      }

      try {
        assertWebhookDeliveryHistoryResponse(payload);
      } catch {
        throw toInvalidResponseError(operation, payload);
      }

      return payload.data;
    },
  };
}
