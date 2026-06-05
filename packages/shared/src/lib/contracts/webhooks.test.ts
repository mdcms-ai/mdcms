import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_REPLAY_RETENTION_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS,
  assertWebhookConfig,
  assertWebhookConfigResponse,
  assertWebhookDeleteResponse,
  assertWebhookDeliveryHistoryResponse,
  assertWebhookListResponse,
  parseWebhookDeliveryHistoryQuery,
  parseWebhookCreateInput,
  parseWebhookUpdateInput,
} from "./webhooks.js";

const validSecret = "0123456789abcdef0123456789abcdef";

test("webhook signing contract constants expose the public delivery headers", () => {
  assert.equal(WEBHOOK_SIGNATURE_HEADER, "X-MDCMS-Signature");
  assert.equal(WEBHOOK_DELIVERY_ID_HEADER, "X-MDCMS-Delivery-Id");
  assert.equal(WEBHOOK_EVENT_ID_HEADER, "X-MDCMS-Event-Id");
  assert.equal(WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS, 300);
  assert.equal(WEBHOOK_REPLAY_RETENTION_SECONDS, 300);
});

test("parseWebhookCreateInput accepts valid input and defaults active", () => {
  const parsed = parseWebhookCreateInput({
    url: " https://example.com/hooks/mdcms ",
    events: ["content.published", "content.updated"],
    secret: validSecret,
  });

  assert.deepEqual(parsed, {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published", "content.updated"],
    secret: validSecret,
    active: true,
  });
});

test("parseWebhookUpdateInput accepts partial rotations", () => {
  const parsed = parseWebhookUpdateInput({
    secret: `${validSecret}-rotated`,
  });

  assert.deepEqual(parsed, {
    secret: `${validSecret}-rotated`,
  });
});

test("parseWebhookUpdateInput rejects empty partial updates", () => {
  assert.throws(
    () => parseWebhookUpdateInput({}),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );
});

test("parseWebhookCreateInput rejects unsupported events with a deterministic code", () => {
  assert.throws(
    () =>
      parseWebhookCreateInput({
        url: "https://example.com/hooks/mdcms",
        events: ["content.archived"],
        secret: validSecret,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOK_EVENT_UNSUPPORTED" &&
      error.statusCode === 400,
  );
});

test("parseWebhookCreateInput rejects duplicate events as invalid input", () => {
  assert.throws(
    () =>
      parseWebhookCreateInput({
        url: "https://example.com/hooks/mdcms",
        events: ["content.published", "content.published"],
        secret: validSecret,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );
});

test("parseWebhookCreateInput rejects non-HTTPS URLs with a deterministic code", () => {
  assert.throws(
    () =>
      parseWebhookCreateInput({
        url: "http://example.com/hooks/mdcms",
        events: ["content.published"],
        secret: validSecret,
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOK_URL_NOT_HTTPS" &&
      error.statusCode === 400,
  );
});

test("webhook response assertions accept redacted configs", () => {
  const config = {
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    project: "marketing-site",
    environment: "production",
    url: "https://example.com/hooks/mdcms",
    events: [...WEBHOOK_EVENTS],
    active: true,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };

  assert.doesNotThrow(() => assertWebhookConfig(config));
  assert.doesNotThrow(() => assertWebhookListResponse({ data: [config] }));
  assert.doesNotThrow(() => assertWebhookConfigResponse({ data: config }));
  assert.doesNotThrow(() =>
    assertWebhookDeleteResponse({ data: { deleted: true, id: config.id } }),
  );
});

test("parseWebhookDeliveryHistoryQuery normalizes optional filters", () => {
  const parsed = parseWebhookDeliveryHistoryQuery({
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    event: "content.published",
    outcome: "failed",
    limit: "25",
  });

  assert.deepEqual(parsed, {
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    event: "content.published",
    outcome: "failed",
    limit: 25,
  });
});

test("parseWebhookDeliveryHistoryQuery defaults limit and rejects invalid filters", () => {
  assert.deepEqual(parseWebhookDeliveryHistoryQuery({}), { limit: 50 });

  assert.throws(
    () => parseWebhookDeliveryHistoryQuery({ outcome: "pending" }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );

  assert.throws(
    () => parseWebhookDeliveryHistoryQuery({ event: "content.archived" }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOK_EVENT_UNSUPPORTED" &&
      error.statusCode === 400,
  );

  assert.throws(
    () => parseWebhookDeliveryHistoryQuery({ limit: "101" }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );
});

test("webhook delivery history response assertions accept status-bearing attempts", () => {
  assert.doesNotThrow(() =>
    assertWebhookDeliveryHistoryResponse({
      data: [
        {
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
        },
      ],
    }),
  );
});
