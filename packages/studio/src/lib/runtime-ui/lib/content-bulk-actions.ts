import type { ContentBulkAction } from "@mdcms/shared";

import type { MappedContentDocument } from "../hooks/use-content-type-list.js";

export type ContentBulkCapabilities = {
  canPublishContent: boolean;
  canUnpublishContent: boolean;
  canWriteContent: boolean;
  canDeleteContent: boolean;
};

export type ContentBulkUiAction = ContentBulkAction;

export function getSelectedDocuments(
  documents: MappedContentDocument[],
  selectedDocumentIds: ReadonlySet<string>,
): MappedContentDocument[] {
  return documents.filter((document) =>
    selectedDocumentIds.has(document.documentId),
  );
}

export function getBulkOperationTargets(
  action: ContentBulkAction,
  selectedDocuments: MappedContentDocument[],
): MappedContentDocument[] {
  switch (action) {
    case "publish":
      return selectedDocuments.filter(
        (document) =>
          document.status === "draft" || document.status === "changed",
      );
    case "unpublish":
      return selectedDocuments.filter(
        (document) => document.status === "published",
      );
    case "delete":
    case "move":
      return selectedDocuments;
  }
}

export function getAvailableBulkActions(
  selectedDocuments: MappedContentDocument[],
  capabilities: ContentBulkCapabilities,
): ContentBulkAction[] {
  if (selectedDocuments.length === 0) {
    return [];
  }

  const actions: ContentBulkAction[] = [];

  if (
    capabilities.canPublishContent &&
    getBulkOperationTargets("publish", selectedDocuments).length > 0
  ) {
    actions.push("publish");
  }

  if (
    capabilities.canUnpublishContent &&
    getBulkOperationTargets("unpublish", selectedDocuments).length > 0
  ) {
    actions.push("unpublish");
  }

  if (capabilities.canWriteContent) {
    actions.push("move");
  }

  if (capabilities.canDeleteContent) {
    actions.push("delete");
  }

  return actions;
}

export function validateBulkMoveTargetDirectory(
  value: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim();

  if (trimmed === "") {
    return { ok: true, value: "" };
  }

  if (trimmed.startsWith("/")) {
    return {
      ok: false,
      message: "Target folder must not start with /.",
    };
  }

  if (trimmed.endsWith("/")) {
    return {
      ok: false,
      message: "Target folder must not end with /.",
    };
  }

  if (trimmed.split("/").includes("..")) {
    return {
      ok: false,
      message: "Target folder must not contain .. path segments.",
    };
  }

  return { ok: true, value: trimmed };
}

export function formatBulkOperationSummary(
  action: ContentBulkAction,
  count: number,
): string {
  const documents = count === 1 ? "document" : "documents";

  switch (action) {
    case "publish":
      return `Publish ${count} ${documents}.`;
    case "unpublish":
      return `Unpublish ${count} ${documents}.`;
    case "move":
      return `Move ${count} ${documents}.`;
    case "delete":
      return `Move ${count} ${documents} to Trash.`;
  }
}
