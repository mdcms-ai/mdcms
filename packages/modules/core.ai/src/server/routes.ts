import {
  aiChatMessageRequestSchema,
  aiProposalSchema,
  assertRequestTargetRouting,
  RuntimeError,
  type AiChatAllowedAction,
  type AiChatMessage,
  type AiChatMessageRequest,
  type AiComponentReference,
  type AiProposal,
  type AiProposalKind,
  type AiTaskKind,
  type ContentDocumentResponse,
} from "@mdcms/shared";

import {
  applyAiProposal,
  applyAiProposalUndo,
  type AiApplyContentStore,
  type AiApplyPriorDraft,
} from "./apply.js";
import { buildAuditRecord, type AiAuditRecord } from "./audit.js";
import {
  getOrchestratorFailureAudit,
  getOrchestratorFailureRuntimeError,
  type AiOrchestrator,
} from "./orchestrator.js";
import type { AiProposalEnvelope } from "./proposal-builder.js";
import type { AiProposalRecord, AiProposalStore } from "./proposal-store.js";

const INLINE_TRANSFORM_ACTIONS = [
  "rewrite",
  "shorten",
  "expand",
  "change_tone",
  "fix_grammar",
  "improve_clarity",
] as const;

export type InlineTransformAction = (typeof INLINE_TRANSFORM_ACTIONS)[number];

// All inline transforms map to the copy_improvement task; the prompt is
// shaped by the action-specific instruction hint below. SEO frontmatter
// suggestions and MDX component insertion live on other surfaces (the
// document properties panel, slash menu, chat) and are intentionally not
// exposed through `/api/v1/ai/inline-transform`.
const ACTION_TO_TASK: Record<InlineTransformAction, AiTaskKind> = {
  rewrite: "copy_improvement",
  shorten: "copy_improvement",
  expand: "copy_improvement",
  change_tone: "copy_improvement",
  fix_grammar: "copy_improvement",
  improve_clarity: "copy_improvement",
};

const ACTION_INSTRUCTION_HINT: Record<InlineTransformAction, string> = {
  rewrite: "Rewrite the selected content while preserving the meaning.",
  shorten: "Shorten the selected content while preserving the key points.",
  expand: "Expand the selected content with additional supporting detail.",
  change_tone:
    "Rewrite the selected content using the requested tone. Keep meaning intact.",
  fix_grammar:
    "Fix grammar and spelling errors in the selected content without changing meaning.",
  improve_clarity:
    "Rewrite the selected content for clarity, brevity, and active voice.",
};

export type InlineTransformRequestBody = {
  documentId?: string;
  draftRevision?: number;
  selectionId?: string;
  selectedText?: string;
  action?: string;
  instruction?: string;
  tone?: string;
};

export type ProposalApplyRequestBody = {
  draftRevision?: number;
  schemaHash?: string;
  /**
   * Full proposal body — used by the chat surface, which persists
   * proposals client-side (in localStorage) so they survive server
   * restarts and never get a "NOT_FOUND" after the in-memory store is
   * wiped. When present, the server validates the body via Zod and
   * applies it directly, bypassing the proposal store lookup. Inline
   * transforms continue to use the proposalId-only path.
   */
  proposal?: unknown;
};

export type AiAuditEmitter = (record: AiAuditRecord) => void;

export type AiContentStore = AiApplyContentStore & {
  // No additional methods required beyond AiApplyContentStore for routes.
};

export type AiContextResolver = {
  /**
   * Load the draft document used to assemble AI context. Implementations
   * MUST enforce the caller's authorization before returning data.
   */
  loadDraftContext(input: {
    request: Request;
    project: string;
    environment: string;
    documentId: string;
  }): Promise<{
    document: ContentDocumentResponse;
  }>;
};

export type AiSchemaHashLookup = (input: {
  project: string;
  environment: string;
}) => Promise<string | undefined>;

export type AiAuthorizer = (
  request: Request,
  requirement: {
    requiredScope:
      | "ai:use"
      | "content:write"
      | "content:read:draft"
      | "content:delete";
    project: string;
    environment: string;
    documentPath?: string;
  },
) => Promise<{ actorId: string }>;

export type AiCsrfProtector = (request: Request) => Promise<void>;

export type AiRouteApp = {
  post?: (path: string, handler: (ctx: any) => unknown) => AiRouteApp;
};

export type MountAiRoutesOptions = {
  orchestrator: AiOrchestrator;
  proposalStore: AiProposalStore;
  contentStore: AiContentStore;
  contextResolver: AiContextResolver;
  schemaHashLookup: AiSchemaHashLookup;
  authorize: AiAuthorizer;
  requireCsrf: AiCsrfProtector;
  emitAudit?: AiAuditEmitter;
  /**
   * Returns all content types registered for the given project +
   * environment, each with the full schema snapshot. Used to ground
   * the chat model in real types (system prompt) and to enum-constrain
   * the find_entries tool's `type` parameter.
   */
  contentTypesLookup?: (input: {
    project: string;
    environment: string;
  }) => Promise<import("@mdcms/shared").SchemaRegistryTypeSnapshot[]>;

  /**
   * Returns the list of locale codes (e.g. "en", "pl") configured as
   * supported by the project's MDCMS config. Used to ground the model
   * and to enum-constrain the find_entries tool's `locale` parameter.
   */
  supportedLocalesLookup?: (input: {
    project: string;
    environment: string;
  }) => Promise<string[]>;

  /**
   * Returns the display name for a user id (from authUsers.name with
   * email/id fallbacks). Used to address the current user by name in
   * the chat system prompt so attribution defaults are accurate.
   */
  userLookup?: (input: { userId: string }) => Promise<{
    id: string;
    displayName: string;
  }>;

  /**
   * Backend for the find_entries chat tool. Wraps contentStore.list
   * scoped to the active project + environment.
   */
  listEntries?: (input: {
    project: string;
    environment: string;
    type: string;
    query?: string;
    locale?: string;
    limit?: number;
  }) => Promise<import("./chat-tools.js").FindEntriesResult>;

  /**
   * Backend for the get_entry chat tool. Wraps contentStore.getById.
   */
  getEntry?: (input: {
    project: string;
    environment: string;
    documentId: string;
  }) => Promise<import("./chat-tools.js").GetEntryResult | undefined>;
};

const KIND_BY_TASK: Record<AiTaskKind, AiProposalKind> = {
  copy_improvement: "replace_selection",
  seo_improvement: "update_frontmatter",
  mdx_component_insertion: "insert_block",
  current_document_edit: "replace_selection",
  new_document_draft: "create_document",
};

function ensureInlineTransformAction(value: unknown): InlineTransformAction {
  if (typeof value !== "string") {
    throw invalidInput('Field "action" must be a string.', { field: "action" });
  }

  if (!INLINE_TRANSFORM_ACTIONS.includes(value as InlineTransformAction)) {
    throw invalidInput(`Unsupported action "${value}".`, {
      field: "action",
      value,
      allowed: INLINE_TRANSFORM_ACTIONS,
    });
  }

  return value as InlineTransformAction;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidInput(`Field "${field}" must be a string.`, { field });
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw invalidInput(`Field "${field}" must not be empty.`, { field });
  }

  return trimmed;
}

function ensureOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw invalidInput(`Field "${field}" must be a string when provided.`, {
      field,
    });
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

function ensureOptionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidInput(
      `Field "${field}" must be a non-negative integer when provided.`,
      { field },
    );
  }

  return value;
}

function invalidInput(
  message: string,
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    details,
  });
}

function buildInstruction(
  action: InlineTransformAction,
  body: InlineTransformRequestBody,
): string {
  const userInstruction = ensureOptionalString(body.instruction, "instruction");
  const tone = ensureOptionalString(body.tone, "tone");

  const parts: string[] = [ACTION_INSTRUCTION_HINT[action]];

  if (action === "change_tone" && tone) {
    parts.push(`Tone: ${tone}.`);
  }

  if (userInstruction) {
    parts.push(`User instruction: ${userInstruction}.`);
  }

  return parts.join("\n");
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    const parsed = (await request.json()) as T;
    return parsed;
  } catch {
    throw invalidInput("Request body must be valid JSON.", {
      field: "body",
    });
  }
}

function emitAudit(
  emitter: AiAuditEmitter | undefined,
  record: AiAuditRecord,
): void {
  if (!emitter) {
    return;
  }

  try {
    emitter(record);
  } catch {
    // Audit emission must never break a request.
  }
}

/**
 * Sanitize a raw error message for client-facing surfaces. Drizzle wraps
 * postgres failures as `Failed query: <SQL>\nparams: <values>` which is
 * unreadable in a chat bubble; collapse it to a short hint while the
 * full SQL still lives in server logs via the audit pipeline.
 */
function sanitizeClientReason(raw: string): string {
  if (raw.startsWith("Failed query:")) {
    return "Database operation failed. See server logs for details.";
  }
  // Single-line cap so a chat bubble never grows past a sane size; the
  // full text is still in the audit log for ops to inspect.
  const firstLine = raw.split(/\r?\n/)[0]!;
  if (firstLine.length > 240) {
    return `${firstLine.slice(0, 240).trimEnd()}…`;
  }
  return firstLine;
}

function toRuntimeErrorResponse(error: unknown): Response {
  if (error instanceof RuntimeError) {
    return new Response(
      JSON.stringify({
        code: error.code,
        message: error.message,
        details: error.details,
        statusCode: error.statusCode,
      }),
      {
        status: error.statusCode,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const rawMessage =
    error instanceof Error ? error.message : "Internal server error.";
  return new Response(
    JSON.stringify({
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
      details: { reason: sanitizeClientReason(rawMessage) },
      statusCode: 500,
    }),
    {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

async function handleInlineTransform(
  request: Request,
  options: MountAiRoutesOptions,
): Promise<Response> {
  // Hoisted so the catch arm can stamp the user-facing action onto an
  // orchestrator-failure audit even though `action` is parsed inside
  // the try block.
  let resolvedAction: InlineTransformAction | undefined;

  try {
    const routing = assertRequestTargetRouting(request, "project_environment");
    const body = await readJsonBody<InlineTransformRequestBody>(request);
    const action = ensureInlineTransformAction(body.action);
    resolvedAction = action;
    const taskKind = ACTION_TO_TASK[action];

    // Every inline-transform action operates on a selection within a
    // document, so selectionId, selectedText, and documentId are all
    // required. Frontmatter and block-insertion workflows live on
    // separate surfaces — see SPEC-014 §Inline Selection Transforms.
    const documentId = ensureOptionalString(body.documentId, "documentId");
    const selectionId = ensureNonEmptyString(body.selectionId, "selectionId");
    const selectedText = ensureNonEmptyString(
      body.selectedText,
      "selectedText",
    );
    const draftRevision = ensureOptionalNonNegativeInteger(
      body.draftRevision,
      "draftRevision",
    );

    const project = routing.project as string;
    const environment = routing.environment as string;

    const aiAuth = await options.authorize(request, {
      requiredScope: "ai:use",
      project,
      environment,
    });
    let documentForContext: ContentDocumentResponse | undefined;

    if (documentId) {
      await options.authorize(request, {
        requiredScope: "content:read:draft",
        project,
        environment,
      });
      const ctx = await options.contextResolver.loadDraftContext({
        request,
        project,
        environment,
        documentId,
      });
      documentForContext = ctx.document;

      if (
        typeof draftRevision === "number" &&
        documentForContext.draftRevision !== draftRevision
      ) {
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message:
            "Provided draftRevision does not match the live draft revision.",
          statusCode: 409,
          details: {
            documentId,
            providedDraftRevision: draftRevision,
            currentDraftRevision: documentForContext.draftRevision,
          },
        });
      }
    }

    const envelope: AiProposalEnvelope = {
      project,
      environment,
      type: documentForContext?.type ?? "page",
      locale: documentForContext?.locale ?? "en",
      ...(documentForContext
        ? {
            documentId: documentForContext.documentId,
            baseDraftRevision: documentForContext.draftRevision,
          }
        : {}),
    };

    const instruction = buildInstruction(action, body);
    const result = await options.orchestrator.runTask({
      taskKind,
      envelope,
      input: {
        instruction,
        locale: envelope.locale,
        ...(selectedText !== undefined ? { selectionText: selectedText } : {}),
        ...(selectionId !== undefined ? { selectionId } : {}),
        ...(documentForContext
          ? {
              documentBody: documentForContext.body,
              frontmatter: documentForContext.frontmatter,
            }
          : {}),
        ...(action === "change_tone" && body.tone
          ? { tone: ensureNonEmptyString(body.tone, "tone") }
          : {}),
      },
    });

    for (const proposal of result.proposals) {
      options.proposalStore.insert({
        proposal,
        actorId: aiAuth.actorId,
      });
    }

    emitAudit(options.emitAudit, {
      ...result.audit,
      project,
      environment,
      actorId: aiAuth.actorId,
      action,
      ...(documentId ? { documentId } : {}),
    });

    return new Response(
      JSON.stringify({
        data: { proposals: result.proposals },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (error) {
    const failureAudit = getOrchestratorFailureAudit(error);
    if (failureAudit) {
      // The orchestrator failure audit doesn't know about the
      // user-facing action; stamp it here so failed inline transforms
      // are still attributable to the action the user picked.
      emitAudit(options.emitAudit, {
        ...failureAudit,
        ...(resolvedAction ? { action: resolvedAction } : {}),
      });
    }
    const runtimeError = getOrchestratorFailureRuntimeError(error) ?? error;
    return toRuntimeErrorResponse(runtimeError);
  }
}

function ensureProposalCanBeApplied(
  record: AiProposalRecord | undefined,
  proposalId: string,
): asserts record is AiProposalRecord {
  if (!record) {
    throw new RuntimeError({
      code: "NOT_FOUND",
      message: "AI proposal not found.",
      statusCode: 404,
      details: { proposalId },
    });
  }

  if (record.status === "expired") {
    throw new RuntimeError({
      code: "AI_PROPOSAL_EXPIRED",
      message: "AI proposal has expired.",
      statusCode: 410,
      details: { proposalId, status: record.status },
    });
  }

  if (record.status !== "pending") {
    throw new RuntimeError({
      code: "AI_PROPOSAL_CONFLICT",
      message: "AI proposal has already been resolved.",
      statusCode: 409,
      details: { proposalId, status: record.status },
    });
  }

  if (record.proposal.validation.status !== "valid") {
    throw new RuntimeError({
      code: "AI_OUTPUT_INVALID",
      message: "AI proposal failed validation and cannot be applied.",
      statusCode: 422,
      details: {
        proposalId,
        errors: record.proposal.validation.errors,
      },
    });
  }
}

function ensureSchemaHashMatch(
  expected: string | undefined,
  provided: string,
): string {
  if (!expected) {
    throw new RuntimeError({
      code: "SCHEMA_NOT_SYNCED",
      message:
        'Target project/environment has no synced schema. Run "cms schema sync" before applying AI proposals.',
      statusCode: 409,
    });
  }

  if (expected !== provided) {
    throw new RuntimeError({
      code: "SCHEMA_HASH_MISMATCH",
      message:
        "Client schema hash does not match the server schema hash for the target project/environment.",
      statusCode: 409,
      details: {
        clientSchemaHash: provided,
        serverSchemaHash: expected,
      },
    });
  }

  return expected;
}

function buildLifecycleAudit(input: {
  proposal: AiProposal;
  outcome: AiAuditRecord["outcome"];
  occurredAt: Date;
  // Optional because chat-surface failures may abort before
  // authorize() resolves the actor — we still want the audit entry
  // for ops visibility even without a known actor.
  actorId?: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * Explicit document id override. The undo path always operates on
   * the document the apply call landed on, even for `create_document`
   * proposals whose `proposal.documentId` is undefined (the resulting
   * id is resolved client-side from the apply response and posted on
   * the undo request). Pass this so the audit record carries the
   * operated document id per SPEC-014 §Observability.
   */
  documentId?: string;
}): AiAuditRecord {
  const taskKind = mapKindToTask(input.proposal.kind);
  const resolvedDocumentId = input.documentId ?? input.proposal.documentId;

  return buildAuditRecord({
    taskKind,
    providerId: input.proposal.provider.providerId,
    model: input.proposal.provider.model,
    promptTemplateId: input.proposal.provider.promptTemplateId,
    occurredAt: input.occurredAt,
    outcome: input.outcome,
    validation: input.proposal.validation,
    proposals: [input.proposal],
    actorId: input.actorId,
    project: input.proposal.project,
    environment: input.proposal.environment,
    ...(resolvedDocumentId ? { documentId: resolvedDocumentId } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  });
}

function mapKindToTask(kind: AiProposalKind): AiTaskKind {
  for (const [task, mapped] of Object.entries(KIND_BY_TASK) as [
    AiTaskKind,
    AiProposalKind,
  ][]) {
    if (mapped === kind) {
      return task;
    }
  }

  return "copy_improvement";
}

function canReanchorProposalBySourceText(proposal: AiProposal): boolean {
  const [operation] = proposal.operations;

  return (
    proposal.operations.length === 1 &&
    proposal.kind === "replace_selection" &&
    operation?.op === "replace_selection"
  );
}

async function handleProposalApply(
  request: Request,
  proposalId: string,
  options: MountAiRoutesOptions,
): Promise<Response> {
  const occurredAt = new Date();
  let observedRecord: AiProposalRecord | undefined;
  // Tracks the parsed proposal so the catch block can audit failures
  // even when the proposal came from the chat body (no store record).
  let parsedProposal: AiProposal | undefined;

  try {
    await options.requireCsrf(request);
    assertRequestTargetRouting(request, "project_environment");
    const body = await readJsonBody<ProposalApplyRequestBody>(request);
    const schemaHash = ensureNonEmptyString(body.schemaHash, "schemaHash");
    const requestDraftRevision = ensureOptionalNonNegativeInteger(
      body.draftRevision,
      "draftRevision",
    );

    // Dual-path: if the client supplied a full proposal body (chat
    // surface), validate via Zod and use it directly. Otherwise (inline
    // transform) look up the proposal from the in-memory store by id.
    // Chat proposals are persisted client-side in localStorage, so a
    // server restart doesn't poison them.
    let proposal: AiProposal;
    let proposalFromStore = false;
    if (body.proposal !== undefined) {
      const parsed = aiProposalSchema.safeParse(body.proposal);
      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: "Proposal body failed schema validation.",
          statusCode: 400,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
      }
      if (parsed.data.proposalId !== proposalId) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            "Proposal body proposalId does not match the URL path parameter.",
          statusCode: 400,
          details: {
            urlProposalId: proposalId,
            bodyProposalId: parsed.data.proposalId,
          },
        });
      }
      proposal = parsed.data;
      parsedProposal = parsed.data;
    } else {
      observedRecord = options.proposalStore.observe(proposalId);
      if (observedRecord && observedRecord.status === "expired") {
        const audit = buildLifecycleAudit({
          proposal: observedRecord.proposal,
          outcome: "expired",
          occurredAt,
          actorId: observedRecord.createdByActorId,
          errorCode: "AI_PROPOSAL_EXPIRED",
        });
        emitAudit(options.emitAudit, audit);
      }
      ensureProposalCanBeApplied(observedRecord, proposalId);
      proposal = observedRecord.proposal;
      proposalFromStore = true;
    }

    if (
      typeof requestDraftRevision === "number" &&
      typeof proposal.baseDraftRevision === "number" &&
      requestDraftRevision !== proposal.baseDraftRevision &&
      !canReanchorProposalBySourceText(proposal)
    ) {
      throw new RuntimeError({
        code: "AI_PROPOSAL_CONFLICT",
        message:
          "Request draftRevision does not match the proposal base draft revision.",
        statusCode: 409,
        details: {
          requestDraftRevision,
          proposalBaseDraftRevision: proposal.baseDraftRevision,
        },
      });
    }

    // Soft-delete proposals are gated on a stricter capability than
    // the content-mutating kinds — same rule as the manual
    // `DELETE /api/v1/content/:id` route. Edit/insert/frontmatter/create
    // proposals fall back to `content:write` (they only touch draft body
    // or frontmatter, never tombstone the document).
    const requiredScope =
      proposal.kind === "delete_document" ? "content:delete" : "content:write";

    const aiAuth = await options.authorize(request, {
      requiredScope,
      project: proposal.project,
      environment: proposal.environment,
    });

    const expected = await options.schemaHashLookup({
      project: proposal.project,
      environment: proposal.environment,
    });
    ensureSchemaHashMatch(expected, schemaHash);

    const applyResult = await applyAiProposal({
      proposal,
      expectedSchemaHash: schemaHash,
      actorId: aiAuth.actorId,
      store: options.contentStore,
    });
    const { document, priorDraft } = applyResult;

    // Mark accepted in the store only when we sourced the proposal
    // from the store. Client-supplied chat proposals don't have a store
    // record to update.
    const acceptedProposal = proposalFromStore
      ? options.proposalStore.markAccepted({
          proposalId,
          actorId: aiAuth.actorId,
        }).proposal
      : proposal;

    const audit = buildLifecycleAudit({
      proposal: acceptedProposal,
      outcome: "accepted",
      occurredAt,
      actorId: aiAuth.actorId,
    });
    emitAudit(options.emitAudit, audit);

    return new Response(
      JSON.stringify({
        data: {
          proposal: acceptedProposal,
          document,
          ...(priorDraft ? { priorDraft } : {}),
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (error) {
    const code = error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
    const isValidationFailure =
      code === "AI_OUTPUT_INVALID" || code === "SCHEMA_HASH_MISMATCH";
    const isAlreadyExpired = code === "AI_PROPOSAL_EXPIRED";
    const lifecycleOutcome: AiAuditRecord["outcome"] = isAlreadyExpired
      ? "expired"
      : isValidationFailure
        ? "validation_failed"
        : "apply_failed";
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Prefer the store record when we have one (it carries the original
    // createdByActorId); fall back to the chat-body proposal so a
    // failed apply on a chat-surface proposal still emits an audit.
    if (observedRecord && observedRecord.status === "pending") {
      emitAudit(
        options.emitAudit,
        buildLifecycleAudit({
          proposal: observedRecord.proposal,
          outcome: lifecycleOutcome,
          occurredAt,
          actorId: observedRecord.createdByActorId,
          errorCode: code,
          errorMessage,
        }),
      );
    } else if (parsedProposal) {
      emitAudit(
        options.emitAudit,
        buildLifecycleAudit({
          proposal: parsedProposal,
          outcome: lifecycleOutcome,
          occurredAt,
          errorCode: code,
          errorMessage,
        }),
      );
    }

    return toRuntimeErrorResponse(error);
  }
}

export type ProposalUndoRequestBody = {
  /** Wire-shape proposal body (same as apply). */
  proposal?: unknown;
  /** The document the apply call produced / mutated. */
  documentId?: unknown;
  /** Schema hash for the project, threaded the same as apply. */
  schemaHash?: unknown;
  /** Captured pre-apply body+frontmatter for body/frontmatter kinds. */
  priorDraft?: unknown;
  /** Post-apply draft revision for conflict detection on edit kinds. */
  postApplyDraftRevision?: unknown;
};

function ensurePriorDraftPayload(
  value: unknown,
): AiApplyPriorDraft | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw invalidInput("priorDraft must be an object.", {
      field: "priorDraft",
    });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.body !== "string") {
    throw invalidInput("priorDraft.body must be a string.", {
      field: "priorDraft.body",
    });
  }
  if (
    typeof record.frontmatter !== "object" ||
    record.frontmatter === null ||
    Array.isArray(record.frontmatter)
  ) {
    throw invalidInput("priorDraft.frontmatter must be a plain object.", {
      field: "priorDraft.frontmatter",
    });
  }
  return {
    body: record.body,
    frontmatter: record.frontmatter as Record<string, unknown>,
  };
}

async function handleProposalUndo(
  request: Request,
  proposalId: string,
  options: MountAiRoutesOptions,
): Promise<Response> {
  const occurredAt = new Date();
  let parsedProposal: AiProposal | undefined;
  let resolvedActorId: string | undefined;
  let resolvedDocumentId: string | undefined;

  try {
    await options.requireCsrf(request);
    assertRequestTargetRouting(request, "project_environment");
    const body = await readJsonBody<ProposalUndoRequestBody>(request);
    const schemaHash = ensureNonEmptyString(body.schemaHash, "schemaHash");
    const documentId = ensureNonEmptyString(body.documentId, "documentId");
    resolvedDocumentId = documentId;
    const postApplyDraftRevision = ensureOptionalNonNegativeInteger(
      body.postApplyDraftRevision,
      "postApplyDraftRevision",
    );

    if (body.proposal === undefined) {
      throw invalidInput("Undo requires the wire-shape proposal body.", {
        field: "proposal",
      });
    }
    const parsed = aiProposalSchema.safeParse(body.proposal);
    if (!parsed.success) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Proposal body failed schema validation.",
        statusCode: 400,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    if (parsed.data.proposalId !== proposalId) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message:
          "Proposal body proposalId does not match the URL path parameter.",
        statusCode: 400,
        details: {
          urlProposalId: proposalId,
          bodyProposalId: parsed.data.proposalId,
        },
      });
    }
    const proposal = parsed.data;
    parsedProposal = proposal;

    // SPEC-014 §Post-Accept Undo Window: body/frontmatter undo MUST
    // ship the post-apply draft revision so the server can refuse a
    // replay that would clobber a concurrent edit. The apply call
    // returns it on `result.document.draftRevision`; the client
    // stamps it onto the proposal on accept. A request that omits
    // it is a programming error, not a transient failure.
    const isBodyOrFrontmatterKind =
      proposal.kind === "replace_selection" ||
      proposal.kind === "insert_block" ||
      proposal.kind === "update_frontmatter";
    if (isBodyOrFrontmatterKind && typeof postApplyDraftRevision !== "number") {
      throw invalidInput(
        "postApplyDraftRevision is required for body/frontmatter undo.",
        { field: "postApplyDraftRevision", proposalKind: proposal.kind },
      );
    }

    // For every kind except `create_document`, the proposal already
    // pins the target document. Allowing the request body documentId
    // to diverge would let a caller replay the proposal's captured
    // priorDraft (or restore-from-trash, or soft-delete) onto an
    // unrelated document the caller happens to have write access to.
    // The proposal's documentId is the canonical target; refuse a
    // mismatch up front so the audit + mutation paths only ever see
    // a consistent pair.
    if (
      proposal.kind !== "create_document" &&
      proposal.documentId !== documentId
    ) {
      throw invalidInput(
        "Request documentId does not match the proposal's target document.",
        {
          field: "documentId",
          proposalKind: proposal.kind,
          requestDocumentId: documentId,
          proposalDocumentId: proposal.documentId,
        },
      );
    }

    // Undo authorization mirrors the action being reverted:
    //   create_document  → content:delete (we are deleting the doc)
    //   delete_document  → content:write  (we are restoring the doc)
    //   edit kinds       → content:write
    const requiredScope =
      proposal.kind === "create_document" ? "content:delete" : "content:write";
    const aiAuth = await options.authorize(request, {
      requiredScope,
      project: proposal.project,
      environment: proposal.environment,
    });
    resolvedActorId = aiAuth.actorId;

    const expected = await options.schemaHashLookup({
      project: proposal.project,
      environment: proposal.environment,
    });
    ensureSchemaHashMatch(expected, schemaHash);

    const priorDraft = ensurePriorDraftPayload(body.priorDraft);

    const undoResult = await applyAiProposalUndo({
      proposal,
      documentId,
      expectedSchemaHash: schemaHash,
      actorId: aiAuth.actorId,
      store: options.contentStore,
      ...(priorDraft ? { priorDraft } : {}),
      ...(typeof postApplyDraftRevision === "number"
        ? { postApplyDraftRevision }
        : {}),
    });

    emitAudit(
      options.emitAudit,
      buildLifecycleAudit({
        proposal,
        outcome: "undone",
        occurredAt,
        actorId: aiAuth.actorId,
        documentId,
      }),
    );

    return new Response(
      JSON.stringify({
        data: { proposal, document: undoResult.document },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (error) {
    if (parsedProposal) {
      const code =
        error instanceof RuntimeError ? error.code : "INTERNAL_ERROR";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      emitAudit(
        options.emitAudit,
        buildLifecycleAudit({
          proposal: parsedProposal,
          outcome: "undo_failed",
          occurredAt,
          ...(resolvedActorId ? { actorId: resolvedActorId } : {}),
          ...(resolvedDocumentId ? { documentId: resolvedDocumentId } : {}),
          errorCode: code,
          errorMessage,
        }),
      );
    }
    return toRuntimeErrorResponse(error);
  }
}

async function handleProposalReject(
  request: Request,
  proposalId: string,
  options: MountAiRoutesOptions,
): Promise<Response> {
  const occurredAt = new Date();

  try {
    await options.requireCsrf(request);
    assertRequestTargetRouting(request, "project_environment");

    const rawBody = (await readJsonBody<{ proposal?: unknown }>(request)) ?? {};

    // Dual-path: chat surface persists proposals client-side and posts
    // the body back to reject; inline transforms still rely on the
    // in-memory proposal store.
    let proposal: AiProposal;
    let proposalFromStore = false;
    if (rawBody.proposal !== undefined) {
      const parsed = aiProposalSchema.safeParse(rawBody.proposal);
      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: "Proposal body failed schema validation.",
          statusCode: 400,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
      }
      if (parsed.data.proposalId !== proposalId) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            "Proposal body proposalId does not match the URL path parameter.",
          statusCode: 400,
        });
      }
      proposal = parsed.data;
    } else {
      const observed = options.proposalStore.observe(proposalId);
      if (!observed) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "AI proposal not found.",
          statusCode: 404,
          details: { proposalId },
        });
      }
      if (observed.status === "expired") {
        emitAudit(
          options.emitAudit,
          buildLifecycleAudit({
            proposal: observed.proposal,
            outcome: "expired",
            occurredAt,
            actorId: observed.createdByActorId,
            errorCode: "AI_PROPOSAL_EXPIRED",
          }),
        );
        throw new RuntimeError({
          code: "AI_PROPOSAL_EXPIRED",
          message: "AI proposal has expired.",
          statusCode: 410,
          details: { proposalId, status: observed.status },
        });
      }
      if (observed.status !== "pending") {
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message: "AI proposal has already been resolved.",
          statusCode: 409,
          details: { proposalId, status: observed.status },
        });
      }
      proposal = observed.proposal;
      proposalFromStore = true;
    }

    const aiAuth = await options.authorize(request, {
      requiredScope: "ai:use",
      project: proposal.project,
      environment: proposal.environment,
    });

    const rejectedProposal = proposalFromStore
      ? options.proposalStore.markRejected({
          proposalId,
          actorId: aiAuth.actorId,
        }).proposal
      : proposal;

    emitAudit(
      options.emitAudit,
      buildLifecycleAudit({
        proposal: rejectedProposal,
        outcome: "rejected",
        occurredAt,
        actorId: aiAuth.actorId,
      }),
    );

    return new Response(
      JSON.stringify({
        data: { proposal: rejectedProposal },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (error) {
    return toRuntimeErrorResponse(error);
  }
}

// Chat-message endpoint — POST /api/v1/ai/chat/messages

/**
 * Actions the client could conceivably ask for that the chat surface
 * NEVER produces. These cover deployment, schema, permission, and
 * provider-config changes that have no AI-mediated path; the wire
 * contract rejects them up-front rather than letting them reach the
 * orchestrator. This is the "hard denylist" in SPEC-014.
 */
const ALWAYS_DENIED_ACTIONS = new Set([
  "publish",
  "restore",
  "schema_change",
  "env_change",
  "project_change",
  "role_change",
  "provider_change",
]);

const PROPOSAL_KIND_TO_ACTION: Record<AiProposalKind, AiChatAllowedAction> = {
  replace_selection: "edit_document",
  insert_block: "edit_document",
  update_frontmatter: "edit_document",
  create_document: "create_document",
  delete_document: "delete_document",
};

type ChatCapabilities = {
  canWrite: boolean;
  canDelete: boolean;
};

/**
 * Resolve which action kinds the caller is allowed to receive
 * proposals for, given the client's `allowedActions` hint and the
 * caller's actual capabilities. Returns the **intersection** — a
 * conservative defaults-to-deny rule keeps the chat surface from
 * leaking proposal shapes the caller couldn't apply anyway.
 */
function resolveEffectiveAllowedActions(
  requested: readonly string[] | undefined,
  capabilities: ChatCapabilities,
): Set<AiChatAllowedAction> {
  // The wire-level schema is permissive (`nonEmptyString`) so the route
  // can surface `AI_UNSUPPORTED_ACTION` for denylisted actions rather
  // than letting Zod reject them with `INVALID_INPUT`. Filter the input
  // down to the known action vocabulary here; anything else falls
  // through and the denylist guard above will throw.
  const knownActions = new Set<AiChatAllowedAction>([
    "answer",
    "edit_document",
    "create_document",
    "delete_document",
  ]);
  const requestedSet = new Set<AiChatAllowedAction>(
    requested && requested.length > 0
      ? requested.filter((value): value is AiChatAllowedAction =>
          knownActions.has(value as AiChatAllowedAction),
        )
      : ["answer", "edit_document", "create_document", "delete_document"],
  );

  const allowed = new Set<AiChatAllowedAction>();
  if (requestedSet.has("answer")) {
    allowed.add("answer");
  }
  if (requestedSet.has("edit_document") && capabilities.canWrite) {
    allowed.add("edit_document");
  }
  if (requestedSet.has("create_document") && capabilities.canWrite) {
    allowed.add("create_document");
  }
  if (requestedSet.has("delete_document") && capabilities.canDelete) {
    allowed.add("delete_document");
  }
  return allowed;
}

function unsupportedAction(
  message: string,
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "AI_UNSUPPORTED_ACTION",
    message,
    statusCode: 403,
    details,
  });
}

/**
 * Build a regenerate-context prefix for the orchestrator instruction
 * when the chat turn is a reject-with-feedback follow-up. Surfacing the
 * prior proposal's summary + first-operation hint to the model is what
 * makes "regenerate" meaningfully different from "ignore the previous
 * turn entirely" — without it, the model would re-emit the same kind
 * of proposal it just produced.
 *
 * Empty string when there's no prior proposal (e.g. a fresh turn). Each
 * caller concatenates the prefix in front of its own instruction so the
 * orchestrator's prompt builder still sees the user's actual message at
 * the end.
 */
function buildRegenerateInstructionPrefix(
  prior: AiProposal | undefined,
  feedback: string | undefined,
): string {
  if (!prior) return "";
  const op = prior.operations[0];
  let priorSummary = `Previously you proposed (${prior.kind}): ${prior.summary}.`;
  if (op?.op === "replace_selection") {
    priorSummary += ` Original selection: ${op.originalText.slice(0, 200)}. Proposed replacement: ${op.replacementText.slice(0, 200)}.`;
  } else if (op?.op === "insert_block") {
    priorSummary += ` Proposed insertion: ${op.bodyMdx.slice(0, 200)}.`;
  } else if (op?.op === "update_frontmatter") {
    priorSummary += ` Proposed frontmatter patch: ${JSON.stringify(op.patch).slice(0, 200)}.`;
  } else if (op?.op === "create_document") {
    priorSummary += ` Proposed new document at ${op.path}.`;
  } else if (op?.op === "delete_document") {
    priorSummary += ` Proposed deletion of ${op.path}.`;
  }
  const feedbackLine = feedback?.trim()
    ? ` The user rejected it with this feedback: ${feedback.trim()}.`
    : " The user rejected it without leaving feedback.";
  return `${priorSummary}${feedbackLine} Generate an alternative that addresses the feedback. User's regenerate prompt: `;
}

/**
 * Result of `prepareChatTurn` — everything both the JSON handler and
 * the SSE streaming handler need to drive the orchestrator and assemble
 * the final assistant turn.
 */
type ChatTurnPreparation = {
  body: AiChatMessageRequest;
  project: string;
  environment: string;
  aiAuth: { actorId: string };
  effectiveAllowed: Set<AiChatAllowedAction>;
  attachedDocument: ContentDocumentResponse | undefined;
  chatInput: import("./orchestrator.js").AiChatInput;
};

function resolveFreshChatSelection(
  body: AiChatMessageRequest,
  attachedDocument: ContentDocumentResponse | undefined,
) {
  if (!body.attachedSelection || !attachedDocument) return undefined;
  return attachedDocument.draftRevision === body.attachedSelection.draftRevision
    ? body.attachedSelection
    : undefined;
}

function buildComponentReferenceBackend(
  references: readonly AiComponentReference[] | undefined,
): import("./chat-tools.js").ChatToolDeps["getComponentReferenceBackend"] {
  if (!references || references.length === 0) {
    return undefined;
  }

  const byName = new Map<string, AiComponentReference>();
  for (const reference of references) {
    if (!byName.has(reference.componentName)) {
      byName.set(reference.componentName, reference);
    }
  }

  return async ({ componentName }) => byName.get(componentName);
}

/**
 * Shared chat-turn prep: CSRF, parsing, auth + capability probe,
 * regenerate-prefix resolution, attached-doc loading, project-knowledge
 * fetch, and final `AiChatInput` construction. Throws RuntimeError on
 * any pre-orchestrator failure so the handler can return a normal HTTP
 * error before opening a stream.
 */
async function prepareChatTurn(
  request: Request,
  options: MountAiRoutesOptions,
): Promise<ChatTurnPreparation> {
  await options.requireCsrf(request);
  const routing = assertRequestTargetRouting(request, "project_environment");
  const rawBody = await readJsonBody<unknown>(request);
  const parsed = aiChatMessageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    throw invalidInput(first?.message ?? "Invalid chat message payload.", {
      field: first?.path?.join(".") ?? "body",
      issues: parsed.error.issues,
    });
  }
  const body: AiChatMessageRequest = parsed.data;

  const project = routing.project as string;
  const environment = routing.environment as string;

  const aiAuth = await options.authorize(request, {
    requiredScope: "ai:use",
    project,
    environment,
  });

  if (body.allowedActions) {
    for (const requested of body.allowedActions) {
      if (ALWAYS_DENIED_ACTIONS.has(requested)) {
        throw unsupportedAction(
          `Action "${requested}" is never allowed via the AI chat surface.`,
          { requestedAction: requested },
        );
      }
    }
  }

  const capabilities: ChatCapabilities = { canWrite: false, canDelete: false };
  try {
    await options.authorize(request, {
      requiredScope: "content:write",
      project,
      environment,
    });
    capabilities.canWrite = true;
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.statusCode !== 403)
      throw error;
  }
  try {
    await options.authorize(request, {
      requiredScope: "content:delete",
      project,
      environment,
    });
    capabilities.canDelete = true;
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.statusCode !== 403)
      throw error;
  }

  const effectiveAllowed = resolveEffectiveAllowedActions(
    body.allowedActions,
    capabilities,
  );

  let priorProposal: AiProposal | undefined;
  if (body.rejectedProposal) {
    const parsedProposal = aiProposalSchema.safeParse(body.rejectedProposal);
    if (!parsedProposal.success) {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "rejectedProposal failed schema validation.",
        statusCode: 400,
        details: {
          issues: parsedProposal.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    priorProposal = parsedProposal.data;
  } else if (body.rejectedProposalId) {
    const priorRecord = options.proposalStore.peek(body.rejectedProposalId);
    if (!priorRecord) {
      throw new RuntimeError({
        code: "NOT_FOUND",
        message: "Rejected proposal not found.",
        statusCode: 404,
        details: { proposalId: body.rejectedProposalId },
      });
    }
    priorProposal = priorRecord.proposal;
  }
  const regenerateInstructionPrefix = buildRegenerateInstructionPrefix(
    priorProposal,
    body.rejectionFeedback,
  );

  const primaryDocumentId =
    body.attachedSelection?.documentId ??
    (body.attachedDocumentIds && body.attachedDocumentIds.length > 0
      ? body.attachedDocumentIds[0]
      : undefined);

  const additionalDocumentIds = (() => {
    const ids = body.attachedDocumentIds ?? [];
    const out: string[] = [];
    for (const id of ids) {
      if (id !== primaryDocumentId && !out.includes(id)) out.push(id);
    }
    return out;
  })();

  let attachedDocument: ContentDocumentResponse | undefined;
  const additionalDocuments: ContentDocumentResponse[] = [];
  if (primaryDocumentId || additionalDocumentIds.length > 0) {
    await options.authorize(request, {
      requiredScope: "content:read:draft",
      project,
      environment,
    });
    if (primaryDocumentId) {
      const ctx = await options.contextResolver.loadDraftContext({
        request,
        project,
        environment,
        documentId: primaryDocumentId,
      });
      attachedDocument = ctx.document;
    }
    for (const docId of additionalDocumentIds) {
      try {
        const ctx = await options.contextResolver.loadDraftContext({
          request,
          project,
          environment,
          documentId: docId,
        });
        additionalDocuments.push(ctx.document);
      } catch {
        // Skip silently. The proposal target is still the primary doc.
      }
    }
  }

  const additionalContextDocs =
    additionalDocuments.length > 0
      ? additionalDocuments.map((doc) => ({
          documentId: doc.documentId,
          path: doc.path,
          type: doc.type,
          locale: doc.locale,
          draftRevision: doc.draftRevision,
          ...(doc.body ? { body: doc.body } : {}),
          ...(doc.frontmatter ? { frontmatter: doc.frontmatter } : {}),
        }))
      : undefined;

  const attachedSelectionForChat = resolveFreshChatSelection(
    body,
    attachedDocument,
  );

  const conversationHistory =
    body.conversationHistory && body.conversationHistory.length > 0
      ? body.conversationHistory.map((turn) => ({
          role: turn.role,
          text: turn.text,
        }))
      : undefined;

  const chatCapabilities = {
    canEditDocument: effectiveAllowed.has("edit_document"),
    canCreateDocument: effectiveAllowed.has("create_document"),
    canDeleteDocument: effectiveAllowed.has("delete_document"),
    canReadEntries: Boolean(options.listEntries),
  };

  const [registeredTypes, supportedLocales, currentUser] = await Promise.all([
    options.contentTypesLookup
      ? options.contentTypesLookup({ project, environment })
      : Promise.resolve([]),
    options.supportedLocalesLookup
      ? options.supportedLocalesLookup({ project, environment })
      : Promise.resolve<string[]>([]),
    options.userLookup
      ? options.userLookup({ userId: aiAuth.actorId }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const getComponentReference = buildComponentReferenceBackend(
    body.componentReferences,
  );

  const chatInput: import("./orchestrator.js").AiChatInput = {
    message: `${regenerateInstructionPrefix}${body.message}`,
    project,
    environment,
    ...(attachedDocument
      ? {
          activeDocument: {
            documentId: attachedDocument.documentId,
            path: attachedDocument.path,
            type: attachedDocument.type,
            locale: attachedDocument.locale,
            draftRevision: attachedDocument.draftRevision,
            body: attachedDocument.body,
            frontmatter: attachedDocument.frontmatter,
            hasPublishedVersion: attachedDocument.publishedVersion !== null,
          },
        }
      : {}),
    ...(attachedSelectionForChat
      ? {
          attachedSelection: {
            selectionId: attachedSelectionForChat.selectionId,
            text: attachedSelectionForChat.text,
          },
        }
      : {}),
    ...(additionalContextDocs ? { additionalContextDocs } : {}),
    ...(conversationHistory ? { conversationHistory } : {}),
    capabilities: chatCapabilities,
    projectKnowledge: {
      registeredTypes,
      supportedLocales,
      ...(currentUser ? { currentUser } : {}),
    },
    ...(body.mdxCatalog ? { mdxCatalog: body.mdxCatalog } : {}),
    ...(options.listEntries || options.getEntry || getComponentReference
      ? {
          toolBackends: {
            ...(options.listEntries
              ? {
                  findEntries: (input: {
                    type: string;
                    query?: string;
                    locale?: string;
                    limit?: number;
                  }) =>
                    options.listEntries!({
                      project,
                      environment,
                      ...input,
                    }),
                }
              : {}),
            ...(options.getEntry
              ? {
                  getEntry: (input: { documentId: string }) =>
                    options.getEntry!({
                      project,
                      environment,
                      documentId: input.documentId,
                    }),
                }
              : {}),
            ...(getComponentReference ? { getComponentReference } : {}),
          },
        }
      : {}),
  };

  return {
    body,
    project,
    environment,
    aiAuth,
    effectiveAllowed,
    attachedDocument,
    chatInput,
  };
}

async function handleChatMessage(
  request: Request,
  options: MountAiRoutesOptions,
): Promise<Response> {
  const occurredAt = new Date();

  try {
    await options.requireCsrf(request);
    const routing = assertRequestTargetRouting(request, "project_environment");
    const rawBody = await readJsonBody<unknown>(request);
    const parsed = aiChatMessageRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const [first] = parsed.error.issues;
      throw invalidInput(first?.message ?? "Invalid chat message payload.", {
        field: first?.path?.join(".") ?? "body",
        issues: parsed.error.issues,
      });
    }
    const body: AiChatMessageRequest = parsed.data;

    const project = routing.project as string;
    const environment = routing.environment as string;

    const aiAuth = await options.authorize(request, {
      requiredScope: "ai:use",
      project,
      environment,
    });

    // Reject hard-denylist actions before doing any other work, even
    // before resolving capabilities — this is a contract-level guard
    // and should be the cheapest possible 403.
    if (body.allowedActions) {
      for (const requested of body.allowedActions) {
        if (ALWAYS_DENIED_ACTIONS.has(requested)) {
          throw unsupportedAction(
            `Action "${requested}" is never allowed via the AI chat surface.`,
            { requestedAction: requested },
          );
        }
      }
    }

    // Probe content capabilities. These calls double as the explicit
    // capability check the chat needs AND as the place where unrelated
    // auth failures (token expired, wrong project) surface.
    const capabilities: ChatCapabilities = {
      canWrite: false,
      canDelete: false,
    };
    try {
      await options.authorize(request, {
        requiredScope: "content:write",
        project,
        environment,
      });
      capabilities.canWrite = true;
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.statusCode !== 403) {
        throw error;
      }
    }
    try {
      await options.authorize(request, {
        requiredScope: "content:delete",
        project,
        environment,
      });
      capabilities.canDelete = true;
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.statusCode !== 403) {
        throw error;
      }
    }

    const effectiveAllowed = resolveEffectiveAllowedActions(
      body.allowedActions,
      capabilities,
    );

    // Regenerate-with-feedback: load the prior proposal so the
    // orchestrator can see what was rejected and the user's reason.
    // SPEC-014 §POST /api/v1/ai/chat/messages requires the server to
    // "load the prior proposal, apply the user's feedback, and emit a
    // fresh proposal that supersedes the rejected one." Inlining only
    // the feedback string isn't enough — the model wouldn't know what
    // it was being asked to redo.
    //
    // Chat proposals live client-side (localStorage), so the client
    // sends the full prior proposal body when regenerating. Fall back
    // to the in-memory store for backward compatibility (inline-driven
    // regenerates, if any).
    let priorProposal: AiProposal | undefined;
    if (body.rejectedProposal) {
      const parsed = aiProposalSchema.safeParse(body.rejectedProposal);
      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: "rejectedProposal failed schema validation.",
          statusCode: 400,
          details: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        });
      }
      priorProposal = parsed.data;
    } else if (body.rejectedProposalId) {
      const priorRecord = options.proposalStore.peek(body.rejectedProposalId);
      if (!priorRecord) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Rejected proposal not found.",
          statusCode: 404,
          details: { proposalId: body.rejectedProposalId },
        });
      }
      priorProposal = priorRecord.proposal;
    }
    const regenerateInstructionPrefix = buildRegenerateInstructionPrefix(
      priorProposal,
      body.rejectionFeedback,
    );

    // Resolve attached documents. The chat treats the first attached id
    // (or the attachedSelection's documentId) as the "active" document
    // for the turn — that's the proposal target. Remaining ids are loaded
    // as read-only `additionalContextDocs` so the model can reference
    // them in proposal text but never propose direct writes to them.
    const primaryDocumentId =
      body.attachedSelection?.documentId ??
      (body.attachedDocumentIds && body.attachedDocumentIds.length > 0
        ? body.attachedDocumentIds[0]
        : undefined);

    const additionalDocumentIds = (() => {
      const ids = body.attachedDocumentIds ?? [];
      const out: string[] = [];
      for (const id of ids) {
        if (id !== primaryDocumentId && !out.includes(id)) out.push(id);
      }
      return out;
    })();

    let attachedDocument: ContentDocumentResponse | undefined;
    const additionalDocuments: ContentDocumentResponse[] = [];
    if (primaryDocumentId || additionalDocumentIds.length > 0) {
      await options.authorize(request, {
        requiredScope: "content:read:draft",
        project,
        environment,
      });
      if (primaryDocumentId) {
        const ctx = await options.contextResolver.loadDraftContext({
          request,
          project,
          environment,
          documentId: primaryDocumentId,
        });
        attachedDocument = ctx.document;
      }
      // Best-effort: skip any additional id that fails to resolve rather
      // than failing the whole turn — a stale mention chip shouldn't break
      // the user's primary edit request. Sequential to keep the auth + IO
      // ordering simple; the chat composer caps mentions in practice.
      for (const docId of additionalDocumentIds) {
        try {
          const ctx = await options.contextResolver.loadDraftContext({
            request,
            project,
            environment,
            documentId: docId,
          });
          additionalDocuments.push(ctx.document);
        } catch {
          // Skip silently. The proposal target is still the primary doc.
        }
      }
    }

    const additionalContextDocs =
      additionalDocuments.length > 0
        ? additionalDocuments.map((doc) => ({
            documentId: doc.documentId,
            path: doc.path,
            type: doc.type,
            locale: doc.locale,
            draftRevision: doc.draftRevision,
            ...(doc.body ? { body: doc.body } : {}),
            ...(doc.frontmatter ? { frontmatter: doc.frontmatter } : {}),
          }))
        : undefined;

    const attachedSelectionForChat = resolveFreshChatSelection(
      body,
      attachedDocument,
    );

    const conversationHistory =
      body.conversationHistory && body.conversationHistory.length > 0
        ? body.conversationHistory.map((turn) => ({
            role: turn.role,
            text: turn.text,
          }))
        : undefined;

    // Capability-gated tool surface. The model only sees tools whose
    // both the caller's effective allowedActions AND the request's
    // attached-state preconditions are satisfied (e.g. edit/insert/
    // update_frontmatter require an attached document; delete requires
    // both an attached document and `content:delete`).
    const chatCapabilities = {
      canEditDocument: effectiveAllowed.has("edit_document"),
      canCreateDocument: effectiveAllowed.has("create_document"),
      canDeleteDocument: effectiveAllowed.has("delete_document"),
      canReadEntries: Boolean(options.listEntries),
    };

    // Gather per-turn project knowledge in parallel with the existing
    // attached-doc fetch so the round-trip cost is bounded by the
    // longest query, not the sum.
    const [registeredTypes, supportedLocales, currentUser] = await Promise.all([
      options.contentTypesLookup
        ? options.contentTypesLookup({ project, environment })
        : Promise.resolve([]),
      options.supportedLocalesLookup
        ? options.supportedLocalesLookup({ project, environment })
        : Promise.resolve<string[]>([]),
      options.userLookup
        ? options.userLookup({ userId: aiAuth.actorId }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const getComponentReference = buildComponentReferenceBackend(
      body.componentReferences,
    );

    let newProposals: AiProposal[] = [];
    let assistantText: string | undefined;

    try {
      const chatResult = await options.orchestrator.runChat({
        message: `${regenerateInstructionPrefix}${body.message}`,
        project,
        environment,
        ...(attachedDocument
          ? {
              activeDocument: {
                documentId: attachedDocument.documentId,
                path: attachedDocument.path,
                type: attachedDocument.type,
                locale: attachedDocument.locale,
                draftRevision: attachedDocument.draftRevision,
                body: attachedDocument.body,
                frontmatter: attachedDocument.frontmatter,
                hasPublishedVersion: attachedDocument.publishedVersion !== null,
              },
            }
          : {}),
        ...(attachedSelectionForChat
          ? {
              attachedSelection: {
                selectionId: attachedSelectionForChat.selectionId,
                text: attachedSelectionForChat.text,
              },
            }
          : {}),
        ...(additionalContextDocs ? { additionalContextDocs } : {}),
        ...(conversationHistory ? { conversationHistory } : {}),
        capabilities: chatCapabilities,
        projectKnowledge: {
          registeredTypes,
          supportedLocales,
          ...(currentUser ? { currentUser } : {}),
        },
        ...(body.mdxCatalog ? { mdxCatalog: body.mdxCatalog } : {}),
        ...(options.listEntries || options.getEntry || getComponentReference
          ? {
              toolBackends: {
                ...(options.listEntries
                  ? {
                      findEntries: (input: {
                        type: string;
                        query?: string;
                        locale?: string;
                        limit?: number;
                      }) =>
                        options.listEntries!({
                          project,
                          environment,
                          ...input,
                        }),
                    }
                  : {}),
                ...(options.getEntry
                  ? {
                      getEntry: (input: { documentId: string }) =>
                        options.getEntry!({
                          project,
                          environment,
                          documentId: input.documentId,
                        }),
                    }
                  : {}),
                ...(getComponentReference ? { getComponentReference } : {}),
              },
            }
          : {}),
      });
      newProposals = chatResult.proposals;
      assistantText = chatResult.text;
      emitAudit(options.emitAudit, {
        ...chatResult.audit,
        project,
        environment,
        actorId: aiAuth.actorId,
        ...(attachedDocument?.documentId
          ? { documentId: attachedDocument.documentId }
          : {}),
      });
    } catch (error) {
      // `runChat` wraps RuntimeError instances in an OrchestratorFailure
      // along with the audit record — unwrap so we can branch on the
      // underlying error code instead of falling through to a generic
      // INTERNAL_ERROR 500.
      const unwrapped = getOrchestratorFailureRuntimeError(error) ?? error;
      const code =
        unwrapped instanceof RuntimeError ? unwrapped.code : undefined;
      if (code === "AI_DISABLED") {
        assistantText =
          "AI is not yet configured for this server. Set AI_PROVIDER=groq with GROQ_API_KEY=<your key>, or AI_PROVIDER=anthropic with ANTHROPIC_API_KEY=<your key>, in the server environment to enable chat replies.";
      } else if (code === "AI_PROVIDER_UNAVAILABLE") {
        // Surface the underlying provider error to the user in the
        // chat thread (turn-level) rather than failing the whole HTTP
        // call. Provider hiccups (rate limits, transient 5xx, schema
        // rejection) are common; the user can retry from the UI.
        const detail =
          unwrapped instanceof RuntimeError ? unwrapped.message : undefined;
        assistantText = detail
          ? `The AI provider returned an error: ${detail}. Try again in a moment, or rephrase the request.`
          : "The AI provider returned an error. Try again in a moment.";
      } else {
        throw unwrapped;
      }
    }

    // The proposal-builder validates the operation kinds the model
    // emits; we additionally enforce that any proposal the model
    // produced via a tool corresponds to an action the caller is
    // allowed to receive. The tools are capability-gated up front, so
    // this is belt-and-suspenders against a future tool wiring bug.
    const filteredProposals = newProposals.filter((p) =>
      effectiveAllowed.has(PROPOSAL_KIND_TO_ACTION[p.kind]),
    );
    if (newProposals.length > 0 && filteredProposals.length === 0) {
      throw unsupportedAction(
        "Generated proposals were filtered out because the caller is not allowed to receive any of their kinds.",
        {
          generated: newProposals.map((p) => p.kind),
          allowedActions: Array.from(effectiveAllowed),
        },
      );
    }

    // Chat proposals are owned by the client (persisted in localStorage
    // alongside the conversation thread). Apply/reject accept the full
    // proposal body from the client, so we deliberately do NOT insert
    // chat proposals into the in-memory store — that store is only the
    // backing for inline-transform proposals where the client doesn't
    // carry the proposal body.
    const messageId = `m-asst-${occurredAt.getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const assistantMessage: AiChatMessage = {
      id: messageId,
      role: "assistant",
      at: occurredAt.toISOString(),
      ...(assistantText ? { text: assistantText } : {}),
      ...(filteredProposals.length > 0
        ? { proposals: filteredProposals.map((p) => p.proposalId) }
        : {}),
      ...(body.rejectedProposalId
        ? { rejectedProposalId: body.rejectedProposalId }
        : {}),
    };

    return new Response(
      JSON.stringify({
        data: {
          conversationId:
            body.conversationId ??
            `conv-${occurredAt.getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          message: assistantMessage,
          ...(filteredProposals.length > 0
            ? { proposals: filteredProposals }
            : {}),
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  } catch (error) {
    // Surface unexpected errors in server logs — the 500 path turns
    // them into a generic INTERNAL_ERROR for the client, but operators
    // need the stack to debug.
    if (!(error instanceof RuntimeError)) {
      // eslint-disable-next-line no-console
      console.error("[ai.chat] unexpected error in handleChatMessage:", error);
    }
    return toRuntimeErrorResponse(error);
  }
}

/**
 * Serialise an event as SSE: `event: <type>\ndata: <json>\n\n`. The
 * client reads `event.type` to switch behaviour; the rest of the
 * envelope rides as JSON inside `data:`.
 */
function encodeSse(event: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

async function handleChatMessageStream(
  request: Request,
  options: MountAiRoutesOptions,
): Promise<Response> {
  const occurredAt = new Date();

  // Pre-orchestrator failures (auth, parse, denied actions) propagate
  // as a normal HTTP error before the stream opens — the client only
  // commits to SSE consumption after seeing 200 + text/event-stream.
  let prep: ChatTurnPreparation;
  try {
    prep = await prepareChatTurn(request, options);
  } catch (error) {
    if (!(error instanceof RuntimeError)) {
      // eslint-disable-next-line no-console
      console.error("[ai.chat] unexpected error in stream prep:", error);
    }
    return toRuntimeErrorResponse(error);
  }
  const {
    body,
    project,
    environment,
    aiAuth,
    effectiveAllowed,
    attachedDocument,
    chatInput,
  } = prep;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collectedProposals: AiProposal[] = [];
      let assistantText = "";
      let finalAudit: AiAuditRecord | undefined;
      const emitTurnAudit = (audit: AiAuditRecord | undefined) => {
        if (!audit) {
          return;
        }
        emitAudit(options.emitAudit, {
          ...audit,
          project,
          environment,
          actorId: aiAuth.actorId,
          ...(attachedDocument?.documentId
            ? { documentId: attachedDocument.documentId }
            : {}),
        });
      };
      // SSE keepalive: fire a comment-only frame every 15s while the
      // LLM is mid-think. Bun's per-connection idle timeout (default
      // 10s, raised to 255s in http-server.ts) and most proxies
      // (Nginx, Cloudflare, k8s ingress) close sockets that look
      // idle — a `:keep-alive` line keeps the TCP turn fresh without
      // affecting the parsed event stream (the client's SSE parser
      // treats `:`-prefixed lines as no-ops).
      const KEEPALIVE_MS = 15_000;
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(`: keep-alive\n\n`));
        } catch {
          // Controller may be closed already — harmless, the interval
          // is about to clear itself in the finally block.
        }
      }, KEEPALIVE_MS);
      try {
        for await (const event of options.orchestrator.runChatStream(
          chatInput,
        )) {
          if (event.type === "progress") {
            controller.enqueue(encodeSse("progress", event));
          } else if (event.type === "text-delta") {
            controller.enqueue(encodeSse("text-delta", { text: event.text }));
          } else if (event.type === "done") {
            assistantText = event.text;
            collectedProposals.push(...event.proposals);
            finalAudit = event.audit;
          } else if (event.type === "error") {
            finalAudit = event.audit;
            controller.enqueue(
              encodeSse("error", {
                code: event.code,
                message: event.message,
              }),
            );
            emitTurnAudit(finalAudit);
            // No `done` after an `error` — the client closes.
            clearInterval(keepalive);
            controller.close();
            return;
          }
        }
      } catch (error) {
        // Defensive: yield an error event then close cleanly so the
        // client can render a turn-level message even if the
        // orchestrator threw outside of its own error event.
        const code =
          error instanceof RuntimeError ? error.code : "AI_REQUEST_FAILED";
        const message =
          error instanceof Error ? error.message : "AI request failed.";
        // eslint-disable-next-line no-console
        console.error("[ai.chat] unexpected stream error:", error);
        controller.enqueue(encodeSse("error", { code, message }));
        clearInterval(keepalive);
        controller.close();
        return;
      }
      clearInterval(keepalive);

      // Belt-and-suspenders: enforce the caller's allowed actions on
      // the proposals the model produced. Tools are capability-gated
      // up front but this is the canonical filter the JSON handler
      // also runs.
      const filtered = collectedProposals.filter((p) =>
        effectiveAllowed.has(PROPOSAL_KIND_TO_ACTION[p.kind]),
      );

      const messageId = `m-asst-${occurredAt.getTime().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const assistantMessage: AiChatMessage = {
        id: messageId,
        role: "assistant",
        at: occurredAt.toISOString(),
        ...(assistantText ? { text: assistantText.trim() } : {}),
        ...(filtered.length > 0
          ? { proposals: filtered.map((p) => p.proposalId) }
          : {}),
        ...(body.rejectedProposalId
          ? { rejectedProposalId: body.rejectedProposalId }
          : {}),
      };

      emitTurnAudit(finalAudit);

      controller.enqueue(
        encodeSse("done", {
          message: assistantMessage,
          proposals: filtered,
          conversationId: body.conversationId,
        }),
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disable proxy buffering so deltas reach the browser as they
      // arrive (Nginx + similar middleboxes will otherwise hold the
      // stream until it closes).
      "x-accel-buffering": "no",
    },
  });
}

export function mountAiRoutes(
  app: unknown,
  options: MountAiRoutesOptions,
): void {
  const aiApp = app as AiRouteApp;

  aiApp.post?.("/api/v1/ai/inline-transform", ({ request }: any) =>
    handleInlineTransform(request, options),
  );

  aiApp.post?.(
    "/api/v1/ai/proposals/:proposalId/apply",
    ({ request, params }: any) =>
      handleProposalApply(
        request,
        ensureNonEmptyString(params.proposalId, "proposalId"),
        options,
      ),
  );

  aiApp.post?.(
    "/api/v1/ai/proposals/:proposalId/reject",
    ({ request, params }: any) =>
      handleProposalReject(
        request,
        ensureNonEmptyString(params.proposalId, "proposalId"),
        options,
      ),
  );

  aiApp.post?.(
    "/api/v1/ai/proposals/:proposalId/undo",
    ({ request, params }: any) =>
      handleProposalUndo(
        request,
        ensureNonEmptyString(params.proposalId, "proposalId"),
        options,
      ),
  );

  aiApp.post?.("/api/v1/ai/chat/messages", ({ request }: any) =>
    handleChatMessage(request, options),
  );

  aiApp.post?.("/api/v1/ai/chat/messages/stream", ({ request }: any) =>
    handleChatMessageStream(request, options),
  );
}
