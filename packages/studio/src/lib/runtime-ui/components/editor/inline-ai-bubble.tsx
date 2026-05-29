"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type CSSProperties,
} from "react";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from "@floating-ui/react-dom";
import { Check, Loader2, RotateCcw, Sparkles } from "lucide-react";

import { InlineAiPanel } from "./inline-ai-panel.js";
import {
  useInlineAiTransform,
  type InlineAiAppliedSignal,
  type InlineAiTransformIntent,
  type InlineAiTransformOptions,
} from "../../hooks/use-inline-ai-transform.js";
import type { StudioAiRouteApi } from "../../../ai-route-api.js";
import type {
  TipTapEditorAnchorRect,
  TipTapEditorHandle,
  TipTapEditorSelectionInfo,
} from "./tiptap-editor.js";
import { PickerOffscreenHint } from "./inline-ai-offscreen-hint.js";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover.js";
import { cn } from "../../lib/utils.js";

export type InlineAiBubbleProps = {
  api: StudioAiRouteApi;
  options: InlineAiTransformOptions;
  selection: TipTapEditorSelectionInfo | null;
  /**
   * When false, the bubble is suppressed entirely (e.g. caller lacks
   * `ai:use`). The trigger and panel are both hidden.
   */
  enabled: boolean;
  /**
   * Imperative handle to the TipTap editor. Used to apply / revert the
   * inline preview that appears inside the editor when a proposal
   * arrives.
   */
  editorRef: React.RefObject<TipTapEditorHandle | null>;
  onApplied?: (signal: InlineAiAppliedSignal) => void;
  /**
   * Milliseconds the selection must stay stable before the trigger
   * appears. Avoids the bubble flashing while the user is still
   * dragging to extend a selection. Default 200ms; set to 0 to
   * disable (useful for tests).
   */
  appearDelayMs?: number;
};

type AnchorRect = TipTapEditorAnchorRect;

type PreviewState = {
  proposal: NonNullable<
    Extract<
      ReturnType<typeof useInlineAiTransform>["state"],
      { status: "proposal" }
    >
  >["proposal"];
  previewFrom: number;
  previewTo: number;
  anchorRect: AnchorRect;
  /**
   * Restores the original ProseMirror slice at the previewed range.
   * Captured by `applyInlinePreview` so reverting brings back block
   * structure (lists, headings) — not just the plain text.
   */
  revert: () => void;
};

type InlineAiBubbleUiState = {
  pickerOpen: boolean;
  preview: PreviewState | null;
  settledSelection: TipTapEditorSelectionInfo | null;
  lastSelectionId: string | null;
};

type InlineAiBubbleUiAction =
  | { type: "selection-settled"; selection: TipTapEditorSelectionInfo | null }
  | { type: "picker-open-change"; open: boolean }
  | { type: "picker-toggle" }
  | { type: "preview-ready"; preview: PreviewState }
  | { type: "preview-applied" }
  | { type: "preview-rejected"; reopenPicker: boolean };

const INLINE_AI_BUBBLE_INITIAL_UI: InlineAiBubbleUiState = {
  pickerOpen: false,
  preview: null,
  settledSelection: null,
  lastSelectionId: null,
};

function inlineAiBubbleUiReducer(
  state: InlineAiBubbleUiState,
  action: InlineAiBubbleUiAction,
): InlineAiBubbleUiState {
  switch (action.type) {
    case "selection-settled": {
      if (state.preview) return state;
      if (!action.selection) {
        return {
          ...state,
          pickerOpen: false,
          settledSelection: null,
          lastSelectionId: null,
        };
      }
      return {
        ...state,
        pickerOpen:
          state.lastSelectionId !== action.selection.selectionId
            ? false
            : state.pickerOpen,
        settledSelection: action.selection,
        lastSelectionId: action.selection.selectionId,
      };
    }
    case "picker-open-change":
      return { ...state, pickerOpen: action.open };
    case "picker-toggle":
      return { ...state, pickerOpen: !state.pickerOpen };
    case "preview-ready":
      return { ...state, pickerOpen: false, preview: action.preview };
    case "preview-applied":
      return { ...state, preview: null };
    case "preview-rejected":
      return {
        ...state,
        preview: null,
        pickerOpen: action.reopenPicker,
      };
  }
}

function rectToBoundingClientRect(rect: AnchorRect): DOMRect {
  const { top, left, right, bottom, width, height } = rect;
  return {
    x: left,
    y: top,
    top,
    left,
    right,
    bottom,
    width,
    height,
    toJSON: () => rect,
  } as DOMRect;
}

/**
 * Floating "Edit with AI" affordance positioned at the selection's
 * anchor rect. Drives a three-stage UX:
 *
 * 1. **Trigger** — a small pill at the selection. Click to open the
 *    action picker.
 * 2. **Picker** — Radix popover with the action list + Generate
 *    button. Esc / click-outside dismisses to stage 1.
 * 3. **Preview** — when a proposal arrives, the picker closes and the
 *    proposed replacement is applied directly inline in the editor.
 *    A small Accept / Reject affordance hovers over the replaced
 *    range.
 *      * Accept → call the apply endpoint, then settle the editor
 *        from the server response.
 *      * Reject → revert the inline replacement, restore the
 *        original selection, and reopen the picker so the user can
 *        try a different action or detail.
 */
export function InlineAiBubble(props: InlineAiBubbleProps) {
  return useInlineAiBubbleElement(props);
}

function useInlineAiBubbleElement(props: InlineAiBubbleProps) {
  const {
    selection,
    enabled,
    appearDelayMs = 200,
    api,
    options,
    editorRef,
    onApplied,
  } = props;

  const [uiState, dispatchUi] = useReducer(
    inlineAiBubbleUiReducer,
    INLINE_AI_BUBBLE_INITIAL_UI,
  );
  const { pickerOpen, preview, settledSelection } = uiState;

  // The "settled" selection drives the bubble's visible state. While
  // the user is actively extending a selection (drag, shift+arrow),
  // the upstream `selection` prop changes on every animation frame,
  // but `settledSelection` only catches up after `appearDelayMs` of
  // quiet — so the trigger doesn't flash and re-anchor mid-drag.
  useEffect(() => {
    // Skip debounce while the editor is showing a preview — the
    // preview replaces selection text and the editor publishes a new
    // selection rooted at the replacement. We don't want to retract
    // the bubble during that internal state shuffle.
    if (preview) {
      return;
    }

    if (!selection) {
      dispatchUi({ type: "selection-settled", selection: null });
      return;
    }

    if (appearDelayMs <= 0) {
      dispatchUi({ type: "selection-settled", selection });
      return;
    }

    const handle = setTimeout(() => {
      dispatchUi({ type: "selection-settled", selection });
    }, appearDelayMs);

    return () => clearTimeout(handle);
  }, [selection, appearDelayMs, preview]);

  // Serialize the selection for AI input. Whole-block selections get
  // full markdown round-tripping (lists, headings preserved); mid-
  // block selections fall back to plain text so the surrounding block
  // structure is left alone on apply. Memoized by selection id so we
  // don't re-spin a transient editor on every render.
  const lastSerializedRef = useRef<{
    id: string;
    text: string;
    mode: "markdown" | "text";
  } | null>(null);
  const selectionPayload = useMemo(() => {
    if (!settledSelection) {
      lastSerializedRef.current = null;
      return null;
    }
    if (lastSerializedRef.current?.id === settledSelection.selectionId) {
      return lastSerializedRef.current;
    }
    const result = editorRef.current?.getSelectionMarkdown({
      from: settledSelection.from,
      to: settledSelection.to,
    });
    const payload = {
      id: settledSelection.selectionId,
      text: result?.text ?? settledSelection.text,
      // Default to "text" if the editor handle is unavailable (e.g.
      // unmounted) — apply preview will preserve surrounding blocks.
      mode: result?.mode ?? ("text" as const),
    };
    lastSerializedRef.current = payload;
    return payload;
  }, [settledSelection, editorRef]);

  const transform = useInlineAiTransform({
    api,
    options,
    selection: settledSelection
      ? {
          id: settledSelection.selectionId,
          text: selectionPayload?.text ?? settledSelection.text,
        }
      : null,
    onApplied,
  });

  // When the hook produces a proposal, lift it out of the popover and
  // into the editor as an inline preview. The picker closes; the
  // bubble switches to the Accept / Reject stage.
  useEffect(() => {
    if (transform.state.status !== "proposal") {
      return;
    }
    if (preview) {
      return;
    }
    if (!editorRef.current || !settledSelection) {
      return;
    }

    const operation = transform.state.proposal.operations.find(
      (op) => op.op === "replace_selection",
    );
    if (!operation || operation.op !== "replace_selection") {
      return;
    }

    const result = editorRef.current.applyInlinePreview({
      from: settledSelection.from,
      to: settledSelection.to,
      replacementText: operation.replacementText,
      expectedText: settledSelection.text,
      // Match the apply mode to what the bubble sent for this
      // selection. Mid-block selections were sent as plain text and
      // must be applied as plain text — markdown parsing of a
      // mid-block range produces nested lists.
      mode: selectionPayload?.mode ?? "text",
    });

    if (!result) {
      // Document mutated under us. Leave the popover open so the user
      // can read the error/proposal panel and retry.
      return;
    }

    dispatchUi({
      type: "preview-ready",
      preview: {
        proposal: transform.state.proposal,
        previewFrom: result.previewFrom,
        previewTo: result.previewTo,
        anchorRect: result.anchorRect,
        revert: () => {
          result.revert();
        },
      },
    });
  }, [
    transform.state,
    preview,
    editorRef,
    settledSelection,
    selectionPayload?.mode,
  ]);

  // After accept resolves, drop the inline preview. On success
  // ("applied") the bubble falls back to the trigger pill at the new
  // range. On terminal failure ("stale" / "forbidden" / "error" /
  // "validation_invalid") the apply did NOT persist, so we revert
  // the in-editor preview to the original slice and clear the
  // preview state — the picker reopens carrying the failure status,
  // letting the user retry or dismiss instead of leaving the editor
  // showing the AI's text as if it had been accepted.
  useEffect(() => {
    if (!preview) return;
    const status = transform.state.status;
    if (status === "applied") {
      dispatchUi({ type: "preview-applied" });
      return;
    }
    if (
      status === "stale" ||
      status === "forbidden" ||
      status === "error" ||
      status === "validation_invalid"
    ) {
      preview.revert();
      dispatchUi({ type: "preview-rejected", reopenPicker: true });
    }
  }, [transform.state, preview]);

  // Accept → call apply through the hook. The page-level `onApplied`
  // will refresh the editor body from the server response.
  const handleAccept = useCallback(() => {
    void transform.accept();
  }, [transform]);

  // Reject → revert the inline replacement, drop the proposal, and
  // reopen the picker with the original selection so the user can try
  // another action or detail.
  const handleReject = useCallback(() => {
    if (!preview) {
      return;
    }
    preview.revert();
    dispatchUi({ type: "preview-rejected", reopenPicker: true });
    void transform.reject();
  }, [preview, transform]);

  const reference = useMemo(() => {
    const rect = preview
      ? preview.anchorRect
      : (settledSelection?.anchorRect ?? null);
    if (!rect) {
      return null;
    }
    return {
      getBoundingClientRect: () => rectToBoundingClientRect(rect),
    };
  }, [preview, settledSelection]);

  const { refs, floatingStyles } = useFloating({
    placement: "top-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      // 10px gap between the pill and the selection so it doesn't
      // crowd the highlighted range.
      offset(10),
      // Flip below the selection when there isn't enough headroom
      // (e.g., selection sits right under a heading), and pad the
      // viewport so the pill never hugs the screen edge.
      flip({ padding: 12 }),
      shift({ padding: 8 }),
    ],
  });

  useEffect(() => {
    refs.setReference(reference as never);
  }, [refs, reference]);

  const handleSubmit = useCallback(
    (intent: InlineAiTransformIntent) => {
      void transform.request(intent);
    },
    [transform],
  );

  // ⌘J / Ctrl+J opens the picker when a settled selection exists.
  // Mirrors the kbd hint shown on the trigger pill.
  useEffect(() => {
    if (!enabled || !settledSelection || preview) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "j" && event.key !== "J") {
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      dispatchUi({ type: "picker-toggle" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, settledSelection, preview]);

  if (!enabled) {
    return null;
  }

  // Stage 3: inline preview is showing — render Accept / Reject pill.
  // Theme-aware: popover surface + theme foreground, with semantic
  // success / destructive accents on the action buttons. Stays
  // legible in both light and dark themes.
  if (preview) {
    const isApplying = transform.state.status === "applying";
    return renderInlineAiPreviewBubble({
      floatingRef: refs.setFloating,
      floatingStyles,
      isApplying,
      onAccept: handleAccept,
      onReject: handleReject,
    });
  }

  // Stages 1 & 2: trigger pill + picker popover. The pill anchors to
  // the (debounced) original selection.
  if (!settledSelection) {
    return null;
  }

  // The picker popover and the trigger pill are rendered as siblings:
  // the pill is positioned via floating-ui inside a transform'd div,
  // and CSS spec says `position: fixed` descendants of a transformed
  // ancestor are positioned relative to the ancestor — not the
  // viewport. Putting the popover-anchor div *inside* that transformed
  // div would mis-anchor the picker. Lifting both Popover and Anchor
  // up to the bubble root keeps the anchor's fixed coords viewport-
  // relative as expected.
  return renderInlineAiTriggerBubble({
    floatingRef: refs.setFloating,
    floatingStyles,
    pickerOpen,
    selection: settledSelection,
    transform,
    onClosePicker: () =>
      dispatchUi({ type: "picker-open-change", open: false }),
    onPickerOpenChange: (open) =>
      dispatchUi({ type: "picker-open-change", open }),
    onSubmit: handleSubmit,
    onTogglePicker: () => dispatchUi({ type: "picker-toggle" }),
  });
}

function renderInlineAiPreviewBubble({
  floatingRef,
  floatingStyles,
  isApplying,
  onAccept,
  onReject,
}: {
  floatingRef: (node: HTMLDivElement | null) => void;
  floatingStyles: CSSProperties;
  isApplying: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div
      ref={floatingRef}
      style={floatingStyles}
      data-mdcms-ai-bubble="preview"
      className="z-50"
    >
      <div
        className={cn(
          "inline-flex items-center overflow-hidden rounded-full",
          "border border-border bg-popover text-popover-foreground",
          "shadow-lg",
        )}
      >
        <span className="inline-flex items-center gap-1.5 border-r border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          <Sparkles className="size-3 text-primary" aria-hidden />
          Proposed
        </span>
        <button
          type="button"
          onClick={onAccept}
          disabled={isApplying}
          data-testid="inline-ai-preview-accept"
          aria-label="Accept AI replacement"
          className={cn(
            "inline-flex items-center gap-1.5 border-r border-border px-3 py-1.5",
            "text-xs font-semibold text-success transition-colors",
            "hover:bg-success-subtle disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isApplying ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          {isApplying ? "Applying" : "Accept"}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isApplying}
          data-testid="inline-ai-preview-reject"
          aria-label="Reject AI replacement and reopen picker"
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5",
            "text-xs font-semibold text-destructive transition-colors",
            "hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Reject
        </button>
      </div>
    </div>
  );
}

function renderInlineAiTriggerBubble({
  floatingRef,
  floatingStyles,
  pickerOpen,
  selection,
  transform,
  onClosePicker,
  onPickerOpenChange,
  onSubmit,
  onTogglePicker,
}: {
  floatingRef: (node: HTMLDivElement | null) => void;
  floatingStyles: CSSProperties;
  pickerOpen: boolean;
  selection: TipTapEditorSelectionInfo;
  transform: ReturnType<typeof useInlineAiTransform>;
  onClosePicker: () => void;
  onPickerOpenChange: (open: boolean) => void;
  onSubmit: (intent: InlineAiTransformIntent) => void;
  onTogglePicker: () => void;
}) {
  return (
    <>
      <Popover open={pickerOpen} onOpenChange={onPickerOpenChange}>
        <PopoverAnchor asChild>
          <div
            aria-hidden
            style={{
              position: "fixed",
              top: selection.anchorRect.bottom,
              left: selection.anchorRect.left,
              width: selection.anchorRect.width,
              height: 0,
              pointerEvents: "none",
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={8}
          collisionPadding={8}
          avoidCollisions={false}
          data-mdcms-ai-bubble="panel"
          className="w-[240px] overflow-visible p-0"
        >
          <InlineAiPanel
            transform={transform}
            hasSelection
            onSubmit={onSubmit}
            onClose={onClosePicker}
            hideProposalResult
            className="border-0 shadow-none"
          />
        </PopoverContent>
      </Popover>

      <PickerOffscreenHint selection={selection} pickerOpen={pickerOpen} />

      <div
        ref={floatingRef}
        style={floatingStyles}
        data-mdcms-ai-bubble="trigger"
        className={cn("z-50", pickerOpen && "pointer-events-none opacity-0")}
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          onClick={onTogglePicker}
          data-testid="inline-ai-bubble-trigger"
          aria-label="Open AI edit menu"
          className={cn(
            "group inline-flex items-center gap-1.5 rounded-full",
            "px-3 py-1.5 text-xs font-semibold",
            "border bg-card/80 backdrop-blur-md",
            "border-primary/45 text-primary",
            "shadow-[0_1px_2px_rgba(0,0,0,0.18),0_16px_32px_-16px_rgba(47,73,229,0.55)]",
            "transition-all duration-150",
            "hover:border-primary/70 hover:bg-card",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
        >
          <Sparkles
            className="size-3.5 transition-transform duration-150 group-hover:scale-110"
            aria-hidden
          />
          Edit with AI
          <kbd
            aria-hidden
            className={cn(
              "ml-1 rounded-sm font-mono text-[9px] tracking-[0.04em]",
              "bg-primary/10 px-1.5 py-px text-primary",
            )}
          >
            ⌘ J
          </kbd>
        </button>
      </div>
    </>
  );
}
