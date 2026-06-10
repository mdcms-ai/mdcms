import assert from "node:assert/strict";
import { test } from "bun:test";
import type { MediaAsset, SchemaRegistryTypeSnapshot } from "@mdcms/shared";

import {
  mediaAssetMatchesFileField,
  normalizeMimeType,
  validateMediaFieldIdentities,
} from "./media-field-validation.js";

const imageAsset = {
  id: "07ebb057-eeab-4849-94e4-2162cb921c8e",
  project: "marketing-site",
  filename: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 100,
  url: "https://cdn.example.test/hero.jpg",
  uploadedBy: "user_1",
  uploadedAt: "2026-06-09T10:00:00.000Z",
} satisfies MediaAsset;

const pdfAsset = {
  ...imageAsset,
  id: "31d87a14-4c4f-4ed3-8a27-1e5fb7dce19f",
  filename: "terms.pdf",
  mimeType: "application/pdf",
  url: "https://cdn.example.test/terms.pdf",
} satisfies MediaAsset;

const videoAsset = {
  ...imageAsset,
  id: "c5a473d5-f72d-4912-93ac-4ba577db0aa7",
  filename: "launch.mp4",
  mimeType: "video/mp4; charset=binary",
  url: "https://cdn.example.test/launch.mp4",
} satisfies MediaAsset;

const scope = {
  project: "marketing-site",
  environment: "production",
};

function createSchema(
  fields: SchemaRegistryTypeSnapshot["fields"],
): SchemaRegistryTypeSnapshot {
  return {
    type: "Page",
    directory: "content/pages",
    localized: true,
    fields,
  };
}

function primaryImageField(
  overrides: Partial<SchemaRegistryTypeSnapshot["fields"][string]> = {},
): SchemaRegistryTypeSnapshot["fields"][string] {
  return {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    },
    ...overrides,
  };
}

function createLookup(assets: MediaAsset[], calls: string[] = []) {
  return async (_scope: typeof scope, id: string) => {
    calls.push(id);
    return assets.find((asset) => asset.id === id);
  };
}

async function assertRuntimeError(
  action: () => Promise<unknown>,
  expected: {
    code: string;
    statusCode: number;
    details: Record<string, unknown>;
  },
) {
  await assert.rejects(action, (error: unknown) => {
    const actual = error as {
      code?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
    };
    assert.equal(actual.code, expected.code);
    assert.equal(actual.statusCode, expected.statusCode);
    assert.deepEqual(actual.details, expected.details);
    return true;
  });
}

test("required file fields reject missing, null, empty, and blank values", async () => {
  const schema = createSchema({
    primaryImage: primaryImageField(),
  });

  for (const frontmatter of [
    {},
    { primaryImage: null },
    { primaryImage: "" },
    { primaryImage: "   " },
  ]) {
    await assertRuntimeError(
      () =>
        validateMediaFieldIdentities({
          schema,
          frontmatter,
          scope,
          lookupMediaAsset: createLookup([imageAsset]),
        }),
      {
        code: "INVALID_INPUT",
        statusCode: 400,
        details: {
          field: "frontmatter.primaryImage",
          reason: "MEDIA_REQUIRED",
        },
      },
    );
  }
});

test("non-string present file field values fail deterministically", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({ primaryImage: primaryImageField() }),
        frontmatter: { primaryImage: 42 },
        scope,
        lookupMediaAsset: createLookup([imageAsset]),
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        reason: "MEDIA_REQUIRED",
      },
    },
  );
});

test("optional file fields treat missing, null, and empty string as unset without lookup", async () => {
  const calls: string[] = [];
  const schema = createSchema({
    primaryImage: primaryImageField({
      required: false,
      nullable: true,
      file: {
        preset: "image",
        accept: [],
        emptyStringAsUnset: true,
      },
    }),
  });

  for (const frontmatter of [
    {},
    { primaryImage: null },
    { primaryImage: "" },
  ]) {
    const result = await validateMediaFieldIdentities({
      schema,
      frontmatter,
      scope,
      lookupMediaAsset: createLookup([imageAsset], calls),
    });

    assert.deepEqual(result.frontmatter, {});
  }

  assert.deepEqual(calls, []);
});

test("missing media asset ids fail with machine-readable details", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({ primaryImage: primaryImageField() }),
        frontmatter: { primaryImage: imageAsset.id },
        scope,
        lookupMediaAsset: createLookup([]),
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: imageAsset.id,
        reason: "MEDIA_NOT_FOUND",
      },
    },
  );
});

test("file field defaults are validated and materialized as raw ids", async () => {
  const schema = createSchema({
    helperDefaultImage: primaryImageField({ default: imageAsset.id }),
    zodDefaultImage: primaryImageField({ default: imageAsset.id }),
  });

  const result = await validateMediaFieldIdentities({
    schema,
    frontmatter: {},
    scope,
    lookupMediaAsset: createLookup([imageAsset]),
  });

  assert.deepEqual(result.frontmatter, {
    helperDefaultImage: imageAsset.id,
    zodDefaultImage: imageAsset.id,
  });
});

test("applied defaults fail when the asset does not exist", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({
          primaryImage: primaryImageField({ default: imageAsset.id }),
        }),
        frontmatter: {},
        scope,
        lookupMediaAsset: createLookup([]),
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: imageAsset.id,
        reason: "MEDIA_NOT_FOUND",
      },
    },
  );
});

test("applied defaults fail when the asset MIME type does not match", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({
          primaryImage: primaryImageField({ default: pdfAsset.id }),
        }),
        frontmatter: {},
        scope,
        lookupMediaAsset: createLookup([pdfAsset]),
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: pdfAsset.id,
        reason: "MEDIA_TYPE_MISMATCH",
        expectedMime: "image/*",
        actualMimeType: "application/pdf",
      },
    },
  );
});

test("MIME matching honors presets, exact accept entries, wildcards, and parameters", () => {
  assert.equal(normalizeMimeType("Video/MP4; charset=binary"), "video/mp4");
  assert.equal(
    mediaAssetMatchesFileField(imageAsset, {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(pdfAsset, {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    }),
    false,
  );
  assert.equal(
    mediaAssetMatchesFileField(videoAsset, {
      preset: "video",
      accept: ["video/mp4"],
      emptyStringAsUnset: false,
    }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(imageAsset, {
      preset: "image",
      accept: ["IMAGE/JPEG"],
      emptyStringAsUnset: false,
    }),
    true,
  );
  assert.equal(
    mediaAssetMatchesFileField(imageAsset, {
      preset: "file",
      accept: ["image/*"],
      emptyStringAsUnset: false,
    }),
    true,
  );
});

test("MIME mismatch details include expected and actual MIME data", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({
          primaryImage: primaryImageField({
            file: {
              preset: "image",
              accept: ["image/png"],
              emptyStringAsUnset: false,
            },
          }),
        }),
        frontmatter: { primaryImage: imageAsset.id },
        scope,
        lookupMediaAsset: createLookup([imageAsset]),
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: imageAsset.id,
        reason: "MEDIA_TYPE_MISMATCH",
        expectedMime: "image/png",
        actualMimeType: "image/jpeg",
      },
    },
  );
});

test("file fields fail fast when schema validation lacks a media lookup", async () => {
  await assertRuntimeError(
    () =>
      validateMediaFieldIdentities({
        schema: createSchema({ primaryImage: primaryImageField() }),
        frontmatter: { primaryImage: imageAsset.id },
        scope,
      }),
    {
      code: "MEDIA_ASSET_LOOKUP_UNAVAILABLE",
      statusCode: 500,
      details: {
        field: "frontmatter.primaryImage",
      },
    },
  );
});
