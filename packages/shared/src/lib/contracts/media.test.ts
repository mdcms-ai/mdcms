import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import {
  assertMediaAssetResponse,
  assertMediaAssetListResponse,
  assertMediaDeleteResponse,
  assertMediaSettingsResponse,
  deriveMediaAssetCategory,
  parseMediaSettingsInput,
} from "./media.js";

const mediaAsset = {
  id: "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
  project: "marketing-site",
  filename: "hero.png",
  mimeType: "image/png",
  sizeBytes: 204_800,
  url: "https://cdn.example.com/media/hero.png",
  uploadedBy: "user_123",
  uploadedAt: "2026-06-05T12:00:00.000Z",
};

test("parseMediaSettingsInput accepts null and positive image upload limits", () => {
  assert.deepEqual(
    parseMediaSettingsInput({
      media: { image: { maxUploadSizeBytes: null } },
    }),
    { media: { image: { maxUploadSizeBytes: null } } },
  );

  assert.deepEqual(
    parseMediaSettingsInput({
      media: { image: { maxUploadSizeBytes: 10_485_760 } },
    }),
    { media: { image: { maxUploadSizeBytes: 10_485_760 } } },
  );
});

test("parseMediaSettingsInput treats omitted image upload limit as unlimited", () => {
  assert.deepEqual(parseMediaSettingsInput({ media: { image: {} } }), {
    media: { image: { maxUploadSizeBytes: null } },
  });
});

test("parseMediaSettingsInput rejects non-positive image upload limits", () => {
  assert.throws(
    () =>
      parseMediaSettingsInput({
        media: { image: { maxUploadSizeBytes: 0 } },
      }),
    /positive safe integer/,
  );
});

test("parseMediaSettingsInput rejects application-owned routing fields", () => {
  assert.throws(
    () =>
      parseMediaSettingsInput({
        project: "marketing-site",
        media: { image: { maxUploadSizeBytes: null } },
      }),
    /not allowed/,
  );
});

test("media response assertions accept the public camelCase response shape", () => {
  assertMediaAssetResponse({
    data: mediaAsset,
  });

  assertMediaSettingsResponse({
    data: { media: { image: { maxUploadSizeBytes: null } } },
  });

  assertMediaDeleteResponse({
    data: {
      deleted: true,
      id: "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
    },
  });
});

test("deriveMediaAssetCategory maps supported MIME type groups", () => {
  assert.equal(deriveMediaAssetCategory("image/png"), "image");
  assert.equal(deriveMediaAssetCategory("video/mp4"), "video");
  assert.equal(deriveMediaAssetCategory("audio/mpeg"), "audio");
  assert.equal(deriveMediaAssetCategory("text/plain"), "document");
  assert.equal(deriveMediaAssetCategory("application/pdf"), "document");
  assert.equal(
    deriveMediaAssetCategory("application/pdf ; charset=utf-8"),
    "document",
  );
  assert.equal(deriveMediaAssetCategory("application/zip"), "archive");
  assert.equal(
    deriveMediaAssetCategory("application/zip ; charset=binary"),
    "archive",
  );
  assert.equal(deriveMediaAssetCategory("application/octet-stream"), "other");
  assert.equal(deriveMediaAssetCategory("model/gltf+json"), "other");
  assert.equal(
    deriveMediaAssetCategory("application/vnd.ms-fontobject"),
    "other",
  );
});

test("assertMediaAssetListResponse accepts assets with pagination metadata", () => {
  assert.doesNotThrow(() =>
    assertMediaAssetListResponse({
      data: [mediaAsset],
      pagination: {
        total: 1,
        limit: 30,
        offset: 0,
        hasMore: false,
      },
    }),
  );
});

test("assertMediaAssetListResponse rejects invalid pagination metadata", () => {
  assert.throws(
    () =>
      assertMediaAssetListResponse({
        data: [mediaAsset],
        pagination: {
          total: -1,
          limit: 30,
          offset: 0,
          hasMore: false,
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );
});

test("assertMediaAssetListResponse rejects invalid asset rows", () => {
  assert.throws(
    () =>
      assertMediaAssetListResponse({
        data: [
          {
            ...mediaAsset,
            filename: "",
          },
        ],
        pagination: {
          total: 1,
          limit: 30,
          offset: 0,
          hasMore: false,
        },
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_INPUT" &&
      error.statusCode === 400,
  );
});
