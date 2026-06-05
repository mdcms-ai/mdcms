import assert from "node:assert/strict";

import {
  RuntimeError,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookDeliveryHistoryEntry,
} from "@mdcms/shared";
import { test } from "bun:test";

import {
  createStudioWebhooksApi,
  type StudioWebhooksApiOptions,
} from "./webhooks-api.js";

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | null {
  const headers = init?.headers;

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (headers && !Array.isArray(headers)) {
    const value = (headers as Record<string, string>)[name];
    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function createApi(options: StudioWebhooksApiOptions = {}) {
  return createStudioWebhooksApi(
    {
      project: "marketing-site",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

const historyEntry: WebhookDeliveryHistoryEntry = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e85990",
  webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "marketing-site",
  environment: "production",
  event: "content.published",
  eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
  deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
  url: "https://example.com/hooks/mdcms",
  attempt: 1,
  maxAttempts: 3,
  outcome: "failed",
  statusCode: 503,
  error: "Webhook delivery failed with status 503.",
  createdAt: "2026-06-03T00:00:00.000Z",
};

const webhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "marketing-site",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
};

test("listDeliveryHistory fetches routed webhook delivery history with filters", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [historyEntry] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.listDeliveryHistory({
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    event: "content.published",
    outcome: "failed",
    limit: 25,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks/deliveries?webhookId=018f0c6d-98da-7f25-89fe-7c7ef5e8597d&event=content.published&outcome=failed&limit=25",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.statusCode, 503);
});

test("listDeliveryHistory attaches bearer token in token auth mode", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.listDeliveryHistory({ limit: 10 });

  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks/deliveries?limit=10",
  );
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.deepEqual(result, []);
});

test("listDeliveryHistory surfaces route errors and rejects invalid responses", async () => {
  const failingApi = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "Nope." }), {
        status: 403,
      }),
  });

  await assert.rejects(
    () => failingApi.listDeliveryHistory({}),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN" &&
      error.statusCode === 403,
  );

  const invalidApi = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => invalidApi.listDeliveryHistory({}),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );
});

test("listConfigs fetches routed webhook configurations", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [webhookConfig] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.listConfigs();

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(result[0]?.id, webhookConfig.id);
});

test("createConfig posts scoped webhook input with csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: webhookConfig }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const input: WebhookCreateInput = {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret: "a".repeat(32),
    active: true,
  };

  const result = await api.createConfig(input);

  assert.equal(result.id, webhookConfig.id);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks",
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(readHeader(calls[0]?.init, "content-type"), "application/json");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
});

test("updateConfig and deleteConfig route ids safely", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      const data =
        init?.method === "DELETE"
          ? { deleted: true, id: "webhook/with spaces" }
          : webhookConfig;
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await api.updateConfig("webhook/with spaces", {
    active: false,
    secret: "b".repeat(32),
  });
  const deleted = await api.deleteConfig("webhook/with spaces");

  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks/webhook%2Fwith%20spaces",
  );
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    active: false,
    secret: "b".repeat(32),
  });
  assert.equal(
    String(calls[1]?.input),
    "http://localhost:4000/api/v1/webhooks/webhook%2Fwith%20spaces",
  );
  assert.equal(calls[1]?.init?.method, "DELETE");
  assert.equal(readHeader(calls[1]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[1]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[1]?.init, "x-mdcms-environment"), "production");
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.id, "webhook/with spaces");
});

test("token-authenticated config mutations do not attach csrf or credentials", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: webhookConfig }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await api.createConfig({
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret: "a".repeat(32),
    active: true,
  });

  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), null);
});

test("cookie-authenticated config mutations require csrf at the API boundary", async () => {
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async () => {
      throw new Error("request should not be sent without csrf");
    },
  });

  await assert.rejects(
    () =>
      api.createConfig({
        url: "https://example.com/hooks/mdcms",
        events: ["content.published"],
        secret: "a".repeat(32),
        active: true,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "CSRF_TOKEN_MISSING" &&
      error.message ===
        "CSRF token is not available. You must be authenticated.",
  );
});

test("config requests surface route errors and reject invalid responses", async () => {
  const failingApi = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "Nope." }), {
        status: 403,
      }),
  });

  await assert.rejects(
    () => failingApi.listConfigs(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN" &&
      error.statusCode === 403,
  );

  const invalidApi = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => invalidApi.listConfigs(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );

  const invalidCreateApi = createApi({
    csrfToken: "csrf-token",
    fetcher: async () =>
      new Response(JSON.stringify({ data: { ...webhookConfig, secret: "x" } })),
  });

  await assert.rejects(
    () =>
      invalidCreateApi.createConfig({
        url: "https://example.com/hooks/mdcms",
        events: ["content.published"],
        secret: "a".repeat(32),
        active: true,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );

  const invalidUpdateApi = createApi({
    csrfToken: "csrf-token",
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () =>
      invalidUpdateApi.updateConfig("018f0c6d-98da-7f25-89fe-7c7ef5e8597d", {
        active: false,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );

  const invalidDeleteApi = createApi({
    csrfToken: "csrf-token",
    fetcher: async () =>
      new Response(
        JSON.stringify({
          data: { deleted: false, id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d" },
        }),
      ),
  });

  await assert.rejects(
    () => invalidDeleteApi.deleteConfig("018f0c6d-98da-7f25-89fe-7c7ef5e8597d"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );
});
