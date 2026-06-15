import {
  RuntimeError,
  type AiProposal,
  type AiProposalOperation,
} from "@mdcms/shared";

export type AssistantCollaborationPriorDraft = {
  body: string;
  frontmatter: Record<string, unknown>;
};

export type AssistantCollaborationProposalDraftResult = {
  body: string;
  frontmatter: Record<string, unknown>;
  priorDraft: AssistantCollaborationPriorDraft;
};

type ExistingDocumentAiProposal = AiProposal & { documentId: string };

type ReplaceSelectionOperation = Extract<
  AiProposalOperation,
  { op: "replace_selection" }
>;

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

function getSingleOperation(proposal: AiProposal): AiProposalOperation {
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

function findReplaceSelectionMatch(
  body: string,
  operation: ReplaceSelectionOperation,
): number {
  const original = operation.originalText;
  const index = body.indexOf(original);

  if (index < 0) {
    throw aiProposalConflict(
      "Original selection text was not found in the current draft body.",
      { selectionId: operation.selectionId },
    );
  }

  const last = body.lastIndexOf(original);
  if (index !== last) {
    throw aiProposalConflict(
      "Original selection text appears more than once in the current draft body; refusing to apply ambiguously.",
      { selectionId: operation.selectionId },
    );
  }

  return index;
}

function applyReplaceSelection(
  body: string,
  operation: ReplaceSelectionOperation,
): string {
  const index = findReplaceSelectionMatch(body, operation);

  return (
    body.slice(0, index) +
    operation.replacementText +
    body.slice(index + operation.originalText.length)
  );
}

function applyInsertBlock(
  body: string,
  operation: Extract<AiProposalOperation, { op: "insert_block" }>,
): string {
  if (body.length === 0) {
    return operation.bodyMdx;
  }

  const separator = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${separator}${operation.bodyMdx}`;
}

function mergeFrontmatter(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch };
}

function isExistingDocumentEditProposal(
  proposal: AiProposal,
): proposal is ExistingDocumentAiProposal {
  return (
    Boolean(proposal.documentId) &&
    (proposal.kind === "replace_selection" ||
      proposal.kind === "insert_block" ||
      proposal.kind === "update_frontmatter")
  );
}

export function isAssistantCollaborationProposalApplicable({
  proposal,
  documentId,
}: {
  proposal: AiProposal;
  documentId: string;
}): boolean {
  return (
    isExistingDocumentEditProposal(proposal) &&
    proposal.documentId === documentId
  );
}

export function applyAssistantCollaborationProposalDraft({
  proposal,
  documentId,
  body,
  frontmatter,
}: {
  proposal: AiProposal;
  documentId: string;
  body: string;
  frontmatter: Record<string, unknown>;
}): AssistantCollaborationProposalDraftResult {
  if (
    !isAssistantCollaborationProposalApplicable({
      proposal,
      documentId,
    })
  ) {
    throw aiOutputInvalid(
      "Proposal cannot be applied through the active collaboration document.",
      { proposalId: proposal.proposalId, documentId: proposal.documentId },
    );
  }

  const operation = getSingleOperation(proposal);
  if (operation.op !== proposal.kind) {
    throw aiOutputInvalid(
      `Proposal kind "${proposal.kind}" does not match operation kind "${operation.op}".`,
      { proposalId: proposal.proposalId },
    );
  }

  const priorDraft = { body, frontmatter: { ...frontmatter } };
  let nextBody = body;
  let nextFrontmatter = frontmatter;

  if (operation.op === "replace_selection") {
    nextBody = applyReplaceSelection(body, operation);
  } else if (operation.op === "insert_block") {
    nextBody = applyInsertBlock(body, operation);
  } else if (operation.op === "update_frontmatter") {
    nextFrontmatter = mergeFrontmatter(frontmatter, operation.patch);
  } else {
    throw aiOutputInvalid(
      `Unsupported operation kind "${operation.op}" for active collaboration apply.`,
      { proposalId: proposal.proposalId },
    );
  }

  return {
    body: nextBody,
    frontmatter: nextFrontmatter,
    priorDraft,
  };
}
