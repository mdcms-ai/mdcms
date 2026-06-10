import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  MediaAsset,
  ResolveErrorsMap,
  SchemaRegistryFieldSnapshot,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import { applyMediaFieldExpansion } from "./media-field-expansion.js";

const scope = {
  project: "media-expansion-project",
  environment: "production",
};

const imageAsset = {
  id: "07ebb057-eeab-4849-94e4-2162cb921c8e",
  project: "media-expansion-project",
  filename: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 100,
  url: "https://cdn.example.test/hero.jpg",
  uploadedBy: "user_1",
  uploadedAt: "2026-06-09T10:00:00.000Z",
} satisfies MediaAsset;

const secondImageAsset = {
  ...imageAsset,
  id: "02fd78b9-a55d-4c4a-8d2f-216814f6f75f",
  filename: "gallery.jpg",
  url: "https://cdn.example.test/gallery.jpg",
} satisfies MediaAsset;

const pdfAsset = {
  ...imageAsset,
  id: "31d87a14-4c4f-4ed3-8a27-1e5fb7dce19f",
  filename: "terms.pdf",
  mimeType: "application/pdf",
  url: "https://cdn.example.test/terms.pdf",
} satisfies MediaAsset;

function createLookup(assets: MediaAsset[], calls: string[] = []) {
  return async (_scope: typeof scope, id: string) => {
    calls.push(id);
    return assets.find((asset) => asset.id === id);
  };
}

function fileField(
  overrides: Partial<SchemaRegistryFieldSnapshot> = {},
): SchemaRegistryFieldSnapshot {
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

function schema(
  fields: Record<string, SchemaRegistryFieldSnapshot>,
): SchemaRegistryTypeSnapshot {
  return {
    type: "Article",
    directory: "content/articles",
    localized: true,
    fields,
  };
}

function document(frontmatter: Record<string, unknown>): {
  documentId: string;
  frontmatter: Record<string, unknown>;
  resolveErrors?: ResolveErrorsMap;
} {
  return {
    documentId: "doc-1",
    frontmatter,
  };
}

test("top-level image id expands to a MediaAsset", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({ heroImage: fileField() }),
    document: document({ heroImage: imageAsset.id }),
    scope,
    lookupMediaAsset: createLookup([imageAsset]),
    mode: "expanded",
  });

  assert.deepEqual(expanded.frontmatter.heroImage, imageAsset);
  assert.equal(expanded.resolveErrors, undefined);
});

test("raw mode leaves file ids unchanged and does not call media lookup", async () => {
  const calls: string[] = [];
  const original = document({ heroImage: imageAsset.id });
  const raw = await applyMediaFieldExpansion({
    schema: schema({ heroImage: fileField() }),
    document: original,
    scope,
    lookupMediaAsset: createLookup([imageAsset], calls),
    mode: "raw",
  });

  assert.equal(raw, original);
  assert.equal(raw.frontmatter.heroImage, imageAsset.id);
  assert.deepEqual(calls, []);
});

test("raw mode preserves persisted unset representations", async () => {
  const original = document({
    nullableImage: null,
    emptyImage: "",
  });
  const raw = await applyMediaFieldExpansion({
    schema: schema({
      missingImage: fileField({ required: false, nullable: true }),
      nullableImage: fileField({ nullable: true }),
      emptyImage: fileField({
        required: false,
        nullable: true,
        file: {
          preset: "image",
          accept: [],
          emptyStringAsUnset: true,
        },
      }),
    }),
    document: original,
    scope,
    lookupMediaAsset: createLookup([imageAsset]),
    mode: "raw",
  });

  assert.equal(raw, original);
  assert.equal("missingImage" in raw.frontmatter, false);
  assert.equal(raw.frontmatter.nullableImage, null);
  assert.equal(raw.frontmatter.emptyImage, "");
});

test("expanded mode returns null for allowed unset file field values without resolve errors", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({
      missingImage: fileField({ required: false, nullable: false }),
      nullableImage: fileField({ nullable: true }),
      emptyImage: fileField({
        required: false,
        nullable: true,
        file: {
          preset: "image",
          accept: [],
          emptyStringAsUnset: true,
        },
      }),
    }),
    document: document({
      nullableImage: null,
      emptyImage: "",
    }),
    scope,
    lookupMediaAsset: createLookup([imageAsset]),
    mode: "expanded",
  });

  assert.deepEqual(expanded.frontmatter, {
    missingImage: null,
    nullableImage: null,
    emptyImage: null,
  });
  assert.equal(expanded.resolveErrors, undefined);
});

test("missing assets expand to null and record MEDIA_NOT_FOUND", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({ heroImage: fileField() }),
    document: document({ heroImage: imageAsset.id }),
    scope,
    lookupMediaAsset: createLookup([]),
    mode: "expanded",
  });

  assert.equal(expanded.frontmatter.heroImage, null);
  assert.deepEqual(expanded.resolveErrors, {
    "frontmatter.heroImage": {
      code: "MEDIA_NOT_FOUND",
      message:
        "Media asset could not be resolved in the target project/environment.",
      media: {
        assetId: imageAsset.id,
      },
    },
  });
});

test("wrong MIME assets expand to null and record MEDIA_TYPE_MISMATCH", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({ heroImage: fileField() }),
    document: document({ heroImage: pdfAsset.id }),
    scope,
    lookupMediaAsset: createLookup([pdfAsset]),
    mode: "expanded",
  });

  assert.equal(expanded.frontmatter.heroImage, null);
  assert.deepEqual(expanded.resolveErrors, {
    "frontmatter.heroImage": {
      code: "MEDIA_TYPE_MISMATCH",
      message: "Media asset MIME type does not match the schema file field.",
      media: {
        assetId: pdfAsset.id,
        expectedMime: ["image/*"],
        actualMimeType: "application/pdf",
      },
    },
  });
});

test("media expansion merges with existing resolve errors", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({ heroImage: fileField() }),
    document: {
      ...document({ heroImage: imageAsset.id }),
      resolveErrors: {
        "frontmatter.author": {
          code: "REFERENCE_NOT_FOUND",
          message: "Reference not found.",
          ref: {
            documentId: "author-1",
            type: "Author",
          },
        },
      },
    },
    scope,
    lookupMediaAsset: createLookup([]),
    mode: "expanded",
  });

  assert.deepEqual(Object.keys(expanded.resolveErrors ?? {}).sort(), [
    "frontmatter.author",
    "frontmatter.heroImage",
  ]);
});

test("nested object file fields expand with their full frontmatter path", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({
      hero: {
        kind: "object",
        required: true,
        nullable: false,
        fields: {
          image: fileField(),
        },
      },
    }),
    document: document({ hero: { image: imageAsset.id } }),
    scope,
    lookupMediaAsset: createLookup([imageAsset]),
    mode: "expanded",
  });

  assert.deepEqual(expanded.frontmatter.hero, { image: imageAsset });
  assert.equal(expanded.resolveErrors, undefined);
});

test("arrays expand structurally", async () => {
  const expanded = await applyMediaFieldExpansion({
    schema: schema({
      gallery: {
        kind: "array",
        required: true,
        nullable: false,
        item: fileField(),
      },
    }),
    document: document({
      gallery: [imageAsset.id, secondImageAsset.id],
    }),
    scope,
    lookupMediaAsset: createLookup([imageAsset, secondImageAsset]),
    mode: "expanded",
  });

  assert.deepEqual(expanded.frontmatter.gallery, [
    imageAsset,
    secondImageAsset,
  ]);
});

test("unresolved reads do not mutate the original document object", async () => {
  const original = document({
    hero: {
      image: imageAsset.id,
    },
  });
  const expanded = await applyMediaFieldExpansion({
    schema: schema({
      hero: {
        kind: "object",
        required: true,
        nullable: false,
        fields: {
          image: fileField(),
        },
      },
    }),
    document: original,
    scope,
    lookupMediaAsset: createLookup([]),
    mode: "expanded",
  });

  assert.notEqual(expanded, original);
  assert.deepEqual(original.frontmatter, {
    hero: {
      image: imageAsset.id,
    },
  });
  assert.deepEqual(expanded.frontmatter, {
    hero: {
      image: null,
    },
  });
});
