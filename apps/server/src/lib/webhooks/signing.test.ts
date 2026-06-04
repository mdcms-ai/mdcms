import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createInMemoryWebhookReplayStore,
  createWebhookSignatureHeader,
  verifyWebhookSignature,
} from "../webhooks-api.js";

test("webhook signing creates the canonical HMAC header", () => {
  const header = createWebhookSignatureHeader({
    secret: "0123456789abcdef0123456789abcdef",
    timestamp: 1_770_000_000,
    body: '{"event":"content.published"}',
  });

  assert.equal(
    header,
    "t=1770000000,v1=37e8d9e9ddb9357818693bfebb9b8599175b50b9bd05c0848796c69e396230e0",
  );
});

test("webhook signature verification accepts a fresh signature once", async () => {
  const replayStore = createInMemoryWebhookReplayStore();
  const body = '{"event":"content.published"}';
  const signature = createWebhookSignatureHeader({
    secret: "0123456789abcdef0123456789abcdef",
    timestamp: 1_770_000_000,
    body,
  });

  const result = await verifyWebhookSignature({
    secret: "0123456789abcdef0123456789abcdef",
    body,
    signature,
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    now: () => new Date("2026-02-02T02:40:30.000Z"),
    replayStore,
  });

  assert.deepEqual(result, { ok: true });
});

test("webhook signature verification rejects stale timestamps and replayed event ids", async () => {
  const replayStore = createInMemoryWebhookReplayStore();
  const body = '{"event":"content.published"}';
  const signature = createWebhookSignatureHeader({
    secret: "0123456789abcdef0123456789abcdef",
    timestamp: 1_770_000_000,
    body,
  });
  const freshInput = {
    secret: "0123456789abcdef0123456789abcdef",
    body,
    signature,
    eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    now: () => new Date("2026-02-02T02:40:30.000Z"),
    replayStore,
  };

  assert.deepEqual(await verifyWebhookSignature(freshInput), { ok: true });
  assert.deepEqual(await verifyWebhookSignature(freshInput), {
    ok: false,
    reason: "event_replayed",
  });

  const staleSignature = createWebhookSignatureHeader({
    secret: "0123456789abcdef0123456789abcdef",
    timestamp: 1_770_000_000,
    body,
  });

  assert.deepEqual(
    await verifyWebhookSignature({
      secret: "0123456789abcdef0123456789abcdef",
      body,
      signature: staleSignature,
      eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
      now: () => new Date("2026-02-02T02:46:00.000Z"),
      replayStore,
    }),
    {
      ok: false,
      reason: "timestamp_out_of_tolerance",
    },
  );
});
