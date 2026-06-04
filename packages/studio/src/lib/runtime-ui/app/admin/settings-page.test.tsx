import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "../../adapters/next-themes.js";
import { StudioNavigationProvider } from "../../navigation.js";
import {
  AdminCapabilitiesProvider,
  type AdminCapabilitiesValue,
} from "./capabilities-context.js";
import { StudioMountInfoProvider } from "./mount-info-context.js";
import SettingsPage from "./settings-page.js";
import { WebhookDeleteConfirmationDialog } from "./webhook-delete-confirmation-dialog.js";
import {
  SettingsPageView,
  type SettingsPageApiKeysState,
  type SettingsPageSchemaSummaryState,
  type SettingsPageWebhookConfigState,
  type SettingsPageWebhookHistoryState,
} from "./settings-page.js";
import type { ApiKeyMetadata } from "../../../api-keys-api.js";
import type { WebhookConfig, WebhookDeliveryHistoryEntry } from "@mdcms/shared";

function renderSettingsPage(input: {
  initialTab: string;
  basePath?: string;
  capabilities?: Partial<AdminCapabilitiesValue>;
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ThemeProvider,
        null,
        createElement(
          StudioNavigationProvider,
          {
            value: {
              pathname: "/admin/settings",
              params: {},
              basePath: input.basePath ?? "/admin",
              push: () => {},
              replace: () => {},
              back: () => {},
            },
          },
          createElement(
            AdminCapabilitiesProvider,
            {
              value: {
                canReadSchema: true,
                canCreateContent: false,
                canPublishContent: false,
                canUnpublishContent: false,
                canDeleteContent: false,
                canManageUsers: false,
                canManageSettings: false,
                ...input.capabilities,
              },
            },
            createElement(
              StudioMountInfoProvider,
              {
                value: {
                  project: "test-project",
                  environment: "production",
                  apiBaseUrl: "https://api.example.com",
                  auth: { mode: "cookie" as const },
                  environments: [],
                  hostBridge: null,
                  setEnvironment: () => {},
                },
              },
              createElement(SettingsPage, {
                initialTab: input.initialTab,
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

test("SettingsPage renders the API keys tab header and create button", () => {
  const markup = renderSettingsPage({
    initialTab: "api-keys",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /Create API Key/);
  assert.match(markup, /Manage API keys for external integrations/);
  assert.match(markup, /data-mdcms-settings-subnav/);
});

test("SettingsPage does not render a Schema tab", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.doesNotMatch(markup, /Open schema browser/);
  assert.doesNotMatch(markup, /data-mdcms-settings-schema-state/);
});

test("SettingsPage shows access denied when canManageSettings is false", () => {
  const markup = renderSettingsPage({
    initialTab: "api-keys",
    capabilities: { canManageSettings: false },
  });
  assert.match(markup, /Access denied/);
  assert.doesNotMatch(markup, /Create API Key/);
});

test("SettingsPage renders content when canManageSettings is true", () => {
  const markup = renderSettingsPage({
    initialTab: "api-keys",
    capabilities: { canManageSettings: true },
  });
  assert.match(markup, /Create API Key/);
  assert.doesNotMatch(markup, /Access denied/);
});

test("SettingsPage renders Webhooks tab and still omits Media tab", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.match(markup, /Webhooks/);
  assert.doesNotMatch(markup, /Media/);
});

test("SettingsPage General tab shows read-only project context", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.match(markup, /read-only/i);
  assert.match(markup, /Schema hash/);
  assert.match(markup, /Last schema sync/);
  assert.match(markup, /mdcms schema sync/);
  assert.doesNotMatch(markup, /Save changes/);
});

const readySchemaSummary: SettingsPageSchemaSummaryState = {
  status: "ready",
  schemaHash: "server-hash",
  syncedAt: "2026-03-31T12:00:00.000Z",
};

const readyKey: ApiKeyMetadata = {
  id: "key-1",
  label: "CI deploy",
  keyPrefix: "mdcms_key_abc123",
  scopes: ["content:read", "content:publish", "schema:read"],
  contextAllowlist: [{ project: "test-project", environment: "production" }],
  createdByUserId: "user-1",
  createdAt: "2026-03-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
};

const readyWebhookHistoryEntry: WebhookDeliveryHistoryEntry = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e85990",
  webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "test-project",
  environment: "production",
  event: "content.published",
  eventId: "018f0c6d-98da-7f25-89fe-7c7ef5e85980",
  deliveryId: "018f0c6d-98da-7f25-89fe-7c7ef5e85981",
  url: "https://example.com/hooks/mdcms",
  attempt: 2,
  maxAttempts: 3,
  outcome: "failed",
  statusCode: 503,
  error: "Webhook delivery failed with status 503.",
  createdAt: "2026-06-03T00:00:00.000Z",
};

const readyWebhookHistoryState: SettingsPageWebhookHistoryState = {
  status: "ready",
  entries: [readyWebhookHistoryEntry],
  filters: {
    webhookId: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    event: "content.published",
    outcome: "failed",
    limit: 50,
  },
  errorMessage: undefined,
  setFilters: () => {},
};

const readyWebhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "test-project",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published", "media.uploaded"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-2",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

const readyWebhookConfigState: SettingsPageWebhookConfigState = {
  status: "ready",
  configs: [readyWebhookConfig],
  errorMessage: undefined,
  createWebhook: async () => readyWebhookConfig,
  updateWebhook: async () => readyWebhookConfig,
  deleteWebhook: async (id: string) => ({ deleted: true, id }),
  isCreating: false,
  createError: null,
  isUpdating: false,
  updateError: null,
  isDeleting: false,
  deleteError: null,
  clearDeleteError: () => {},
};

function renderSettingsPageView(input: {
  initialTab: string;
  apiKeysState?: Partial<SettingsPageApiKeysState>;
  webhookConfigState?: Partial<SettingsPageWebhookConfigState>;
  webhookHistoryState?: Partial<SettingsPageWebhookHistoryState>;
  schemaSummary?: SettingsPageSchemaSummaryState;
  canManageSettings?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(SettingsPageView, {
        activeTab: input.initialTab,
        setActiveTab: () => {},
        canManageSettings: input.canManageSettings ?? true,
        mountInfo: {
          project: "test-project",
          environment: "production",
          apiBaseUrl: "https://api.example.com",
        },
        schemaSummary: input.schemaSummary ?? readySchemaSummary,
        apiKeysState: {
          status: "ready",
          keys: [readyKey],
          isRevoking: false,
          revokeError: null,
          onRevoke: () => {},
          ...input.apiKeysState,
        },
        webhookConfigState: {
          ...readyWebhookConfigState,
          ...input.webhookConfigState,
        },
        webhookHistoryState: {
          ...readyWebhookHistoryState,
          ...input.webhookHistoryState,
        },
        createDialogOpen: false,
        setCreateDialogOpen: () => {},
        createKey: async () => ({
          ...readyKey,
          key: "mdcms_key_secret",
        }),
        isCreating: false,
        createError: null,
      }),
    ),
  );
}

test("SettingsPageView renders schema summary metadata from the existing schema contract", () => {
  const markup = renderSettingsPageView({ initialTab: "general" });

  assert.match(markup, /data-mdcms-settings-general-state="ready"/);
  assert.match(markup, /server-hash/);
  assert.match(markup, /2026-03-31T12:00:00.000Z/);
  assert.match(markup, /mdcms schema sync/);
});

test("SettingsPageView renders API key metadata and revoke affordance", () => {
  const markup = renderSettingsPageView({ initialTab: "api-keys" });

  assert.match(markup, /data-mdcms-settings-api-keys-state="ready"/);
  assert.match(markup, /CI deploy/);
  assert.match(markup, /mdcms_key_abc123/);
  assert.match(markup, /content:read/);
  assert.match(markup, /schema:read/);
  assert.match(markup, /test-project/);
  assert.match(markup, /production/);
  assert.match(markup, /Active/);
  assert.match(markup, /Revoke/);
});

test("SettingsPageView renders webhook configuration rows and CRUD affordances", () => {
  const markup = renderSettingsPageView({ initialTab: "webhooks" });

  assert.match(markup, /Webhook configurations/);
  assert.match(markup, /Create webhook/);
  assert.match(markup, /data-mdcms-settings-webhook-configs-state="ready"/);
  assert.match(markup, /https:\/\/example\.com\/hooks\/mdcms/);
  assert.match(markup, /content\.published/);
  assert.match(markup, /media\.uploaded/);
  assert.match(markup, /Active/);
  assert.match(
    markup,
    /aria-label="Edit webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
  assert.match(
    markup,
    /aria-label="Delete webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
});

test("SettingsPageView renders webhook configuration loading empty error and unavailable states", () => {
  const loadingMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "loading",
      configs: [],
    },
  });
  assert.match(
    loadingMarkup,
    /data-mdcms-settings-webhook-configs-state="loading"/,
  );

  const emptyMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "empty",
      configs: [],
    },
  });
  assert.match(emptyMarkup, /No webhook configurations yet/);

  const errorMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "error",
      configs: [],
      errorMessage: "Failed to load webhook configurations.",
    },
  });
  assert.match(errorMarkup, /Failed to load webhook configurations/);

  const unavailableMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "unavailable",
      configs: [],
      errorMessage: "Studio is missing project or environment context.",
    },
  });
  assert.match(
    unavailableMarkup,
    /Studio is missing project or environment context/,
  );
});

test("WebhookDeleteConfirmationDialog surfaces delete failures in the active confirmation context", () => {
  const markup = renderToStaticMarkup(
    createElement(WebhookDeleteConfirmationDialog, {
      config: readyWebhookConfig,
      error: new Error("Delete request failed."),
      isDeleting: false,
      onConfirm: async () => {},
      onOpenChange: () => {},
    }),
  );

  assert.match(markup, /Delete request failed/);
  assert.match(markup, /role="alert"/);
});

test("SettingsPageView renders webhook delivery history filters and status codes", () => {
  const markup = renderSettingsPageView({ initialTab: "webhooks" });

  assert.match(markup, /data-mdcms-settings-webhooks-state="ready"/);
  assert.match(markup, /Delivery history/);
  assert.match(markup, /018f0c6d-98da-7f25-89fe-7c7ef5e8597d/);
  assert.match(markup, /content\.published/);
  assert.match(markup, /Failed/);
  assert.match(markup, /503/);
  assert.match(markup, /Status code/);
  assert.match(markup, /Webhook id/);
  assert.match(markup, /Outcome/);
});

test("SettingsPageView renders webhook history loading empty and error states", () => {
  const loadingMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookHistoryState: {
      status: "loading",
      entries: [],
    },
  });
  assert.match(loadingMarkup, /data-mdcms-settings-webhooks-state="loading"/);

  const emptyMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookHistoryState: {
      status: "empty",
      entries: [],
    },
  });
  assert.match(emptyMarkup, /data-mdcms-settings-webhooks-state="empty"/);
  assert.match(emptyMarkup, /No webhook deliveries match these filters/);

  const errorMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookHistoryState: {
      status: "error",
      entries: [],
      errorMessage: "Failed to load webhook delivery history.",
    },
  });
  assert.match(errorMarkup, /data-mdcms-settings-webhooks-state="error"/);
  assert.match(errorMarkup, /Failed to load webhook delivery history/);
});

test("SettingsPageView keeps forbidden state capability-gated", () => {
  const markup = renderSettingsPageView({
    initialTab: "api-keys",
    canManageSettings: false,
  });

  assert.match(markup, /data-mdcms-settings-state="forbidden"/);
  assert.match(markup, /Access denied/);
  assert.doesNotMatch(markup, /Create API Key/);
  assert.doesNotMatch(markup, /Webhook configurations/);
  assert.doesNotMatch(markup, /Create webhook/);
  assert.doesNotMatch(markup, /Delivery history/);
});
