import type { Editor } from "@tiptap/core";

import type { StudioMountContext } from "@mdcms/shared";

import { createMdxComponentInsertContent } from "./mdx-component-catalog.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type MdxComponentSlashTrigger = {
  query: string;
  from: number;
  to: number;
};

const MDX_COMPONENT_SLASH_QUERY_PATTERN = /(?:^|\s)\/([A-Za-z0-9._-]*)$/;

export function getMdxComponentSlashTrigger(
  editor: Editor,
): MdxComponentSlashTrigger | null {
  const { selection } = editor.state;

  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  const parent = $from.parent;

  if (!parent.isTextblock) {
    return null;
  }

  const textBefore = parent.textBetween(0, $from.parentOffset, undefined, "");
  const match = MDX_COMPONENT_SLASH_QUERY_PATTERN.exec(textBefore);

  if (!match) {
    return null;
  }

  const prefix = match[0];
  const query = match[1] ?? "";
  const slashOffset =
    textBefore.length - prefix.length + (prefix.startsWith(" ") ? 1 : 0);

  return {
    query,
    from: $from.pos - ($from.parentOffset - slashOffset),
    to: $from.pos,
  };
}

/**
 * Whether `trigger` still points at its `/query` text in the editor's current
 * document. A trigger captured before the document changed (or against an
 * editor that has since been replaced) can point at unrelated text.
 */
export function isMdxComponentSlashTriggerCurrent(
  editor: Editor,
  trigger: MdxComponentSlashTrigger,
): boolean {
  const { doc } = editor.state;

  if (
    trigger.from < 0 ||
    trigger.to < trigger.from ||
    trigger.to > doc.content.size
  ) {
    return false;
  }

  return (
    doc.textBetween(trigger.from, trigger.to, "\n") === `/${trigger.query}`
  );
}

/**
 * Replaces the `/query` text with the component. Returns `false` and leaves
 * the document untouched when the trigger no longer matches the document, so
 * a stale insert never deletes unrelated text.
 */
export function replaceSlashTriggerWithMdxComponent(
  editor: Editor,
  trigger: MdxComponentSlashTrigger,
  component: MdxCatalogComponent,
  props: Record<string, unknown> = {},
): boolean {
  if (!isMdxComponentSlashTriggerCurrent(editor, trigger)) {
    return false;
  }

  return editor.commands.insertContentAt(
    {
      from: trigger.from,
      to: trigger.to,
    },
    createMdxComponentInsertContent(component, props),
  );
}

export type SlashTriggerCoords = {
  top: number;
  left: number;
  cursorTop: number;
  cursorBottom: number;
};

export type SlashPickerVirtualReference = {
  contextElement?: Element;
  getBoundingClientRect: () => DOMRect;
};

export function getSlashTriggerCoords(
  view: {
    coordsAtPos: (pos: number) => { top: number; left: number; bottom: number };
  },
  trigger: MdxComponentSlashTrigger,
  _container?: { getBoundingClientRect: () => { top: number; left: number } },
): SlashTriggerCoords {
  const cursorCoords = view.coordsAtPos(trigger.to);

  return {
    top: cursorCoords.bottom,
    left: cursorCoords.left,
    cursorTop: cursorCoords.top,
    cursorBottom: cursorCoords.bottom,
  };
}

export function createSlashPickerVirtualReference(input: {
  getAnchor: () => SlashTriggerCoords;
  contextElement?: Element | null;
}): SlashPickerVirtualReference {
  return {
    contextElement: input.contextElement ?? undefined,
    getBoundingClientRect: () => {
      const anchor = input.getAnchor();
      const height = Math.max(anchor.cursorBottom - anchor.cursorTop, 0);
      const left = anchor.left;
      const top = anchor.cursorTop;
      const bottom = top + height;

      return {
        x: left,
        y: top,
        top,
        right: left,
        bottom,
        left,
        width: 0,
        height,
        toJSON: () => ({
          x: left,
          y: top,
          top,
          right: left,
          bottom,
          left,
          width: 0,
          height,
        }),
      } satisfies DOMRect;
    },
  };
}
