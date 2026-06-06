import assert from "node:assert/strict";

import { test } from "bun:test";

import type { MappedContentDocument } from "../hooks/use-content-type-list.js";
import {
  formatBulkOperationSummary,
  getAvailableBulkActions,
  getBulkOperationTargets,
  getSelectedDocuments,
  validateBulkMoveTargetDirectory,
  type ContentBulkCapabilities,
} from "./content-bulk-actions.js";

function document(
  documentId: string,
  status: MappedContentDocument["status"],
): MappedContentDocument {
  return {
    documentId,
    translationGroupId: `tg-${documentId}`,
    title: documentId,
    path: `content/${documentId}`,
    locale: "en",
    status,
    updatedAt: "2026-06-06T10:00:00.000Z",
    createdBy: "user-1",
    updatedBy: "user-1",
  };
}

const allCapabilities: ContentBulkCapabilities = {
  canPublishContent: true,
  canUnpublishContent: true,
  canWriteContent: true,
  canDeleteContent: true,
};

test("getSelectedDocuments preserves rendered document order", () => {
  const documents = [
    document("doc-1", "published"),
    document("doc-2", "draft"),
    document("doc-3", "changed"),
  ];

  const selected = getSelectedDocuments(documents, new Set(["doc-3", "doc-1"]));

  assert.deepEqual(
    selected.map((doc) => doc.documentId),
    ["doc-1", "doc-3"],
  );
});

test("getBulkOperationTargets filters publish and unpublish targets by status", () => {
  const selectedDocuments = [
    document("published", "published"),
    document("draft", "draft"),
    document("changed", "changed"),
  ];

  assert.deepEqual(
    getBulkOperationTargets("publish", selectedDocuments).map(
      (doc) => doc.documentId,
    ),
    ["draft", "changed"],
  );
  assert.deepEqual(
    getBulkOperationTargets("unpublish", selectedDocuments).map(
      (doc) => doc.documentId,
    ),
    ["published"],
  );
});

test("getBulkOperationTargets includes all selected documents for move and delete", () => {
  const selectedDocuments = [
    document("published", "published"),
    document("draft", "draft"),
    document("changed", "changed"),
  ];

  assert.deepEqual(
    getBulkOperationTargets("move", selectedDocuments).map(
      (doc) => doc.documentId,
    ),
    ["published", "draft", "changed"],
  );
  assert.deepEqual(
    getBulkOperationTargets("delete", selectedDocuments).map(
      (doc) => doc.documentId,
    ),
    ["published", "draft", "changed"],
  );
});

test("getAvailableBulkActions follows capability and selected status rules in toolbar order", () => {
  assert.deepEqual(
    getAvailableBulkActions(
      [document("published", "published"), document("changed", "changed")],
      allCapabilities,
    ),
    ["publish", "unpublish", "move", "delete"],
  );

  assert.deepEqual(
    getAvailableBulkActions([document("published", "published")], {
      ...allCapabilities,
      canUnpublishContent: false,
      canDeleteContent: false,
    }),
    ["move"],
  );

  assert.deepEqual(
    getAvailableBulkActions([document("published", "published")], {
      ...allCapabilities,
      canUnpublishContent: false,
      canWriteContent: false,
      canDeleteContent: false,
    }),
    [],
  );

  assert.deepEqual(
    getAvailableBulkActions([document("draft", "draft")], {
      ...allCapabilities,
      canPublishContent: false,
      canWriteContent: false,
    }),
    ["delete"],
  );

  assert.deepEqual(getAvailableBulkActions([], allCapabilities), []);
});

test("validateBulkMoveTargetDirectory trims and accepts root or nested folders", () => {
  assert.deepEqual(validateBulkMoveTargetDirectory("   "), {
    ok: true,
    value: "",
  });
  assert.deepEqual(validateBulkMoveTargetDirectory(" archive/news "), {
    ok: true,
    value: "archive/news",
  });
});

test("validateBulkMoveTargetDirectory rejects leading slash, trailing slash, and traversal", () => {
  assert.deepEqual(validateBulkMoveTargetDirectory("/archive"), {
    ok: false,
    message: "Target folder must not start with /.",
  });
  assert.deepEqual(validateBulkMoveTargetDirectory("archive/"), {
    ok: false,
    message: "Target folder must not end with /.",
  });
  assert.deepEqual(validateBulkMoveTargetDirectory("../archive"), {
    ok: false,
    message: "Target folder must not contain .. path segments.",
  });
  assert.deepEqual(validateBulkMoveTargetDirectory("archive/../news"), {
    ok: false,
    message: "Target folder must not contain .. path segments.",
  });
});

test("formatBulkOperationSummary includes action count and Trash copy for delete", () => {
  assert.equal(
    formatBulkOperationSummary("publish", 2),
    "Publish 2 documents.",
  );
  assert.equal(
    formatBulkOperationSummary("unpublish", 1),
    "Unpublish 1 document.",
  );
  assert.equal(formatBulkOperationSummary("move", 3), "Move 3 documents.");
  assert.equal(
    formatBulkOperationSummary("delete", 2),
    "Move 2 documents to Trash.",
  );
});
