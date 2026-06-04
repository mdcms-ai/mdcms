import type {
  ParsedWebhookCreateInput,
  WebhookConfig,
  WebhookPayload,
} from "@mdcms/shared";

import type { AuthorizationRequirement } from "../auth.js";
import { createServerRequestHandler } from "../server.js";
import type { ContentDocument } from "../content-api/types.js";

import { mountWebhookApiRoutes } from "../webhooks-api.js";
import type {
  MountWebhookApiRoutesOptions,
  WebhookDeliveryTarget,
  WebhookStore,
} from "../webhooks-api.js";

export const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

export const scopeHeaders = {
  "x-mdcms-project": "marketing-site",
  "x-mdcms-environment": "production",
};

export const validSecret = "0123456789abcdef0123456789abcdef";

export function createConfig(
  overrides: Partial<WebhookConfig> = {},
): WebhookConfig {
  return {
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    project: "marketing-site",
    environment: "production",
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    active: true,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

export function createTarget(
  overrides: Partial<WebhookDeliveryTarget> = {},
): WebhookDeliveryTarget {
  return {
    ...createConfig(overrides),
    secret: validSecret,
    ...overrides,
  };
}

export function createPayload(): WebhookPayload {
  return {
    event: "content.published",
    timestamp: "2026-06-03T12:34:56.000Z",
    project: "marketing-site",
    environment: "production",
    document: {
      documentId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
      translationGroupId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
      path: "blog/webhooks",
      type: "BlogPost",
      locale: "en",
      format: "mdx",
      version: 3,
    },
    user: {
      id: "user-1",
      email: "editor@example.com",
    },
  };
}

export function createDocument(
  overrides: Partial<ContentDocument> = {},
): ContentDocument {
  return {
    documentId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597f",
    translationGroupId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
    project: "marketing-site",
    environment: "production",
    path: "blog/webhooks",
    type: "BlogPost",
    locale: "en",
    format: "mdx",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 4,
    frontmatter: { slug: "webhooks" },
    body: "body",
    createdBy: "user-1",
    createdAt: "2026-06-03T10:00:00.000Z",
    updatedBy: "user-1",
    updatedAt: "2026-06-03T12:00:00.000Z",
    ...overrides,
  };
}

export function createStubStore(
  overrides: Partial<WebhookStore> = {},
): WebhookStore {
  const fail = (label: string) => async (): Promise<never> => {
    throw new Error(`stub ${label} not configured for this test`);
  };

  return {
    list: overrides.list ?? (fail("list") as WebhookStore["list"]),
    create: overrides.create ?? (fail("create") as WebhookStore["create"]),
    update: overrides.update ?? (fail("update") as WebhookStore["update"]),
    delete: overrides.delete ?? (fail("delete") as WebhookStore["delete"]),
    listActiveByEvent:
      overrides.listActiveByEvent ??
      (fail("listActiveByEvent") as WebhookStore["listActiveByEvent"]),
    listActiveTargetsByEvent:
      overrides.listActiveTargetsByEvent ??
      (fail(
        "listActiveTargetsByEvent",
      ) as WebhookStore["listActiveTargetsByEvent"]),
    recordDeliveryAttempt:
      overrides.recordDeliveryAttempt ??
      (fail("recordDeliveryAttempt") as WebhookStore["recordDeliveryAttempt"]),
    listDeliveryHistory:
      overrides.listDeliveryHistory ??
      (fail("listDeliveryHistory") as WebhookStore["listDeliveryHistory"]),
  };
}

export function createTestRoutes(
  options: Partial<MountWebhookApiRoutesOptions>,
) {
  return createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountWebhookApiRoutes(app, {
        store: options.store ?? createStubStore(),
        authorize:
          options.authorize ??
          (async () => ({
            mode: "session" as const,
            principal: {
              type: "session" as const,
              session: {
                id: "session-1",
                userId: "user-1",
                email: "editor@example.com",
                issuedAt: "2026-06-03T00:00:00.000Z",
                expiresAt: "2026-06-03T01:00:00.000Z",
              },
            },
          })),
        requireCsrf: options.requireCsrf ?? (async () => undefined),
        resolveTargetAddresses:
          options.resolveTargetAddresses ?? (async () => ["93.184.216.34"]),
      });
    },
  });
}

export type { AuthorizationRequirement, ParsedWebhookCreateInput };
