import assert from "node:assert/strict";
import { test } from "bun:test";

import { createWebhookHttpDeliverySink } from "../webhooks-api.js";

import { createPayload, createTarget } from "./test-support.js";

test("webhook HTTP delivery sink posts JSON payloads and rejects non-2xx responses", async () => {
  const requests: Request[] = [];
  const sink = createWebhookHttpDeliverySink({
    now: () => new Date("2026-02-02T02:40:00.000Z"),
    resolveTargetAddresses: async () => ["93.184.216.34"],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(null, { status: 202 });
    },
  });

  await sink({
    webhook: createTarget({
      url: "https://example.com/hooks/mdcms",
    }),
    payload: createPayload(),
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
    deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
    attempt: 1,
    maxAttempts: 3,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(
    requests[0]?.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(
    requests[0]?.headers.get("x-mdcms-signature"),
    "t=1770000000,v1=5f3e22aa49977362d9d2eb905af572002961eca1a4dcf308d0fe666222ef61cd",
  );
  assert.equal(
    requests[0]?.headers.get("x-mdcms-delivery-id"),
    "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
  );
  assert.equal(
    requests[0]?.headers.get("x-mdcms-event-id"),
    "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
  );
  assert.deepEqual(await requests[0]?.json(), createPayload());

  const failingSink = createWebhookHttpDeliverySink({
    resolveTargetAddresses: async () => ["93.184.216.34"],
    fetch: async () => new Response("unavailable", { status: 503 }),
  });

  await assert.rejects(
    () =>
      Promise.resolve(
        failingSink({
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

test("webhook HTTP delivery sink disables automatic redirects", async () => {
  const sink = createWebhookHttpDeliverySink({
    resolveTargetAddresses: async () => ["93.184.216.34"],
    fetch: async (_input, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://127.0.0.1/hooks/mdcms",
        },
      });
    },
  });

  await assert.rejects(
    () =>
      Promise.resolve(
        sink({
          webhook: createTarget(),
          payload: createPayload(),
          eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
          attempt: 1,
          maxAttempts: 3,
        }),
      ),
    /Webhook delivery failed with status 302/,
  );
});

test("webhook HTTP delivery sink aborts stalled fetch requests after timeout", async () => {
  const sink = createWebhookHttpDeliverySink({
    timeoutMs: 5,
    resolveTargetAddresses: async () => ["93.184.216.34"],
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const failIfNotAborted = setTimeout(() => {
          reject(new Error("fetch was not aborted"));
        }, 30);

        init?.signal?.addEventListener("abort", () => {
          clearTimeout(failIfNotAborted);
          reject(new Error("fetch aborted"));
        });
      }),
  });

  await assert.rejects(
    () =>
      Promise.resolve(
        sink({
          webhook: createTarget(),
          payload: createPayload(),
          eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
          deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
          attempt: 1,
          maxAttempts: 3,
        }),
      ),
    /fetch aborted/,
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
    webhook: createTarget(),
    payload: createPayload(),
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
    deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
    attempt: 1,
    maxAttempts: 3,
  });
});
