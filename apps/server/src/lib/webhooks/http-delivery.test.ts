import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createWebhookHttpDeliverySink,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "../webhooks-api.js";

import { createPinnedWebhookTargetLookup } from "./http-delivery.js";
import { createPayload, createTarget } from "./test-support.js";

test("webhook HTTP delivery sink posts JSON payloads through the pinned transport", async () => {
  const deliveries: Array<{
    body: string;
    headers: Record<string, string>;
    target: {
      url: string;
      hostname: string;
      address: string;
      addressFamily: 4 | 6;
    };
    timeoutMs: number;
  }> = [];
  const sink = createWebhookHttpDeliverySink({
    now: () => new Date("2026-02-02T02:40:00.000Z"),
    resolveTargetAddresses: async () => ["93.184.216.34"],
    transport: async (input) => {
      deliveries.push(input);
      return { status: 202 };
    },
  });

  await sink({
    scope: {
      project: "marketing-site",
      environment: "production",
    },
    webhook: createTarget({
      url: "https://example.com/hooks/mdcms",
    }),
    payload: createPayload(),
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
    deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
    attempt: 1,
    maxAttempts: 3,
  });

  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0]?.target, {
    url: "https://example.com/hooks/mdcms",
    hostname: "example.com",
    address: "93.184.216.34",
    addressFamily: 4,
  });
  assert.equal(
    deliveries[0]?.headers["content-type"],
    "application/json; charset=utf-8",
  );
  assert.equal(
    deliveries[0]?.headers[WEBHOOK_SIGNATURE_HEADER],
    "t=1770000000,v1=5f3e22aa49977362d9d2eb905af572002961eca1a4dcf308d0fe666222ef61cd",
  );
  assert.equal(
    deliveries[0]?.headers[WEBHOOK_DELIVERY_ID_HEADER],
    "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
  );
  assert.equal(
    deliveries[0]?.headers[WEBHOOK_EVENT_ID_HEADER],
    "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
  );
  assert.deepEqual(JSON.parse(deliveries[0]?.body ?? "{}"), createPayload());
});

test("webhook HTTP delivery sink rejects non-2xx transport responses", async () => {
  const sink = createWebhookHttpDeliverySink({
    resolveTargetAddresses: async () => ["93.184.216.34"],
    transport: async () => ({ status: 503 }),
  });

  await assert.rejects(
    () =>
      Promise.resolve(
        sink({
          scope: {
            project: "marketing-site",
            environment: "production",
          },
          webhook: createTarget(),
          payload: createPayload(),
          eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
          attempt: 1,
          maxAttempts: 3,
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Webhook delivery failed with status 503." &&
      (error as { statusCode?: number }).statusCode === 503,
  );
});

test("webhook HTTP delivery sink passes timeout to pinned transport", async () => {
  const sink = createWebhookHttpDeliverySink({
    timeoutMs: 123,
    resolveTargetAddresses: async () => ["93.184.216.34"],
    transport: async (input) => {
      assert.equal(input.timeoutMs, 123);
      return { status: 202 };
    },
  });

  await sink({
    scope: {
      project: "marketing-site",
      environment: "production",
    },
    webhook: createTarget(),
    payload: createPayload(),
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
    deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
    attempt: 1,
    maxAttempts: 3,
  });
});

test("webhook pinned target lookup supports single and all-address callback shapes", async () => {
  const lookup = createPinnedWebhookTargetLookup({
    address: "93.184.216.34",
    addressFamily: 4,
  });

  const singleResult = await new Promise<{
    address: string | unknown[];
    family: number | undefined;
  }>((resolve, reject) => {
    lookup("example.com", {}, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ address, family });
    });
  });

  assert.deepEqual(singleResult, {
    address: "93.184.216.34",
    family: 4,
  });

  const allResult = await new Promise<{
    address: string | unknown[];
    family: number | undefined;
  }>((resolve, reject) => {
    lookup("example.com", { all: true }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ address, family });
    });
  });

  assert.deepEqual(allResult, {
    address: [{ address: "93.184.216.34", family: 4 }],
    family: undefined,
  });
});
