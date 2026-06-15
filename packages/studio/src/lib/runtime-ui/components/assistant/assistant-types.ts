/**
 * Studio Global Assistant — frontend type definitions.
 *
 * These mirror the proposal and conversation contracts in
 * `docs/specs/SPEC-014-ai-assisted-studio-editing.md`. The shapes here are
 * the surface the UI components depend on; the backing transport (the
 * `/api/v1/ai/chat/messages` endpoint and the proposal apply/reject
 * endpoints) is intentionally out of scope for this UI work and is
 * consumed through `StudioAiRouteApi`.
 *
 * The UI is currently driven by a mock provider so designers and editors
 * can interact with the surface end-to-end before the chat endpoint
 * lands. Swap the mock for a real fetcher by changing the assistant
 * provider input — the components themselves do not touch the network.
 */

export type AssistantContextDoc = {
  documentId?: string;
  path: string;
  type: string;
  locale: string;
};

export type AssistantSelectionContext = {
  documentId?: string;
  path: string;
  text: string;
  selectionId?: string;
};

export type AssistantMessageContextDocument = {
  documentId?: string;
  path: string;
  type?: string;
  locale?: string;
  source: "current" | "attached";
};

export type AssistantMessageContextSnapshot = {
  documents: AssistantMessageContextDocument[];
  selection?: {
    documentId?: string;
    path: string;
    text: string;
    selectionId?: string;
  };
};

export type AssistantValidationCheck = {
  label: string;
  ok: true;
};

export type AssistantValidationError = {
  code: string;
  message: string;
  path?: string;
};

export type AssistantValidation =
  | { status: "valid"; checks?: AssistantValidationCheck[] }
  | { status: "invalid"; errors: AssistantValidationError[] };

export type AssistantProposalKind =
  | "replace_selection"
  | "insert_block"
  | "update_frontmatter"
  | "create_document"
  | "delete_document";

type ProposalCommonFields = {
  proposalId: string;
  /**
   * Stable server identity for existing-document proposals. UI surfaces
   * should prefer `docPath` for display and keep this only for resolving
   * labels or follow-up API calls.
   */
  documentId?: string;
  summary: string;
  validation: AssistantValidation;
  expiresAt?: string;
  /**
   * True when the source text the proposal targets has changed since the
   * proposal was generated. Renders an inline warning and disables Accept
   * until the user retries.
   */
  contentInvalidated?: boolean;
  /** Optional pre-computed diff stats; the card falls back to line counts. */
  diffStats?: { added: number; removed: number };
  /**
   * ISO timestamp set when the user accepted the proposal and the apply
   * call succeeded. The card morphs into a quiet past-tense log line
   * (`Applied HH:MM — path (+N −M)`) when this is set instead of
   * disappearing.
   */
  acceptedAt?: string;
  /**
   * Document id resolved from the apply response. For `create_document`
   * proposals this is the newly created doc the undo path soft-deletes;
   * for `delete_document` it is the doc the undo path restores; for
   * edit kinds it is the doc whose body/frontmatter the undo path
   * replays. Absent until apply succeeds.
   */
  acceptedDocumentId?: string;
  /**
   * Pre-apply draft snapshot returned by the apply endpoint for the
   * three body/frontmatter mutating kinds. Echoed back on undo so the
   * server can replay it. Absent for `create_document` and
   * `delete_document` proposals.
   */
  priorDraft?: { body: string; frontmatter: Record<string, unknown> };
  /**
   * Draft revision after the apply call landed. Used by the undo path
   * to detect concurrent edits inside the 6-second window and refuse
   * to clobber them.
   */
  postApplyDraftRevision?: number;
  /**
   * True when the proposal was applied into an active collaboration room
   * instead of through the server apply endpoint. Undo must use the same
   * active room while the short undo window is open.
   */
  acceptedViaCollaboration?: boolean;
};

export type AssistantProposalEdit = ProposalCommonFields & {
  kind: "replace_selection";
  docPath: string;
  type: string;
  locale: string;
  baseDraftRevision?: number;
  op: {
    op: "replace_selection";
    selectionId: string;
    originalText: string;
    replacementText: string;
  };
};

export type AssistantProposalInsert = ProposalCommonFields & {
  kind: "insert_block";
  docPath: string;
  type: string;
  locale: string;
  baseDraftRevision?: number;
  op: {
    op: "insert_block";
    afterSelectionId?: string;
    bodyMdx: string;
  };
};

export type AssistantProposalFrontmatter = ProposalCommonFields & {
  kind: "update_frontmatter";
  docPath: string;
  type: string;
  locale: string;
  baseDraftRevision?: number;
  op: {
    op: "update_frontmatter";
    patch: Record<string, unknown>;
  };
};

export type AssistantProposalCreate = ProposalCommonFields & {
  kind: "create_document";
  docPath: string;
  type: string;
  locale: string;
  op: {
    op: "create_document";
    path: string;
    format: "md" | "mdx";
    frontmatter: Record<string, unknown>;
    bodyPreview: string;
    bodyLines: number;
  };
};

export type AssistantProposalDelete = ProposalCommonFields & {
  kind: "delete_document";
  docPath: string;
  type: string;
  locale: string;
  baseDraftRevision?: number;
  op: {
    op: "delete_document";
    path: string;
    reason?: string;
  };
};

export type AssistantProposal =
  | AssistantProposalEdit
  | AssistantProposalInsert
  | AssistantProposalFrontmatter
  | AssistantProposalCreate
  | AssistantProposalDelete;

export type AssistantMessageRole = "user" | "assistant";

export type AssistantProgressEvent = {
  phase:
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "tool-error"
    | "step-finished";
  message: string;
  toolCallId?: string;
  toolName?: string;
  status?: "started" | "completed" | "queued" | "rejected" | "failed";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type AssistantStreamBlock =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "progress";
      events: AssistantProgressEvent[];
    };

export type AssistantMessage = {
  id: string;
  role: AssistantMessageRole;
  /** Plain-text composer content for user turns. Empty string for assistant turns that emit only proposals. */
  text?: string;
  /** Context chips that were attached when this user turn was sent. */
  context?: AssistantMessageContextSnapshot;
  progress?: AssistantProgressEvent[];
  /**
   * Pending-stream-only render blocks. They preserve the order in
   * which text deltas and progress events arrived so the assistant can
   * show tool activity between prose blocks while a turn is streaming.
   */
  streamBlocks?: AssistantStreamBlock[];
  proposals?: string[];
  at: string;
  /**
   * When the user turn is a regenerate-with-feedback follow-up, the
   * proposal id this message is responding to. Forwarded to the chat
   * endpoint so the server can correlate the regenerate request with
   * its predecessor for audit + cost accounting.
   */
  rejectedProposalId?: string;
  /**
   * Side-channel messages emitted by the client to give the model
   * context the user never types — e.g. an "I accepted the proposal
   * for blog/post-1" turn appended after Accept succeeds. The chat
   * timeline filters these out of rendering but the conversation-
   * history serializer includes them so the agent sees the signal.
   */
  hidden?: boolean;
};

export type AssistantThread = {
  id: string;
  title: string;
  updatedAt: string;
  pinned?: boolean;
  preview: string;
  contextDocs: AssistantContextDoc[];
  attachedSelection?: AssistantSelectionContext;
  messages: AssistantMessage[];
  /**
   * Counted across messages.proposals; cached to avoid recomputing in the
   * sidebar list when the thread is closed.
   */
  docCount: number;
};

/**
 * Opaque wire-shape proposal envelope persisted by the client alongside
 * the rendering-shaped `AssistantProposal`. The studio doesn't introspect
 * this — it just round-trips it back to the server on accept/reject so
 * the apply route doesn't depend on a server-side proposal store
 * surviving a restart. The actual type is `StudioAiProposal` from
 * `@mdcms/studio/lib/ai-route-api`; the assistant types stay
 * decoupled from the route API by treating it as an opaque record.
 */
export type AssistantWireProposal = Record<string, unknown>;

export type AssistantStore = {
  now: string;
  activeThreadId: string;
  threads: AssistantThread[];
  proposals: Record<string, AssistantProposal>;
  /**
   * Wire-shape proposals keyed by proposalId. The rendering layer reads
   * from `proposals`; accept/reject reads from this map and posts the
   * body back to the server. Both are populated when a chat turn
   * returns proposals; both are persisted to localStorage.
   */
  wireProposals: Record<string, AssistantWireProposal>;
};
