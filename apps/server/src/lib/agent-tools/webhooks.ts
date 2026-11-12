import { z } from "zod";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_DELIVERY_OUTCOMES,
  type WebhookCreateInput,
  type WebhookUpdateInput,
  type WebhookDeliveryHistoryQuery,
  type WebhookConfig,
  type WebhookDeliveryHistoryEntry,
} from "@mdcms/shared";
import { dispatchJson } from "./content.js";
import { defineAgentTool } from "./types.js";
const text = z.string().min(1);
export const webhookCreateSchema = z.strictObject({
  url: text,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  secret: text,
  active: z.boolean().optional(),
}) satisfies z.ZodType<WebhookCreateInput>;
export const webhookUpdateSchema =
  webhookCreateSchema.partial() satisfies z.ZodType<WebhookUpdateInput>;
export const webhookHistoryQuerySchema = z.strictObject({
  webhookId: text.optional(),
  event: z.enum(WEBHOOK_EVENTS).optional(),
  outcome: z.enum(WEBHOOK_DELIVERY_OUTCOMES).optional(),
  limit: z.union([z.number().int().positive(), text]).optional(),
}) satisfies z.ZodType<WebhookDeliveryHistoryQuery>;
export const webhookSchema = z.object({
  id: text,
  project: text,
  environment: text,
  url: text,
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  active: z.boolean(),
  createdBy: text,
  updatedBy: text,
  createdAt: text,
  updatedAt: text,
}) satisfies z.ZodType<WebhookConfig>;
export const webhookDeliverySchema = z.object({
  id: text,
  webhookId: text,
  project: text,
  environment: text,
  url: text,
  event: z.enum(WEBHOOK_EVENTS),
  eventId: text,
  deliveryId: text,
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  outcome: z.enum(WEBHOOK_DELIVERY_OUTCOMES),
  statusCode: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: text,
}) satisfies z.ZodType<WebhookDeliveryHistoryEntry>;
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};
const path = (id: string) => `/api/v1/webhooks/${encodeURIComponent(id)}`;
export const webhookTools = [
  defineAgentTool({
    name: "list_webhooks",
    title: "List webhooks",
    description: "Read configured webhooks without secrets.",
    requiredScopes: ["webhooks:read"],
    annotations: read,
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ data: z.array(webhookSchema) }),
    execute: (_, { dispatch }) =>
      dispatchJson(dispatch, { method: "GET", path: "/api/v1/webhooks" }),
  }),
  defineAgentTool({
    name: "create_webhook",
    title: "Create webhook",
    description: "Create a webhook with a write-only signing secret.",
    requiredScopes: ["webhooks:write"],
    annotations: write,
    inputSchema: webhookCreateSchema,
    outputSchema: z.object({ data: webhookSchema }),
    execute: (body, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "POST",
        path: "/api/v1/webhooks",
        body,
      }),
  }),
  defineAgentTool({
    name: "update_webhook",
    title: "Update webhook",
    description: "Update a webhook with a write-only signing secret.",
    requiredScopes: ["webhooks:write"],
    annotations: write,
    inputSchema: webhookUpdateSchema.extend({ id: text }),
    outputSchema: z.object({ data: webhookSchema }),
    execute: ({ id, ...body }, { dispatch }) =>
      dispatchJson(dispatch, { method: "PUT", path: path(id), body }),
  }),
  defineAgentTool({
    name: "delete_webhook",
    title: "Delete webhook",
    description: "Delete a configured webhook.",
    requiredScopes: ["webhooks:write"],
    annotations: write,
    inputSchema: z.strictObject({ id: text }),
    outputSchema: z.object({
      data: z.object({ deleted: z.literal(true), id: text }),
    }),
    execute: ({ id }, { dispatch }) =>
      dispatchJson(dispatch, { method: "DELETE", path: path(id) }),
  }),
  defineAgentTool({
    name: "list_webhook_deliveries",
    title: "List webhook deliveries",
    description: "Read webhook delivery history.",
    requiredScopes: ["webhooks:read"],
    annotations: read,
    inputSchema: webhookHistoryQuerySchema,
    outputSchema: z.object({ data: z.array(webhookDeliverySchema) }),
    execute: (input, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: "/api/v1/webhooks/deliveries",
        query: Object.fromEntries(
          Object.entries(input).map(([k, v]) => [k, String(v)]),
        ),
      }),
  }),
];
