"use client";

import { useState, useEffect, useMemo } from "react";
import type {
  CollaborationPresenceUser,
  ContentBulkAction,
} from "@mdcms/shared";
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
  FolderInput,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { PageHeader } from "../../../../components/layout/page-header.js";
import { Skeleton } from "../../../../components/ui/skeleton.js";
import { PresenceIndicators } from "../../../../components/presence/presence-indicators.js";

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
import { useCollaborationPresence } from "../../../../hooks/use-collaboration-presence.js";
import { CreateDocumentDialog } from "../../../../components/create-document-dialog.js";
import { createStudioContentListApi } from "../../../../../content-list-api.js";
import { createStudioSchemaRouteApi } from "../../../../../schema-route-api.js";
import { createStudioDocumentRouteApi } from "../../../../../document-route-api.js";
import { groupPresenceByDocument } from "../../../../lib/collaboration-presence.js";
import { useToast } from "../../../../components/toast.js";
import {
  formatContentTranslationCoverageLabel,
  getContentTranslationCoverageQueryKey,
  type ContentTranslationCoverage,
} from "../../../../lib/content-translation-coverage.js";
import {
  formatBulkOperationSummary,
  getAvailableBulkActions,
  getBulkOperationTargets,
  getSelectedDocuments,
  validateBulkMoveTargetDirectory,
  type ContentBulkCapabilities,
} from "../../../../lib/content-bulk-actions.js";

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
  key:
    | "selection"
    | "title"
    | "translations"
    | "status"
    | "updated"
    | "author"
    | "actions";
  label: string;
  className?: string;
};

type BulkConfirmationText = {
  title: string;
  description: string;
  confirmLabel: string;
};

type BulkOperationFailureBanner = {
  succeeded: number;
  failed: number;
  message: string;
};

const bulkActionLabels: Record<ContentBulkAction, string> = {
  publish: "Publish",
  unpublish: "Unpublish",
  move: "Move",
  delete: "Delete",
};

export function getContentTypeTableColumns(
  showTranslationCoverage: boolean,
): ContentTypeTableColumn[] {
  return [
    { key: "selection", label: "", className: "w-10" },
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

export function getBulkConfirmationText({
  action,
  selectedCount,
  targetCount,
}: {
  action: ContentBulkAction;
  selectedCount: number;
  targetCount: number;
}): BulkConfirmationText {
  const selectedDocuments =
    selectedCount === 1 ? "selected document" : "selected documents";
  const targetDocuments = targetCount === 1 ? "document" : "documents";

  switch (action) {
    case "publish":
      return {
        title: "Publish documents",
        description: `${targetCount} ${targetDocuments} will be published from ${selectedCount} ${selectedDocuments}. Already published documents without changes are skipped.`,
        confirmLabel: "Publish",
      };
    case "unpublish":
      return {
        title: "Unpublish documents",
        description: `${targetCount} published ${targetDocuments} will be unpublished from ${selectedCount} ${selectedDocuments}.`,
        confirmLabel: "Unpublish",
      };
    case "move":
      return {
        title: "Move documents",
        description: `${selectedCount} ${selectedDocuments} will be moved to the target folder.`,
        confirmLabel: "Move",
      };
    case "delete":
      return {
        title: "Move documents to Trash",
        description: `${selectedCount} ${selectedDocuments} will move to Trash. This does not permanently delete them.`,
        confirmLabel: "Move to Trash",
      };
  }
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

function BulkActionIcon({ action }: { action: ContentBulkAction }) {
  switch (action) {
    case "publish":
      return <Send className="size-4" />;
    case "unpublish":
      return <ArrowUpFromLine className="size-4" />;
    case "move":
      return <FolderInput className="size-4" />;
    case "delete":
      return <Trash2 className="size-4" />;
  }
}

function ContentBulkToolbar({
  selectedCount,
  availableActions,
  pending,
  onAction,
}: {
  selectedCount: number;
  availableActions: ContentBulkAction[];
  pending: boolean;
  onAction: (action: ContentBulkAction) => void;
}) {
  if (selectedCount === 0) {
    return null;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <p className="font-mono text-[12px] text-foreground-muted">
        {selectedCount} selected
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {availableActions.map((action) => (
          <Button
            key={action}
            type="button"
            size="sm"
            variant={action === "delete" ? "destructive" : "ghost"}
            disabled={pending}
            onClick={() => onAction(action)}
          >
            <BulkActionIcon action={action} />
            {bulkActionLabels[action]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function BulkOperationConfirmationDialog({
  action,
  selectedCount,
  targetCount,
  moveTargetDirectory,
  moveTargetDirectoryError,
  pending,
  onMoveTargetDirectoryChange,
  onCancel,
  onConfirm,
}: {
  action: ContentBulkAction | null;
  selectedCount: number;
  targetCount: number;
  moveTargetDirectory: string;
  moveTargetDirectoryError: string | null;
  pending: boolean;
  onMoveTargetDirectoryChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!action) {
    return null;
  }

  const text = getBulkConfirmationText({
    action,
    selectedCount,
    targetCount,
  });
  const isDelete = action === "delete";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          onCancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={isDelete ? "text-destructive" : undefined}>
            {text.title}
          </DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>

        {action === "move" && (
          <div className="space-y-2">
            <label
              htmlFor="bulk-move-target-directory"
              className="text-sm font-medium text-foreground"
            >
              Target folder
            </label>
            <Input
              id="bulk-move-target-directory"
              value={moveTargetDirectory}
              disabled={pending}
              aria-invalid={moveTargetDirectoryError ? true : undefined}
              placeholder="archive/news"
              onChange={(event) =>
                onMoveTargetDirectoryChange(event.target.value)
              }
            />
            <p className="text-xs text-foreground-muted">
              Leave empty to move documents to the content root.
            </p>
            {moveTargetDirectoryError && (
              <p className="text-xs text-destructive">
                {moveTargetDirectoryError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={isDelete ? "destructive" : "default"}
            disabled={pending || targetCount === 0}
            onClick={onConfirm}
          >
            {text.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          disabled={pending}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={pending}
          onClick={() => onEdit(doc.documentId)}
        >
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

export function ContentTypeDocumentsTable({
  documents,
  users,
  capabilities,
  pendingRowAction,
  selectedDocumentIds,
  allRenderedSelected,
  someRenderedSelected,
  selectionDisabled,
  showTranslationCoverage,
  translationCoverageStatus,
  translationCoverageByGroup,
  tableColumns,
  presenceByDocumentId,
  onToggleDocumentSelected,
  onToggleRenderedSelection,
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
  selectedDocumentIds: ReadonlySet<string>;
  allRenderedSelected: boolean;
  someRenderedSelected: boolean;
  selectionDisabled: boolean;
  showTranslationCoverage: boolean;
  translationCoverageStatus: ReturnType<
    typeof useContentTypeList
  >["translationCoverageStatus"];
  translationCoverageByGroup: ReturnType<
    typeof useContentTypeList
  >["translationCoverageByGroup"];
  tableColumns: ReturnType<typeof getContentTypeTableColumns>;
  presenceByDocumentId?: ReadonlyMap<string, CollaborationPresenceUser[]>;
  onToggleDocumentSelected: (documentId: string, checked: boolean) => void;
  onToggleRenderedSelection: (checked: boolean) => void;
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
                {column.key === "selection" ? (
                  <input
                    type="checkbox"
                    aria-label="Select all visible documents"
                    checked={allRenderedSelected}
                    disabled={selectionDisabled || documents.length === 0}
                    ref={(element) => {
                      if (element) {
                        element.indeterminate =
                          someRenderedSelected && !allRenderedSelected;
                      }
                    }}
                    className="size-4 rounded border-border accent-primary"
                    onChange={(event) =>
                      onToggleRenderedSelection(event.target.checked)
                    }
                  />
                ) : (
                  column.label
                )}
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
              <TableCell
                className="px-4 py-3"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <input
                  type="checkbox"
                  aria-label={`Select document ${doc.title}`}
                  checked={selectedDocumentIds.has(doc.documentId)}
                  disabled={selectionDisabled}
                  className="size-4 rounded border-border accent-primary"
                  onChange={(event) =>
                    onToggleDocumentSelected(
                      doc.documentId,
                      event.target.checked,
                    )
                  }
                />
              </TableCell>
              <TableCell className="px-4 py-3">
                <div className="max-w-[480px]">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                      {doc.title}
                    </p>
                    <PresenceIndicators
                      className="shrink-0"
                      users={presenceByDocumentId?.get(doc.documentId) ?? []}
                    />
                  </div>
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
                onKeyDown={(event) => event.stopPropagation()}
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
  disabled,
  onPageChange,
}: {
  offset: number;
  total: number;
  currentPage: number;
  totalPages: number;
  disabled: boolean;
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
              aria-disabled={disabled || currentPage === 1}
              onClick={(event) => {
                event.preventDefault();
                if (!disabled && currentPage !== 1) {
                  onPageChange(clamp(offset - PAGE_SIZE));
                }
              }}
              className={
                disabled || currentPage === 1
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
                  aria-disabled={disabled}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!disabled) {
                      onPageChange(clamp((page - 1) * PAGE_SIZE));
                    }
                  }}
                  isActive={currentPage === page}
                  className={
                    disabled
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                >
                  {page}
                </PaginationLink>
              </PaginationItem>
            );
          })}
          <PaginationItem>
            <PaginationNext
              aria-disabled={disabled || currentPage === totalPages}
              onClick={(event) => {
                event.preventDefault();
                if (!disabled && currentPage !== totalPages) {
                  onPageChange(clamp(offset + PAGE_SIZE));
                }
              }}
              className={
                disabled || currentPage === totalPages
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
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [activeBulkAction, setActiveBulkAction] =
    useState<ContentBulkAction | null>(null);
  const [moveTargetDirectory, setMoveTargetDirectory] = useState("");
  const [moveTargetDirectoryError, setMoveTargetDirectoryError] = useState<
    string | null
  >(null);
  const [bulkOperationBanner, setBulkOperationBanner] =
    useState<BulkOperationFailureBanner | null>(null);

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

  const contentListApi = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl)
      return null;
    return createStudioContentListApi(
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
  const renderedDocumentIds = useMemo(
    () => list.documents.map((document) => document.documentId),
    [list.documents],
  );
  const renderedDocumentIdsKey = renderedDocumentIds.join("\u0000");
  const presence = useCollaborationPresence({ mode: "view" });
  const presenceByDocumentId = useMemo(
    () =>
      groupPresenceByDocument(presence.snapshot?.users ?? [], {
        visibleDocumentIds: renderedDocumentIds,
        currentSessionId: presence.currentSessionId,
      }),
    [presence.currentSessionId, presence.snapshot?.users, renderedDocumentIds],
  );
  const selectedDocuments = useMemo(
    () => getSelectedDocuments(list.documents, selectedDocumentIds),
    [list.documents, selectedDocumentIds],
  );
  const bulkCapabilities = useMemo<ContentBulkCapabilities>(
    () => ({
      canPublishContent: capabilities.canPublishContent,
      canUnpublishContent: capabilities.canUnpublishContent,
      canWriteContent: capabilities.canCreateContent,
      canDeleteContent: capabilities.canDeleteContent,
    }),
    [
      capabilities.canPublishContent,
      capabilities.canUnpublishContent,
      capabilities.canCreateContent,
      capabilities.canDeleteContent,
    ],
  );
  const availableBulkActions = useMemo(
    () => getAvailableBulkActions(selectedDocuments, bulkCapabilities),
    [selectedDocuments, bulkCapabilities],
  );
  const allRenderedSelected =
    renderedDocumentIds.length > 0 &&
    renderedDocumentIds.every((documentId) =>
      selectedDocumentIds.has(documentId),
    );
  const someRenderedSelected = renderedDocumentIds.some((documentId) =>
    selectedDocumentIds.has(documentId),
  );
  const activeBulkTargets = activeBulkAction
    ? getBulkOperationTargets(activeBulkAction, selectedDocuments)
    : [];

  useEffect(() => {
    setSelectedDocumentIds(new Set());
    setActiveBulkAction(null);
    setMoveTargetDirectory("");
    setMoveTargetDirectoryError(null);
  }, [
    typeId,
    mountInfo.project,
    mountInfo.environment,
    searchInput,
    list.filters.q,
    list.filters.status,
    list.filters.sort,
    list.pagination?.offset,
    renderedDocumentIdsKey,
  ]);

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

  const bulkOperationMutation = useMutation({
    mutationFn: ({
      action,
      targetDirectory,
    }: {
      action: ContentBulkAction;
      targetDirectory?: string;
    }) => {
      if (!contentListApi) throw new Error("Content list API not available.");

      const targets = getBulkOperationTargets(action, selectedDocuments);
      if (targets.length === 0) {
        throw new Error("No eligible documents selected.");
      }

      setRowActionError(null);
      setBulkOperationBanner(null);

      return contentListApi.bulkOperation({
        action,
        documentIds: targets.map((document) => document.documentId),
        ...(action === "move"
          ? {
              move: {
                targetDirectory: targetDirectory ?? "",
              },
              schemaHash: schemaEntry?.schemaHash,
            }
          : {}),
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: contentListQueryKey });
      void queryClient.invalidateQueries({
        queryKey: translationCoverageQueryKey,
      });
      list.refresh();

      if (result.failed === 0) {
        setBulkOperationBanner(null);
        toast.success(
          formatBulkOperationSummary(result.action, result.succeeded),
        );
        return;
      }

      const firstFailure = result.results.find(
        (item) => item.status === "failed",
      );
      setBulkOperationBanner({
        succeeded: result.succeeded,
        failed: result.failed,
        message:
          firstFailure?.status === "failed"
            ? firstFailure.error.message
            : "Bulk operation failed for one or more documents.",
      });
    },
    onError: (error) => {
      setBulkOperationBanner(null);
      setRowActionError(
        error instanceof Error ? error.message : "Bulk operation failed.",
      );
    },
    onSettled: () => {
      setSelectedDocumentIds(new Set());
      setActiveBulkAction(null);
      setMoveTargetDirectory("");
      setMoveTargetDirectoryError(null);
    },
  });

  const isRowActionPending =
    publishMutation.isPending ||
    unpublishMutation.isPending ||
    duplicateMutation.isPending ||
    deleteMutation.isPending;
  const isListInteractionLocked =
    isRowActionPending || bulkOperationMutation.isPending;

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

  const toggleDocumentSelection = (documentId: string, checked: boolean) => {
    if (isListInteractionLocked) return;

    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(documentId);
      } else {
        next.delete(documentId);
      }
      return next;
    });
  };

  const toggleRenderedSelection = (checked: boolean) => {
    if (isListInteractionLocked) return;

    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      for (const documentId of renderedDocumentIds) {
        if (checked) {
          next.add(documentId);
        } else {
          next.delete(documentId);
        }
      }
      return next;
    });
  };

  const openBulkAction = (action: ContentBulkAction) => {
    if (
      isListInteractionLocked ||
      !availableBulkActions.includes(action) ||
      selectedDocuments.length === 0
    ) {
      return;
    }

    setRowActionError(null);
    setBulkOperationBanner(null);
    setMoveTargetDirectory("");
    setMoveTargetDirectoryError(null);
    setActiveBulkAction(action);
  };

  const closeBulkAction = () => {
    if (bulkOperationMutation.isPending) return;

    setActiveBulkAction(null);
    setMoveTargetDirectory("");
    setMoveTargetDirectoryError(null);
  };

  const confirmBulkAction = () => {
    if (!activeBulkAction || isListInteractionLocked) return;

    if (activeBulkAction === "move") {
      const validation = validateBulkMoveTargetDirectory(moveTargetDirectory);
      if (!validation.ok) {
        setMoveTargetDirectoryError(validation.message);
        return;
      }

      bulkOperationMutation.mutate({
        action: activeBulkAction,
        targetDirectory: validation.value,
      });
      return;
    }

    bulkOperationMutation.mutate({ action: activeBulkAction });
  };

  const updateMoveTargetDirectory = (value: string) => {
    setMoveTargetDirectory(value);
    setMoveTargetDirectoryError(null);
  };

  const dismissBulkOperationBanner = () => {
    setBulkOperationBanner(null);
  };

  const rowActionHandlers = {
    onEdit: (documentId: string) =>
      push(`/admin/content/${typeId}/${documentId}`),
    onPublish: (documentId: string) => publishMutation.mutate(documentId),
    onUnpublish: (documentId: string) => unpublishMutation.mutate(documentId),
    onDuplicate: (documentId: string) => duplicateMutation.mutate(documentId),
    onDelete: (documentId: string) => deleteMutation.mutate(documentId),
  };

  return {
    activeBulkAction,
    activeBulkTargets,
    allRenderedSelected,
    availableBulkActions,
    bulkOperationBanner,
    capabilities,
    closeBulkAction,
    confirmBulkAction,
    create,
    currentPage,
    dismissBulkOperationBanner,
    isListInteractionLocked,
    list,
    mountInfo,
    moveTargetDirectory,
    moveTargetDirectoryError,
    openBulkAction,
    presenceByDocumentId,
    rowActionError,
    rowActionHandlers,
    schemaEntry,
    searchInput,
    selectedDocuments,
    selectedDocumentIds,
    setRowActionError,
    setSearchInput,
    showLoading,
    showTranslationCoverage,
    someRenderedSelected,
    tableColumns,
    toggleDocumentSelection,
    toggleRenderedSelection,
    totalPages,
    typeId,
    typeName,
    updateMoveTargetDirectory,
    push,
  };
}

function ContentTypePageView({
  activeBulkAction,
  activeBulkTargets,
  allRenderedSelected,
  availableBulkActions,
  bulkOperationBanner,
  capabilities,
  closeBulkAction,
  confirmBulkAction,
  create,
  currentPage,
  dismissBulkOperationBanner,
  isListInteractionLocked,
  list,
  mountInfo,
  moveTargetDirectory,
  moveTargetDirectoryError,
  openBulkAction,
  rowActionError,
  presenceByDocumentId,
  rowActionHandlers,
  schemaEntry,
  searchInput,
  selectedDocuments,
  selectedDocumentIds,
  setRowActionError,
  setSearchInput,
  showLoading,
  showTranslationCoverage,
  someRenderedSelected,
  tableColumns,
  toggleDocumentSelection,
  toggleRenderedSelection,
  totalPages,
  typeId,
  typeName,
  updateMoveTargetDirectory,
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
            <Button onClick={create.open} disabled={isListInteractionLocked}>
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
                disabled={isListInteractionLocked}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9 w-72"
              />
            </div>
            <Select
              value={list.filters.status ?? "all"}
              disabled={isListInteractionLocked}
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
            disabled={isListInteractionLocked}
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

        <ContentBulkToolbar
          selectedCount={selectedDocuments.length}
          availableActions={availableBulkActions}
          pending={isListInteractionLocked}
          onAction={openBulkAction}
        />

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

        {bulkOperationBanner && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3">
            <p className="text-sm text-destructive">
              {bulkOperationBanner.succeeded} succeeded,{" "}
              {bulkOperationBanner.failed} failed. First failure:{" "}
              {bulkOperationBanner.message}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={dismissBulkOperationBanner}
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
              <Button onClick={create.open} disabled={isListInteractionLocked}>
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
                pendingRowAction={isListInteractionLocked}
                selectedDocumentIds={selectedDocumentIds}
                allRenderedSelected={allRenderedSelected}
                someRenderedSelected={someRenderedSelected}
                selectionDisabled={isListInteractionLocked}
                showTranslationCoverage={showTranslationCoverage}
                translationCoverageStatus={list.translationCoverageStatus}
                translationCoverageByGroup={list.translationCoverageByGroup}
                tableColumns={tableColumns}
                presenceByDocumentId={presenceByDocumentId}
                onToggleDocumentSelected={toggleDocumentSelection}
                onToggleRenderedSelection={toggleRenderedSelection}
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
                disabled={isListInteractionLocked}
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
      <BulkOperationConfirmationDialog
        action={activeBulkAction}
        selectedCount={selectedDocuments.length}
        targetCount={activeBulkTargets.length}
        moveTargetDirectory={moveTargetDirectory}
        moveTargetDirectoryError={moveTargetDirectoryError}
        pending={isListInteractionLocked}
        onMoveTargetDirectoryChange={updateMoveTargetDirectory}
        onCancel={closeBulkAction}
        onConfirm={confirmBulkAction}
      />
    </div>
  );
}

export default function ContentTypePage() {
  const viewProps = useContentTypePageController();
  return <ContentTypePageView {...viewProps} />;
}
