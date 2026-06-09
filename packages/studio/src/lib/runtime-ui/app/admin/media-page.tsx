"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { RuntimeError, type MediaAsset } from "@mdcms/shared";
import {
  AlertCircle,
  Clipboard,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  FileSearch,
  Image,
  Loader2,
  Music,
  Play,
  Search,
  ShieldAlert,
  Upload,
} from "lucide-react";

import { PageHeader } from "../../components/layout/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "../../components/ui/pagination.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import {
  createStudioMediaLibraryApi,
  type StudioMediaLibraryListQuery,
} from "../../lib/media-library-api.js";
import { createStudioMediaUploadApi } from "../../lib/media-upload-api.js";
import type { StudioRuntimeAuth } from "../../../request-auth.js";
import { useCanReadMedia, useCanUploadMedia } from "./capabilities-context.js";
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

export type MediaLibraryUploadState =
  | { status: "idle" }
  | { status: "uploading"; completedFiles: number; totalFiles: number }
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
  { value: "all", label: "All categories" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Documents" },
  { value: "archive", label: "Archives" },
  { value: "other", label: "Other" },
];

const sortOptions: Array<{ value: MediaLibrarySortOption; label: string }> = [
  { value: "newest", label: "Uploaded date, newest" },
  { value: "oldest", label: "Uploaded date, oldest" },
  { value: "name-asc", label: "Name, A-Z" },
  { value: "name-desc", label: "Name, Z-A" },
  { value: "size-desc", label: "Size, largest" },
  { value: "size-asc", label: "Size, smallest" },
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

function MediaLibraryFilterBar({
  filters,
  searchInput,
  sort,
  onSearchInputChange,
  onFilterChange,
  onSortChange,
}: {
  filters: MediaLibraryFilters;
  searchInput: string;
  sort: MediaLibrarySortOption;
  onSearchInputChange: (value: string) => void;
  onFilterChange: (patch: Partial<MediaLibraryFilters>) => void;
  onSortChange: (value: MediaLibrarySortOption) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-80">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" />
          <Input
            aria-label="Search filenames"
            className="pl-9"
            placeholder="Search filenames..."
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.target.value)}
          />
        </div>

        <Select
          value={sort}
          onValueChange={(value) =>
            onSortChange(value as MediaLibrarySortOption)
          }
        >
          <SelectTrigger className="w-48" aria-label="Sort media">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={filters.category}
          onValueChange={(value) =>
            onFilterChange({
              category: value as MediaLibraryFilters["category"],
            })
          }
        >
          <SelectTrigger className="w-44" aria-label="Filter by media category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          aria-label="Filter by uploader"
          className="w-56"
          placeholder="Uploader actor id"
          value={filters.uploadedBy}
          onChange={(event) =>
            onFilterChange({ uploadedBy: event.target.value })
          }
        />
        <Input
          aria-label="Uploaded from"
          className="w-40"
          type="date"
          value={filters.uploadedFrom}
          onChange={(event) =>
            onFilterChange({ uploadedFrom: event.target.value })
          }
        />
        <Input
          aria-label="Uploaded to"
          className="w-40"
          type="date"
          value={filters.uploadedTo}
          onChange={(event) =>
            onFilterChange({ uploadedTo: event.target.value })
          }
        />
      </div>
    </div>
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
  const statusText = progress
    ? `Uploading media ${progress.completedFiles} of ${progress.totalFiles}`
    : "Uploading media...";

  if (!canUploadMedia) {
    return null;
  }

  return (
    <div className="flex min-w-64 flex-col items-stretch gap-2 sm:items-end">
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
        className="gap-2"
        onClick={() => inputRef.current?.click()}
      >
        {isUploading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Upload className="size-4" />
        )}
        Upload media
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
        </div>
      ) : null}
      {uploadState.status === "error" ? (
        <div
          role="alert"
          aria-live="assertive"
          className="w-full rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:w-72"
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
}: {
  state: MediaLibraryEmptyPageState;
  isDragActive?: boolean;
}) {
  const emptyState = deriveMediaLibraryEmptyState(state.status === "no-match");
  const Icon = state.status === "no-match" ? FileSearch : Image;
  const panelClassName = [
    "relative isolate flex min-h-[26rem] overflow-hidden rounded-lg border border-dashed bg-background-subtle text-center transition-colors",
    isDragActive ? "border-primary bg-accent-subtle" : "border-border",
  ].join(" ");

  return (
    <section
      data-mdcms-media-library-state={state.status}
      className={panelClassName}
    >
      {state.status === "empty" ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 grid grid-cols-2 gap-3 p-6 opacity-35 sm:grid-cols-4"
        >
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="rounded-lg border border-border bg-background"
            >
              <div className="h-28 rounded-t-lg bg-muted" />
              <div className="space-y-2 p-3">
                <div className="h-2 rounded-full bg-border" />
                <div className="h-2 w-2/3 rounded-full bg-border" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="relative m-auto flex max-w-sm flex-col items-center px-6 py-16">
        <div className="mb-4 rounded-full border border-border bg-background p-4 shadow-sm">
          <Icon className="size-8 text-foreground-muted" />
        </div>
        <h3 className="mb-2 text-lg font-semibold">{emptyState.title}</h3>
        <p className="text-sm text-foreground-muted">
          {emptyState.description}
        </p>
      </div>
    </section>
  );
}

function MediaAssetActions({
  asset,
  onCopyUrl,
}: {
  asset: MediaAsset;
  onCopyUrl: (url: string) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`Open asset ${asset.filename}`}
        onClick={() => window.open(asset.url, "_blank", "noopener,noreferrer")}
      >
        <ExternalLink className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`Copy asset URL for ${asset.filename}`}
        onClick={() => onCopyUrl(asset.url)}
      >
        <Clipboard className="size-4" />
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
      : "flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md bg-muted";

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

function MediaAssetMetadataRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <dt className="text-xs uppercase text-foreground-muted">{label}</dt>
      <dd className="max-w-48 truncate text-right text-sm text-foreground">
        {value}
      </dd>
    </div>
  );
}

function MediaAssetCard({
  asset,
  selected,
  onSelect,
  onCopyUrl,
}: {
  asset: MediaAsset;
  selected: boolean;
  onSelect: (asset: MediaAsset) => void;
  onCopyUrl: (url: string) => void;
}) {
  const category = getMediaAssetCategory(asset);
  const cardClassName = [
    "group overflow-hidden rounded-lg border bg-background transition-colors",
    selected
      ? "border-primary shadow-sm ring-1 ring-primary/30"
      : "border-border hover:border-primary/40",
  ].join(" ");

  return (
    <article className={cardClassName}>
      <div className="relative p-2">
        <MediaAssetPreview asset={asset} category={category} />
        <Badge
          variant="outline"
          className="absolute left-4 top-4 bg-background/90 text-[11px] shadow-sm"
        >
          {getMediaAssetCategoryLabel(category)}
        </Badge>
      </div>
      <div className="space-y-3 p-3 pt-1">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Select asset ${asset.filename}`}
          className="block w-full min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onClick={() => onSelect(asset)}
        >
          <span className="block truncate text-sm font-medium text-foreground">
            {asset.filename}
          </span>
          <span className="mt-1 block truncate text-xs text-foreground-muted">
            {formatMediaAssetBytes(asset.sizeBytes)} /{" "}
            {getMediaAssetExtension(asset.filename)}
          </span>
        </button>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-mono text-[11px] text-foreground-muted">
            {asset.uploadedBy}
          </span>
          <MediaAssetActions asset={asset} onCopyUrl={onCopyUrl} />
        </div>
      </div>
    </article>
  );
}

function MediaAssetDetailDrawer({
  asset,
  onCopyUrl,
}: {
  asset: MediaAsset | null;
  onCopyUrl: (url: string) => void;
}) {
  if (!asset) {
    return (
      <aside
        aria-label="Asset details"
        className="flex min-h-full items-center justify-center border-t border-border bg-background-subtle p-6 text-center lg:border-l lg:border-t-0"
      >
        <p className="max-w-52 text-sm text-foreground-muted">
          Select an asset to inspect its metadata.
        </p>
      </aside>
    );
  }

  const category = getMediaAssetCategory(asset);

  return (
    <aside
      aria-label="Asset details"
      className="flex min-h-full flex-col border-t border-border bg-background-subtle lg:border-l lg:border-t-0"
    >
      <div className="border-b border-border px-4 py-4">
        <p className="text-xs uppercase text-foreground-muted">
          Selected asset
        </p>
        <h2 className="mt-1 truncate text-base font-semibold text-foreground">
          {asset.filename}
        </h2>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <MediaAssetPreview asset={asset} category={category} variant="drawer" />

        <div className="flex items-center justify-between gap-3">
          <Badge variant="outline" className="text-xs">
            {getMediaAssetCategoryLabel(category)}
          </Badge>
          <MediaAssetActions asset={asset} onCopyUrl={onCopyUrl} />
        </div>

        <dl className="rounded-md border border-border bg-background px-3">
          <MediaAssetMetadataRow label="MIME type" value={asset.mimeType} />
          <MediaAssetMetadataRow
            label="Size"
            value={formatMediaAssetBytes(asset.sizeBytes)}
          />
          <MediaAssetMetadataRow
            label="Uploaded"
            value={formatMediaAssetDate(asset.uploadedAt, "en-US")}
          />
          <MediaAssetMetadataRow label="Uploader" value={asset.uploadedBy} />
          <MediaAssetMetadataRow label="Asset ID" value={asset.id} />
        </dl>
      </div>
    </aside>
  );
}

function MediaLibraryGallery({
  assets,
  selectedAsset,
  onSelectAsset,
  onCopyUrl,
}: {
  assets: MediaAsset[];
  selectedAsset: MediaAsset | null;
  onSelectAsset: (asset: MediaAsset) => void;
  onCopyUrl: (url: string) => void;
}) {
  return (
    <div
      data-mdcms-media-library-layout="gallery"
      className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3"
    >
      {assets.map((asset) => (
        <MediaAssetCard
          key={asset.id}
          asset={asset}
          selected={selectedAsset?.id === asset.id}
          onSelect={onSelectAsset}
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
    return (
      <p className="text-sm text-foreground-muted">
        Showing {pagination.total} media asset
        {pagination.total === 1 ? "" : "s"}
      </p>
    );
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

export function MediaLibraryPageView({
  state,
  canUploadMedia,
  uploadState,
  filters,
  searchInput,
  sort,
  onUploadFiles,
  onSearchInputChange,
  onFilterChange,
  onSortChange,
  onPageChange,
  onRetry,
  onCopyUrl,
}: {
  state: MediaLibraryPageState;
  canUploadMedia: boolean;
  uploadState: MediaLibraryUploadState;
  filters: MediaLibraryFilters;
  searchInput: string;
  sort: MediaLibrarySortOption;
  onUploadFiles: (files: File[]) => void;
  onSearchInputChange: (value: string) => void;
  onFilterChange: (patch: Partial<MediaLibraryFilters>) => void;
  onSortChange: (value: MediaLibrarySortOption) => void;
  onPageChange: (offset: number) => void;
  onRetry: () => void;
  onCopyUrl: (url: string) => void;
}) {
  const showControls =
    state.status === "loading" ||
    state.status === "empty" ||
    state.status === "no-match" ||
    state.status === "ready" ||
    state.status === "error";
  const readyAssets = state.status === "ready" ? state.assets : [];
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const selectedAsset =
    readyAssets.find((asset) => asset.id === selectedAssetId) ??
    readyAssets[0] ??
    null;
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
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Media" }]} />

      <div
        className="space-y-6 p-6"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Media Library</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Upload, preview, and inspect project media for the active
              environment.
            </p>
          </div>
          <MediaLibraryUploadControl
            canUploadMedia={canUploadMedia}
            uploadState={uploadState}
            onUploadFiles={onUploadFiles}
          />
        </div>

        {showControls && (
          <>
            <MediaLibraryFilterBar
              filters={filters}
              searchInput={searchInput}
              sort={sort}
              onSearchInputChange={onSearchInputChange}
              onFilterChange={onFilterChange}
              onSortChange={onSortChange}
            />
          </>
        )}

        {state.status === "unavailable" ||
        state.status === "forbidden" ||
        state.status === "loading" ||
        state.status === "error" ? (
          <MediaLibraryStatePanel state={state} onRetry={onRetry} />
        ) : state.status === "empty" || state.status === "no-match" ? (
          <MediaLibraryEmptyPanel state={state} isDragActive={isDragActive} />
        ) : (
          <section
            data-mdcms-media-library-state="ready"
            className="overflow-hidden rounded-lg border border-border bg-background"
          >
            <div className="grid min-h-[34rem] lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
              <div className="flex min-w-0 flex-col gap-4 p-4">
                <MediaLibraryGallery
                  assets={state.assets}
                  selectedAsset={selectedAsset}
                  onSelectAsset={(asset) => setSelectedAssetId(asset.id)}
                  onCopyUrl={onCopyUrl}
                />
                <MediaLibraryPagination
                  pagination={state.pagination}
                  onPageChange={onPageChange}
                />
              </div>
              <MediaAssetDetailDrawer
                asset={selectedAsset}
                onCopyUrl={onCopyUrl}
              />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default function MediaPage() {
  const canReadMedia = useCanReadMedia();
  const canUploadMedia = useCanUploadMedia();
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

  const query = useQuery({
    queryKey: queryKey ?? ["media-library", "unavailable"],
    queryFn: () =>
      api!.list(createMediaLibraryListQuery({ filters, sort, offset })),
    enabled: canReadMedia && hasApiConfig && api !== null && queryKey !== null,
    retryOnMount: false,
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
      setUploadState({ status: "uploading", completedFiles: 0, totalFiles });

      void (async () => {
        try {
          let completedFiles = 0;

          for (const file of files) {
            await mediaUploadApi.upload(file);
            completedFiles += 1;
            setUploadState({
              status: "uploading",
              completedFiles,
              totalFiles,
            });
          }

          setUploadState({ status: "idle" });
          await query.refetch();
        } catch (error) {
          setUploadState({
            status: "error",
            message: readErrorMessage(error, "Media upload failed."),
          });
        }
      })();
    },
    [canUploadMedia, mediaUploadApi, query],
  );

  return (
    <MediaLibraryPageView
      state={pageState}
      canUploadMedia={canUploadMedia && mediaUploadApi !== null}
      uploadState={uploadState}
      filters={filters}
      searchInput={searchInput}
      sort={sort}
      onUploadFiles={handleUploadFiles}
      onSearchInputChange={setSearchInput}
      onFilterChange={handleFilterChange}
      onSortChange={handleSortChange}
      onPageChange={handlePageChange}
      onRetry={() => {
        void query.refetch();
      }}
      onCopyUrl={handleCopyUrl}
    />
  );
}
