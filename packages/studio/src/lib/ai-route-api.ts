import {
  RuntimeError,
  type AiComponentReference,
  type ContentDocumentResponse,
  type MdxComponentCatalog,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  isStudioCookieAuth,
  type StudioRuntimeAuth,
} from "./request-auth.js";
import { resolveStudioRelativeUrl } from "./url-resolution.js";
import type { MdcmsConfig } from "./studio-component.js";

export type StudioAiRouteConfig = Pick<
  MdcmsConfig,
  "project" | "environment" | "serverUrl"
>;

export type StudioAiRouteApiOptions = {
  auth?: StudioRuntimeAuth;
  fetcher?: typeof fetch;
};

/**
 * Inline-transform actions are scoped to selection-anchored copy edits.
 * Frontmatter (SEO) suggestions and MDX block insertion are produced
 * through other surfaces (properties panel and slash menu / chat
 * respectively) per SPEC-014 §Inline Selection Transforms.
 */
export type StudioAiInlineAction =
  | "rewrite"
  | "shorten"
  | "expand"
  | "change_tone"
  | "fix_grammar"
  | "improve_clarity";

export type StudioAiProposalOperation =
  | {
      op: "replace_selection";
      selectionId: string;
      originalText: string;
      replacementText: string;
    }
  | {
      op: "insert_block";
      afterSelectionId?: string;
      bodyMdx: string;
    }
  | {
      op: "update_frontmatter";
      patch: Record<string, unknown>;
    }
  | {
      op: "create_document";
      path: string;
      format: "md" | "mdx";
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | {
      op: "delete_document";
      path: string;
      reason?: string;
    };

export type StudioAiProposalValidation =
  | { status: "valid" }
  | {
      status: "invalid";
      errors: { code: string; message: string; path?: string }[];
    };

export type StudioAiProposal = {
  proposalId: string;
  kind:
    | "replace_selection"
    | "insert_block"
    | "update_frontmatter"
    | "create_document"
    | "delete_document";
  project: string;
  environment: string;
  documentId?: string;
  baseDraftRevision?: number;
  type: string;
  locale: string;
  summary: string;
  operations: StudioAiProposalOperation[];
  validation: StudioAiProposalValidation;
  expiresAt: string;
  provider: {
    providerId: string;
    model: string;
    promptTemplateId: string;
  };
};

export type StudioAiInlineTransformRequest = {
  documentId?: string;
  draftRevision?: number;
  /** Stable id for the selection range; the server stamps this onto every replacement op. */
  selectionId: string;
  /** Plain-text contents of the selection. */
  selectedText: string;
  action: StudioAiInlineAction;
  instruction?: string;
  /** Required when `action` is `change_tone`; ignored otherwise. */
  tone?: string;
  signal?: AbortSignal;
};

export type StudioAiInlineTransformResult = {
  proposals: StudioAiProposal[];
};

export type StudioAiApplyRequest = {
  proposalId: string;
  draftRevision?: number;
  schemaHash: string;
  /**
   * Full proposal body. The chat surface persists proposals client-side
   * and sends the body back here so apply doesn't depend on the
   * server's in-memory proposal store surviving a restart. Inline
   * transforms omit this and rely on a proposalId lookup.
   */
  proposal?: StudioAiProposal;
  signal?: AbortSignal;
};

/**
 * Snapshot of the pre-apply draft body and frontmatter returned by the
 * apply route for body/frontmatter mutating kinds. The client passes
 * this back to the undo route so the server can replay it without
 * holding state across calls.
 */
export type StudioAiPriorDraft = {
  body: string;
  frontmatter: Record<string, unknown>;
};

export type StudioAiApplyResult = {
  proposal: StudioAiProposal;
  document: ContentDocumentResponse;
  /**
   * Pre-apply draft snapshot, present only for `replace_selection`,
   * `insert_block`, and `update_frontmatter` proposals. Client undo
   * for those kinds passes this back to the server verbatim.
   */
  priorDraft?: StudioAiPriorDraft;
};

export type StudioAiUndoRequest = {
  proposalId: string;
  /** Wire-shape proposal body, same envelope as `applyProposal`. */
  proposal: StudioAiProposal;
  /** Document the apply call produced or mutated. */
  documentId: string;
  schemaHash: string;
  /** Required for body/frontmatter undo; ignored for create/delete. */
  priorDraft?: StudioAiPriorDraft;
  /**
   * Post-apply draft revision. The server uses this to fail loud with
   * `AI_PROPOSAL_CONFLICT` when the doc has been edited inside the 6s
   * undo window so the replay can't clobber concurrent changes.
   */
  postApplyDraftRevision?: number;
  signal?: AbortSignal;
};

export type StudioAiUndoResult = {
  proposal: StudioAiProposal;
  document: ContentDocumentResponse;
};

export type StudioAiRejectRequest = {
  proposalId: string;
  /**
   * Full proposal body — same rationale as in `StudioAiApplyRequest`.
   * When the chat surface rejects a client-owned proposal it sends the
   * body here so the server doesn't need a store lookup.
   */
  proposal?: StudioAiProposal;
  signal?: AbortSignal;
};

export type StudioAiChatAllowedAction =
  | "answer"
  | "edit_document"
  | "create_document"
  | "delete_document";

export type StudioAiChatAttachedSelection = {
  documentId: string;
  draftRevision: number;
  selectionId: string;
  text: string;
};

export type StudioAiChatConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type StudioAiChatMessageRequest = {
  message: string;
  conversationId?: string;
  attachedDocumentIds?: string[];
  attachedSelection?: StudioAiChatAttachedSelection;
  rejectedProposalId?: string;
  /**
   * Full body of the rejected proposal — sent so the regenerate flow
   * doesn't depend on the server's in-memory proposal store.
   */
  rejectedProposal?: StudioAiProposal;
  rejectionFeedback?: string;
  allowedActions?: StudioAiChatAllowedAction[];
  mdxCatalog?: MdxComponentCatalog;
  componentReferences?: AiComponentReference[];
  /**
   * Prior conversation turns from the same thread, oldest first. The
   * server is stateless per request — the client owns conversation
   * memory — so we send a rolling window of recent turns alongside the
   * new message so the model can resolve anaphora across the thread.
   */
  conversationHistory?: StudioAiChatConversationTurn[];
  signal?: AbortSignal;
};

export type StudioAiChatMessage = {
  id: string;
  role: "user" | "assistant";
  at: string;
  text?: string;
  proposals?: string[];
  rejectedProposalId?: string;
};

export type StudioAiChatMessageResult = {
  conversationId: string;
  message: StudioAiChatMessage;
  proposals?: StudioAiProposal[];
};

export type StudioAiChatProgressEvent = {
  type: "progress";
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

/**
 * Wire-shape of a Server-Sent Event emitted by the chat stream
 * endpoint. The client accumulates `text-delta` events into the
 * pending assistant message, then commits the final shape on `done`
 * (or renders a turn-level error on `error`).
 */
export type StudioAiChatStreamEvent =
  | StudioAiChatProgressEvent
  | { type: "text-delta"; text: string }
  | {
      type: "done";
      message: StudioAiChatMessage;
      proposals: StudioAiProposal[];
      conversationId?: string;
    }
  | { type: "error"; code: string; message: string };

export type StudioAiRouteApi = {
  inlineTransform(
    input: StudioAiInlineTransformRequest,
  ): Promise<StudioAiInlineTransformResult>;
  applyProposal(input: StudioAiApplyRequest): Promise<StudioAiApplyResult>;
  /**
   * Reverse a previously applied proposal through the post-accept undo
   * window. Routes per kind to a delete / restore / body replay on the
   * server and emits a paired audit record (`outcome: undone`).
   */
  undoProposal(input: StudioAiUndoRequest): Promise<StudioAiUndoResult>;
  rejectProposal(
    input: StudioAiRejectRequest,
  ): Promise<{ proposal: StudioAiProposal }>;
  chatMessage(
    input: StudioAiChatMessageRequest,
  ): Promise<StudioAiChatMessageResult>;
  /**
   * Streaming counterpart of `chatMessage`. Returns an AsyncIterable
   * that yields parsed SSE events as the server emits them. The caller
   * is responsible for cleaning up via the input's `signal` if it
   * needs to interrupt the read.
   */
  chatMessageStream(
    input: StudioAiChatMessageRequest,
  ): AsyncIterable<StudioAiChatStreamEvent>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildAiUrl(config: StudioAiRouteConfig, path: string): URL {
  return resolveStudioRelativeUrl(path, config.serverUrl);
}

function targetHeaders(
  config: StudioAiRouteConfig,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "x-mdcms-project": config.project,
    "x-mdcms-environment": config.environment,
    "content-type": "application/json",
    ...(extra ?? {}),
  };
}

function isDevEnvironment(): boolean {
  try {
    return (
      typeof process !== "undefined" && process.env?.NODE_ENV !== "production"
    );
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isDevEnvironment()) {
      // eslint-disable-next-line no-console -- dev-only diagnostic
      console.warn(
        `[mdcms-studio] failed to parse AI route JSON (status ${response.status}, url ${response.url})`,
        error,
      );
    }
    return undefined;
  }
}

function failureFromResponse(
  operation: string,
  response: Response,
  payload: unknown,
  fallback: string,
): RuntimeError {
  const code =
    isRecord(payload) && typeof payload.code === "string" && payload.code
      ? payload.code
      : "AI_REQUEST_FAILED";
  const message =
    isRecord(payload) && typeof payload.message === "string" && payload.message
      ? payload.message
      : fallback;

  return new RuntimeError({
    code,
    message,
    statusCode: response.status,
    details: {
      operation,
      status: response.status,
      payload,
    },
  });
}

function unwrapData<T>(operation: string, payload: unknown): T {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new RuntimeError({
      code: "AI_REQUEST_FAILED",
      message: `Unexpected response shape for ${operation}.`,
      statusCode: 500,
    });
  }

  return payload.data as T;
}

async function fetchAi(
  config: StudioAiRouteConfig,
  options: StudioAiRouteApiOptions,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const cookieAuth = options.auth && isStudioCookieAuth(options.auth);
  const finalInit = applyStudioAuthToRequestInit(options.auth, init);

  return fetcher(url.toString(), {
    ...finalInit,
    credentials: cookieAuth ? "include" : finalInit.credentials,
  });
}

/**
 * Bootstrap (and cache) the studio CSRF token used by state-changing
 * AI endpoints: chat-message, apply, and reject all gate session-auth
 * mutations on a valid `x-mdcms-csrf-token`. API-key auth is exempt
 * server-side (the bearer header itself proves intent), so we skip the
 * extra round-trip in that case.
 *
 * The token is fetched once per `createStudioAiRouteApi` lifetime and
 * shared across all three endpoints — matching the cadence the
 * document-route API uses for content mutations. If the session
 * endpoint omits the token (e.g. on an unauthenticated cookie request)
 * we return undefined and let the server respond with its own 403.
 */
function createCsrfTokenLoader(
  config: StudioAiRouteConfig,
  options: StudioAiRouteApiOptions,
): () => Promise<string | undefined> {
  let cachedPromise: Promise<string | undefined> | undefined;

  return () => {
    if (!options.auth || !isStudioCookieAuth(options.auth)) {
      return Promise.resolve(undefined);
    }
    if (!cachedPromise) {
      cachedPromise = (async () => {
        try {
          const url = buildAiUrl(config, "/api/v1/auth/session");
          const response = await fetchAi(config, options, url, {
            method: "GET",
            headers: { "content-type": "application/json" },
          });
          if (!response.ok) return undefined;
          const payload = await readJson(response);
          if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
          const token = payload.data.csrfToken;
          return typeof token === "string" && token.length > 0
            ? token
            : undefined;
        } catch {
          return undefined;
        }
      })();
    }
    return cachedPromise;
  };
}

/**
 * createStudioAiRouteApi mirrors the `document-route-api.ts` factory but
 * targets `/api/v1/ai/*`. The proposal id returned from inline-transform
 * is opaque to callers — they pass it back to `applyProposal` or
 * `rejectProposal` to resolve the lifecycle.
 */
export function createStudioAiRouteApi(
  config: StudioAiRouteConfig,
  options: StudioAiRouteApiOptions = {},
): StudioAiRouteApi {
  const loadCsrfToken = createCsrfTokenLoader(config, options);
  return {
    async inlineTransform(input) {
      const url = buildAiUrl(config, "/api/v1/ai/inline-transform");
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: targetHeaders(config),
        signal: input.signal,
        body: JSON.stringify({
          documentId: input.documentId,
          draftRevision: input.draftRevision,
          selectionId: input.selectionId,
          selectedText: input.selectedText,
          action: input.action,
          instruction: input.instruction,
          tone: input.tone,
        }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw failureFromResponse(
          "POST /api/v1/ai/inline-transform",
          response,
          payload,
          "Failed to request AI inline transform.",
        );
      }

      return unwrapData<StudioAiInlineTransformResult>(
        "POST /api/v1/ai/inline-transform",
        payload,
      );
    },
    async applyProposal(input) {
      const url = buildAiUrl(
        config,
        `/api/v1/ai/proposals/${encodeURIComponent(input.proposalId)}/apply`,
      );
      const csrfToken = await loadCsrfToken();
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: targetHeaders(
          config,
          csrfToken ? { "x-mdcms-csrf-token": csrfToken } : undefined,
        ),
        signal: input.signal,
        body: JSON.stringify({
          draftRevision: input.draftRevision,
          schemaHash: input.schemaHash,
          ...(input.proposal !== undefined ? { proposal: input.proposal } : {}),
        }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw failureFromResponse(
          "POST /api/v1/ai/proposals/:id/apply",
          response,
          payload,
          "Failed to apply AI proposal.",
        );
      }

      return unwrapData<StudioAiApplyResult>(
        "POST /api/v1/ai/proposals/:id/apply",
        payload,
      );
    },
    async undoProposal(input) {
      const url = buildAiUrl(
        config,
        `/api/v1/ai/proposals/${encodeURIComponent(input.proposalId)}/undo`,
      );
      const csrfToken = await loadCsrfToken();
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: targetHeaders(
          config,
          csrfToken ? { "x-mdcms-csrf-token": csrfToken } : undefined,
        ),
        signal: input.signal,
        body: JSON.stringify({
          proposal: input.proposal,
          documentId: input.documentId,
          schemaHash: input.schemaHash,
          ...(input.priorDraft !== undefined
            ? { priorDraft: input.priorDraft }
            : {}),
          ...(typeof input.postApplyDraftRevision === "number"
            ? { postApplyDraftRevision: input.postApplyDraftRevision }
            : {}),
        }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw failureFromResponse(
          "POST /api/v1/ai/proposals/:id/undo",
          response,
          payload,
          "Failed to undo AI proposal.",
        );
      }

      return unwrapData<StudioAiUndoResult>(
        "POST /api/v1/ai/proposals/:id/undo",
        payload,
      );
    },
    async rejectProposal(input) {
      const url = buildAiUrl(
        config,
        `/api/v1/ai/proposals/${encodeURIComponent(input.proposalId)}/reject`,
      );
      const csrfToken = await loadCsrfToken();
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: targetHeaders(
          config,
          csrfToken ? { "x-mdcms-csrf-token": csrfToken } : undefined,
        ),
        signal: input.signal,
        body: JSON.stringify(
          input.proposal !== undefined ? { proposal: input.proposal } : {},
        ),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw failureFromResponse(
          "POST /api/v1/ai/proposals/:id/reject",
          response,
          payload,
          "Failed to reject AI proposal.",
        );
      }

      return unwrapData<{ proposal: StudioAiProposal }>(
        "POST /api/v1/ai/proposals/:id/reject",
        payload,
      );
    },
    async chatMessage(input) {
      const url = buildAiUrl(config, "/api/v1/ai/chat/messages");
      const body: Record<string, unknown> = {
        message: input.message,
      };
      if (input.conversationId !== undefined) {
        body.conversationId = input.conversationId;
      }
      if (input.attachedDocumentIds && input.attachedDocumentIds.length > 0) {
        body.attachedDocumentIds = input.attachedDocumentIds;
      }
      if (input.attachedSelection !== undefined) {
        body.attachedSelection = input.attachedSelection;
      }
      if (input.rejectedProposalId !== undefined) {
        body.rejectedProposalId = input.rejectedProposalId;
      }
      if (input.rejectedProposal !== undefined) {
        body.rejectedProposal = input.rejectedProposal;
      }
      if (input.rejectionFeedback !== undefined) {
        body.rejectionFeedback = input.rejectionFeedback;
      }
      if (input.allowedActions && input.allowedActions.length > 0) {
        body.allowedActions = input.allowedActions;
      }
      if (input.mdxCatalog !== undefined) {
        body.mdxCatalog = input.mdxCatalog;
      }
      if (
        input.componentReferences !== undefined &&
        input.componentReferences.length > 0
      ) {
        body.componentReferences = input.componentReferences;
      }
      if (input.conversationHistory && input.conversationHistory.length > 0) {
        body.conversationHistory = input.conversationHistory;
      }

      const csrfToken = await loadCsrfToken();
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: targetHeaders(
          config,
          csrfToken ? { "x-mdcms-csrf-token": csrfToken } : undefined,
        ),
        signal: input.signal,
        body: JSON.stringify(body),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        throw failureFromResponse(
          "POST /api/v1/ai/chat/messages",
          response,
          payload,
          "Failed to send AI chat message.",
        );
      }

      return unwrapData<StudioAiChatMessageResult>(
        "POST /api/v1/ai/chat/messages",
        payload,
      );
    },
    async *chatMessageStream(input) {
      const url = buildAiUrl(config, "/api/v1/ai/chat/messages/stream");
      const body: Record<string, unknown> = { message: input.message };
      if (input.conversationId !== undefined) {
        body.conversationId = input.conversationId;
      }
      if (input.attachedDocumentIds && input.attachedDocumentIds.length > 0) {
        body.attachedDocumentIds = input.attachedDocumentIds;
      }
      if (input.attachedSelection !== undefined) {
        body.attachedSelection = input.attachedSelection;
      }
      if (input.rejectedProposalId !== undefined) {
        body.rejectedProposalId = input.rejectedProposalId;
      }
      if (input.rejectedProposal !== undefined) {
        body.rejectedProposal = input.rejectedProposal;
      }
      if (input.rejectionFeedback !== undefined) {
        body.rejectionFeedback = input.rejectionFeedback;
      }
      if (input.allowedActions && input.allowedActions.length > 0) {
        body.allowedActions = input.allowedActions;
      }
      if (input.mdxCatalog !== undefined) {
        body.mdxCatalog = input.mdxCatalog;
      }
      if (
        input.componentReferences !== undefined &&
        input.componentReferences.length > 0
      ) {
        body.componentReferences = input.componentReferences;
      }
      if (input.conversationHistory && input.conversationHistory.length > 0) {
        body.conversationHistory = input.conversationHistory;
      }

      const csrfToken = await loadCsrfToken();
      const response = await fetchAi(config, options, url, {
        method: "POST",
        headers: {
          ...targetHeaders(
            config,
            csrfToken ? { "x-mdcms-csrf-token": csrfToken } : undefined,
          ),
          accept: "text/event-stream",
        },
        signal: input.signal,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await readJson(response);
        throw failureFromResponse(
          "POST /api/v1/ai/chat/messages/stream",
          response,
          payload,
          "Failed to open AI chat stream.",
        );
      }
      if (!response.body) {
        throw new RuntimeError({
          code: "AI_REQUEST_FAILED",
          message: "AI chat stream response has no body.",
          statusCode: 500,
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events are delimited by a blank line — accept both LF
          // and CRLF terminators so we don't lose events behind a
          // middlebox that rewrites line endings.
          let boundary: number;
          while ((boundary = findEventBoundary(buffer)) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseSseBlock(block);
            if (event) yield event;
          }
        }
        // Flush any remaining buffered block when the server closes
        // without a trailing blank line (rare but tolerated).
        const trailing = parseSseBlock(buffer);
        if (trailing) yield trailing;
      } finally {
        // Releasing the reader cancels the underlying fetch body so
        // an early-terminated AsyncIterable (e.g. user hit Stop) tears
        // down the connection promptly.
        try {
          reader.releaseLock();
        } catch {
          // Already released — fine.
        }
      }
    },
  };
}

/**
 * Find the next SSE event boundary (\n\n or \r\n\r\n) inside the
 * buffer; returns the index of the FIRST terminator newline, with
 * the slice [0, idx] being the block and [idx + 2 / + 4] being the
 * remainder. Returns -1 when no full event is buffered yet.
 */
function findEventBoundary(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseSseBlock(block: string): StudioAiChatStreamEvent | null {
  const trimmed = block.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return null;
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join("\n"));
    if (typeof data !== "object" || data === null) return null;
    return {
      type: eventType,
      ...(data as Record<string, unknown>),
    } as StudioAiChatStreamEvent | null;
  } catch {
    return null;
  }
}
