"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { autoUpdate, offset, size, useFloating } from "@floating-ui/react-dom";
import {
  AlertCircle,
  ChevronRight,
  Eraser,
  Expand,
  Loader2,
  PenLine,
  RefreshCw,
  Scissors,
  Search,
  Smile,
  Sparkles,
  X,
} from "lucide-react";

import { type StudioAiInlineAction } from "../../../ai-route-api.js";
import {
  type InlineAiState,
  type InlineAiTransformIntent,
  type UseInlineAiTransformResult,
} from "../../hooks/use-inline-ai-transform.js";
import { Button } from "../ui/button.js";
import { cn } from "../../lib/utils.js";

type InlineAiActionMeta = {
  id: StudioAiInlineAction;
  label: string;
  icon: typeof Sparkles;
  flyout: boolean;
};

const INLINE_AI_ACTIONS: ReadonlyArray<InlineAiActionMeta> = [
  { id: "rewrite", label: "Rewrite", icon: PenLine, flyout: false },
  { id: "shorten", label: "Shorten", icon: Scissors, flyout: false },
  { id: "expand", label: "Expand", icon: Expand, flyout: false },
  { id: "change_tone", label: "Change tone", icon: Smile, flyout: true },
  { id: "fix_grammar", label: "Fix grammar", icon: Eraser, flyout: false },
  {
    id: "improve_clarity",
    label: "Improve clarity",
    icon: Search,
    flyout: false,
  },
];

type TonePreset = {
  id: string;
  label: string;
  detail: string;
};

const TONE_PRESETS: ReadonlyArray<TonePreset> = [
  { id: "formal", label: "More formal", detail: "more formal" },
  { id: "casual", label: "More casual", detail: "more casual" },
  {
    id: "matter_of_fact",
    label: "Matter-of-fact",
    detail: "matter-of-fact, no flourish",
  },
  { id: "confident", label: "Confident", detail: "confident, no hedging" },
  { id: "friendly", label: "Friendly", detail: "friendly, warm" },
  { id: "technical", label: "Technical", detail: "technical, precise" },
];

export type InlineAiPanelProps = {
  /**
   * Transform state machine. Lifted out of the panel so the bubble
   * can react to proposal/applied transitions and drive the inline
   * editor preview from outside.
   */
  transform: UseInlineAiTransformResult;
  hasSelection: boolean;
  /**
   * Fired when the user picks an action (or a tone, for change_tone).
   * The panel itself does not call `transform.request` — the bubble
   * owns that so it can also drive editor-side preview state.
   */
  onSubmit: (intent: InlineAiTransformIntent) => void;
  onClose?: () => void;
  /**
   * Suppress the in-popover proposal preview when an external surface
   * (e.g. the editor's inline preview) is already rendering it.
   */
  hideProposalResult?: boolean;
  className?: string;
};

function intentForInlineAction(
  action: StudioAiInlineAction,
  detail: string,
): InlineAiTransformIntent {
  if (action === "change_tone") {
    return { action, tone: detail };
  }

  return { action };
}

function StateMessage(props: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
}) {
  return (
    <output
      aria-live="polite"
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        props.tone === "info" &&
          "border-border bg-muted/40 text-muted-foreground",
        props.tone === "warn" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        props.tone === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="leading-snug">{props.children}</span>
    </output>
  );
}

export type InlineAiResultBodyProps = {
  state: InlineAiState;
  onAccept: () => void;
  onReject: () => void;
  onRetry: () => void;
};

/**
 * Pure render of the proposal-result region. Exported so tests can
 * verify per-state markup without driving the panel state machine.
 *
 * In the new design (Option A) the picker fires actions on click and
 * relinquishes control to the editor's inline preview. The panel only
 * reaches this body for the loading/error/stale/forbidden/empty/
 * validation states, plus proposal/applying/applied when the bubble
 * does not mask them.
 */
export function InlineAiResultBody(props: InlineAiResultBodyProps) {
  const { state, onAccept, onReject, onRetry } = props;

  if (state.status === "idle") {
    return null;
  }

  if (state.status === "loading") {
    return (
      <output
        aria-live="polite"
        className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Generating…
      </output>
    );
  }

  if (state.status === "empty") {
    return (
      <StateMessage tone="info">
        AI did not return a usable proposal. Try a different action.
      </StateMessage>
    );
  }

  if (state.status === "validation_invalid") {
    const errorList =
      state.proposal.validation.status === "invalid"
        ? state.proposal.validation.errors
        : [];
    return (
      <div className="space-y-2">
        <StateMessage tone="warn">
          The proposal failed validation and cannot be applied.
        </StateMessage>
        {errorList.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
            {errorList.map((entry) => (
              <li key={`${entry.code}:${entry.message}`}>
                <span className="font-medium">{entry.code}</span>:{" "}
                {entry.message}
              </li>
            ))}
          </ul>
        ) : null}
        <DismissRetry onRetry={onRetry} onDismiss={onReject} />
      </div>
    );
  }

  if (state.status === "applying") {
    return (
      <output
        aria-live="polite"
        className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Applying…
      </output>
    );
  }

  if (state.status === "applied") {
    return (
      <StateMessage tone="info">
        Proposal applied. Editor draft updated.
      </StateMessage>
    );
  }

  if (state.status === "stale") {
    return (
      <div className="space-y-2">
        <StateMessage tone="warn">{state.message}</StateMessage>
        <DismissRetry onRetry={onRetry} onDismiss={onReject} />
      </div>
    );
  }

  if (state.status === "forbidden") {
    return (
      <StateMessage tone="error">
        AI is unavailable: {state.message}
      </StateMessage>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <StateMessage tone="error">
          <span>
            <span className="font-medium">{state.code}</span>: {state.message}
          </span>
        </StateMessage>
        <DismissRetry onRetry={onRetry} onDismiss={onReject} />
      </div>
    );
  }

  // proposal — fallback display when the bubble is not masking. In
  // the new design the editor inline preview replaces this; this is
  // only rendered if a caller forgets to set hideProposalResult.
  if (state.status === "proposal") {
    return (
      <div className="space-y-2">
        <StateMessage tone="info">
          Proposal ready: awaiting Accept / Reject.
        </StateMessage>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={onAccept} className="h-7 px-2.5">
            Accept
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={onReject}
            className="h-7 px-2.5"
          >
            Reject
          </Button>
        </div>
      </div>
    );
  }

  return null;
}

function DismissRetry(props: { onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="flex gap-1.5">
      <Button size="sm" onClick={props.onRetry} className="h-7 px-2.5">
        <RefreshCw className="mr-1 size-3.5" aria-hidden />
        Try again
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={props.onDismiss}
        className="h-7 px-2.5 text-muted-foreground"
      >
        Dismiss
      </Button>
    </div>
  );
}

function ToneFlyout(props: {
  anchorEl: HTMLElement | null;
  onPick: (preset: TonePreset) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  registerEl?: (el: HTMLElement | null) => void;
}) {
  // Always render to the right of the row — no flip. If the flyout
  // doesn't fit the viewport vertically, size() caps its max-height
  // and the inner overflow-y-auto lets the user scroll through tones.
  // The user's request: never reposition; allow scroll instead.
  const { refs, floatingStyles, isPositioned } = useFloating({
    placement: "right-start",
    strategy: "fixed",
    elements: { reference: props.anchorEl ?? undefined },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          // Cap the flyout at its natural content height (~6 tones
          // + header) when there's room, and shrink to the available
          // space when constrained so it never overflows the viewport.
          // Using Math.max(140, availableHeight) was the reverse —
          // it ignored a smaller availableHeight and let the flyout
          // exceed the viewport bottom.
          const NATURAL_MAX_PX = 280;
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.min(NATURAL_MAX_PX, availableHeight)}px`,
          });
        },
      }),
    ],
  });

  const setRefs = (el: HTMLDivElement | null) => {
    refs.setFloating(el);
    props.registerEl?.(el);
  };

  return (
    <div
      ref={setRefs}
      role="menu"
      tabIndex={-1}
      aria-label="Target tone"
      data-testid="inline-ai-tone-flyout"
      style={floatingStyles}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      className={cn(
        "z-[65] flex w-[200px] flex-col overflow-y-auto",
        "rounded-lg border border-border bg-popover p-1.5 shadow-lg",
        // Hide the flyout until floating-ui has measured the anchor
        // and applied the final transform. Without this, the entrance
        // animation plays from (0, 0) and the flyout appears to teleport
        // into place a frame later.
        isPositioned
          ? "opacity-100 transition-opacity duration-150"
          : "pointer-events-none opacity-0",
      )}
    >
      <div className="px-2 pb-1.5 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        Pick a tone
      </div>
      {TONE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="menuitem"
          onClick={() => props.onPick(preset)}
          data-testid={`inline-ai-tone-${preset.id}`}
          className={cn(
            "block w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium",
            "text-foreground transition-colors hover:bg-muted",
            "focus-visible:outline-none focus-visible:bg-muted",
          )}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

function ActionRow(props: {
  meta: InlineAiActionMeta;
  expanded: boolean;
  disabled: boolean;
  onFire: () => void;
  onHoverEnter: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  children?: ReactNode;
}) {
  const {
    meta,
    expanded,
    disabled,
    onFire,
    onHoverEnter,
    buttonRef,
    children,
  } = props;
  const Icon = meta.icon;

  return (
    <div onMouseEnter={onHoverEnter}>
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        aria-haspopup={meta.flyout ? "menu" : undefined}
        aria-expanded={meta.flyout ? expanded : undefined}
        disabled={disabled}
        onClick={() => {
          if (!meta.flyout) {
            onFire();
          }
        }}
        onFocus={onHoverEnter}
        data-testid={`inline-ai-action-${meta.id}`}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2",
          "text-left text-[13px] font-medium text-foreground transition-colors",
          "focus-visible:outline-none focus-visible:bg-muted",
          "disabled:cursor-not-allowed disabled:opacity-60",
          expanded ? "bg-muted" : "hover:bg-muted",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 transition-colors",
            expanded
              ? "text-primary"
              : "text-muted-foreground group-hover:text-primary",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex-1 truncate">{meta.label}</span>
        {meta.flyout ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "translate-x-0.5 text-primary",
            )}
            aria-hidden
          />
        ) : null}
      </button>
      {children}
    </div>
  );
}

export function InlineAiPanel(props: InlineAiPanelProps) {
  return <InlineAiPanelStateful {...props} />;
}

function InlineAiPanelStateful(props: InlineAiPanelProps) {
  const {
    transform,
    hasSelection,
    onSubmit,
    onClose,
    hideProposalResult,
    className,
  } = props;

  const [toneOpen, setToneOpen] = useState(false);
  // Tracked as state (not a ref) so the floating-ui flyout reflows
  // when the anchor button mounts/unmounts.
  const [toneAnchorEl, setToneAnchorEl] = useState<HTMLButtonElement | null>(
    null,
  );
  const flyoutElRef = useRef<HTMLElement | null>(null);

  // Safe-triangle pointer tracking. When the cursor is moving from the
  // tone row toward the open flyout, it briefly passes over neighbor
  // rows. Without this, those rows' onMouseEnter handlers would close
  // the flyout. We compute the triangle from the current cursor
  // position to the flyout's near (left) edge and only allow neighbor
  // rows to close the flyout when the cursor is OUTSIDE that triangle.
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  useEffect(() => {
    if (!toneOpen) return;
    const onMove = (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [toneOpen]);

  const isHeadingTowardFlyout = (): boolean => {
    if (!toneOpen) return false;
    const flyout = flyoutElRef.current;
    if (!flyout) return false;
    const rect = flyout.getBoundingClientRect();
    const { x: cx, y: cy } = cursorRef.current;
    // Only relevant when the cursor is left of the flyout — once the user
    // has moved past its left edge they're inside or beyond it.
    if (cx >= rect.left) return false;
    // Approximate "heading toward flyout" as the cursor's Y sitting within
    // the flyout's vertical band (plus slack) — the rectangle approximation
    // used by libraries that avoid per-move point-in-triangle tests.
    const slack = 24;
    return cy >= rect.top - slack && cy <= rect.bottom + slack;
  };

  const requestCloseTone = () => {
    // If the cursor is inside the safe triangle (heading toward the
    // open flyout), don't close. Without this, neighbor rows would
    // close the flyout the moment the cursor crosses them.
    if (isHeadingTowardFlyout()) {
      return;
    }
    setToneOpen(false);
  };
  const isWorking =
    transform.state.status === "loading" ||
    transform.state.status === "applying";

  // Mask proposal/applying/applied (and the inline preview owns it),
  // and idle (no message). Loading / error / empty / stale / forbidden
  // / validation_invalid replace the action list with a status row.
  const maskedState: InlineAiState =
    hideProposalResult &&
    (transform.state.status === "proposal" ||
      transform.state.status === "applying" ||
      transform.state.status === "applied")
      ? ({ status: "idle" } as InlineAiState)
      : transform.state;

  const showStatus =
    maskedState.status !== "idle" && maskedState.status !== "applied";

  // Last fired intent — used by retry to re-fire the same action.
  const lastIntentRef = useRef<InlineAiTransformIntent | null>(null);

  const fire = (intent: InlineAiTransformIntent) => {
    lastIntentRef.current = intent;
    onSubmit(intent);
  };

  const retry = () => {
    if (lastIntentRef.current) {
      onSubmit(lastIntentRef.current);
    }
  };

  return (
    <section
      aria-label="AI inline transform"
      className={cn(
        "flex w-full flex-col overflow-visible rounded-lg border border-border bg-popover text-popover-foreground shadow-md",
        className,
      )}
      // Note: we don't close the flyout on section mouse-leave because
      // the flyout floats outside the picker's bounding box (via
      // floating-ui), and a global leave would race with moving the
      // cursor onto the flyout. The flyout closes when the user hovers
      // a different action row, picks a tone, dismisses the popover,
      // or clicks outside.
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
          <Sparkles className="size-3 text-primary" aria-hidden />
          AI · edit selection
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close AI panel"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:bg-muted"
            data-testid="inline-ai-close"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </header>

      {!hasSelection ? (
        <div className="p-3">
          <StateMessage tone="info">
            Select editor text first, then pick an action.
          </StateMessage>
        </div>
      ) : showStatus ? (
        <div className="p-3">
          <InlineAiResultBody
            state={maskedState}
            onAccept={transform.accept}
            onReject={() => {
              void transform.reject();
            }}
            onRetry={retry}
          />
        </div>
      ) : (
        <div
          role="menu"
          aria-label="AI actions"
          // Cap the action list to the space Radix reports as
          // available between the popover and the viewport, so the
          // panel scrolls when the selection sits low on the page
          // instead of getting clipped. The CSS var is set by Radix
          // even when avoidCollisions is false.
          style={{
            maxHeight:
              "calc(var(--radix-popover-content-available-height, 100vh) - 56px)",
          }}
          className="flex flex-col overflow-y-auto p-1.5"
        >
          {INLINE_AI_ACTIONS.map((meta) => (
            <ActionRow
              key={meta.id}
              meta={meta}
              expanded={meta.flyout && toneOpen}
              disabled={isWorking}
              onHoverEnter={() => {
                if (meta.flyout) {
                  setToneOpen(true);
                } else {
                  // Honor the safe triangle: don't close the flyout
                  // when the cursor is on its way to the flyout.
                  requestCloseTone();
                }
              }}
              onFire={() => fire(intentForInlineAction(meta.id, ""))}
              buttonRef={meta.flyout ? setToneAnchorEl : undefined}
            />
          ))}
          {toneOpen ? (
            <ToneFlyout
              anchorEl={toneAnchorEl}
              registerEl={(el) => {
                flyoutElRef.current = el;
              }}
              onMouseEnter={() => setToneOpen(true)}
              onMouseLeave={() => setToneOpen(false)}
              onPick={(preset) => {
                setToneOpen(false);
                fire(intentForInlineAction("change_tone", preset.detail));
              }}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
