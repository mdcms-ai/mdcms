"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RuntimeError,
  type MediaAsset,
  type MediaAssetCategory,
} from "@mdcms/shared";
import {
  AlertCircle,
  Check,
  Clipboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileSearch,
  Loader2,
  Music,
  Play,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "../../components/ui/pagination.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { Avatar, AvatarFallback } from "../../components/ui/avatar.js";
import { PageHeader } from "../../components/layout/page-header.js";
import {
  createStudioMediaLibraryApi,
  type StudioMediaLibraryListQuery,
} from "../../lib/media-library-api.js";
import { createStudioMediaUploadApi } from "../../lib/media-upload-api.js";
import type { StudioRuntimeAuth } from "../../../request-auth.js";
import {
  useCanDeleteMedia,
  useCanManageUsers,
  useCanReadMedia,
  useCanUploadMedia,
} from "./capabilities-context.js";
import {
  createStudioUsersApi,
  type UserWithGrants,
} from "../../../users-api.js";
import {
  deriveMediaLibraryEmptyState,
  formatMediaAssetBytes,
  formatMediaAssetDate,
  getMediaAssetCategory,
  getMediaAssetCategoryLabel,
  hasActiveMediaLibraryFilters,
  mapMediaLibrarySortOptionToQuery,
  type MediaLibraryFilters,
  type MediaLibrarySortOption,
} from "./media-library-model.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import { useStudioSession } from "./session-context.js";

export const MEDIA_LIBRARY_PAGE_SIZE = 30;

type MediaLibraryQueryKeyInput = {
  project: string;
  environment: string;
  serverUrl: string;
  authMode: string;
  authCacheKey: string | null;
  filters: MediaLibraryFilters;
  sort: MediaLibrarySortOption;
  offset: number;
};

type MediaLibraryTargetKeyInput = {
  project: string;
  environment: string;
  serverUrl: string;
};

type MediaLibraryOffsetState = {
  targetKey: string | null;
  offset: number;
};

type MediaLibraryPaginationData = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

type MediaLibraryUserSummary = Pick<UserWithGrants, "id" | "name" | "email">;

type MediaLibraryUploaderDisplay = {
  id: string;
  label: string;
  secondaryLabel: string | null;
  initials: string;
};

export type MediaLibraryEmptyPageState = {
  status: "empty" | "no-match";
  assets: MediaAsset[];
  pagination: MediaLibraryPaginationData;
};

export type MediaLibraryReadyPageState = {
  status: "ready";
  assets: MediaAsset[];
  pagination: MediaLibraryPaginationData;
};

export type MediaLibraryPageState =
  | { status: "unavailable"; message: string }
  | { status: "forbidden"; message: string }
  | { status: "loading" }
  | MediaLibraryEmptyPageState
  | MediaLibraryReadyPageState
  | { status: "error"; message: string };

export type MediaLibraryUploadFileProgress = {
  name: string;
  status: "pending" | "uploading" | "done" | "error";
  percent: number;
};

export type MediaLibraryUploadState =
  | { status: "idle" }
  | {
      status: "uploading";
      completedFiles: number;
      totalFiles: number;
      files?: MediaLibraryUploadFileProgress[];
    }
  | { status: "error"; message: string };

const defaultFilters: MediaLibraryFilters = {
  q: "",
  category: "all",
  uploadedBy: "",
  uploadedFrom: "",
  uploadedTo: "",
};

const categoryOptions: Array<{
  value: MediaLibraryFilters["category"];
  label: string;
}> = [
  { value: "all", label: "All types" },
  { value: "image", label: "Images" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Documents" },
  { value: "archive", label: "Archives" },
  { value: "other", label: "Other" },
];

const sortOptions: Array<{ value: MediaLibrarySortOption; label: string }> = [
  { value: "newest", label: "Recent" },
  { value: "oldest", label: "Oldest" },
  { value: "name-asc", label: "Name A-Z" },
  { value: "name-desc", label: "Name Z-A" },
  { value: "size-desc", label: "Largest first" },
  { value: "size-asc", label: "Smallest first" },
];

export function createMediaLibraryQueryKey(input: MediaLibraryQueryKeyInput) {
  return [
    "studio",
    "media-library",
    input.project,
    input.environment,
    input.serverUrl,
    input.authMode,
    input.authCacheKey,
    input.filters.q,
    input.filters.category,
    input.filters.uploadedBy,
    input.filters.uploadedFrom,
    input.filters.uploadedTo,
    input.sort,
    MEDIA_LIBRARY_PAGE_SIZE,
    input.offset,
  ] as const;
}

export function createMediaLibraryTargetKey(
  input: MediaLibraryTargetKeyInput,
): string {
  return [input.project, input.environment, input.serverUrl].join("\u0000");
}

export function createMediaLibraryAuthCacheKey(
  auth: StudioRuntimeAuth,
): string | null {
  return auth.mode === "token" ? (auth.token ?? null) : null;
}

export function resolveMediaLibraryEffectiveOffset(
  targetKey: string | null,
  offsetState: MediaLibraryOffsetState,
): number {
  return targetKey !== null && offsetState.targetKey === targetKey
    ? offsetState.offset
    : 0;
}

function createMediaLibraryListQuery(input: {
  filters: MediaLibraryFilters;
  sort: MediaLibrarySortOption;
  offset: number;
}): StudioMediaLibraryListQuery {
  const sortQuery = mapMediaLibrarySortOptionToQuery(input.sort);
  const q = input.filters.q.trim();
  const uploadedBy = input.filters.uploadedBy.trim();
  const uploadedFrom = input.filters.uploadedFrom.trim();
  const uploadedTo = input.filters.uploadedTo.trim();

  return {
    ...(q ? { q } : {}),
    ...(input.filters.category === "all"
      ? {}
      : { category: input.filters.category }),
    ...(uploadedBy ? { uploadedBy } : {}),
    ...(uploadedFrom ? { uploadedFrom } : {}),
    ...(uploadedTo ? { uploadedTo } : {}),
    ...sortQuery,
    limit: MEDIA_LIBRARY_PAGE_SIZE,
    offset: input.offset,
  };
}

function isForbiddenError(error: unknown): boolean {
  return (
    error instanceof RuntimeError &&
    (error.statusCode === 401 || error.statusCode === 403)
  );
}

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function getMediaAssetExtension(filename: string): string {
  const extension = filename.split(".").pop()?.trim();

  return extension && extension !== filename ? extension.toUpperCase() : "FILE";
}

function getMediaLibrarySortLabel(sort: MediaLibrarySortOption): string {
  return (
    sortOptions.find((option) => option.value === sort)?.label ??
    sortOptions[0]!.label
  );
}

function getMediaLibraryFilterCount(filters: MediaLibraryFilters): number {
  return [
    filters.category !== "all",
    filters.uploadedBy.trim().length > 0,
    filters.uploadedFrom.trim().length > 0,
    filters.uploadedTo.trim().length > 0,
  ].filter(Boolean).length;
}

function createMediaLibraryUserMap(
  users: readonly MediaLibraryUserSummary[],
): Map<string, MediaLibraryUserSummary> {
  const userMap = new Map<string, MediaLibraryUserSummary>();

  for (const user of users) {
    if (user.id.trim().length > 0) {
      userMap.set(user.id, user);
    }
  }

  return userMap;
}

function resolveMediaLibraryUploaderDisplay(
  uploadedBy: string,
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>,
): MediaLibraryUploaderDisplay {
  const id = uploadedBy.trim();
  const user = userMap.get(id);
  const name = user?.name.trim() ?? "";
  const email = user?.email.trim() ?? "";
  const label = name || email || id || "Unknown";

  return {
    id,
    label,
    secondaryLabel: email && email !== label ? email : null,
    initials: getUploaderInitials(label),
  };
}

function createMediaUploaderOptions(
  assets: readonly MediaAsset[],
  selectedUploadedBy: string,
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>,
): MediaLibraryUploaderDisplay[] {
  const uploaders = new Set<string>();

  for (const asset of assets) {
    if (asset.uploadedBy.trim().length > 0) {
      uploaders.add(asset.uploadedBy);
    }
  }

  if (selectedUploadedBy.trim().length > 0) {
    uploaders.add(selectedUploadedBy.trim());
  }

  return Array.from(uploaders)
    .map((uploader) => resolveMediaLibraryUploaderDisplay(uploader, userMap))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function getUploaderInitials(value: string): string {
  const words = value
    .replace(/[_@.-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  }

  return value.slice(0, 2).toUpperCase() || "?";
}

function collectMediaLibraryUploadFiles(
  files: FileList | readonly File[] | null | undefined,
): File[] {
  return files ? Array.from(files) : [];
}

function hasMediaLibraryFileDrag(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function resolveMediaLibraryUploadProgress(
  state: MediaLibraryUploadState,
): { completedFiles: number; totalFiles: number; percent: number } | null {
  if (state.status !== "uploading") {
    return null;
  }

  const totalFiles = Math.max(0, Math.floor(state.totalFiles));

  if (totalFiles === 0) {
    return null;
  }

  const completedFiles = Math.min(
    totalFiles,
    Math.max(0, Math.floor(state.completedFiles)),
  );

  return {
    completedFiles,
    totalFiles,
    percent: Math.round((completedFiles / totalFiles) * 100),
  };
}

function clickDownloadAnchor(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Downloads a media asset. Media URLs are cross-origin (CDN / object store), so
 * the `download` attribute is ignored and a bare anchor would navigate the
 * Studio document away. We fetch the asset into a same-origin blob URL so the
 * filename is honored; if the cross-origin fetch is blocked (CORS) we open the
 * asset in a new tab instead, which never destroys the Studio session.
 */
export async function triggerMediaAssetDownload(asset: {
  url: string;
  filename: string;
}): Promise<void> {
  if (typeof document === "undefined") {
    return;
  }

  try {
    const response = await fetch(asset.url);

    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}.`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    try {
      clickDownloadAnchor(objectUrl, asset.filename);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    if (typeof window !== "undefined") {
      window.open(asset.url, "_blank", "noopener,noreferrer");
    }
  }
}

export async function copyMediaAssetUrlToClipboard(url: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API not available.");
  }

  const textArea = document.createElement("textarea");
  const selection = document.getSelection();
  const selectedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textArea.value = url;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.inset = "0 auto auto -9999px";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    document.body.removeChild(textArea);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

function MediaLibraryTopbar({
  canUploadMedia,
  uploadState,
  searchInput,
  onUploadFiles,
  onSearchInputChange,
}: {
  canUploadMedia: boolean;
  uploadState: MediaLibraryUploadState;
  searchInput: string;
  onUploadFiles: (files: File[]) => void;
  onSearchInputChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-6 py-3 lg:px-8">
      <div className="relative w-full sm:max-w-xs">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
        <Input
          aria-label="Search media"
          className="h-9 rounded-md bg-background-subtle pl-9 font-mono text-xs"
          placeholder="Search media..."
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
        />
      </div>
      <div className="ml-auto flex items-center">
        <MediaLibraryUploadControl
          canUploadMedia={canUploadMedia}
          uploadState={uploadState}
          onUploadFiles={onUploadFiles}
        />
      </div>
    </div>
  );
}

function MediaLibraryControlsBar({
  state,
  filters,
  sort,
  assets,
  userMap,
  onFilterChange,
  onSortChange,
}: {
  state: MediaLibraryEmptyPageState | MediaLibraryReadyPageState;
  filters: MediaLibraryFilters;
  sort: MediaLibrarySortOption;
  assets: readonly MediaAsset[];
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>;
  onFilterChange: (patch: Partial<MediaLibraryFilters>) => void;
  onSortChange: (value: MediaLibrarySortOption) => void;
}) {
  const activeFilterCount = getMediaLibraryFilterCount(filters);
  const uploaderOptions = createMediaUploaderOptions(
    assets,
    filters.uploadedBy,
    userMap,
  );
  const selectedUploader = filters.uploadedBy.trim() || "__anyone";
  const countLabel = `${state.pagination.total} asset${
    state.pagination.total === 1 ? "" : "s"
  }`;

  return (
    <div className="flex flex-wrap items-center gap-3 px-6 py-4 lg:px-8">
      <span className="font-mono text-xs text-foreground-muted">
        {countLabel}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={[
                "h-8 gap-2 rounded border-border bg-card font-mono text-xs",
                activeFilterCount > 0 ? "border-primary text-primary" : "",
              ].join(" ")}
            >
              <span>Filters</span>
              {activeFilterCount > 0 ? (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
                  {activeFilterCount}
                </span>
              ) : null}
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 p-2">
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wide text-foreground-muted">
              Type
            </DropdownMenuLabel>
            <div className="flex flex-wrap gap-1.5 px-2 pb-2">
              {categoryOptions.map((option) => {
                const selected = filters.category === option.value;

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={[
                      "rounded border px-2.5 py-1.5 font-mono text-[11px] transition-colors",
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-foreground-muted hover:text-foreground",
                    ].join(" ")}
                    onClick={() => onFilterChange({ category: option.value })}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wide text-foreground-muted">
              Uploaded by
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selectedUploader}
              onValueChange={(value) =>
                onFilterChange({
                  uploadedBy: value === "__anyone" ? "" : value,
                })
              }
            >
              <DropdownMenuRadioItem value="__anyone">
                Anyone
              </DropdownMenuRadioItem>
              {uploaderOptions.map((uploader) => (
                <DropdownMenuRadioItem key={uploader.id} value={uploader.id}>
                  <Avatar className="size-5">
                    <AvatarFallback className="font-mono text-[10px]">
                      {uploader.initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate">{uploader.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="justify-end font-mono text-xs text-primary"
              onSelect={() =>
                onFilterChange({
                  category: "all",
                  uploadedBy: "",
                  uploadedFrom: "",
                  uploadedTo: "",
                })
              }
            >
              Clear all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-2 rounded border-border bg-card font-mono text-xs"
            >
              <span>Sort: {getMediaLibrarySortLabel(sort)}</span>
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {sortOptions.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => onSortChange(option.value)}
              >
                <span>{option.label}</span>
                {sort === option.value ? (
                  <Check className="ml-auto size-4 text-primary" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function MediaUploadFileRow({
  file,
}: {
  file: MediaLibraryUploadFileProgress;
}) {
  const extension = getMediaAssetExtension(file.name);
  const failed = file.status === "error";
  const done = file.status === "done";
  const statusLabel = failed
    ? "Failed"
    : done
      ? "Done"
      : file.status === "pending"
        ? "Queued"
        : `${Math.max(0, Math.min(100, Math.round(file.percent)))}%`;
  const barWidth = failed
    ? 100
    : done
      ? 100
      : Math.max(0, Math.min(100, file.percent));

  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[9px] font-semibold uppercase text-foreground-muted"
      >
        {extension}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {file.name}
          </span>
          <span
            className={[
              "shrink-0 font-mono text-[10px]",
              failed ? "text-destructive" : "text-foreground-muted",
            ].join(" ")}
          >
            {statusLabel}
          </span>
        </span>
        <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-border">
          <span
            className={[
              "block h-full rounded-full transition-[width]",
              failed ? "bg-destructive" : "bg-primary",
            ].join(" ")}
            style={{ width: `${barWidth}%` }}
          />
        </span>
      </span>
    </li>
  );
}

function MediaLibraryUploadControl({
  canUploadMedia,
  uploadState,
  onUploadFiles,
}: {
  canUploadMedia: boolean;
  uploadState: MediaLibraryUploadState;
  onUploadFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isUploading = uploadState.status === "uploading";
  const progress = resolveMediaLibraryUploadProgress(uploadState);
  const fileProgress =
    uploadState.status === "uploading" ? uploadState.files : undefined;
  const statusText = progress
    ? `Uploading media ${progress.completedFiles} of ${progress.totalFiles}`
    : "Uploading media...";

  if (!canUploadMedia) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        aria-label="Upload media files"
        type="file"
        multiple
        disabled={isUploading}
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          const files = collectMediaLibraryUploadFiles(
            event.currentTarget.files,
          );
          event.currentTarget.value = "";
          onUploadFiles(files);
        }}
      />
      <Button
        type="button"
        variant="default"
        disabled={isUploading}
        size="sm"
        className="gap-2"
        onClick={() => inputRef.current?.click()}
      >
        {isUploading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Upload className="size-4" />
        )}
        Upload
      </Button>
      {isUploading ? (
        <div
          data-mdcms-media-upload-progress="docked"
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-50 w-[min(22rem,calc(100vw-3rem))] rounded-lg border border-border bg-background p-4 text-sm shadow-xl"
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="font-medium text-foreground">Uploading assets</p>
              <p className="mt-0.5 text-xs text-foreground-muted">
                {statusText}
              </p>
            </div>
            {progress ? (
              <span className="font-mono text-xs text-foreground-muted">
                {progress.percent}%
              </span>
            ) : null}
          </div>
          {progress ? (
            <div
              role="progressbar"
              aria-label="Media upload progress"
              aria-valuemin={0}
              aria-valuemax={progress.totalFiles}
              aria-valuenow={progress.completedFiles}
              className="h-1.5 overflow-hidden rounded-full bg-border"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          ) : null}
          {fileProgress && fileProgress.length > 0 ? (
            <ul className="mt-3 space-y-2.5">
              {fileProgress.map((file, index) => (
                <MediaUploadFileRow key={`${file.name}-${index}`} file={file} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {uploadState.status === "error" ? (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed bottom-6 right-6 z-50 w-[min(22rem,calc(100vw-3rem))] rounded-md border border-destructive/20 bg-background px-3 py-2 text-sm text-destructive shadow-xl"
        >
          {uploadState.message}
        </div>
      ) : null}
    </div>
  );
}

function MediaLibraryStatePanel({
  state,
  onRetry,
}: {
  state: Exclude<
    MediaLibraryPageState,
    { status: "ready" | "empty" | "no-match" }
  >;
  onRetry: () => void;
}) {
  if (state.status === "loading") {
    return (
      <section
        data-mdcms-media-library-state="loading"
        className="flex items-center justify-center py-16"
        role="status"
      >
        <Loader2 className="mr-2 size-5 animate-spin text-foreground-muted" />
        <span className="text-sm text-foreground-muted">
          Loading media assets...
        </span>
      </section>
    );
  }

  if (state.status === "forbidden") {
    return (
      <section
        data-mdcms-media-library-state="forbidden"
        className="flex flex-col items-center justify-center py-16 text-center"
      >
        <ShieldAlert className="mb-4 size-8 text-foreground-muted" />
        <h3 className="mb-2 text-lg font-semibold">Access denied</h3>
        <p className="max-w-md text-sm text-foreground-muted">
          {state.message}
        </p>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section
        data-mdcms-media-library-state="unavailable"
        className="flex flex-col items-center justify-center py-16 text-center"
        role="alert"
      >
        <AlertCircle className="mb-4 size-8 text-foreground-muted" />
        <h3 className="mb-2 text-lg font-semibold">
          Media library unavailable
        </h3>
        <p className="max-w-md text-sm text-foreground-muted">
          {state.message}
        </p>
      </section>
    );
  }

  return (
    <section
      data-mdcms-media-library-state="error"
      className="flex flex-col items-center justify-center py-16 text-center"
      role="alert"
    >
      <AlertCircle className="mb-4 size-8 text-destructive" />
      <h3 className="mb-2 text-lg font-semibold">
        Failed to load media library
      </h3>
      <p className="mb-4 max-w-md text-sm text-foreground-muted">
        {state.message}
      </p>
      <Button type="button" variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </section>
  );
}

function MediaLibraryEmptyPanel({
  state,
  isDragActive = false,
  canUploadMedia = false,
  onUploadFiles,
}: {
  state: MediaLibraryEmptyPageState;
  isDragActive?: boolean;
  canUploadMedia?: boolean;
  onUploadFiles?: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const emptyState = deriveMediaLibraryEmptyState(state.status === "no-match");

  if (state.status === "no-match") {
    return (
      <section
        data-mdcms-media-library-state="no-match"
        className="flex min-h-[24rem] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 px-6 py-16 text-center"
      >
        <div className="mb-4 rounded-full border border-border bg-card p-4 shadow-sm">
          <FileSearch className="size-7 text-foreground-muted" />
        </div>
        <h3 className="mb-1.5 font-heading text-xl font-bold text-foreground">
          {emptyState.title}
        </h3>
        <p className="max-w-sm text-sm text-foreground-muted">
          {emptyState.description}
        </p>
      </section>
    );
  }

  const panelClassName = [
    "relative isolate flex min-h-[26rem] flex-1 overflow-hidden rounded-2xl border-2 border-dashed bg-card transition-colors",
    isDragActive ? "border-primary bg-accent-subtle" : "border-border/70",
  ].join(" ");

  return (
    <section data-mdcms-media-library-state="empty" className={panelClassName}>
      <div
        aria-hidden="true"
        className="absolute inset-0 grid grid-cols-2 gap-4 p-6 opacity-50 sm:grid-cols-4 lg:grid-cols-5"
      >
        {Array.from({ length: 15 }).map((_, index) => (
          <div
            key={index}
            className="rounded-lg border border-dashed border-border/50"
            style={{
              backgroundImage:
                "repeating-linear-gradient(135deg, transparent 0 11px, rgba(120,120,135,0.06) 11px 12px)",
            }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 55% at 50% 46%, var(--card) 42%, transparent 78%)",
        }}
      />
      <div className="relative m-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
          <Upload className="size-6" />
        </div>
        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.12em] text-primary">
          Media library
        </p>
        <h3 className="font-heading text-[28px] font-bold leading-tight tracking-tight text-foreground">
          {emptyState.title}
        </h3>
        <p className="mt-3 max-w-sm text-sm leading-relaxed text-foreground-muted">
          {emptyState.description}
        </p>
        {canUploadMedia && onUploadFiles ? (
          <>
            <input
              ref={inputRef}
              aria-label="Upload media files"
              type="file"
              multiple
              tabIndex={-1}
              className="sr-only"
              onChange={(event) => {
                const files = collectMediaLibraryUploadFiles(
                  event.currentTarget.files,
                );
                event.currentTarget.value = "";
                onUploadFiles(files);
              }}
            />
            <Button
              type="button"
              className="mt-6 gap-2"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="size-4" />
              Upload files
            </Button>
          </>
        ) : null}
        <p className="mt-5 font-mono text-[11px] text-foreground-muted">
          PNG · JPG · SVG · MP4 · PDF
        </p>
      </div>
    </section>
  );
}

const MEDIA_KIND_CHIP_STYLES: Record<MediaAssetCategory, string> = {
  image: "bg-accent-subtle text-primary",
  video: "bg-muted text-foreground",
  audio: "bg-muted text-foreground-muted",
  document: "bg-destructive/10 text-destructive",
  archive: "bg-muted text-foreground-muted",
  other: "bg-muted text-foreground-muted",
};

function MediaKindChip({ category }: { category: MediaAssetCategory }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide",
        MEDIA_KIND_CHIP_STYLES[category],
      ].join(" ")}
    >
      {getMediaAssetCategoryLabel(category)}
    </span>
  );
}

function MediaAssetActions({
  asset,
  onCopyUrl,
  overlay = false,
}: {
  asset: MediaAsset;
  onCopyUrl: (url: string) => void;
  overlay?: boolean;
}) {
  const buttonClassName = overlay
    ? "size-7 bg-card/90 text-foreground-muted shadow-sm hover:text-primary"
    : "size-8";
  const stop = (event: ReactMouseEvent<HTMLButtonElement>) =>
    event.stopPropagation();

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        aria-label={`Open asset ${asset.filename}`}
        onClick={(event) => {
          stop(event);
          window.open(asset.url, "_blank", "noopener,noreferrer");
        }}
      >
        <ExternalLink className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        aria-label={`Copy asset URL for ${asset.filename}`}
        onClick={(event) => {
          stop(event);
          onCopyUrl(asset.url);
        }}
      >
        <Clipboard className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={buttonClassName}
        aria-label={`Download asset ${asset.filename}`}
        onClick={(event) => {
          stop(event);
          void triggerMediaAssetDownload(asset);
        }}
      >
        <Download className="size-4" />
      </Button>
    </div>
  );
}

function MediaAssetPreview({
  asset,
  category,
  variant = "card",
}: {
  asset: MediaAsset;
  category: ReturnType<typeof getMediaAssetCategory>;
  variant?: "card" | "drawer";
}) {
  const previewFrameClassName =
    variant === "drawer"
      ? "flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted"
      : "flex h-[132px] w-full items-center justify-center overflow-hidden rounded-md bg-muted";

  if (category === "image") {
    return (
      <div className={previewFrameClassName}>
        <img
          src={asset.url}
          alt={`${asset.filename} preview`}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </div>
    );
  }

  if (category === "video") {
    return (
      <div className={previewFrameClassName}>
        <video
          controls
          preload="metadata"
          aria-label={`Preview video ${asset.filename}`}
          className="h-full w-full bg-black object-contain"
          onClick={(event) => event.stopPropagation()}
        >
          <source src={asset.url} type={asset.mimeType} />
        </video>
      </div>
    );
  }

  if (category === "audio") {
    return (
      <div className={`${previewFrameClassName} gap-3 px-3`}>
        <Music className="size-5 shrink-0 text-foreground-muted" />
        <audio
          controls
          preload="metadata"
          aria-label={`Preview audio ${asset.filename}`}
          className="min-w-0 flex-1"
          onClick={(event) => event.stopPropagation()}
        >
          <source src={asset.url} type={asset.mimeType} />
        </audio>
      </div>
    );
  }

  return (
    <div
      aria-label={`Preview unavailable for ${asset.filename}`}
      className={`${previewFrameClassName} flex-col px-2 text-center text-xs text-foreground-muted`}
    >
      {category === "document" ? (
        <File className="mb-2 size-6" />
      ) : (
        <Play className="mb-2 size-6" />
      )}
      <span className="max-w-full truncate">
        {getMediaAssetCategoryLabel(category)}
      </span>
    </div>
  );
}

function MediaPropertyRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="font-mono text-[11px] text-foreground-muted">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end font-mono text-[11px] text-foreground">
        {children}
      </dd>
    </div>
  );
}

function MediaAssetCard({
  asset,
  selected,
  selectable = false,
  checked = false,
  userMap,
  onSelect,
  onToggleCheck,
  onCopyUrl,
}: {
  asset: MediaAsset;
  selected: boolean;
  selectable?: boolean;
  checked?: boolean;
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>;
  onSelect: (asset: MediaAsset) => void;
  onToggleCheck?: (asset: MediaAsset) => void;
  onCopyUrl: (url: string) => void;
}) {
  const category = getMediaAssetCategory(asset);
  const uploader = resolveMediaLibraryUploaderDisplay(
    asset.uploadedBy,
    userMap,
  );
  const cardClassName = [
    "group cursor-pointer select-none overflow-hidden rounded-[10px] border bg-card p-2 transition-colors",
    checked
      ? "border-primary shadow-sm ring-1 ring-primary"
      : selected
        ? "border-primary shadow-sm ring-1 ring-primary/30"
        : "border-border/60 hover:border-border hover:shadow-sm",
  ].join(" ");

  return (
    <article className={cardClassName} onClick={() => onSelect(asset)}>
      <div className="relative">
        <MediaAssetPreview asset={asset} category={category} />
        <span className="absolute left-2 top-2 rounded-sm border border-border/50 bg-card/90 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide text-foreground-muted shadow-sm">
          {getMediaAssetExtension(asset.filename)}
        </span>
        {selectable ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`Select ${asset.filename} for bulk actions`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCheck?.(asset);
            }}
            className={[
              "absolute right-2 top-2 flex size-5 items-center justify-center rounded border bg-card/90 shadow-sm transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              checked
                ? "border-primary bg-primary text-primary-foreground opacity-100"
                : "border-border text-transparent opacity-0 group-hover:opacity-100",
            ].join(" ")}
          >
            <Check className="size-3.5" />
          </button>
        ) : null}
        <div className="absolute bottom-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
          <MediaAssetActions asset={asset} onCopyUrl={onCopyUrl} overlay />
        </div>
      </div>
      <div className="px-0.5 pb-0.5 pt-2.5">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Select asset ${asset.filename}`}
          className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(asset);
          }}
        >
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {asset.filename}
          </span>
        </button>
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-foreground-muted">
          <MediaKindChip category={category} />
          <span>{formatMediaAssetBytes(asset.sizeBytes)}</span>
          <span
            className="ml-auto flex min-w-0 items-center gap-1"
            title={uploader.secondaryLabel ?? uploader.label}
          >
            <Avatar className="size-4">
              <AvatarFallback className="font-mono text-[8px]">
                {uploader.initials}
              </AvatarFallback>
            </Avatar>
            <span className="truncate">{uploader.label}</span>
          </span>
        </div>
      </div>
    </article>
  );
}

function MediaAssetDetailDrawer({
  asset,
  userMap,
  onCopyUrl,
  onClose,
}: {
  asset: MediaAsset | null;
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>;
  onCopyUrl: (url: string) => void;
  onClose?: () => void;
}) {
  if (!asset) {
    return (
      <aside
        aria-label="Asset details"
        className="flex min-h-0 w-full shrink-0 items-center justify-center border-t border-border bg-card p-6 text-center lg:w-[340px] lg:border-l lg:border-t-0"
      >
        <p className="max-w-52 text-sm text-foreground-muted">
          Select an asset to inspect its metadata.
        </p>
      </aside>
    );
  }

  const category = getMediaAssetCategory(asset);
  const uploader = resolveMediaLibraryUploaderDisplay(
    asset.uploadedBy,
    userMap,
  );

  return (
    <aside
      aria-label="Asset details"
      className="flex min-h-0 w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-card lg:w-[340px] lg:border-l lg:border-t-0"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card px-5 py-4">
        <p className="font-mono text-[10px] uppercase tracking-wide text-foreground-muted">
          Asset details
        </p>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mr-1.5 size-7"
            aria-label="Close asset details"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      <div className="border-b border-border p-5">
        <MediaAssetPreview asset={asset} category={category} variant="drawer" />
        <h2 className="mt-4 break-words text-[15px] font-semibold text-foreground">
          {asset.filename}
        </h2>
      </div>

      <div className="flex-1 p-5">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wide text-foreground-muted">
          Properties
        </p>
        <dl>
          <MediaPropertyRow label="kind">
            <MediaKindChip category={category} />
          </MediaPropertyRow>
          <MediaPropertyRow label="size">
            {formatMediaAssetBytes(asset.sizeBytes)}
          </MediaPropertyRow>
          <MediaPropertyRow label="type">
            <span className="truncate">{asset.mimeType}</span>
          </MediaPropertyRow>
          <MediaPropertyRow label="uploaded">
            {formatMediaAssetDate(asset.uploadedAt, "en-US")}
          </MediaPropertyRow>
          <MediaPropertyRow label="by">
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar className="size-4">
                <AvatarFallback className="font-mono text-[8px]">
                  {uploader.initials}
                </AvatarFallback>
              </Avatar>
              <span
                className="truncate"
                title={uploader.secondaryLabel ?? uploader.label}
              >
                {uploader.label}
              </span>
            </span>
          </MediaPropertyRow>
          <MediaPropertyRow label="asset id">
            <span className="truncate">{asset.id}</span>
          </MediaPropertyRow>
        </dl>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border p-4">
        <span className="font-mono text-[10px] uppercase tracking-wide text-foreground-muted">
          Actions
        </span>
        <MediaAssetActions asset={asset} onCopyUrl={onCopyUrl} />
      </div>
    </aside>
  );
}

function MediaLibraryGallery({
  assets,
  selectedAsset,
  selectable = false,
  checkedIds,
  userMap,
  onSelectAsset,
  onToggleCheck,
  onCopyUrl,
}: {
  assets: MediaAsset[];
  selectedAsset: MediaAsset | null;
  selectable?: boolean;
  checkedIds?: ReadonlySet<string>;
  userMap: ReadonlyMap<string, MediaLibraryUserSummary>;
  onSelectAsset: (asset: MediaAsset) => void;
  onToggleCheck?: (asset: MediaAsset) => void;
  onCopyUrl: (url: string) => void;
}) {
  return (
    <div
      data-mdcms-media-library-layout="gallery"
      className="grid grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-4"
    >
      {assets.map((asset) => (
        <MediaAssetCard
          key={asset.id}
          asset={asset}
          selected={selectedAsset?.id === asset.id}
          selectable={selectable}
          checked={checkedIds?.has(asset.id) ?? false}
          userMap={userMap}
          onSelect={onSelectAsset}
          onToggleCheck={onToggleCheck}
          onCopyUrl={onCopyUrl}
        />
      ))}
    </div>
  );
}

function MediaLibraryPagination({
  pagination,
  onPageChange,
}: {
  pagination: MediaLibraryPaginationData;
  onPageChange: (offset: number) => void;
}) {
  const totalPages = Math.ceil(pagination.total / MEDIA_LIBRARY_PAGE_SIZE);
  const currentPage =
    Math.floor(pagination.offset / MEDIA_LIBRARY_PAGE_SIZE) + 1;
  const maxOffset = Math.max(0, (totalPages - 1) * MEDIA_LIBRARY_PAGE_SIZE);
  const clamp = (value: number) => Math.max(0, Math.min(value, maxOffset));
  const visibleCount = Math.min(5, totalPages);
  const windowStart = Math.max(
    1,
    Math.min(currentPage - 2, totalPages - visibleCount + 1),
  );

  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-foreground-muted">
        Showing {pagination.offset + 1}-
        {Math.min(
          pagination.offset + MEDIA_LIBRARY_PAGE_SIZE,
          pagination.total,
        )}{" "}
        of {pagination.total} media assets
      </p>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Go to previous page"
              disabled={currentPage === 1}
              onClick={() =>
                onPageChange(clamp(pagination.offset - MEDIA_LIBRARY_PAGE_SIZE))
              }
              className="gap-1 px-2.5"
            >
              <ChevronLeft className="size-4" />
              <span className="hidden sm:block">Previous</span>
            </Button>
          </PaginationItem>
          {Array.from({ length: visibleCount }).map((_, index) => {
            const page = windowStart + index;

            return (
              <PaginationItem key={page}>
                <Button
                  type="button"
                  variant={currentPage === page ? "default" : "ghost"}
                  size="icon"
                  aria-current={currentPage === page ? "page" : undefined}
                  aria-label={`Go to page ${page}`}
                  onClick={() =>
                    onPageChange(clamp((page - 1) * MEDIA_LIBRARY_PAGE_SIZE))
                  }
                >
                  {page}
                </Button>
              </PaginationItem>
            );
          })}
          <PaginationItem>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Go to next page"
              disabled={currentPage === totalPages}
              onClick={() =>
                onPageChange(clamp(pagination.offset + MEDIA_LIBRARY_PAGE_SIZE))
              }
              className="gap-1 px-2.5"
            >
              <span className="hidden sm:block">Next</span>
              <ChevronRight className="size-4" />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

function MediaLibraryBulkBar({
  selectedCount,
  isDeleting,
  errorMessage,
  onDownload,
  onConfirmDelete,
  onClear,
}: {
  selectedCount: number;
  isDeleting: boolean;
  errorMessage: string | null;
  onDownload: () => void;
  onConfirmDelete: () => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      data-mdcms-media-bulk-bar=""
      role="region"
      aria-label="Bulk media actions"
      className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-3rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-xl"
    >
      <span className="font-mono text-xs font-semibold text-foreground">
        {selectedCount} selected
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5"
        disabled={isDeleting}
        onClick={onDownload}
      >
        <Download className="size-4" />
        Download
      </Button>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-muted">
            Delete {selectedCount} asset{selectedCount === 1 ? "" : "s"}?
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="h-8 gap-1.5"
            disabled={isDeleting}
            onClick={onConfirmDelete}
          >
            {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm delete
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            disabled={isDeleting}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-destructive hover:text-destructive"
          disabled={isDeleting}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
      )}
      {errorMessage ? (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="ml-auto size-8"
        aria-label="Clear media selection"
        disabled={isDeleting}
        onClick={onClear}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

export function MediaLibraryPageView({
  state,
  canUploadMedia,
  canDeleteMedia = false,
  uploadState,
  filters,
  searchInput,
  sort,
  userSummaries = [],
  onUploadFiles,
  onSearchInputChange,
  onFilterChange,
  onSortChange,
  onPageChange,
  onRetry,
  onCopyUrl,
  onDeleteAssets,
}: {
  state: MediaLibraryPageState;
  canUploadMedia: boolean;
  canDeleteMedia?: boolean;
  uploadState: MediaLibraryUploadState;
  filters: MediaLibraryFilters;
  searchInput: string;
  sort: MediaLibrarySortOption;
  userSummaries?: readonly MediaLibraryUserSummary[];
  onUploadFiles: (files: File[]) => void;
  onSearchInputChange: (value: string) => void;
  onFilterChange: (patch: Partial<MediaLibraryFilters>) => void;
  onSortChange: (value: MediaLibrarySortOption) => void;
  onPageChange: (offset: number) => void;
  onRetry: () => void;
  onCopyUrl: (url: string) => void;
  onDeleteAssets?: (assets: MediaAsset[]) => void | Promise<void>;
}) {
  const readyAssets = state.status === "ready" ? state.assets : [];
  const userMap = useMemo(
    () => createMediaLibraryUserMap(userSummaries),
    [userSummaries],
  );
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(true);
  const selectedAsset =
    readyAssets.find((asset) => asset.id === selectedAssetId) ??
    readyAssets[0] ??
    null;
  const isSelectable = canDeleteMedia;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const readyAssetIdsKey = readyAssets.map((asset) => asset.id).join("\u0000");
  const bulkSelectedAssets = readyAssets.filter((asset) =>
    selectedIds.has(asset.id),
  );

  useEffect(() => {
    setSelectedIds((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const visible = new Set(readyAssetIdsKey.split("\u0000"));
      const next = new Set<string>();
      let changed = false;

      for (const id of previous) {
        if (visible.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [readyAssetIdsKey]);

  const handleToggleCheck = useCallback((asset: MediaAsset) => {
    setDeleteError(null);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else {
        next.add(asset.id);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setDeleteError(null);
  }, []);

  const handleBulkDownload = useCallback(() => {
    void (async () => {
      // Sequence downloads so each blob fetch / new-tab fallback completes
      // before the next, avoiding the prior synchronous loop that clobbered
      // all but the first asset.
      for (const asset of bulkSelectedAssets) {
        await triggerMediaAssetDownload(asset);
      }
    })();
  }, [bulkSelectedAssets]);

  const handleConfirmDelete = useCallback(() => {
    if (!onDeleteAssets || bulkSelectedAssets.length === 0) {
      return;
    }

    setIsDeleting(true);
    setDeleteError(null);
    void Promise.resolve(onDeleteAssets(bulkSelectedAssets))
      .then(() => {
        setSelectedIds(new Set());
      })
      .catch((error: unknown) => {
        setDeleteError(readErrorMessage(error, "Failed to delete media."));
      })
      .finally(() => {
        setIsDeleting(false);
      });
  }, [onDeleteAssets, bulkSelectedAssets]);

  const [isDragActive, setIsDragActive] = useState(false);
  const canDropUpload = canUploadMedia && uploadState.status !== "uploading";
  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!canDropUpload || !hasMediaLibraryFileDrag(event)) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragActive(true);
    },
    [canDropUpload],
  );
  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;

      if (
        nextTarget instanceof Node &&
        event.currentTarget.contains(nextTarget)
      ) {
        return;
      }

      setIsDragActive(false);
    },
    [],
  );
  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!canDropUpload || !hasMediaLibraryFileDrag(event)) {
        return;
      }

      event.preventDefault();
      setIsDragActive(false);
      onUploadFiles(collectMediaLibraryUploadFiles(event.dataTransfer.files));
    },
    [canDropUpload, onUploadFiles],
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PageHeader breadcrumbs={[{ label: "Media" }]} />

      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <MediaLibraryTopbar
          canUploadMedia={canUploadMedia}
          uploadState={uploadState}
          searchInput={searchInput}
          onUploadFiles={onUploadFiles}
          onSearchInputChange={onSearchInputChange}
        />

        {state.status === "unavailable" ||
        state.status === "forbidden" ||
        state.status === "loading" ||
        state.status === "error" ? (
          <div className="flex-1 overflow-auto p-6 lg:p-8">
            <MediaLibraryStatePanel state={state} onRetry={onRetry} />
          </div>
        ) : state.status === "empty" || state.status === "no-match" ? (
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="px-6 pt-7 lg:px-8">
              <h1 className="font-heading text-[36px] font-bold leading-[1.05] text-foreground">
                Media
              </h1>
              <p className="mt-1.5 font-mono text-xs text-foreground-muted">
                {state.pagination.total} assets
                {state.status === "empty" ? " · drop files to begin" : ""}
              </p>
            </div>
            {state.status === "no-match" ? (
              <MediaLibraryControlsBar
                state={state}
                filters={filters}
                sort={sort}
                assets={state.assets}
                userMap={userMap}
                onFilterChange={onFilterChange}
                onSortChange={onSortChange}
              />
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto p-6 lg:px-8">
              <MediaLibraryEmptyPanel
                state={state}
                isDragActive={isDragActive}
                canUploadMedia={canUploadMedia}
                onUploadFiles={onUploadFiles}
              />
            </div>
          </section>
        ) : (
          <section
            data-mdcms-media-library-state="ready"
            className="flex min-h-0 flex-1 overflow-hidden bg-background"
          >
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="px-6 pt-7 lg:px-8">
                <h1 className="font-heading text-[36px] font-bold leading-[1.05] text-foreground">
                  Media
                </h1>
              </div>
              <MediaLibraryControlsBar
                state={state}
                filters={filters}
                sort={sort}
                assets={state.assets}
                userMap={userMap}
                onFilterChange={onFilterChange}
                onSortChange={onSortChange}
              />
              {isSelectable && selectedIds.size > 0 ? (
                <MediaLibraryBulkBar
                  selectedCount={selectedIds.size}
                  isDeleting={isDeleting}
                  errorMessage={deleteError}
                  onDownload={handleBulkDownload}
                  onConfirmDelete={handleConfirmDelete}
                  onClear={handleClearSelection}
                />
              ) : null}
              <div className="relative min-h-0 flex-1 overflow-auto px-6 pb-8 pt-1 lg:px-8">
                <MediaLibraryGallery
                  assets={state.assets}
                  selectedAsset={isDrawerOpen ? selectedAsset : null}
                  selectable={isSelectable}
                  checkedIds={selectedIds}
                  userMap={userMap}
                  onSelectAsset={(asset) => {
                    setSelectedAssetId(asset.id);
                    setIsDrawerOpen(true);
                  }}
                  onToggleCheck={handleToggleCheck}
                  onCopyUrl={onCopyUrl}
                />
                {isDragActive && canDropUpload ? (
                  <div
                    data-mdcms-media-drop-overlay=""
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-accent-subtle/80 text-center backdrop-blur-[1px]"
                  >
                    <Upload className="size-7 text-primary" />
                    <p className="text-base font-semibold text-foreground">
                      Drop to upload
                    </p>
                    <p className="font-mono text-xs text-foreground-muted">
                      Files are added to this library
                    </p>
                  </div>
                ) : null}
              </div>
              {state.pagination.total > MEDIA_LIBRARY_PAGE_SIZE ? (
                <div className="border-t border-border px-6 py-3 lg:px-8">
                  <MediaLibraryPagination
                    pagination={state.pagination}
                    onPageChange={onPageChange}
                  />
                </div>
              ) : null}
            </div>
            {isDrawerOpen && selectedAsset ? (
              <MediaAssetDetailDrawer
                asset={selectedAsset}
                userMap={userMap}
                onCopyUrl={onCopyUrl}
                onClose={() => setIsDrawerOpen(false)}
              />
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}

export default function MediaPage() {
  const canReadMedia = useCanReadMedia();
  const canUploadMedia = useCanUploadMedia();
  const canDeleteMedia = useCanDeleteMedia();
  const canManageUsers = useCanManageUsers();
  const mountInfo = useStudioMountInfo();
  const sessionState = useStudioSession();
  const [filters, setFilters] = useState<MediaLibraryFilters>(defaultFilters);
  const [searchInput, setSearchInput] = useState(defaultFilters.q);
  const [sort, setSort] = useState<MediaLibrarySortOption>("newest");
  const [uploadState, setUploadState] = useState<MediaLibraryUploadState>({
    status: "idle",
  });
  const [offsetState, setOffsetState] = useState<MediaLibraryOffsetState>({
    targetKey: null,
    offset: 0,
  });

  const hasApiConfig = Boolean(
    mountInfo.project && mountInfo.environment && mountInfo.apiBaseUrl,
  );
  const targetKey = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl) {
      return null;
    }

    return createMediaLibraryTargetKey({
      project: mountInfo.project,
      environment: mountInfo.environment,
      serverUrl: mountInfo.apiBaseUrl,
    });
  }, [mountInfo.project, mountInfo.environment, mountInfo.apiBaseUrl]);
  const authCacheKey = createMediaLibraryAuthCacheKey(mountInfo.auth);
  const offset = resolveMediaLibraryEffectiveOffset(targetKey, offsetState);

  const queryKey = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl) {
      return null;
    }

    return createMediaLibraryQueryKey({
      project: mountInfo.project,
      environment: mountInfo.environment,
      serverUrl: mountInfo.apiBaseUrl,
      authMode: mountInfo.auth.mode,
      authCacheKey,
      filters,
      sort,
      offset,
    });
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth.mode,
    authCacheKey,
    filters,
    sort,
    offset,
  ]);

  const api = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl) {
      return null;
    }

    return createStudioMediaLibraryApi(
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
  const usersApi = useMemo(() => {
    if (!mountInfo.apiBaseUrl) {
      return null;
    }

    return createStudioUsersApi(
      { serverUrl: mountInfo.apiBaseUrl },
      { auth: mountInfo.auth },
    );
  }, [mountInfo.apiBaseUrl, mountInfo.auth]);
  const isMediaUploadAuthUsable =
    mountInfo.auth.mode === "token" || sessionState.status === "authenticated";
  const mediaUploadApi = useMemo(() => {
    if (
      !mountInfo.project ||
      !mountInfo.environment ||
      !mountInfo.apiBaseUrl ||
      !isMediaUploadAuthUsable
    ) {
      return null;
    }

    return createStudioMediaUploadApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      {
        auth: mountInfo.auth,
        csrfToken:
          sessionState.status === "authenticated"
            ? sessionState.csrfToken
            : null,
      },
    );
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
    isMediaUploadAuthUsable,
    sessionState,
  ]);
  const mediaDeleteApi = useMemo(() => {
    if (
      !mountInfo.project ||
      !mountInfo.environment ||
      !mountInfo.apiBaseUrl ||
      !isMediaUploadAuthUsable
    ) {
      return null;
    }

    return createStudioMediaLibraryApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      {
        auth: mountInfo.auth,
        csrfToken:
          sessionState.status === "authenticated"
            ? sessionState.csrfToken
            : null,
      },
    );
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
    isMediaUploadAuthUsable,
    sessionState,
  ]);

  const query = useQuery({
    queryKey: queryKey ?? ["media-library", "unavailable"],
    queryFn: () =>
      api!.list(createMediaLibraryListQuery({ filters, sort, offset })),
    enabled: canReadMedia && hasApiConfig && api !== null && queryKey !== null,
    retryOnMount: false,
  });
  const usersQuery = useQuery({
    queryKey: ["users", mountInfo.apiBaseUrl],
    queryFn: () => usersApi!.list(),
    enabled: canReadMedia && canManageUsers && usersApi !== null,
    retry: false,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setOffsetState({ targetKey, offset: 0 });
      setFilters((current) => ({ ...current, q: searchInput }));
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput, targetKey]);

  useEffect(() => {
    setOffsetState((current) =>
      current.targetKey === targetKey ? current : { targetKey, offset: 0 },
    );
    setUploadState({ status: "idle" });
  }, [targetKey]);

  const pageState = useMemo<MediaLibraryPageState>(() => {
    if (!hasApiConfig) {
      return {
        status: "unavailable",
        message:
          "Studio is missing project, environment, or server URL context.",
      };
    }

    if (!canReadMedia) {
      return {
        status: "forbidden",
        message: "You do not have permission to view media assets.",
      };
    }

    if (query.isError) {
      if (isForbiddenError(query.error)) {
        return {
          status: "forbidden",
          message: "You do not have permission to view media assets.",
        };
      }

      return {
        status: "error",
        message: readErrorMessage(query.error, "Media library request failed."),
      };
    }

    if (!query.data) {
      return { status: "loading" };
    }

    if (query.data.data.length === 0) {
      return {
        status: hasActiveMediaLibraryFilters(filters) ? "no-match" : "empty",
        assets: [],
        pagination: query.data.pagination,
      };
    }

    return {
      status: "ready",
      assets: query.data.data,
      pagination: query.data.pagination,
    };
  }, [
    canReadMedia,
    hasApiConfig,
    query.isError,
    query.error,
    query.data,
    filters,
  ]);

  const handleFilterChange = (patch: Partial<MediaLibraryFilters>) => {
    setOffsetState({ targetKey, offset: 0 });
    setFilters((current) => ({ ...current, ...patch }));
  };
  const handleSortChange = (value: MediaLibrarySortOption) => {
    setOffsetState({ targetKey, offset: 0 });
    setSort(value);
  };
  const handlePageChange = (newOffset: number) => {
    if (!targetKey) {
      return;
    }
    setOffsetState({ targetKey, offset: newOffset });
  };
  const handleCopyUrl = (url: string) => {
    void copyMediaAssetUrlToClipboard(url).catch(() => undefined);
  };
  const handleUploadFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      if (!canUploadMedia || mediaUploadApi === null) {
        setUploadState({
          status: "error",
          message: "You do not have permission to upload media assets.",
        });
        return;
      }

      const totalFiles = files.length;
      const fileProgress: MediaLibraryUploadFileProgress[] = files.map(
        (file) => ({ name: file.name, status: "pending", percent: 0 }),
      );
      const publish = (completedFiles: number) => {
        setUploadState({
          status: "uploading",
          completedFiles,
          totalFiles,
          files: fileProgress.map((entry) => ({ ...entry })),
        });
      };

      publish(0);

      void (async () => {
        let completedFiles = 0;
        let firstError: unknown = null;

        for (let index = 0; index < files.length; index += 1) {
          const entry = fileProgress[index]!;
          entry.status = "uploading";
          publish(completedFiles);

          try {
            await mediaUploadApi.upload(files[index]!, {
              onProgress: ({ loaded, total }) => {
                entry.percent =
                  total > 0 ? Math.round((loaded / total) * 100) : 0;
                publish(completedFiles);
              },
            });
            entry.status = "done";
            entry.percent = 100;
            completedFiles += 1;
          } catch (error) {
            entry.status = "error";
            firstError ??= error;
          }

          publish(completedFiles);
        }

        if (firstError !== null) {
          setUploadState({
            status: "error",
            message: readErrorMessage(firstError, "Media upload failed."),
          });
        } else {
          setUploadState({ status: "idle" });
        }

        await query.refetch();
      })();
    },
    [canUploadMedia, mediaUploadApi, query],
  );
  const handleDeleteAssets = useCallback(
    async (assets: MediaAsset[]) => {
      if (assets.length === 0) {
        return;
      }

      if (!canDeleteMedia || mediaDeleteApi === null) {
        throw new Error("You do not have permission to delete media assets.");
      }

      let failureCount = 0;
      let firstError: unknown = null;

      for (const asset of assets) {
        try {
          await mediaDeleteApi.delete(asset.id);
        } catch (error) {
          failureCount += 1;
          firstError ??= error;
        }
      }

      await query.refetch();

      if (failureCount > 0) {
        throw new RuntimeError({
          code: "MEDIA_BULK_DELETE_FAILED",
          message:
            failureCount === assets.length
              ? readErrorMessage(firstError, "Failed to delete media.")
              : `Failed to delete ${failureCount} of ${assets.length} assets.`,
          statusCode:
            firstError instanceof RuntimeError ? firstError.statusCode : 500,
        });
      }
    },
    [canDeleteMedia, mediaDeleteApi, query],
  );

  return (
    <MediaLibraryPageView
      state={pageState}
      canUploadMedia={canUploadMedia && mediaUploadApi !== null}
      canDeleteMedia={canDeleteMedia && mediaDeleteApi !== null}
      uploadState={uploadState}
      filters={filters}
      searchInput={searchInput}
      sort={sort}
      userSummaries={usersQuery.data ?? []}
      onUploadFiles={handleUploadFiles}
      onSearchInputChange={setSearchInput}
      onFilterChange={handleFilterChange}
      onSortChange={handleSortChange}
      onPageChange={handlePageChange}
      onRetry={() => {
        void query.refetch();
      }}
      onCopyUrl={handleCopyUrl}
      onDeleteAssets={handleDeleteAssets}
    />
  );
}
