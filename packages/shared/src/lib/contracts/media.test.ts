import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  assertMediaAssetResponse,
  assertMediaDeleteResponse,
  assertMediaSettingsResponse,
  parseMediaSettingsInput,
} from "./media.js";

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
    data: {
      id: "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
      project: "marketing-site",
      filename: "hero.png",
      mimeType: "image/png",
      sizeBytes: 204_800,
      url: "https://cdn.example.com/media/hero.png",
      uploadedBy: "user_123",
      uploadedAt: "2026-06-05T12:00:00.000Z",
    },
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
