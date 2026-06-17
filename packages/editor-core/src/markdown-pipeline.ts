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

function isEmptyParagraphNode(node: JSONContent | undefined): boolean {
  return (
    node?.type === "paragraph" && (!node.content || node.content.length === 0)
  );
}

function dropTrailingEmptyParagraphs(content: JSONContent[] | undefined): {
  content: JSONContent[] | undefined;
  changed: boolean;
} {
  if (!content || content.length === 0) {
    return { content, changed: false };
  }

  let end = content.length;
  while (end > 1 && isEmptyParagraphNode(content[end - 1])) {
    end -= 1;
  }

  if (end === content.length) {
    return { content, changed: false };
  }

  return {
    content: content.slice(0, end),
    changed: true,
  };
}

function normalizeEditorDocumentForMarkdown(document: JSONContent): {
  document: JSONContent;
  changed: boolean;
} {
  const normalized = dropTrailingEmptyParagraphs(document.content);

  if (!normalized.changed) {
    return { document, changed: false };
  }

  return {
    document: {
      ...document,
      ...(normalized.content ? { content: normalized.content } : {}),
    },
    changed: true,
  };
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

function extractRawMarkdownFromEditor(editor: Editor): string {
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

function serializeNormalizedDocumentToMarkdown(document: JSONContent): string {
  const normalized = normalizeEditorDocumentForMarkdown(document);
  const editor = createMarkdownEditor(normalized.document);

  try {
    return extractRawMarkdownFromEditor(editor);
  } finally {
    editor.destroy();
  }
}

export function extractMarkdownFromEditor(editor: Editor): string {
  const getJSON = (editor as unknown as { getJSON?: () => JSONContent })
    .getJSON;

  if (typeof getJSON === "function") {
    const normalized = normalizeEditorDocumentForMarkdown(getJSON.call(editor));

    if (normalized.changed) {
      return serializeNormalizedDocumentToMarkdown(normalized.document);
    }
  }

  return extractRawMarkdownFromEditor(editor);
}

export function parseMarkdownToDocument(markdown: string): JSONContent {
  return parseMdxMarkdownToTipTapDocument(markdown);
}

export function serializeDocumentToMarkdown(document: JSONContent): string {
  return serializeNormalizedDocumentToMarkdown(document);
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
