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

test("ContentBulkOperationInputSchema trims document IDs and preserves request order", () => {
  const parsed = ContentBulkOperationInputSchema.parse({
    action: "delete",
    documentIds: [" doc-2 ", "doc-1", "\tdoc-3\n"],
  });

  assert.deepEqual(parsed.documentIds, ["doc-2", "doc-1", "doc-3"]);
});

test("ContentBulkOperationInputSchema rejects invalid document ID collections", () => {
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: [],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: ["doc-1", " doc-1 "],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: ["doc-1", " "],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: Array.from({ length: 101 }, (_, index) => `doc-${index}`),
    }).success,
    false,
  );
});

test("ContentBulkOperationInputSchema enforces action-specific metadata", () => {
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "publish",
      documentIds: ["doc-1"],
      changeSummary: "Launch",
      actorId: "user-1",
    }).success,
    true,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "unpublish",
      documentIds: ["doc-1"],
      actorId: "user-1",
    }).success,
    true,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "unpublish",
      documentIds: ["doc-1"],
      changeSummary: "No longer public",
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: ["doc-1"],
      actorId: "user-1",
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      changeSummary: "Archive",
      move: {
        targetDirectory: "archive",
      },
    }).success,
    false,
  );
});

test("ContentBulkOperationInputSchema enforces move payload rules", () => {
  assert.deepEqual(
    ContentBulkOperationInputSchema.parse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: " archive/news ",
      },
    }),
    {
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive/news",
      },
    },
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "",
      },
    }).success,
    true,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive/news",
      },
    }).success,
    true,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive",
      },
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "/archive",
      },
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive/",
      },
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive/../news",
      },
    }).success,
    false,
  );
});

test("ContentBulkOperationInputSchema rejects unknown fields", () => {
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "delete",
      documentIds: ["doc-1"],
      unexpected: true,
    }).success,
    false,
  );
  assert.equal(
    ContentBulkOperationInputSchema.safeParse({
      action: "move",
      documentIds: ["doc-1"],
      move: {
        targetDirectory: "archive",
        unexpected: true,
      },
    }).success,
    false,
  );
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
