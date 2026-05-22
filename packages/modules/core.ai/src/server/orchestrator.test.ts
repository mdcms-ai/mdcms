import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import {
  createAiOrchestrator,
  getOrchestratorFailureAudit,
  getOrchestratorFailureRuntimeError,
  OrchestratorFailure,
  type AiOrchestrationInput,
} from "./orchestrator.js";
import {
  createEchoAiProvider,
  ECHO_PROVIDER_DEFAULT_MODEL,
  ECHO_PROVIDER_ID,
  type EchoStepResponse,
} from "./providers/echo.js";
import { createNullAiProvider } from "./providers/null.js";

const baseInput: AiOrchestrationInput = {
  taskKind: "copy_improvement",
  envelope: {
    project: "demo",
    environment: "draft",
    type: "page",
    locale: "en",
    documentId: "doc_1",
    baseDraftRevision: 4,
  },
  input: {
    locale: "en",
    selectionText: "Hello world",
    selectionId: "sel_anchor",
    instruction: "make it punchier",
  },
};

const fixedClock = () => new Date("2026-05-01T00:00:00.000Z");

let nextProposalId = 0;
const idFactory = () => {
  nextProposalId += 1;
  return `prop_${nextProposalId}`;
};

function resetIds(): void {
  nextProposalId = 0;
}

function buildEchoOutput(): string {
  return JSON.stringify({
    summary: "Tightened intro",
    operations: [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "Hello world",
        replacementText: "Hi.",
      },
    ],
  });
}

describe("createAiOrchestrator", () => {
  test("provider success → proposals and succeeded audit", async () => {
    resetIds();
    const provider = createEchoAiProvider({
      respond: () => buildEchoOutput(),
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    const result = await orchestrator.runTask(baseInput);

    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0]?.kind, "replace_selection");
    assert.equal(result.proposals[0]?.proposalId, "prop_1");
    assert.equal(result.proposals[0]?.provider.providerId, ECHO_PROVIDER_ID);
    assert.equal(
      result.proposals[0]?.provider.model,
      ECHO_PROVIDER_DEFAULT_MODEL,
    );

    assert.equal(result.audit.outcome, "succeeded");
    assert.equal(result.audit.providerId, ECHO_PROVIDER_ID);
    assert.equal(result.audit.model, ECHO_PROVIDER_DEFAULT_MODEL);
    assert.deepEqual(result.audit.proposalIds, ["prop_1"]);
    assert.deepEqual(result.audit.usage, {
      inputTokens: 12,
      outputTokens: 6,
      totalTokens: 18,
    });
  });

  test("provider failure → AI_PROVIDER_UNAVAILABLE with provider_error audit", async () => {
    const provider = createEchoAiProvider({
      throwOnGenerate: new Error("network down"),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    try {
      await orchestrator.runTask(baseInput);
      assert.fail("expected throw");
    } catch (error) {
      const runtime = getOrchestratorFailureRuntimeError(error);
      const audit = getOrchestratorFailureAudit(error);
      assert.ok(error instanceof OrchestratorFailure);
      assert.ok(runtime instanceof RuntimeError);
      assert.equal(runtime?.code, "AI_PROVIDER_UNAVAILABLE");
      assert.equal(audit?.outcome, "provider_error");
      assert.equal(audit?.errorCode, "AI_PROVIDER_UNAVAILABLE");
      assert.equal(audit?.providerId, ECHO_PROVIDER_ID);
    }
  });

  test("disabled AI → AI_DISABLED with provider_error audit", async () => {
    const provider = createNullAiProvider();
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    try {
      await orchestrator.runTask(baseInput);
      assert.fail("expected throw");
    } catch (error) {
      const runtime = getOrchestratorFailureRuntimeError(error);
      const audit = getOrchestratorFailureAudit(error);
      assert.equal(runtime?.code, "AI_DISABLED");
      assert.equal(audit?.outcome, "provider_error");
      assert.equal(audit?.errorCode, "AI_DISABLED");
    }
  });

  test("invalid model output → AI_OUTPUT_INVALID with invalid_output audit", async () => {
    const provider = createEchoAiProvider({
      respond: () => "not json at all",
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    try {
      await orchestrator.runTask(baseInput);
      assert.fail("expected throw");
    } catch (error) {
      const runtime = getOrchestratorFailureRuntimeError(error);
      const audit = getOrchestratorFailureAudit(error);
      assert.equal(runtime?.code, "AI_OUTPUT_INVALID");
      assert.equal(audit?.outcome, "invalid_output");
      assert.equal(audit?.validation.status, "invalid");
    }
  });

  test("model output failing schema → AI_OUTPUT_INVALID", async () => {
    const provider = createEchoAiProvider({
      respond: () =>
        JSON.stringify({
          summary: "ok",
          operations: [
            {
              op: "create_document",
              path: "x.md",
              format: "md",
              frontmatter: {},
              body: "x",
            },
          ],
        }),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    // copy_improvement only allows replace_selection ops
    await assert.rejects(
      () => orchestrator.runTask(baseInput),
      (error) => {
        const runtime = getOrchestratorFailureRuntimeError(error);
        return runtime?.code === "AI_OUTPUT_INVALID";
      },
    );
  });

  test("rejects task input that fails task schema", async () => {
    const provider = createEchoAiProvider({
      respond: () => buildEchoOutput(),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    await assert.rejects(
      () =>
        orchestrator.runTask({
          ...baseInput,
          input: { locale: "en" /* missing selectionText */ },
        }),
      (error) => {
        assert.ok(error instanceof OrchestratorFailure);
        const runtime = getOrchestratorFailureRuntimeError(error);
        assert.ok(runtime !== undefined);
        assert.equal(runtime.code, "AI_OUTPUT_INVALID");
        return true;
      },
    );
  });

  test("unknown task kind → AI_UNSUPPORTED_TASK wrapped in OrchestratorFailure", async () => {
    const provider = createEchoAiProvider({
      respond: () => buildEchoOutput(),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    await assert.rejects(
      () =>
        orchestrator.runTask({
          ...baseInput,
          taskKind: "unknown_task" as never,
        }),
      (error) => {
        assert.ok(error instanceof OrchestratorFailure);
        const runtime = getOrchestratorFailureRuntimeError(error);
        const audit = getOrchestratorFailureAudit(error);
        assert.ok(runtime !== undefined);
        assert.equal(runtime.code, "AI_UNSUPPORTED_TASK");
        assert.equal(audit?.errorCode, "AI_UNSUPPORTED_TASK");
        assert.equal(audit?.taskKind, "unknown_task");
        return true;
      },
    );
  });

  test("current_document_edit rejects input that omits selectionId", async () => {
    const provider = createEchoAiProvider({
      respond: () =>
        JSON.stringify({
          summary: "edit",
          operations: [
            {
              op: "replace_selection",
              selectionId: "sel_invented",
              originalText: "a",
              replacementText: "b",
            },
          ],
        }),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    await assert.rejects(
      () =>
        orchestrator.runTask({
          taskKind: "current_document_edit",
          envelope: baseInput.envelope,
          input: {
            locale: "en",
            documentBody: "Some body",
            instruction: "rewrite the intro",
            // selectionId intentionally absent
          },
        }),
      (error) => {
        assert.ok(error instanceof OrchestratorFailure);
        const runtime = getOrchestratorFailureRuntimeError(error);
        assert.ok(runtime !== undefined);
        assert.equal(runtime.code, "AI_OUTPUT_INVALID");
        return true;
      },
    );
  });

  test("chat replacement proposals are invalid when source text is missing from the active draft", async () => {
    resetIds();
    const steps: EchoStepResponse[] = [
      {
        type: "tool-calls",
        calls: [
          {
            toolName: "propose_replace_document_text",
            input: JSON.stringify({
              summary: "Replace contact block",
              originalText: "## Contact us\n\nMissing text",
              replacementText: "## Contact us\n\nUpdated text",
            }),
          },
        ],
      },
      { type: "text", text: "I proposed the replacement." },
    ];
    const provider = createEchoAiProvider({ steps });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    const result = await orchestrator.runChat({
      message: "Update the contact section",
      project: "demo",
      environment: "draft",
      activeDocument: {
        documentId: "doc_1",
        path: "content/pages/about",
        type: "page",
        locale: "en",
        draftRevision: 4,
        body: "## Contact us\n\nExisting text",
        frontmatter: {},
        hasPublishedVersion: false,
      },
      capabilities: {
        canEditDocument: true,
        canCreateDocument: false,
        canDeleteDocument: false,
        canReadEntries: false,
      },
    });

    assert.equal(result.proposals.length, 1);
    const proposal = result.proposals[0]!;
    assert.equal(proposal.kind, "replace_selection");
    assert.equal(proposal.validation.status, "invalid");
    if (proposal.validation.status === "invalid") {
      assert.equal(
        proposal.validation.errors[0]?.code,
        "REPLACE_SELECTION_SOURCE_NOT_FOUND",
      );
    }
  });

  test("seo_improvement task only allows update_frontmatter operations", async () => {
    const provider = createEchoAiProvider({
      respond: () =>
        JSON.stringify({
          summary: "Tighten title",
          operations: [
            {
              op: "replace_selection",
              selectionId: "sel_invented",
              originalText: "Old title",
              replacementText: "New title",
            },
          ],
        }),
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    await assert.rejects(
      () =>
        orchestrator.runTask({
          taskKind: "seo_improvement",
          envelope: baseInput.envelope,
          input: {
            locale: "en",
            instruction: "improve SEO",
            frontmatter: { title: "Old title" },
          },
        }),
      (error) => {
        assert.ok(error instanceof OrchestratorFailure);
        const runtime = getOrchestratorFailureRuntimeError(error);
        assert.ok(runtime !== undefined);
        assert.equal(runtime.code, "AI_OUTPUT_INVALID");
        return true;
      },
    );
  });
});
