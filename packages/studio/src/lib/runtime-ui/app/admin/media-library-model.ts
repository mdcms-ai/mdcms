import {
  deriveMediaAssetCategory,
  type MediaAsset,
  type MediaAssetCategory,
} from "@mdcms/shared";

import type {
  StudioMediaLibraryOrder,
  StudioMediaLibrarySort,
} from "../../lib/media-library-api.js";

export type MediaLibraryCategoryFilter = "all" | MediaAssetCategory;

export type MediaLibraryFilters = {
  q: string;
  category: MediaLibraryCategoryFilter;
  uploadedBy: string;
  uploadedFrom: string;
  uploadedTo: string;
};

export type MediaLibrarySortOption =
  | "newest"
  | "oldest"
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc";

export type MediaLibrarySortQuery = {
  sort: StudioMediaLibrarySort;
  order: StudioMediaLibraryOrder;
};

export type MediaLibraryEmptyState =
  | {
      kind: "empty";
      title: "No media yet";
      description: "Drop files here or use Upload media to add assets.";
    }
  | {
      kind: "no-match";
      title: "No media matches";
      description: "Try changing the search or filters.";
    };

const categoryLabels: Record<MediaAssetCategory, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
  archive: "Archive",
  other: "Other",
};

const sortOptions: Record<MediaLibrarySortOption, MediaLibrarySortQuery> = {
  newest: { sort: "uploadedAt", order: "desc" },
  oldest: { sort: "uploadedAt", order: "asc" },
  "name-asc": { sort: "filename", order: "asc" },
  "name-desc": { sort: "filename", order: "desc" },
  "size-desc": { sort: "sizeBytes", order: "desc" },
  "size-asc": { sort: "sizeBytes", order: "asc" },
};

export function hasActiveMediaLibraryFilters(
  filters: MediaLibraryFilters,
): boolean {
  return (
    filters.q.trim().length > 0 ||
    filters.category !== "all" ||
    filters.uploadedBy.trim().length > 0 ||
    filters.uploadedFrom.trim().length > 0 ||
    filters.uploadedTo.trim().length > 0
  );
}

export function mapMediaLibrarySortOptionToQuery(
  option: MediaLibrarySortOption,
): MediaLibrarySortQuery {
  return sortOptions[option];
}

export function formatMediaAssetBytes(sizeBytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = Math.max(0, sizeBytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted =
    unitIndex === 0 || Number.isInteger(value)
      ? String(Math.round(value))
      : value.toFixed(1);

  return `${formatted} ${units[unitIndex]}`;
}

export function formatMediaAssetDate(
  value: string,
  locale: string | string[] | undefined = undefined,
): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function getMediaAssetCategoryLabel(
  category: MediaAssetCategory,
): string {
  return categoryLabels[category];
}

export function getMediaAssetCategory(asset: MediaAsset): MediaAssetCategory {
  return deriveMediaAssetCategory(asset.mimeType);
}

export function deriveMediaLibraryEmptyState(
  hasActiveFilters: boolean,
): MediaLibraryEmptyState {
  if (hasActiveFilters) {
    return {
      kind: "no-match",
      title: "No media matches",
      description: "Try changing the search or filters.",
    };
  }

  return {
    kind: "empty",
    title: "No media yet",
    description: "Drop files here or use Upload media to add assets.",
  };
}
