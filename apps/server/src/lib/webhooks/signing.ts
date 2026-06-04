import { createHmac, timingSafeEqual } from "node:crypto";

import {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_REPLAY_RETENTION_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS,
} from "@mdcms/shared";

export {
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_REPLAY_RETENTION_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS,
};

export type WebhookReplayStore = {
  accept: (
    eventId: string,
    expiresAtUnixSeconds: number,
    nowUnixSeconds: number,
  ) => Promise<boolean> | boolean;
};

export type WebhookSignatureVerificationFailureReason =
  | "signature_missing"
  | "signature_malformed"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch"
  | "event_replayed";

export type WebhookSignatureVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: WebhookSignatureVerificationFailureReason;
    };

export type CreateWebhookSignatureHeaderInput = {
  secret: string;
  timestamp: number;
  body: string;
};

export type VerifyWebhookSignatureInput = {
  secret: string;
  // Must be the exact raw request body string; parsed and re-serialized JSON is not signature-equivalent.
  body: string;
  signature: string | null | undefined;
  eventId: string;
  replayStore: WebhookReplayStore;
  now?: () => Date;
  skewToleranceSeconds?: number;
  replayRetentionSeconds?: number;
};

export function createInMemoryWebhookReplayStore(): WebhookReplayStore {
  const acceptedEventIds = new Map<string, number>();

  return {
    accept(eventId, expiresAtUnixSeconds, nowUnixSeconds) {
      for (const [candidate, expiresAt] of acceptedEventIds) {
        if (expiresAt <= nowUnixSeconds) {
          acceptedEventIds.delete(candidate);
        }
      }

      const existingExpiry = acceptedEventIds.get(eventId);
      if (existingExpiry !== undefined && existingExpiry > nowUnixSeconds) {
        return false;
      }

      acceptedEventIds.set(eventId, expiresAtUnixSeconds);
      return true;
    },
  };
}

function parseSignatureHeader(
  signature: string | null | undefined,
): { timestamp: number; signature: string } | undefined {
  if (!signature) {
    return undefined;
  }

  const parts = new Map(
    signature.split(",").map((part) => {
      const [key, ...valueParts] = part.split("=");
      return [key.trim(), valueParts.join("=").trim()] as const;
    }),
  );
  const timestamp = Number(parts.get("t"));
  const hmac = parts.get("v1");

  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !hmac) {
    return undefined;
  }

  return {
    timestamp,
    signature: hmac,
  };
}

export function createWebhookSignature(
  input: CreateWebhookSignatureHeaderInput,
): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex");
}

export function createWebhookSignatureHeader(
  input: CreateWebhookSignatureHeaderInput,
): string {
  return `t=${input.timestamp},v1=${createWebhookSignature(input)}`;
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (
    actualBuffer.length === 0 ||
    actualBuffer.length !== expectedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<WebhookSignatureVerificationResult> {
  if (!input.signature) {
    return { ok: false, reason: "signature_missing" };
  }

  const parsed = parseSignatureHeader(input.signature);
  if (!parsed) {
    return { ok: false, reason: "signature_malformed" };
  }

  const nowUnixSeconds = Math.floor(
    (input.now?.() ?? new Date()).getTime() / 1000,
  );
  const skewToleranceSeconds =
    input.skewToleranceSeconds ?? WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS;

  if (Math.abs(nowUnixSeconds - parsed.timestamp) > skewToleranceSeconds) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = createWebhookSignature({
    secret: input.secret,
    timestamp: parsed.timestamp,
    body: input.body,
  });

  if (!signaturesMatch(parsed.signature, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const replayRetentionSeconds =
    input.replayRetentionSeconds ?? WEBHOOK_REPLAY_RETENTION_SECONDS;
  const accepted = await input.replayStore.accept(
    input.eventId,
    nowUnixSeconds + replayRetentionSeconds,
    nowUnixSeconds,
  );

  if (!accepted) {
    return { ok: false, reason: "event_replayed" };
  }

  return { ok: true };
}
