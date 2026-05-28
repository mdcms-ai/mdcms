import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  RuntimeError,
  type AiProposal,
  type ContentDocumentResponse,
} from "@mdcms/shared";

import {
  applyAiProposal,
  applyAiProposalUndo,
  type AiApplyContentStore,
  type AiApplyWritePayload,
} from "./apply.js";

function buildDocument(
  overrides: Partial<ContentDocumentResponse> = {},
): ContentDocumentResponse {
  return {
    documentId: "doc_1",
    translationGroupId: "tg_1",
    project: "demo",
    environment: "draft",
    path: "blog/welcome",
    type: "page",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: true,
    version: 1,
    publishedVersion: null,
    draftRevision: 4,
    frontmatter: { title: "Welcome" },
    body: "Welcome to the site.",
    createdBy: "user_1",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedBy: "user_1",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildProposal(overrides: Partial<AiProposal> = {}): AiProposal {
  return {
    proposalId: overrides.proposalId ?? "p_1",
    kind: overrides.kind ?? "replace_selection",
    project: overrides.project ?? "demo",
    environment: overrides.environment ?? "draft",
    documentId: overrides.documentId ?? "doc_1",
    baseDraftRevision: overrides.baseDraftRevision ?? 4,
    type: overrides.type ?? "page",
    locale: overrides.locale ?? "en",
    summary: overrides.summary ?? "Replace the greeting.",
    operations: overrides.operations ?? [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "Welcome to the site.",
        replacementText: "Hi there!",
      },
    ],
    validation: overrides.validation ?? { status: "valid" },
    expiresAt: overrides.expiresAt ?? "2026-05-01T00:05:00.000Z",
    provider: overrides.provider ?? {
      providerId: "echo",
      model: "echo-1",
      promptTemplateId: "copy_improvement.v1",
    },
  };
}

type StubStoreState = {
  document: ContentDocumentResponse;
  updateCalls: Array<{
    documentId: string;
    payload: AiApplyWritePayload;
    options: { expectedSchemaHash: string; expectedDraftRevision?: number };
  }>;
  createCalls: Array<{
    payload: AiApplyWritePayload;
    options: { expectedSchemaHash: string };
  }>;
  softDeleteCalls: Array<{ documentId: string }>;
  restoreCalls?: Array<{ documentId: string }>;
};

function createStubStore(state: StubStoreState): AiApplyContentStore {
  return {
    async getById(_scope, documentId) {
      if (documentId !== state.document.documentId) {
        return undefined;
      }
      return state.document;
    },
    async update(_scope, documentId, payload, options) {
      state.updateCalls.push({ documentId, payload, options });
      return {
        ...state.document,
        body: payload.body ?? state.document.body,
        frontmatter: payload.frontmatter ?? state.document.frontmatter,
        draftRevision: state.document.draftRevision + 1,
      };
    },
    async create(_scope, payload, options) {
      state.createCalls.push({ payload, options });
      return {
        ...state.document,
        documentId: "doc_new",
        path: payload.path ?? state.document.path,
        body: payload.body ?? "",
        frontmatter: payload.frontmatter ?? {},
        draftRevision: 0,
        version: 0,
      };
    },
    async softDelete(_scope, documentId) {
      state.softDeleteCalls.push({ documentId });
      return { ...state.document, isDeleted: true };
    },
    async restore(_scope, documentId) {
      state.restoreCalls = state.restoreCalls ?? [];
      state.restoreCalls.push({ documentId });
      return { ...state.document, isDeleted: false };
    },
  };
}

describe("applyAiProposal", () => {
  test("replace_selection updates the body through the content store", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const result = await applyAiProposal({
      proposal: buildProposal(),
      expectedSchemaHash: "hash_1",
      actorId: "user_99",
      store,
    });

    assert.equal(state.updateCalls.length, 1);
    const call = state.updateCalls[0]!;
    assert.equal(call.documentId, "doc_1");
    assert.equal(call.payload.body, "Hi there!");
    // `updatedBy` is intentionally NOT set on AI applies — the store
    // falls through to its DEFAULT_ACTOR placeholder, matching the
    // manual content endpoints. Real actor identity is recorded in
    // the AI audit log instead.
    assert.equal(call.payload.updatedBy, undefined);
    assert.equal(call.options.expectedDraftRevision, 4);
    assert.equal(call.options.expectedSchemaHash, "hash_1");
    assert.equal(result.document.body, "Hi there!");
    assert.ok(
      result.priorDraft,
      "replace_selection apply must return a priorDraft snapshot for undo",
    );
    assert.equal(result.priorDraft!.body, "Welcome to the site.");
    assert.deepEqual(result.priorDraft!.frontmatter, { title: "Welcome" });
  });

  test("conflict when original selection text is missing in body", async () => {
    const state: StubStoreState = {
      document: buildDocument({ body: "Different body content." }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: buildProposal(),
          expectedSchemaHash: "hash_1",
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROPOSAL_CONFLICT" &&
        error.statusCode === 409,
    );
    assert.equal(state.updateCalls.length, 0);
  });

  test("replace_selection applies when base draft revision changed but source text still exists", async () => {
    const state: StubStoreState = {
      document: buildDocument({
        draftRevision: 6,
        body: "Draft prefix.\n\nWelcome to the site.",
      }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const result = await applyAiProposal({
      proposal: buildProposal({ baseDraftRevision: 4 }),
      expectedSchemaHash: "hash_1",
      actorId: "user_99",
      store,
    });

    assert.equal(state.updateCalls.length, 1);
    const call = state.updateCalls[0]!;
    assert.equal(call.payload.body, "Draft prefix.\n\nHi there!");
    assert.equal(call.options.expectedDraftRevision, 6);
    assert.equal(result.document.body, "Draft prefix.\n\nHi there!");
  });

  test("insert_block base draft revision mismatch is reported as conflict", async () => {
    const state: StubStoreState = {
      document: buildDocument({ draftRevision: 6 }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: buildProposal({
            kind: "insert_block",
            baseDraftRevision: 4,
            operations: [
              {
                op: "insert_block",
                afterSelectionId: "sel_1",
                bodyMdx: "New block.",
              },
            ],
          }),
          expectedSchemaHash: "hash_1",
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_PROPOSAL_CONFLICT",
    );
    assert.equal(state.updateCalls.length, 0);
  });

  test("update_frontmatter merges patch", async () => {
    const state: StubStoreState = {
      document: buildDocument({
        frontmatter: { title: "Welcome", description: "Old" },
      }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await applyAiProposal({
      proposal: buildProposal({
        kind: "update_frontmatter",
        operations: [
          {
            op: "update_frontmatter",
            patch: { description: "New description" },
          },
        ],
      }),
      expectedSchemaHash: "hash_1",
      actorId: "user_42",
      store,
    });

    const call = state.updateCalls[0]!;
    assert.deepEqual(call.payload.frontmatter, {
      title: "Welcome",
      description: "New description",
    });
  });

  test("create_document calls store.create instead of update", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await applyAiProposal({
      proposal: buildProposal({
        proposalId: "p_2",
        kind: "create_document",
        documentId: undefined,
        baseDraftRevision: undefined,
        operations: [
          {
            op: "create_document",
            path: "blog/new-post",
            format: "mdx",
            frontmatter: { title: "New" },
            body: "Body of the new post.",
          },
        ],
      }),
      expectedSchemaHash: "hash_2",
      actorId: "user_42",
      store,
    });

    assert.equal(state.updateCalls.length, 0);
    assert.equal(state.createCalls.length, 1);
    const call = state.createCalls[0]!;
    assert.equal(call.payload.path, "blog/new-post");
    assert.equal(call.payload.body, "Body of the new post.");
    assert.deepEqual(call.payload.frontmatter, { title: "New" });
    assert.equal(call.options.expectedSchemaHash, "hash_2");
  });

  test("delete_document calls store.softDelete and bypasses update", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const result = await applyAiProposal({
      proposal: buildProposal({
        proposalId: "p_3",
        kind: "delete_document",
        operations: [
          {
            op: "delete_document",
            path: "blog/welcome",
            reason: "stale",
          },
        ],
      }),
      expectedSchemaHash: "hash_3",
      actorId: "user_42",
      store,
    });

    assert.equal(state.updateCalls.length, 0);
    assert.equal(state.createCalls.length, 0);
    assert.equal(state.softDeleteCalls.length, 1);
    assert.equal(state.softDeleteCalls[0]!.documentId, "doc_1");
    assert.equal(result.document.isDeleted, true);
    assert.equal(
      result.priorDraft,
      undefined,
      "delete_document apply does not return a body/frontmatter priorDraft",
    );
  });

  test("delete_document fails when the document does not exist", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: buildProposal({
            proposalId: "p_4",
            kind: "delete_document",
            documentId: "doc_missing",
            operations: [
              {
                op: "delete_document",
                path: "blog/missing",
              },
            ],
          }),
          expectedSchemaHash: "hash_4",
          actorId: "user_42",
          store,
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "NOT_FOUND" &&
        error.statusCode === 404,
    );

    assert.equal(state.softDeleteCalls.length, 0);
  });

  test("delete_document refuses to delete a published document", async () => {
    const state: StubStoreState = {
      document: buildDocument({ publishedVersion: 3 }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: buildProposal({
            proposalId: "p_published",
            kind: "delete_document",
            operations: [
              {
                op: "delete_document",
                path: "blog/welcome",
              },
            ],
          }),
          expectedSchemaHash: "hash_pub",
          actorId: "user_42",
          store,
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROPOSAL_CONFLICT" &&
        error.statusCode === 409,
    );

    assert.equal(state.softDeleteCalls.length, 0);
  });

  test("delete_document fails when the document is already deleted", async () => {
    const state: StubStoreState = {
      document: buildDocument({ isDeleted: true }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: buildProposal({
            proposalId: "p_5",
            kind: "delete_document",
            operations: [
              {
                op: "delete_document",
                path: "blog/welcome",
              },
            ],
          }),
          expectedSchemaHash: "hash_5",
          actorId: "user_42",
          store,
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "NOT_FOUND" &&
        error.statusCode === 404,
    );

    assert.equal(state.softDeleteCalls.length, 0);
  });

  test("delete_document requires documentId on the proposal", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    // buildProposal coalesces `undefined` overrides back to its default,
    // so strip the field explicitly to exercise the missing-id guard.
    const baseProposal = buildProposal({
      proposalId: "p_6",
      kind: "delete_document",
      operations: [
        {
          op: "delete_document",
          path: "blog/no-id",
        },
      ],
    });
    const { documentId: _ignored, ...withoutId } = baseProposal;
    const proposalWithoutId = withoutId as AiProposal;

    await assert.rejects(
      () =>
        applyAiProposal({
          proposal: proposalWithoutId,
          expectedSchemaHash: "hash_6",
          actorId: "user_42",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_OUTPUT_INVALID",
    );

    assert.equal(state.softDeleteCalls.length, 0);
  });
});

describe("applyAiProposalUndo", () => {
  test("create_document undo soft-deletes the newly created document", async () => {
    const state: StubStoreState = {
      document: buildDocument({ documentId: "doc_new" }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const result = await applyAiProposalUndo({
      proposal: buildProposal({
        proposalId: "p_create_undo",
        kind: "create_document",
        documentId: undefined,
        baseDraftRevision: undefined,
        operations: [
          {
            op: "create_document",
            path: "blog/new",
            format: "mdx",
            frontmatter: {},
            body: "",
          },
        ],
      }),
      documentId: "doc_new",
      expectedSchemaHash: "hash_undo",
      actorId: "user_99",
      store,
    });

    assert.equal(state.softDeleteCalls.length, 1);
    assert.equal(state.softDeleteCalls[0]!.documentId, "doc_new");
    assert.equal(result.document.isDeleted, true);
  });

  test("delete_document undo restores the soft-deleted document", async () => {
    const state: StubStoreState = {
      document: buildDocument({ isDeleted: true }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const result = await applyAiProposalUndo({
      proposal: buildProposal({
        proposalId: "p_delete_undo",
        kind: "delete_document",
        operations: [
          {
            op: "delete_document",
            path: "blog/welcome",
          },
        ],
      }),
      documentId: "doc_1",
      expectedSchemaHash: "hash_undo",
      actorId: "user_99",
      store,
    });

    assert.equal(state.restoreCalls?.length ?? 0, 1);
    assert.equal(state.restoreCalls![0]!.documentId, "doc_1");
    assert.equal(result.document.isDeleted, false);
  });

  test("delete_document undo refuses when the document is not deleted", async () => {
    const state: StubStoreState = {
      document: buildDocument({ isDeleted: false }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposalUndo({
          proposal: buildProposal({
            proposalId: "p_delete_undo_idempotent",
            kind: "delete_document",
            operations: [{ op: "delete_document", path: "blog/welcome" }],
          }),
          documentId: "doc_1",
          expectedSchemaHash: "hash_undo",
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_PROPOSAL_CONFLICT",
    );
    assert.equal(state.restoreCalls?.length ?? 0, 0);
  });

  test("replace_selection undo replays the captured priorDraft via update", async () => {
    const state: StubStoreState = {
      document: buildDocument({ body: "Hi there!", draftRevision: 5 }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    const priorDraft = {
      body: "Welcome to the site.",
      frontmatter: { title: "Welcome" },
    };

    await applyAiProposalUndo({
      proposal: buildProposal(),
      documentId: "doc_1",
      expectedSchemaHash: "hash_undo",
      priorDraft,
      postApplyDraftRevision: 5,
      actorId: "user_99",
      store,
    });

    assert.equal(state.updateCalls.length, 1);
    const call = state.updateCalls[0]!;
    assert.equal(call.payload.body, "Welcome to the site.");
    assert.deepEqual(call.payload.frontmatter, { title: "Welcome" });
    assert.equal(call.options.expectedDraftRevision, 5);
  });

  test("replace_selection undo fails loud on a concurrent edit", async () => {
    const state: StubStoreState = {
      document: buildDocument({ draftRevision: 7 }),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposalUndo({
          proposal: buildProposal(),
          documentId: "doc_1",
          expectedSchemaHash: "hash_undo",
          priorDraft: { body: "original", frontmatter: {} },
          postApplyDraftRevision: 5,
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_PROPOSAL_CONFLICT",
    );
    assert.equal(state.updateCalls.length, 0);
  });

  test("body-kind undo requires postApplyDraftRevision (defense-in-depth)", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    // Caller has a priorDraft but forgot to pass the revision. The
    // route also rejects this, but `applyAiProposalUndo` is a public
    // export — its own contract MUST refuse the unsafe replay so a
    // direct caller can't skip the concurrent-edit guard.
    await assert.rejects(
      () =>
        applyAiProposalUndo({
          proposal: buildProposal(),
          documentId: "doc_1",
          expectedSchemaHash: "hash_undo",
          priorDraft: { body: "original", frontmatter: {} },
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_OUTPUT_INVALID",
    );
    assert.equal(state.updateCalls.length, 0);
  });

  test("body-kind undo requires a priorDraft snapshot", async () => {
    const state: StubStoreState = {
      document: buildDocument(),
      updateCalls: [],
      createCalls: [],
      softDeleteCalls: [],
    };
    const store = createStubStore(state);

    await assert.rejects(
      () =>
        applyAiProposalUndo({
          proposal: buildProposal(),
          documentId: "doc_1",
          expectedSchemaHash: "hash_undo",
          actorId: "user_99",
          store,
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_OUTPUT_INVALID",
    );
    assert.equal(state.updateCalls.length, 0);
  });
});
