import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  ContentBulkOperationInputSchema,
  type ContentMediaResolveError,
  type ContentResolveError,
} from "./content-api.js";

test("ContentBulkOperationInputSchema accepts valid bulk operation shapes", () => {
  const parsed = ContentBulkOperationInputSchema.parse({
    action: "move",
    documentIds: ["doc-1", "doc-2"],
    move: {
      targetDirectory: "archive/news",
    },
  });

  assert.deepEqual(parsed, {
    action: "move",
    documentIds: ["doc-1", "doc-2"],
    move: {
      targetDirectory: "archive/news",
    },
  });
});

test("ContentBulkOperationInputSchema rejects malformed bulk operation fields", () => {
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "archive",
      documentIds: ["doc-1"],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: [1],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: 123,
      },
    }).success,
    false,
  );
});

test("ContentResolveError accepts reference and media resolve errors", () => {
  const mediaError = {
    code: "MEDIA_TYPE_MISMATCH",
    message: "Media asset MIME type does not match the schema file field.",
    media: {
      assetId: "asset-1",
      expectedMime: ["image/*"],
      actualMimeType: "application/pdf",
    },
  } satisfies ContentMediaResolveError;

  const errors: Record<string, ContentResolveError> = {
    "frontmatter.author": {
      code: "REFERENCE_NOT_FOUND",
      message: "Reference not found.",
      ref: {
        documentId: "author-1",
        type: "Author",
      },
    },
    "frontmatter.heroImage": mediaError,
  };

  assert.equal(errors["frontmatter.heroImage"]?.code, "MEDIA_TYPE_MISMATCH");
  assert.deepEqual(
    (errors["frontmatter.heroImage"] as ContentMediaResolveError).media,
    mediaError.media,
  );
});
