"use client";

import * as React from "react";

import { cn } from "../../lib/utils.js";
import {
  ASSISTANT_RAIL_DEFAULT_WIDTH,
  ASSISTANT_RAIL_MAX_WIDTH,
  ASSISTANT_RAIL_MIN_WIDTH,
  clampAssistantRailWidth,
  useAssistant,
} from "./assistant-context.js";
import { AssistantPanel } from "./assistant-panel.js";

const RAIL_RESIZE_STEP = 24;

type AssistantRailCssVars = React.CSSProperties & {
  "--mdcms-assistant-rail-width"?: string;
};

function useAssistantRailResizeHandlers() {
  const assistant = useAssistant();
  const dragState = React.useRef<{
    startX: number;
    startWidth: number;
    previousCursor: string;
    previousUserSelect: string;
  } | null>(null);

  const finishResize = React.useCallback(() => {
    const state = dragState.current;
    if (!state || typeof document === "undefined") return;
    document.body.style.cursor = state.previousCursor;
    document.body.style.userSelect = state.previousUserSelect;
    dragState.current = null;
  }, []);

  React.useEffect(() => finishResize, [finishResize]);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (typeof document !== "undefined") {
        dragState.current = {
          startX: event.clientX,
          startWidth: assistant.railWidth,
          previousCursor: document.body.style.cursor,
          previousUserSelect: document.body.style.userSelect,
        };
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
      } else {
        dragState.current = {
          startX: event.clientX,
          startWidth: assistant.railWidth,
          previousCursor: "",
          previousUserSelect: "",
        };
      }
    },
    [assistant.railWidth],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragState.current;
      if (!state) return;
      const nextWidth = state.startWidth + (state.startX - event.clientX);
      assistant.setRailWidth(nextWidth);
    },
    [assistant],
  );

  const onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragState.current) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishResize();
    },
    [finishResize],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        assistant.setRailWidth(assistant.railWidth + RAIL_RESIZE_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        assistant.setRailWidth(assistant.railWidth - RAIL_RESIZE_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        assistant.setRailWidth(ASSISTANT_RAIL_MIN_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        assistant.setRailWidth(ASSISTANT_RAIL_MAX_WIDTH);
      }
    },
    [assistant],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: finishResize,
    onKeyDown,
  };
}

function AssistantRailResizeHandle() {
  const assistant = useAssistant();
  const resizeHandlers = useAssistantRailResizeHandlers();

  return (
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- this is an interactive resizer with separator semantics; <hr> cannot carry the resize handle affordance.
    <div
      role="separator"
      aria-label="Resize AI assistant"
      aria-orientation="vertical"
      aria-valuemin={ASSISTANT_RAIL_MIN_WIDTH}
      aria-valuemax={ASSISTANT_RAIL_MAX_WIDTH}
      aria-valuenow={assistant.railWidth}
      tabIndex={0}
      data-mdcms-assistant-resize-handle=""
      className="group absolute inset-y-0 left-0 z-20 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center outline-none"
      {...resizeHandlers}
    >
      <span
        aria-hidden
        className="h-full w-1 bg-primary/70 opacity-0 transition-opacity group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100"
      />
    </div>
  );
}

/**
 * Persistent right-side rail. Two visible modes:
 *   - rail        →  resizable column anchored to the right edge.
 *   - fullscreen  →  spans the full main area (sidebar stays visible),
 *                    hides the editor behind it.
 *
 * The rail is mounted at the layout level so its visibility persists
 * across page navigation, keeping conversation state attached to the
 * assistant context rather than to the route.
 */
export function AssistantRail({
  sidebarCollapsed,
}: {
  /** Width of the studio sidebar in px. The rail uses it to position the fullscreen overlay. */
  sidebarCollapsed: boolean;
}) {
  const assistant = useAssistant();
  if (!assistant.isOpen) return null;

  const sidebarOffset = sidebarCollapsed ? 64 : 240;

  if (assistant.isFullscreen) {
    return (
      <aside
        aria-label="AI assistant — fullscreen"
        className="fixed inset-y-0 right-0 z-40 border-l border-divider/40 bg-card shadow-[0_24px_60px_-16px_rgba(0,0,0,0.18)] dark:shadow-[0_24px_60px_-16px_rgba(0,0,0,0.6)]"
        style={{ left: sidebarOffset }}
      >
        <AssistantPanel hideClose={false} variant="fullscreen" />
      </aside>
    );
  }

  return (
    <aside
      aria-label="AI assistant"
      data-mdcms-assistant-rail-width={assistant.railWidth}
      className="fixed inset-y-0 right-0 z-40 border-l border-divider/40 bg-card shadow-[-12px_0_40px_-20px_rgba(0,0,0,0.18)]"
      style={{ width: assistant.railWidth }}
    >
      <AssistantRailResizeHandle />
      <AssistantPanel hideClose={false} hideThreadList variant="rail" />
    </aside>
  );
}

/**
 * Spacer that reserves the right margin on `<main>` while the rail is
 * docked, so the editor doesn't slide under it. The fullscreen mode
 * doesn't need a spacer because the rail sits on top of the editor.
 */
export function useAssistantMainPadding(): string {
  const assistant = useAssistant();
  return cn(
    "transition-[padding] duration-200",
    assistant.isOpen && !assistant.isFullscreen
      ? "pr-[var(--mdcms-assistant-rail-width)]"
      : "pr-0",
  );
}

export function useAssistantMainPaddingStyle():
  | AssistantRailCssVars
  | undefined {
  const assistant = useAssistant();
  if (!assistant.isOpen || assistant.isFullscreen) return undefined;
  return {
    "--mdcms-assistant-rail-width": `${clampAssistantRailWidth(
      assistant.railWidth || ASSISTANT_RAIL_DEFAULT_WIDTH,
    )}px`,
  };
}
