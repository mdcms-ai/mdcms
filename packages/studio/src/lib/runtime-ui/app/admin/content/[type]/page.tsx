"use client";

import { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "../../../../adapters/next-navigation.js";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  MoreHorizontal,
  Edit,
  Copy,
  Trash2,
  Send,
  FileText,
  AlertCircle,
  ShieldAlert,
  ArrowUpFromLine,
} from "lucide-react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { cn } from "../../../../lib/utils.js";
import { Avatar, AvatarFallback } from "../../../../components/ui/avatar.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui/table.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu.js";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../../../../components/ui/pagination.js";
import { PageHeader } from "../../../../components/layout/page-header.js";
import { Skeleton } from "../../../../components/ui/skeleton.js";

import { useAdminCapabilities } from "../../capabilities-context.js";
import { useStudioMountInfo } from "../../mount-info-context.js";
import {
  getContentTypeListQueryKey,
  useContentTypeList,
  PAGE_SIZE,
  type ContentTypeTranslationCoverageStatus,
  type MappedContentDocument,
  type ContentTypeListFilters,
} from "../../../../hooks/use-content-type-list.js";
import { useCreateDocument } from "../../../../hooks/use-create-document.js";
import { CreateDocumentDialog } from "../../../../components/create-document-dialog.js";
import { createStudioSchemaRouteApi } from "../../../../../schema-route-api.js";
import { createStudioDocumentRouteApi } from "../../../../../document-route-api.js";
import { useToast } from "../../../../components/toast.js";
import {
  formatContentTranslationCoverageLabel,
  getContentTranslationCoverageQueryKey,
  type ContentTranslationCoverage,
} from "../../../../lib/content-translation-coverage.js";

const statusConfig = {
  published: {
    label: "PUBLISHED",
    className:
      "bg-[rgba(174,213,32,0.18)] text-[#516600] font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-sm",
  },
  draft: {
    label: "DRAFT",
    className:
      "bg-vibrant-green text-[#516600] font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-sm",
  },
  changed: {
    label: "UNPUBLISHED CHANGES",
    className:
      "bg-blue-100 text-primary font-mono text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-sm",
  },
};

type TranslationCoverageSummaryProps = {
  status: ContentTypeTranslationCoverageStatus;
  coverage?: ContentTranslationCoverage;
};

type ContentTypeTableColumn = {
  key: "title" | "translations" | "status" | "updated" | "author" | "actions";
  label: string;
  className?: string;
};

export function getContentTypeTableColumns(
  showTranslationCoverage: boolean,
): ContentTypeTableColumn[] {
  return [
    { key: "title", label: "Title / Path" },
    ...(showTranslationCoverage
      ? ([
          {
            key: "translations",
            label: "Translations",
            className: "w-40",
          },
        ] satisfies ContentTypeTableColumn[])
      : []),
    { key: "status", label: "Status", className: "w-28" },
    { key: "updated", label: "Updated", className: "w-32" },
    { key: "author", label: "Author", className: "w-28" },
    { key: "actions", label: "", className: "w-14" },
  ];
}

export function TranslationCoverageSummary({
  status,
  coverage,
}: TranslationCoverageSummaryProps) {
  if (status === "idle") {
    return null;
  }

  if (status === "loading") {
    return (
      <p
        data-mdcms-translation-coverage-state="loading"
        className="text-xs text-foreground-muted"
      >
        Loading locale coverage…
      </p>
    );
  }

  if (status === "error" || !coverage) {
    return (
      <p
        data-mdcms-translation-coverage-state="error"
        className="text-xs text-destructive"
      >
        Translation status unavailable.
      </p>
    );
  }

  return (
    <p
      data-mdcms-translation-coverage-state="ready"
      className="text-xs text-foreground-muted"
    >
      {formatContentTranslationCoverageLabel(coverage)}
    </p>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function deriveAuthorInitials(email: string | undefined): string {
  if (!email) return "?";
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

function RowActions({
  doc,
  capabilities,
  pending,
  onEdit,
  onPublish,
  onUnpublish,
  onDuplicate,
  onDelete,
}: {
  doc: MappedContentDocument;
  capabilities: {
    canPublishContent: boolean;
    canUnpublishContent: boolean;
    canCreateContent: boolean;
    canDeleteContent: boolean;
  };
  pending: boolean;
  onEdit: (documentId: string) => void;
  onPublish: (documentId: string) => void;
  onUnpublish: (documentId: string) => void;
  onDuplicate: (documentId: string) => void;
  onDelete: (documentId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(doc.documentId)}>
          <Edit className="mr-2 size-4" />
          Edit
        </DropdownMenuItem>
        {capabilities.canPublishContent &&
          (doc.status === "draft" || doc.status === "changed") && (
            <DropdownMenuItem
              disabled={pending}
              onClick={() => onPublish(doc.documentId)}
            >
              <Send className="mr-2 size-4" />
              Publish
            </DropdownMenuItem>
          )}
        {capabilities.canUnpublishContent && doc.status === "published" && (
          <DropdownMenuItem
            disabled={pending}
            onClick={() => onUnpublish(doc.documentId)}
          >
            <ArrowUpFromLine className="mr-2 size-4" />
            Unpublish
          </DropdownMenuItem>
        )}
        {capabilities.canCreateContent && (
          <DropdownMenuItem
            disabled={pending}
            onClick={() => onDuplicate(doc.documentId)}
          >
            <Copy className="mr-2 size-4" />
            Duplicate
          </DropdownMenuItem>
        )}
        {capabilities.canDeleteContent && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending}
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(doc.documentId)}
            >
              <Trash2 className="mr-2 size-4" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContentTypeDocumentsTable({
  documents,
  users,
  capabilities,
  pendingRowAction,
  showTranslationCoverage,
  translationCoverageStatus,
  translationCoverageByGroup,
  tableColumns,
  onRowClick,
  rowActionHandlers,
}: {
  documents: MappedContentDocument[];
  users: Record<string, { email?: string; name?: string }>;
  capabilities: {
    canPublishContent: boolean;
    canUnpublishContent: boolean;
    canCreateContent: boolean;
    canDeleteContent: boolean;
  };
  pendingRowAction: boolean;
  showTranslationCoverage: boolean;
  translationCoverageStatus: ReturnType<
    typeof useContentTypeList
  >["translationCoverageStatus"];
  translationCoverageByGroup: ReturnType<
    typeof useContentTypeList
  >["translationCoverageByGroup"];
  tableColumns: ReturnType<typeof getContentTypeTableColumns>;
  onRowClick: (documentId: string) => void;
  rowActionHandlers: {
    onEdit: (documentId: string) => void;
    onPublish: (documentId: string) => void;
    onUnpublish: (documentId: string) => void;
    onDuplicate: (documentId: string) => void;
    onDelete: (documentId: string) => void;
  };
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card">
      <Table>
        <TableHeader className="bg-background-subtle">
          <TableRow>
            {tableColumns.map((column) => (
              <TableHead
                key={column.key}
                className={cn(
                  "h-10 px-4 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted",
                  column.className,
                )}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => (
            <TableRow
              key={doc.documentId}
              role="button"
              tabIndex={0}
              aria-label={`Open document ${doc.title}`}
              className="cursor-pointer border-b border-divider/60 last:border-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
              onClick={() => onRowClick(doc.documentId)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onRowClick(doc.documentId);
                }
              }}
            >
              <TableCell className="px-4 py-3">
                <div className="max-w-[480px]">
                  <p className="truncate text-[13px] font-semibold text-foreground">
                    {doc.title}
                  </p>
                  <p className="truncate font-mono text-[11px] text-foreground-muted">
                    {doc.path}
                  </p>
                </div>
              </TableCell>
              {showTranslationCoverage ? (
                <TableCell className="px-4 py-3">
                  <TranslationCoverageSummary
                    status={translationCoverageStatus}
                    coverage={
                      translationCoverageByGroup[doc.translationGroupId]
                    }
                  />
                </TableCell>
              ) : null}
              <TableCell className="px-4 py-3">
                <span className={statusConfig[doc.status].className}>
                  {statusConfig[doc.status].label}
                </span>
              </TableCell>
              <TableCell className="px-4 py-3 font-mono text-[11px] text-foreground-muted">
                {formatRelativeTime(doc.updatedAt)}
              </TableCell>
              <TableCell className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Avatar className="size-6">
                    <AvatarFallback className="bg-blue-100 text-[10px] font-bold text-primary">
                      {deriveAuthorInitials(users[doc.updatedBy]?.email)}
                    </AvatarFallback>
                  </Avatar>
                </div>
              </TableCell>
              <TableCell
                className="px-4 py-3"
                onClick={(e) => e.stopPropagation()}
              >
                <RowActions
                  doc={doc}
                  capabilities={capabilities}
                  pending={pendingRowAction}
                  onEdit={rowActionHandlers.onEdit}
                  onPublish={rowActionHandlers.onPublish}
                  onUnpublish={rowActionHandlers.onUnpublish}
                  onDuplicate={rowActionHandlers.onDuplicate}
                  onDelete={rowActionHandlers.onDelete}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ContentTypePaginationBar({
  offset,
  total,
  currentPage,
  totalPages,
  onPageChange,
}: {
  offset: number;
  total: number;
  currentPage: number;
  totalPages: number;
  onPageChange: (newOffset: number) => void;
}) {
  const maxOffset = Math.max(0, (totalPages - 1) * PAGE_SIZE);
  const clamp = (value: number) => Math.max(0, Math.min(value, maxOffset));
  const visibleCount = Math.min(5, totalPages);
  const windowStart = Math.max(
    1,
    Math.min(currentPage - 2, totalPages - visibleCount + 1),
  );
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-foreground-muted">
        Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}{" "}
        documents
      </p>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => onPageChange(clamp(offset - PAGE_SIZE))}
              className={
                currentPage === 1
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer"
              }
            />
          </PaginationItem>
          {Array.from({ length: visibleCount }).map((_, i) => {
            const page = windowStart + i;
            return (
              <PaginationItem key={page}>
                <PaginationLink
                  onClick={() => onPageChange(clamp((page - 1) * PAGE_SIZE))}
                  isActive={currentPage === page}
                  className="cursor-pointer"
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            );
          })}
          <PaginationItem>
            <PaginationNext
              onClick={() => onPageChange(clamp(offset + PAGE_SIZE))}
              className={
                currentPage === totalPages
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer"
              }
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

function useContentTypePageController() {
  const params = useParams();
  const { push } = useRouter();
  const typeId = params.type as string;
  const mountInfo = useStudioMountInfo();
  const capabilities = useAdminCapabilities();
  const queryClient = useQueryClient();

  const toast = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  // Schema query for type metadata (localized, locales, directory)
  const schemaApi = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl)
      return null;
    return createStudioSchemaRouteApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      { auth: mountInfo.auth },
    );
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
  ]);

  const schemaQuery = useQuery({
    queryKey: ["schema-list", mountInfo.project, mountInfo.environment],
    queryFn: () => schemaApi!.list(),
    enabled: schemaApi !== null,
    staleTime: 60_000,
  });

  const schemaEntry = useMemo(() => {
    return schemaQuery.data?.types.find(
      (entry) => entry.type.toLowerCase() === typeId.toLowerCase(),
    );
  }, [schemaQuery.data, typeId]);

  const typeName = schemaEntry?.type ?? typeId;
  const enableTranslationCoverage = schemaEntry?.localized === true;
  const list = useContentTypeList(typeId, {
    enableTranslationCoverage,
  });
  const create = useCreateDocument(typeId);
  const showLoading = list.status === "loading";

  useEffect(() => {
    const timer = setTimeout(() => {
      list.setFilters({ q: searchInput || undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, list.setFilters]);

  // Document route API for row actions
  const documentApi = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl)
      return null;
    return createStudioDocumentRouteApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      { auth: mountInfo.auth },
    );
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
  ]);

  const onRowActionError = (error: Error) => {
    setRowActionError(error.message || "Action failed.");
  };
  const contentListQueryKey = getContentTypeListQueryKey(
    mountInfo.project,
    mountInfo.environment,
    typeId,
  );
  const translationCoverageQueryKey = getContentTranslationCoverageQueryKey(
    mountInfo.project,
    mountInfo.environment,
    typeId,
  );

  const publishMutation = useMutation({
    mutationFn: (documentId: string) => {
      if (!documentApi) throw new Error("Document API not available.");
      setRowActionError(null);
      return documentApi.publish({ documentId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: translationCoverageQueryKey,
      });
    },
    onError: onRowActionError,
  });

  const unpublishMutation = useMutation({
    mutationFn: (documentId: string) => {
      if (!documentApi) throw new Error("Document API not available.");
      setRowActionError(null);
      return documentApi.unpublish({ documentId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: translationCoverageQueryKey,
      });
    },
    onError: onRowActionError,
  });

  const duplicateMutation = useMutation({
    mutationFn: (documentId: string) => {
      if (!documentApi) throw new Error("Document API not available.");
      setRowActionError(null);
      return documentApi.duplicate({ documentId });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: contentListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: translationCoverageQueryKey,
      });
      push(`/admin/content/${typeId}/${data.documentId}`);
    },
    onError: onRowActionError,
  });

  const deleteMutation = useMutation({
    mutationFn: (documentId: string) => {
      if (!documentApi) throw new Error("Document API not available.");
      setRowActionError(null);
      return documentApi.softDelete({ documentId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: translationCoverageQueryKey,
      });
      toast.success(
        "Document moved to trash. It can be restored from the Trash page.",
      );
    },
    onError: onRowActionError,
  });

  const isRowActionPending =
    publishMutation.isPending ||
    unpublishMutation.isPending ||
    duplicateMutation.isPending ||
    deleteMutation.isPending;

  const totalPages = list.pagination
    ? Math.ceil(list.pagination.total / PAGE_SIZE)
    : 0;
  const currentPage = list.pagination
    ? Math.floor(list.pagination.offset / PAGE_SIZE) + 1
    : 1;
  const showTranslationCoverage =
    enableTranslationCoverage && (mountInfo.supportedLocales?.length ?? 0) > 0;
  const tableColumns = useMemo(
    () => getContentTypeTableColumns(showTranslationCoverage),
    [showTranslationCoverage],
  );

  const rowActionHandlers = {
    onEdit: (documentId: string) =>
      push(`/admin/content/${typeId}/${documentId}`),
    onPublish: (documentId: string) => publishMutation.mutate(documentId),
    onUnpublish: (documentId: string) => unpublishMutation.mutate(documentId),
    onDuplicate: (documentId: string) => duplicateMutation.mutate(documentId),
    onDelete: (documentId: string) => deleteMutation.mutate(documentId),
  };

  return {
    capabilities,
    create,
    currentPage,
    isRowActionPending,
    list,
    mountInfo,
    rowActionError,
    rowActionHandlers,
    schemaEntry,
    searchInput,
    setRowActionError,
    setSearchInput,
    showLoading,
    showTranslationCoverage,
    tableColumns,
    totalPages,
    typeId,
    typeName,
    push,
  };
}

function ContentTypePageView({
  capabilities,
  create,
  currentPage,
  isRowActionPending,
  list,
  mountInfo,
  rowActionError,
  rowActionHandlers,
  schemaEntry,
  searchInput,
  setRowActionError,
  setSearchInput,
  showLoading,
  showTranslationCoverage,
  tableColumns,
  totalPages,
  typeId,
  typeName,
  push,
}: ReturnType<typeof useContentTypePageController>) {
  return (
    <div className="min-h-screen">
      <PageHeader
        breadcrumbs={[
          { label: "Content", href: "/admin/content" },
          { label: typeName },
        ]}
      />

      <div className="space-y-8 p-6 lg:p-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-[36px] font-semibold leading-[1.05] tracking-tight text-foreground">
              {typeName}
            </h1>
            <p className="mt-1.5 font-mono text-[12px] text-foreground-muted">
              {schemaEntry?.directory ? `/${schemaEntry.directory}` : typeId}
              {schemaEntry?.localized ? " · localized" : ""}
              {list.pagination
                ? ` · ${list.pagination.total} document${list.pagination.total === 1 ? "" : "s"}`
                : ""}
            </p>
          </div>
          {capabilities.canCreateContent && schemaEntry && (
            <Button onClick={create.open}>
              <Plus className="mr-2 size-4" />
              New document
            </Button>
          )}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
              <Input
                placeholder="Search documents..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9 w-72"
              />
            </div>
            <Select
              value={list.filters.status ?? "all"}
              onValueChange={(value) =>
                list.setFilters({
                  status: value as ContentTypeListFilters["status"],
                })
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="draft">Draft only</SelectItem>
                <SelectItem value="changed">Has changes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Select
            value={list.filters.sort ?? "updated"}
            onValueChange={(value) => list.setFilters({ sort: value })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">Last updated</SelectItem>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="path-asc">Path A-Z</SelectItem>
              <SelectItem value="path-desc">Path Z-A</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Row action error banner */}
        {rowActionError && (
          <div className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">{rowActionError}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRowActionError(null)}
              className="text-destructive hover:text-destructive"
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* Content area */}
        {list.status === "loading" && showLoading && (
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-3 flex gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16 ml-auto" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="size-6 rounded-full" />
              </div>
            ))}
          </div>
        )}

        {list.status === "forbidden" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldAlert className="mb-4 size-8 text-foreground-muted" />
            <h3 className="mb-2 text-lg font-semibold">Access denied</h3>
            <p className="text-sm text-foreground-muted">
              You do not have permission to view content for this target.
            </p>
          </div>
        )}

        {list.status === "error" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-4 size-8 text-destructive" />
            <h3 className="mb-2 text-lg font-semibold">
              Failed to load documents
            </h3>
            <p className="mb-4 text-sm text-foreground-muted">
              {list.errorMessage}
            </p>
            <Button variant="ghost" onClick={list.refresh}>
              Try again
            </Button>
          </div>
        )}

        {list.status === "empty" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 rounded-full bg-background-subtle p-4">
              <FileText className="size-8 text-foreground-muted" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">No documents yet</h3>
            <p className="mb-4 text-sm text-foreground-muted">
              Create your first {typeName} document to get started.
            </p>
            {capabilities.canCreateContent && schemaEntry && (
              <Button onClick={create.open}>
                <Plus className="mr-2 size-4" />
                New Document
              </Button>
            )}
          </div>
        )}

        {list.status === "ready" && (
          <>
            {list.documents.length > 0 ? (
              <ContentTypeDocumentsTable
                documents={list.documents}
                users={list.users}
                capabilities={capabilities}
                pendingRowAction={isRowActionPending}
                showTranslationCoverage={showTranslationCoverage}
                translationCoverageStatus={list.translationCoverageStatus}
                translationCoverageByGroup={list.translationCoverageByGroup}
                tableColumns={tableColumns}
                onRowClick={(documentId) =>
                  push(`/admin/content/${typeId}/${documentId}`)
                }
                rowActionHandlers={rowActionHandlers}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 rounded-full bg-background-subtle p-4">
                  <Search className="size-8 text-foreground-muted" />
                </div>
                <h3 className="mb-2 text-lg font-semibold">No results</h3>
                <p className="text-sm text-foreground-muted">
                  No documents match your current filters.
                </p>
              </div>
            )}

            {totalPages > 1 && list.pagination && (
              <ContentTypePaginationBar
                offset={list.pagination.offset}
                total={list.pagination.total}
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={(newOffset) => list.setPage(newOffset)}
              />
            )}
          </>
        )}
      </div>

      {/* Create document dialog */}
      <CreateDocumentDialog
        isOpen={create.isOpen}
        isSubmitting={create.isSubmitting}
        error={create.error}
        typeDirectory={schemaEntry?.directory ?? typeId}
        localized={schemaEntry?.localized ?? false}
        locales={mountInfo.supportedLocales}
        onClose={create.close}
        onSubmit={(input) => {
          create.submit({
            ...input,
            schemaHash: schemaEntry?.schemaHash,
          });
        }}
      />
    </div>
  );
}

export default function ContentTypePage() {
  const viewProps = useContentTypePageController();
  return <ContentTypePageView {...viewProps} />;
}
