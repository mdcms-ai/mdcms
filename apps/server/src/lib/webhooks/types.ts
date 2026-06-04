import type {
  WebhookConfig,
  ParsedWebhookDeliveryHistoryQuery,
  ParsedWebhookCreateInput,
  WebhookEvent,
  WebhookDeliveryHistoryEntry,
  WebhookPayload,
  WebhookUpdateInput,
} from "@mdcms/shared";

import type { AuthorizationRequirement, AuthorizedRequest } from "../auth.js";
import type {
  ContentLifecycleActor,
  ContentLifecycleEventSink,
} from "../content-api/types.js";
import type { DrizzleDatabase } from "../db.js";
import type {
  ResolvedWebhookTarget,
  WebhookTargetAddressResolver,
} from "./target-url.js";

export type WebhookScope = {
  project: string;
  environment: string;
};

export type WebhookMutationContext = {
  actorId: string;
};

export type WebhookDeliveryTarget = WebhookConfig & {
  secret: string;
};

export type WebhookStore = {
  list: (scope: WebhookScope) => Promise<WebhookConfig[]>;
  create: (
    scope: WebhookScope,
    input: ParsedWebhookCreateInput,
    context: WebhookMutationContext,
  ) => Promise<WebhookConfig>;
  update: (
    scope: WebhookScope,
    id: string,
    input: WebhookUpdateInput,
    context: WebhookMutationContext,
  ) => Promise<WebhookConfig>;
  delete: (
    scope: WebhookScope,
    id: string,
  ) => Promise<{ deleted: true; id: string }>;
  listActiveByEvent: (
    scope: WebhookScope,
    event: WebhookEvent,
  ) => Promise<WebhookConfig[]>;
  listActiveTargetsByEvent: (
    scope: WebhookScope,
    event: WebhookEvent,
  ) => Promise<WebhookDeliveryTarget[]>;
  recordDeliveryAttempt: (
    result: WebhookDeliveryAttemptResult,
  ) => Promise<void>;
  listDeliveryHistory: (
    scope: WebhookScope,
    filter: ParsedWebhookDeliveryHistoryQuery,
  ) => Promise<WebhookDeliveryHistoryEntry[]>;
};

export type WebhookRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => WebhookRouteApp;
  post?: (path: string, handler: (ctx: any) => unknown) => WebhookRouteApp;
  put?: (path: string, handler: (ctx: any) => unknown) => WebhookRouteApp;
  delete?: (path: string, handler: (ctx: any) => unknown) => WebhookRouteApp;
};

export type WebhookRequestAuthorizer = (
  request: Request,
  requirement: AuthorizationRequirement,
) => Promise<AuthorizedRequest>;

export type CreateDatabaseWebhookStoreOptions = {
  db: DrizzleDatabase;
  now?: () => Date;
};

export type MountWebhookApiRoutesOptions = {
  store: WebhookStore;
  authorize: WebhookRequestAuthorizer;
  requireCsrf: (request: Request) => Promise<void>;
  resolveTargetAddresses?: WebhookTargetAddressResolver;
};

export type WebhookDelivery = {
  webhook: WebhookDeliveryTarget;
  payload: WebhookPayload;
  eventId: string;
  deliveryId: string;
  target?: ResolvedWebhookTarget;
  attempt: number;
  maxAttempts: number;
};

export type WebhookDeliverySinkResult = {
  statusCode?: number | null;
};

export type WebhookDeliverySink = (
  delivery: WebhookDelivery,
) =>
  | Promise<WebhookDeliverySinkResult | void>
  | WebhookDeliverySinkResult
  | void;

export type WebhookRetryPolicy = {
  maxAttempts: number;
  retryDelaysMs: readonly number[];
};

export type WebhookRetrySleeper = (delayMs: number) => Promise<void> | void;

export type WebhookQueuedEvent = {
  scope: WebhookScope;
  event: WebhookEvent;
  eventId: string;
  payload: WebhookPayload;
};

export type WebhookDeliveryInput = {
  webhook: WebhookDeliveryTarget;
  payload: WebhookPayload;
  eventId?: string;
};

export type WebhookDeliveryQueueInput =
  | WebhookQueuedEvent
  | WebhookDeliveryInput;

export type WebhookDeliveryAttemptResult = {
  delivery: Omit<WebhookDelivery, "target"> & {
    target?: ResolvedWebhookTarget;
  };
  outcome: "succeeded" | "retrying" | "failed" | "discarded";
  statusCode?: number | null;
  error?: unknown;
  nextDelayMs?: number;
};

export type WebhookDeliveryAttemptRecorder = (
  result: WebhookDeliveryAttemptResult,
) => Promise<void> | void;

export type WebhookDeliveryQueue = {
  enqueue: (input: WebhookDeliveryQueueInput) => void;
  drain: () => Promise<void>;
};

export type WebhookIdGenerator = () => string;

export type CreateWebhookDeliveryWorkerOptions = {
  store?: WebhookStore;
  deliver?: WebhookDeliverySink;
  resolveTargetAddresses?: WebhookTargetAddressResolver;
  retryPolicy?: WebhookRetryPolicy;
  sleep?: WebhookRetrySleeper;
  recordAttempt?: WebhookDeliveryAttemptRecorder;
  createEventId?: WebhookIdGenerator;
  createDeliveryId?: WebhookIdGenerator;
};

export type CreateWebhookEventDispatcherOptions = {
  store: WebhookStore;
  now?: () => Date;
  deliver?: WebhookDeliverySink;
  resolveTargetAddresses?: WebhookTargetAddressResolver;
  retryPolicy?: WebhookRetryPolicy;
  sleep?: WebhookRetrySleeper;
  recordAttempt?: WebhookDeliveryAttemptRecorder;
  deliveryQueue?: WebhookDeliveryQueue;
  createEventId?: WebhookIdGenerator;
  createDeliveryId?: WebhookIdGenerator;
};

export type WebhookMediaUpload = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};

export type WebhookEventDispatcher = ContentLifecycleEventSink & {
  emitMediaUploaded: (input: {
    scope: WebhookScope;
    media: WebhookMediaUpload;
    actor: ContentLifecycleActor;
  }) => Promise<void>;
  drainDeliveries: () => Promise<void>;
};
