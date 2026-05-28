"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";

import type { TipTapEditorSelectionInfo } from "./tiptap-editor.js";
import { getPickerOffscreenHintLeft } from "./inline-ai-offscreen-hint-position.js";
import { cn } from "../../lib/utils.js";

/**
 * Hint pill shown when the picker is open but its anchor (the
 * selection) has scrolled out of view. Anchored inside the editor
 * surface, centered horizontally on the relevant edge. Clicking
 * scrolls the selection back so the picker is on screen again.
 */
export function PickerOffscreenHint(props: {
  selection: TipTapEditorSelectionInfo | null;
  pickerOpen: boolean;
}) {
  const { selection, pickerOpen } = props;
  const [, force] = useState(0);
  const editorEl = useMemo(() => {
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLElement>(
      '[data-mdcms-editor-pane="canvas"]',
    );
  }, []);

  // Re-render on viewport scroll/resize so visibility tracks the
  // selection rect as the user scrolls past it.
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = () => force((n) => n + 1);
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [pickerOpen]);

  if (!pickerOpen || !selection) return null;

  const anchor = selection.anchorRect;
  const viewportTop = 0;
  const viewportBottom =
    typeof window === "undefined" ? Infinity : window.innerHeight;
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;

  // Picker sits below selection; we treat it as ~280px tall when
  // computing visibility (real height varies with scroll).
  const ASSUMED_PICKER_HEIGHT = 280;
  const pickerTop = anchor.bottom + 8;
  const pickerBottom = pickerTop + ASSUMED_PICKER_HEIGHT;

  const visibleTop = Math.max(pickerTop, viewportTop);
  const visibleBottom = Math.min(pickerBottom, viewportBottom);
  const visiblePx = Math.max(0, visibleBottom - visibleTop);
  const visibleFrac = visiblePx / ASSUMED_PICKER_HEIGHT;

  // Don't surface the hint until most of the picker is clipped.
  if (visibleFrac > 0.6) return null;

  const aboveViewport = anchor.bottom < viewportTop + 40;
  const direction: "up" | "down" = aboveViewport ? "up" : "down";

  const onClick = () => {
    if (!editorEl) {
      const targetTop = aboveViewport
        ? Math.max(0, anchor.top - 80)
        : window.scrollY + (anchor.bottom - viewportBottom + 320);
      window.scrollTo({ top: targetTop, behavior: "smooth" });
      return;
    }
    if (aboveViewport) {
      editorEl.scrollBy({ top: anchor.top - 80, behavior: "smooth" });
    } else {
      editorEl.scrollBy({
        top: pickerBottom - viewportBottom + 24,
        behavior: "smooth",
      });
    }
  };

  // Anchor the hint inside the editor surface when present, else
  // fall back to viewport edge.
  const surfaceRect = editorEl?.getBoundingClientRect();
  const left = getPickerOffscreenHintLeft(surfaceRect, viewportWidth);
  const top = aboveViewport
    ? (surfaceRect?.top ?? 16) + 16
    : (surfaceRect?.bottom ?? viewportBottom - 16) - 48;

  const Arrow = direction === "up" ? ArrowUp : ArrowDown;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="inline-ai-offscreen-hint"
      aria-label={`Picker ${direction === "up" ? "above" : "below"} viewport - scroll to view`}
      style={{
        position: "fixed",
        top,
        left,
        transform: "translateX(-50%)",
        zIndex: 70,
      }}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5",
        "border border-border bg-popover/95 backdrop-blur-md shadow-lg",
        "font-mono text-[11px] uppercase tracking-[0.04em] text-popover-foreground",
        "hover:bg-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
      )}
    >
      <Arrow className="size-3.5 text-primary" aria-hidden />
      Picker {direction === "up" ? "above" : "below"} - scroll to view
    </button>
  );
}
