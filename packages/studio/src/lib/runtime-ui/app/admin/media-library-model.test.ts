import assert from "node:assert/strict";
import { test } from "bun:test";
import type { MediaAsset } from "@mdcms/shared";

import {
  deriveMediaLibraryEmptyState,
  formatMediaAssetBytes,
  formatMediaAssetDate,
  getMediaAssetCategory,
  getMediaAssetCategoryLabel,
  hasActiveMediaLibraryFilters,
  mapMediaLibrarySortOptionToQuery,
  type MediaLibraryFilters,
} from "./media-library-model.js";

const inactiveFilters: MediaLibraryFilters = {
  q: "",
  category: "all",
  uploadedBy: "",
  uploadedFrom: "",
  uploadedTo: "",
};

const asset: MediaAsset = {
  id: "asset_123",
  project: "marketing-site",
  filename: "hero.png",
  mimeType: "image/png",
  sizeBytes: 1536,
  url: "https://cdn.example.com/media/hero.png",
  uploadedBy: "user_123",
  uploadedAt: "2026-06-05T12:00:00.000Z",
};

test("hasActiveMediaLibraryFilters detects search and metadata filters", () => {
  assert.equal(hasActiveMediaLibraryFilters(inactiveFilters), false);
  assert.equal(
    hasActiveMediaLibraryFilters({ ...inactiveFilters, q: " hero " }),
    true,
  );
  assert.equal(
    hasActiveMediaLibraryFilters({ ...inactiveFilters, category: "image" }),
    true,
  );
  assert.equal(
    hasActiveMediaLibraryFilters({
      ...inactiveFilters,
      uploadedBy: "user_123",
    }),
    true,
  );
  assert.equal(
    hasActiveMediaLibraryFilters({
      ...inactiveFilters,
      uploadedFrom: "2026-06-01",
    }),
    true,
  );
  assert.equal(
    hasActiveMediaLibraryFilters({
      ...inactiveFilters,
      uploadedTo: "2026-06-05",
    }),
    true,
  );
});

test("mapMediaLibrarySortOptionToQuery maps UI sort choices to API query fields", () => {
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("newest"), {
    sort: "uploadedAt",
    order: "desc",
  });
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("oldest"), {
    sort: "uploadedAt",
    order: "asc",
  });
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("name-asc"), {
    sort: "filename",
    order: "asc",
  });
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("name-desc"), {
    sort: "filename",
    order: "desc",
  });
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("size-desc"), {
    sort: "sizeBytes",
    order: "desc",
  });
  assert.deepEqual(mapMediaLibrarySortOptionToQuery("size-asc"), {
    sort: "sizeBytes",
    order: "asc",
  });
});

test("formatMediaAssetBytes formats byte values with binary units", () => {
  assert.equal(formatMediaAssetBytes(0), "0 B");
  assert.equal(formatMediaAssetBytes(512), "512 B");
  assert.equal(formatMediaAssetBytes(1536), "1.5 KB");
  assert.equal(formatMediaAssetBytes(1_048_576), "1 MB");
  assert.equal(formatMediaAssetBytes(2_621_440), "2.5 MB");
});

test("formatMediaAssetDate returns a locale date or fallback for invalid input", () => {
  assert.equal(
    formatMediaAssetDate("2026-06-05T12:00:00.000Z", "en-US"),
    "Jun 5, 2026",
  );
  assert.equal(formatMediaAssetDate("not-a-date", "en-US"), "Unknown date");
  assert.equal(formatMediaAssetDate("", "en-US"), "Unknown date");
});

test("getMediaAssetCategoryLabel maps all coarse media categories", () => {
  assert.equal(getMediaAssetCategoryLabel("image"), "Image");
  assert.equal(getMediaAssetCategoryLabel("video"), "Video");
  assert.equal(getMediaAssetCategoryLabel("audio"), "Audio");
  assert.equal(getMediaAssetCategoryLabel("document"), "Document");
  assert.equal(getMediaAssetCategoryLabel("archive"), "Archive");
  assert.equal(getMediaAssetCategoryLabel("other"), "Other");
});

test("getMediaAssetCategory derives the category from the asset MIME type", () => {
  assert.equal(getMediaAssetCategory(asset), "image");
  assert.equal(
    getMediaAssetCategory({ ...asset, mimeType: "application/pdf" }),
    "document",
  );
  assert.equal(
    getMediaAssetCategory({ ...asset, mimeType: "application/octet-stream" }),
    "other",
  );
});

test("deriveMediaLibraryEmptyState distinguishes empty library from no-match filters", () => {
  assert.deepEqual(deriveMediaLibraryEmptyState(false), {
    kind: "empty",
    title: "No media yet",
    description: "Drop files here or use Upload media to add assets.",
  });
  assert.deepEqual(deriveMediaLibraryEmptyState(true), {
    kind: "no-match",
    title: "No media matches",
    description: "Try changing the search or filters.",
  });
});
