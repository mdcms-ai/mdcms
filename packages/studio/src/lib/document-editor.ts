import { Editor } from "@tiptap/core";

import { createEditorExtensions } from "./editor-extensions.js";
import {
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
} from "./markdown-pipeline.js";

export type CreateDocumentEditorInput = {
  content: string;
  onChange?: (markdown: string) => void;
};

export function createDocumentEditor(input: CreateDocumentEditorInput): Editor {
  return new Editor({
    content: parseMarkdownToDocument(input.content),
    contentType: "json",
    extensions: createEditorExtensions(),
    onUpdate({ editor }) {
      // Nested MDX wrapper content lives in the same ProseMirror tree as the
      // rest of the document, so every update still serializes one draft body.
      input.onChange?.(extractMarkdownFromEditor(editor));
    },
  });
}
