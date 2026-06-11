import { RuntimeError } from "@mdcms/shared";
import { Editor, type JSONContent } from "@tiptap/core";

import { createEditorCoreExtensions } from "./editor-extensions.js";
import { parseMdxMarkdownToTipTapDocument } from "./mdx-markdown-parser.js";

function createMarkdownEditor(content: string | JSONContent): Editor {
  // TipTap's core editor can parse/serialize markdown in the Bun test runtime,
  // so the markdown pipeline now exercises the same engine in tests and UI code.
  return new Editor({
    content,
    contentType: typeof content === "string" ? "markdown" : "json",
    extensions: createEditorCoreExtensions(),
  });
}

function assertMarkdownString(markdown: unknown, source: string): string {
  if (typeof markdown === "string") {
    return markdown;
  }

  throw new RuntimeError({
    code: "MARKDOWN_SERIALIZATION_FAILED",
    message: `TipTap markdown serializer (${source}) returned a non-string value.`,
    statusCode: 500,
  });
}

export function extractMarkdownFromEditor(editor: Editor): string {
  // TipTap v3 has exposed markdown serialization through both
  // `editor.getMarkdown()` and `editor.storage.markdown.getMarkdown()`.
  // The double cast keeps this duck-typing local, while the RuntimeError
  // fallback makes a future API move fail explicitly instead of serializing
  // an empty draft.
  const maybeGetMarkdown = (editor as unknown as { getMarkdown?: () => string })
    .getMarkdown;

  if (typeof maybeGetMarkdown === "function") {
    return assertMarkdownString(
      maybeGetMarkdown.call(editor),
      "editor.getMarkdown",
    );
  }

  const markdownStorage = (
    editor as unknown as {
      storage?: { markdown?: { getMarkdown?: () => string } };
    }
  ).storage?.markdown;

  if (typeof markdownStorage?.getMarkdown === "function") {
    return assertMarkdownString(
      markdownStorage.getMarkdown(),
      "editor.storage.markdown.getMarkdown",
    );
  }

  throw new RuntimeError({
    code: "MARKDOWN_SERIALIZATION_UNAVAILABLE",
    message: "TipTap markdown serializer is unavailable in this runtime.",
    statusCode: 500,
  });
}

export function parseMarkdownToDocument(markdown: string): JSONContent {
  return parseMdxMarkdownToTipTapDocument(markdown);
}

export function serializeDocumentToMarkdown(document: JSONContent): string {
  const editor = createMarkdownEditor(document);

  try {
    return extractMarkdownFromEditor(editor);
  } finally {
    editor.destroy();
  }
}

export function roundTripMarkdown(markdown: string): {
  document: JSONContent;
  markdown: string;
} {
  const document = parseMarkdownToDocument(markdown);
  const serialized = serializeDocumentToMarkdown(document);

  return {
    document,
    markdown: serialized,
  };
}
