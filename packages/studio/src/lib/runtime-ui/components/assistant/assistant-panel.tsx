"use client";

import * as React from "react";
import {
  AtSign,
  Check,
  ChevronRight,
  CircleDashed,
  CheckCircle2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import {
  ASSISTANT_COMPOSER_DATA_ATTR,
  type AssistantActiveDocument,
  buildAssistantProposalDocumentPathMap,
  resolveAssistantProposalDisplayPath,
  useAssistant,
  useAssistantActiveDocument,
  relTime,
} from "./assistant-context.js";
import type {
  AssistantMessage,
  AssistantProgressEvent,
  AssistantProposal,
  AssistantThread,
} from "./assistant-types.js";
import { triggerTopAppliedUndo } from "./applied-undo-stack.js";
import { AssistantMarkdown } from "./assistant-markdown.js";
import { EmptyStarter } from "./empty-starter.js";
import { KindGlyph } from "./kind-glyph.js";
import { AcceptedView, ProposalCard } from "./proposal-card.js";
import { SendStopButton } from "./send-stop-button.js";
import { SparkleMark } from "./sparkle-mark.js";
import { useStudioApiConfig } from "../../app/admin/mount-info-context.js";
import { createStudioDocumentRouteApi } from "../../../document-route-api.js";

export type AssistantPanelProps = {
  /** Hide the close (×) button — used when the surface chrome owns dismissal. */
  hideClose?: boolean;
  /** Hide the thread list pane; collapse the panel to a single conversation. */
  hideThreadList?: boolean;
  /** Hide the Fullscreen toggle in the header. */
  hideExpand?: boolean;
  /** When true, render with the rail-mode width hint for chip overflow. */
  variant?: "rail" | "fullscreen";
};

function ThreadList({
  threads,
  activeId,
  onPick,
  onCreate,
}: {
  threads: AssistantThread[];
  activeId: string;
  onPick: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex h-full w-[220px] shrink-0 flex-col border-r border-divider/40 bg-background-subtle">
      <div className="flex items-center gap-2 border-b border-divider/40 px-3 py-2.5">
        <span className="flex-1 font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
          Conversations
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={onCreate}
        >
          <Plus className="size-3" aria-hidden /> New
        </Button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-1.5">
        {threads.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => onPick(t.id)}
            aria-current={t.id === activeId ? "true" : undefined}
            className={cn(
              "mb-0.5 block w-full rounded-md border px-2.5 py-2 text-left transition-colors",
              t.id === activeId
                ? "border-divider/60 bg-card text-foreground"
                : "border-transparent text-foreground hover:bg-card/60",
            )}
          >
            <div className="mb-0.5 truncate text-[12.5px] font-semibold">
              {t.pinned && <span className="mr-1.5 text-primary">●</span>}
              {t.title}
            </div>
            <div className="flex gap-1.5 font-mono text-[10px] text-foreground-muted">
              <span>{relTime(t.updatedAt)}</span>
              <span>·</span>
              <span>
                {t.docCount} doc{t.docCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground-muted">
              {t.preview}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

type MentionCandidate = {
  documentId?: string;
  path: string;
  type: string;
  locale: string;
};

/**
 * Server-backed mention candidate fetch. Debounces the query so the
 * picker doesn't fan out a request per keystroke, aborts in-flight
 * requests when the user keeps typing, and exposes loading + error
 * states for the dropdown to render. Scoped to the active studio
 * project/environment via the mount info context.
 */
function useServerMentionCandidates(query: string): {
  candidates: MentionCandidate[];
  loading: boolean;
  error: string | null;
} {
  const apiConfig = useStudioApiConfig();
  const [state, setState] = React.useState<{
    candidates: MentionCandidate[];
    loading: boolean;
    error: string | null;
  }>({ candidates: [], loading: false, error: null });

  React.useEffect(() => {
    if (!apiConfig) {
      setState({ candidates: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const api = createStudioDocumentRouteApi(
        apiConfig.config,
        apiConfig.authOptions,
      );
      api
        .listContent({
          q: query.length > 0 ? query : undefined,
          limit: 20,
          signal: controller.signal,
        })
        .then((response) => {
          if (controller.signal.aborted) return;
          const mapped: MentionCandidate[] = response.data.map((doc) => ({
            ...(doc.documentId ? { documentId: doc.documentId } : {}),
            path: doc.path,
            type: doc.type,
            locale: doc.locale,
          }));
          setState({ candidates: mapped, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            error instanceof Error
              ? error.message
              : "Failed to load documents.";
          setState({ candidates: [], loading: false, error: message });
        });
    }, 200);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [apiConfig, query]);

  return state;
}

function MentionPicker({
  query,
  excludePaths,
  onPick,
  onClose,
}: {
  query: string;
  excludePaths: Set<string>;
  onPick: (candidate: MentionCandidate) => void;
  onClose: () => void;
}) {
  const { candidates, loading, error } = useServerMentionCandidates(query);
  const filtered = React.useMemo(
    () => candidates.filter((c) => !excludePaths.has(c.path)).slice(0, 8),
    [candidates, excludePaths],
  );

  if (error) {
    return (
      <div
        role="listbox"
        aria-label="Document picker"
        className="absolute bottom-full left-3 right-3 mb-1 rounded-md border border-divider/60 bg-popover p-3 text-[12px] text-destructive shadow-lg"
      >
        Couldn't search documents: {error}.{" "}
        <button
          type="button"
          onClick={onClose}
          className="ml-1 underline hover:text-foreground"
        >
          dismiss
        </button>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Document picker"
        className="absolute bottom-full left-3 right-3 mb-1 rounded-md border border-divider/60 bg-popover p-3 text-[12px] text-foreground-muted shadow-lg"
      >
        {loading ? (
          "Searching documents…"
        ) : query ? (
          <>
            No documents match <code className="font-mono">@{query}</code>.{" "}
          </>
        ) : (
          "Start typing to search documents. "
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-1 underline hover:text-foreground"
        >
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label="Document picker"
      className="absolute bottom-full left-3 right-3 mb-1 max-h-72 overflow-y-auto rounded-md border border-divider/60 bg-popover py-1 shadow-lg"
    >
      <div className="border-b border-divider/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
        Attach document
      </div>
      {filtered.map((c) => (
        <button
          key={c.path}
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => onPick(c)}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-accent-subtle"
        >
          <span className="shrink-0 rounded-sm bg-blue-100 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
            {c.type}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
            {c.path}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-foreground-muted/80">
            {c.locale}
          </span>
        </button>
      ))}
    </div>
  );
}

function ContextChips({
  thread,
  activeDocument,
  onClearSelection,
  onRemoveDoc,
}: {
  thread: AssistantThread;
  activeDocument: AssistantActiveDocument | null;
  onClearSelection: () => void;
  onRemoveDoc: (path: string) => void;
}) {
  const sel = thread.attachedSelection;
  const liveSelection = activeDocument?.selection
    ? {
        documentId: activeDocument.documentId,
        path: activeDocument.path,
        text: activeDocument.selection.text,
        selectionId: activeDocument.selection.selectionId,
      }
    : null;
  const visibleSelection = sel ?? liveSelection;
  // Render mention-added context docs as `+` chips, skipping any that
  // already represent the active editor doc (path-matched) so we don't
  // double up if the user mentions the doc they're currently editing.
  const extras = activeDocument
    ? thread.contextDocs.filter((d) => d.path !== activeDocument.path)
    : thread.contextDocs;
  return (
    <div className="-mb-px flex flex-wrap items-center gap-1.5 rounded-t-lg border border-b-0 border-divider/60 bg-card px-2.5 py-1.5">
      <span className="mr-0.5 font-mono text-[9px] uppercase tracking-wider text-foreground-muted">
        Context
      </span>
      {activeDocument && (
        <span
          className="inline-flex items-center gap-1.5 rounded-sm border border-divider/60 bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-foreground-muted"
          title={`Current document — ${activeDocument.path}`}
        >
          <span className="text-primary">◆</span>
          {activeDocument.path}
        </span>
      )}
      {extras.map((d) => (
        <span
          key={d.path}
          className="inline-flex items-center gap-1.5 rounded-sm border border-divider/60 bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-foreground-muted"
          title={`Selected document — ${d.path}`}
        >
          <span className="text-foreground-muted">＋</span>
          {d.path}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveDoc(d.path);
            }}
            className="-mr-0.5 ml-0.5 rounded text-foreground-muted hover:text-foreground"
            aria-label={`Remove ${d.path} from context`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      {visibleSelection && (
        <span
          className="inline-flex items-center gap-1.5 rounded-sm border border-primary/30 bg-blue-100 px-1.5 py-0.5 font-mono text-[10.5px] text-primary"
          title={visibleSelection.text}
        >
          <SparkleMark size={9} />
          selected text
          {sel ? (
            <button
              type="button"
              onClick={onClearSelection}
              className="-mr-0.5 ml-0.5 rounded text-primary/80 hover:text-primary"
              aria-label="Detach selection"
            >
              <X className="size-2.5" />
            </button>
          ) : null}
        </span>
      )}
    </div>
  );
}

// User messages render as a quiet right-aligned quote — muted ink, no
// fill, a thin right accent border the line sits flush against. The
// asymmetric look pairs with the assistant's sparkle gutter so the eye
// lands on assistant prose rather than bouncing back to the echo of
// the user's own text.
function UserBubble({ message }: { message: AssistantMessage }) {
  const docs = message.context?.documents ?? [];
  const selection = message.context?.selection;
  return (
    <div className="mb-6 flex justify-end">
      <div className="max-w-[70%] border-r-2 border-foreground/20 py-1.5 pl-2.5 pr-2.5 text-right text-[13px] leading-normal text-foreground/60">
        {docs.length > 0 || selection ? (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1">
            {docs.map((doc) => (
              <span
                key={`${doc.source}:${doc.path}`}
                className="inline-flex max-w-full items-center gap-1 rounded-sm border border-divider/50 px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted"
                title={`${doc.source === "current" ? "Current document" : "Attached document"} — ${doc.path}`}
              >
                {doc.source === "current" ? "◆" : "＋"}
                <span className="truncate">{doc.path}</span>
              </span>
            ))}
            {selection ? (
              <span
                className="inline-flex max-w-full items-center gap-1 rounded-sm border border-primary/30 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                title={selection.text}
              >
                <SparkleMark size={9} />
                selected text
              </span>
            ) : null}
          </div>
        ) : null}
        {message.text}
      </div>
    </div>
  );
}

function formatProgressUsage(
  usage: AssistantProgressEvent["usage"],
): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number") {
    parts.push(`${usage.inputTokens} in`);
  }
  if (typeof usage.outputTokens === "number") {
    parts.push(`${usage.outputTokens} out`);
  }
  if (typeof usage.totalTokens === "number") {
    parts.push(`${usage.totalTokens} total`);
  }
  return parts.length > 0 ? `${parts.join(" / ")} tokens` : null;
}

function progressIcon(event: AssistantProgressEvent) {
  if (event.status === "failed" || event.phase === "tool-error") {
    return <TriangleAlert className="size-3.5" aria-hidden="true" />;
  }
  if (event.status === "queued" || event.status === "completed") {
    return <CheckCircle2 className="size-3.5" aria-hidden="true" />;
  }
  if (event.phase === "tool-call") {
    return <Wrench className="size-3.5" aria-hidden="true" />;
  }
  return <CircleDashed className="size-3.5 animate-spin" aria-hidden="true" />;
}

function progressTone(event: AssistantProgressEvent): string {
  if (event.status === "failed" || event.phase === "tool-error") {
    return "text-destructive";
  }
  if (event.status === "rejected") {
    return "text-accent-amber";
  }
  if (event.status === "queued" || event.status === "completed") {
    return "text-success";
  }
  return "text-primary";
}

function AssistantProgressTimeline({
  events,
}: {
  events: AssistantProgressEvent[];
}) {
  if (events.length === 0) return null;
  const visible = events.slice(-6);
  return (
    <div
      className="mt-1 flex max-w-[92%] flex-col gap-1.5 border-l border-divider/60 pl-3"
      aria-label="AI progress"
    >
      {visible.map((event, idx) => {
        const usage = formatProgressUsage(event.usage);
        return (
          <div
            key={`${event.phase}-${event.toolName ?? "model"}-${idx}`}
            className="flex min-w-0 items-center gap-2 text-[12px] leading-5 text-foreground-muted"
          >
            <span className={cn("shrink-0", progressTone(event))}>
              {progressIcon(event)}
            </span>
            <span className="min-w-0 flex-1 truncate">{event.message}</span>
            {usage ? (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-foreground-subtle">
                {usage}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// Assistant turns sit in a two-column layout: a fixed 24px gutter that
// holds the blue ✦ identity glyph, and a flex content column with the
// prose + proposal cards. The fixed gutter keeps proposals aligned to
// a consistent left edge across an entire turn instead of just the
// first prose paragraph.
export function AssistantBubble({
  message,
  proposalsById,
  documentPathById,
  isStreamingPlaceholder,
  onAccept,
  onReject,
  onUndo,
}: {
  message: AssistantMessage;
  proposalsById: Record<string, AssistantProposal>;
  documentPathById: ReadonlyMap<string, string>;
  /**
   * True when this message is the most-recent assistant turn AND the
   * context is mid-stream. Drives the typing-indicator render when
   * text is still empty.
   */
  isStreamingPlaceholder: boolean;
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string, feedback: string) => void;
  /**
   * Optional handler for the post-accept Undo button. Returns a
   * promise so the banner can wait for the server's response before
   * dismissing — failures keep the banner mounted with an inline
   * error. Omitted when no live AI route is wired (e.g. showcases /
   * tests); in that case the banner hides the button.
   */
  onUndo?: (proposalId: string) => Promise<void>;
}) {
  const proposalIds = message.proposals ?? [];
  const text = message.text?.trim();
  const progressEvents = isStreamingPlaceholder ? (message.progress ?? []) : [];
  if (
    proposalIds.length === 0 &&
    !text &&
    !isStreamingPlaceholder &&
    progressEvents.length === 0
  ) {
    return null;
  }
  const proposals = proposalIds.flatMap((pid) => {
    const proposal = proposalsById[pid];
    return proposal
      ? [resolveAssistantProposalDisplayPath(proposal, documentPathById)]
      : [];
  });
  const isMultiTurn = proposals.length > 1;
  return (
    <div className="mb-6 flex items-start gap-0">
      <div className="w-6 shrink-0 pt-2 text-primary" aria-hidden="true">
        <SparkleMark size={14} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {text ? (
          <div className="max-w-[92%] py-0.5">
            <AssistantMarkdown text={text} />
          </div>
        ) : isStreamingPlaceholder && progressEvents.length === 0 ? (
          <div
            className="inline-flex max-w-[92%] items-center gap-1 py-1.5 text-foreground-muted"
            aria-label="Generating response"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:-0.2s]" />
            <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            <span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:0.2s]" />
          </div>
        ) : null}
        {isStreamingPlaceholder && progressEvents.length > 0 ? (
          <AssistantProgressTimeline events={progressEvents} />
        ) : null}
        {!isMultiTurn &&
          proposals.map((proposal) => (
            <ProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              onAccept={() => onAccept(proposal.proposalId)}
              onReject={(feedback) => onReject(proposal.proposalId, feedback)}
              {...(onUndo ? { onUndo: () => onUndo(proposal.proposalId) } : {})}
            />
          ))}
        {isMultiTurn && (
          <TurnGroup
            proposals={proposals}
            onAccept={onAccept}
            onReject={onReject}
            {...(onUndo ? { onUndo } : {})}
          />
        )}
      </div>
    </div>
  );
}

const TURN_KIND_LABEL: Record<AssistantProposal["kind"], string> = {
  replace_selection: "Edit",
  insert_block: "Insert",
  update_frontmatter: "Frontmatter",
  create_document: "New doc",
  delete_document: "Delete",
};

// One blue family for every non-destructive operation, an amber family
// reserved for the destructive kind. Keeping the chip palette to two
// hues makes the destructive case unmistakable at a glance even when
// the row is otherwise text-dense.
function turnChipPaletteFor(kind: AssistantProposal["kind"]): string {
  return kind === "delete_document"
    ? "bg-accent-amber-tint text-accent-amber"
    : "bg-primary/15 text-primary";
}

function diffStatsFor(proposal: AssistantProposal): {
  added: number;
  removed: number;
} {
  if (proposal.diffStats) return proposal.diffStats;
  if (proposal.kind === "replace_selection") {
    return {
      added: proposal.op.replacementText.split("\n").length,
      removed: proposal.op.originalText.split("\n").length,
    };
  }
  if (proposal.kind === "insert_block") {
    return { added: proposal.op.bodyMdx.split("\n").length, removed: 0 };
  }
  if (proposal.kind === "create_document") {
    return { added: proposal.op.bodyLines, removed: 0 };
  }
  if (proposal.kind === "delete_document") {
    return { added: 0, removed: 1 };
  }
  if (proposal.kind === "update_frontmatter") {
    return { added: Object.keys(proposal.op.patch).length, removed: 0 };
  }
  return { added: 0, removed: 0 };
}

function expandedPreviewFor(proposal: AssistantProposal): React.ReactNode {
  if (proposal.kind === "replace_selection") {
    return (
      <div className="space-y-1.5 font-mono text-[11.5px] leading-relaxed">
        <div className="rounded-sm bg-destructive/10 px-2 py-1.5 text-destructive line-through decoration-destructive/40">
          {proposal.op.originalText}
        </div>
        <div className="rounded-sm bg-vibrant-green/10 px-2 py-1.5 text-vibrant-green">
          {proposal.op.replacementText}
        </div>
      </div>
    );
  }
  if (proposal.kind === "insert_block") {
    return (
      <pre className="overflow-x-auto rounded-sm bg-vibrant-green/10 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-vibrant-green">
        {proposal.op.bodyMdx}
      </pre>
    );
  }
  if (proposal.kind === "create_document") {
    return (
      <pre className="overflow-x-auto rounded-sm bg-vibrant-green/10 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-vibrant-green">
        {proposal.op.bodyPreview}
      </pre>
    );
  }
  if (proposal.kind === "update_frontmatter") {
    return (
      <pre className="overflow-x-auto rounded-sm bg-primary/10 px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-primary">
        {JSON.stringify(proposal.op.patch, null, 2)}
      </pre>
    );
  }
  if (proposal.kind === "delete_document") {
    return (
      <div className="rounded-sm bg-destructive/10 px-2 py-1.5 font-mono text-[11.5px] text-destructive">
        rm {proposal.op.path}
        {proposal.op.reason ? ` — ${proposal.op.reason}` : ""}
      </div>
    );
  }
  // All AssistantProposal kinds have a dedicated branch above; this
  // fallback keeps the function total without referring to `never`.
  return null;
}

function TurnGroup({
  proposals,
  onAccept,
  onReject,
  onUndo,
}: {
  proposals: AssistantProposal[];
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string, feedback: string) => void;
  /**
   * Optional undo handler — same contract as the single-card path.
   * Each accepted child opens its own independent undo window per
   * SPEC-014 §Post-Accept Undo Window, so we thread the handler into
   * every row instead of scoping it to the most recent accept.
   */
  onUndo?: (proposalId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [showReject, setShowReject] = React.useState(false);
  const allValid = proposals.every((p) => p.validation.status === "valid");
  const stale = proposals.some((p) => p.contentInvalidated);
  const acceptBlocked = !allValid || stale;
  // Hide the batch action bar (Reject all / Accept all) once every
  // row has been individually resolved — leaving "Accept all (3)"
  // visible after the user already accepted all 3 reads as a stuck
  // affordance. Rows remain on screen as their AcceptedView /
  // logged-line history; the footer just gets out of the way.
  const pendingProposals = proposals.filter((p) => !p.acceptedAt);
  const hasPending = pendingProposals.length > 0;
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card">
      <ul className="m-0 list-none p-0">
        {proposals.map((proposal, i) => {
          const isExpanded = !!expanded[proposal.proposalId];
          const stats = diffStatsFor(proposal);
          const valid = proposal.validation.status === "valid";
          const isAccepted = Boolean(proposal.acceptedAt);
          return (
            <li
              key={proposal.proposalId}
              className={cn(
                i < proposals.length - 1 && "border-b border-divider/40",
              )}
            >
              {isAccepted ? (
                // Hand the row off to the same accepted-view component
                // a single card uses: 6s lime banner with countdown
                // first, then morphs to the quiet past-tense log line.
                // Threading onUndo here is what gives each accepted
                // child its own independent undo window — without it
                // multi-proposal turns would silently drop the Undo
                // affordance the single-card path exposes.
                <div className="px-3 py-2">
                  <AcceptedView
                    proposal={proposal}
                    {...(onUndo
                      ? { onUndo: () => onUndo(proposal.proposalId) }
                      : {})}
                  />
                </div>
              ) : (
                <>
                  <TurnRow
                    proposal={proposal}
                    stats={stats}
                    valid={valid}
                    isExpanded={isExpanded}
                    onToggle={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [proposal.proposalId]: !isExpanded,
                      }))
                    }
                    onAccept={() => onAccept(proposal.proposalId)}
                    onReject={() => onReject(proposal.proposalId, "")}
                  />
                  {isExpanded && (
                    <div className="border-t border-divider/40 bg-background-subtle px-3 py-2.5">
                      {expandedPreviewFor(proposal)}
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {!hasPending ? null : showReject ? (
        <TurnRejectFeedback
          onCancel={() => setShowReject(false)}
          onSend={(feedback) => {
            for (const p of pendingProposals) onReject(p.proposalId, feedback);
            setShowReject(false);
          }}
        />
      ) : (
        <div className="flex items-center gap-2 border-t border-divider/40 bg-background-subtle px-3 py-2">
          <span className="flex-1 font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
            {pendingProposals.length} of {proposals.length} pending
          </span>
          <button
            type="button"
            onClick={() => setShowReject(true)}
            className="rounded border border-border bg-transparent px-2.5 py-1 font-mono text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          >
            Reject all…
          </button>
          <button
            type="button"
            onClick={
              acceptBlocked
                ? undefined
                : () => {
                    for (const p of pendingProposals) onAccept(p.proposalId);
                  }
            }
            disabled={acceptBlocked}
            aria-disabled={acceptBlocked}
            title={
              stale
                ? "Source text changed — retry to regenerate"
                : allValid
                  ? `Apply all ${pendingProposals.length} pending proposals`
                  : "Fix invalid proposals before accepting"
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors",
              acceptBlocked
                ? "cursor-not-allowed border-transparent bg-muted text-foreground-muted"
                : "border-vibrant-green-border bg-vibrant-green text-vibrant-green-foreground hover:bg-vibrant-green/90",
            )}
          >
            <Check className="size-3" aria-hidden />
            Accept all ({pendingProposals.length})
          </button>
        </div>
      )}
    </div>
  );
}

// Two-line row: the document path sits as the headline, the operation
// chip (blue / amber by kind) + ± stats + a validation flag share the
// second line, and the row's trailing icon stack gives one-click
// accept / reject without disclosing the expanded diff. The chevron
// still toggles inline disclosure, but it lives at the far right where
// it doesn't compete with the chip for first read.
function TurnRow({
  proposal,
  stats,
  valid,
  isExpanded,
  onToggle,
  onAccept,
  onReject,
}: {
  proposal: AssistantProposal;
  stats: { added: number; removed: number };
  valid: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const rowAria = `Proposal — ${TURN_KIND_LABEL[proposal.kind]} in ${
    proposal.docPath
  }, +${stats.added} −${stats.removed}`;
  return (
    <div
      role="group"
      aria-label={rowAria}
      className="flex flex-col gap-1.5 px-3 py-2"
    >
      <button
        type="button"
        onClick={onToggle}
        title={proposal.docPath}
        aria-expanded={isExpanded}
        className="block w-full truncate text-left font-mono text-[12px] text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        dir="rtl"
      >
        <bdi dir="ltr">{proposal.docPath}</bdi>
      </button>
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
            turnChipPaletteFor(proposal.kind),
          )}
        >
          <KindGlyph kind={proposal.kind} />
          {TURN_KIND_LABEL[proposal.kind]}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground-muted">
          <span className="text-success">+{stats.added}</span>{" "}
          <span className="text-destructive">−{stats.removed}</span>
        </span>
        {!valid && (
          <span
            aria-hidden
            title="Invalid"
            className="shrink-0 text-[11px] text-destructive"
          >
            ⚠
          </span>
        )}
        <span className="flex-1" />
        <RowIconButton
          label="Reject"
          tone="reject"
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
        >
          <X className="size-3.5" aria-hidden />
        </RowIconButton>
        <RowIconButton
          label="Accept"
          tone="accept"
          disabled={!valid}
          onClick={(e) => {
            e.stopPropagation();
            if (valid) onAccept();
          }}
        >
          <Check className="size-3.5" aria-hidden />
        </RowIconButton>
        <RowIconButton
          label={isExpanded ? "Collapse details" : "Expand details"}
          tone="neutral"
          pressed={isExpanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              isExpanded && "rotate-90",
            )}
            aria-hidden
          />
        </RowIconButton>
      </div>
    </div>
  );
}

// 28×28 hit target with a tonal hover tint — `accept` warms toward
// lime, `reject` toward destructive red, `neutral` stays grey. Stays
// flat in the idle state so a row with three icons doesn't broadcast
// as three buttons until the user actually points at one.
function RowIconButton({
  label,
  tone,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tone: "accept" | "reject" | "neutral";
  pressed?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      title={label}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded text-foreground-muted transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : tone === "accept"
            ? "hover:bg-vibrant-green/25 hover:text-foreground"
            : tone === "reject"
              ? "hover:bg-destructive/15 hover:text-destructive"
              : "hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function TurnRejectFeedback({
  onCancel,
  onSend,
}: {
  onCancel: () => void;
  onSend: (feedback: string) => void;
}) {
  const [text, setText] = React.useState("");
  return (
    <div className="space-y-2 border-t border-divider/40 bg-background-subtle px-3 py-2.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Why are you rejecting these? (optional — sent back to the model on regenerate)"
        rows={2}
        className="w-full resize-none rounded border border-border bg-card px-2 py-1.5 text-[12px] text-foreground placeholder:text-foreground-muted/60 focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono text-[10px] uppercase tracking-wider text-foreground-muted">
          rejecting whole turn
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border bg-transparent px-2.5 py-1 font-mono text-[11px] font-medium text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSend(text.trim())}
          className="inline-flex items-center gap-1.5 rounded bg-sidebar px-2.5 py-1 font-mono text-[11px] font-semibold text-vibrant-green transition-colors hover:bg-sidebar/90"
        >
          Send & retry
        </button>
      </div>
    </div>
  );
}

function Composer({
  thread,
  draft,
  setDraft,
  textareaRef,
  onClearSelection,
  onRemoveDoc,
}: {
  thread: AssistantThread;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onClearSelection: () => void;
  onRemoveDoc: (path: string) => void;
}) {
  const assistant = useAssistant();
  const activeDocument = useAssistantActiveDocument();
  const [mention, setMention] = React.useState<{
    query: string;
    caret: number;
  } | null>(null);

  // Focus the composer on mount so opening the assistant lands the cursor
  // ready-to-type. The Composer only mounts when the rail/fullscreen
  // panel is open, so mount == open.
  React.useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const end = ta.value.length;
    ta.focus();
    ta.setSelectionRange(end, end);
  }, [textareaRef]);

  const submit = () => {
    if (assistant.isPending) return;
    if (!draft.trim()) return;
    assistant.sendMessage(draft);
    setDraft("");
    setMention(null);
  };

  const onChange: React.ChangeEventHandler<HTMLTextAreaElement> = (e) => {
    const next = e.target.value;
    setDraft(next);
    const caret = e.target.selectionStart ?? next.length;
    const upToCaret = next.slice(0, caret);
    const atIndex = upToCaret.lastIndexOf("@");
    if (atIndex < 0) {
      setMention(null);
      return;
    }
    const between = upToCaret.slice(atIndex + 1);
    // Only treat the @ as a mention if it sits at start-of-string or
    // after a whitespace char, and the text after it has no whitespace.
    const before = atIndex === 0 ? "" : upToCaret[atIndex - 1];
    if (before && !/\s/.test(before)) {
      setMention(null);
      return;
    }
    if (/\s/.test(between)) {
      setMention(null);
      return;
    }
    setMention({ query: between, caret });
  };

  const handlePick = (candidate: MentionCandidate) => {
    assistant.attachContextDoc({
      ...(candidate.documentId ? { documentId: candidate.documentId } : {}),
      path: candidate.path,
      type: candidate.type,
      locale: candidate.locale,
    });
    let nextCaret: number | null = null;
    if (mention) {
      const before = draft.slice(0, mention.caret);
      const after = draft.slice(mention.caret);
      const atIndex = before.lastIndexOf("@");
      if (atIndex >= 0) {
        const replaced = `${draft.slice(0, atIndex)}${after}`;
        setDraft(replaced);
        nextCaret = atIndex;
      }
    }
    setMention(null);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      if (nextCaret !== null) {
        const caret = nextCaret;
        requestAnimationFrame(() => {
          ta.setSelectionRange(caret, caret);
        });
      }
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="relative border-t border-divider/40 bg-background-subtle px-3 pb-3 pt-2.5"
    >
      <ContextChips
        thread={thread}
        activeDocument={activeDocument}
        onClearSelection={onClearSelection}
        onRemoveDoc={onRemoveDoc}
      />
      <div
        {...{ [ASSISTANT_COMPOSER_DATA_ATTR]: "" }}
        className="rounded-b-lg border border-divider/60 bg-card px-3 py-2.5 transition-colors focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30"
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={onChange}
          rows={2}
          placeholder={
            assistant.isPending
              ? "Draft your next message…"
              : "Ask about any doc, propose edits, draft new posts…"
          }
          className="w-full resize-none border-none bg-transparent text-[13.5px] leading-snug text-foreground outline-none placeholder:text-foreground-muted"
          onKeyDown={(e) => {
            if (e.key === "Escape" && assistant.isPending) {
              e.preventDefault();
              assistant.cancelPending();
              return;
            }
            if (mention && e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
            if (
              (e.metaKey || e.ctrlKey) &&
              e.key === "Enter" &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex-1 font-mono text-[10px] text-foreground-muted">
            {assistant.isPending
              ? "Streaming… Esc to stop · send after response finishes"
              : "⌘ ↵ to send · @ to reference a doc"}
          </span>
          <button
            type="button"
            onClick={() => {
              const ta = textareaRef.current;
              if (!ta) return;
              ta.focus();
              const caret = ta.selectionStart ?? draft.length;
              const next =
                draft.slice(0, caret) +
                (caret > 0 && !/\s/.test(draft[caret - 1] ?? "") ? " @" : "@") +
                draft.slice(caret);
              setDraft(next);
              const newCaret = next.length - draft.slice(caret).length;
              setMention({ query: "", caret: newCaret });
              window.setTimeout(() => {
                ta.setSelectionRange(newCaret, newCaret);
              }, 0);
            }}
            className="grid size-6 place-items-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
            title="Attach document (@)"
            aria-label="Attach document"
          >
            <AtSign className="size-3.5" aria-hidden />
          </button>
          <SendStopButton
            pending={assistant.isPending}
            hasDraft={Boolean(draft.trim())}
            onSend={submit}
            onStop={assistant.cancelPending}
          />
        </div>
      </div>
      {mention && (
        <MentionPicker
          query={mention.query}
          excludePaths={
            new Set([
              ...thread.contextDocs.map((d) => d.path),
              ...(activeDocument ? [activeDocument.path] : []),
            ])
          }
          onPick={handlePick}
          onClose={() => setMention(null)}
        />
      )}
    </form>
  );
}

export function AssistantPanel({
  hideClose = false,
  hideThreadList = false,
  hideExpand = false,
  variant = "rail",
}: AssistantPanelProps) {
  const assistant = useAssistant();
  const activeDocument = useAssistantActiveDocument();
  const thread = assistant.activeThread;
  const proposalDocumentPathMap = React.useMemo(
    () =>
      buildAssistantProposalDocumentPathMap({
        activeDocument,
        thread,
      }),
    [activeDocument, thread],
  );
  // Lifted so the empty-state example cards can fill the same buffer
  // the Composer renders. The Composer is otherwise a controlled
  // textarea against this state.
  const [draft, setDraft] = React.useState("");
  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Root of the panel — used by the panel-scoped ⌘Z / Ctrl-Z handler
  // to check whether focus is inside our subtree before stealing the
  // shortcut from the OS / browser.
  const panelRootRef = React.useRef<HTMLDivElement | null>(null);

  // Panel-scoped post-accept undo shortcut: ⌘Z (macOS) or Ctrl+Z
  // (other) triggers the most recently registered undo handler
  // surfaced by `AppliedBanner`. We listen on `document` so the
  // shortcut fires even when focus is on a composer textarea inside
  // the panel — only the focus-containment check matters for whether
  // we claim the event.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Bail on Shift+Z so redo (⌘⇧Z) and selection-extend never
      // collide with the undo window.
      if (event.shiftKey) return;
      const isUndoChord = event.metaKey || event.ctrlKey;
      if (!isUndoChord) return;
      if (event.key.toLowerCase() !== "z") return;
      const root = panelRootRef.current;
      const active = document.activeElement;
      if (!root || !active || !root.contains(active)) return;
      const fired = triggerTopAppliedUndo();
      if (fired) {
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sticky-at-bottom auto-scroll. Tracks whether the user is currently
  // pinned to the latest message; we only auto-scroll on new content
  // while they're stuck at the bottom. If they scroll up to read older
  // turns we leave them alone, then re-engage when they scroll back
  // near the bottom.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickyRef = React.useRef(true);

  const isNearBottom = React.useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [],
  );

  // Re-engage stickiness whenever the user manually scrolls back down,
  // disengage when they scroll up. ResizeObserver covers proposal
  // cards expanding mid-conversation (mid-scroll the height changes
  // even though the user didn't touch the wheel).
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickyRef.current = isNearBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isNearBottom]);

  // Drive the actual scroll on every render where content might have
  // grown — messages length, pending state (assistant is mid-stream),
  // proposal map identity (proposal mutation morphs a row in place),
  // AND the trailing message's text length so streaming deltas keep
  // the bottom of the most recent turn in view.
  const lastMessageTextLength =
    thread.messages[thread.messages.length - 1]?.text?.length ?? 0;
  React.useEffect(() => {
    if (!stickyRef.current) return;
    scrollToBottom("smooth");
  }, [
    thread.messages.length,
    assistant.isPending,
    assistant.store.proposals,
    lastMessageTextLength,
    scrollToBottom,
  ]);

  // First mount or thread switch — jump to bottom without animation so
  // the user opens to the latest turn rather than the top of history.
  React.useEffect(() => {
    stickyRef.current = true;
    scrollToBottom("auto");
  }, [thread.id, scrollToBottom]);

  const fillFromExample = React.useCallback((prompt: string) => {
    setDraft(prompt);
    const ta = composerRef.current;
    if (!ta) return;
    ta.focus();
    // Wait one frame so the controlled value lands before we set the
    // caret — otherwise React resets the selection on the next render.
    requestAnimationFrame(() => {
      try {
        ta.setSelectionRange(prompt.length, prompt.length);
      } catch {
        // Some browsers (Safari with certain input types) reject
        // setSelectionRange — non-fatal, the value still landed.
      }
    });
  }, []);

  const visibleThreadList = !hideThreadList;

  return (
    <div
      ref={panelRootRef}
      className="flex h-full min-h-0 overflow-hidden bg-card text-card-foreground"
    >
      {visibleThreadList && (
        <ThreadList
          threads={assistant.store.threads}
          activeId={assistant.activeThread.id}
          onPick={assistant.selectThread}
          onCreate={assistant.createThread}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-9 items-center gap-2 border-b border-divider/40 px-3 py-1.5">
          <span className="text-primary">
            <SparkleMark size={14} />
          </span>
          <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
            {thread.title}
          </div>
          {!hideExpand && (
            <button
              type="button"
              onClick={assistant.toggleFullscreen}
              className="grid size-6 place-items-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
              title={assistant.isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={
                assistant.isFullscreen ? "Exit fullscreen" : "Fullscreen"
              }
            >
              {assistant.isFullscreen ? (
                <Minimize2 className="size-3.5" aria-hidden />
              ) : (
                <Maximize2 className="size-3.5" aria-hidden />
              )}
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="grid size-6 place-items-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
                title="More"
                aria-label="More actions"
              >
                <MoreHorizontal className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => assistant.createThread()}>
                New conversation
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => assistant.toggleThreadPin(thread.id)}
              >
                {thread.pinned ? "Unpin conversation" : "Pin conversation"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => assistant.deleteThread(thread.id)}
                className="text-destructive focus:text-destructive"
              >
                Delete conversation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => assistant.close()}>
                Close assistant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {!hideClose && (
            <button
              type="button"
              onClick={assistant.close}
              className="grid size-6 place-items-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
              title="Close"
              aria-label="Close assistant"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <div
          ref={scrollRef}
          className={cn(
            "scrollbar-thin flex-1 space-y-1 overflow-y-auto p-4",
            variant === "fullscreen" && "px-8",
          )}
        >
          {thread.messages.length === 0 ? (
            <EmptyStarter
              thread={thread}
              activeDocument={activeDocument}
              hasDraft={draft.trim().length > 0}
              onPick={fillFromExample}
            />
          ) : (
            (() => {
              // Filter out hidden side-channel messages (e.g. the
              // "I accepted your proposal" turn the client appends so
              // the model sees acceptances in conversation history)
              // before laying out the timeline. The model still
              // receives them via the conversationHistory serializer;
              // the user just doesn't see them.
              const visible = thread.messages.filter((m) => !m.hidden);
              // The streaming typing-indicator only renders for the
              // most-recent visible assistant turn while the context
              // is mid-stream. Compute once per render rather than
              // scanning inside the map callback.
              const lastAssistantIdx = (() => {
                for (let i = visible.length - 1; i >= 0; i--) {
                  if (visible[i]?.role === "assistant") return i;
                }
                return -1;
              })();
              return visible.map((m, idx) =>
                m.role === "user" ? (
                  <UserBubble key={m.id} message={m} />
                ) : (
                  <AssistantBubble
                    key={m.id}
                    message={m}
                    proposalsById={assistant.store.proposals}
                    documentPathById={proposalDocumentPathMap}
                    isStreamingPlaceholder={
                      assistant.isPending && idx === lastAssistantIdx
                    }
                    onAccept={(pid) => {
                      const p = assistant.store.proposals[pid];
                      if (p) assistant.acceptProposal(p);
                    }}
                    onReject={(pid, feedback) => {
                      const p = assistant.store.proposals[pid];
                      if (p) assistant.rejectProposal(p, feedback);
                    }}
                    onUndo={async (pid) => {
                      const p = assistant.store.proposals[pid];
                      if (!p) return;
                      await assistant.undoProposal(p);
                    }}
                  />
                ),
              );
            })()
          )}
        </div>
        <Composer
          thread={thread}
          draft={draft}
          setDraft={setDraft}
          textareaRef={composerRef}
          onClearSelection={assistant.clearActiveSelection}
          onRemoveDoc={assistant.removeContextDoc}
        />
      </div>
    </div>
  );
}
