import type { Editor } from "@tiptap/core";

import type { StudioMountContext } from "@mdcms/shared";

import { serializeDocumentToMarkdown } from "../../../markdown-pipeline.js";
import {
  getSlashTriggerCoords,
  type MdxComponentSlashTrigger,
  type SlashTriggerCoords,
} from "./mdx-component-slash.js";

export type TipTapEditorSerializedSelection = {
  text: string;
  mode: "markdown" | "text";
};

export function stripBlockMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*([-*+])\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*#{1,6}\s+/, ""),
    )
    .join("\n");
}

export function getSelectionMarkdownForAi(
  editor: Editor,
  input: { from: number; to: number },
): TipTapEditorSerializedSelection | null {
  const docSize = editor.state.doc.content.size;
  if (input.from < 0 || input.to > docSize || input.from > input.to) {
    return null;
  }
  if (input.from === input.to) {
    return { text: "", mode: "text" };
  }

  // Whole-block cuts preserve markdown structure; mid-block cuts stay plain
  // text so inline replacements do not create accidental nested blocks.
  const $from = editor.state.doc.resolve(input.from);
  const $to = editor.state.doc.resolve(input.to);
  const isWholeBlockCut =
    $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;

  if (!isWholeBlockCut) {
    return {
      text: editor.state.doc.textBetween(input.from, input.to, "\n", "\n"),
      mode: "text",
    };
  }

  const slice = editor.state.doc.slice(input.from, input.to, true);
  const fragmentJson = slice.content.toJSON() as
    | Array<Record<string, unknown>>
    | undefined;

  return {
    text: serializeDocumentToMarkdown({
      type: "doc",
      content: fragmentJson ?? [],
    }),
    mode: "markdown",
  };
}

export function createTipTapEditorDependencies(input: {
  placeholder: string;
  hostBridge: StudioMountContext["hostBridge"] | undefined;
  readOnly: boolean;
  forbidden: boolean;
}) {
  return [input.placeholder, input.hostBridge, input.readOnly, input.forbidden];
}

export function resolveSlashPickerCoordsForEditor(input: {
  editor: {
    view: Parameters<typeof getSlashTriggerCoords>[0];
  };
  trigger: MdxComponentSlashTrigger;
  container: Parameters<typeof getSlashTriggerCoords>[2];
}): SlashTriggerCoords | null {
  try {
    return getSlashTriggerCoords(
      input.editor.view,
      input.trigger,
      input.container,
    );
  } catch {
    return null;
  }
}

export function resolveVisualDropPosition(
  editor: Editor,
  event: { clientX: number; clientY: number },
): number | undefined {
  try {
    return (
      editor.view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      })?.pos ?? undefined
    );
  } catch {
    return undefined;
  }
}
