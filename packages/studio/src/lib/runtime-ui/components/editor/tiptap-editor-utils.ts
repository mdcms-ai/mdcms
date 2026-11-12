import type { Editor } from "@tiptap/core";

import type { StudioMountContext } from "@mdcms/shared";

import { serializeDocumentToMarkdown } from "../../../markdown-pipeline.js";
import { createMdxComponentInsertContent } from "./mdx-component-catalog.js";
import {
  getSlashTriggerCoords,
  replaceSlashTriggerWithMdxComponent,
  type MdxComponentSlashTrigger,
  type SlashTriggerCoords,
} from "./mdx-component-slash.js";
import type { MdxCatalogComponent } from "./visual-composition-types.js";

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

/**
 * Whether an insert that captured `editor` may still dispatch to it.
 *
 * The editor is recreated when its dependencies change (for example when the
 * host bridge changes). A picker, dialog or slash menu opened against the
 * previous instance must not dispatch to it: its state no longer matches the
 * live editor, so the insert would be lost or rejected as a mismatched
 * transaction.
 */
export function isLiveTipTapEditor(
  editor: Editor | null,
  liveEditor: Editor | null,
): editor is Editor {
  return editor !== null && editor === liveEditor && !editor.isDestroyed;
}

/**
 * Inserts a component chosen in the slash menu or the toolbar picker.
 * With a slash trigger the `/query` text is replaced; otherwise the component
 * goes at the current selection. Returns `false` without touching any
 * document when the captured editor is no longer the live one or the slash
 * trigger no longer matches the document.
 */
export function insertMdxComponentFromPicker(input: {
  editor: Editor | null;
  liveEditor: Editor | null;
  slashTrigger: MdxComponentSlashTrigger | null;
  component: MdxCatalogComponent;
}): boolean {
  if (!isLiveTipTapEditor(input.editor, input.liveEditor)) {
    return false;
  }

  if (input.slashTrigger) {
    return replaceSlashTriggerWithMdxComponent(
      input.editor,
      input.slashTrigger,
      input.component,
    );
  }

  return input.editor.commands.insertContent(
    createMdxComponentInsertContent(input.component),
  );
}
