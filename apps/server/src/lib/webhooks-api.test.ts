import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  WebhookConfig,
  WebhookDeliveryHistoryEntry,
  WebhookUpdateInput,
} from "@mdcms/shared";

import {
  createConfig,
  createStubStore,
  createTestRoutes,
  scopeHeaders,
  validSecret,
  type AuthorizationRequirement,
  type ParsedWebhookCreateInput,
} from "./webhooks/test-support.js";

test("webhook routes create scoped webhooks with write-only secrets", async () => {
  let authorization: AuthorizationRequirement | undefined;
  let capturedInput: ParsedWebhookCreateInput | undefined;
  let capturedActorId: string | undefined;

  const handler = createTestRoutes({
    store: createStubStore({
      async create(scope, input, context) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        capturedInput = input;
        capturedActorId = context.actorId;
        return createConfig({
          events: input.events,
          active: input.active,
          createdBy: context.actorId,
          updatedBy: context.actorId,
        });
      },
    }),
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return {
        mode: "session",
        principal: {
          type: "session",
          session: {
            id: "session-1",
            userId: "user-1",
            email: "editor@example.com",
            issuedAt: "2026-06-03T00:00:00.000Z",
            expiresAt: "2026-06-03T01:00:00.000Z",
          },
        },
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/hooks/mdcms",
        events: ["content.published"],
        secret: validSecret,
      }),
    }),
  );
  const body = (await response.json()) as {
    data: WebhookConfig & { secret?: string };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "webhooks:write",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(capturedInput, {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret: validSecret,
    active: true,
  });
  assert.equal(capturedActorId, "user-1");
  assert.equal(body.data.secret, undefined);
  assert.equal(body.data.active, true);
});

test("webhook routes list scoped webhooks with read authorization", async () => {
  let authorization: AuthorizationRequirement | undefined;
  const handler = createTestRoutes({
    store: createStubStore({
      async list(scope) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        return [createConfig()];
      },
    }),
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return {
        mode: "session",
        principal: {
          type: "session",
          session: {
            id: "session-1",
            userId: "user-1",
            email: "editor@example.com",
            issuedAt: "2026-06-03T00:00:00.000Z",
            expiresAt: "2026-06-03T01:00:00.000Z",
          },
        },
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      headers: scopeHeaders,
    }),
  );
  const body = (await response.json()) as { data: WebhookConfig[] };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "webhooks:read",
    project: "marketing-site",
    environment: "production",
  });
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.url, "https://example.com/hooks/mdcms");
});

test("webhook routes list delivery history with filters and read authorization", async () => {
  let authorization: AuthorizationRequirement | undefined;
  let capturedFilter:
    | {
        webhookId?: string;
        event?: string;
        outcome?: string;
        limit: number;
      }
    | undefined;
  const entry: WebhookDeliveryHistoryEntry = {
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e85990",
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    project: "marketing-site",
    environment: "production",
    event: "content.published",
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
    deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
    url: "https://example.com/hooks/mdcms",
    attempt: 2,
    maxAttempts: 3,
    outcome: "failed",
    statusCode: 503,
    error: "Webhook delivery failed with status 503.",
    createdAt: "2026-06-03T00:00:00.000Z",
  };
  const handler = createTestRoutes({
    store: createStubStore({
      async listDeliveryHistory(scope, filter) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        capturedFilter = filter;
        return [entry];
      },
    }),
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return {
        mode: "session",
        principal: {
          type: "session",
          session: {
            id: "session-1",
            userId: "user-1",
            email: "editor@example.com",
            issuedAt: "2026-06-03T00:00:00.000Z",
            expiresAt: "2026-06-03T01:00:00.000Z",
          },
        },
      };
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/webhooks/deliveries?webhookId=018f0c6d-98da-7f25-89fe-7c7ef5e8597d&event=content.published&outcome=failed&limit=25",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: WebhookDeliveryHistoryEntry[];
  };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "webhooks:read",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(capturedFilter, {
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    event: "content.published",
    outcome: "failed",
    limit: 25,
  });
  assert.equal(body.data[0]?.statusCode, 503);
});

test("webhook routes reject invalid delivery history filters before touching the store", async () => {
  let listCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async listDeliveryHistory() {
        listCalls += 1;
        return [];
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks/deliveries?outcome=pending", {
      headers: scopeHeaders,
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(listCalls, 0);
});

test("webhook routes partially update scoped webhooks", async () => {
  let capturedInput: WebhookUpdateInput | undefined;
  const handler = createTestRoutes({
    store: createStubStore({
      async update(scope, id, input, context) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        assert.equal(id, "018f0c6d-98da-7f25-89fe-7c7ef5e8597d");
        assert.equal(context.actorId, "user-1");
        capturedInput = input;
        return createConfig({
          id,
          events: input.events ?? ["content.published"],
          active: input.active ?? true,
          updatedBy: context.actorId,
        });
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/webhooks/018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
      {
        method: "PUT",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: ["content.updated"],
          active: false,
        }),
      },
    ),
  );
  const body = (await response.json()) as { data: WebhookConfig };

  assert.equal(response.status, 200);
  assert.deepEqual(capturedInput, {
    events: ["content.updated"],
    active: false,
  });
  assert.deepEqual(body.data.events, ["content.updated"]);
  assert.equal(body.data.active, false);
});

test("webhook routes delete scoped webhooks", async () => {
  const handler = createTestRoutes({
    store: createStubStore({
      async delete(scope, id) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        assert.equal(id, "018f0c6d-98da-7f25-89fe-7c7ef5e8597d");
        return { deleted: true, id };
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/webhooks/018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
      {
        method: "DELETE",
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: { deleted: true; id: string };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, {
    deleted: true,
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  });
});

test("webhook routes reject unsupported events before touching the store", async () => {
  let createCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async create() {
        createCalls += 1;
        return createConfig();
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.com/hooks/mdcms",
        events: ["content.archived"],
        secret: validSecret,
      }),
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "WEBHOOK_EVENT_UNSUPPORTED");
  assert.equal(createCalls, 0);
});

test("webhook routes reject non-HTTPS targets with an explicit code", async () => {
  let createCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async create() {
        createCalls += 1;
        return createConfig();
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "http://example.com/hooks/mdcms",
        events: ["content.published"],
        secret: validSecret,
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: { field?: string };
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "WEBHOOK_URL_NOT_HTTPS");
  assert.equal(body.details?.field, "url");
  assert.equal(createCalls, 0);
});

test("webhook routes reject private targets before touching the store", async () => {
  let createCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async create() {
        createCalls += 1;
        return createConfig();
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://127.0.0.1/hooks/mdcms",
        events: ["content.published"],
        secret: validSecret,
      }),
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "WEBHOOK_TARGET_FORBIDDEN");
  assert.equal(createCalls, 0);
});

test("webhook routes reject DNS targets resolving to private addresses before touching the store", async () => {
  let createCalls = 0;
  const resolvedHosts: string[] = [];
  const handler = createTestRoutes({
    resolveTargetAddresses: async (hostname) => {
      resolvedHosts.push(hostname);
      return ["10.0.0.8"];
    },
    store: createStubStore({
      async create() {
        createCalls += 1;
        return createConfig();
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://customer-webhook.example/hooks/mdcms",
        events: ["content.published"],
        secret: validSecret,
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: {
      field?: string;
      hostname?: string;
      address?: string;
      reason?: string;
    };
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "WEBHOOK_TARGET_FORBIDDEN");
  assert.deepEqual(resolvedHosts, ["customer-webhook.example"]);
  assert.equal(body.details?.field, "url");
  assert.equal(body.details?.hostname, "customer-webhook.example");
  assert.equal(body.details?.address, "10.0.0.8");
  assert.equal(body.details?.reason, "resolved_forbidden_address");
  assert.equal(createCalls, 0);
});

test("webhook routes reject private update targets before touching the store", async () => {
  let updateCalls = 0;
  const handler = createTestRoutes({
    resolveTargetAddresses: async () => ["172.16.0.12"],
    store: createStubStore({
      async update() {
        updateCalls += 1;
        return createConfig();
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/webhooks/018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
      {
        method: "PUT",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: "https://rebinding.example/hooks/mdcms",
        }),
      },
    ),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "WEBHOOK_TARGET_FORBIDDEN");
  assert.equal(updateCalls, 0);
});

test("webhook routes reject malformed webhook ids before touching the store", async () => {
  let updateCalls = 0;
  let deleteCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async update() {
        updateCalls += 1;
        return createConfig();
      },
      async delete() {
        deleteCalls += 1;
        return {
          deleted: true,
          id: "not-a-uuid",
        };
      },
    }),
  });

  const updateResponse = await handler(
    new Request("http://localhost/api/v1/webhooks/not-a-uuid", {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        active: false,
      }),
    }),
  );
  const updateBody = (await updateResponse.json()) as { code: string };
  const deleteResponse = await handler(
    new Request("http://localhost/api/v1/webhooks/not-a-uuid", {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const deleteBody = (await deleteResponse.json()) as { code: string };

  assert.equal(updateResponse.status, 400);
  assert.equal(updateBody.code, "INVALID_INPUT");
  assert.equal(deleteResponse.status, 400);
  assert.equal(deleteBody.code, "INVALID_INPUT");
  assert.equal(updateCalls, 0);
  assert.equal(deleteCalls, 0);
});

test("webhook routes require project and environment routing", async () => {
  const handler = createTestRoutes({
    store: createStubStore({
      async list() {
        throw new Error("not reached");
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/webhooks"),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "MISSING_TARGET_ROUTING");
});
