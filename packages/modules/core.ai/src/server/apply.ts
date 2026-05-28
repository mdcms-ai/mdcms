import {
  RuntimeError,
  type AiProposal,
  type AiProposalOperation,
  type ContentDocumentResponse,
} from "@mdcms/shared";

export type AiApplyContentScope = {
  project: string;
  environment: string;
};

export type AiApplyContentDocument = ContentDocumentResponse;

export type AiApplyWritePayload = {
  path?: string;
  type?: string;
  locale?: string;
  format?: "md" | "mdx";
  frontmatter?: Record<string, unknown>;
  body?: string;
  draftRevision?: number;
  updatedBy?: string;
  createdBy?: string;
};

export type AiApplyContentStore = {
  getById(
    scope: AiApplyContentScope,
    documentId: string,
    options?: { draft?: boolean },
  ): Promise<AiApplyContentDocument | undefined>;
  update(
    scope: AiApplyContentScope,
    documentId: string,
    payload: AiApplyWritePayload,
    options: {
      expectedSchemaHash: string;
      expectedDraftRevision?: number;
    },
  ): Promise<AiApplyContentDocument>;
  create(
    scope: AiApplyContentScope,
    payload: AiApplyWritePayload & {
      type: string;
      path: string;
      locale: string;
    },
    options: { expectedSchemaHash: string },
  ): Promise<AiApplyContentDocument>;
  softDelete(
    scope: AiApplyContentScope,
    documentId: string,
  ): Promise<AiApplyContentDocument>;
  /**
   * Restore a previously soft-deleted document back to draft state.
   * Mirrors `POST /api/v1/content/:documentId/restore` with
   * `targetStatus=draft`. Used by the post-accept undo path for
   * `delete_document` proposals.
   */
  restore?(
    scope: AiApplyContentScope,
    documentId: string,
  ): Promise<AiApplyContentDocument>;
};

export type AiApplyInput = {
  proposal: AiProposal;
  expectedSchemaHash: string;
  /**
   * Authenticated caller for audit purposes. Document writes pass
   * through the content store WITHOUT this id — `createdBy`/`updatedBy`
   * fall through to the store's `DEFAULT_ACTOR` placeholder, matching
   * the behaviour of the manual content endpoints. The real actor is
   * captured in the AI audit record instead. See
   * `core.ai/server/apply.ts` create/update branches for context.
   */
  actorId: string;
  store: AiApplyContentStore;
};

/**
 * Snapshot of the pre-apply draft state captured at the moment of
 * write. Returned by `applyAiProposal` for body/frontmatter mutating
 * kinds so the post-accept undo path can replay the prior values
 * without storing them server-side. The shape is intentionally simple
 * — body and frontmatter are the only fields content edits touch.
 */
export type AiApplyPriorDraft = {
  body: string;
  frontmatter: Record<string, unknown>;
};

export type AiApplyResult = {
  document: AiApplyContentDocument;
  /**
   * Present only for `replace_selection`, `insert_block`, and
   * `update_frontmatter` proposals. The post-accept undo endpoint
   * replays this payload through `PUT /api/v1/content/:documentId`.
   */
  priorDraft?: AiApplyPriorDraft;
};

export type AiUndoInput = {
  proposal: AiProposal;
  documentId: string;
  expectedSchemaHash: string;
  /**
   * Caller-supplied draft snapshot to replay for body/frontmatter
   * kinds. Required for `replace_selection`, `insert_block`, and
   * `update_frontmatter`; ignored for create/delete kinds.
   */
  priorDraft?: AiApplyPriorDraft;
  /**
   * Post-apply draft revision (the revision the apply call produced).
   * The undo path rejects with `AI_PROPOSAL_CONFLICT` when the live
   * draft has advanced past this — the user edited the doc inside the
   * 6-second window and a blind replay would clobber their work.
   */
  postApplyDraftRevision?: number;
  actorId: string;
  store: AiApplyContentStore;
};

export type AiUndoResult = {
  document: AiApplyContentDocument;
};

function aiProposalConflict(
  message: string,
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "AI_PROPOSAL_CONFLICT",
    message,
    statusCode: 409,
    details,
  });
}

function aiOutputInvalid(
  message: string,
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "AI_OUTPUT_INVALID",
    message,
    statusCode: 422,
    details,
  });
}

function ensureSingleOperation(proposal: AiProposal): AiProposalOperation {
  const [operation] = proposal.operations;

  if (!operation) {
    throw aiOutputInvalid("Proposal has no operations to apply.", {
      proposalId: proposal.proposalId,
    });
  }

  if (proposal.operations.length > 1) {
    throw aiOutputInvalid("Proposal must contain exactly one operation.", {
      proposalId: proposal.proposalId,
      operationCount: proposal.operations.length,
    });
  }

  return operation;
}

function applyReplaceSelection(
  body: string,
  operation: Extract<AiProposalOperation, { op: "replace_selection" }>,
): string {
  const original = operation.originalText;
  const index = body.indexOf(original);

  if (index < 0) {
    throw aiProposalConflict(
      "Original selection text was not found in the current draft body.",
      {
        selectionId: operation.selectionId,
      },
    );
  }

  const last = body.lastIndexOf(original);

  if (index !== last) {
    throw aiProposalConflict(
      "Original selection text appears more than once in the current draft body; refusing to apply ambiguously.",
      {
        selectionId: operation.selectionId,
      },
    );
  }

  return (
    body.slice(0, index) +
    operation.replacementText +
    body.slice(index + original.length)
  );
}

function textAppearsExactlyOnce(body: string, text: string): boolean {
  const index = body.indexOf(text);

  if (index < 0) {
    return false;
  }

  return index === body.lastIndexOf(text);
}

function applyInsertBlock(
  body: string,
  operation: Extract<AiProposalOperation, { op: "insert_block" }>,
): string {
  // TODO: honour `operation.afterSelectionId` for positional insertion
  // once Studio supplies a stable text anchor map in the apply payload.
  // For now we always append; the server-stamped selectionId is used
  // by `replace_selection` proposals but the model has no reliable way
  // to reference an arbitrary post-edit anchor inside the markdown body.
  const insertion = operation.bodyMdx;

  if (body.length === 0) {
    return insertion;
  }

  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${insertion}`;
}

function mergeFrontmatter(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch };
}

/**
 * Apply an AI proposal as a draft mutation through the content store.
 *
 * The function performs operation-specific composition (string-level
 * replacement for `replace_selection`, body append for `insert_block`,
 * shallow merge for `update_frontmatter`, full create for
 * `create_document`) and routes the result through the same content
 * store mutation surface as Studio's normal draft writes.
 *
 * Optimistic concurrency is preserved: existing-document updates pass
 * through `expectedDraftRevision` taken from the proposal, so the
 * underlying store enforces the same conflict semantics as a regular
 * `PUT /api/v1/content/:id`.
 */
export async function applyAiProposal(
  input: AiApplyInput,
): Promise<AiApplyResult> {
  const { proposal, expectedSchemaHash, store } = input;
  // `actorId` is intentionally not destructured into a local — the
  // store calls below fall through to DEFAULT_ACTOR for createdBy/
  // updatedBy. The id is still part of the input shape because the
  // route handler uses it for audit-record emission.
  void input.actorId;
  const scope: AiApplyContentScope = {
    project: proposal.project,
    environment: proposal.environment,
  };
  const operation = ensureSingleOperation(proposal);

  if (proposal.kind === "create_document") {
    if (operation.op !== "create_document") {
      throw aiOutputInvalid(
        "create_document proposal must contain a create_document operation.",
        { proposalId: proposal.proposalId },
      );
    }

    const document = await store.create(
      scope,
      {
        type: proposal.type,
        path: operation.path,
        locale: proposal.locale,
        format: operation.format,
        frontmatter: operation.frontmatter,
        body: operation.body,
        // Intentionally omit `createdBy`/`updatedBy` so the store
        // falls through to the same DEFAULT_ACTOR placeholder the
        // manual content endpoints use. The real actor identity is
        // captured in the AI audit record — the underlying document
        // attribution gap is shared with the manual UI flow and is
        // tracked separately as a follow-up.
      },
      { expectedSchemaHash },
    );
    return { document };
  }

  if (!proposal.documentId) {
    throw aiOutputInvalid(
      "Proposal targets an existing document but is missing documentId.",
      { proposalId: proposal.proposalId },
    );
  }

  const existing = await store.getById(scope, proposal.documentId, {
    draft: true,
  });

  if (!existing || existing.isDeleted) {
    throw new RuntimeError({
      code: "NOT_FOUND",
      message: "Document not found.",
      statusCode: 404,
      details: { documentId: proposal.documentId },
    });
  }

  const hasBaseDraftRevision = typeof proposal.baseDraftRevision === "number";
  const baseDraftRevisionMatches =
    !hasBaseDraftRevision ||
    existing.draftRevision === proposal.baseDraftRevision;
  const canApplyReplaceSelectionAgainstLiveRevision =
    !baseDraftRevisionMatches &&
    operation.op === "replace_selection" &&
    textAppearsExactlyOnce(existing.body, operation.originalText);

  if (
    !baseDraftRevisionMatches &&
    !canApplyReplaceSelectionAgainstLiveRevision
  ) {
    throw aiProposalConflict(
      "Proposal base draft revision no longer matches the live draft.",
      {
        proposalId: proposal.proposalId,
        proposalBaseDraftRevision: proposal.baseDraftRevision,
        currentDraftRevision: existing.draftRevision,
      },
    );
  }

  if (proposal.kind === "delete_document") {
    if (operation.op !== "delete_document") {
      throw aiOutputInvalid(
        "delete_document proposal must contain a delete_document operation.",
        { proposalId: proposal.proposalId },
      );
    }

    // SPEC-014 §Authorization: AI-mediated deletion only applies to
    // draft or unpublished documents. A document with a publishedVersion
    // must first be unpublished through the manual content endpoints,
    // which keeps the AI surface from removing live content as a single
    // accept-click. The proposal-builder also stamps an invalid
    // validation in this case, but the apply path enforces it again so a
    // stale proposal generated before publish can't be replayed.
    if (
      existing.publishedVersion !== null &&
      existing.publishedVersion !== undefined
    ) {
      throw aiProposalConflict(
        "Cannot delete a document with a published version. Unpublish it first via the content endpoints.",
        {
          proposalId: proposal.proposalId,
          documentId: proposal.documentId,
          publishedVersion: existing.publishedVersion,
        },
      );
    }

    // The proposal's `op.path` is a human-readable hint stamped at
    // generation time; the authoritative target is `proposal.documentId`,
    // already verified to exist above. We do not enforce path equality
    // here because content paths can shift via rename without affecting
    // identity, and we already proved we're deleting the doc the model
    // intended via the existing draft load.
    const document = await store.softDelete(scope, proposal.documentId);
    return { document };
  }

  // Snapshot the pre-apply body and frontmatter before the write so the
  // post-accept undo path can replay the prior state without persisting
  // it server-side. `existing.frontmatter` is captured by reference here
  // — the store guarantees frontmatter is a fresh object per fetch.
  const priorDraft: AiApplyPriorDraft = {
    body: existing.body,
    frontmatter: { ...existing.frontmatter },
  };

  let nextBody = existing.body;
  let nextFrontmatter = existing.frontmatter;

  if (operation.op === "replace_selection") {
    nextBody = applyReplaceSelection(existing.body, operation);
  } else if (operation.op === "insert_block") {
    nextBody = applyInsertBlock(existing.body, operation);
  } else if (operation.op === "update_frontmatter") {
    nextFrontmatter = mergeFrontmatter(existing.frontmatter, operation.patch);
  } else {
    throw aiOutputInvalid(
      `Unsupported operation kind "${(operation as { op: string }).op}" for existing document.`,
      { proposalId: proposal.proposalId },
    );
  }

  const document = await store.update(
    scope,
    proposal.documentId,
    {
      body: nextBody,
      frontmatter: nextFrontmatter,
      // Omit `updatedBy` so the store falls through to DEFAULT_ACTOR
      // — same path the manual `PUT /api/v1/content/:id` route takes.
    },
    {
      expectedSchemaHash,
      expectedDraftRevision: hasBaseDraftRevision
        ? canApplyReplaceSelectionAgainstLiveRevision
          ? existing.draftRevision
          : proposal.baseDraftRevision
        : undefined,
    },
  );
  return { document, priorDraft };
}

/**
 * Reverse a previously applied AI proposal. Fans out per kind:
 *
 * - `create_document` → soft-delete the document the apply call created.
 * - `delete_document` → restore the soft-deleted document.
 * - `replace_selection` / `insert_block` / `update_frontmatter` →
 *   re-write the document body and frontmatter to the snapshot the
 *   apply call captured.
 *
 * The undo path rejects with `AI_PROPOSAL_CONFLICT` (409) when the live
 * draft revision has moved past `postApplyDraftRevision` for body /
 * frontmatter kinds — a concurrent edit landed inside the 6-second
 * window and a blind replay would clobber the user's work.
 */
export async function applyAiProposalUndo(
  input: AiUndoInput,
): Promise<AiUndoResult> {
  const { proposal, documentId, expectedSchemaHash, store } = input;
  void input.actorId; // audit-only — store mutations use DEFAULT_ACTOR.
  const scope: AiApplyContentScope = {
    project: proposal.project,
    environment: proposal.environment,
  };

  if (proposal.kind === "create_document") {
    // Soft-delete the newly created document. The store's soft-delete
    // surface is idempotent in practice (already-deleted → no-op), but
    // we still load first so we can report a clean NOT_FOUND for a
    // stale undo (e.g. user manually deleted in another tab).
    const existing = await store.getById(scope, documentId, { draft: true });
    if (!existing || existing.isDeleted) {
      throw new RuntimeError({
        code: "NOT_FOUND",
        message: "Document not found or already deleted.",
        statusCode: 404,
        details: { documentId },
      });
    }
    const document = await store.softDelete(scope, documentId);
    return { document };
  }

  if (proposal.kind === "delete_document") {
    if (!store.restore) {
      throw new RuntimeError({
        code: "AI_PROPOSAL_CONFLICT",
        message:
          "Content store does not support restore — delete_document undo unavailable in this deployment.",
        statusCode: 409,
        details: { documentId },
      });
    }
    // `draft: true` returns the head row regardless of soft-delete
    // state, which is exactly what restore-from-trash needs.
    const existing = await store.getById(scope, documentId, {
      draft: true,
    });
    if (!existing) {
      throw new RuntimeError({
        code: "NOT_FOUND",
        message: "Document not found.",
        statusCode: 404,
        details: { documentId },
      });
    }
    if (!existing.isDeleted) {
      throw aiProposalConflict(
        "Document is not in a deleted state; nothing to restore.",
        { documentId, proposalId: proposal.proposalId },
      );
    }
    const document = await store.restore(scope, documentId);
    return { document };
  }

  // Body / frontmatter kinds: replay the captured snapshot.
  if (!input.priorDraft) {
    throw aiOutputInvalid(
      `Undo for ${proposal.kind} requires a priorDraft snapshot.`,
      { proposalId: proposal.proposalId, documentId },
    );
  }
  // Defense-in-depth: the route handler also enforces this, but direct
  // callers of `applyAiProposalUndo` must not be able to skip the
  // concurrent-edit guard by simply omitting `postApplyDraftRevision`.
  // Without an explicit revision we'd silently overwrite whatever
  // draft state currently exists, which defeats the safety contract
  // SPEC-014 §Post-Accept Undo Window promises.
  if (typeof input.postApplyDraftRevision !== "number") {
    throw aiOutputInvalid(
      `Undo for ${proposal.kind} requires postApplyDraftRevision.`,
      { proposalId: proposal.proposalId, documentId },
    );
  }
  const existing = await store.getById(scope, documentId, { draft: true });
  if (!existing || existing.isDeleted) {
    throw new RuntimeError({
      code: "NOT_FOUND",
      message: "Document not found.",
      statusCode: 404,
      details: { documentId },
    });
  }
  if (existing.draftRevision !== input.postApplyDraftRevision) {
    throw aiProposalConflict(
      "Document has been edited since the AI apply; refusing to clobber concurrent changes.",
      {
        proposalId: proposal.proposalId,
        documentId,
        postApplyDraftRevision: input.postApplyDraftRevision,
        currentDraftRevision: existing.draftRevision,
      },
    );
  }
  const document = await store.update(
    scope,
    documentId,
    {
      body: input.priorDraft.body,
      frontmatter: input.priorDraft.frontmatter,
    },
    {
      expectedSchemaHash,
      expectedDraftRevision: existing.draftRevision,
    },
  );
  return { document };
}
