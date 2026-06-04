import { randomUUID } from "node:crypto";

import type { ContentLifecycleActor } from "../content-api/types.js";

import type {
  CreateWebhookEventDispatcherOptions,
  WebhookEventDispatcher,
} from "./types.js";
import { createWebhookDeliveryWorker } from "./delivery-worker.js";

function userPayload(actor: ContentLifecycleActor): {
  id: string;
  email: string;
} {
  return {
    id: actor.id,
    email: actor.email,
  };
}

export function createWebhookEventDispatcher(
  options: CreateWebhookEventDispatcherOptions,
): WebhookEventDispatcher {
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? randomUUID;
  const deliveryQueue =
    options.deliveryQueue ??
    createWebhookDeliveryWorker({
      store: options.store,
      deliver: options.deliver,
      resolveTargetAddresses: options.resolveTargetAddresses,
      retryPolicy: options.retryPolicy,
      sleep: options.sleep,
      recordAttempt: options.recordAttempt,
      createEventId,
      createDeliveryId: options.createDeliveryId,
    });

  return {
    async emitContentEvent(input) {
      const eventId = createEventId();

      deliveryQueue.enqueue({
        scope: input.scope,
        event: input.event,
        eventId,
        payload: {
          event: input.event,
          timestamp: now().toISOString(),
          project: input.scope.project,
          environment: input.scope.environment,
          document: {
            documentId: input.document.documentId,
            translationGroupId: input.document.translationGroupId,
            path: input.document.path,
            type: input.document.type,
            locale: input.document.locale,
            format: input.document.format,
            version: input.document.publishedVersion,
          },
          user: userPayload(input.actor),
        },
      });
    },

    async emitMediaUploaded(input) {
      const eventId = createEventId();

      deliveryQueue.enqueue({
        scope: input.scope,
        event: "media.uploaded",
        eventId,
        payload: {
          event: "media.uploaded",
          timestamp: now().toISOString(),
          project: input.scope.project,
          environment: input.scope.environment,
          media: input.media,
          user: userPayload(input.actor),
        },
      });
    },

    async drainDeliveries() {
      await deliveryQueue.drain();
    },
  };
}
