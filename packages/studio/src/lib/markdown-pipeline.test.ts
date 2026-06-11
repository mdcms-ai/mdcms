import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  extractMarkdownFromEditor as extractMarkdownFromCoreEditor,
  parseMarkdownToDocument as parseCoreMarkdownToDocument,
  roundTripMarkdown as roundTripCoreMarkdown,
  serializeDocumentToMarkdown as serializeCoreDocumentToMarkdown,
} from "@mdcms/editor-core";

import {
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
  roundTripMarkdown,
  serializeDocumentToMarkdown,
} from "./markdown-pipeline.js";

test("studio markdown pipeline re-exports editor core helpers", () => {
  assert.equal(parseMarkdownToDocument, parseCoreMarkdownToDocument);
  assert.equal(serializeDocumentToMarkdown, serializeCoreDocumentToMarkdown);
  assert.equal(roundTripMarkdown, roundTripCoreMarkdown);
  assert.equal(extractMarkdownFromEditor, extractMarkdownFromCoreEditor);
});

test("studio markdown pipeline keeps the compatibility subpath usable", () => {
  const result = roundTripMarkdown("# Launch Notes\n\nShip it.");

  assert.equal(result.document.type, "doc");
  assert.match(result.markdown, /# Launch Notes/);
  assert.match(result.markdown, /Ship it\./);
});
