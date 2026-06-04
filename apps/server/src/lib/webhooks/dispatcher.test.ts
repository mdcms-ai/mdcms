import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createWebhookEventDispatcher,
  type WebhookDelivery,
} from "../webhooks-api.js";

import {
  createDocument,
  createPayload,
  createStubStore,
  createTarget,
} from "./test-support.js";

const scope = {
  project: "marketing-site",
  environment: "production",
};

const actor = {
  id: "user-1",
  email: "editor@example.com",
};

test("webhook dispatcher queues delivery work without awaiting the sink", async () => {
  const store = createStubStore({
    async listActiveTargetsByEvent() {
      return [createTarget()];
    },
  });
  let finishDelivery!: () => void;
  let markDeliveryStarted!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => {
    markDeliveryStarted = resolve;
  });
  const dispatcher = createWebhookEventDispatcher({
    store,
    resolveTargetAddresses: async () => ["93.184.216.34"],
    deliver: async () => {
      markDeliveryStarted();
      await new Promise<void>((resolve) => {
        finishDelivery = resolve;
      });
    },
  });

  const emitPromise = dispatcher.emitContentEvent({
    event: "content.published",
    scope,
    document: createDocument(),
    actor,
  });
  const result = await Promise.race([
    emitPromise.then(() => "resolved"),
    new Promise<"blocked">((resolve) =>
      setTimeout(() => resolve("blocked"), 0),
    ),
  ]);

  assert.equal(result, "resolved");

  await deliveryStarted;
  finishDelivery();
  await dispatcher.drainDeliveries();
});

test("webhook dispatcher returns before subscription lookup finishes", async () => {
  let finishLookup!: () => void;
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const lookupFinished = new Promise<void>((resolve) => {
    finishLookup = resolve;
  });
  const store = createStubStore({
    async listActiveTargetsByEvent() {
      markLookupStarted();
      await lookupFinished;
      return [];
    },
  });
  const dispatcher = createWebhookEventDispatcher({
    store,
    resolveTargetAddresses: async () => ["93.184.216.34"],
    deliver: async () => undefined,
  });

  const emitPromise = dispatcher.emitContentEvent({
    event: "content.published",
    scope,
    document: createDocument(),
    actor,
  });

  await lookupStarted;
  const result = await Promise.race([
    emitPromise.then(() => "resolved"),
    new Promise<"blocked">((resolve) =>
      setTimeout(() => resolve("blocked"), 0),
    ),
  ]);
  finishLookup();
  await dispatcher.drainDeliveries();

  assert.equal(result, "resolved");
});

test("webhook dispatcher delivers canonical content payloads to active matching subscriptions", async () => {
  const delivered: WebhookDelivery[] = [];
  const store = createStubStore({
    async listActiveTargetsByEvent(receivedScope, event) {
      assert.deepEqual(receivedScope, scope);
      assert.equal(event, "content.published");

      return [
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
          url: "https://example.com/hooks/primary",
          events: ["content.published"],
        }),
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          url: "https://example.com/hooks/all-content",
          events: ["content.created", "content.published"],
        }),
      ];
    },
  });
  const dispatcher = createWebhookEventDispatcher({
    store,
    now: () => new Date("2026-06-03T12:34:56.000Z"),
    resolveTargetAddresses: async () => ["93.184.216.34"],
    deliver: async (delivery) => {
      delivered.push(delivery);
    },
  });

  await dispatcher.emitContentEvent({
    event: "content.published",
    scope,
    document: createDocument(),
    actor,
  });
  await dispatcher.drainDeliveries();

  assert.deepEqual(
    delivered.map((entry) => entry.webhook.url),
    [
      "https://example.com/hooks/primary",
      "https://example.com/hooks/all-content",
    ],
  );
  assert.equal(
    delivered[0]?.webhook.secret,
    "0123456789abcdef0123456789abcdef",
  );
  assert.deepEqual(delivered[0]?.payload, createPayload());
});

test("webhook dispatcher uses one event id for all deliveries from one emitted event", async () => {
  const delivered: WebhookDelivery[] = [];
  const deliveryIds = [
    "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
    "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
  ];
  const store = createStubStore({
    async listActiveTargetsByEvent() {
      return [
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
          url: "https://example.com/hooks/primary",
        }),
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          url: "https://example.com/hooks/secondary",
        }),
      ];
    },
  });
  const dispatcher = createWebhookEventDispatcher({
    store,
    createEventId: () => "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
    createDeliveryId: () => {
      const id = deliveryIds.shift();
      assert.ok(id);
      return id;
    },
    resolveTargetAddresses: async () => ["93.184.216.34"],
    deliver: async (delivery) => {
      delivered.push(delivery);
    },
  });

  await dispatcher.emitContentEvent({
    event: "content.published",
    scope,
    document: createDocument(),
    actor,
  });
  await dispatcher.drainDeliveries();

  assert.deepEqual(
    delivered.map((delivery) => ({
      eventId: delivery.eventId,
      deliveryId: delivery.deliveryId,
    })),
    [
      {
        eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
        deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
      },
      {
        eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
        deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
      },
    ],
  );
});

test("webhook dispatcher validates stored targets before delivery fan-out", async () => {
  const delivered: WebhookDelivery[] = [];
  const store = createStubStore({
    async listActiveTargetsByEvent() {
      return [
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
          url: "https://private-webhook.example/hooks/mdcms",
        }),
        createTarget({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          url: "https://public-webhook.example/hooks/mdcms",
        }),
      ];
    },
  });
  const dispatcher = createWebhookEventDispatcher({
    store,
    resolveTargetAddresses: async (hostname) =>
      hostname === "private-webhook.example"
        ? ["127.0.0.1"]
        : ["93.184.216.34"],
    deliver: async (delivery) => {
      delivered.push(delivery);
    },
  });

  await dispatcher.emitContentEvent({
    event: "content.published",
    scope,
    document: createDocument(),
    actor,
  });
  await dispatcher.drainDeliveries();

  assert.deepEqual(
    delivered.map((entry) => entry.webhook.url),
    ["https://public-webhook.example/hooks/mdcms"],
  );
});
