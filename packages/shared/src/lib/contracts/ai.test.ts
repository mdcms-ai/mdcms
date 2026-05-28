import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import {
  AI_ERROR_CODES,
  AI_PROPOSAL_KINDS,
  aiChatMessageRequestSchema,
  aiChatMessageResponseSchema,
  aiProposalOperationSchema,
  aiProposalSchema,
  aiProposalValidationSchema,
  assertAiProposal,
  deleteDocumentOperationSchema,
  isAiProposal,
  type AiProposal,
} from "./ai.js";

const baseProvider = {
  providerId: "echo",
  model: "echo-1",
  promptTemplateId: "copy_improvement",
};

const validProposal: AiProposal = {
  proposalId: "p_1",
  kind: "replace_selection",
  project: "demo",
  environment: "draft",
  documentId: "doc_1",
  baseDraftRevision: 4,
  type: "page",
  locale: "en",
  summary: "Tighten the intro",
  operations: [
    {
      op: "replace_selection",
      selectionId: "sel_1",
      originalText: "old",
      replacementText: "new",
    },
  ],
  validation: { status: "valid" },
  expiresAt: "2026-05-01T00:05:00.000Z",
  provider: baseProvider,
};

test("aiProposalSchema accepts a fully populated proposal", () => {
  const parsed = aiProposalSchema.safeParse(validProposal);
  assert.equal(parsed.success, true);
});

test("aiProposalSchema accepts an insert_block proposal without afterSelectionId", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "insert_block",
    operations: [{ op: "insert_block", bodyMdx: "<Callout>Hi</Callout>" }],
  });
  assert.equal(parsed.success, true);
});

test("aiProposalSchema accepts a create_document proposal", () => {
  const {
    documentId: _documentId,
    baseDraftRevision: _baseDraftRevision,
    ...rest
  } = validProposal;
  const parsed = aiProposalSchema.safeParse({
    ...rest,
    kind: "create_document",
    operations: [
      {
        op: "create_document",
        path: "blog/new-post.mdx",
        format: "mdx",
        frontmatter: { title: "New" },
        body: "# Hello",
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("aiProposalSchema rejects create_document proposals carrying source documentId", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "create_document",
    operations: [
      {
        op: "create_document",
        path: "blog/new-post.mdx",
        format: "mdx",
        frontmatter: {},
        body: "# Hi",
      },
    ],
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects create_document proposals carrying baseDraftRevision", () => {
  const { documentId: _documentId, ...rest } = validProposal;
  const parsed = aiProposalSchema.safeParse({
    ...rest,
    kind: "create_document",
    operations: [
      {
        op: "create_document",
        path: "blog/new-post.mdx",
        format: "mdx",
        frontmatter: {},
        body: "# Hi",
      },
    ],
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects proposals with unknown kind", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "rewrite_everything",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects proposals with empty operations", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    operations: [],
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects proposals with non-ISO expiresAt", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    expiresAt: "yesterday",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects date-only expiresAt strings", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    expiresAt: "2026-05-01",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects locale-formatted dates that Date.parse accepts", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    expiresAt: "May 1 2026 12:00:00",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects proposals missing provider metadata", () => {
  const { provider: _provider, ...rest } = validProposal;
  const parsed = aiProposalSchema.safeParse(rest);
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects unknown top-level keys", () => {
  const parsed = aiProposalSchema.safeParse({ ...validProposal, extra: true });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects mismatched kind/operation", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "replace_selection",
    operations: [
      {
        op: "create_document",
        path: "foo.md",
        format: "md",
        frontmatter: {},
        body: "x",
      },
    ],
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema rejects heterogeneous operations", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "replace_selection",
    operations: [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "a",
        replacementText: "b",
      },
      { op: "update_frontmatter", patch: {} },
    ],
  });
  assert.equal(parsed.success, false);
});

test("AI_PROPOSAL_KINDS exposes every spec proposal kind", () => {
  assert.deepEqual([...AI_PROPOSAL_KINDS].sort(), [
    "create_document",
    "delete_document",
    "insert_block",
    "replace_selection",
    "update_frontmatter",
  ]);
});

test("aiProposalOperationSchema accepts a replace_selection operation", () => {
  const parsed = aiProposalOperationSchema.safeParse({
    op: "replace_selection",
    selectionId: "sel_1",
    originalText: "",
    replacementText: "Hi",
  });
  assert.equal(parsed.success, true);
});

test("aiProposalOperationSchema rejects insert_block operations with empty body", () => {
  const parsed = aiProposalOperationSchema.safeParse({
    op: "insert_block",
    bodyMdx: "",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalValidationSchema accepts a valid status", () => {
  assert.equal(
    aiProposalValidationSchema.safeParse({ status: "valid" }).success,
    true,
  );
});

test("aiProposalValidationSchema rejects invalid status with empty error list", () => {
  assert.equal(
    aiProposalValidationSchema.safeParse({ status: "invalid", errors: [] })
      .success,
    false,
  );
});

test("aiProposalValidationSchema accepts invalid status with error entries", () => {
  assert.equal(
    aiProposalValidationSchema.safeParse({
      status: "invalid",
      errors: [{ code: "X", message: "boom" }],
    }).success,
    true,
  );
});

test("assertAiProposal returns when value matches", () => {
  assertAiProposal(validProposal);
});

test("assertAiProposal throws AI_OUTPUT_INVALID for malformed value", () => {
  assert.throws(
    () =>
      assertAiProposal({
        ...validProposal,
        operations: [{ op: "replace_selection", selectionId: "" }],
      }),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "AI_OUTPUT_INVALID" &&
      error.statusCode === 422,
  );
});

test("assertAiProposal carries issue path in details", () => {
  try {
    assertAiProposal({ ...validProposal, expiresAt: "soon" });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof RuntimeError);
    assert.equal((error as RuntimeError).code, "AI_OUTPUT_INVALID");
    assert.equal(typeof (error as RuntimeError).details?.path, "string");
  }
});

test("isAiProposal returns true for valid proposal", () => {
  assert.equal(isAiProposal(validProposal), true);
});

test("isAiProposal returns false for malformed proposal", () => {
  assert.equal(isAiProposal({}), false);
});

// ───────────────────────────────────────────────────────────────────────
// delete_document kind + AI_UNSUPPORTED_ACTION error code
// ───────────────────────────────────────────────────────────────────────

test("AI_PROPOSAL_KINDS includes delete_document", () => {
  assert.ok(AI_PROPOSAL_KINDS.includes("delete_document"));
});

test("AI_ERROR_CODES includes AI_UNSUPPORTED_ACTION", () => {
  assert.ok(AI_ERROR_CODES.includes("AI_UNSUPPORTED_ACTION"));
});

test("deleteDocumentOperationSchema accepts a minimal delete op", () => {
  const parsed = deleteDocumentOperationSchema.safeParse({
    op: "delete_document",
    path: "blog/legacy/2024-12-status.md",
  });
  assert.equal(parsed.success, true);
});

test("deleteDocumentOperationSchema accepts an optional reason", () => {
  const parsed = deleteDocumentOperationSchema.safeParse({
    op: "delete_document",
    path: "blog/legacy/2024-12-status.md",
    reason: "Superseded by /blog/shipping-mdcms-0-4",
  });
  assert.equal(parsed.success, true);
});

test("deleteDocumentOperationSchema rejects an empty path", () => {
  const parsed = deleteDocumentOperationSchema.safeParse({
    op: "delete_document",
    path: "",
  });
  assert.equal(parsed.success, false);
});

test("aiProposalSchema accepts a delete_document proposal", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "delete_document",
    operations: [
      {
        op: "delete_document",
        path: "blog/legacy/2024-12-status.md",
        reason: "stale",
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("aiProposalSchema rejects delete_document with a non-delete operation", () => {
  const parsed = aiProposalSchema.safeParse({
    ...validProposal,
    kind: "delete_document",
    operations: [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "a",
        replacementText: "b",
      },
    ],
  });
  assert.equal(parsed.success, false);
});

test("aiProposalOperationSchema accepts the delete_document variant in the union", () => {
  const parsed = aiProposalOperationSchema.safeParse({
    op: "delete_document",
    path: "blog/stale.md",
  });
  assert.equal(parsed.success, true);
});

// ───────────────────────────────────────────────────────────────────────
// Chat-message request/response schemas
// ───────────────────────────────────────────────────────────────────────

test("aiChatMessageRequestSchema accepts a minimal message", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "Tighten the lede",
  });
  assert.equal(parsed.success, true);
});

test("aiChatMessageRequestSchema accepts a fully populated request", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "Apply this across all drafts",
    conversationId: "conv_1",
    attachedDocumentIds: ["doc_1", "doc_2"],
    attachedSelection: {
      documentId: "doc_1",
      draftRevision: 4,
      selectionId: "sel_1",
      text: "selected paragraph",
    },
    rejectedProposalId: "p_prev",
    rejectionFeedback: "Keep the original tone please.",
    allowedActions: ["answer", "edit_document"],
    mdxCatalog: {
      components: [
        {
          name: "Callout",
          importPath: "@/components/mdx/Callout",
          extractedProps: {
            tone: { type: "enum", required: true, values: ["info"] },
          },
        },
      ],
    },
    componentReferences: [
      {
        componentName: "HomeHero",
        source: "studio_host_preview",
        renderedHtml:
          '<section class="landing-hero"><h1>Content operations</h1></section>',
        text: "Content operations",
        styleSummary:
          "section.landing-hero { display: block; backgroundColor: rgb(15, 23, 42); color: rgb(248, 250, 252) }",
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("aiChatMessageRequestSchema rejects rejectionFeedback without rejectedProposalId", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "regenerate",
    rejectionFeedback: "try again",
  });
  assert.equal(parsed.success, false);
});

test("aiChatMessageRequestSchema accepts unknown allowedActions strings (route-level denylist owns rejection)", () => {
  // The wire-level schema is intentionally permissive: SPEC-014 requires
  // the chat route to surface `AI_UNSUPPORTED_ACTION` (403) for
  // permanently-denied actions, which only fires if the action makes it
  // past Zod parsing. The route-level `ALWAYS_DENIED_ACTIONS` set is
  // what enforces the contract.
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "publish this",
    allowedActions: ["publish"],
  });
  assert.equal(parsed.success, true);
});

test("aiChatMessageRequestSchema still rejects empty allowedActions strings", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "ok",
    allowedActions: [""],
  });
  assert.equal(parsed.success, false);
});

test("aiChatMessageRequestSchema rejects empty message", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({ message: "" });
  assert.equal(parsed.success, false);
});

test("aiChatMessageRequestSchema rejects unknown top-level keys", () => {
  const parsed = aiChatMessageRequestSchema.safeParse({
    message: "ok",
    extra: true,
  });
  assert.equal(parsed.success, false);
});

test("aiChatMessageResponseSchema accepts a response without proposals", () => {
  const parsed = aiChatMessageResponseSchema.safeParse({
    conversationId: "conv_1",
    message: {
      id: "m_1",
      role: "assistant",
      at: "2026-05-10T10:00:00.000Z",
      text: "Here you go.",
    },
  });
  assert.equal(parsed.success, true);
});

test("aiChatMessageResponseSchema accepts a response with proposals", () => {
  const parsed = aiChatMessageResponseSchema.safeParse({
    conversationId: "conv_1",
    message: {
      id: "m_1",
      role: "assistant",
      at: "2026-05-10T10:00:00.000Z",
      proposals: [validProposal.proposalId],
    },
    proposals: [validProposal],
  });
  assert.equal(parsed.success, true);
});

test("aiChatMessageResponseSchema rejects a malformed message role", () => {
  const parsed = aiChatMessageResponseSchema.safeParse({
    conversationId: "conv_1",
    message: {
      id: "m_1",
      role: "system",
      at: "2026-05-10T10:00:00.000Z",
    },
  });
  assert.equal(parsed.success, false);
});
