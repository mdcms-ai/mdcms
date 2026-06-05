import { RuntimeError } from "../runtime/error.js";
import { z } from "zod";

export const WEBHOOK_EVENTS = [
  "content.created",
  "content.updated",
  "content.published",
  "content.unpublished",
  "content.deleted",
  "content.restored",
  "media.uploaded",
] as const;

export const WEBHOOK_SIGNATURE_HEADER = "X-MDCMS-Signature";
export const WEBHOOK_DELIVERY_ID_HEADER = "X-MDCMS-Delivery-Id";
export const WEBHOOK_EVENT_ID_HEADER = "X-MDCMS-Event-Id";
export const WEBHOOK_SIGNATURE_SKEW_TOLERANCE_SECONDS = 300;
export const WEBHOOK_REPLAY_RETENTION_SECONDS = 300;

export const WEBHOOK_DELIVERY_OUTCOMES = [
  "succeeded",
  "retrying",
  "failed",
  "discarded",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

export type WebhookConfig = {
  id: string;
  project: string;
  environment: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WebhookCreateInput = {
  url: string;
  events: WebhookEvent[];
  secret: string;
  active?: boolean;
};

export type ParsedWebhookCreateInput = {
  url: string;
  events: WebhookEvent[];
  secret: string;
  active: boolean;
};

export type WebhookUpdateInput = {
  url?: string;
  events?: WebhookEvent[];
  secret?: string;
  active?: boolean;
};

export type WebhookListResponse = {
  data: WebhookConfig[];
};

export type WebhookConfigResponse = {
  data: WebhookConfig;
};

export type WebhookDeleteResponse = {
  data: {
    deleted: true;
    id: string;
  };
};

export type WebhookDeliveryHistoryEntry = {
  id: string;
  webhookId: string;
  project: string;
  environment: string;
  url: string;
  event: WebhookEvent;
  eventId: string;
  deliveryId: string;
  attempt: number;
  maxAttempts: number;
  outcome: WebhookDeliveryOutcome;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
};

export type WebhookDeliveryHistoryQuery = {
  webhookId?: string;
  event?: WebhookEvent;
  outcome?: WebhookDeliveryOutcome;
  limit?: number | string;
};

export type ParsedWebhookDeliveryHistoryQuery = {
  webhookId?: string;
  event?: WebhookEvent;
  outcome?: WebhookDeliveryOutcome;
  limit: number;
};

export type WebhookDeliveryHistoryResponse = {
  data: WebhookDeliveryHistoryEntry[];
};

export type WebhookContentPayload = {
  event: Exclude<WebhookEvent, "media.uploaded">;
  timestamp: string;
  project: string;
  environment: string;
  document: {
    documentId: string;
    translationGroupId: string;
    path: string;
    type: string;
    locale: string;
    format: "md" | "mdx";
    version: number | null;
  };
  user: {
    id: string;
    email: string;
  };
};

export type WebhookMediaPayload = {
  event: "media.uploaded";
  timestamp: string;
  project: string;
  environment: string;
  media: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    url: string;
  };
  user: {
    id: string;
    email: string;
  };
};

export type WebhookPayload = WebhookContentPayload | WebhookMediaPayload;

const WebhookEventSchema = z.enum(WEBHOOK_EVENTS);
const WebhookDeliveryOutcomeSchema = z.enum(WEBHOOK_DELIVERY_OUTCOMES);
const NonEmptyStringSchema = z.string().trim().min(1);
const UuidSchema = z.uuid();
const WebhookConfigSchema = z
  .object({
    id: NonEmptyStringSchema,
    project: NonEmptyStringSchema,
    environment: NonEmptyStringSchema,
    url: NonEmptyStringSchema,
    events: z.array(WebhookEventSchema).min(1),
    active: z.boolean(),
    createdBy: NonEmptyStringSchema,
    updatedBy: NonEmptyStringSchema,
    createdAt: NonEmptyStringSchema,
    updatedAt: NonEmptyStringSchema,
  })
  .strict();
const WebhookListResponseSchema = z
  .object({
    data: z.array(WebhookConfigSchema),
  })
  .strict();
const WebhookConfigResponseSchema = z
  .object({
    data: WebhookConfigSchema,
  })
  .strict();
const WebhookDeleteResponseSchema = z
  .object({
    data: z
      .object({
        deleted: z.literal(true),
        id: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();
const WebhookDeliveryHistoryEntrySchema = z
  .object({
    id: NonEmptyStringSchema,
    webhookId: NonEmptyStringSchema,
    project: NonEmptyStringSchema,
    environment: NonEmptyStringSchema,
    url: NonEmptyStringSchema,
    event: WebhookEventSchema,
    eventId: NonEmptyStringSchema,
    deliveryId: NonEmptyStringSchema,
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    outcome: WebhookDeliveryOutcomeSchema,
    statusCode: z.number().int().min(100).max(599).nullable(),
    error: z.string().nullable(),
    createdAt: NonEmptyStringSchema,
  })
  .strict();
const WebhookDeliveryHistoryResponseSchema = z
  .object({
    data: z.array(WebhookDeliveryHistoryEntrySchema),
  })
  .strict();

function runtimeError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code,
    message,
    statusCode: 400,
    ...(details ? { details } : {}),
  });
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw runtimeError("INVALID_INPUT", "Webhook payload must be an object.", {
      field: "body",
    });
  }

  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknownField = Object.keys(record).find(
    (field) => !allowedSet.has(field),
  );

  if (unknownField) {
    throw runtimeError(
      "INVALID_INPUT",
      `Field "${unknownField}" is not allowed.`,
      { field: unknownField },
    );
  }
}

function parseBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw runtimeError("INVALID_INPUT", `Field "${field}" must be a boolean.`, {
      field,
    });
  }

  return value;
}

function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw runtimeError("INVALID_INPUT", `Field "${field}" must be a string.`, {
      field,
    });
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function parseWebhookHistoryWebhookId(value: unknown): string | undefined {
  const webhookId = parseOptionalString(value, "webhookId");

  if (webhookId === undefined) {
    return undefined;
  }

  if (!UuidSchema.safeParse(webhookId).success) {
    throw runtimeError("INVALID_INPUT", 'Field "webhookId" must be a UUID.', {
      field: "webhookId",
    });
  }

  return webhookId;
}

function parseWebhookHistoryEvent(value: unknown): WebhookEvent | undefined {
  const event = parseOptionalString(value, "event");

  if (event === undefined) {
    return undefined;
  }

  if (!isWebhookEvent(event)) {
    throw runtimeError(
      "WEBHOOK_EVENT_UNSUPPORTED",
      `Webhook event "${event}" is not supported.`,
      { field: "event", value: event },
    );
  }

  return event;
}

function parseWebhookHistoryOutcome(
  value: unknown,
): WebhookDeliveryOutcome | undefined {
  const outcome = parseOptionalString(value, "outcome");

  if (outcome === undefined) {
    return undefined;
  }

  if (!(WEBHOOK_DELIVERY_OUTCOMES as readonly string[]).includes(outcome)) {
    throw runtimeError(
      "INVALID_INPUT",
      `Webhook delivery outcome "${outcome}" is not supported.`,
      { field: "outcome", value: outcome },
    );
  }

  return outcome as WebhookDeliveryOutcome;
}

function parseWebhookHistoryLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return 50;
  }

  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "limit" must be an integer from 1 through 100.',
      { field: "limit" },
    );
  }

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "limit" must be an integer from 1 through 100.',
      { field: "limit" },
    );
  }

  return limit;
}

function parseSecret(value: unknown): string {
  if (typeof value !== "string") {
    throw runtimeError("INVALID_INPUT", 'Field "secret" must be a string.', {
      field: "secret",
    });
  }

  if (value.length < 32 || value.length > 4096) {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "secret" must be between 32 and 4096 characters.',
      { field: "secret" },
    );
  }

  return value;
}

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === "string" &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

function parseEvents(value: unknown): WebhookEvent[] {
  if (!Array.isArray(value)) {
    throw runtimeError("INVALID_INPUT", 'Field "events" must be an array.', {
      field: "events",
    });
  }

  if (value.length === 0) {
    throw runtimeError("INVALID_INPUT", 'Field "events" must not be empty.', {
      field: "events",
    });
  }

  const events: WebhookEvent[] = [];
  const seen = new Set<WebhookEvent>();

  for (const candidate of value) {
    if (!isWebhookEvent(candidate)) {
      throw runtimeError(
        "WEBHOOK_EVENT_UNSUPPORTED",
        `Webhook event "${String(candidate)}" is not supported.`,
        { field: "events", value: candidate },
      );
    }

    if (seen.has(candidate)) {
      throw runtimeError(
        "INVALID_INPUT",
        `Webhook event "${candidate}" must not be duplicated.`,
        { field: "events", value: candidate },
      );
    }

    seen.add(candidate);
    events.push(candidate);
  }

  return events;
}

function parseUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw runtimeError("INVALID_INPUT", 'Field "url" must be a string.', {
      field: "url",
    });
  }

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > 2048) {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "url" must be a non-empty URL no longer than 2048 characters.',
      { field: "url" },
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "url" must be an absolute URL.',
      {
        field: "url",
      },
    );
  }

  if (url.protocol !== "https:") {
    throw runtimeError(
      "WEBHOOK_URL_NOT_HTTPS",
      'Field "url" must use the https scheme.',
      { field: "url" },
    );
  }

  if (url.hash.length > 0) {
    throw runtimeError(
      "INVALID_INPUT",
      'Field "url" must not include a fragment.',
      {
        field: "url",
      },
    );
  }

  return trimmed;
}

export function parseWebhookCreateInput(
  value: unknown,
): ParsedWebhookCreateInput {
  const record = assertRecord(value);
  rejectUnknownFields(record, ["url", "events", "secret", "active"]);

  return {
    url: parseUrl(record.url),
    events: parseEvents(record.events),
    secret: parseSecret(record.secret),
    active:
      record.active === undefined
        ? true
        : parseBooleanField(record.active, "active"),
  };
}

export function parseWebhookUpdateInput(value: unknown): WebhookUpdateInput {
  const record = assertRecord(value);
  rejectUnknownFields(record, ["url", "events", "secret", "active"]);

  const input: WebhookUpdateInput = {};

  if (record.url !== undefined) {
    input.url = parseUrl(record.url);
  }
  if (record.events !== undefined) {
    input.events = parseEvents(record.events);
  }
  if (record.secret !== undefined) {
    input.secret = parseSecret(record.secret);
  }
  if (record.active !== undefined) {
    input.active = parseBooleanField(record.active, "active");
  }

  if (Object.keys(input).length === 0) {
    throw runtimeError(
      "INVALID_INPUT",
      "Webhook update must include at least one field.",
      { field: "body" },
    );
  }

  return input;
}

export function parseWebhookDeliveryHistoryQuery(
  value: unknown,
): ParsedWebhookDeliveryHistoryQuery {
  const record = assertRecord(value);
  rejectUnknownFields(record, [
    "webhookId",
    "event",
    "outcome",
    "limit",
    "project",
    "environment",
  ]);

  const parsed: ParsedWebhookDeliveryHistoryQuery = {
    limit: parseWebhookHistoryLimit(record.limit),
  };
  const webhookId = parseWebhookHistoryWebhookId(record.webhookId);
  const event = parseWebhookHistoryEvent(record.event);
  const outcome = parseWebhookHistoryOutcome(record.outcome);

  if (webhookId !== undefined) {
    parsed.webhookId = webhookId;
  }
  if (event !== undefined) {
    parsed.event = event;
  }
  if (outcome !== undefined) {
    parsed.outcome = outcome;
  }

  return parsed;
}

export function assertWebhookConfig(
  value: unknown,
  path = "value",
): asserts value is WebhookConfig {
  const parsed = WebhookConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError("INVALID_INPUT", `${path} must be a webhook config.`, {
      path,
    });
  }
}

export function assertWebhookListResponse(
  value: unknown,
  path = "value",
): asserts value is WebhookListResponse {
  const parsed = WebhookListResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError(
      "INVALID_INPUT",
      `${path} must be a webhook list response.`,
      {
        path,
      },
    );
  }
}

export function assertWebhookConfigResponse(
  value: unknown,
  path = "value",
): asserts value is WebhookConfigResponse {
  const parsed = WebhookConfigResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError(
      "INVALID_INPUT",
      `${path} must be a webhook config response.`,
      {
        path,
      },
    );
  }
}

export function assertWebhookDeleteResponse(
  value: unknown,
  path = "value",
): asserts value is WebhookDeleteResponse {
  const parsed = WebhookDeleteResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError(
      "INVALID_INPUT",
      `${path} must be a webhook delete response.`,
      {
        path,
      },
    );
  }
}

export function assertWebhookDeliveryHistoryResponse(
  value: unknown,
  path = "value",
): asserts value is WebhookDeliveryHistoryResponse {
  const parsed = WebhookDeliveryHistoryResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError(
      "INVALID_INPUT",
      `${path} must be a webhook delivery history response.`,
      {
        path,
      },
    );
  }
}
