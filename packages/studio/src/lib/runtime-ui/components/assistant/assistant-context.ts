"use client";

import * as React from "react";

import {
  RuntimeError,
  type AiComponentReference,
  type MdxComponentCatalog,
} from "@mdcms/shared";

import type {
  StudioAiChatProgressEvent,
  StudioAiChatMessageRequest,
  StudioAiChatAttachedSelection,
  StudioAiProposal,
  StudioAiRouteApi,
} from "../../../ai-route-api.js";
import type {
  AssistantContextDoc,
  AssistantMessage,
  AssistantMessageContextSnapshot,
  AssistantProposal,
  AssistantStore,
  AssistantThread,
} from "./assistant-types.js";

export type { AssistantThread } from "./assistant-types.js";

type RailMode = "closed" | "rail" | "fullscreen";

export const ASSISTANT_PROPOSAL_APPLIED_EVENT =
  "mdcms:assistant-proposal-applied";

export type AssistantProposalAppliedEventDetail = {
  documentId: string;
  body: string;
  frontmatter: Record<string, unknown>;
  draftRevision: number;
  updatedAt: string;
};

function emitAssistantProposalApplied(
  detail: AssistantProposalAppliedEventDetail,
) {
  if (typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent<AssistantProposalAppliedEventDetail>(
      ASSISTANT_PROPOSAL_APPLIED_EVENT,
      {
        detail,
      },
    ),
  );
}

type AssistantState = {
  store: AssistantStore;
  mode: RailMode;
  activeThreadId: string;
  railWidth: number;
};

type AssistantAction =
  | { type: "open-rail" }
  | { type: "close" }
  | { type: "toggle-fullscreen" }
  | { type: "set-mode"; mode: RailMode }
  | { type: "set-rail-width"; width: number }
  | { type: "select-thread"; threadId: string }
  | { type: "clear-selection-on-active" }
  | { type: "remove-context-doc"; path: string }
  | { type: "attach-context-doc"; doc: AssistantContextDoc }
  | { type: "toggle-thread-pin"; threadId: string }
  | { type: "create-thread"; thread: AssistantThread }
  | { type: "delete-thread"; threadId: string }
  | { type: "hydrate"; store: AssistantStore }
  | { type: "remove-proposal"; threadId: string; proposalId: string }
  | {
      /**
       * Apply succeeded. Stamps `acceptedAt` on the proposal so the
       * card renders as a past-tense log line, and appends a hidden
       * user turn describing the acceptance so the model sees the
       * signal in the next conversation-history send.
       */
      type: "mark-proposal-accepted";
      threadId: string;
      proposalId: string;
      acceptedAt: string;
      hiddenMessage: AssistantMessage;
      /**
       * Document id resolved from the apply response. Stamped on the
       * proposal so the post-accept undo handler can target the right
       * doc per kind (delete for create_document, restore for
       * delete_document, body/frontmatter replay for edit kinds).
       */
      acceptedDocumentId?: string;
      /**
       * Pre-apply draft snapshot returned by the apply endpoint, only
       * present for body/frontmatter mutating kinds. Echoed back on
       * undo.
       */
      priorDraft?: { body: string; frontmatter: Record<string, unknown> };
      /** Draft revision the apply call produced. */
      postApplyDraftRevision?: number;
    }
  | {
      /**
       * Undo succeeded inside the 6-second window. Strips the proposal
       * from the rendering map (so the banner / log line both
       * disappear) and appends a hidden side-channel turn describing
       * the undo so the next conversationHistory send reflects it.
       */
      type: "mark-proposal-undone";
      threadId: string;
      proposalId: string;
      undoneAt: string;
      hiddenMessage: AssistantMessage;
    }
  | {
      type: "reject-proposal";
      threadId: string;
      proposalId: string;
      feedback: string;
    }
  | {
      type: "send-message";
      threadId: string;
      userMessage: AssistantMessage;
      assistantMessage: AssistantMessage;
      newProposals: AssistantProposal[];
      /**
       * Wire-shape proposals matching `newProposals` by id. Persisted in
       * the store's `wireProposals` map so accept/reject can post them
       * back to the server intact, bypassing the in-memory proposal
       * store on the server side.
       */
      newWireProposals: Record<string, StudioAiProposal>;
    }
  /**
   * Begin a streaming turn — adds the user message + an empty
   * assistant placeholder whose text grows via subsequent
   * `append-stream-delta` dispatches and is finalised by
   * `commit-stream-turn` (or replaced by an error turn on failure).
   */
  | {
      type: "begin-stream-turn";
      threadId: string;
      userMessage: AssistantMessage;
      placeholderId: string;
      placeholderAt: string;
    }
  | {
      type: "append-stream-delta";
      threadId: string;
      placeholderId: string;
      delta: string;
    }
  | {
      type: "append-stream-progress";
      threadId: string;
      placeholderId: string;
      progress: Omit<StudioAiChatProgressEvent, "type">;
    }
  | {
      type: "commit-stream-turn";
      threadId: string;
      placeholderId: string;
      finalMessage: AssistantMessage;
      newProposals: AssistantProposal[];
      newWireProposals: Record<string, StudioAiProposal>;
    }
  | {
      /**
       * Replace the streaming placeholder with an inline error turn
       * carrying the wire-level code so the UI can render it the same
       * way a non-streaming failure would.
       */
      type: "abort-stream-turn";
      threadId: string;
      placeholderId: string;
      errorText: string;
    };

const NEW_THREAD_TITLE = "New conversation";
export const ASSISTANT_RAIL_DEFAULT_WIDTH = 420;
export const ASSISTANT_RAIL_MIN_WIDTH = 360;
export const ASSISTANT_RAIL_MAX_WIDTH = 720;

export function clampAssistantRailWidth(width: number): number {
  if (!Number.isFinite(width)) return ASSISTANT_RAIL_DEFAULT_WIDTH;
  return Math.min(
    ASSISTANT_RAIL_MAX_WIDTH,
    Math.max(ASSISTANT_RAIL_MIN_WIDTH, Math.round(width)),
  );
}

/**
 * Server 500s wrap the original exception's text inside
 * `details.payload.details.reason` because the public `message` is
 * forced to "Internal server error." Walk the nested envelope to
 * surface the real reason so the user sees something more useful
 * than the generic placeholder.
 */
function extractInnerReason(error: unknown): string | undefined {
  if (!(error instanceof RuntimeError)) return undefined;
  const details = error.details;
  if (!details || typeof details !== "object") return undefined;
  const payload = (details as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  const inner = (payload as { details?: unknown }).details;
  if (!inner || typeof inner !== "object") return undefined;
  const reason = (inner as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.length > 0 ? reason : undefined;
}

/**
 * Build the side-channel text we hand to the model when the user
 * accepts a proposal. The model receives this as a "user" turn in
 * the next conversation-history window — phrased so it reads as the
 * user reporting the acceptance rather than the system fabricating a
 * message. The kind/docPath give the model enough context to
 * acknowledge what landed without re-proposing it.
 */
function describeAcceptanceForAgent(proposal: AssistantProposal): string {
  const path = "docPath" in proposal ? proposal.docPath : undefined;
  const target = path ? ` for \`${path}\`` : "";
  switch (proposal.kind) {
    case "create_document":
      return `(I accepted your proposal to create the document${target}. It's now a draft.)`;
    case "delete_document":
      return `(I accepted your proposal to delete the document${target}.)`;
    case "replace_selection":
      return `(I accepted your proposal to rewrite the selection${target}.)`;
    case "insert_block":
      return `(I accepted your proposal to insert a block${target}.)`;
    case "update_frontmatter":
      return `(I accepted your proposal to update the frontmatter${target}.)`;
  }
}

/**
 * Side-channel text appended after a successful undo. Mirrors
 * `describeAcceptanceForAgent` so the model receives a coherent
 * acceptance → reversal pair in its conversation history and doesn't
 * re-propose the change or reference it as still applied.
 */
function describeUndoForAgent(proposal: AssistantProposal): string {
  const path = "docPath" in proposal ? proposal.docPath : undefined;
  const target = path ? ` for \`${path}\`` : "";
  switch (proposal.kind) {
    case "create_document":
      return `(I undid your proposal to create the document${target}. The draft has been removed.)`;
    case "delete_document":
      return `(I undid your proposal to delete the document${target}. The document has been restored.)`;
    case "replace_selection":
      return `(I undid your proposal to rewrite the selection${target}.)`;
    case "insert_block":
      return `(I undid your proposal to insert a block${target}.)`;
    case "update_frontmatter":
      return `(I undid your proposal to update the frontmatter${target}.)`;
  }
}

function deriveThreadTitle(text: string): string {
  const single = text.trim().replace(/\s+/g, " ");
  if (!single) return NEW_THREAD_TITLE;
  const trimmed = single.slice(0, 60);
  return single.length > 60 ? `${trimmed}…` : trimmed;
}

function makeEmptyThread(now: string, threadId?: string): AssistantThread {
  return {
    id:
      threadId ??
      `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: NEW_THREAD_TITLE,
    updatedAt: now,
    preview: "",
    contextDocs: [],
    messages: [],
    docCount: 0,
  };
}

function buildEmptyAssistantStore(now: string): AssistantStore {
  const thread = makeEmptyThread(now);
  return {
    now,
    activeThreadId: thread.id,
    threads: [thread],
    proposals: {},
    wireProposals: {},
  };
}

function collectProposalDocPaths(p: AssistantProposal): string[] {
  if ("docPath" in p && p.docPath) return [p.docPath];
  return [];
}

function collectMessageDocPaths(message: AssistantMessage): string[] {
  return message.context?.documents.map((doc) => doc.path) ?? [];
}

type DocumentPathLookup = ReadonlyMap<string, string>;
const ACTIVE_DOCUMENT_PATH_LOOKUP_KEY = "__mdcms_active_document_path__";
const UUID_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StudioProposalFromWireOptions = {
  documentPathById?: DocumentPathLookup;
};

function lookupDocumentPath(
  lookup: DocumentPathLookup | undefined,
  documentId: string | undefined,
): string | undefined {
  if (!lookup || !documentId) return undefined;
  return lookup.get(documentId);
}

function sourceDocumentPathForWire(
  wire: StudioAiProposal,
  options?: StudioProposalFromWireOptions,
): string {
  return (
    lookupDocumentPath(options?.documentPathById, wire.documentId) ??
    wire.documentId ??
    ""
  );
}

/**
 * Map a wire-level `StudioAiProposal` (returned by the chat endpoint)
 * into the studio's local `AssistantProposal` discriminated union used
 * by the UI components. The wire schema carries a single-element
 * `operations` array per the SPEC-014 contract; the UI types flatten
 * that into per-kind `op` fields.
 *
 * `delete_document` proposals from the server stamp metadata onto the
 * shared `AiProposal` shape; the studio types model deletion as a
 * top-level kind without the wire's `operations` wrapper. We pick the
 * first operation and shape-shift here so the existing
 * `ProposalCard` router renders without changes.
 */
export function studioProposalFromWire(
  wire: StudioAiProposal,
  options?: StudioProposalFromWireOptions,
): AssistantProposal | undefined {
  const op = wire.operations[0];
  if (!op) return undefined;

  const common = {
    proposalId: wire.proposalId,
    summary: wire.summary,
    validation: wire.validation,
    expiresAt: wire.expiresAt,
    ...(wire.documentId ? { documentId: wire.documentId } : {}),
  };
  const sourceDocumentPath = sourceDocumentPathForWire(wire, options);

  if (wire.kind === "replace_selection" && op.op === "replace_selection") {
    return {
      ...common,
      kind: "replace_selection",
      docPath: sourceDocumentPath,
      type: wire.type,
      locale: wire.locale,
      baseDraftRevision: wire.baseDraftRevision,
      op: {
        op: "replace_selection",
        selectionId: op.selectionId,
        originalText: op.originalText,
        replacementText: op.replacementText,
      },
    };
  }
  if (wire.kind === "insert_block" && op.op === "insert_block") {
    return {
      ...common,
      kind: "insert_block",
      docPath: sourceDocumentPath,
      type: wire.type,
      locale: wire.locale,
      baseDraftRevision: wire.baseDraftRevision,
      op: {
        op: "insert_block",
        ...(op.afterSelectionId
          ? { afterSelectionId: op.afterSelectionId }
          : {}),
        bodyMdx: op.bodyMdx,
      },
    };
  }
  if (wire.kind === "update_frontmatter" && op.op === "update_frontmatter") {
    return {
      ...common,
      kind: "update_frontmatter",
      docPath: sourceDocumentPath,
      type: wire.type,
      locale: wire.locale,
      baseDraftRevision: wire.baseDraftRevision,
      op: {
        op: "update_frontmatter",
        patch: op.patch,
      },
    };
  }
  if (wire.kind === "create_document" && op.op === "create_document") {
    return {
      ...common,
      kind: "create_document",
      docPath: op.path,
      type: wire.type,
      locale: wire.locale,
      op: {
        op: "create_document",
        path: op.path,
        format: op.format,
        frontmatter: op.frontmatter,
        bodyPreview: op.body,
        bodyLines: op.body.split("\n").length,
      },
    };
  }
  if (wire.kind === "delete_document" && op.op === "delete_document") {
    return {
      ...common,
      kind: "delete_document",
      docPath: op.path,
      type: wire.type,
      locale: wire.locale,
      baseDraftRevision: wire.baseDraftRevision,
      op: {
        op: "delete_document",
        path: op.path,
        ...(op.reason ? { reason: op.reason } : {}),
      },
    };
  }
  return undefined;
}

/**
 * Side-channel context for the editor route to publish "which document
 * are we looking at right now" so the assistant rail can resolve the
 * schemaHash + documentId + draftRevision needed by the apply route.
 * The chat surface lives outside the editor route, so we can't read
 * those values directly from the page's local state; the editor sets
 * this via `AssistantActiveDocumentProvider` on mount.
 */
export type AssistantActiveDocument = {
  documentId: string;
  path: string;
  type: string;
  locale: string;
  draftRevision: number;
  schemaHash: string;
  project: string;
  environment: string;
  selection?: {
    selectionId: string;
    /** AI-facing selected span; complete block selections preserve markdown markers. */
    text: string;
  };
};

function addDocumentPath(
  map: Map<string, string>,
  documentId: string | undefined,
  path: string | undefined,
) {
  if (!documentId || !path) return;
  map.set(documentId, path);
}

export function buildAssistantProposalDocumentPathMap(input: {
  activeDocument: AssistantActiveDocument | null;
  thread: AssistantThread;
  userMessage?: AssistantMessage;
}): Map<string, string> {
  const map = new Map<string, string>();
  addDocumentPath(
    map,
    input.activeDocument?.documentId,
    input.activeDocument?.path,
  );
  if (input.activeDocument?.path) {
    map.set(ACTIVE_DOCUMENT_PATH_LOOKUP_KEY, input.activeDocument.path);
  }

  for (const ctx of input.thread.contextDocs) {
    addDocumentPath(map, ctx.documentId, ctx.path);
  }
  if (input.thread.attachedSelection) {
    addDocumentPath(
      map,
      input.thread.attachedSelection.documentId,
      input.thread.attachedSelection.path,
    );
  }
  for (const message of input.thread.messages) {
    for (const doc of message.context?.documents ?? []) {
      addDocumentPath(map, doc.documentId, doc.path);
    }
    addDocumentPath(
      map,
      message.context?.selection?.documentId,
      message.context?.selection?.path,
    );
  }
  for (const doc of input.userMessage?.context?.documents ?? []) {
    addDocumentPath(map, doc.documentId, doc.path);
  }
  addDocumentPath(
    map,
    input.userMessage?.context?.selection?.documentId,
    input.userMessage?.context?.selection?.path,
  );

  return map;
}

export function resolveAssistantProposalDisplayPath(
  proposal: AssistantProposal,
  documentPathById: ReadonlyMap<string, string>,
): AssistantProposal {
  if (!("docPath" in proposal)) return proposal;

  const resolved =
    (proposal.documentId
      ? documentPathById.get(proposal.documentId)
      : undefined) ??
    documentPathById.get(proposal.docPath) ??
    (UUID_DOCUMENT_ID_PATTERN.test(proposal.docPath)
      ? documentPathById.get(ACTIVE_DOCUMENT_PATH_LOOKUP_KEY)
      : undefined);

  if (!resolved || resolved === proposal.docPath) return proposal;
  return { ...proposal, docPath: resolved };
}

const AssistantActiveDocumentContext =
  React.createContext<AssistantActiveDocument | null>(null);

type AssistantActiveDocumentRegistration = (input: {
  token: symbol;
  document: AssistantActiveDocument | null;
}) => void;

const AssistantActiveDocumentRegistrationContext =
  React.createContext<AssistantActiveDocumentRegistration | null>(null);

export function AssistantActiveDocumentProvider({
  value,
  children,
}: {
  value: AssistantActiveDocument | null;
  children: React.ReactNode;
}) {
  const register = React.use(AssistantActiveDocumentRegistrationContext);
  const tokenRef = React.useRef<symbol | null>(null);
  if (!tokenRef.current) {
    tokenRef.current = Symbol("assistant-active-document");
  }

  React.useEffect(() => {
    register?.({ token: tokenRef.current!, document: value });
  }, [register, value]);

  React.useEffect(() => {
    const token = tokenRef.current!;
    return () => {
      register?.({ token, document: null });
    };
  }, [register]);

  return React.createElement(
    AssistantActiveDocumentContext.Provider,
    { value },
    children,
  );
}

export function useAssistantActiveDocument(): AssistantActiveDocument | null {
  return React.use(AssistantActiveDocumentContext);
}

export function buildAssistantChatRequestContext(input: {
  activeDocument: AssistantActiveDocument | null;
  thread: AssistantThread;
}): Pick<
  StudioAiChatMessageRequest,
  "attachedDocumentIds" | "attachedSelection"
> {
  const ids = new Set<string>();
  if (input.activeDocument?.documentId) {
    ids.add(input.activeDocument.documentId);
  }
  for (const ctx of input.thread.contextDocs) {
    if (ctx.documentId) ids.add(ctx.documentId);
  }

  const attachedSelection: StudioAiChatAttachedSelection | undefined = input
    .activeDocument?.selection
    ? {
        documentId: input.activeDocument.documentId,
        draftRevision: input.activeDocument.draftRevision,
        selectionId: input.activeDocument.selection.selectionId,
        text: input.activeDocument.selection.text,
      }
    : undefined;

  return {
    ...(ids.size > 0 ? { attachedDocumentIds: Array.from(ids) } : {}),
    ...(attachedSelection ? { attachedSelection } : {}),
  };
}

export function buildAssistantMessageContextSnapshot(input: {
  activeDocument: AssistantActiveDocument | null;
  thread: AssistantThread;
}): AssistantMessageContextSnapshot {
  const documents: AssistantMessageContextSnapshot["documents"] = [];
  const seenPaths = new Set<string>();

  if (input.activeDocument) {
    documents.push({
      documentId: input.activeDocument.documentId,
      path: input.activeDocument.path,
      type: input.activeDocument.type,
      locale: input.activeDocument.locale,
      source: "current",
    });
    seenPaths.add(input.activeDocument.path);
  }

  for (const ctx of input.thread.contextDocs) {
    if (seenPaths.has(ctx.path)) continue;
    documents.push({
      ...(ctx.documentId ? { documentId: ctx.documentId } : {}),
      path: ctx.path,
      type: ctx.type,
      locale: ctx.locale,
      source: "attached",
    });
    seenPaths.add(ctx.path);
  }

  const selection = input.activeDocument?.selection
    ? {
        documentId: input.activeDocument.documentId,
        path: input.activeDocument.path,
        text: input.activeDocument.selection.text,
        selectionId: input.activeDocument.selection.selectionId,
      }
    : input.thread.attachedSelection
      ? {
          ...(input.thread.attachedSelection.documentId
            ? { documentId: input.thread.attachedSelection.documentId }
            : {}),
          path: input.thread.attachedSelection.path,
          text: input.thread.attachedSelection.text,
          ...(input.thread.attachedSelection.selectionId
            ? { selectionId: input.thread.attachedSelection.selectionId }
            : {}),
        }
      : undefined;

  return {
    documents,
    ...(selection ? { selection } : {}),
  };
}

function reducer(
  state: AssistantState,
  action: AssistantAction,
): AssistantState {
  switch (action.type) {
    case "open-rail":
      return state.mode === "closed" ? { ...state, mode: "rail" } : state;
    case "close":
      return { ...state, mode: "closed" };
    case "toggle-fullscreen":
      if (state.mode === "fullscreen") return { ...state, mode: "rail" };
      if (state.mode === "rail") return { ...state, mode: "fullscreen" };
      return state;
    case "set-mode":
      return { ...state, mode: action.mode };
    case "set-rail-width":
      return { ...state, railWidth: clampAssistantRailWidth(action.width) };
    case "select-thread":
      return { ...state, activeThreadId: action.threadId };
    case "toggle-thread-pin":
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((t) =>
            t.id === action.threadId ? { ...t, pinned: !t.pinned } : t,
          ),
        },
      };
    case "clear-selection-on-active":
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((t) =>
            t.id === state.activeThreadId
              ? { ...t, attachedSelection: undefined }
              : t,
          ),
        },
      };
    case "remove-context-doc":
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((t) =>
            t.id === state.activeThreadId
              ? {
                  ...t,
                  contextDocs: t.contextDocs.filter(
                    (d) => d.path !== action.path,
                  ),
                }
              : t,
          ),
        },
      };
    case "attach-context-doc":
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((t) => {
            if (t.id !== state.activeThreadId) return t;
            if (t.contextDocs.some((d) => d.path === action.doc.path)) {
              return t;
            }
            const nextContextDocs = [...t.contextDocs, action.doc];
            return {
              ...t,
              contextDocs: nextContextDocs,
              docCount: Math.max(t.docCount, nextContextDocs.length),
            };
          }),
        },
      };
    case "send-message": {
      const proposalDelta = Object.fromEntries(
        action.newProposals.map((p) => [p.proposalId, p]),
      );
      return {
        ...state,
        store: {
          ...state.store,
          proposals: { ...state.store.proposals, ...proposalDelta },
          wireProposals: {
            ...state.store.wireProposals,
            ...action.newWireProposals,
          },
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            const docCount = new Set([
              ...thread.contextDocs.map((d) => d.path),
              ...collectMessageDocPaths(action.userMessage),
              ...action.newProposals.flatMap((p) => collectProposalDocPaths(p)),
            ]).size;
            const isFirstUserTurn =
              thread.title === NEW_THREAD_TITLE &&
              !thread.messages.some((m) => m.role === "user") &&
              action.userMessage.role === "user" &&
              !!action.userMessage.text;
            const nextTitle = isFirstUserTurn
              ? deriveThreadTitle(action.userMessage.text ?? "")
              : thread.title;
            const nextPreview = action.userMessage.text?.trim()
              ? action.userMessage.text.trim().slice(0, 120)
              : thread.preview;
            return {
              ...thread,
              title: nextTitle,
              preview: nextPreview,
              docCount: Math.max(thread.docCount, docCount),
              updatedAt: action.assistantMessage.at,
              messages: [
                ...thread.messages,
                action.userMessage,
                action.assistantMessage,
              ],
            };
          }),
        },
      };
    }
    case "begin-stream-turn": {
      // Appends the user message + an empty assistant placeholder. The
      // placeholder is a normal AssistantMessage with text === "" — the
      // bubble renders a typing indicator while text is empty AND the
      // context is in `isPending` state.
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            const docCount = new Set([
              ...thread.contextDocs.map((d) => d.path),
              ...collectMessageDocPaths(action.userMessage),
            ]).size;
            const isFirstUserTurn =
              thread.title === NEW_THREAD_TITLE &&
              !thread.messages.some((m) => m.role === "user") &&
              action.userMessage.role === "user" &&
              !!action.userMessage.text;
            const nextTitle = isFirstUserTurn
              ? deriveThreadTitle(action.userMessage.text ?? "")
              : thread.title;
            const nextPreview = action.userMessage.text?.trim()
              ? action.userMessage.text.trim().slice(0, 120)
              : thread.preview;
            const placeholder: AssistantMessage = {
              id: action.placeholderId,
              role: "assistant",
              at: action.placeholderAt,
              text: "",
            };
            return {
              ...thread,
              title: nextTitle,
              preview: nextPreview,
              docCount: Math.max(thread.docCount, docCount),
              updatedAt: action.placeholderAt,
              messages: [...thread.messages, action.userMessage, placeholder],
            };
          }),
        },
      };
    }
    case "append-stream-delta": {
      // O(n) per delta — the messages array is short (≤20 turns in
      // practice), so we accept the cost for the simplicity of a flat
      // map over messages.
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              messages: thread.messages.map((m) =>
                m.id === action.placeholderId
                  ? { ...m, text: (m.text ?? "") + action.delta }
                  : m,
              ),
            };
          }),
        },
      };
    }
    case "append-stream-progress": {
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              messages: thread.messages.map((m) =>
                m.id === action.placeholderId
                  ? {
                      ...m,
                      progress: [...(m.progress ?? []), action.progress].slice(
                        -8,
                      ),
                    }
                  : m,
              ),
            };
          }),
        },
      };
    }
    case "commit-stream-turn": {
      // Replace the placeholder with the final message and merge in
      // the proposal map updates the JSON handler used to atomically
      // deliver via send-message.
      const proposalDelta = Object.fromEntries(
        action.newProposals.map((p) => [p.proposalId, p]),
      );
      return {
        ...state,
        store: {
          ...state.store,
          proposals: { ...state.store.proposals, ...proposalDelta },
          wireProposals: {
            ...state.store.wireProposals,
            ...action.newWireProposals,
          },
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            const docCount = new Set([
              ...thread.contextDocs.map((d) => d.path),
              ...action.newProposals.flatMap((p) => collectProposalDocPaths(p)),
            ]).size;
            return {
              ...thread,
              docCount: Math.max(thread.docCount, docCount),
              updatedAt: action.finalMessage.at,
              messages: thread.messages.map((m) =>
                m.id === action.placeholderId ? action.finalMessage : m,
              ),
            };
          }),
        },
      };
    }
    case "abort-stream-turn": {
      // The placeholder becomes an error turn carrying the wire-level
      // code in its text so the UI renders it the same way a
      // non-streaming failure would.
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              messages: thread.messages.map((m) =>
                m.id === action.placeholderId
                  ? { ...m, text: action.errorText }
                  : m,
              ),
            };
          }),
        },
      };
    }
    case "create-thread": {
      return {
        ...state,
        activeThreadId: action.thread.id,
        store: {
          ...state.store,
          activeThreadId: action.thread.id,
          threads: [action.thread, ...state.store.threads],
        },
      };
    }
    case "delete-thread": {
      const remaining = state.store.threads.filter(
        (t) => t.id !== action.threadId,
      );
      const proposalIdsToKeep = new Set(
        remaining.flatMap((t) => t.messages.flatMap((m) => m.proposals ?? [])),
      );
      const proposals = Object.fromEntries(
        Object.entries(state.store.proposals).filter(([pid]) =>
          proposalIdsToKeep.has(pid),
        ),
      );
      const wireProposals = Object.fromEntries(
        Object.entries(state.store.wireProposals).filter(([pid]) =>
          proposalIdsToKeep.has(pid),
        ),
      );
      const ensured =
        remaining.length === 0
          ? [makeEmptyThread(new Date().toISOString())]
          : remaining;
      const nextActive =
        state.activeThreadId === action.threadId
          ? (ensured[0]?.id ?? state.activeThreadId)
          : state.activeThreadId;
      return {
        ...state,
        activeThreadId: nextActive,
        store: {
          ...state.store,
          activeThreadId: nextActive,
          threads: ensured,
          proposals,
          wireProposals,
        },
      };
    }
    case "hydrate": {
      return {
        ...state,
        store: action.store,
        activeThreadId: action.store.activeThreadId,
      };
    }
    case "remove-proposal":
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) =>
            thread.id === action.threadId
              ? {
                  ...thread,
                  messages: thread.messages.map((m) => {
                    if (!m.proposals?.includes(action.proposalId)) return m;
                    return {
                      ...m,
                      proposals: m.proposals.filter(
                        (id) => id !== action.proposalId,
                      ),
                    };
                  }),
                }
              : thread,
          ),
        },
      };
    case "mark-proposal-accepted": {
      // Stamp `acceptedAt` (plus the per-kind undo metadata) on the
      // proposal record so the bubble renders a past-tense log line in
      // place of the full card, and append the hidden side-channel turn
      // so the next conversationHistory send carries the acceptance
      // signal. The undo metadata is what the post-accept undo handler
      // reads to call the server with the right per-kind payload.
      const existing = state.store.proposals[action.proposalId];
      const updatedProposals = existing
        ? {
            ...state.store.proposals,
            [action.proposalId]: {
              ...existing,
              acceptedAt: action.acceptedAt,
              ...(action.acceptedDocumentId !== undefined
                ? { acceptedDocumentId: action.acceptedDocumentId }
                : {}),
              ...(action.priorDraft !== undefined
                ? { priorDraft: action.priorDraft }
                : {}),
              ...(action.postApplyDraftRevision !== undefined
                ? { postApplyDraftRevision: action.postApplyDraftRevision }
                : {}),
            },
          }
        : state.store.proposals;
      return {
        ...state,
        store: {
          ...state.store,
          proposals: updatedProposals,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              updatedAt: action.acceptedAt,
              messages: [...thread.messages, action.hiddenMessage],
            };
          }),
        },
      };
    }
    case "mark-proposal-undone": {
      // Strip the proposal from its host message so the banner / log
      // line disappears, append the hidden undo signal turn, and drop
      // the proposal record + its wire-shape companion. The undo only
      // succeeds while the window is open, so anything still keyed to
      // this proposal in localStorage is now stale.
      const { [action.proposalId]: _droppedProposal, ...remainingProposals } =
        state.store.proposals;
      const { [action.proposalId]: _droppedWire, ...remainingWireProposals } =
        state.store.wireProposals;
      return {
        ...state,
        store: {
          ...state.store,
          proposals: remainingProposals,
          wireProposals: remainingWireProposals,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              updatedAt: action.undoneAt,
              messages: [
                ...thread.messages.map((m) => {
                  if (!m.proposals?.includes(action.proposalId)) return m;
                  return {
                    ...m,
                    proposals: m.proposals.filter(
                      (id) => id !== action.proposalId,
                    ),
                  };
                }),
                action.hiddenMessage,
              ],
            };
          }),
        },
      };
    }
    case "reject-proposal": {
      // Reject only strips the proposal from its host message. The
      // follow-up user turn (with rejectionFeedback + rejectedProposalId)
      // and the regenerated assistant turn are both appended by the
      // `runChatRequest` flow via `send-message` — keeping that owner
      // single avoids the duplicate-user-turn bug where reducer +
      // chat success both pushed the same feedback message.
      return {
        ...state,
        store: {
          ...state.store,
          threads: state.store.threads.map((thread) => {
            if (thread.id !== action.threadId) return thread;
            return {
              ...thread,
              messages: thread.messages.map((m) => {
                if (!m.proposals?.includes(action.proposalId)) return m;
                return {
                  ...m,
                  proposals: m.proposals.filter(
                    (id) => id !== action.proposalId,
                  ),
                };
              }),
            };
          }),
        },
      };
    }
    default:
      return state;
  }
}

export type AssistantContextValue = {
  store: AssistantStore;
  mode: RailMode;
  isOpen: boolean;
  isFullscreen: boolean;
  /** Current docked assistant rail width in pixels. */
  railWidth: number;
  /** Resize the docked assistant rail; ignored by fullscreen rendering. */
  setRailWidth: (width: number) => void;
  /**
   * True while a chat turn is in flight (network request hasn't resolved
   * yet). The composer keeps accepting draft text while this is true, but
   * flips its Send affordance to Stop so the user can abort instead of
   * starting an overlapping turn.
   */
  isPending: boolean;
  activeThread: AssistantThread;
  openRail: () => void;
  close: () => void;
  toggleFullscreen: () => void;
  setMode: (mode: RailMode) => void;
  selectThread: (threadId: string) => void;
  /** Toggle the `pinned` flag on a thread (used by the More menu). */
  toggleThreadPin: (threadId: string) => void;
  clearActiveSelection: () => void;
  removeContextDoc: (path: string) => void;
  acceptProposal: (proposal: AssistantProposal) => void;
  rejectProposal: (proposal: AssistantProposal, feedback: string) => void;
  /**
   * Reverse a previously accepted proposal inside the 6-second
   * post-accept undo window. Calls the server's undo endpoint with the
   * per-kind payload captured on `acceptProposal`, dispatches the
   * `mark-proposal-undone` reducer action, and emits a hidden
   * side-channel turn so the agent's conversation history reflects
   * the reversal.
   *
   * Returns a promise that resolves on success and rejects with the
   * underlying error on failure. Failure does NOT append a chat error
   * turn — SPEC-014 §Post-Accept Undo Window requires the banner to
   * keep itself mounted and surface the inline error.
   */
  undoProposal: (proposal: AssistantProposal) => Promise<void>;
  /**
   * Submit a composer message. Appends a user turn, then calls the chat
   * endpoint via the injected `StudioAiRouteApi` and appends the assistant
   * turn + proposals on success (or an inline error turn on failure).
   */
  sendMessage: (text: string) => void;
  /**
   * Abort an in-flight chat turn. No-op when nothing is pending. The
   * server may still record the request, but the client drops the
   * response and surfaces nothing further on the timeline.
   */
  cancelPending: () => void;
  /** Add a document to the active thread's context (used by @-mention). */
  attachContextDoc: (doc: AssistantContextDoc) => void;
  /** Create a new empty thread and select it as active. */
  createThread: () => void;
  /** Remove a thread + its dangling proposals from the store. */
  deleteThread: (threadId: string) => void;
};

/**
 * Marker selector applied to the assistant composer textarea so the
 * global ⌘K handler can keep listening even when focus is inside the
 * composer (the user typically wants ⌘K to dismiss the rail). Any other
 * input/textarea/contenteditable element should be left alone.
 */
export const ASSISTANT_COMPOSER_DATA_ATTR = "data-assistant-composer";

/**
 * Headless fallback returned when `useAssistant()` is called outside of an
 * `AssistantProvider`. The launcher embeds inside the page header, which
 * is rendered by unit tests in isolation; we don't want those tests to
 * have to wrap every page in a provider just because the topbar exposes
 * the launcher. The fallback intentionally exposes an empty store and
 * no-op handlers — the launcher is invisible in that mode.
 */
const FALLBACK_STORE: AssistantStore = {
  now: new Date(0).toISOString(),
  activeThreadId: "fallback",
  threads: [],
  proposals: {},
  wireProposals: {},
};

const FALLBACK_THREAD: AssistantThread = {
  id: "fallback",
  title: "AI assistant",
  updatedAt: new Date(0).toISOString(),
  preview: "",
  contextDocs: [],
  messages: [],
  docCount: 0,
};

const FALLBACK_VALUE: AssistantContextValue = {
  store: FALLBACK_STORE,
  mode: "closed",
  isOpen: false,
  isFullscreen: false,
  railWidth: ASSISTANT_RAIL_DEFAULT_WIDTH,
  setRailWidth: () => {},
  activeThread: FALLBACK_THREAD,
  openRail: () => {},
  close: () => {},
  toggleFullscreen: () => {},
  setMode: () => {},
  selectThread: () => {},
  toggleThreadPin: () => {},
  clearActiveSelection: () => {},
  removeContextDoc: () => {},
  acceptProposal: () => {},
  rejectProposal: () => {},
  undoProposal: async () => {},
  sendMessage: () => {},
  cancelPending: () => {},
  isPending: false,
  attachContextDoc: () => {},
  createThread: () => {},
  deleteThread: () => {},
};

const AssistantContext =
  React.createContext<AssistantContextValue>(FALLBACK_VALUE);

/**
 * Dedicated boolean context that flips to `true` only when an
 * `AssistantProvider` is mounted above the consumer. The launcher reads
 * this to hide itself outside the provider — and unlike comparing the
 * value context against the FALLBACK_VALUE singleton, this is robust to
 * the value object being spread or replaced.
 */
const AssistantMountedContext = React.createContext<boolean>(false);

export type AssistantProviderProps = {
  children: React.ReactNode;
  /** Optional override for tests / Storybook-style harnesses. */
  initialStore?: AssistantStore;
  /** Initial visibility — defaults to closed. */
  initialMode?: RailMode;
  /** Initial docked rail width in px. Defaults to 420. */
  initialRailWidth?: number;
  /** Optional pending-state override for tests / Storybook-style harnesses. */
  initialPending?: boolean;
  /**
   * Studio AI route client. When provided, sendMessage / acceptProposal /
   * rejectProposal call the real `/api/v1/ai/*` endpoints. When omitted
   * (Storybook / unit-test paths) the provider exposes no-op handlers
   * and surfaces an inline "no api configured" error from sendMessage.
   */
  api?: StudioAiRouteApi;
  /**
   * Fetch the active project's schemaHash. Required for the apply route,
   * which validates that the client's view of the schema matches the
   * server's. Used as a fallback when no document is open in the editor
   * (e.g. applying a `create_document` proposal from the standalone
   * assistant page) — open-editor flows use `useAssistantActiveDocument`
   * which already carries schemaHash. The provider caches the result for
   * the session lifetime.
   */
  schemaHashFetcher?: () => Promise<string | null>;
  /**
   * Active host-supplied MDX component catalog. Sent with chat turns so
   * the server can validate generated MDX proposals against the same
   * component set the embedded Studio can render locally.
   */
  mdxCatalog?: MdxComponentCatalog;
  /**
   * Produces host-rendered component references for model grounding.
   * The AI server exposes these through `get_component_reference` so
   * the model can follow existing component aesthetics without seeing
   * host source code.
   */
  componentReferenceProvider?: () => Promise<AiComponentReference[]>;
  /**
   * localStorage key for persisting the thread store across reloads.
   * When omitted, persistence is disabled (tests / storybook). The admin
   * layout passes a key scoped to `<project>:<environment>` so projects
   * don't bleed conversations between each other.
   */
  storageKey?: string;
};

// v2 adds the `wireProposals` map needed by the chat surface to round-
// trip proposals back to the apply/reject routes without depending on
// the server's in-memory proposal store. v1 data is discarded on load.
const STORAGE_VERSION = 2;

function loadStoreFromStorage(key: string): AssistantStore | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      v?: number;
      store?: AssistantStore;
    };
    if (parsed.v !== STORAGE_VERSION || !parsed.store) return undefined;
    const store = parsed.store;
    if (
      !Array.isArray(store.threads) ||
      typeof store.activeThreadId !== "string" ||
      typeof store.now !== "string" ||
      !store.proposals ||
      typeof store.proposals !== "object" ||
      !store.wireProposals ||
      typeof store.wireProposals !== "object"
    ) {
      return undefined;
    }
    return store;
  } catch {
    return undefined;
  }
}

function loadRailWidthFromStorage(key: string): number | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      railWidth?: unknown;
    };
    return typeof parsed.railWidth === "number"
      ? clampAssistantRailWidth(parsed.railWidth)
      : undefined;
  } catch {
    return undefined;
  }
}

function loadModeFromStorage(key: string): RailMode | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { mode?: unknown };
    return parsed.mode === "closed" ||
      parsed.mode === "rail" ||
      parsed.mode === "fullscreen"
      ? parsed.mode
      : undefined;
  } catch {
    return undefined;
  }
}

function saveStoreToStorage(
  key: string,
  store: AssistantStore,
  railWidth: number,
  mode: RailMode,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        v: STORAGE_VERSION,
        store,
        railWidth: clampAssistantRailWidth(railWidth),
        mode,
      }),
    );
  } catch {
    // Quota exceeded / private mode — swallow; persistence is best-effort.
  }
}

function useAssistantProviderModel({
  initialStore,
  initialMode,
  initialRailWidth,
  initialPending = false,
  api,
  schemaHashFetcher,
  mdxCatalog,
  componentReferenceProvider,
  storageKey,
}: Omit<AssistantProviderProps, "children">) {
  const [state, dispatch] = React.useReducer(reducer, undefined, () => {
    const persisted = storageKey ? loadStoreFromStorage(storageKey) : undefined;
    const persistedRailWidth = storageKey
      ? loadRailWidthFromStorage(storageKey)
      : undefined;
    const persistedMode = storageKey
      ? loadModeFromStorage(storageKey)
      : undefined;
    const store =
      initialStore ??
      persisted ??
      buildEmptyAssistantStore(new Date().toISOString());
    return {
      store,
      mode: initialMode ?? persistedMode ?? "closed",
      activeThreadId: store.activeThreadId,
      railWidth: clampAssistantRailWidth(
        initialRailWidth ?? persistedRailWidth ?? ASSISTANT_RAIL_DEFAULT_WIDTH,
      ),
    };
  });
  const [registeredActiveDocument, setRegisteredActiveDocument] =
    React.useState<AssistantActiveDocument | null>(null);
  const registeredActiveDocumentTokenRef = React.useRef<symbol | null>(null);
  const registerActiveDocument =
    React.useCallback<AssistantActiveDocumentRegistration>((input) => {
      if (input.document) {
        registeredActiveDocumentTokenRef.current = input.token;
        setRegisteredActiveDocument(input.document);
        return;
      }
      if (registeredActiveDocumentTokenRef.current !== input.token) return;
      registeredActiveDocumentTokenRef.current = null;
      setRegisteredActiveDocument(null);
    }, []);

  const activeThread =
    state.store.threads.find((t) => t.id === state.activeThreadId) ??
    state.store.threads[0] ??
    FALLBACK_THREAD;

  // Keep the latest active-doc, thread, and api in refs so the async
  // handlers always read the current value rather than what was bound
  // when sendMessage / acceptProposal closed over.
  const apiRef = React.useRef(api);
  React.useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const activeDocumentRef = React.useRef(registeredActiveDocument);
  React.useEffect(() => {
    activeDocumentRef.current = registeredActiveDocument;
  }, [registeredActiveDocument]);
  const activeThreadRef = React.useRef(activeThread);
  React.useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  // Cache the project schemaHash for the session — apply needs it, but
  // we don't want a refetch on every accept click. The fetcher is built
  // once by the admin layout from the schema route API.
  const schemaHashFetcherRef = React.useRef(schemaHashFetcher);
  React.useEffect(() => {
    schemaHashFetcherRef.current = schemaHashFetcher;
  }, [schemaHashFetcher]);
  const cachedSchemaHashRef = React.useRef<string | null>(null);
  const inflightSchemaHashRef = React.useRef<Promise<string | null> | null>(
    null,
  );
  const resolveSchemaHash = React.useCallback(async (): Promise<
    string | null
  > => {
    const liveDoc = activeDocumentRef.current;
    if (liveDoc?.schemaHash) return liveDoc.schemaHash;
    if (cachedSchemaHashRef.current) return cachedSchemaHashRef.current;
    const fetcher = schemaHashFetcherRef.current;
    if (!fetcher) return null;
    if (!inflightSchemaHashRef.current) {
      inflightSchemaHashRef.current = (async () => {
        try {
          const value = await fetcher();
          cachedSchemaHashRef.current = value;
          return value;
        } finally {
          inflightSchemaHashRef.current = null;
        }
      })();
    }
    return inflightSchemaHashRef.current;
  }, []);

  // Append an error turn rendered as a plain assistant text message
  // carrying the wire-level error code so the UI can show it inline.
  const appendErrorTurn = React.useCallback(
    (userMessage: AssistantMessage, error: unknown) => {
      const code =
        error instanceof RuntimeError ? error.code : "AI_REQUEST_FAILED";
      const message =
        error instanceof Error ? error.message : "AI request failed.";
      // Server 500s collapse to `code: "INTERNAL_ERROR", message:
      // "Internal server error."` with the actual exception text under
      // `details.payload.details.reason`. Surface that reason so the
      // user sees something more useful than the generic placeholder.
      const reason = extractInnerReason(error);
      const text =
        reason && message === "Internal server error."
          ? `${code}: ${reason}`
          : `${code}: ${message}`;
      const assistantMessage: AssistantMessage = {
        id: `m-err-${Date.now().toString(36)}`,
        role: "assistant",
        at: new Date().toISOString(),
        text,
      };
      dispatch({
        type: "send-message",
        threadId: state.activeThreadId,
        userMessage,
        assistantMessage,
        newProposals: [],
        newWireProposals: {},
      });
    },
    [state.activeThreadId],
  );

  // Tracks the AbortController for the currently in-flight chat turn so
  // the composer's Stop affordance can cancel it. Held in a ref (not
  // state) so we don't re-render the provider tree on every flip; the
  // user-facing `isPending` boolean below is the rendered projection.
  const pendingControllerRef = React.useRef<AbortController | null>(null);
  const [isPending, setIsPending] = React.useState(initialPending);

  const cancelPending = React.useCallback(() => {
    const ctrl = pendingControllerRef.current;
    if (!ctrl) {
      setIsPending(false);
      return;
    }
    pendingControllerRef.current = null;
    setIsPending(false);
    ctrl.abort();
  }, []);

  const runChatRequest = React.useCallback(
    async (input: {
      userMessage: AssistantMessage;
      message: string;
      conversationId?: string;
      rejectedProposalId?: string;
      rejectedProposal?: StudioAiProposal;
      rejectionFeedback?: string;
    }) => {
      const liveApi = apiRef.current;
      const liveDoc = activeDocumentRef.current;
      const liveThread = activeThreadRef.current;

      if (!liveApi) {
        appendErrorTurn(
          input.userMessage,
          new RuntimeError({
            code: "AI_CHAT_UNAVAILABLE",
            message:
              "The AI chat endpoint is not configured for this Studio mount.",
            statusCode: 503,
          }),
        );
        return;
      }

      const requestContext = buildAssistantChatRequestContext({
        activeDocument: liveDoc,
        thread: liveThread,
      });
      const proposalDocumentPathMap = buildAssistantProposalDocumentPathMap({
        activeDocument: liveDoc,
        thread: liveThread,
        userMessage: input.userMessage,
      });

      // If a previous turn is still in flight (the user clicked Send twice
      // in quick succession), abort it before preparing expensive request
      // context so we never overlap two streaming requests.
      pendingControllerRef.current?.abort();
      const controller = new AbortController();
      pendingControllerRef.current = controller;
      setIsPending(true);

      // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await guard rejects stale component-reference work if this request was aborted.
      const componentReferences = componentReferenceProvider
        ? await componentReferenceProvider().catch(() => [])
        : [];

      if (
        controller.signal.aborted ||
        pendingControllerRef.current !== controller
      ) {
        return;
      }

      // Build a rolling window of prior conversation turns so the server
      // can resolve anaphora across the thread. Skip empty assistant
      // turns (proposal-only with no text) since they carry no signal
      // the model can resolve against without seeing the proposal body.
      const conversationHistory = liveThread.messages
        .flatMap((m) => {
          const text = m.text?.trim();
          if (!text) return [];
          return [{ role: m.role, text }];
        })
        .slice(-10);

      const request: StudioAiChatMessageRequest = {
        message: input.message,
        signal: controller.signal,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        ...requestContext,
        ...(mdxCatalog ? { mdxCatalog } : {}),
        ...(componentReferences.length > 0 ? { componentReferences } : {}),
        ...(input.rejectedProposalId
          ? { rejectedProposalId: input.rejectedProposalId }
          : {}),
        ...(input.rejectedProposal
          ? { rejectedProposal: input.rejectedProposal }
          : {}),
        ...(input.rejectionFeedback
          ? { rejectionFeedback: input.rejectionFeedback }
          : {}),
        ...(conversationHistory.length > 0 ? { conversationHistory } : {}),
      };

      const placeholderId = `m-asst-stream-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const placeholderAt = new Date().toISOString();
      dispatch({
        type: "begin-stream-turn",
        threadId: state.activeThreadId,
        userMessage: input.userMessage,
        placeholderId,
        placeholderAt,
      });

      let sawDone = false;
      try {
        for await (const event of liveApi.chatMessageStream(request)) {
          if (controller.signal.aborted) return;
          if (event.type === "progress") {
            const { type: _type, ...progress } = event;
            dispatch({
              type: "append-stream-progress",
              threadId: state.activeThreadId,
              placeholderId,
              progress,
            });
          } else if (event.type === "text-delta") {
            dispatch({
              type: "append-stream-delta",
              threadId: state.activeThreadId,
              placeholderId,
              delta: event.text,
            });
          } else if (event.type === "done") {
            sawDone = true;
            const wireProposals = event.proposals ?? [];
            const newProposals: AssistantProposal[] = [];
            const newWireProposals: Record<string, StudioAiProposal> = {};
            for (const wp of wireProposals) {
              const mapped = studioProposalFromWire(wp, {
                documentPathById: proposalDocumentPathMap,
              });
              if (mapped) {
                newProposals.push(mapped);
                newWireProposals[wp.proposalId] = wp;
              }
            }
            const finalMessage: AssistantMessage = {
              id: event.message.id,
              role: "assistant",
              at: event.message.at,
              ...(event.message.text ? { text: event.message.text } : {}),
              ...(newProposals.length > 0
                ? { proposals: newProposals.map((p) => p.proposalId) }
                : {}),
              ...(event.message.rejectedProposalId
                ? { rejectedProposalId: event.message.rejectedProposalId }
                : {}),
            };
            dispatch({
              type: "commit-stream-turn",
              threadId: state.activeThreadId,
              placeholderId,
              finalMessage,
              newProposals,
              newWireProposals,
            });
          } else if (event.type === "error") {
            // Replace the placeholder with an inline error turn so the
            // user gets the same surface as a non-streaming failure.
            sawDone = true;
            dispatch({
              type: "abort-stream-turn",
              threadId: state.activeThreadId,
              placeholderId,
              errorText: `${event.code}: ${event.message}`,
            });
          }
        }
        if (!sawDone && !controller.signal.aborted) {
          // The stream closed without a terminal event — treat as an
          // unexpected truncation and surface a placeholder error so
          // the user isn't stuck with a frozen typing indicator.
          dispatch({
            type: "abort-stream-turn",
            threadId: state.activeThreadId,
            placeholderId,
            errorText: "AI_REQUEST_FAILED: stream closed without response.",
          });
        }
      } catch (error) {
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        if (isAbort) {
          // The user clicked Stop or sent again — drop the placeholder
          // by replacing its text with an empty (non-rendered) state.
          // The reducer keeps the placeholder in messages; the bubble
          // will simply not render an empty message that's no longer
          // pending. (See AssistantBubble early-return.)
          dispatch({
            type: "abort-stream-turn",
            threadId: state.activeThreadId,
            placeholderId,
            errorText: "",
          });
        } else {
          const code =
            error instanceof RuntimeError ? error.code : "AI_REQUEST_FAILED";
          const message =
            error instanceof Error ? error.message : "AI request failed.";
          const reason = extractInnerReason(error);
          const text =
            reason && message === "Internal server error."
              ? `${code}: ${reason}`
              : `${code}: ${message}`;
          dispatch({
            type: "abort-stream-turn",
            threadId: state.activeThreadId,
            placeholderId,
            errorText: text,
          });
        }
      } finally {
        // Clear pending state only if this controller is still the
        // active one — a fresh sendMessage call may have already
        // installed a new controller while we were awaiting, in which
        // case the new turn owns the spinner.
        if (pendingControllerRef.current === controller) {
          pendingControllerRef.current = null;
          setIsPending(false);
        }
      }
    },
    [
      appendErrorTurn,
      componentReferenceProvider,
      mdxCatalog,
      state.activeThreadId,
    ],
  );

  const value = React.useMemo<AssistantContextValue>(
    () => ({
      store: state.store,
      mode: state.mode,
      isOpen: state.mode !== "closed",
      isFullscreen: state.mode === "fullscreen",
      railWidth: state.railWidth,
      setRailWidth: (width) => dispatch({ type: "set-rail-width", width }),
      isPending,
      cancelPending,
      activeThread,
      openRail: () => dispatch({ type: "open-rail" }),
      close: () => dispatch({ type: "close" }),
      toggleFullscreen: () => dispatch({ type: "toggle-fullscreen" }),
      setMode: (mode) => dispatch({ type: "set-mode", mode }),
      selectThread: (threadId) => dispatch({ type: "select-thread", threadId }),
      toggleThreadPin: (threadId) =>
        dispatch({ type: "toggle-thread-pin", threadId }),
      clearActiveSelection: () =>
        dispatch({ type: "clear-selection-on-active" }),
      removeContextDoc: (path) =>
        dispatch({ type: "remove-context-doc", path }),
      acceptProposal: (proposal) => {
        void (async () => {
          const liveApi = apiRef.current;
          const placeholderUser: AssistantMessage = {
            id: `m-accept-${Date.now().toString(36)}`,
            role: "user",
            at: new Date().toISOString(),
            text: `Accept ${proposal.proposalId}`,
          };
          if (!liveApi) {
            appendErrorTurn(
              placeholderUser,
              new RuntimeError({
                code: "AI_APPLY_UNAVAILABLE",
                message:
                  "AI route is not configured for this Studio mount — apply is disabled.",
                statusCode: 503,
              }),
            );
            return;
          }
          const schemaHash = await resolveSchemaHash();
          if (!schemaHash) {
            // schemaHash is project-scoped — needed for every apply,
            // including create_document. We only end up here when both
            // the editor context (`useAssistantActiveDocument`) and the
            // schemaHashFetcher prop are missing, which is unexpected
            // in admin layout but possible in tests/storybook.
            appendErrorTurn(
              placeholderUser,
              new RuntimeError({
                code: "SCHEMA_HASH_UNAVAILABLE",
                message:
                  "Studio could not resolve the project schemaHash needed to apply this proposal.",
                statusCode: 503,
              }),
            );
            return;
          }
          // Send the wire-shape proposal body so the server doesn't
          // need to look it up in its in-memory store — chat proposals
          // live entirely client-side.
          const wireProposal = state.store.wireProposals[
            proposal.proposalId
          ] as StudioAiProposal | undefined;
          try {
            const applyResult = await liveApi.applyProposal({
              proposalId: proposal.proposalId,
              draftRevision:
                "baseDraftRevision" in proposal
                  ? proposal.baseDraftRevision
                  : undefined,
              schemaHash,
              ...(wireProposal ? { proposal: wireProposal } : {}),
            });
            emitAssistantProposalApplied({
              documentId: applyResult.document.documentId,
              body: applyResult.document.body,
              frontmatter: applyResult.document.frontmatter,
              draftRevision: applyResult.document.draftRevision,
              updatedAt: applyResult.document.updatedAt,
            });
            const acceptedAt = new Date().toISOString();
            // Hidden side-channel turn — the model needs to know the
            // user accepted the proposal so it doesn't suggest the
            // same change again and so its next reply can reference
            // what landed. The UI filters `hidden: true` messages
            // out of the timeline; the conversation-history
            // serializer keeps them so the agent still sees the
            // signal.
            const acceptanceSignal = describeAcceptanceForAgent(proposal);
            const hiddenMessage: AssistantMessage = {
              id: `m-accept-signal-${Date.now().toString(36)}`,
              role: "user",
              at: acceptedAt,
              text: acceptanceSignal,
              hidden: true,
            };
            dispatch({
              type: "mark-proposal-accepted",
              threadId: state.activeThreadId,
              proposalId: proposal.proposalId,
              acceptedAt,
              hiddenMessage,
              // Capture the per-kind undo metadata returned by the
              // apply call so the AppliedBanner's Undo button can
              // call the server with the right payload during the
              // 6-second window.
              ...(applyResult.document?.documentId
                ? { acceptedDocumentId: applyResult.document.documentId }
                : {}),
              ...(applyResult.priorDraft
                ? { priorDraft: applyResult.priorDraft }
                : {}),
              ...(typeof applyResult.document?.draftRevision === "number"
                ? {
                    postApplyDraftRevision: applyResult.document.draftRevision,
                  }
                : {}),
            });
          } catch (error) {
            appendErrorTurn(placeholderUser, error);
          }
        })();
      },
      undoProposal: async (proposal) => {
        // Failures here propagate to the caller so the AppliedBanner
        // can stay mounted and render an inline error — SPEC-014
        // says undo errors do NOT become chat error turns.
        const liveApi = apiRef.current;
        if (!proposal.acceptedAt || !proposal.acceptedDocumentId) {
          throw new RuntimeError({
            code: "AI_UNDO_UNAVAILABLE",
            message: "Undo is not available for this proposal.",
            statusCode: 400,
          });
        }
        if (!liveApi) {
          throw new RuntimeError({
            code: "AI_UNDO_UNAVAILABLE",
            message:
              "AI route is not configured for this Studio mount — undo is disabled.",
            statusCode: 503,
          });
        }
        const schemaHash = await resolveSchemaHash();
        if (!schemaHash) {
          throw new RuntimeError({
            code: "SCHEMA_HASH_UNAVAILABLE",
            message:
              "Studio could not resolve the project schemaHash needed to undo this proposal.",
            statusCode: 503,
          });
        }
        const wireProposal = state.store.wireProposals[proposal.proposalId] as
          | StudioAiProposal
          | undefined;
        if (!wireProposal) {
          throw new RuntimeError({
            code: "AI_UNDO_UNAVAILABLE",
            message:
              "Studio cannot find the original proposal body needed for undo.",
            statusCode: 400,
          });
        }
        await liveApi.undoProposal({
          proposalId: proposal.proposalId,
          proposal: wireProposal,
          documentId: proposal.acceptedDocumentId,
          schemaHash,
          ...(proposal.priorDraft ? { priorDraft: proposal.priorDraft } : {}),
          ...(typeof proposal.postApplyDraftRevision === "number"
            ? { postApplyDraftRevision: proposal.postApplyDraftRevision }
            : {}),
        });
        const undoneAt = new Date().toISOString();
        const undoSignal = describeUndoForAgent(proposal);
        const hiddenMessage: AssistantMessage = {
          id: `m-undo-signal-${Date.now().toString(36)}`,
          role: "user",
          at: undoneAt,
          text: undoSignal,
          hidden: true,
        };
        dispatch({
          type: "mark-proposal-undone",
          threadId: state.activeThreadId,
          proposalId: proposal.proposalId,
          undoneAt,
          hiddenMessage,
        });
      },
      rejectProposal: (proposal, feedback) => {
        void (async () => {
          const liveApi = apiRef.current;
          const trimmed = feedback.trim();
          const wireProposal = state.store.wireProposals[
            proposal.proposalId
          ] as StudioAiProposal | undefined;
          try {
            if (liveApi) {
              await liveApi.rejectProposal({
                proposalId: proposal.proposalId,
                ...(wireProposal ? { proposal: wireProposal } : {}),
              });
            }
            dispatch({
              type: "reject-proposal",
              threadId: state.activeThreadId,
              proposalId: proposal.proposalId,
              feedback,
            });
            // If the user supplied feedback, immediately request a
            // regenerated proposal via the chat endpoint with the
            // rejected proposal id forwarded.
            if (trimmed && liveApi) {
              const userMessage: AssistantMessage = {
                id: `m-${Date.now().toString(36)}`,
                role: "user",
                at: new Date().toISOString(),
                text: trimmed,
                rejectedProposalId: proposal.proposalId,
              };
              await runChatRequest({
                userMessage,
                message: trimmed,
                conversationId: activeThreadRef.current.id,
                rejectedProposalId: proposal.proposalId,
                ...(wireProposal ? { rejectedProposal: wireProposal } : {}),
                rejectionFeedback: trimmed,
              });
            }
          } catch (error) {
            const placeholderUser: AssistantMessage = {
              id: `m-reject-${Date.now().toString(36)}`,
              role: "user",
              at: new Date().toISOString(),
              text: trimmed || `Reject ${proposal.proposalId}`,
              ...(trimmed ? { rejectedProposalId: proposal.proposalId } : {}),
            };
            appendErrorTurn(placeholderUser, error);
          }
        })();
      },
      sendMessage: (text) => {
        if (isPending) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const context = buildAssistantMessageContextSnapshot({
          activeDocument: activeDocumentRef.current,
          thread: activeThreadRef.current,
        });
        const userMessage: AssistantMessage = {
          id: `m-${Date.now().toString(36)}`,
          role: "user",
          at: new Date().toISOString(),
          text: trimmed,
          ...(context.documents.length > 0 || context.selection
            ? { context }
            : {}),
        };
        void runChatRequest({
          userMessage,
          message: trimmed,
          conversationId: activeThread.id,
        });
      },
      attachContextDoc: (doc) => dispatch({ type: "attach-context-doc", doc }),
      createThread: () => {
        const thread = makeEmptyThread(new Date().toISOString());
        dispatch({ type: "create-thread", thread });
      },
      deleteThread: (threadId) => {
        dispatch({ type: "delete-thread", threadId });
      },
    }),
    [
      state,
      activeThread,
      appendErrorTurn,
      runChatRequest,
      resolveSchemaHash,
      isPending,
      cancelPending,
    ],
  );

  // Persist the store to localStorage whenever it changes — best-effort.
  // The activeThreadId from the reducer (top-level) wins so we don't
  // restore to a thread the user has navigated away from.
  React.useEffect(() => {
    if (!storageKey) return;
    saveStoreToStorage(
      storageKey,
      {
        ...state.store,
        activeThreadId: state.activeThreadId,
      },
      state.railWidth,
      state.mode,
    );
  }, [
    storageKey,
    state.store,
    state.activeThreadId,
    state.railWidth,
    state.mode,
  ]);

  // Mode is read inside the once-mounted ⌘K handler, so keep a ref in
  // sync with the latest reducer state to avoid stale closure reads.
  const modeRef = React.useRef(state.mode);
  React.useEffect(() => {
    modeRef.current = state.mode;
  }, [state.mode]);

  // Global ⌘K / Ctrl-K behaviour:
  //   closed                              →  open the rail
  //   open + composer focused             →  close the rail
  //   open + composer NOT focused         →  focus the composer
  // Bail when focus is in an input/textarea/contenteditable that is
  // NOT the assistant composer, so we don't steal keystrokes from the
  // user's current field.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const isMac = (() => {
        if (typeof navigator === "undefined") return false;
        // `navigator.userAgentData.platform` is the modern, non-deprecated
        // surface; fall back to `navigator.platform` on browsers that
        // haven't shipped UA-CH yet (Safari at the time of writing).
        const uaData = (
          navigator as unknown as {
            userAgentData?: { platform?: string };
          }
        ).userAgentData;
        if (uaData?.platform) return /Mac/i.test(uaData.platform);
        return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      })();
      const meta = isMac ? event.metaKey : event.ctrlKey;
      if (!meta) return;
      if (event.key !== "k" && event.key !== "K") return;

      const target = event.target as HTMLElement | null;
      const composerSelector = `[${ASSISTANT_COMPOSER_DATA_ATTR}]`;
      const inComposer = !!target?.closest(composerSelector);

      // Only swallow ⌘K when it's harmless — i.e., we're not stealing it
      // from a form input the user is typing into. Notably we DO want to
      // capture from the TipTap editor body (a contenteditable region):
      // it has no native ⌘K binding, the assistant rail is the primary
      // ⌘K consumer in this product, and a previous version of this
      // guard incorrectly bailed for contenteditable, breaking ⌘K every
      // time the editor was focused.
      if (
        target &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
        !inComposer
      ) {
        return;
      }

      event.preventDefault();

      const mode = modeRef.current;
      if (mode === "closed") {
        dispatch({ type: "open-rail" });
        return;
      }

      if (inComposer) {
        // Already typing in the composer → toggle close.
        dispatch({ type: "close" });
        return;
      }

      // Rail is visible but composer isn't focused → focus it.
      const composerTextarea = document.querySelector(
        `${composerSelector} textarea`,
      ) as HTMLTextAreaElement | null;
      if (composerTextarea) {
        composerTextarea.focus();
        // Place the caret at end so the user can keep typing without
        // re-selecting.
        const end = composerTextarea.value.length;
        composerTextarea.setSelectionRange(end, end);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { registerActiveDocument, registeredActiveDocument, value };
}

export function AssistantProvider({
  children,
  ...options
}: AssistantProviderProps) {
  const { registerActiveDocument, registeredActiveDocument, value } =
    useAssistantProviderModel(options);

  return React.createElement(
    AssistantMountedContext.Provider,
    { value: true },
    React.createElement(
      AssistantActiveDocumentRegistrationContext.Provider,
      { value: registerActiveDocument },
      React.createElement(
        AssistantActiveDocumentContext.Provider,
        { value: registeredActiveDocument },
        React.createElement(AssistantContext.Provider, { value }, children),
      ),
    ),
  );
}

export function useAssistant(): AssistantContextValue {
  return React.use(AssistantContext);
}

/**
 * `true` when the consumer is inside a real `AssistantProvider` rather
 * than the headless fallback. Components like the topbar launcher use
 * this to hide themselves entirely outside the provider.
 */
export function useAssistantMounted(): boolean {
  return React.use(AssistantMountedContext);
}

export function relTime(iso: string, nowIso?: string): string {
  const d = new Date(iso);
  const now = nowIso ? new Date(nowIso) : new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (Number.isNaN(diff)) return "";
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}
