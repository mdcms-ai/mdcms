import assert from "node:assert/strict";

import type { MediaAsset } from "@mdcms/shared";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FileFieldAssetPreview,
  FileFieldSelectedAssetView,
  FileFieldUploadFeedback,
  createMediaFieldOperationGuard,
  listMatchingMediaAssets,
  mediaAssetMatchesFileField,
  resolveFileFieldMediaListQuery,
} from "./media-field-picker.js";

function createMediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset_123",
    project: "marketing-site",
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 1200,
    url: "https://cdn.example.com/hero.png",
    uploadedBy: "editor@example.com",
    uploadedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

test("mediaAssetMatchesFileField applies preset and exact or wildcard accept rules", () => {
  const imageAsset = createMediaAsset({ mimeType: "image/png" });
  const jpegAsset = createMediaAsset({ mimeType: "image/jpeg" });
  const videoAsset = createMediaAsset({ mimeType: "video/mp4" });
  const pdfAsset = createMediaAsset({ mimeType: "application/pdf" });

  assert.equal(
    mediaAssetMatchesFileField(imageAsset, { preset: "image", accept: [] }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(videoAsset, { preset: "image", accept: [] }),
    false,
  );
  assert.equal(
    mediaAssetMatchesFileField(videoAsset, { preset: "video", accept: [] }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(pdfAsset, { preset: "file", accept: [] }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(imageAsset, {
      preset: "image",
      accept: ["image/png"],
    }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(jpegAsset, {
      preset: "image",
      accept: ["image/png"],
    }),
    false,
  );
  assert.equal(
    mediaAssetMatchesFileField(jpegAsset, {
      preset: "image",
      accept: ["image/*"],
    }),
    true,
  );
});

test("resolveFileFieldMediaListQuery scopes image and video presets to their category", () => {
  assert.deepEqual(resolveFileFieldMediaListQuery("image"), {
    category: "image",
    sort: "uploadedAt",
    order: "desc",
    limit: 24,
  });
  assert.deepEqual(resolveFileFieldMediaListQuery("video"), {
    category: "video",
    sort: "uploadedAt",
    order: "desc",
    limit: 24,
  });
  assert.deepEqual(resolveFileFieldMediaListQuery("file"), {
    sort: "uploadedAt",
    order: "desc",
    limit: 24,
  });
});

test("listMatchingMediaAssets scans later pages until a matching accepted asset is found", async () => {
  const calls: Array<{ offset?: number; limit?: number }> = [];
  const pngAsset = createMediaAsset({
    id: "asset_png",
    filename: "hero.png",
    mimeType: "image/png",
  });
  const pdfAsset = createMediaAsset({
    id: "asset_pdf",
    filename: "brief.pdf",
    mimeType: "application/pdf",
  });

  const assets = await listMatchingMediaAssets({
    file: { preset: "file", accept: ["application/pdf"] },
    list: async (query) => {
      calls.push({ offset: query?.offset, limit: query?.limit });

      if (query?.offset === 24) {
        return {
          data: [pdfAsset],
          pagination: { total: 25, limit: 24, offset: 24, hasMore: false },
          storage: { objectStorageConfigured: true },
        };
      }

      return {
        data: [pngAsset],
        pagination: { total: 25, limit: 24, offset: 0, hasMore: true },
        storage: { objectStorageConfigured: true },
      };
    },
  });

  assert.deepEqual(
    assets.map((asset) => asset.id),
    ["asset_pdf"],
  );
  assert.deepEqual(calls, [
    { offset: 0, limit: 24 },
    { offset: 24, limit: 24 },
  ]);
});

test("createMediaFieldOperationGuard invalidates pending uploads after newer field operations", () => {
  const guard = createMediaFieldOperationGuard();
  const firstUpload = guard.startUpload();

  assert.equal(guard.isCurrentUpload(firstUpload), true);

  guard.invalidate();

  assert.equal(guard.isCurrentUpload(firstUpload), false);

  const secondUpload = guard.startUpload();

  assert.equal(guard.isCurrentUpload(firstUpload), false);
  assert.equal(guard.isCurrentUpload(secondUpload), true);
  guard.finishUpload(secondUpload);
  assert.equal(guard.isUploadActive(), false);
});

test("FileFieldAssetPreview renders image, video, and file placeholders", () => {
  const imageMarkup = renderToStaticMarkup(
    createElement(FileFieldAssetPreview, {
      asset: createMediaAsset({
        filename: "hero.png",
        mimeType: "image/png",
        url: "https://cdn.example.com/hero.png",
      }),
    }),
  );
  const videoMarkup = renderToStaticMarkup(
    createElement(FileFieldAssetPreview, {
      asset: createMediaAsset({
        filename: "demo.mp4",
        mimeType: "video/mp4",
        url: "https://cdn.example.com/demo.mp4",
      }),
    }),
  );
  const fileMarkup = renderToStaticMarkup(
    createElement(FileFieldAssetPreview, {
      asset: createMediaAsset({
        filename: "brief.pdf",
        mimeType: "application/pdf",
        url: "https://cdn.example.com/brief.pdf",
      }),
    }),
  );

  assert.match(imageMarkup, /<img /);
  assert.match(imageMarkup, /src="https:\/\/cdn.example.com\/hero.png"/);
  assert.match(imageMarkup, /alt=""/);
  assert.match(videoMarkup, /<video /);
  assert.match(videoMarkup, /src="https:\/\/cdn.example.com\/demo.mp4"/);
  assert.match(videoMarkup, /controls=""/);
  assert.match(videoMarkup, /preload="metadata"/);
  assert.match(fileMarkup, /brief\.pdf/);
  assert.match(fileMarkup, /application\/pdf/);
});

test("FileFieldSelectedAssetView renders a loaded image asset filename and preview", () => {
  const markup = renderToStaticMarkup(
    createElement(FileFieldSelectedAssetView, {
      asset: createMediaAsset({
        filename: "hero.png",
        mimeType: "image/png",
        url: "https://cdn.example.com/hero.png",
      }),
    }),
  );

  assert.match(markup, /hero\.png/);
  assert.match(markup, /<img /);
  assert.match(markup, /src="https:\/\/cdn.example.com\/hero.png"/);
});

test("FileFieldUploadFeedback exposes live regions for progress and errors", () => {
  const progressMarkup = renderToStaticMarkup(
    createElement(FileFieldUploadFeedback, {
      uploadProgress: 42,
    }),
  );
  const errorMarkup = renderToStaticMarkup(
    createElement(FileFieldUploadFeedback, {
      localError: "Uploaded asset must be a video.",
    }),
  );

  assert.match(progressMarkup, /role="status"/);
  assert.match(progressMarkup, /aria-live="polite"/);
  assert.match(progressMarkup, /Uploading 42%/);
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, /aria-live="assertive"/);
  assert.match(errorMarkup, /Uploaded asset must be a video\./);
});
