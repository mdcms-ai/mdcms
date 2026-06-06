import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  MediaSettings,
  WebhookConfig,
  WebhookDeliveryHistoryEntry,
} from "@mdcms/shared";

import { ThemeProvider } from "../../adapters/next-themes.js";
import { StudioNavigationProvider } from "../../navigation.js";
import type { SettingsPageMediaSettingsState } from "../../hooks/use-media-settings.js";
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
import type { MediaSettingsDraft } from "./settings-media-model.js";
import type { ApiKeyMetadata } from "../../../api-keys-api.js";

function renderSettingsPage(input: {
  initialTab?: string;
  routeTab?: string;
  routeSection?: string;
  basePath?: string;
  capabilities?: Partial<AdminCapabilitiesValue>;
}): string {
  const pathname =
    input.routeTab === "webhooks" && input.routeSection
      ? `/admin/settings/webhooks/${input.routeSection}`
      : input.routeTab === "webhooks"
        ? "/admin/settings/webhooks"
        : input.routeTab === "media"
          ? "/admin/settings/media"
          : input.routeTab === "api-keys"
            ? "/admin/settings/api-keys"
            : "/admin/settings";
  const settingsPageProps =
    input.initialTab === undefined ? {} : { initialTab: input.initialTab };

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
              pathname,
              params: {
                ...(input.routeTab ? { tab: input.routeTab } : {}),
                ...(input.routeSection ? { section: input.routeSection } : {}),
              },
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
              createElement(SettingsPage, settingsPageProps),
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

test("SettingsPage renders Media tab in Settings navigation", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.match(markup, /Webhooks/);
  assert.match(markup, /Media/);
});

test("SettingsPage subnav links to addressable settings sections", () => {
  const markup = renderSettingsPage({
    initialTab: "webhooks",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /href="\/admin\/settings"/);
  assert.match(markup, /href="\/admin\/settings\/api-keys"/);
  assert.match(markup, /href="\/admin\/settings\/webhooks"/);
  assert.match(markup, /href="\/admin\/settings\/media"/);
});

test("SettingsPage selects the Webhooks section from the route", () => {
  const markup = renderSettingsPage({
    routeTab: "webhooks",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /data-mdcms-settings-webhooks-state="loading"/);
  assert.match(
    markup,
    /data-active="true"[^>]*href="\/admin\/settings\/webhooks"/,
  );
});

test("SettingsPage selects the Media section from the route", () => {
  const markup = renderSettingsPage({
    routeTab: "media",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /data-mdcms-settings-media-state="loading"/);
  assert.match(
    markup,
    /data-active="true"[^>]*href="\/admin\/settings\/media"/,
  );
});

test("SettingsPage uses the webhooks create route as an addressable page", () => {
  const markup = renderSettingsPage({
    routeTab: "webhooks",
    routeSection: "new",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /data-mdcms-settings-webhook-create-page/);
  assert.match(markup, /Create webhook/);
  assert.match(markup, /value="whsec_[0-9a-f]{64}"/);
  assert.doesNotMatch(markup, /data-mdcms-webhook-dialog-content/);
});

test("SettingsPage uses webhook ids as addressable edit pages", () => {
  const markup = renderSettingsPage({
    routeTab: "webhooks",
    routeSection: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /data-mdcms-settings-webhook-edit-page/);
  assert.match(markup, /Edit webhook/);
  assert.doesNotMatch(markup, /data-mdcms-webhook-dialog-content/);
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

const readyMediaSettings: MediaSettings = {
  media: { image: { maxUploadSizeBytes: 10_485_760 } },
};

const readyMediaSettingsState: SettingsPageMediaSettingsState = {
  status: "ready",
  settings: readyMediaSettings,
  errorMessage: undefined,
  refetch: () => {},
  updateSettings: async () => readyMediaSettings,
  isUpdating: false,
  updateError: null,
  resetUpdateError: () => {},
};

function renderSettingsPageView(input: {
  initialTab: string;
  activeSection?: string | null;
  apiKeysState?: Partial<SettingsPageApiKeysState>;
  webhookConfigState?: Partial<SettingsPageWebhookConfigState>;
  webhookHistoryState?: Partial<SettingsPageWebhookHistoryState>;
  mediaSettingsState?: Partial<SettingsPageMediaSettingsState>;
  mediaDraftOverride?: MediaSettingsDraft;
  schemaSummary?: SettingsPageSchemaSummaryState;
  canManageSettings?: boolean;
}): string {
  const pathname =
    input.initialTab === "webhooks" && input.activeSection
      ? `/admin/settings/webhooks/${input.activeSection}`
      : input.initialTab === "webhooks"
        ? "/admin/settings/webhooks"
        : input.initialTab === "api-keys"
          ? "/admin/settings/api-keys"
          : "/admin/settings";

  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(
        StudioNavigationProvider,
        {
          value: {
            pathname,
            params: {},
            basePath: "/admin",
            push: () => {},
            replace: () => {},
            back: () => {},
          },
        },
        createElement(SettingsPageView, {
          activeTab: input.initialTab,
          activeSection: input.activeSection ?? null,
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
          mediaSettingsState: {
            ...readyMediaSettingsState,
            ...input.mediaSettingsState,
          },
          mediaInitialDraft: input.mediaDraftOverride,
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

test("SettingsPageView renders media settings ready state with backend semantics", () => {
  const markup = renderSettingsPageView({ initialTab: "media" });

  assert.match(markup, /data-mdcms-settings-media-state="ready"/);
  assert.match(markup, /Image upload limit/);
  assert.match(markup, /No file-type allowlist/);
  assert.match(markup, /image\//);
  assert.match(markup, /10,485,760 bytes/);
  assert.match(markup, /Save changes/);
  assert.match(markup, /role="status"/);
});

test("SettingsPageView renders media settings loading error and unavailable states", () => {
  const loadingMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: { status: "loading", settings: null },
  });
  assert.match(loadingMarkup, /data-mdcms-settings-media-state="loading"/);

  const errorMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      status: "error",
      settings: null,
      errorMessage: "Failed to load media settings.",
    },
  });
  assert.match(errorMarkup, /Failed to load media settings/);
  assert.match(errorMarkup, /Retry/);
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, /aria-live="assertive"/);

  const unavailableMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      status: "unavailable",
      settings: null,
      errorMessage: "Studio is missing project or environment context.",
    },
  });
  assert.match(
    unavailableMarkup,
    /Studio is missing project or environment context/,
  );
  assert.match(unavailableMarkup, /role="alert"/);
  assert.match(unavailableMarkup, /aria-live="assertive"/);
});

test("SettingsPageView surfaces invalid and failed media settings saves inline", () => {
  const invalidMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaDraftOverride: { mode: "explicit", explicitBytes: "0" },
  });
  assert.match(invalidMarkup, /Enter a positive whole number of bytes/);
  assert.match(invalidMarkup, /aria-invalid="true"/);

  const failedMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      ...readyMediaSettingsState,
      updateError: new Error("Save failed."),
    },
  });
  assert.match(failedMarkup, /Save failed\./);
  assert.match(failedMarkup, /role="alert"/);
});

test("SettingsPageView renders webhook configuration rows and CRUD affordances", () => {
  const markup = renderSettingsPageView({ initialTab: "webhooks" });

  assert.match(markup, /Webhook configurations/);
  assert.match(markup, /Create webhook/);
  assert.match(markup, /href="\/admin\/settings\/webhooks\/new"/);
  assert.match(markup, /data-mdcms-settings-webhook-configs-state="ready"/);
  assert.match(markup, /https:\/\/example\.com\/hooks\/mdcms/);
  assert.match(markup, /Published content/);
  assert.match(markup, /Media uploaded/);
  assert.match(markup, /Active/);
  assert.match(
    markup,
    /aria-label="Disable webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
  assert.match(markup, /aria-checked="true"/);
  assert.match(
    markup,
    /href="\/admin\/settings\/webhooks\/018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
  assert.match(
    markup,
    /aria-label="Edit webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
  assert.match(
    markup,
    /aria-label="Delete webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/,
  );
});

test("SettingsPageView surfaces webhook active toggle update failures", () => {
  const markup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      updateError: new Error("Webhook update failed."),
    },
  });

  assert.match(markup, /Webhook update failed\./);
  assert.match(markup, /role="alert"/);
});

test("SettingsPageView renders webhook creation as a settings subpage", () => {
  const markup = renderSettingsPageView({
    initialTab: "webhooks",
    activeSection: "new",
  });

  assert.match(markup, /data-mdcms-settings-webhook-create-page/);
  assert.match(markup, /Create webhook/);
  assert.match(markup, /Add an HTTPS endpoint for selected MDCMS events/);
  assert.match(markup, /href="\/admin\/settings\/webhooks"/);
  assert.match(markup, /value="whsec_[0-9a-f]{64}"/);
  assert.doesNotMatch(markup, /data-mdcms-webhook-dialog-content/);
  assert.doesNotMatch(markup, /Delivery history/);
});

test("SettingsPageView renders webhook editing as a settings subpage", () => {
  const markup = renderSettingsPageView({
    initialTab: "webhooks",
    activeSection: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  });

  assert.match(markup, /data-mdcms-settings-webhook-edit-page/);
  assert.match(markup, /Edit webhook/);
  assert.match(markup, /https:\/\/example\.com\/hooks\/mdcms/);
  assert.match(markup, /Rotate signing secret/);
  assert.match(markup, /href="\/admin\/settings\/webhooks"/);
  assert.doesNotMatch(markup, /data-mdcms-webhook-dialog-content/);
  assert.doesNotMatch(markup, /Delivery history/);
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
