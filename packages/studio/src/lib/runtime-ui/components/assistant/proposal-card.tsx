"use client";

import * as React from "react";
import { AlertTriangle, Check, ChevronRight, Send, Trash2 } from "lucide-react";

import { cn } from "../../lib/utils.js";
import { pushAppliedUndoHandler } from "./applied-undo-stack.js";
import type {
  AssistantProposal,
  AssistantProposalCreate,
  AssistantProposalDelete,
  AssistantProposalEdit,
  AssistantProposalInsert,
  AssistantValidation,
} from "./assistant-types.js";
import { KindGlyph } from "./kind-glyph.js";

const KIND_LABEL: Record<AssistantProposal["kind"], string> = {
  replace_selection: "Edit",
  insert_block: "Insert",
  update_frontmatter: "Frontmatter",
  create_document: "New doc",
  delete_document: "Delete",
};

// Chip palette: one blue family for every non-destructive operation, an
// amber family that only the destructive kind uses. The single binary
// keeps the chips legible at a glance — green/blue/red triple coding
// blurred when the action types grew past three.
function chipPaletteFor(kind: AssistantProposal["kind"]): string {
  return kind === "delete_document"
    ? "bg-accent-amber-tint text-accent-amber"
    : "bg-primary/15 text-primary";
}

type CardChromeProps = {
  children: React.ReactNode;
  className?: string;
};

function CardChrome({ children, className }: CardChromeProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-card-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ValidBadge({ validation }: { validation: AssistantValidation }) {
  if (validation.status === "valid") {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-success/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-success">
        <Check className="size-2.5" aria-hidden /> valid
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-destructive/12 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-destructive">
      <AlertTriangle className="size-2.5" aria-hidden />{" "}
      {validation.errors.length} error
      {validation.errors.length === 1 ? "" : "s"}
    </span>
  );
}

type StandardHeaderProps = {
  kind: AssistantProposal["kind"];
  docPath: string;
  locale?: string;
  validation: AssistantValidation;
  dense?: boolean;
};

// Two-line header: the document path sits as the headline (font-mono,
// truncating left-from-the-end so the leaf segment stays visible), and
// the operation chip + locale + validation status share the second
// line. Previously a single row tried to hold all four — the path got
// squeezed before the chip did, which made the kind harder to scan
// than the path it operated on.
function StandardHeader({
  kind,
  docPath,
  locale,
  validation,
  dense,
}: StandardHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-b border-divider/40 bg-gradient-to-b from-primary/[0.04] to-transparent",
        dense ? "px-2.5 py-1.5" : "px-3 py-2.5",
      )}
    >
      <div
        className="truncate font-mono text-[12px] text-foreground"
        title={docPath}
        dir="rtl"
      >
        <bdi dir="ltr">{docPath}</bdi>
      </div>
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
            chipPaletteFor(kind),
          )}
        >
          <KindGlyph kind={kind} />
          {KIND_LABEL[kind]}
        </span>
        {locale && (
          <span className="shrink-0 font-mono text-[10px] text-foreground-muted/80">
            {locale}
          </span>
        )}
        <span className="flex-1" />
        <ValidBadge validation={validation} />
      </div>
    </div>
  );
}

type FooterProps = {
  contentInvalidated?: boolean;
  validation: AssistantValidation;
  onAccept: () => void;
  onReject: () => void;
  acceptLabel?: React.ReactNode;
  rejectLabel?: React.ReactNode;
  destructive?: boolean;
};

function Footer({
  contentInvalidated,
  validation,
  onAccept,
  onReject,
  acceptLabel,
  rejectLabel,
  destructive,
}: FooterProps) {
  const ok = validation.status === "valid";
  const blocked = !ok || contentInvalidated;
  return (
    <div className="flex items-center gap-2 border-t border-divider/40 bg-background-subtle px-3 py-2">
      {contentInvalidated ? (
        <span className="flex flex-1 items-center gap-1.5 font-mono text-[10px] text-destructive">
          <AlertTriangle className="size-3" aria-hidden /> source text changed,
          retry
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <button
        type="button"
        onClick={onReject}
        className="rounded border border-border bg-transparent px-2.5 py-1 font-mono text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
      >
        {rejectLabel ?? "Reject…"}
      </button>
      <button
        type="button"
        onClick={blocked ? undefined : onAccept}
        disabled={blocked}
        className={cn(
          "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors",
          blocked
            ? "cursor-not-allowed border-transparent bg-muted text-foreground-muted"
            : destructive
              ? "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90"
              : "border-vibrant-green-border bg-vibrant-green text-vibrant-green-foreground hover:bg-vibrant-green/90",
        )}
        title={
          contentInvalidated
            ? "Source text changed — retry to regenerate"
            : ok
              ? "Apply as draft"
              : "Fix validation before accepting"
        }
      >
        <Check className="size-3" aria-hidden />
        {acceptLabel ?? "Accept"}
      </button>
    </div>
  );
}

type RejectFeedbackProps = {
  onCancel: () => void;
  onSend: (feedback: string) => void;
};

function RejectFeedback({ onCancel, onSend }: RejectFeedbackProps) {
  const [feedback, setFeedback] = React.useState("");
  return (
    <div className="space-y-2 border-t border-divider/40 bg-muted/40 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
        Rejected: what should change?
      </div>
      <textarea
        aria-label="Rejection feedback"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="e.g. Keep it under 12 words, no em dashes."
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-2.5 py-1 font-mono text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSend(feedback)}
          className="inline-flex items-center gap-1.5 rounded bg-sidebar px-2.5 py-1 font-mono text-[11px] font-semibold text-vibrant-green transition-colors hover:bg-sidebar/90"
        >
          <Send className="size-3" aria-hidden />
          Send & retry
        </button>
      </div>
    </div>
  );
}

type DiffBodyProps = {
  removed?: string;
  added: string;
  emptyLeftLabel?: string;
};

function DiffBody({ removed, added, emptyLeftLabel }: DiffBodyProps) {
  return (
    <div className="overflow-hidden rounded-md border border-divider/60 bg-background-subtle font-mono text-[12px] leading-snug">
      {removed != null ? (
        <div className="flex gap-2 border-l-2 border-destructive bg-destructive/5 px-2.5 py-1 text-foreground-muted line-through">
          <span className="w-2.5 shrink-0 text-center text-foreground-muted/80">
            −
          </span>
          <span className="whitespace-pre-wrap">{removed}</span>
        </div>
      ) : (
        <div className="flex gap-2 border-l-2 border-transparent bg-transparent px-2.5 py-1 italic text-foreground-muted/70">
          <span className="w-2.5 shrink-0 text-center text-foreground-muted/60">
            −
          </span>
          <span>{emptyLeftLabel ?? "(no existing content)"}</span>
        </div>
      )}
      <div className="flex gap-2 border-l-2 border-success bg-success/8 px-2.5 py-1 text-foreground">
        <span className="w-2.5 shrink-0 text-center text-foreground-muted/80">
          +
        </span>
        <span className="whitespace-pre-wrap">{added}</span>
      </div>
    </div>
  );
}

function CollapseHeader({
  collapsed,
  added,
  removed,
}: {
  collapsed: boolean;
  added: number;
  removed: number;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 text-left">
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-foreground-muted transition-transform",
          !collapsed && "rotate-90",
        )}
        aria-hidden
      />
      <span className="flex-1 font-mono text-[11px] text-foreground-muted">
        {collapsed ? "click to expand" : "click to collapse"}
      </span>
      <span className="shrink-0 font-mono text-[11px]">
        <span className="text-success">+{added}</span>{" "}
        <span
          className={removed ? "text-destructive" : "text-foreground-muted"}
        >
          −{removed}
        </span>
      </span>
    </div>
  );
}

// ─── Edit / Insert (replace_selection or insert_block) ──────────────────
function EditOrInsertCard({
  proposal,
  rejecting,
  defaultCollapsed,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposalEdit | AssistantProposalInsert;
  rejecting: boolean;
  defaultCollapsed: boolean;
  onAccept: () => void;
  onReject: (feedback: string) => void;
}) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const [openLocally, setOpenLocally] = React.useState(false);
  const showReject = rejecting || openLocally;

  const isEdit = proposal.kind === "replace_selection";
  const removed = isEdit
    ? (proposal as AssistantProposalEdit).op.originalText
    : undefined;
  const added = isEdit
    ? (proposal as AssistantProposalEdit).op.replacementText
    : (proposal as AssistantProposalInsert).op.bodyMdx;
  const removedCount = proposal.diffStats?.removed ?? (removed ? 1 : 0);
  const addedCount =
    proposal.diffStats?.added ?? (added ? added.split("\n").length : 0);

  return (
    <CardChrome>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="block w-full bg-transparent text-left hover:bg-accent-subtle/50"
      >
        <StandardHeader
          kind={proposal.kind}
          docPath={proposal.docPath}
          locale={proposal.locale}
          validation={proposal.validation}
          dense={collapsed}
        />
        <CollapseHeader
          collapsed={collapsed}
          added={addedCount}
          removed={removedCount}
        />
      </button>
      {!collapsed && (
        <div className="px-3 pb-3">
          <DiffBody
            removed={removed}
            added={added}
            emptyLeftLabel="(no existing content — new block)"
          />
        </div>
      )}
      {showReject ? (
        <RejectFeedback
          onCancel={() => setOpenLocally(false)}
          onSend={(feedback) => {
            onReject(feedback);
            setOpenLocally(false);
          }}
        />
      ) : (
        <Footer
          contentInvalidated={proposal.contentInvalidated}
          validation={proposal.validation}
          onAccept={onAccept}
          onReject={() => setOpenLocally(true)}
        />
      )}
    </CardChrome>
  );
}

// ─── Create document ────────────────────────────────────────────────────
function CreateCard({
  proposal,
  rejecting,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposalCreate;
  rejecting: boolean;
  onAccept: () => void;
  onReject: (feedback: string) => void;
}) {
  const [openLocally, setOpenLocally] = React.useState(false);
  const showReject = rejecting || openLocally;

  const hasBody = Boolean(
    proposal.op.bodyPreview && proposal.op.bodyPreview.trim(),
  );
  const isInvalid = proposal.validation.status === "invalid";

  return (
    <CardChrome>
      <StandardHeader
        kind={proposal.kind}
        docPath={proposal.docPath}
        locale={proposal.locale}
        validation={proposal.validation}
      />
      <div className="space-y-3 p-3">
        {!hasBody && !isInvalid && (
          <div className="text-[13px] text-foreground">Create new document</div>
        )}
        {Object.keys(proposal.op.frontmatter).length > 0 && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-divider/60 bg-background-subtle px-3 py-2.5">
            {Object.entries(proposal.op.frontmatter).map(([k, v]) => (
              <React.Fragment key={k}>
                <div className="font-mono text-[10px] tracking-wide text-foreground-muted">
                  {k}
                </div>
                <div className="text-[12px] text-foreground">
                  {Array.isArray(v)
                    ? v.map((t) => `#${t}`).join(" ")
                    : String(v)}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
        {hasBody && !isInvalid && (
          <div className="relative max-h-36 overflow-hidden rounded-md border border-divider/60 bg-background-subtle px-3 py-2.5 font-mono text-[11.5px] leading-snug text-foreground-muted">
            <pre className="whitespace-pre-wrap break-words font-mono">
              {proposal.op.bodyPreview}
            </pre>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-9 bg-gradient-to-t from-background-subtle to-transparent" />
          </div>
        )}
        {!isInvalid &&
          proposal.validation.status === "valid" &&
          proposal.validation.checks && (
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
              {proposal.validation.checks.map((c) => (
                <li
                  key={c.label}
                  className="flex items-center gap-1.5 text-[11.5px] text-foreground-muted"
                >
                  <Check className="size-3 text-success" aria-hidden />
                  {c.label}
                </li>
              ))}
            </ul>
          )}
        {proposal.validation.status === "invalid" && (
          <div className="space-y-2.5">
            <DiffBody
              added={proposal.op.bodyPreview || "(empty body)"}
              emptyLeftLabel="(no existing content — new document)"
            />
            <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              {proposal.validation.errors.map((e) => (
                <li
                  key={`${e.code}:${e.message}`}
                  className="flex gap-2 text-[12px] text-foreground"
                >
                  <span className="shrink-0 font-mono text-[10px] text-destructive">
                    {e.code}
                  </span>
                  <span className="flex-1">{e.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {showReject ? (
        <RejectFeedback
          onCancel={() => setOpenLocally(false)}
          onSend={(feedback) => {
            onReject(feedback);
            setOpenLocally(false);
          }}
        />
      ) : (
        <Footer
          contentInvalidated={proposal.contentInvalidated}
          validation={proposal.validation}
          onAccept={onAccept}
          onReject={() => setOpenLocally(true)}
        />
      )}
    </CardChrome>
  );
}

// ─── Invalid insert/edit (renders the diff + errors below) ──────────────
function InvalidInsertCard({
  proposal,
  rejecting,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposalInsert;
  rejecting: boolean;
  onAccept: () => void;
  onReject: (feedback: string) => void;
}) {
  const [openLocally, setOpenLocally] = React.useState(false);
  const showReject = rejecting || openLocally;

  if (proposal.validation.status !== "invalid") return null;

  return (
    <CardChrome>
      <StandardHeader
        kind={proposal.kind}
        docPath={proposal.docPath}
        locale={proposal.locale}
        validation={proposal.validation}
      />
      <div className="space-y-2.5 p-3">
        <DiffBody
          added={proposal.op.bodyMdx}
          emptyLeftLabel="(no existing content — new block)"
        />
        <ul className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          {proposal.validation.errors.map((e) => (
            <li
              key={`${e.code}:${e.message}`}
              className="flex gap-2 text-[12px] text-foreground"
            >
              <span className="shrink-0 font-mono text-[10px] text-destructive">
                {e.code}
              </span>
              <span className="flex-1">{e.message}</span>
            </li>
          ))}
        </ul>
      </div>
      {showReject ? (
        <RejectFeedback
          onCancel={() => setOpenLocally(false)}
          onSend={(feedback) => {
            onReject(feedback);
            setOpenLocally(false);
          }}
        />
      ) : (
        <Footer
          contentInvalidated={proposal.contentInvalidated}
          validation={proposal.validation}
          onAccept={onAccept}
          onReject={() => setOpenLocally(true)}
        />
      )}
    </CardChrome>
  );
}

// ─── Delete document ────────────────────────────────────────────────────
function DeleteCard({
  proposal,
  rejecting,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposalDelete;
  rejecting: boolean;
  onAccept: () => void;
  onReject: (feedback: string) => void;
}) {
  const [openLocally, setOpenLocally] = React.useState(false);
  const showReject = rejecting || openLocally;

  return (
    <CardChrome>
      <StandardHeader
        kind={proposal.kind}
        docPath={proposal.docPath}
        locale={proposal.locale}
        validation={proposal.validation}
      />
      <div className="space-y-2.5 p-3">
        <div className="overflow-hidden rounded-md border border-divider/60 bg-background-subtle font-mono text-[12px]">
          <div className="flex gap-2 border-l-2 border-destructive bg-destructive/5 px-2.5 py-1 text-foreground-muted line-through">
            <span className="w-2.5 shrink-0 text-center text-foreground-muted/80">
              −
            </span>
            <span>{proposal.docPath}</span>
          </div>
        </div>
        {proposal.op.reason && (
          <p className="text-[13px] text-foreground-muted">
            {proposal.op.reason}
          </p>
        )}
        {proposal.validation.status === "valid" &&
          proposal.validation.checks && (
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
              {proposal.validation.checks.map((c) => (
                <li
                  key={c.label}
                  className="flex items-center gap-1.5 text-[11.5px] text-foreground-muted"
                >
                  <Check className="size-3 text-success" aria-hidden />
                  {c.label}
                </li>
              ))}
            </ul>
          )}
      </div>
      {showReject ? (
        <RejectFeedback
          onCancel={() => setOpenLocally(false)}
          onSend={(feedback) => {
            onReject(feedback);
            setOpenLocally(false);
          }}
        />
      ) : (
        <Footer
          contentInvalidated={proposal.contentInvalidated}
          validation={proposal.validation}
          onAccept={onAccept}
          onReject={() => setOpenLocally(true)}
          rejectLabel="Keep"
          acceptLabel={
            <span className="inline-flex items-center gap-1.5">
              <Trash2 className="size-3" aria-hidden /> Delete document
            </span>
          }
          destructive
        />
      )}
    </CardChrome>
  );
}

export type ProposalCardProps = {
  proposal: AssistantProposal;
  /** Force reject-feedback state (used in showcases). */
  rejecting?: boolean;
  defaultCollapsed?: boolean;
  onAccept: () => void;
  /**
   * Called when the user submits the inline reject-feedback panel. The
   * feedback string is the reason the user is rejecting; an empty string
   * means a silent reject (Cancel from the panel does NOT call this).
   */
  onReject: (feedback: string) => void;
  /**
   * Optional undo handler. When provided AND the proposal has been
   * accepted, the post-accept banner exposes an Undo button during the
   * 6-second window. Returns a promise that resolves on success and
   * rejects on failure so the banner can surface inline errors per
   * SPEC-014 §Post-Accept Undo Window. Omitted by callers without a
   * live AI route configured (e.g. showcases / tests).
   */
  onUndo?: () => Promise<void>;
};

/** 6-second window — Sonia's design + the AI Elements reference both use this. */
const UNDO_WINDOW_MS = 6000;

/**
 * Countdown timer that pauses on hover and when the tab is hidden.
 * Returns a 1→0 progress value and calls `onExpire` exactly once when
 * progress hits 0. The pause logic uses `performance.now()` so elapsed
 * time stays accurate across tab visibility flips (rAF would throttle
 * when backgrounded, which would silently extend the window).
 */
function useUndoCountdown(
  durationMs: number,
  acceptedAt: string,
  paused: boolean,
  onExpire: () => void,
): number {
  const [progress, setProgress] = React.useState(() => {
    // Initial progress accounts for time elapsed since acceptedAt so
    // a page reload during the window resumes the countdown cleanly
    // instead of restarting it.
    const elapsedAtMount = Date.now() - new Date(acceptedAt).getTime();
    return Math.max(0, 1 - elapsedAtMount / durationMs);
  });
  const expiredRef = React.useRef(false);
  const onExpireRef = React.useRef(onExpire);
  const progressRef = React.useRef(progress);
  React.useEffect(() => {
    progressRef.current = progress;
  }, [progress]);
  React.useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // Tab-hidden detection so the timer doesn't burn through the
  // window while the user can't see it.
  const [tabHidden, setTabHidden] = React.useState(
    typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const handle = () => setTabHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);

  const effectivePaused = paused || tabHidden;

  React.useEffect(() => {
    if (expiredRef.current) return;
    if (effectivePaused) return;
    const startedAtMs = performance.now();
    const startProgress = progressRef.current;
    const tick = () => {
      const elapsed = performance.now() - startedAtMs;
      const next = Math.max(0, startProgress - elapsed / durationMs);
      setProgress(next);
      if (next <= 0) {
        expiredRef.current = true;
        clearInterval(id);
        onExpireRef.current();
      }
    };
    const id = setInterval(tick, 80);
    return () => clearInterval(id);
  }, [durationMs, effectivePaused]);

  return progress;
}

export type AppliedBannerProps = {
  proposal: AssistantProposal;
  onUndo?: () => void;
  onExpire: () => void;
  /**
   * Whether the undo affordance is actually wired up for this kind
   * of proposal. When false the banner still shows the countdown but
   * hides the Undo button so we don't promise a revert we can't
   * deliver.
   */
  canUndo: boolean;
  /**
   * True while the undo round-trip is in flight. The button shows a
   * pending label and the countdown is paused so the window doesn't
   * expire under the user mid-undo.
   */
  pending?: boolean;
  /**
   * Inline error to render below the row when the server rejected
   * the undo (typically `AI_PROPOSAL_CONFLICT` from a concurrent
   * edit). The banner stays mounted so the user sees what happened
   * — SPEC-014 §Post-Accept Undo Window requires inline reporting
   * rather than appending a chat-level error turn.
   */
  errorMessage?: string;
};

/**
 * Lime-tinted "Applied" banner with a 6s undo countdown. Renders
 * above the read-only applied-change details the moment the apply
 * call succeeds, then morphs to the quiet `AppliedLogLine` when the
 * window expires (via `onExpire`). Hover pauses the countdown;
 * clicking Undo fires `onUndo` and dismisses the banner.
 */
export function AppliedBanner({
  proposal,
  onUndo,
  onExpire,
  canUndo,
  pending = false,
  errorMessage,
}: AppliedBannerProps) {
  const [paused, setPaused] = React.useState(false);
  const acceptedAt = proposal.acceptedAt;
  // Register this banner's undo handler in the panel-scoped LIFO so
  // ⌘Z / Ctrl-Z fires the most recent still-open window. We use a
  // ref so the registration callback always sees the latest onUndo
  // (without re-registering on every render — that would put the
  // banner at the top of the stack every render and break LIFO
  // ordering relative to sibling banners).
  const onUndoRef = React.useRef(onUndo);
  const canRegisterUndo = canUndo && Boolean(onUndo);
  React.useEffect(() => {
    onUndoRef.current = onUndo;
  }, [onUndo]);
  React.useEffect(() => {
    if (!canRegisterUndo) return;
    return pushAppliedUndoHandler(() => {
      onUndoRef.current?.();
    });
  }, [canRegisterUndo]);
  // `acceptedAt` is required for this banner to render — the caller
  // gates on it, but TypeScript needs the narrowing here so the hook
  // doesn't see a possibly-undefined value. Pause the countdown
  // while the undo round-trip is in flight or after a failure so the
  // window doesn't expire out from under the user mid-recovery.
  const progress = useUndoCountdown(
    UNDO_WINDOW_MS,
    acceptedAt ?? new Date().toISOString(),
    paused || pending || Boolean(errorMessage),
    onExpire,
  );
  const secondsRemaining = Math.max(
    1,
    Math.ceil((progress * UNDO_WINDOW_MS) / 1000),
  );
  const docPath = "docPath" in proposal ? proposal.docPath : undefined;
  const stats = inferDiffStats(proposal);
  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="overflow-hidden rounded-md border border-divider/60 bg-vibrant-green/[0.08]"
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Check
          aria-hidden
          className="size-4 shrink-0 stroke-[2.5] text-vibrant-green"
        />
        <span className="text-[12.5px] text-foreground">Applied</span>
        {docPath && (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-muted"
            title={docPath}
            dir="rtl"
          >
            <bdi dir="ltr">{docPath}</bdi>
          </span>
        )}
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-foreground-muted">
          <span className="text-success">+{stats.added}</span>{" "}
          <span className="text-destructive">−{stats.removed}</span>
        </span>
        {canUndo && onUndo && (
          <button
            type="button"
            onClick={pending ? undefined : onUndo}
            disabled={pending}
            aria-disabled={pending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-divider/60 bg-transparent px-2.5 py-0.5 font-mono text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>{pending ? "Undoing…" : "Undo"}</span>
            {!pending && (
              <span className="font-mono text-[10.5px] text-foreground-muted tabular-nums">
                ({secondsRemaining})
              </span>
            )}
          </button>
        )}
      </div>
      {errorMessage && (
        <div
          role="alert"
          className="border-t border-divider/40 bg-destructive/[0.06] px-3 py-1.5 font-mono text-[11px] text-destructive"
        >
          {errorMessage}
        </div>
      )}
      <div
        aria-hidden
        className="relative h-0.5 overflow-hidden bg-transparent"
      >
        <div
          className="absolute inset-y-0 left-0 bg-vibrant-green/60 transition-[width] duration-[80ms] ease-linear"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Two-stage post-accept render: `AppliedBanner` (lime tint + countdown)
 * for the 6s undo window, then `AppliedLogLine` for the quiet
 * past-tense history entry. Both states keep a read-only expandable
 * view of the applied change. State is local to the component so a
 * single accepted proposal lives in one DOM subtree that doesn't get
 * remounted as the timer ticks. Page reloads inside the window resume
 * the remaining time correctly; reloads after the window land
 * straight in `AppliedLogLine`.
 */
export function AcceptedView({
  proposal,
  onUndo,
}: {
  proposal: AssistantProposal;
  /**
   * Wired by the host when a live AI route is available AND the
   * proposal carries the per-kind undo metadata stamped at accept
   * time. Returns a promise that resolves on success and rejects on
   * failure so the banner can stay mounted and render the inline
   * error per SPEC-014 §Post-Accept Undo Window. Absent for stale
   * localStorage records from before the undo feature shipped —
   * those land in the quiet log line immediately.
   */
  onUndo?: () => Promise<void>;
}) {
  const acceptedAt = proposal.acceptedAt;
  // Page-reload-safe initial state: if more than the window has
  // elapsed since accept, jump straight to the quiet log line.
  const startsExpired = acceptedAt
    ? Date.now() - new Date(acceptedAt).getTime() >= UNDO_WINDOW_MS
    : true;
  const [expired, setExpired] = React.useState(startsExpired);
  // `pending` flips while the undo round-trip is in flight; the
  // banner pauses its countdown and disables the button. On success
  // the reducer removes the proposal record and the component
  // unmounts naturally — we never set a local "undone" flag, so a
  // server failure leaves the banner exactly where it was with the
  // inline error attached.
  const [pending, setPending] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>(
    undefined,
  );
  // Undo is only offered when the host wired a handler AND the
  // proposal carries the metadata the handler needs (accepted doc id,
  // and a priorDraft for body/frontmatter kinds).
  const canUndo = Boolean(
    onUndo &&
      proposal.acceptedDocumentId &&
      (proposal.kind === "create_document" ||
        proposal.kind === "delete_document" ||
        Boolean(proposal.priorDraft)),
  );
  if (expired || !acceptedAt) {
    return (
      <div className="space-y-2">
        <AppliedLogLine proposal={proposal} />
        <AppliedHistoryDetails proposal={proposal} />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <AppliedBanner
        proposal={proposal}
        onExpire={() => setExpired(true)}
        canUndo={canUndo}
        pending={pending}
        {...(errorMessage ? { errorMessage } : {})}
        {...(canUndo && onUndo
          ? {
              onUndo: () => {
                if (pending) return;
                setPending(true);
                setErrorMessage(undefined);
                onUndo().then(
                  () => {
                    // Success: the reducer's `mark-proposal-undone`
                    // strips the proposal record and the component
                    // unmounts. Nothing to do locally — clearing
                    // state on an about-to-unmount component would
                    // trigger a stale setState warning.
                  },
                  (error: unknown) => {
                    const message = extractUndoErrorMessage(error);
                    setErrorMessage(message);
                    setPending(false);
                  },
                );
              },
            }
          : {})}
      />
      <AppliedHistoryDetails proposal={proposal} />
    </div>
  );
}

function AppliedHistoryDetails({ proposal }: { proposal: AssistantProposal }) {
  const stats = inferDiffStats(proposal);
  return (
    <details className="group overflow-hidden rounded-md border border-divider/60 bg-background-subtle">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 font-mono text-[11px] text-foreground-muted transition-colors hover:bg-accent-subtle/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <span className="flex-1">View applied change</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-success">+{stats.added}</span>{" "}
          <span className="text-destructive">−{stats.removed}</span>
        </span>
      </summary>
      <div className="border-t border-divider/50 p-3">
        <AppliedHistoryBody proposal={proposal} />
      </div>
    </details>
  );
}

function AppliedHistoryBody({ proposal }: { proposal: AssistantProposal }) {
  if (proposal.kind === "replace_selection") {
    return (
      <DiffBody
        removed={proposal.op.originalText}
        added={proposal.op.replacementText}
      />
    );
  }
  if (proposal.kind === "insert_block") {
    return (
      <DiffBody
        added={proposal.op.bodyMdx}
        emptyLeftLabel="(no existing content — new block)"
      />
    );
  }
  if (proposal.kind === "create_document") {
    return (
      <div className="space-y-2.5">
        {Object.keys(proposal.op.frontmatter).length > 0 && (
          <JsonPatchBlock label="frontmatter" value={proposal.op.frontmatter} />
        )}
        <DiffBody
          added={proposal.op.bodyPreview || "(empty body)"}
          emptyLeftLabel="(no existing content — new document)"
        />
      </div>
    );
  }
  if (proposal.kind === "delete_document") {
    return (
      <div className="space-y-2.5">
        <RemovedOnlyBody removed={proposal.docPath} />
        {proposal.op.reason && (
          <p className="text-[12px] text-foreground-muted">
            {proposal.op.reason}
          </p>
        )}
      </div>
    );
  }
  return <JsonPatchBlock label="frontmatter patch" value={proposal.op.patch} />;
}

function RemovedOnlyBody({ removed }: { removed: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-divider/60 bg-background-subtle font-mono text-[12px] leading-snug">
      <div className="flex gap-2 border-l-2 border-destructive bg-destructive/5 px-2.5 py-1 text-foreground-muted line-through">
        <span className="w-2.5 shrink-0 text-center text-foreground-muted/80">
          −
        </span>
        <span className="whitespace-pre-wrap">{removed}</span>
      </div>
    </div>
  );
}

function JsonPatchBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="overflow-hidden rounded-md border border-divider/60 bg-background-subtle font-mono text-[12px] leading-snug">
      <div className="border-b border-divider/40 px-2.5 py-1 text-[10px] uppercase tracking-wider text-foreground-muted">
        {label}
      </div>
      <div className="flex gap-2 border-l-2 border-success bg-success/8 px-2.5 py-1 text-foreground">
        <span className="w-2.5 shrink-0 text-center text-foreground-muted/80">
          +
        </span>
        <pre className="whitespace-pre-wrap break-words font-mono">
          {formatJson(value)}
        </pre>
      </div>
    </div>
  );
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

/**
 * Surface a useful inline message from an undo failure. We special-case
 * the conflict code (the most common reason for the user to see this
 * path — they edited the doc inside the 6s window) since the raw
 * server message is operator-oriented; everything else falls through
 * to the carrier's own message.
 */
function extractUndoErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "AI_PROPOSAL_CONFLICT"
  ) {
    return "Can't undo — the document was edited after the apply.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Undo failed.";
}

/**
 * Past-tense log line that replaces the card after the user accepts a
 * proposal and the apply call succeeds. Quieter than the full card so
 * the chat rhythm reads as "happening now vs. already history" without
 * the row vanishing. Matches the design's `LoggedLine` shape.
 */
function AppliedLogLine({ proposal }: { proposal: AssistantProposal }) {
  const docPath = "docPath" in proposal ? proposal.docPath : undefined;
  const acceptedAt = proposal.acceptedAt
    ? formatLoggedTime(proposal.acceptedAt)
    : "";
  const stats = inferDiffStats(proposal);
  return (
    <div className="flex items-center gap-2 p-1 font-mono text-[11px] text-foreground-muted">
      <span aria-hidden className="opacity-70">
        ·
      </span>
      <span>Applied {acceptedAt}</span>
      {docPath && (
        <>
          <span aria-hidden>·</span>
          <span
            className="min-w-0 flex-1 truncate text-foreground"
            title={docPath}
            dir="rtl"
          >
            <bdi dir="ltr">{docPath}</bdi>
          </span>
        </>
      )}
      <span className="shrink-0 tabular-nums">
        (<span className="text-success">+{stats.added}</span>{" "}
        <span className="text-destructive">−{stats.removed}</span>)
      </span>
    </div>
  );
}

function formatLoggedTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function inferDiffStats(p: AssistantProposal): {
  added: number;
  removed: number;
} {
  if (p.diffStats) return p.diffStats;
  if (p.kind === "replace_selection") {
    return {
      added: p.op.replacementText.split("\n").length,
      removed: p.op.originalText.split("\n").length,
    };
  }
  if (p.kind === "insert_block") {
    return { added: p.op.bodyMdx.split("\n").length, removed: 0 };
  }
  if (p.kind === "create_document") {
    return { added: p.op.bodyLines, removed: 0 };
  }
  if (p.kind === "delete_document") {
    return { added: 0, removed: 1 };
  }
  return { added: 0, removed: 0 };
}

export function ProposalCard({
  proposal,
  rejecting = false,
  defaultCollapsed = false,
  onAccept,
  onReject,
  onUndo,
}: ProposalCardProps) {
  // Once accepted, the card morphs into a 6-second lime banner with a
  // visible countdown — Sonia's bullet #3. During the window the
  // banner exposes an Undo button that calls the server's undo
  // endpoint (delete for create_document, restore for
  // delete_document, body/frontmatter replay for the three edit
  // kinds). After the window expires the row settles into the quiet
  // `AppliedLogLine` and undo is no longer offered.
  if (proposal.acceptedAt) {
    return <AcceptedView proposal={proposal} {...(onUndo ? { onUndo } : {})} />;
  }
  if (proposal.kind === "delete_document") {
    return (
      <DeleteCard
        proposal={proposal}
        rejecting={rejecting}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
  }
  if (proposal.kind === "create_document") {
    return (
      <CreateCard
        proposal={proposal}
        rejecting={rejecting}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
  }
  if (
    proposal.kind === "insert_block" &&
    proposal.validation.status === "invalid"
  ) {
    return (
      <InvalidInsertCard
        proposal={proposal}
        rejecting={rejecting}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
  }
  if (
    proposal.kind === "replace_selection" ||
    proposal.kind === "insert_block"
  ) {
    return (
      <EditOrInsertCard
        proposal={proposal}
        rejecting={rejecting}
        defaultCollapsed={defaultCollapsed}
        onAccept={onAccept}
        onReject={onReject}
      />
    );
  }
  // update_frontmatter falls through to a minimal renderer.
  return (
    <FrontmatterCard
      proposal={proposal}
      rejecting={rejecting}
      onAccept={onAccept}
      onReject={onReject}
    />
  );
}

function FrontmatterCard({
  proposal,
  rejecting,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposal;
  rejecting: boolean;
  onAccept: () => void;
  onReject: (feedback: string) => void;
}) {
  const [openLocally, setOpenLocally] = React.useState(false);
  const showReject = rejecting || openLocally;
  // The fallthrough only renders for non-batch proposals that carry per-doc routing.
  const docPath = "docPath" in proposal ? proposal.docPath : undefined;
  const locale = "locale" in proposal ? proposal.locale : undefined;
  return (
    <CardChrome>
      <StandardHeader
        kind={proposal.kind}
        docPath={docPath ?? ""}
        locale={locale}
        validation={proposal.validation}
      />
      <div className="p-3 text-[13px] text-foreground">{proposal.summary}</div>
      {showReject ? (
        <RejectFeedback
          onCancel={() => setOpenLocally(false)}
          onSend={(feedback) => {
            onReject(feedback);
            setOpenLocally(false);
          }}
        />
      ) : (
        <Footer
          contentInvalidated={proposal.contentInvalidated}
          validation={proposal.validation}
          onAccept={onAccept}
          onReject={() => setOpenLocally(true)}
        />
      )}
    </CardChrome>
  );
}
