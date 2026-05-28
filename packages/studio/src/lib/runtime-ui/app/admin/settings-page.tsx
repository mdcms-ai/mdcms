"use client";

import { useEffect, useState } from "react";
import { Settings, Key, Plus, ShieldOff } from "lucide-react";
import { useApiKeyList } from "../../hooks/use-api-key-list.js";
import { ApiKeyCreateDialog } from "../../components/api-key-create-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";
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
import { useStudioMountInfo } from "./mount-info-context.js";
import { cn } from "../../lib/utils.js";

const settingsTabs = [
  { id: "general", label: "General", icon: Settings },
  { id: "api-keys", label: "API Keys", icon: Key },
];

function formatClientDate(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleDateString();
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
    // Refresh once a minute so a key crossing its expiry while this page
    // is open flips from Active → Expired without a manual reload.
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const isExpired = expiresAt !== null && new Date(expiresAt).getTime() < now;
  const label =
    revokedAt !== null ? "Revoked" : isExpired ? "Expired" : "Active";
  const isActive = label === "Active";
  return (
    <Badge
      variant="outline"
      suppressHydrationWarning
      className={cn(
        "text-xs",
        isActive
          ? "bg-success/10 text-success border-success/20"
          : "bg-destructive/10 text-destructive border-destructive/20",
      )}
    >
      {label}
    </Badge>
  );
}

export default function SettingsPage({
  initialTab = "general",
}: {
  initialTab?: string;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const canManageSettings = useCanManageSettings();
  const mountInfo = useStudioMountInfo();
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

  if (!canManageSettings) {
    return (
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Settings" }]} />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldOff className="mb-4 size-8 text-foreground-muted" />
          <h3 className="mb-2 text-lg font-semibold">Access denied</h3>
          <p className="text-sm text-foreground-muted">
            You don&apos;t have permission to manage settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Settings" }]} />

      <div className="flex">
        {/* Settings Sidebar */}
        <aside className="w-56 shrink-0 border-r border-border bg-background p-4">
          <nav className="space-y-1">
            {settingsTabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  activeTab === tab.id
                    ? "bg-accent-subtle text-primary"
                    : "text-foreground-muted hover:bg-background-subtle hover:text-foreground",
                )}
              >
                <tab.icon className="size-4" />
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Settings Content */}
        <main className="flex-1 p-6">
          {/* General Settings */}
          {activeTab === "general" && (
            <div className="max-w-2xl space-y-6">
              <div>
                <h2 className="text-xl font-semibold">General</h2>
                <p className="text-sm text-foreground-muted">
                  Project configuration is managed through the CLI and
                  server-side settings. This view shows read-only context for
                  the current session.
                </p>
              </div>
              <div className="rounded-lg border border-border bg-background-subtle p-4 space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-foreground-muted">Project</span>
                  <span className="font-mono">
                    {mountInfo.project ?? "\u2014"}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-foreground-muted">Environment</span>
                  <span className="font-mono">
                    {mountInfo.environment ?? "\u2014"}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-foreground-muted">Server URL</span>
                  <span className="font-mono text-xs break-all">
                    {mountInfo.apiBaseUrl ?? "\u2014"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* API Keys */}
          {activeTab === "api-keys" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold">API Keys</h2>
                  <p className="text-sm text-foreground-muted">
                    Manage API keys for external integrations
                  </p>
                </div>
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="mr-2 size-4" />
                  Create API Key
                </Button>
              </div>

              {apiKeysStatus === "loading" && (
                <p className="text-sm text-foreground-muted">Loading…</p>
              )}

              {apiKeysStatus === "error" && (
                <p className="text-sm text-destructive">
                  {apiKeysErrorMessage ?? "Failed to load API keys."}
                </p>
              )}

              {revokeError && (
                <p className="text-sm text-destructive">
                  {revokeError.message ?? "Failed to revoke API key."}
                </p>
              )}

              {apiKeysStatus === "empty" && (
                <p className="text-sm text-foreground-muted">No API keys yet</p>
              )}

              {apiKeysStatus === "ready" && (
                <div className="rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Label</TableHead>
                        <TableHead>Key prefix</TableHead>
                        <TableHead>Scopes</TableHead>
                        <TableHead>Context</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-14"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {apiKeys.map((key) => (
                        <TableRow key={key.id}>
                          <TableCell className="font-medium">
                            {key.label}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {key.keyPrefix}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {key.scopes.slice(0, 2).map((scope) => (
                                <Badge
                                  key={scope}
                                  variant="default"
                                  className="text-xs"
                                >
                                  {scope}
                                </Badge>
                              ))}
                              {key.scopes.length > 2 && (
                                <Badge variant="default" className="text-xs">
                                  +{key.scopes.length - 2}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {key.contextAllowlist.map((ctx) => (
                                <Badge
                                  key={`${ctx.project}/${ctx.environment}`}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {ctx.environment}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-foreground-muted">
                            <div suppressHydrationWarning>
                              {formatClientDate(key.createdAt)}
                            </div>
                            <div className="text-xs">{key.createdByUserId}</div>
                          </TableCell>
                          <TableCell
                            className="text-sm text-foreground-muted"
                            suppressHydrationWarning
                          >
                            {key.expiresAt
                              ? formatClientDate(key.expiresAt)
                              : "Never"}
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
                              onClick={() => {
                                revokeKey(key.id).catch(() => {
                                  // Error is surfaced via revokeError from the hook
                                });
                              }}
                              disabled={isRevoking || key.revokedAt !== null}
                            >
                              Revoke
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <ApiKeyCreateDialog
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onSubmit={createKey}
                isSubmitting={isCreating}
                error={createError}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
