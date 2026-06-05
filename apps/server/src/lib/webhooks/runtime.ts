import type { Logger } from "@mdcms/shared";

import type { DrizzleDatabase } from "../db.js";

import { createDatabaseWebhookStore } from "./database-store.js";
import { createWebhookEventDispatcher } from "./dispatcher.js";
import { createWebhookHttpDeliverySink } from "./http-delivery.js";
import type {
  WebhookDelivery,
  WebhookDeliveryAttemptResult,
  WebhookEventDispatcher,
  WebhookStore,
} from "./types.js";

export type RuntimeWebhookRuntime = {
  store: WebhookStore;
  dispatcher: WebhookEventDispatcher;
};

export type CreateRuntimeWebhookRuntimeOptions = {
  db: DrizzleDatabase;
  logger: Logger;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryLogMeta(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    webhookId: delivery.webhook.id,
    event: delivery.payload.event,
    eventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    project: delivery.scope.project,
    environment: delivery.scope.environment,
    attempt: delivery.attempt,
    maxAttempts: delivery.maxAttempts,
  };
}

function failedAttemptLogMeta(
  result: WebhookDeliveryAttemptResult,
): Record<string, unknown> {
  const error =
    result.error === undefined || result.error === null
      ? undefined
      : errorMessage(result.error);

  return {
    ...deliveryLogMeta(result.delivery),
    statusCode: result.statusCode ?? null,
    ...(error ? { error } : {}),
  };
}

export function createRuntimeWebhookRuntime({
  db,
  logger,
}: CreateRuntimeWebhookRuntimeOptions): RuntimeWebhookRuntime {
  const store = createDatabaseWebhookStore({ db });
  const deliverWebhook = createWebhookHttpDeliverySink();
  const dispatcher = createWebhookEventDispatcher({
    store,
    deliver: async (delivery) => {
      logger.info("webhook.delivery_attempt", deliveryLogMeta(delivery));
      const result = await deliverWebhook(delivery);
      logger.info("webhook.delivery_succeeded", deliveryLogMeta(delivery));
      return result;
    },
    recordAttempt: async (result) => {
      await store.recordDeliveryAttempt(result);

      if (result.outcome !== "failed" && result.outcome !== "discarded") {
        return;
      }

      logger.error(
        `webhook.delivery_${result.outcome}`,
        failedAttemptLogMeta(result),
      );
    },
    onRecordAttemptError: ({ result, error }) => {
      logger.error("webhook.delivery_attempt_record_failed", {
        ...failedAttemptLogMeta(result),
        outcome: result.outcome,
        error: errorMessage(error),
      });
    },
    onQueueError: ({ input, error }) => {
      logger.error("webhook.delivery_queue_failed", {
        project: input.scope.project,
        environment: input.scope.environment,
        event: input.event,
        eventId: input.eventId,
        error: errorMessage(error),
      });
    },
  });

  return { store, dispatcher };
}
