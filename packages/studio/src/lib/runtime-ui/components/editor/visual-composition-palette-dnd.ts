import type { DragEvent } from "react";

import type { VisualCompositionBlock } from "./visual-composition-types.js";

const VISUAL_COMPOSITION_DRAG_MIME = "application/x-mdcms-visual-block";

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
  event: DragEvent<HTMLElement>,
): VisualCompositionBlock | null {
  const raw = event.dataTransfer.getData(VISUAL_COMPOSITION_DRAG_MIME);

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
  event: DragEvent<HTMLElement>,
): boolean {
  return Array.from(event.dataTransfer.types).includes(
    VISUAL_COMPOSITION_DRAG_MIME,
  );
}
