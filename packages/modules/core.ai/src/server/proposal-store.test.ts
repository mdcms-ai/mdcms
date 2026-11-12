import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { RuntimeError, type AiProposal } from "@mdcms/shared";

import { createInMemoryAiProposalStore } from "./proposal-store.js";

function buildProposal(overrides: Partial<AiProposal> = {}): AiProposal {
  return {
    proposalId: overrides.proposalId ?? "p_1",
    kind: overrides.kind ?? "replace_selection",
    project: overrides.project ?? "demo",
    environment: overrides.environment ?? "draft",
    type: overrides.type ?? "page",
    locale: overrides.locale ?? "en",
    summary: overrides.summary ?? "Tightened intro.",
    operations: overrides.operations ?? [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "Hello world",
        replacementText: "Hi.",
      },
    ],
    validation: overrides.validation ?? { status: "valid" },
    expiresAt: overrides.expiresAt ?? "2026-05-01T00:05:00.000Z",
    provider: overrides.provider ?? {
      providerId: "echo",
      model: "echo-1",
      promptTemplateId: "copy_improvement.v1",
    },
    ...(overrides.documentId ? { documentId: overrides.documentId } : {}),
    ...(overrides.baseDraftRevision !== undefined
      ? { baseDraftRevision: overrides.baseDraftRevision }
      : {}),
  };
}

describe("createInMemoryAiProposalStore", () => {
  test("undo records are immutable snapshots that expire and can be consumed once", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock: () => now });
    const proposal = buildProposal();
    store.insert({ proposal, actorId: "user_1" });
    const release = store.reserve(proposal.proposalId);
    assert.throws(
      () => store.reserve(proposal.proposalId),
      /already in progress/,
    );
    release();
    store.markAccepted({ proposalId: proposal.proposalId, actorId: "user_1" });
    // Only the snapshot lifetime is relevant to this store test.
    const result = {
      document: {
        documentId: "doc_1",
        draftRevision: 4,
        body: "large-current-document",
      },
      priorDraft: { body: "prior", frontmatter: {} },
    } as import("./apply.js").AiApplyResult;
    store.saveUndo(proposal.proposalId, result);
    result.document.draftRevision = 10;
    assert.deepEqual(store.getUndo(proposal.proposalId), {
      documentId: "doc_1",
      postApplyDraftRevision: 4,
      priorDraft: { body: "prior", frontmatter: {} },
    });
    const accepted = store.peek(proposal.proposalId)!;
    store.consumeUndo(proposal.proposalId);
    assert.equal(accepted.undo, undefined);
    assert.throws(
      () => store.getUndo(proposal.proposalId),
      /unavailable or expired/,
    );
    store.saveUndo(proposal.proposalId, result);
    now = new Date(now.getTime() + 6001);
    assert.throws(
      () => store.getUndo(proposal.proposalId),
      /unavailable or expired/,
    );
    assert.equal(accepted.undo, undefined);
    store.dispose();
  });

  test("cleanup bounds terminal retention and capacity without evicting reservations", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({
      clock: () => now,
      capacity: 2,
    });
    const first = store.insert({
      proposal: buildProposal(),
      actorId: "user_1",
    });
    store.insert({
      proposal: buildProposal({ proposalId: "p_2" }),
      actorId: "user_1",
    });
    const release = store.reserve("p_1");
    assert.throws(
      () =>
        store.insert({
          proposal: buildProposal({ proposalId: "p_3" }),
          actorId: "user_1",
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_RATE_LIMITED" &&
        error.statusCode === 429,
    );
    store.markRejected({ proposalId: "p_2", actorId: "user_1" });
    now = new Date(now.getTime() + 16 * 60_000);
    store.cleanup();
    assert.equal(store.peek("p_1"), first);
    assert.equal(store.peek("p_2"), undefined);
    release();
    assert.equal(store.peek("p_1"), undefined);
    store.insert({
      proposal: buildProposal({
        proposalId: "p_3",
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
      actorId: "user_1",
    });
    assert.equal(store.list().length, 1);
    store.dispose();
    assert.deepEqual(store.list(), []);
    assert.throws(
      () => store.insert({ proposal: buildProposal(), actorId: "user_1" }),
      /disposed/,
    );
  });

  test("cleanup releases idle expired undo payloads and defers reserved cleanup until release", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock: () => now });
    store.insert({ proposal: buildProposal(), actorId: "user_1" });
    const accepted = store.markAccepted({
      proposalId: "p_1",
      actorId: "user_1",
    });
    const result = {
      document: { documentId: "doc", draftRevision: 4 },
      priorDraft: { body: "private prior body", frontmatter: {} },
    } as import("./apply.js").AiApplyResult;
    store.saveUndo("p_1", result);
    now = new Date(now.getTime() + 6001);
    store.cleanup();
    assert.equal(accepted.undo, undefined);
    store.saveUndo("p_1", result);
    const release = store.reserve("p_1");
    now = new Date(now.getTime() + 6001);
    store.cleanup();
    assert.ok(accepted.undo);
    release();
    assert.equal(accepted.undo, undefined);
    store.saveUndo("p_1", result);
    store.dispose();
    assert.equal(accepted.undo, undefined);
  });
  test("idle timer clears expired payloads and dispose stops the timer", async () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    let clockCalls = 0;
    const store = createInMemoryAiProposalStore({
      clock: () => {
        clockCalls++;
        return now;
      },
    });
    try {
      store.insert({ proposal: buildProposal(), actorId: "user_1" });
      const record = store.markAccepted({
        proposalId: "p_1",
        actorId: "user_1",
      });
      store.saveUndo("p_1", {
        document: { documentId: "doc", draftRevision: 1 },
        priorDraft: { body: "old", frontmatter: {} },
      } as import("./apply.js").AiApplyResult);
      now = new Date(now.getTime() + 6001);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(record.undo, undefined);
      store.dispose();
      const callsAtDisposal = clockCalls;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(clockCalls, callsAtDisposal);
    } finally {
      store.dispose();
    }
  });

  test("inserts and observes pending proposals before expiry", () => {
    const clock = () => new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock });
    const proposal = buildProposal();

    const inserted = store.insert({ proposal, actorId: "user_1" });

    assert.equal(inserted.status, "pending");
    assert.equal(inserted.createdByActorId, "user_1");
    assert.deepEqual(store.observe("p_1")?.proposal, proposal);
  });

  test("observe transitions an expired proposal to expired", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock: () => now });
    store.insert({
      proposal: buildProposal({
        expiresAt: "2026-05-01T00:01:00.000Z",
      }),
      actorId: "user_1",
    });

    now = new Date("2026-05-01T00:02:00.000Z");
    const observed = store.observe("p_1");

    assert.equal(observed?.status, "expired");
    assert.equal(typeof observed?.resolvedAt, "string");
  });

  test("markAccepted moves pending proposal to accepted", () => {
    const clock = () => new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock });
    store.insert({ proposal: buildProposal(), actorId: "user_1" });

    const accepted = store.markAccepted({
      proposalId: "p_1",
      actorId: "user_42",
    });

    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.resolvedByActorId, "user_42");
  });

  test("markAccepted on missing proposal raises NOT_FOUND", () => {
    const store = createInMemoryAiProposalStore({
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
    });

    assert.throws(
      () => store.markAccepted({ proposalId: "missing", actorId: "user_1" }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "NOT_FOUND" &&
        error.statusCode === 404,
    );
  });

  test("markRejected after acceptance raises AI_PROPOSAL_CONFLICT", () => {
    const clock = () => new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock });
    store.insert({ proposal: buildProposal(), actorId: "user_1" });
    store.markAccepted({ proposalId: "p_1", actorId: "user_1" });

    assert.throws(
      () => store.markRejected({ proposalId: "p_1", actorId: "user_1" }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROPOSAL_CONFLICT" &&
        error.statusCode === 409,
    );
  });

  test("markAccepted on a stale-pending expired proposal raises AI_PROPOSAL_EXPIRED", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock: () => now });
    store.insert({
      proposal: buildProposal({ expiresAt: "2026-05-01T00:00:30.000Z" }),
      actorId: "user_1",
    });

    // Advance past expiry without calling observe(), so the record is
    // still flagged "pending" in storage. markAccepted must defensively
    // re-check expiry rather than blindly accepting it.
    now = new Date("2026-05-01T00:01:00.000Z");

    assert.throws(
      () => store.markAccepted({ proposalId: "p_1", actorId: "user_1" }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROPOSAL_EXPIRED" &&
        error.statusCode === 410,
    );
  });

  test("apply on expired proposal raises AI_PROPOSAL_EXPIRED", () => {
    let now = new Date("2026-05-01T00:00:00.000Z");
    const store = createInMemoryAiProposalStore({ clock: () => now });
    store.insert({
      proposal: buildProposal({
        expiresAt: "2026-05-01T00:00:30.000Z",
      }),
      actorId: "user_1",
    });

    now = new Date("2026-05-01T00:01:00.000Z");
    store.observe("p_1");

    assert.throws(
      () => store.markAccepted({ proposalId: "p_1", actorId: "user_1" }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_PROPOSAL_EXPIRED" &&
        error.statusCode === 410,
    );
  });
});
