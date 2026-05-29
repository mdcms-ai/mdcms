"use client";

import { type ReactNode } from "react";

import type { StudioMountContext } from "@mdcms/shared";

import {
  createStudioContentOverviewLoadingState,
  loadStudioContentOverviewState,
  type StudioContentOverviewEntry,
  type StudioContentOverviewState,
} from "../../content-overview-state.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useStudioContentOverview } from "../hooks/use-content-overview.js";
import Link from "../adapters/next-link.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { resolveStudioHref } from "../navigation-paths.js";
import { useBasePath } from "../navigation.js";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderHeading,
} from "../components/layout/page-header.js";
import { Badge } from "../components/ui/badge.js";
import { cn } from "../lib/utils.js";

function findMetricValue(
  entry: StudioContentOverviewEntry,
  metricId: StudioContentOverviewEntry["metrics"][number]["id"],
): number | undefined {
  return entry.metrics.find((metric) => metric.id === metricId)?.value;
}

function ContentTypeCard({
  entry,
  basePath,
}: {
  entry: StudioContentOverviewEntry;
  basePath: string;
}): ReactNode {
  const totalCount = findMetricValue(entry, "documents") ?? 0;
  const publishedCount = findMetricValue(entry, "published") ?? 0;
  const draftCount = findMetricValue(entry, "withDrafts") ?? 0;
  const hasMetrics = entry.metrics.length > 0;
  // Clamp once so the "% published" text and the progress bar both stay in
  // [0, 100] even if upstream returns published > total or a negative
  // value.
  const rawPublishedPercentage =
    totalCount > 0 ? Math.round((publishedCount / totalCount) * 100) : 0;
  const publishedPercentage = Math.max(
    0,
    Math.min(100, rawPublishedPercentage),
  );
  const initial = (entry.type[0] ?? "?").toUpperCase();

  const card = (
    <div
      data-mdcms-content-card-type={entry.type}
      data-mdcms-content-card-disabled={entry.canNavigate ? "false" : "true"}
      className={cn(
        "flex h-full flex-col rounded-lg border border-card-border bg-card p-5 transition-colors",
        entry.canNavigate && "hover:border-primary/60",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-blue-100 font-heading text-base font-bold text-primary">
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[18px] font-semibold leading-[1.1] tracking-tight text-foreground">
            {entry.type}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-foreground-muted">
            /{entry.directory}
          </p>
        </div>
        {entry.localized ? (
          <span
            className="rounded-sm bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-primary"
            title={entry.locales?.join(", ") ?? "Localized"}
          >
            i18n
          </span>
        ) : null}
      </div>

      {hasMetrics ? (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-divider/60 pt-4">
            <CardStat
              label="Total"
              metricLabel="total"
              value={totalCount}
              metric="documents"
            />
            <CardStat
              label="Published"
              metricLabel="published"
              value={publishedCount}
              metric="published"
            />
            <CardStat
              label="Drafts"
              metricLabel="drafts"
              value={draftCount}
              metric="withDrafts"
            />
          </div>

          <div className="mt-4 h-1 overflow-hidden rounded-full bg-background-subtle">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${publishedPercentage}%` }}
            />
          </div>

          <div className="mt-2.5 flex items-center justify-between font-mono text-[11px] text-foreground-muted">
            <span>{publishedPercentage}% published</span>
            {entry.canNavigate ? (
              <span className="text-primary">browse →</span>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-4 border-t border-divider/60 pt-4 text-sm text-muted-foreground">
          Counts unavailable for your current permissions.
        </p>
      )}
    </div>
  );

  if (!entry.canNavigate) {
    return <div key={entry.type}>{card}</div>;
  }

  return (
    <Link
      key={entry.type}
      href={resolveStudioHref(basePath, `/content/${entry.type}`)}
    >
      {card}
    </Link>
  );
}

function CardStat({
  label,
  value,
  metric,
  metricLabel,
}: {
  label: string;
  value: number;
  metric: StudioContentOverviewEntry["metrics"][number]["id"];
  metricLabel: string;
}) {
  return (
    <div
      data-mdcms-content-metric={metric}
      data-mdcms-content-metric-summary={`${value} ${metricLabel}`}
      className="flex flex-col gap-0.5"
    >
      <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-foreground-muted">
        {label}
      </span>
      <span className="font-heading text-[22px] font-bold leading-none text-foreground">
        {value}
      </span>
    </div>
  );
}

function ContentCardGrid({
  entries,
  basePath,
}: {
  entries: StudioContentOverviewEntry[];
  basePath: string;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <ContentTypeCard key={entry.type} entry={entry} basePath={basePath} />
      ))}
    </div>
  );
}

function createContentPageMissingRouteState(): StudioContentOverviewState {
  return {
    status: "error",
    project: "unknown",
    environment: "unknown",
    message: "Content overview requires an active project and environment.",
  };
}

function summariseTotals(entries: StudioContentOverviewEntry[]): {
  totalDocuments: number;
  localizedTypes: number;
} {
  let totalDocuments = 0;
  let localizedTypes = 0;
  for (const entry of entries) {
    totalDocuments += findMetricValue(entry, "documents") ?? 0;
    if (entry.localized) localizedTypes += 1;
  }
  return { totalDocuments, localizedTypes };
}

export function ContentPageView({
  state,
}: {
  state: StudioContentOverviewState;
}) {
  const basePath = useBasePath();
  const summary =
    state.status === "ready" || state.status === "permission-constrained"
      ? summariseTotals(state.entries)
      : null;
  const typesCount =
    state.status === "ready" || state.status === "permission-constrained"
      ? state.entries.length
      : 0;

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Content" }]} />

      <div className="space-y-6 p-6 lg:p-8">
        <div>
          <PageHeaderHeading className="font-heading text-[36px] font-bold leading-[1.05] tracking-tight text-foreground">
            Content
          </PageHeaderHeading>
          <PageHeaderDescription className="mt-1.5 font-mono text-[12px] text-foreground-muted">
            {summary
              ? `${typesCount} content type${typesCount === 1 ? "" : "s"} · ${summary.totalDocuments} document${summary.totalDocuments === 1 ? "" : "s"}${
                  summary.localizedTypes > 0
                    ? ` · ${summary.localizedTypes} localized`
                    : ""
                }`
              : "Browse and manage your content by type"}
          </PageHeaderDescription>
        </div>

        {state.status === "loading" ? (
          <div
            data-mdcms-content-page-state="loading"
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-card-border bg-card p-5"
              >
                <div className="flex items-start gap-3">
                  <Skeleton className="size-9 rounded-md" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-28" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-divider/60 pt-4">
                  <Skeleton className="h-7 w-12" />
                  <Skeleton className="h-7 w-12" />
                  <Skeleton className="h-7 w-12" />
                </div>
                <Skeleton className="mt-4 h-1 w-full rounded-full" />
              </div>
            ))}
          </div>
        ) : state.status === "forbidden" ? (
          <section
            data-mdcms-content-page-state="forbidden"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="default">Forbidden</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : state.status === "error" ? (
          <section
            data-mdcms-content-page-state="error"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="destructive">Error</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : state.entries.length === 0 ? (
          <section
            data-mdcms-content-page-state="empty"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="outline">Empty</Badge>
            <p className="text-sm text-muted-foreground">
              No schema types were returned for this project and environment.
            </p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : state.status === "permission-constrained" ? (
          <div
            data-mdcms-content-page-state="permission-constrained"
            className="space-y-4"
          >
            <section className="space-y-2 rounded-lg border border-dashed p-4">
              <Badge variant="outline">Limited access</Badge>
              <p className="text-sm text-muted-foreground">{state.message}</p>
            </section>
            <ContentCardGrid entries={state.entries} basePath={basePath} />
          </div>
        ) : (
          <div data-mdcms-content-page-state="ready" className="space-y-4">
            <ContentCardGrid entries={state.entries} basePath={basePath} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function ContentPage({
  context,
  loadState = loadStudioContentOverviewState,
}: {
  context: StudioMountContext;
  loadState?: typeof loadStudioContentOverviewState;
}) {
  void context;
  const mountInfo = useStudioMountInfo();
  const query = useStudioContentOverview(loadState);

  const state: StudioContentOverviewState = query.data
    ? query.data
    : query.isError
      ? {
          status: "error",
          project: mountInfo.project ?? "unknown",
          environment: mountInfo.environment ?? "unknown",
          message:
            query.error instanceof Error &&
            query.error.message.trim().length > 0
              ? query.error.message
              : "Failed to load content overview.",
        }
      : query.fetchStatus === "idle" && !query.isFetched
        ? createContentPageMissingRouteState()
        : createStudioContentOverviewLoadingState();

  return <ContentPageView state={state} />;
}
