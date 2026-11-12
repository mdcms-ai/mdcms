import type { DragEvent } from "react";

import type { VisualCompositionBlock } from "./visual-composition-types.js";

const VISUAL_COMPOSITION_DRAG_MIME = "application/x-mdcms-visual-block";

/**
 * The parts of a drag event the palette payload helpers read. Both React
 * synthetic events and the native events ProseMirror hands to `handleDrop`
 * satisfy it.
 */
export type VisualCompositionDragEventLike = {
  dataTransfer: Pick<DataTransfer, "getData" | "types"> | null;
};

export type VisualCompositionDropEventLike = VisualCompositionDragEventLike & {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
};

export function writeVisualCompositionDragPayload(
  event: DragEvent<HTMLElement>,
  block: VisualCompositionBlock,
): void {
  event.dataTransfer.effectAllowed = "copy";
  // ProseMirror's dropcursor only paints when the browser drag carries a
  // readable slice such as text/plain. The custom MIME still drives the real
  // MDCMS insertion on drop; this label is just enough for live positioning.
  event.dataTransfer.setData("text/plain", block.label);
  event.dataTransfer.setData(
    VISUAL_COMPOSITION_DRAG_MIME,
    JSON.stringify({ block }),
  );
}

export function readVisualCompositionDragPayload(
  event: VisualCompositionDragEventLike,
): VisualCompositionBlock | null {
  const raw = event.dataTransfer?.getData(VISUAL_COMPOSITION_DRAG_MIME);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { block?: VisualCompositionBlock };
    return parsed.block ?? null;
  } catch {
    return null;
  }
}

export function hasVisualCompositionDragPayload(
  event: VisualCompositionDragEventLike,
): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(
    VISUAL_COMPOSITION_DRAG_MIME,
  );
}

/**
 * Handles a drop that carries a palette payload, wherever it lands.
 *
 * The payload also sets `text/plain` to the block label, so a drop the
 * editor does not claim would be pasted as that label. This helper claims
 * every palette drop (returns `true` and prevents the default), and asks for
 * a component or Markdown block insertion at the drop point unless the
 * editor is read-only. Because it prevents the default, the canvas-level
 * drop handler, which skips already-handled events, cannot insert a second
 * copy.
 *
 * Returns `false` for drops without a palette payload so other handlers
 * (such as media upload) can run.
 */
export function handleVisualCompositionDrop(
  event: VisualCompositionDropEventLike,
  input: {
    readOnly: boolean;
    resolvePosition: (
      event: VisualCompositionDropEventLike,
    ) => number | undefined;
    requestInsertion: (
      block: VisualCompositionBlock,
      position?: number,
    ) => void;
  },
): boolean {
  if (!hasVisualCompositionDragPayload(event)) {
    return false;
  }

  event.preventDefault();

  if (input.readOnly) {
    return true;
  }

  const block = readVisualCompositionDragPayload(event);

  if (block) {
    input.requestInsertion(block, input.resolvePosition(event));
  }

  return true;
}
