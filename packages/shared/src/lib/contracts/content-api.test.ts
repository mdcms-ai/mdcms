import assert from "node:assert/strict";
import { test } from "bun:test";

import { ContentBulkOperationInputSchema } from "./content-api.js";

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
