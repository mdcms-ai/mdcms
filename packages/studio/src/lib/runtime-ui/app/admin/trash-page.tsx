"use client";

import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RuntimeError } from "@mdcms/shared";
import {
  Search,
  MoreHorizontal,
  Loader2,
  AlertCircle,
  ShieldAlert,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Badge } from "../../components/ui/badge.js";
import { Avatar, AvatarFallback } from "../../components/ui/avatar.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../../components/ui/pagination.js";
import { PageHeader } from "../../components/layout/page-header.js";
import { useAdminCapabilities } from "./capabilities-context.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import {
  useTrashList,
  TRASH_PAGE_SIZE,
  type MappedTrashDocument,
  type TrashListSort,
} from "../../hooks/use-trash-list.js";
import { getContentTranslationCoverageQueryKey } from "../../lib/content-translation-coverage.js";
import { createStudioSchemaRouteApi } from "../../../schema-route-api.js";
import { createStudioDocumentRouteApi } from "../../../document-route-api.js";
import { useToast } from "../../components/toast.js";

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

function TrashRowActions({
  doc,
  disabled,
  onRestore,
}: {
  doc: MappedTrashDocument;
  disabled: boolean;
  onRestore: (documentId: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Actions for ${doc.title}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={disabled}
          onClick={() => onRestore(doc.documentId)}
        >
          <RotateCcw className="mr-2 size-4" />
          Restore
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrashFilterBar({
  searchInput,
  onSearchChange,
  typeFilter,
  onTypeChange,
  schemaTypes,
  sort,
  onSortChange,
}: {
  searchInput: string;
  onSearchChange: (value: string) => void;
  typeFilter: string | undefined;
  onTypeChange: (value: string | undefined) => void;
  schemaTypes: string[];
  sort: TrashListSort | undefined;
  onSortChange: (value: TrashListSort) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
          <Input
            aria-label="Search deleted documents"
            placeholder="Search deleted documents..."
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 w-72"
          />
        </div>
        <Select
          value={typeFilter ?? "all"}
          onValueChange={(value) =>
            onTypeChange(value === "all" ? undefined : value)
          }
        >
          <SelectTrigger className="w-36" aria-label="Filter by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {schemaTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Select
        value={sort ?? "updated"}
        onValueChange={(value) => onSortChange(value as TrashListSort)}
      >
        <SelectTrigger className="w-36" aria-label="Sort order">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated">Newest first</SelectItem>
          <SelectItem value="created">Created</SelectItem>
          <SelectItem value="path-asc">Path A-Z</SelectItem>
          <SelectItem value="path-desc">Path Z-A</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function TrashEmptyMatch() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 rounded-full bg-background-subtle p-4">
        <Search className="size-8 text-foreground-muted" />
      </div>
      <h3 className="mb-2 text-lg font-semibold">No results</h3>
      <p className="text-sm text-foreground-muted">
        No deleted documents match your current filters.
      </p>
    </div>
  );
}

function TrashTable({
  documents,
  users,
  restoreDisabled,
  onRestore,
}: {
  documents: MappedTrashDocument[];
  users: Record<string, { email?: string; name?: string }>;
  restoreDisabled: boolean;
  onRestore: (documentId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title / Path</TableHead>
            <TableHead className="w-28">Type</TableHead>
            <TableHead className="w-32">Deleted</TableHead>
            <TableHead className="w-28">Author</TableHead>
            <TableHead className="w-14"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => (
            <TableRow key={doc.documentId}>
              <TableCell>
                <div>
                  <p className="font-medium">{doc.title}</p>
                  <p className="text-xs text-foreground-muted font-mono">
                    {doc.path}
                  </p>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">
                  {doc.type}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-foreground-muted">
                {formatRelativeTime(doc.deletedAt)}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar className="size-6">
                    <AvatarFallback className="text-xs">
                      {deriveAuthorInitials(users[doc.deletedBy]?.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-foreground-muted truncate max-w-[8rem]">
                    {users[doc.deletedBy]?.name ??
                      users[doc.deletedBy]?.email ??
                      "Unknown"}
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <TrashRowActions
                  doc={doc}
                  disabled={restoreDisabled}
                  onRestore={onRestore}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TrashPagination({
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
  const maxOffset = Math.max(0, (totalPages - 1) * TRASH_PAGE_SIZE);
  const clamp = (value: number) => Math.max(0, Math.min(value, maxOffset));
  const visibleCount = Math.min(5, totalPages);
  const windowStart = Math.max(
    1,
    Math.min(currentPage - 2, totalPages - visibleCount + 1),
  );
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-foreground-muted">
        Showing {offset + 1}–{Math.min(offset + TRASH_PAGE_SIZE, total)} of{" "}
        {total} documents
      </p>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              onClick={() => onPageChange(clamp(offset - TRASH_PAGE_SIZE))}
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
                  onClick={() =>
                    onPageChange(clamp((page - 1) * TRASH_PAGE_SIZE))
                  }
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
              onClick={() => onPageChange(clamp(offset + TRASH_PAGE_SIZE))}
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

export default function TrashPage() {
  const mountInfo = useStudioMountInfo();
  const capabilities = useAdminCapabilities();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [searchInput, setSearchInput] = useState("");
  const [rowActionError, setRowActionError] = useState<string | null>(null);

  const list = useTrashList();

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      list.setFilters({ q: searchInput || undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, list.setFilters]);

  // Schema query for type filter dropdown
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

  const schemaTypes = useMemo(() => {
    return (schemaQuery.data?.types ?? []).map((entry) => entry.type);
  }, [schemaQuery.data]);

  // Document route API for restore action
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

  const restoreMutation = useMutation({
    mutationFn: (documentId: string) => {
      if (!documentApi) throw new Error("Document API not available.");
      setRowActionError(null);
      return documentApi.restore({ documentId });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["trash-list"] });
      void queryClient.invalidateQueries({
        queryKey: getContentTranslationCoverageQueryKey(
          mountInfo.project,
          mountInfo.environment,
        ),
      });
      toast.success("Document restored. It is now available as a draft.");
    },
    onError: (error: Error) => {
      if (
        error instanceof RuntimeError &&
        error.statusCode === 409 &&
        error.code === "CONTENT_PATH_CONFLICT"
      ) {
        const details = error.details as Record<string, unknown> | undefined;
        const payload = details?.payload as Record<string, unknown> | undefined;
        const path =
          typeof payload?.path === "string" ? payload.path : undefined;
        const locale =
          typeof payload?.locale === "string" ? payload.locale : undefined;
        const suffix = path
          ? ` at \`${path}\`${locale ? ` (${locale})` : ""}`
          : "";
        setRowActionError(
          `Could not restore — a document already exists${suffix}.`,
        );
        return;
      }
      setRowActionError(error.message || "Restore failed.");
    },
  });

  const totalPages = list.pagination
    ? Math.ceil(list.pagination.total / TRASH_PAGE_SIZE)
    : 0;
  const currentPage = list.pagination
    ? Math.floor(list.pagination.offset / TRASH_PAGE_SIZE) + 1
    : 1;

  const restoreDisabled =
    !capabilities.canCreateContent || restoreMutation.isPending;
  const restoreHandler = (documentId: string) =>
    restoreMutation.mutate(documentId);

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Trash" }]} />

      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Deleted Content</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Review and restore deleted documents.
          </p>
        </div>

        <TrashFilterBar
          searchInput={searchInput}
          onSearchChange={setSearchInput}
          typeFilter={list.filters.type}
          onTypeChange={(value) => list.setFilters({ type: value })}
          schemaTypes={schemaTypes}
          sort={list.filters.sort}
          onSortChange={(value) => list.setFilters({ sort: value })}
        />

        {/* Row action error banner */}
        {rowActionError && (
          <div
            role="alert"
            className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3"
          >
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

        {list.status === "loading" && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-foreground-muted" />
          </div>
        )}

        {list.status === "forbidden" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldAlert className="mb-4 size-8 text-foreground-muted" />
            <h3 className="mb-2 text-lg font-semibold">Access restricted</h3>
            <p className="text-sm text-foreground-muted">
              You don&apos;t have permission to view deleted content.
            </p>
          </div>
        )}

        {list.status === "error" && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertCircle className="mb-4 size-8 text-destructive" />
            <h3 className="mb-2 text-lg font-semibold">
              Failed to load deleted documents
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
              <Trash2 className="size-8 text-foreground-muted" />
            </div>
            <h3 className="mb-2 text-lg font-semibold">No deleted documents</h3>
            <p className="text-sm text-foreground-muted">
              Documents you delete will appear here for recovery.
            </p>
          </div>
        )}

        {list.status === "ready" && (
          <>
            {list.documents.length > 0 ? (
              <TrashTable
                documents={list.documents}
                users={list.users}
                restoreDisabled={restoreDisabled}
                onRestore={restoreHandler}
              />
            ) : (
              <TrashEmptyMatch />
            )}

            {totalPages > 1 && list.pagination && (
              <TrashPagination
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
    </div>
  );
}
