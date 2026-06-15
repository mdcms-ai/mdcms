import assert from "node:assert/strict";

import { RuntimeError, type AiProposal } from "@mdcms/shared";
import { test } from "bun:test";

import {
  applyAssistantCollaborationProposalDraft,
  isAssistantCollaborationProposalApplicable,
} from "./assistant-collaboration-apply.js";

function buildProposal(overrides: Partial<AiProposal> = {}): AiProposal {
  return {
    proposalId: "proposal_1",
    kind: "replace_selection",
    project: "demo",
    environment: "staging",
    documentId: "doc_1",
    baseDraftRevision: 4,
    type: "page",
    locale: "en",
    summary: "Rewrite intro",
    operations: [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "old intro",
        replacementText: "new intro",
      },
    ],
    validation: { status: "valid" },
    expiresAt: "2026-06-15T10:05:00.000Z",
    provider: {
      providerId: "echo",
      model: "echo-1",
      promptTemplateId: "current_document_edit.v1",
    },
    ...overrides,
  };
}

test("isAssistantCollaborationProposalApplicable only accepts current-document edit proposals", () => {
  assert.equal(
    isAssistantCollaborationProposalApplicable({
      proposal: buildProposal(),
      documentId: "doc_1",
    }),
    true,
  );
  assert.equal(
    isAssistantCollaborationProposalApplicable({
      proposal: buildProposal({ documentId: "doc_2" }),
      documentId: "doc_1",
    }),
    false,
  );
  assert.equal(
    isAssistantCollaborationProposalApplicable({
      proposal: buildProposal({
        kind: "create_document",
        documentId: undefined,
        baseDraftRevision: undefined,
        operations: [
          {
            op: "create_document",
            path: "pages/new",
            format: "mdx",
            frontmatter: {},
            body: "",
          },
        ],
      }),
      documentId: "doc_1",
    }),
    false,
  );
});

test("applyAssistantCollaborationProposalDraft replaces a unique live selection and returns prior draft", () => {
  const result = applyAssistantCollaborationProposalDraft({
    proposal: buildProposal(),
    documentId: "doc_1",
    body: "The old intro is here.",
    frontmatter: { title: "About" },
  });

  assert.equal(result.body, "The new intro is here.");
  assert.deepEqual(result.frontmatter, { title: "About" });
  assert.deepEqual(result.priorDraft, {
    body: "The old intro is here.",
    frontmatter: { title: "About" },
  });
});

test("applyAssistantCollaborationProposalDraft rejects ambiguous replace_selection proposals", () => {
  assert.throws(
    () =>
      applyAssistantCollaborationProposalDraft({
        proposal: buildProposal(),
        documentId: "doc_1",
        body: "old intro\n\nold intro",
        frontmatter: {},
      }),
    (error) =>
      error instanceof RuntimeError && error.code === "AI_PROPOSAL_CONFLICT",
  );
});

test("applyAssistantCollaborationProposalDraft appends insert blocks and merges frontmatter patches", () => {
  const insert = applyAssistantCollaborationProposalDraft({
    proposal: buildProposal({
      kind: "insert_block",
      operations: [{ op: "insert_block", bodyMdx: "<Hero />" }],
    }),
    documentId: "doc_1",
    body: "Existing body.",
    frontmatter: { title: "About" },
  });

  assert.equal(insert.body, "Existing body.\n\n<Hero />");
  assert.deepEqual(insert.frontmatter, { title: "About" });

  const frontmatter = applyAssistantCollaborationProposalDraft({
    proposal: buildProposal({
      kind: "update_frontmatter",
      operations: [
        { op: "update_frontmatter", patch: { title: "Updated", draft: true } },
      ],
    }),
    documentId: "doc_1",
    body: "Existing body.",
    frontmatter: { title: "About", untouched: "yes" },
  });

  assert.equal(frontmatter.body, "Existing body.");
  assert.deepEqual(frontmatter.frontmatter, {
    title: "Updated",
    draft: true,
    untouched: "yes",
  });
});
