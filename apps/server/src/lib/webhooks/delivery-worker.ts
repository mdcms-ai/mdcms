import { randomUUID } from "node:crypto";

import type {
  CreateWebhookDeliveryWorkerOptions,
  DeliverWebhookWithRetriesOptions,
  WebhookDeliveryAttemptResult,
  WebhookDeliveryInput,
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
  options: CreateWebhookDeliveryWorkerOptions,
): WebhookDeliveryQueue {
  if (typeof options.deliver !== "function") {
    throw new Error(
      "Webhook delivery worker requires an explicit delivery sink.",
    );
  }
  if (!options.store) {
    throw new Error("Webhook delivery worker requires an explicit store.");
  }

  const createEventId = options.createEventId ?? randomUUID;
  const onQueueError = options.onQueueError ?? (async () => undefined);
  const pending = new Set<Promise<void>>();

  const reportQueueError = async (
    input: WebhookQueuedEvent,
    error: unknown,
  ): Promise<void> => {
    try {
      await onQueueError({ input, error });
    } catch {
      // Queue error reporting is best effort; it must not rethrow from drain.
    }
  };

  const track = (input: WebhookQueuedEvent, work: Promise<void>) => {
    const tracked = work.catch((error) => reportQueueError(input, error));
    pending.add(tracked);
    tracked.finally(() => pending.delete(tracked));
  };

  const runEvent = async (event: WebhookQueuedEvent): Promise<void> => {
    const matchingWebhooks = await options.store.listActiveTargetsByEvent(
      event.scope,
      event.event,
    );

    await Promise.all(
      matchingWebhooks.map((webhook) =>
        deliverWebhookWithRetries(
          {
            scope: event.scope,
            webhook,
            payload: event.payload,
            eventId: event.eventId,
          },
          {
            deliver: options.deliver,
            resolveTargetAddresses: options.resolveTargetAddresses,
            retryPolicy: options.retryPolicy,
            sleep: options.sleep,
            recordAttempt: options.recordAttempt,
            onRecordAttemptError: options.onRecordAttemptError,
            createEventId,
            createDeliveryId: options.createDeliveryId,
          },
        ),
      ),
    );
  };

  return {
    enqueue(input) {
      track(input, runEvent(input));
    },

    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}

export async function deliverWebhookWithRetries(
  delivery: WebhookDeliveryInput,
  options: DeliverWebhookWithRetriesOptions,
): Promise<void> {
  if (typeof options.deliver !== "function") {
    throw new Error("Webhook delivery requires an explicit delivery sink.");
  }

  const retryPolicy = options.retryPolicy ?? DEFAULT_WEBHOOK_RETRY_POLICY;
  const maxAttempts = Math.max(1, Math.floor(retryPolicy.maxAttempts));
  const deliver = options.deliver;
  const sleep = options.sleep ?? defaultSleep;
  const recordAttempt = options.recordAttempt ?? (async () => undefined);
  const onRecordAttemptError =
    options.onRecordAttemptError ?? (async () => undefined);
  const createEventId = options.createEventId ?? randomUUID;
  const createDeliveryId = options.createDeliveryId ?? randomUUID;

  const safelyRecordAttempt = async (
    result: WebhookDeliveryAttemptResult,
  ): Promise<void> => {
    try {
      await recordAttempt(result);
    } catch (error) {
      try {
        await onRecordAttemptError({ result, error });
      } catch {
        // Delivery history persistence is best effort; reporting failures
        // must not trigger retries or duplicate sends.
      }
    }
  };

  const runAttempt = async (
    attempt: number,
    eventId: string,
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
      await safelyRecordAttempt({
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
        await safelyRecordAttempt({
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
      await safelyRecordAttempt({
        delivery: attemptDelivery,
        outcome: "retrying",
        statusCode: statusCodeFromError(error),
        error,
        nextDelayMs: delayMs,
      });
      await sleep(delayMs);
      await runAttempt(attempt + 1, eventId);
    }
  };

  await runAttempt(1, delivery.eventId ?? createEventId());
}
