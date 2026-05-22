import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  buildChatTools,
  type ChatToolDeps,
  type FindEntriesResult,
} from "./chat-tools.js";
import type { AiProposal } from "@mdcms/shared";

function baseDeps(overrides: Partial<ChatToolDeps> = {}): ChatToolDeps {
  return {
    envelope: {
      project: "p",
      environment: "e",
      type: "page",
      locale: "en",
    },
    hasActiveDocument: false,
    activeDocumentHasPublishedVersion: false,
    providerId: "echo",
    model: "echo-1",
    clock: () => new Date("2026-05-16T00:00:00.000Z"),
    idFactory: (() => {
      let n = 0;
      return () => `prop_${++n}`;
    })(),
    ttlMs: 5 * 60 * 1000,
    capabilities: {
      canEditDocument: false,
      canCreateDocument: false,
      canDeleteDocument: false,
      canReadEntries: false,
    },
    collected: [] as AiProposal[],
    registeredTypeIds: ["author", "post"],
    supportedLocales: ["en", "pl"],
    ...overrides,
  };
}

describe("find_entries tool", () => {
  test("is registered when caller has read capability and backend present", () => {
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        findEntriesBackend: async () => ({ matches: [], total: 0 }),
      }),
    );
    assert.ok(tools.find_entries, "find_entries tool should be registered");
  });

  test("is NOT registered when read capability is absent", () => {
    const tools = buildChatTools(
      baseDeps({
        findEntriesBackend: async () => ({ matches: [], total: 0 }),
      }),
    );
    assert.equal(tools.find_entries, undefined);
  });

  test("execute calls backend with model-supplied args and returns result", async () => {
    let captured: { type: string; query?: string; limit?: number } | undefined;
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        findEntriesBackend: async (input) => {
          captured = input;
          return {
            matches: [
              {
                documentId: "doc_1",
                path: "authors/john",
                type: "author",
                locale: "en",
                title: "John Doe",
                updatedAt: "2026-05-01T00:00:00.000Z",
                hasUnpublishedChanges: false,
              },
            ],
            total: 1,
          };
        },
      }),
    );
    const result = (await tools.find_entries!.execute!(
      { type: "author", query: "john", limit: 5 },
      { toolCallId: "tc_1", messages: [] },
    )) as FindEntriesResult;
    assert.deepEqual(captured, { type: "author", query: "john", limit: 5 });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.documentId, "doc_1");
    assert.equal(result.total, 1);
  });

  test("returns structured error when backend throws", async () => {
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        findEntriesBackend: async () => {
          throw new Error("DB unreachable");
        },
      }),
    );
    const result = (await tools.find_entries!.execute!(
      { type: "author" },
      { toolCallId: "tc_1", messages: [] },
    )) as { queued: false; error: string };
    assert.equal(result.queued, false);
    assert.ok(result.error.includes("DB unreachable"));
  });
});

describe("get_entry tool", () => {
  test("is registered when caller has read capability and backend present", () => {
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        getEntryBackend: async () => undefined,
      }),
    );
    assert.ok(tools.get_entry);
  });

  test("returns the full document when backend resolves it", async () => {
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        getEntryBackend: async () => ({
          documentId: "doc_1",
          path: "blog/welcome",
          type: "post",
          locale: "en",
          draftRevision: 4,
          hasUnpublishedChanges: true,
          publishedVersion: null,
          frontmatter: { title: "Welcome" },
          body: "Body text",
        }),
      }),
    );
    const result = (await tools.get_entry!.execute!(
      { documentId: "doc_1" },
      { toolCallId: "tc_1", messages: [] },
    )) as { documentId: string; body: string };
    assert.equal(result.documentId, "doc_1");
    assert.equal(result.body, "Body text");
  });

  test("returns NOT_FOUND structured error when backend returns undefined", async () => {
    const tools = buildChatTools(
      baseDeps({
        capabilities: {
          canEditDocument: false,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: true,
        },
        getEntryBackend: async () => undefined,
      }),
    );
    const result = (await tools.get_entry!.execute!(
      { documentId: "missing" },
      { toolCallId: "tc_1", messages: [] },
    )) as { queued: false; error: string };
    assert.equal(result.queued, false);
    assert.ok(result.error.toLowerCase().includes("not found"));
  });
});

describe("document text replacement tool", () => {
  test("is registered for editable active documents even without a selected span", () => {
    const tools = buildChatTools(
      baseDeps({
        envelope: {
          project: "p",
          environment: "e",
          type: "post",
          locale: "en",
          documentId: "doc_1",
          baseDraftRevision: 4,
        },
        hasActiveDocument: true,
        capabilities: {
          canEditDocument: true,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: false,
        },
      }),
    );

    assert.ok(tools.propose_replace_document_text);
  });

  test("queues a replace_selection proposal with a server-generated document-text anchor", async () => {
    const collected: AiProposal[] = [];
    const tools = buildChatTools(
      baseDeps({
        envelope: {
          project: "p",
          environment: "e",
          type: "post",
          locale: "en",
          documentId: "doc_1",
          baseDraftRevision: 4,
        },
        hasActiveDocument: true,
        capabilities: {
          canEditDocument: true,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: false,
        },
        collected,
      }),
    );

    const result = (await tools.propose_replace_document_text!.execute!(
      {
        summary: "Remove performance benchmarks",
        originalText:
          "## Performance Benchmarks\n\n- Build Time: Reduced from 3 min 45 s.",
        replacementText: "",
      },
      { toolCallId: "tc_1", messages: [] },
    )) as { proposalId: string; queued: true };

    assert.equal(result.queued, true);
    assert.equal(collected.length, 1);
    const proposal = collected[0]!;
    assert.equal(proposal.kind, "replace_selection");
    assert.equal(proposal.documentId, "doc_1");
    assert.equal(proposal.baseDraftRevision, 4);
    assert.equal(proposal.operations[0]?.op, "replace_selection");
    if (proposal.operations[0]?.op === "replace_selection") {
      assert.match(proposal.operations[0].selectionId, /^doc-text:/);
      assert.equal(
        proposal.operations[0].originalText,
        "## Performance Benchmarks\n\n- Build Time: Reduced from 3 min 45 s.",
      );
      assert.equal(proposal.operations[0].replacementText, "");
    }
  });

  test("auto-rejects invalid proposals without collecting them", async () => {
    const collected: AiProposal[] = [];
    const tools = buildChatTools(
      baseDeps({
        envelope: {
          project: "p",
          environment: "e",
          type: "post",
          locale: "en",
          documentId: "doc_1",
          baseDraftRevision: 4,
        },
        hasActiveDocument: true,
        capabilities: {
          canEditDocument: true,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: false,
        },
        collected,
        validator: async () => ({
          status: "invalid",
          errors: [{ code: "BAD_SOURCE", message: "source missing" }],
        }),
      }),
    );

    const result = (await tools.propose_replace_document_text!.execute!(
      {
        summary: "Replace missing source",
        originalText: "missing source",
        replacementText: "new source",
      },
      { toolCallId: "tc_1", messages: [] },
    )) as {
      queued: false;
      rejected: true;
      retryable: true;
      validation: { status: "invalid"; errors: { code: string }[] };
    };

    assert.equal(result.queued, false);
    assert.equal(result.rejected, true);
    assert.equal(result.retryable, true);
    assert.equal(result.validation.errors[0]?.code, "BAD_SOURCE");
    assert.equal(collected.length, 0);
  });

  test("allows only one invalid proposal correction attempt per chat toolset", async () => {
    const collected: AiProposal[] = [];
    const tools = buildChatTools(
      baseDeps({
        envelope: {
          project: "p",
          environment: "e",
          type: "post",
          locale: "en",
          documentId: "doc_1",
          baseDraftRevision: 4,
        },
        hasActiveDocument: true,
        capabilities: {
          canEditDocument: true,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: false,
        },
        collected,
        validator: async () => ({
          status: "invalid",
          errors: [{ code: "BAD_SOURCE", message: "source missing" }],
        }),
      }),
    );

    const first = (await tools.propose_replace_document_text!.execute!(
      {
        summary: "Replace missing source",
        originalText: "first missing source",
        replacementText: "new source",
      },
      { toolCallId: "tc_1", messages: [] },
    )) as { queued: false; rejected: true; retryable: boolean };

    const second = (await tools.propose_replace_document_text!.execute!(
      {
        summary: "Replace missing source again",
        originalText: "second missing source",
        replacementText: "new source",
      },
      { toolCallId: "tc_2", messages: [] },
    )) as { queued: false; rejected: true; retryable: boolean };

    assert.equal(first.retryable, true);
    assert.equal(second.retryable, false);
    assert.equal(collected.length, 0);
  });
});

describe("selected text replacement tool", () => {
  test("anchors replacement proposals to the server-trusted attached selection text", async () => {
    const collected: AiProposal[] = [];
    const tools = buildChatTools(
      baseDeps({
        envelope: {
          project: "p",
          environment: "e",
          type: "page",
          locale: "en",
          documentId: "doc_1",
          baseDraftRevision: 4,
        },
        hasActiveDocument: true,
        attachedSelection: {
          selectionId: "sel:list",
          text: [
            "- one demo user",
            "- one fixed demo API key",
            "- sample content documents",
          ].join("\n"),
        },
        capabilities: {
          canEditDocument: true,
          canCreateDocument: false,
          canDeleteDocument: false,
          canReadEntries: false,
        },
        collected,
      }),
    );

    const result = (await tools.propose_edit_selection!.execute!(
      {
        summary: "Add emojis to list items",
        originalText: [
          "one demo user",
          "one fixed demo API key",
          "sample content documents",
        ].join("\n"),
        replacementText: [
          "- 👤 one demo user",
          "- 🔑 one fixed demo API key",
          "- 📦 sample content documents",
        ].join("\n"),
      },
      { toolCallId: "tc_1", messages: [] },
    )) as { proposalId: string; queued: true };

    assert.equal(result.queued, true);
    assert.equal(collected.length, 1);
    const operation = collected[0]?.operations[0];
    assert.equal(operation?.op, "replace_selection");
    if (operation?.op === "replace_selection") {
      assert.equal(operation.selectionId, "sel:list");
      assert.equal(
        operation.originalText,
        [
          "- one demo user",
          "- one fixed demo API key",
          "- sample content documents",
        ].join("\n"),
      );
      assert.equal(
        operation.replacementText,
        [
          "- 👤 one demo user",
          "- 🔑 one fixed demo API key",
          "- 📦 sample content documents",
        ].join("\n"),
      );
    }
  });
});
