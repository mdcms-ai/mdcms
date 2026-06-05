import { request as httpsRequest, type RequestOptions } from "node:https";

import type { WebhookDeliverySink } from "./types.js";
import {
  resolveWebhookTarget,
  type ResolvedWebhookTarget,
  type WebhookTargetAddressResolver,
} from "./target-url.js";
import {
  createWebhookSignatureHeader,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "./signing.js";

export type WebhookFetch = typeof fetch;

export const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

export type WebhookHttpTransportInput = {
  target: ResolvedWebhookTarget;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

export type WebhookHttpTransport = (
  input: WebhookHttpTransportInput,
) => Promise<{ status: number }>;

export type CreateWebhookHttpDeliverySinkOptions = {
  fetch?: WebhookFetch;
  transport?: WebhookHttpTransport;
  resolveTargetAddresses?: WebhookTargetAddressResolver;
  now?: () => Date;
  timeoutMs?: number;
};

export class WebhookHttpDeliveryError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Webhook delivery failed with status ${statusCode}.`);
    this.name = "WebhookHttpDeliveryError";
    this.statusCode = statusCode;
  }
}

export function createPinnedWebhookTargetLookup(
  target: Pick<ResolvedWebhookTarget, "address" | "addressFamily">,
): NonNullable<RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [
        {
          address: target.address,
          family: target.addressFamily,
        },
      ]);
      return;
    }

    callback(null, target.address, target.addressFamily);
  };
}

function sendWithPinnedTarget(
  input: WebhookHttpTransportInput,
): Promise<{ status: number }> {
  const url = new URL(input.target.url);
  const headers = {
    ...input.headers,
    host: url.host,
    "content-length": String(Buffer.byteLength(input.body)),
  };
  const lookup = createPinnedWebhookTargetLookup(input.target);

  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        lookup,
        servername: input.target.hostname,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0 });
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(
        new Error(`Webhook delivery timed out after ${input.timeoutMs}ms.`),
      );
    });
    request.end(input.body);
  });
}

export function createWebhookHttpDeliverySink(
  options: CreateWebhookHttpDeliverySinkOptions = {},
): WebhookDeliverySink {
  const send = options.fetch ?? fetch;
  const transport = options.transport ?? sendWithPinnedTarget;
  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS),
  );

  return async ({
    webhook,
    payload,
    eventId,
    deliveryId,
    target: resolvedTarget,
  }) => {
    const target =
      resolvedTarget ??
      (await resolveWebhookTarget(webhook.url, {
        resolveAddresses: options.resolveTargetAddresses,
      }));
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(
      (options.now?.() ?? new Date()).getTime() / 1000,
    );
    const headers = {
      "content-type": "application/json; charset=utf-8",
      [WEBHOOK_SIGNATURE_HEADER]: createWebhookSignatureHeader({
        secret: webhook.secret,
        timestamp,
        body,
      }),
      [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
      [WEBHOOK_EVENT_ID_HEADER]: eventId,
    };
    const response = options.fetch
      ? await (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => {
            controller.abort(
              new Error(`Webhook delivery timed out after ${timeoutMs}ms.`),
            );
          }, timeoutMs);

          try {
            return await send(target.url, {
              method: "POST",
              headers,
              redirect: "manual",
              body,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
        })()
      : await transport({
          target,
          body,
          headers,
          timeoutMs,
        });

    const status = response.status;

    if (status < 200 || status >= 300) {
      throw new WebhookHttpDeliveryError(status);
    }

    return { statusCode: status };
  };
}
