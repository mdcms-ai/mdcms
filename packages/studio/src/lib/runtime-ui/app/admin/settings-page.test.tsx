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
import {
  SettingsPageView,
  type SettingsPageApiKeysState,
  type SettingsPageSchemaSummaryState,
} from "./settings-page.js";
import type { ApiKeyMetadata } from "../../../api-keys-api.js";

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

test("SettingsPage does not render Webhooks or Media tabs", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.doesNotMatch(markup, /Webhooks/);
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

function renderSettingsPageView(input: {
  initialTab: string;
  apiKeysState?: Partial<SettingsPageApiKeysState>;
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

test("SettingsPageView keeps forbidden state capability-gated", () => {
  const markup = renderSettingsPageView({
    initialTab: "api-keys",
    canManageSettings: false,
  });

  assert.match(markup, /data-mdcms-settings-state="forbidden"/);
  assert.match(markup, /Access denied/);
  assert.doesNotMatch(markup, /Create API Key/);
});
