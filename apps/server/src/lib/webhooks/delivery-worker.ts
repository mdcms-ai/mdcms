import { randomUUID } from "node:crypto";

import type {
  CreateWebhookDeliveryWorkerOptions,
  WebhookDeliveryInput,
  WebhookDeliveryQueueInput,
  WebhookDeliveryQueue,
  WebhookQueuedEvent,
  WebhookRetryPolicy,
} from "./types.js";
import { resolveWebhookTarget } from "./target-url.js";

export const DEFAULT_WEBHOOK_RETRY_POLICY: WebhookRetryPolicy = {
  maxAttempts: 3,
  retryDelaysMs: [1000, 2000],
};

const TERMINAL_TARGET_VALIDATION_ERROR_CODES = new Set([
  "WEBHOOK_TARGET_FORBIDDEN",
  "WEBHOOK_URL_NOT_HTTPS",
]);

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isTerminalTargetValidationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    TERMINAL_TARGET_VALIDATION_ERROR_CODES.has(
      String((error as { code?: unknown }).code),
    )
  );
}

function normalizeStatusCode(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  ) {
    return value;
  }

  return undefined;
}

function statusCodeFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  return normalizeStatusCode((error as { statusCode?: unknown }).statusCode);
}

export function createWebhookDeliveryWorker(
  options: CreateWebhookDeliveryWorkerOptions = {},
): WebhookDeliveryQueue {
  const retryPolicy = options.retryPolicy ?? DEFAULT_WEBHOOK_RETRY_POLICY;
  const maxAttempts = Math.max(1, Math.floor(retryPolicy.maxAttempts));
  const deliver = options.deliver ?? (async () => undefined);
  const sleep = options.sleep ?? defaultSleep;
  const recordAttempt = options.recordAttempt ?? (async () => undefined);
  const createEventId = options.createEventId ?? randomUUID;
  const createDeliveryId = options.createDeliveryId ?? randomUUID;
  const pending = new Set<Promise<void>>();

  const track = (work: Promise<void>) => {
    const tracked = work.catch(() => undefined);
    pending.add(tracked);
    tracked.finally(() => pending.delete(tracked));
  };

  const runAttempt = async (
    delivery: WebhookDeliveryInput,
    attempt: number,
    eventId = delivery.eventId ?? createEventId(),
  ): Promise<void> => {
    const attemptDelivery = {
      ...delivery,
      eventId,
      deliveryId: createDeliveryId(),
      attempt,
      maxAttempts,
    };

    try {
      const target = await resolveWebhookTarget(delivery.webhook.url, {
        resolveAddresses: options.resolveTargetAddresses,
      });
      const deliveryResult = await deliver({
        ...attemptDelivery,
        target,
      });
      await recordAttempt({
        delivery: {
          ...attemptDelivery,
          target,
        },
        outcome: "succeeded",
        statusCode: normalizeStatusCode(deliveryResult?.statusCode),
      });
    } catch (error) {
      const terminal = isTerminalTargetValidationError(error);
      if (terminal || attempt >= maxAttempts) {
        await recordAttempt({
          delivery: attemptDelivery,
          outcome: terminal ? "discarded" : "failed",
          statusCode: statusCodeFromError(error),
          error,
        });
        return;
      }

      const delayMs =
        retryPolicy.retryDelaysMs[attempt - 1] ??
        retryPolicy.retryDelaysMs.at(-1) ??
        0;
      await recordAttempt({
        delivery: attemptDelivery,
        outcome: "retrying",
        statusCode: statusCodeFromError(error),
        error,
        nextDelayMs: delayMs,
      });
      await sleep(delayMs);
      await runAttempt(delivery, attempt + 1, eventId);
    }
  };

  const runEvent = async (event: WebhookQueuedEvent): Promise<void> => {
    if (!options.store) {
      throw new Error("Webhook delivery worker requires a store for events.");
    }

    const matchingWebhooks = await options.store.listActiveTargetsByEvent(
      event.scope,
      event.event,
    );

    await Promise.all(
      matchingWebhooks.map((webhook) =>
        runAttempt(
          {
            webhook,
            payload: event.payload,
            eventId: event.eventId,
          },
          1,
        ),
      ),
    );
  };

  const isQueuedEvent = (
    input: WebhookDeliveryQueueInput,
  ): input is WebhookQueuedEvent => {
    return "scope" in input && "event" in input;
  };

  return {
    enqueue(input) {
      track(isQueuedEvent(input) ? runEvent(input) : runAttempt(input, 1));
    },

    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}
