"use client";

import { useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Pencil,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import type { WebhookConfig, WebhookEvent } from "@mdcms/shared";

import { WebhookConfigDialog } from "../../components/webhook-config-dialog.js";
import { WebhookConfigForm } from "../../components/webhook-config-form.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import type { SettingsPageWebhookConfigState } from "../../hooks/use-webhook-config-list.js";
import { cn } from "../../lib/utils.js";
import { formatClientDate } from "./settings-webhooks-format.js";
import { WebhookDeleteConfirmationDialog } from "./webhook-delete-confirmation-dialog.js";
import { getWebhookEventDisplay } from "../../components/webhook-event-display.js";
import Link from "../../adapters/next-link.js";
import { useRouter } from "../../navigation.js";

function WebhookActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-sm border px-2 py-0.5 font-mono text-[11px]",
        active
          ? "border-success/20 bg-success/10 text-success"
          : "border-border bg-background-subtle text-foreground-muted",
      )}
    >
      {active ? "Active" : "Inactive"}
    </Badge>
  );
}

function WebhookEventList({ events }: { events: WebhookEvent[] }) {
  return (
    <div className="flex max-w-[24rem] flex-wrap gap-1">
      {events.map((event) => {
        const display = getWebhookEventDisplay(event);
        return (
          <Badge
            key={event}
            variant="outline"
            title={event}
            className="rounded-sm border-border bg-background-subtle text-[11px] font-medium"
          >
            {display.label}
          </Badge>
        );
      })}
    </div>
  );
}

function WebhookConfigLoadingState() {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="loading"
      className="rounded-lg border border-card-border bg-card p-5"
    >
      <div className="space-y-3">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}

function WebhookConfigEmptyState() {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="empty"
      className="rounded-lg border border-dashed border-border bg-card p-10 text-center"
    >
      <Webhook className="mx-auto size-8 text-foreground-muted" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        No webhook configurations yet
      </p>
      <p className="mt-1 text-sm text-foreground-muted">
        Create a webhook to notify external systems about content and media
        events.
      </p>
      <Button asChild className="mt-4" size="sm">
        <Link href="/settings/webhooks/new">
          <Plus className="size-4" />
          Create webhook
        </Link>
      </Button>
    </div>
  );
}

function WebhookConfigErrorState({
  status,
  message,
}: {
  status: "error" | "unavailable";
  message: string;
}) {
  return (
    <div
      data-mdcms-settings-webhook-configs-state={status}
      className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function WebhookConfigReadyState({
  configs,
  isMutating,
  onEdit,
  onDelete,
}: {
  configs: WebhookConfig[];
  isMutating: boolean;
  onEdit: (config: WebhookConfig) => void;
  onDelete: (config: WebhookConfig) => void;
}) {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="ready"
      className="overflow-hidden rounded-lg border border-card-border bg-card"
    >
      <Table>
        <TableHeader>
          <TableRow className="bg-background-subtle hover:bg-background-subtle">
            <TableHead>URL</TableHead>
            <TableHead>Events</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-28"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {configs.map((config) => (
            <TableRow key={config.id} className="hover:bg-background-subtle/60">
              <TableCell className="min-w-[18rem] break-all font-mono text-[12px]">
                {config.url}
                <div className="mt-1 text-[11px] text-foreground-muted">
                  {config.id}
                </div>
              </TableCell>
              <TableCell className="min-w-[16rem] whitespace-normal">
                <WebhookEventList events={config.events} />
              </TableCell>
              <TableCell>
                <WebhookActiveBadge active={config.active} />
              </TableCell>
              <TableCell className="min-w-[11rem] text-sm text-foreground-muted">
                <div suppressHydrationWarning>
                  {formatClientDate(config.updatedAt)}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit webhook ${config.id}`}
                    disabled={isMutating}
                    onClick={() => onEdit(config)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete webhook ${config.id}`}
                    className="text-destructive hover:text-destructive"
                    disabled={isMutating}
                    onClick={() => onDelete(config)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function WebhookConfigStateView({
  state,
  isMutating,
  onEdit,
  onDelete,
}: {
  state: SettingsPageWebhookConfigState;
  isMutating: boolean;
  onEdit: (config: WebhookConfig) => void;
  onDelete: (config: WebhookConfig) => void;
}) {
  if (state.status === "loading") return <WebhookConfigLoadingState />;
  if (state.status === "error") {
    return (
      <WebhookConfigErrorState
        status="error"
        message={state.errorMessage ?? "Failed to load webhook configurations."}
      />
    );
  }
  if (state.status === "unavailable") {
    return (
      <WebhookConfigErrorState
        status="unavailable"
        message={
          state.errorMessage ??
          "Studio is missing project or environment context."
        }
      />
    );
  }
  if (state.status === "empty") {
    return <WebhookConfigEmptyState />;
  }

  return (
    <WebhookConfigReadyState
      configs={state.configs}
      isMutating={isMutating}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

export function WebhookConfigurationsSection({
  state,
}: {
  state: SettingsPageWebhookConfigState;
}) {
  const [editingConfig, setEditingConfig] = useState<WebhookConfig | null>(
    null,
  );
  const [deletingConfig, setDeletingConfig] = useState<WebhookConfig | null>(
    null,
  );
  const isMutating = state.isUpdating || state.isDeleting;
  const openDeleteDialog = (config: WebhookConfig) => {
    state.clearDeleteError();
    setDeletingConfig(config);
  };

  const confirmDelete = async (id: string) => {
    try {
      await state.deleteWebhook(id);
      state.clearDeleteError();
      setDeletingConfig(null);
    } catch {
      // Error is surfaced through deleteError.
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Webhook className="size-4 text-primary" />
          Webhook configurations
        </div>
        <Button asChild className="sm:self-start">
          <Link href="/settings/webhooks/new">
            <Plus className="size-4" />
            Create webhook
          </Link>
        </Button>
      </div>

      <WebhookConfigStateView
        state={state}
        isMutating={isMutating}
        onEdit={setEditingConfig}
        onDelete={openDeleteDialog}
      />

      <WebhookConfigDialog
        mode="edit"
        open={editingConfig !== null}
        config={editingConfig}
        onOpenChange={(open) => {
          if (!open) setEditingConfig(null);
        }}
        onSubmit={async (input) => {
          if (!editingConfig) return;
          await state.updateWebhook(editingConfig.id, input);
        }}
        isSubmitting={state.isUpdating}
        error={state.updateError}
      />
      <WebhookDeleteConfirmationDialog
        config={deletingConfig}
        error={state.deleteError}
        isDeleting={state.isDeleting}
        onConfirm={confirmDelete}
        onOpenChange={(open) => {
          if (!open) {
            state.clearDeleteError();
            setDeletingConfig(null);
          }
        }}
      />
    </>
  );
}

export function WebhookCreateConfigurationPage({
  state,
}: {
  state: SettingsPageWebhookConfigState;
}) {
  const router = useRouter();
  const returnToWebhooks = () => router.push("/settings/webhooks");

  return (
    <section data-mdcms-settings-webhook-create-page className="space-y-5">
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/settings/webhooks">
            <ArrowLeft className="size-4" />
            Back to webhooks
          </Link>
        </Button>
        <div>
          <h2 className="font-heading text-[30px] font-semibold leading-tight text-foreground">
            Create webhook
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Add an HTTPS endpoint for selected MDCMS events.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-card-border bg-card p-5">
        <WebhookConfigForm
          mode="create"
          onSubmit={async (input) => {
            await state.createWebhook(input);
            returnToWebhooks();
          }}
          onCancel={returnToWebhooks}
          isSubmitting={state.isCreating}
          error={state.createError}
          formClassName="space-y-5"
          bodyClassName="space-y-5"
          footerClassName="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end"
          dataScope="page"
        />
      </div>
    </section>
  );
}
