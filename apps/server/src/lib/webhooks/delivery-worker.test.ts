import assert from "node:assert/strict";
import { test } from "bun:test";

import { createWebhookDeliveryWorker } from "../webhooks-api.js";

import { createPayload, createTarget } from "./test-support.js";

test("webhook delivery worker requires an explicit delivery sink", () => {
  assert.throws(
    () => createWebhookDeliveryWorker({} as never),
    /delivery sink/i,
  );
});

test("webhook delivery worker retries failed deliveries with exponential backoff", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [1000, 2000]);
});

test("webhook delivery worker preserves event ids and creates a delivery id per attempt", async () => {
  const deliveries: Array<{ eventId: string; deliveryId: string }> = [];
  const deliveryIds = [
    "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
    "018f0c6d-98da-7f25-89fe-7c7ef5e85982",
  ];
  const worker = createWebhookDeliveryWorker({
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
  });

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
  });
  await worker.drain();

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

test("webhook delivery worker uses sleep delays that drain waits for", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(delays, [25]);
});

test("webhook delivery worker records exhausted delivery failures", async () => {
  const outcomes: string[] = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(outcomes, ["retrying", "failed"]);
});

test("webhook delivery worker records observed HTTP status codes", async () => {
  const statusCodes: Array<number | null> = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(statusCodes, [503]);
});

test("webhook delivery worker records successful HTTP status codes", async () => {
  const statusCodes: Array<number | null> = [];
  const worker = createWebhookDeliveryWorker({
    resolveTargetAddresses: async () => ["93.184.216.34"],
    recordAttempt: (result) => {
      statusCodes.push(result.statusCode ?? null);
    },
    deliver: async () => ({ statusCode: 202 }),
  });

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(statusCodes, [202]);
});

test("webhook delivery worker does not resend when recording success fails", async () => {
  const attempts: number[] = [];
  const outcomes: string[] = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(attempts, [1]);
  assert.deepEqual(outcomes, ["succeeded"]);
});

test("webhook delivery worker retries delivery failures when recording retry state fails", async () => {
  const attempts: number[] = [];
  const outcomes: string[] = [];
  const worker = createWebhookDeliveryWorker({
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

  worker.enqueue({
    webhook: createTarget(),
    payload: createPayload(),
  });
  await worker.drain();

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(outcomes, ["retrying", "succeeded"]);
});

test("webhook delivery worker does not retry forbidden targets", async () => {
  let attempts = 0;
  let sleeps = 0;
  const worker = createWebhookDeliveryWorker({
    resolveTargetAddresses: async () => ["127.0.0.1"],
    sleep: async () => {
      sleeps += 1;
    },
    deliver: async () => {
      attempts += 1;
    },
  });

  worker.enqueue({
    webhook: createTarget({
      url: "https://private-webhook.example/hooks/mdcms",
    }),
    payload: createPayload(),
  });
  await worker.drain();

  assert.equal(attempts, 0);
  assert.equal(sleeps, 0);
});

test("webhook delivery worker rejects stored non-HTTPS targets without retrying", async () => {
  let attempts = 0;
  let sleeps = 0;
  const worker = createWebhookDeliveryWorker({
    sleep: async () => {
      sleeps += 1;
    },
    deliver: async () => {
      attempts += 1;
    },
  });

  worker.enqueue({
    webhook: createTarget({
      url: "http://example.com/hooks/mdcms",
    }),
    payload: createPayload(),
  });
  await worker.drain();

  assert.equal(attempts, 0);
  assert.equal(sleeps, 0);
});
