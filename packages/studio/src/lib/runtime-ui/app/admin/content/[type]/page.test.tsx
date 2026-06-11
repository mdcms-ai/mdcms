import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContentBulkOperationResponse } from "@mdcms/shared";

import type { MappedContentDocument } from "../../../../hooks/use-content-type-list.js";
import {
  getAvailableBulkActions,
  getBulkOperationTargets,
  validateBulkMoveTargetDirectory,
  type ContentBulkCapabilities,
} from "../../../../lib/content-bulk-actions.js";
import {
  createBulkOperationFailureBanner,
  createBulkOperationRequest,
  formatBulkOperationFailureBanner,
  getContentTypeTableColumns,
  TranslationCoverageSummary,
} from "./page.js";
import * as pageModule from "./page.js";

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

const allBulkCapabilities: ContentBulkCapabilities = {
  canPublishContent: true,
  canUnpublishContent: true,
  canWriteContent: true,
  canDeleteContent: true,
};

const bulkResultDocument: ContentBulkOperationResponse["results"][number] = {
  documentId: "doc-1",
  status: "succeeded",
  document: {
    documentId: "doc-1",
    translationGroupId: "tg-doc-1",
    project: "marketing",
    environment: "production",
    path: "content/doc-1",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 1,
    publishedVersion: 1,
    draftRevision: 0,
    frontmatter: { title: "Document 1" },
    body: "# Document 1",
    createdBy: "user-1",
    createdAt: "2026-06-06T10:00:00.000Z",
    updatedBy: "user-1",
    updatedAt: "2026-06-06T10:00:00.000Z",
  },
};

test("TranslationCoverageSummary renders nothing for the idle state", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "idle",
    }),
  );

  assert.equal(markup, "");
  assert.doesNotMatch(markup, /data-mdcms-translation-coverage-state/);
  assert.doesNotMatch(markup, /Loading/i);
  assert.doesNotMatch(markup, /Translation status unavailable/i);
});

test("TranslationCoverageSummary renders the loading state deterministically", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "loading",
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="loading"/);
  assert.match(markup, /Loading locale coverage/i);
});

test("TranslationCoverageSummary renders the translated locale count", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "ready",
      coverage: {
        translatedLocales: 2,
        totalLocales: 4,
      },
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="ready"/);
  assert.match(markup, /2\/4 locales translated/);
});

test("TranslationCoverageSummary renders an error fallback when coverage is unavailable", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "error",
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="error"/);
  assert.match(markup, /Translation status unavailable/i);
});

test("content type table starts with selection and ends with actions for non-localized lists", () => {
  const columns = getContentTypeTableColumns(false);

  assert.equal(columns[0]?.key, "selection");
  assert.equal(columns.at(-1)?.key, "actions");
});

test("content type table includes selection, translations, and actions for localized lists", () => {
  const columns = getContentTypeTableColumns(true).map((column) => column.key);

  assert.equal(columns[0], "selection");
  assert.ok(columns.includes("translations"));
  assert.equal(columns.at(-1), "actions");
});

test("bulk delete confirmation mentions Trash and selected count", () => {
  const helper = pageModule.getBulkConfirmationText as (input: {
    action: "delete";
    selectedCount: number;
    targetCount: number;
  }) => { title: string; description: string; confirmLabel: string };

  assert.equal(typeof helper, "function");

  const text = helper({
    action: "delete",
    selectedCount: 3,
    targetCount: 3,
  });
  const copy = `${text.title} ${text.description} ${text.confirmLabel}`;

  assert.match(copy, /Trash/);
  assert.match(copy, /3/);
});

test("bulk publish confirmation reports eligible and selected counts with skip copy", () => {
  const selectedDocuments = [
    document("published", "published"),
    document("draft", "draft"),
    document("changed", "changed"),
  ];
  const targetCount = getBulkOperationTargets(
    "publish",
    selectedDocuments,
  ).length;

  const text = pageModule.getBulkConfirmationText({
    action: "publish",
    selectedCount: selectedDocuments.length,
    targetCount,
  });

  assert.equal(text.title, "Publish documents");
  assert.match(
    text.description,
    /2 documents will be published from 3 selected documents/,
  );
  assert.match(
    text.description,
    /Already published documents without changes are skipped/,
  );
  assert.equal(text.confirmLabel, "Publish");
});

test("bulk unpublish confirmation reports published and selected counts", () => {
  const selectedDocuments = [
    document("published", "published"),
    document("draft", "draft"),
    document("changed", "changed"),
  ];
  const targetCount = getBulkOperationTargets(
    "unpublish",
    selectedDocuments,
  ).length;

  const text = pageModule.getBulkConfirmationText({
    action: "unpublish",
    selectedCount: selectedDocuments.length,
    targetCount,
  });

  assert.equal(text.title, "Unpublish documents");
  assert.match(
    text.description,
    /1 published document will be unpublished from 3 selected documents/,
  );
  assert.equal(text.confirmLabel, "Unpublish");
});

test("bulk move target validation rejects leading slash with page-level copy", () => {
  assert.deepEqual(validateBulkMoveTargetDirectory("/archive"), {
    ok: false,
    message: "Target folder must not start with /.",
  });
});

test("bulk action availability follows capability and selected status rules", () => {
  const selectedDocuments = [
    document("published", "published"),
    document("draft", "draft"),
    document("changed", "changed"),
  ];

  assert.deepEqual(
    getAvailableBulkActions(selectedDocuments, allBulkCapabilities),
    ["publish", "unpublish", "move", "delete"],
  );
  assert.deepEqual(
    getAvailableBulkActions(selectedDocuments, {
      ...allBulkCapabilities,
      canPublishContent: false,
      canWriteContent: false,
    }),
    ["unpublish", "delete"],
  );
  assert.deepEqual(
    getAvailableBulkActions([document("published", "published")], {
      ...allBulkCapabilities,
      canUnpublishContent: false,
      canDeleteContent: false,
    }),
    ["move"],
  );
});

test("createBulkOperationRequest builds move payload with selected document ids and schema hash", () => {
  assert.deepEqual(
    createBulkOperationRequest({
      action: "move",
      selectedDocuments: [
        document("doc-1", "published"),
        document("doc-2", "draft"),
      ],
      targetDirectory: "archive",
      schemaHash: "schema-hash-123",
    }),
    {
      action: "move",
      documentIds: ["doc-1", "doc-2"],
      move: {
        targetDirectory: "archive",
      },
      schemaHash: "schema-hash-123",
    },
  );
});

test("formatBulkOperationFailureBanner reports partial failure counts and first failure", () => {
  const response = {
    action: "publish",
    requested: 3,
    succeeded: 1,
    failed: 2,
    results: [
      bulkResultDocument,
      {
        documentId: "doc-2",
        status: "failed",
        error: {
          code: "CONTENT_VALIDATION_FAILED",
          message: "Title is required.",
          statusCode: 422,
        },
      },
      {
        documentId: "doc-3",
        status: "failed",
        error: {
          code: "CONTENT_FORBIDDEN",
          message: "Cannot publish this document.",
          statusCode: 403,
        },
      },
    ],
  } satisfies ContentBulkOperationResponse;

  const banner = createBulkOperationFailureBanner(response);

  assert.deepEqual(banner, {
    succeeded: 1,
    failed: 2,
    message: "Title is required.",
  });
  assert.ok(banner);
  assert.equal(
    formatBulkOperationFailureBanner(banner),
    "1 succeeded, 2 failed. First failure: Title is required.",
  );
});

test("content type table adds a dedicated Translations column for localized lists", () => {
  assert.deepEqual(
    getContentTypeTableColumns(true).map((column) => column.label),
    ["", "Title / Path", "Translations", "Status", "Updated", "Author", ""],
  );
});

test("content type table keeps the original columns for non-localized lists", () => {
  assert.deepEqual(
    getContentTypeTableColumns(false).map((column) => column.label),
    ["", "Title / Path", "Status", "Updated", "Author", ""],
  );
});
