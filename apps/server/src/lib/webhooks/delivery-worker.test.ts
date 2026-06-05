import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createWebhookDeliveryWorker,
  deliverWebhookWithRetries,
  type WebhookStore,
} from "../webhooks-api.js";

import {
  createPayload,
  createStubStore,
  createTarget,
} from "./test-support.js";

const scope = {
  project: "marketing-site",
  environment: "production",
};

const queuedEvent = {
  scope,
  event: "content.published" as const,
  eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
  payload: createPayload(),
};

function deliveryInput() {
  return {
    scope,
    webhook: createTarget(),
    payload: createPayload(),
  };
}

function storeWithTargets(targets = [createTarget()]): WebhookStore {
  return createStubStore({
    async listActiveTargetsByEvent(receivedScope, event) {
      assert.deepEqual(receivedScope, scope);
      assert.equal(event, "content.published");
      return targets;
    },
  });
}

test("webhook delivery worker requires a store and explicit delivery sink", () => {
  assert.throws(
    () => createWebhookDeliveryWorker({} as never),
    /delivery sink/i,
  );
  assert.throws(
    () =>
      createWebhookDeliveryWorker({ deliver: async () => undefined } as never),
    /store/i,
  );
});

test("webhook delivery worker fans out queued events to active targets", async () => {
  const deliveries: string[] = [];
  const worker = createWebhookDeliveryWorker({
    store: storeWithTargets([
      createTarget({ url: "https://example.com/hooks/primary" }),
      createTarget({ url: "https://example.com/hooks/secondary" }),
    ]),
    resolveTargetAddresses: async () => ["93.184.216.34"],
    deliver: async (delivery) => {
      deliveries.push(delivery.webhook.url);
    },
  });

  worker.enqueue(queuedEvent);
  await worker.drain();

  assert.deepEqual(deliveries, [
    "https://example.com/hooks/primary",
    "https://example.com/hooks/secondary",
  ]);
});

test("webhook delivery worker reports queued event lookup failures", async () => {
  const errors: Array<{ event: string; message: string }> = [];
  const worker = createWebhookDeliveryWorker({
    store: createStubStore({
      async listActiveTargetsByEvent() {
        throw new Error("subscription lookup failed");
      },
    }),
    deliver: async () => undefined,
    onQueueError: ({ input, error }) => {
      errors.push({
        event: input.event,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  worker.enqueue(queuedEvent);
  await worker.drain();

  assert.deepEqual(errors, [
    {
      event: "content.published",
      message: "subscription lookup failed",
    },
  ]);
});

test("webhook delivery retry helper retries failed deliveries with exponential backoff", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 3,
      retryDelaysMs: [1000, 2000],
    },
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
    deliver: async (delivery) => {
      attempts.push(delivery.attempt);
      if (delivery.attempt < 3) {
        throw new Error(`transient failure ${delivery.attempt}`);
      }
    },
  });

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [1000, 2000]);
});

test("webhook delivery retry helper preserves event ids and creates a delivery id per attempt", async () => {
  const deliveries: Array<{ eventId: string; deliveryId: string }> = [];
  const deliveryIds = [
    "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
    "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
  ];

  await deliverWebhookWithRetries(
    {
      ...deliveryInput(),
      eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
    },
    {
      createDeliveryId: () => {
        const id = deliveryIds.shift();
        assert.ok(id);
        return id;
      },
      resolveTargetAddresses: async () => ["93.184.216.34"],
      retryPolicy: {
        maxAttempts: 2,
        retryDelaysMs: [0],
      },
      sleep: async () => undefined,
      deliver: async (delivery) => {
        deliveries.push({
          eventId: delivery.eventId,
          deliveryId: delivery.deliveryId,
        });
        if (delivery.attempt === 1) {
          throw new Error("transient failure");
        }
      },
    },
  );

  assert.deepEqual(deliveries, [
    {
      eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
      deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
    },
    {
      eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
      deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
    },
  ]);
});

test("webhook delivery retry helper records attempts with explicit delivery scope", async () => {
  const recordedScopes: (typeof scope)[] = [];

  await deliverWebhookWithRetries(
    {
      scope,
      webhook: createTarget({
        project: "target-project",
        environment: "target-environment",
      }),
      payload: {
        ...createPayload(),
        project: "payload-project",
        environment: "payload-environment",
      },
    },
    {
      resolveTargetAddresses: async () => ["93.184.216.34"],
      recordAttempt: (result) => {
        recordedScopes.push(result.delivery.scope);
      },
      deliver: async () => ({ statusCode: 202 }),
    },
  );

  assert.deepEqual(recordedScopes, [scope]);
});

test("webhook delivery retry helper awaits sleep delays before retrying", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 2,
      retryDelaysMs: [25],
    },
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
    deliver: async (delivery) => {
      attempts.push(delivery.attempt);
      if (delivery.attempt === 1) {
        throw new Error("transient failure");
      }
    },
  });

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(delays, [25]);
});

test("webhook delivery retry helper records exhausted delivery failures", async () => {
  const outcomes: string[] = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 2,
      retryDelaysMs: [0],
    },
    sleep: async () => undefined,
    recordAttempt: (result) => {
      outcomes.push(result.outcome);
    },
    deliver: async () => {
      throw new Error("downstream unavailable");
    },
  });

  assert.deepEqual(outcomes, ["retrying", "failed"]);
});

test("webhook delivery retry helper records observed HTTP status codes", async () => {
  const statusCodes: Array<number | null> = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 1,
      retryDelaysMs: [],
    },
    recordAttempt: (result) => {
      statusCodes.push(result.statusCode ?? null);
    },
    deliver: async () => {
      throw Object.assign(
        new Error("Webhook delivery failed with status 503."),
        {
          statusCode: 503,
        },
      );
    },
  });

  assert.deepEqual(statusCodes, [503]);
});

test("webhook delivery retry helper records successful HTTP status codes", async () => {
  const statusCodes: Array<number | null> = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    recordAttempt: (result) => {
      statusCodes.push(result.statusCode ?? null);
    },
    deliver: async () => ({ statusCode: 202 }),
  });

  assert.deepEqual(statusCodes, [202]);
});

test("webhook delivery retry helper does not resend when recording success fails", async () => {
  const attempts: number[] = [];
  const outcomes: string[] = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 2,
      retryDelaysMs: [0],
    },
    sleep: async () => undefined,
    deliver: async (delivery) => {
      attempts.push(delivery.attempt);
      return { statusCode: 202 };
    },
    recordAttempt: (result) => {
      outcomes.push(result.outcome);
      if (result.outcome === "succeeded") {
        throw new Error("delivery history unavailable");
      }
    },
  });

  assert.deepEqual(attempts, [1]);
  assert.deepEqual(outcomes, ["succeeded"]);
});

test("webhook delivery retry helper retries delivery failures when recording retry state fails", async () => {
  const attempts: number[] = [];
  const outcomes: string[] = [];

  await deliverWebhookWithRetries(deliveryInput(), {
    resolveTargetAddresses: async () => ["93.184.216.34"],
    retryPolicy: {
      maxAttempts: 2,
      retryDelaysMs: [0],
    },
    sleep: async () => undefined,
    deliver: async (delivery) => {
      attempts.push(delivery.attempt);
      if (delivery.attempt === 1) {
        throw new Error("transient failure");
      }
    },
    recordAttempt: (result) => {
      outcomes.push(result.outcome);
      if (result.outcome === "retrying") {
        throw new Error("delivery history unavailable");
      }
    },
  });

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(outcomes, ["retrying", "succeeded"]);
});

test("webhook delivery retry helper does not retry forbidden targets", async () => {
  let attempts = 0;
  let sleeps = 0;

  await deliverWebhookWithRetries(
    {
      ...deliveryInput(),
      webhook: createTarget({
        url: "https://private-webhook.example/hooks/mdcms",
      }),
    },
    {
      resolveTargetAddresses: async () => ["127.0.0.1"],
      sleep: async () => {
        sleeps += 1;
      },
      deliver: async () => {
        attempts += 1;
      },
    },
  );

  assert.equal(attempts, 0);
  assert.equal(sleeps, 0);
});

test("webhook delivery retry helper rejects stored non-HTTPS targets without retrying", async () => {
  let attempts = 0;
  let sleeps = 0;

  await deliverWebhookWithRetries(
    {
      ...deliveryInput(),
      webhook: createTarget({
        url: "http://example.com/hooks/mdcms",
      }),
    },
    {
      sleep: async () => {
        sleeps += 1;
      },
      deliver: async () => {
        attempts += 1;
      },
    },
  );

  assert.equal(attempts, 0);
  assert.equal(sleeps, 0);
});
