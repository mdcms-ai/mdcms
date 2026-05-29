"use client";

import Link from "../../adapters/next-link.js";
import { AlertCircle, ShieldAlert } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { PageHeader } from "../../components/layout/page-header.js";
import { useStudioSession } from "./session-context.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import { useAdminCapabilities } from "./capabilities-context.js";
import type {
  DashboardData,
  DashboardLoadResult,
} from "../../../dashboard-data.js";
import { useDashboardData } from "../../hooks/use-dashboard-data.js";

type DashboardState =
  | { status: "idle" }
  | { status: "loading" }
  | DashboardLoadResult;

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr ago`;
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function deriveUserLabel(email: string): string | null {
  const local = (email || "").split("@")[0];
  if (!local) return null;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

const STAT_LABEL_CLASS =
  "font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted";
const STAT_VALUE_CLASS =
  "mt-2 font-heading text-[40px] font-bold leading-none tracking-tight text-foreground";
const STAT_DELTA_CLASS = "mt-2 font-mono text-[11px] text-foreground-muted";

export default function DashboardPage() {
  const session = useStudioSession();
  const mountInfo = useStudioMountInfo();
  const { canCreateContent } = useAdminCapabilities();
  const query = useDashboardData();
  const showLoadingSkeleton =
    query.isFetching && query.data === undefined && !query.isError;

  const userLabel =
    session.status === "authenticated"
      ? deriveUserLabel(session.session.email)
      : null;

  const result: DashboardState = query.isError
    ? {
        status: "error",
        message:
          query.error instanceof Error
            ? query.error.message
            : "Failed to load dashboard data.",
      }
    : query.data
      ? query.data
      : showLoadingSkeleton
        ? { status: "loading" }
        : { status: "idle" };

  if (result.status === "idle") {
    return (
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Dashboard" }]} />
      </div>
    );
  }

  if (result.status === "loading") {
    return (
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Dashboard" }]} />
        <div className="space-y-6 p-6 lg:p-8">
          <div className="space-y-2">
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-3 w-64" />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-lg border border-card-border bg-card p-5"
              >
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-3 h-8 w-20" />
                <Skeleton className="mt-3 h-3 w-28" />
              </div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <div className="rounded-lg border border-card-border bg-card">
              <div className="flex items-center justify-between border-b border-divider px-5 py-3.5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
              <div className="space-y-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-card-border bg-card">
              <div className="flex items-center justify-between border-b border-divider px-5 py-3.5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="space-y-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (result.status === "forbidden") {
    return (
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Dashboard" }]} />
        <div className="flex flex-col items-center justify-center gap-3 p-24 text-center">
          <ShieldAlert className="size-8 text-foreground-muted" />
          <h2 className="text-lg font-semibold">Access denied</h2>
          <p className="text-sm text-foreground-muted max-w-md">
            You do not have permission to view this dashboard. Contact an
            administrator for access.
          </p>
        </div>
      </div>
    );
  }

  if (result.status === "error") {
    return (
      <div className="min-h-screen">
        <PageHeader breadcrumbs={[{ label: "Dashboard" }]} />
        <div className="flex flex-col items-center justify-center gap-3 p-24 text-center">
          <AlertCircle className="size-8 text-destructive" />
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="text-sm text-foreground-muted max-w-md">
            {result.message}
          </p>
        </div>
      </div>
    );
  }

  const { data } = result;
  const publishedPercentage =
    data.totalDocuments > 0
      ? Math.round((data.publishedDocuments / data.totalDocuments) * 100)
      : 0;

  const subtitleParts: string[] = [];
  if (mountInfo.project) subtitleParts.push(mountInfo.project);
  if (mountInfo.environment) subtitleParts.push(mountInfo.environment);
  const subtitle = subtitleParts.join(" · ");

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Dashboard" }]} />

      <div className="space-y-8 p-6 lg:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-[36px] font-semibold leading-[1.05] tracking-tight text-foreground">
              Dashboard
            </h1>
            {(subtitle || userLabel) && (
              <p className="mt-1.5 font-mono text-[12px] text-foreground-muted">
                {subtitle || `Welcome back, ${userLabel}`}
              </p>
            )}
          </div>
          {canCreateContent && (
            <Button asChild>
              <Link href="/admin/content">+ New document</Link>
            </Button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <StatCard
            label="Total documents"
            value={data.totalDocuments}
            delta={
              data.draftDocuments > 0
                ? `${data.draftDocuments} in draft`
                : undefined
            }
          />
          <StatCard
            label="Published"
            value={data.publishedDocuments}
            delta={
              data.totalDocuments > 0
                ? `${publishedPercentage}% of total`
                : undefined
            }
          />
          <StatCard
            label="Drafts"
            value={data.draftDocuments}
            delta={
              data.draftDocuments > 0 ? "unpublished changes" : "all caught up"
            }
            tone={data.draftDocuments > 0 ? "warn" : "ok"}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
          <ContentTypesCard data={data} />
          <RecentDraftsCard data={data} formatTime={formatRelativeTime} />
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: number;
  delta?: string;
  tone?: "ok" | "warn";
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <p className={STAT_LABEL_CLASS}>{label}</p>
      <p className={STAT_VALUE_CLASS}>{value.toLocaleString()}</p>
      {delta && (
        <p
          className={cn(
            STAT_DELTA_CLASS,
            tone === "warn" && "text-warning",
            tone === "ok" && "text-success",
          )}
        >
          {delta}
        </p>
      )}
    </div>
  );
}

function ContentTypesCard({ data }: { data: DashboardData }) {
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="font-heading text-[16px] font-semibold text-foreground">
          Content types
        </h2>
        <Link
          href="/admin/schema"
          className="font-mono text-[11px] text-primary hover:underline"
        >
          browse schema →
        </Link>
      </div>
      {data.contentTypes.length === 0 ? (
        <p className="p-6 text-center text-sm text-foreground-muted">
          No schema types synced yet.
        </p>
      ) : (
        data.contentTypes.map((ct) => {
          const pct =
            ct.totalCount > 0
              ? Math.round((ct.publishedCount / ct.totalCount) * 100)
              : 0;
          const initial = (ct.type[0] ?? "?").toUpperCase();
          return (
            <Link
              key={ct.type}
              href={`/admin/content/${ct.type}`}
              className="group flex items-center gap-3 border-t border-divider/60 border-l-2 border-l-transparent px-5 py-2.5 transition-colors hover:border-l-primary hover:bg-accent-subtle"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded bg-blue-100 font-mono text-[11px] font-bold text-primary">
                {initial}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {ct.type}
                  </span>
                  {ct.localized && (
                    <span className="rounded-sm bg-blue-100 px-1.5 py-0 font-mono text-[9px] font-bold tracking-wider text-primary">
                      i18n
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[10px] text-foreground-muted">
                  /{ct.directory}
                </div>
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground-muted">
                {ct.publishedCount}/{ct.totalCount}
              </span>
              <div className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-background-subtle">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </Link>
          );
        })
      )}
    </div>
  );
}

function RecentDraftsCard({
  data,
  formatTime,
}: {
  data: DashboardData;
  formatTime: (s: string) => string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card">
      <div className="flex items-center justify-between px-5 py-3.5">
        <h2 className="font-heading text-[16px] font-semibold text-foreground">
          Recently updated
        </h2>
        <Link
          href="/admin/content"
          className="font-mono text-[11px] text-primary hover:underline"
        >
          all content →
        </Link>
      </div>
      {data.recentDocuments.length === 0 ? (
        <p className="p-6 text-center text-sm text-foreground-muted">
          No documents yet.
        </p>
      ) : (
        data.recentDocuments.map((doc) => {
          const draft = doc.hasUnpublishedChanges;
          const title = doc.frontmatter.title
            ? String(doc.frontmatter.title)
            : doc.path;
          return (
            <Link
              key={doc.documentId}
              href={`/admin/content/${doc.type}/${doc.documentId}`}
              className="group flex min-w-0 flex-col gap-1 border-t border-divider/60 border-l-2 border-l-transparent px-5 py-2.5 transition-colors hover:border-l-primary hover:bg-accent-subtle"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    draft ? "bg-vibrant-green" : "bg-success",
                  )}
                />
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {title}
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-foreground-muted">
                {doc.type} · {doc.path} · {formatTime(doc.updatedAt)}
                {draft && " · draft"}
              </div>
            </Link>
          );
        })
      )}
    </div>
  );
}
