"use client";

import { Activity, AlertCircle } from "lucide-react";
import {
  WEBHOOK_DELIVERY_OUTCOMES,
  WEBHOOK_EVENTS,
  type WebhookDeliveryHistoryEntry,
  type WebhookDeliveryOutcome,
  type WebhookEvent,
} from "@mdcms/shared";

import { Badge } from "../../components/ui/badge.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import type {
  SettingsPageWebhookHistoryFilters,
  SettingsPageWebhookHistoryState,
} from "../../hooks/use-webhook-delivery-history.js";
import { cn } from "../../lib/utils.js";
import { formatClientDate } from "./settings-webhooks-format.js";

type WebhookHistoryFilterPatch = Partial<SettingsPageWebhookHistoryFilters>;

const outcomeLabels: Record<WebhookDeliveryOutcome, string> = {
  succeeded: "Succeeded",
  retrying: "Retrying",
  failed: "Failed",
  discarded: "Discarded",
};

function updateFilters(
  state: SettingsPageWebhookHistoryState,
  patch: WebhookHistoryFilterPatch,
): void {
  state.setFilters((filters) => ({
    ...filters,
    ...patch,
  }));
}

function WebhookOutcomeBadge({ outcome }: { outcome: WebhookDeliveryOutcome }) {
  const isSuccess = outcome === "succeeded";

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-sm border px-2 py-0.5 font-mono text-[11px]",
        isSuccess
          ? "border-success/20 bg-success/10 text-success"
          : "border-destructive/20 bg-destructive/10 text-destructive",
      )}
    >
      {outcomeLabels[outcome]}
    </Badge>
  );
}

function WebhookHistoryFilters({
  state,
}: {
  state: SettingsPageWebhookHistoryState;
}) {
  return (
    <div className="grid gap-3 rounded-lg border border-card-border bg-card p-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_140px]">
      <div className="space-y-1.5">
        <Label htmlFor="webhook-history-webhook-id">Webhook id</Label>
        <Input
          id="webhook-history-webhook-id"
          value={state.filters.webhookId}
          onChange={(event) =>
            updateFilters(state, { webhookId: event.currentTarget.value })
          }
          placeholder="All webhooks"
          className="font-mono text-[12px]"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Event</Label>
        <Select
          value={state.filters.event || "all"}
          onValueChange={(value) =>
            updateFilters(state, {
              event: value === "all" ? "" : (value as WebhookEvent),
            })
          }
        >
          <SelectTrigger className="h-9 rounded-sm border-border bg-background text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {WEBHOOK_EVENTS.map((event) => (
              <SelectItem key={event} value={event}>
                {event}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Outcome</Label>
        <Select
          value={state.filters.outcome || "all"}
          onValueChange={(value) =>
            updateFilters(state, {
              outcome: value === "all" ? "" : (value as WebhookDeliveryOutcome),
            })
          }
        >
          <SelectTrigger className="h-9 rounded-sm border-border bg-background text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All outcomes</SelectItem>
            {WEBHOOK_DELIVERY_OUTCOMES.map((outcome) => (
              <SelectItem key={outcome} value={outcome}>
                {outcomeLabels[outcome]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Limit</Label>
        <Select
          value={String(state.filters.limit)}
          onValueChange={(value) =>
            updateFilters(state, { limit: Number(value) })
          }
        >
          <SelectTrigger className="h-9 rounded-sm border-border bg-background text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 25, 50, 100].map((limit) => (
              <SelectItem key={limit} value={String(limit)}>
                {limit}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function WebhookHistoryLoadingState() {
  return (
    <div className="rounded-lg border border-card-border bg-card p-5">
      <div className="space-y-3">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}

function WebhookHistoryEmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
      <Activity className="mx-auto size-8 text-foreground-muted" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        No webhook deliveries match these filters
      </p>
      <p className="mt-1 text-sm text-foreground-muted">
        Delivery attempts appear here after matching content or media events
        fire.
      </p>
    </div>
  );
}

function WebhookHistoryErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function WebhookHistoryReadyState({
  entries,
}: {
  entries: WebhookDeliveryHistoryEntry[];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-background-subtle hover:bg-background-subtle">
            <TableHead>Webhook id</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Status code</TableHead>
            <TableHead>Attempt</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id} className="hover:bg-background-subtle/60">
              <TableCell className="min-w-[16rem] font-mono text-[12px]">
                {entry.webhookId}
                <div className="mt-1 break-all text-[11px] text-foreground-muted">
                  {entry.url}
                </div>
              </TableCell>
              <TableCell className="min-w-[11rem] font-mono text-[12px]">
                {entry.event}
              </TableCell>
              <TableCell>
                <WebhookOutcomeBadge outcome={entry.outcome} />
              </TableCell>
              <TableCell className="font-mono text-[12px]">
                {entry.statusCode ?? "-"}
              </TableCell>
              <TableCell className="font-mono text-[12px]">
                {entry.attempt} / {entry.maxAttempts}
              </TableCell>
              <TableCell className="min-w-[11rem] text-sm text-foreground-muted">
                <div suppressHydrationWarning>
                  {formatClientDate(entry.createdAt)}
                </div>
              </TableCell>
              <TableCell className="max-w-[22rem] whitespace-normal text-sm text-foreground-muted">
                {entry.error ?? "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function WebhookDeliveryHistorySection({
  state,
}: {
  state: SettingsPageWebhookHistoryState;
}) {
  return (
    <>
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Activity className="size-4 text-primary" />
        Delivery history
      </div>

      <WebhookHistoryFilters state={state} />

      {state.status === "loading" && <WebhookHistoryLoadingState />}
      {state.status === "error" && (
        <WebhookHistoryErrorState
          message={
            state.errorMessage ?? "Failed to load webhook delivery history."
          }
        />
      )}
      {state.status === "unavailable" && (
        <WebhookHistoryErrorState
          message={
            state.errorMessage ??
            "Studio is missing project or environment context."
          }
        />
      )}
      {state.status === "empty" && <WebhookHistoryEmptyState />}
      {state.status === "ready" && (
        <WebhookHistoryReadyState entries={state.entries} />
      )}
    </>
  );
}
