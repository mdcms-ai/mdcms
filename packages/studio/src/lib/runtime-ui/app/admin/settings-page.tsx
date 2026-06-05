"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Fingerprint,
  Key,
  Plus,
  Server,
  Settings,
  ShieldOff,
  TerminalSquare,
} from "lucide-react";

import type { SchemaRegistryListResponse } from "@mdcms/shared";

import {
  type ApiKeyCreateInput,
  type ApiKeyCreateResult,
  type ApiKeyMetadata,
} from "../../../api-keys-api.js";
import { createStudioSchemaRouteApi } from "../../../schema-route-api.js";
import { useApiKeyList } from "../../hooks/use-api-key-list.js";
import {
  useWebhookConfigList,
  type SettingsPageWebhookConfigState,
} from "../../hooks/use-webhook-config-list.js";
import {
  useWebhookDeliveryHistory,
  type SettingsPageWebhookHistoryState,
} from "../../hooks/use-webhook-delivery-history.js";
import { ApiKeyCreateDialog } from "../../components/api-key-create-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { useCanManageSettings } from "./capabilities-context.js";
import { PageHeader } from "../../components/layout/page-header.js";
import {
  useStudioMountInfo,
  type StudioMountInfo,
} from "./mount-info-context.js";
import { WebhookCreateConfigurationPage } from "./settings-webhook-configurations.js";
import { SettingsWebhooksPanel } from "./settings-webhooks-panel.js";
import { cn } from "../../lib/utils.js";
import Link from "../../adapters/next-link.js";
import { useParams } from "../../navigation.js";

export type { SettingsPageWebhookHistoryState } from "../../hooks/use-webhook-delivery-history.js";
export type { SettingsPageWebhookConfigState } from "../../hooks/use-webhook-config-list.js";

const settingsTabs = [
  { id: "general", label: "General", icon: Settings, href: "/settings" },
  {
    id: "api-keys",
    label: "API keys",
    icon: Key,
    href: "/settings/api-keys",
  },
  {
    id: "webhooks",
    label: "Webhooks",
    icon: Activity,
    href: "/settings/webhooks",
  },
] as const;

type SettingsTabId = (typeof settingsTabs)[number]["id"];
type SettingsSectionId = "new" | null;

function toSettingsTabId(value: string | undefined): SettingsTabId {
  if (value === "api-keys" || value === "webhooks") {
    return value;
  }

  return "general";
}

function toSettingsSectionId(input: {
  tab: SettingsTabId;
  section: string | undefined;
}): SettingsSectionId {
  if (input.tab === "webhooks" && input.section === "new") {
    return "new";
  }

  return null;
}

export type SettingsPageSchemaSummaryState =
  | { status: "loading" }
  | { status: "ready"; schemaHash: string | null; syncedAt: string | null }
  | { status: "error"; message: string }
  | { status: "unavailable"; message: string };

export type SettingsPageApiKeysState = {
  status: "loading" | "ready" | "empty" | "error";
  keys: ApiKeyMetadata[];
  errorMessage?: string;
  isRevoking: boolean;
  revokeError: Error | null;
  onRevoke: (keyId: string) => void;
};

type SettingsPageMountContext = Pick<
  StudioMountInfo,
  "project" | "environment" | "apiBaseUrl"
>;

function formatClientDate(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString();
}

function resolveApiKeyStatus(input: {
  expiresAt: string | null;
  revokedAt: string | null;
  now: number;
}): "Active" | "Expired" | "Revoked" {
  if (input.revokedAt !== null) return "Revoked";
  if (
    input.expiresAt !== null &&
    new Date(input.expiresAt).getTime() < input.now
  ) {
    return "Expired";
  }
  return "Active";
}

function ApiKeyStatusBadge({
  expiresAt,
  revokedAt,
}: {
  expiresAt: string | null;
  revokedAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const label = resolveApiKeyStatus({ expiresAt, revokedAt, now });
  const isActive = label === "Active";
  return (
    <Badge
      variant="outline"
      suppressHydrationWarning
      className={cn(
        "rounded-sm border px-2 py-0.5 font-mono text-[11px]",
        isActive
          ? "border-success/20 bg-success/10 text-success"
          : "border-destructive/20 bg-destructive/10 text-destructive",
      )}
    >
      {label}
    </Badge>
  );
}

function getConsistentEntryValue(
  entries: SchemaRegistryListResponse["types"],
  field: "schemaHash" | "syncedAt",
): string | null {
  const first = entries[0]?.[field]?.trim();
  if (!first) return null;
  return entries.every((entry) => entry[field] === first) ? first : null;
}

function resolveSettingsSchemaSummary(
  response: SchemaRegistryListResponse,
): Extract<SettingsPageSchemaSummaryState, { status: "ready" }> {
  return {
    status: "ready",
    schemaHash:
      response.schemaHash ??
      getConsistentEntryValue(response.types, "schemaHash"),
    syncedAt:
      response.syncedAt ?? getConsistentEntryValue(response.types, "syncedAt"),
  };
}

function useSettingsSchemaSummary(): SettingsPageSchemaSummaryState {
  const mountInfo = useStudioMountInfo();
  const project = mountInfo.project;
  const environment = mountInfo.environment;
  const serverUrl = mountInfo.apiBaseUrl;
  const auth = mountInfo.auth;
  const canLoad = Boolean(project && environment && serverUrl);

  const schemaQuery = useQuery({
    queryKey: [
      "settings-schema-summary",
      project,
      environment,
      serverUrl,
      auth.mode,
      auth.mode === "token" ? auth.token : null,
    ],
    enabled: canLoad,
    queryFn: async () => {
      const api = createStudioSchemaRouteApi(
        {
          project: project!,
          environment: environment!,
          serverUrl,
        },
        { auth },
      );
      return api.list();
    },
  });

  if (!canLoad) {
    return {
      status: "unavailable",
      message: "Studio is missing project or environment context.",
    };
  }

  if (schemaQuery.isLoading) {
    return { status: "loading" };
  }

  if (schemaQuery.error) {
    return {
      status: "error",
      message:
        schemaQuery.error instanceof Error
          ? schemaQuery.error.message
          : "Failed to load schema metadata.",
    };
  }

  if (!schemaQuery.data) {
    return { status: "loading" };
  }

  return resolveSettingsSchemaSummary(schemaQuery.data);
}

function SettingsMetaRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string | null | undefined;
  valueClassName?: string;
}) {
  return (
    <div className="grid gap-1 border-b border-divider/60 py-3 last:border-b-0 sm:grid-cols-[160px_1fr] sm:items-start">
      <dt className="font-mono text-[11px] uppercase text-foreground-muted">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 break-words font-mono text-[12px] text-foreground",
          valueClassName,
        )}
      >
        {value && value.trim().length > 0 ? value : "-"}
      </dd>
    </div>
  );
}

function SettingsNotice({
  tone,
  title,
  children,
}: {
  tone: "neutral" | "error";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3",
        tone === "error"
          ? "border-destructive/25 bg-destructive/10 text-destructive"
          : "border-card-border bg-background-subtle text-foreground",
      )}
    >
      <div className="flex items-start gap-3">
        {tone === "error" ? (
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
        ) : (
          <TerminalSquare className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold">{title}</p>
          <div className="text-sm text-foreground-muted">{children}</div>
        </div>
      </div>
    </div>
  );
}

function SettingsSubnav({ activeTab }: { activeTab: string }) {
  return (
    <aside
      data-mdcms-settings-subnav
      className="h-fit rounded-lg border border-card-border bg-card p-1 lg:sticky lg:top-20"
    >
      <nav className="flex gap-1 lg:flex-col">
        {settingsTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              data-active={isActive ? "true" : "false"}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors lg:flex-none",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground-muted hover:bg-background-subtle hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function SettingsForbiddenState() {
  return (
    <div data-mdcms-settings-state="forbidden" className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Settings" }]} />
      <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="grid size-12 place-items-center rounded-lg border border-card-border bg-card">
          <ShieldOff className="size-6 text-foreground-muted" />
        </div>
        <h3 className="mt-4 font-heading text-[22px] font-semibold text-foreground">
          Access denied
        </h3>
        <p className="mt-2 max-w-md text-sm text-foreground-muted">
          You do not have permission to manage settings for this project and
          environment.
        </p>
      </div>
    </div>
  );
}

function GeneralSettingsPanel({
  mountInfo,
  schemaSummary,
}: {
  mountInfo: SettingsPageMountContext;
  schemaSummary: SettingsPageSchemaSummaryState;
}) {
  const schemaState = schemaSummary.status;
  const schemaHash =
    schemaSummary.status === "ready" ? schemaSummary.schemaHash : null;
  const syncedAt =
    schemaSummary.status === "ready" ? schemaSummary.syncedAt : null;

  return (
    <section
      data-mdcms-settings-general-state={schemaState}
      className="space-y-5"
    >
      <div>
        <h2 className="font-heading text-[30px] font-semibold leading-tight text-foreground">
          General
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
          Read-only session and project context for the active Studio target.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
        <div className="rounded-lg border border-card-border bg-card p-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Server className="size-4 text-primary" />
            Runtime context
          </div>
          <dl>
            <SettingsMetaRow label="Project" value={mountInfo.project} />
            <SettingsMetaRow
              label="Environment"
              value={mountInfo.environment}
            />
            <SettingsMetaRow
              label="Server URL"
              value={mountInfo.apiBaseUrl}
              valueClassName="break-all"
            />
            {schemaSummary.status === "loading" ? (
              <>
                <div className="grid gap-1 border-b border-divider/60 py-3 sm:grid-cols-[160px_1fr]">
                  <dt className="font-mono text-[11px] uppercase text-foreground-muted">
                    Schema hash
                  </dt>
                  <dd>
                    <Skeleton className="h-4 w-40" />
                  </dd>
                </div>
                <div className="grid gap-1 py-3 sm:grid-cols-[160px_1fr]">
                  <dt className="font-mono text-[11px] uppercase text-foreground-muted">
                    Last schema sync
                  </dt>
                  <dd>
                    <Skeleton className="h-4 w-52" />
                  </dd>
                </div>
              </>
            ) : (
              <>
                <SettingsMetaRow label="Schema hash" value={schemaHash} />
                <SettingsMetaRow label="Last schema sync" value={syncedAt} />
              </>
            )}
          </dl>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-card-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Fingerprint className="size-4 text-primary" />
              <p className="font-mono text-[11px] uppercase text-foreground-muted">
                Contract
              </p>
            </div>
            <p className="mt-3 text-sm text-foreground">
              Schema and project configuration are code-first. Studio does not
              author those definitions here.
            </p>
          </div>
          <SettingsNotice tone="neutral" title="CLI-owned schema sync">
            Update `mdcms.config.ts`, then run{" "}
            <code className="rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[12px] text-foreground">
              mdcms schema sync
            </code>{" "}
            from the host project.
          </SettingsNotice>
          {schemaSummary.status === "error" && (
            <SettingsNotice tone="error" title="Schema metadata unavailable">
              {schemaSummary.message}
            </SettingsNotice>
          )}
          {schemaSummary.status === "unavailable" && (
            <SettingsNotice tone="error" title="Target context unavailable">
              {schemaSummary.message}
            </SettingsNotice>
          )}
        </div>
      </div>
    </section>
  );
}

function ApiKeysLoadingState() {
  return (
    <div
      data-mdcms-settings-api-keys-state="loading"
      className="rounded-lg border border-card-border bg-card p-5"
    >
      <div className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}

function ApiKeysEmptyState() {
  return (
    <div
      data-mdcms-settings-api-keys-state="empty"
      className="rounded-lg border border-dashed border-border bg-card p-10 text-center"
    >
      <Key className="mx-auto size-8 text-foreground-muted" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        No API keys yet
      </p>
      <p className="mt-1 text-sm text-foreground-muted">
        Create a scoped API key for CI, preview builds, or automation.
      </p>
    </div>
  );
}

function ApiKeysErrorState({ message }: { message: string }) {
  return (
    <div
      data-mdcms-settings-api-keys-state="error"
      className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function ApiKeyScopeList({ scopes }: { scopes: ApiKeyMetadata["scopes"] }) {
  return (
    <div className="flex max-w-[24rem] flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge
          key={scope}
          variant="default"
          className="rounded-sm bg-code-bg font-mono text-[10px] text-foreground"
        >
          {scope}
        </Badge>
      ))}
    </div>
  );
}

function ApiKeyContextList({
  contexts,
}: {
  contexts: ApiKeyMetadata["contextAllowlist"];
}) {
  if (contexts.length === 0) {
    return (
      <span className="font-mono text-[11px] text-foreground-muted">
        no allowlist
      </span>
    );
  }

  return (
    <div className="flex max-w-[18rem] flex-wrap gap-1">
      {contexts.map((ctx) => (
        <Badge
          key={`${ctx.project}/${ctx.environment}`}
          variant="outline"
          className="rounded-sm font-mono text-[10px]"
        >
          {ctx.project} / {ctx.environment}
        </Badge>
      ))}
    </div>
  );
}

function ApiKeysReadyState({ state }: { state: SettingsPageApiKeysState }) {
  return (
    <div
      data-mdcms-settings-api-keys-state="ready"
      className="overflow-hidden rounded-lg border border-card-border bg-card"
    >
      <Table>
        <TableHeader>
          <TableRow className="bg-background-subtle hover:bg-background-subtle">
            <TableHead>Label</TableHead>
            <TableHead>Key prefix</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Context allowlist</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.keys.map((key) => (
            <TableRow key={key.id} className="hover:bg-background-subtle/60">
              <TableCell className="min-w-[12rem] font-medium">
                <div className="text-foreground">{key.label}</div>
                <div className="font-mono text-[11px] text-foreground-muted">
                  {key.createdByUserId}
                </div>
              </TableCell>
              <TableCell className="min-w-[12rem] break-all font-mono text-[12px]">
                {key.keyPrefix}
              </TableCell>
              <TableCell className="min-w-[16rem] whitespace-normal">
                <ApiKeyScopeList scopes={key.scopes} />
              </TableCell>
              <TableCell className="min-w-[14rem] whitespace-normal">
                <ApiKeyContextList contexts={key.contextAllowlist} />
              </TableCell>
              <TableCell className="text-sm text-foreground-muted">
                <div suppressHydrationWarning>
                  {formatClientDate(key.createdAt)}
                </div>
              </TableCell>
              <TableCell
                className="text-sm text-foreground-muted"
                suppressHydrationWarning
              >
                {key.expiresAt ? formatClientDate(key.expiresAt) : "Never"}
              </TableCell>
              <TableCell>
                <ApiKeyStatusBadge
                  expiresAt={key.expiresAt}
                  revokedAt={key.revokedAt}
                />
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => state.onRevoke(key.id)}
                  disabled={state.isRevoking || key.revokedAt !== null}
                >
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ApiKeysPanel({
  apiKeysState,
  setCreateDialogOpen,
}: {
  apiKeysState: SettingsPageApiKeysState;
  setCreateDialogOpen: (open: boolean) => void;
}) {
  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-heading text-[30px] font-semibold leading-tight text-foreground">
            API keys
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Manage API keys for external integrations.
          </p>
        </div>
        <Button
          onClick={() => setCreateDialogOpen(true)}
          className="sm:self-start"
        >
          <Plus className="size-4" />
          Create API Key
        </Button>
      </div>

      {apiKeysState.revokeError && (
        <SettingsNotice tone="error" title="Revoke failed">
          {apiKeysState.revokeError.message || "Failed to revoke API key."}
        </SettingsNotice>
      )}

      {apiKeysState.status === "loading" && <ApiKeysLoadingState />}
      {apiKeysState.status === "error" && (
        <ApiKeysErrorState
          message={apiKeysState.errorMessage ?? "Failed to load API keys."}
        />
      )}
      {apiKeysState.status === "empty" && <ApiKeysEmptyState />}
      {apiKeysState.status === "ready" && (
        <ApiKeysReadyState state={apiKeysState} />
      )}
    </section>
  );
}

export function SettingsPageView({
  activeTab,
  activeSection,
  canManageSettings,
  mountInfo,
  schemaSummary,
  apiKeysState,
  webhookConfigState,
  webhookHistoryState,
  createDialogOpen,
  setCreateDialogOpen,
  createKey,
  isCreating,
  createError,
}: {
  activeTab: string;
  activeSection: SettingsSectionId;
  canManageSettings: boolean;
  mountInfo: SettingsPageMountContext;
  schemaSummary: SettingsPageSchemaSummaryState;
  apiKeysState: SettingsPageApiKeysState;
  webhookConfigState: SettingsPageWebhookConfigState;
  webhookHistoryState: SettingsPageWebhookHistoryState;
  createDialogOpen: boolean;
  setCreateDialogOpen: (open: boolean) => void;
  createKey: (input: ApiKeyCreateInput) => Promise<ApiKeyCreateResult>;
  isCreating: boolean;
  createError: Error | null;
}) {
  if (!canManageSettings) {
    return <SettingsForbiddenState />;
  }

  return (
    <div
      data-mdcms-settings-state="ready"
      className="min-h-screen bg-background"
    >
      <PageHeader breadcrumbs={[{ label: "Settings" }]} />

      <div className="space-y-6 p-6 lg:p-8">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase text-foreground-muted">
            Studio control plane
          </p>
          <h1 className="font-heading text-[38px] font-semibold leading-[1.05] text-foreground">
            Settings
          </h1>
          <p className="max-w-2xl text-sm text-foreground-muted">
            Read live context and manage scoped API access without changing
            code-owned schema or project definitions.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <SettingsSubnav activeTab={activeTab} />
          <main className="min-w-0">
            {activeTab === "api-keys" ? (
              <ApiKeysPanel
                apiKeysState={apiKeysState}
                setCreateDialogOpen={setCreateDialogOpen}
              />
            ) : activeTab === "webhooks" ? (
              activeSection === "new" ? (
                <WebhookCreateConfigurationPage state={webhookConfigState} />
              ) : (
                <SettingsWebhooksPanel
                  webhookConfigState={webhookConfigState}
                  webhookHistoryState={webhookHistoryState}
                />
              )
            ) : (
              <GeneralSettingsPanel
                mountInfo={mountInfo}
                schemaSummary={schemaSummary}
              />
            )}
          </main>
        </div>
      </div>

      <ApiKeyCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={createKey}
        isSubmitting={isCreating}
        error={createError}
      />
    </div>
  );
}

export default function SettingsPage({ initialTab }: { initialTab?: string }) {
  const params = useParams<{ tab?: string; section?: string }>();
  const activeTab = toSettingsTabId(initialTab ?? params.tab);
  const activeSection = toSettingsSectionId({
    tab: activeTab,
    section: params.section,
  });
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const canManageSettings = useCanManageSettings();
  const mountInfo = useStudioMountInfo();
  const schemaSummary = useSettingsSchemaSummary();
  const {
    status: apiKeysStatus,
    keys: apiKeys,
    errorMessage: apiKeysErrorMessage,
    createKey,
    isCreating,
    createError,
    revokeKey,
    isRevoking,
    revokeError,
  } = useApiKeyList();
  const webhookConfigState = useWebhookConfigList({
    enabled: canManageSettings,
  });
  const webhookHistoryState = useWebhookDeliveryHistory({
    enabled: canManageSettings,
  });

  const apiKeysState = useMemo<SettingsPageApiKeysState>(
    () => ({
      status: apiKeysStatus,
      keys: apiKeys,
      errorMessage: apiKeysErrorMessage,
      isRevoking,
      revokeError,
      onRevoke: (keyId: string) => {
        revokeKey(keyId).catch(() => {
          // Error is surfaced through revokeError in the hook state.
        });
      },
    }),
    [
      apiKeys,
      apiKeysErrorMessage,
      apiKeysStatus,
      isRevoking,
      revokeError,
      revokeKey,
    ],
  );

  return (
    <SettingsPageView
      activeTab={activeTab}
      activeSection={activeSection}
      canManageSettings={canManageSettings}
      mountInfo={{
        project: mountInfo.project,
        environment: mountInfo.environment,
        apiBaseUrl: mountInfo.apiBaseUrl,
      }}
      schemaSummary={schemaSummary}
      apiKeysState={apiKeysState}
      webhookConfigState={webhookConfigState}
      webhookHistoryState={webhookHistoryState}
      createDialogOpen={createDialogOpen}
      setCreateDialogOpen={setCreateDialogOpen}
      createKey={createKey}
      isCreating={isCreating}
      createError={createError}
    />
  );
}
