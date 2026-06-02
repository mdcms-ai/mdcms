import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import type {
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { RuntimeError } from "@mdcms/shared";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

import {
  type AiChatStreamEvent,
  createAiOrchestrator,
  getOrchestratorFailureAudit,
  getOrchestratorFailureRuntimeError,
  OrchestratorFailure,
  type AiOrchestrationInput,
} from "./orchestrator.js";
import type { AiProvider } from "./provider.js";
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

function createStreamErrorAiProvider(error: unknown): AiProvider {
  const usage: LanguageModelV3Usage = {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  };
  return {
    id: ECHO_PROVIDER_ID,
    languageModel: new MockLanguageModelV3({
      provider: ECHO_PROVIDER_ID,
      modelId: ECHO_PROVIDER_DEFAULT_MODEL,
      doGenerate: async () => ({
        content: [],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "error", error });
            controller.close();
          },
        }),
      }),
    }),
  };
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

  test("chat replacement proposals retry once when source text is missing from the active draft", async () => {
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
      {
        type: "tool-calls",
        calls: [
          {
            toolName: "propose_replace_document_text",
            input: JSON.stringify({
              summary: "Replace contact block",
              originalText: "## Contact us\n\nExisting text",
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
    assert.equal(proposal.validation.status, "valid");
    const operation = proposal.operations[0];
    assert.equal(operation?.op, "replace_selection");
    if (operation?.op === "replace_selection") {
      assert.equal(operation.originalText, "## Contact us\n\nExisting text");
      assert.equal(operation.replacementText, "## Contact us\n\nUpdated text");
    }
  });

  test("chat stream emits progress events for model steps and proposal tools", async () => {
    resetIds();
    const provider = createEchoAiProvider({
      steps: [
        {
          type: "tool-calls",
          calls: [
            {
              toolName: "propose_replace_document_text",
              input: JSON.stringify({
                summary: "Replace contact block",
                originalText: "## Contact us\n\nExisting text",
                replacementText: "## Contact us\n\nUpdated text",
              }),
            },
          ],
        },
        { type: "text", text: "I proposed the replacement." },
      ],
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    const events = [];
    for await (const event of orchestrator.runChatStream({
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
    })) {
      events.push(event);
    }

    const progress = events.filter((event) => event.type === "progress");
    assert.ok(
      progress.some((event) => event.phase === "thinking"),
      "should surface model-step progress before text/proposals are done",
    );
    assert.ok(
      progress.some(
        (event) =>
          event.phase === "tool-call" &&
          event.toolName === "propose_replace_document_text",
      ),
      "should surface proposal tool calls",
    );
    assert.ok(
      progress.some(
        (event) =>
          event.phase === "tool-result" &&
          event.toolName === "propose_replace_document_text" &&
          event.status === "queued",
      ),
      "should surface proposal tool results",
    );
    assert.ok(events.some((event) => event.type === "done"));
  });

  test("chat stream separates text blocks emitted across model steps", async () => {
    resetIds();
    const provider = createEchoAiProvider({
      steps: [
        {
          type: "tool-calls",
          calls: [
            {
              toolName: "propose_replace_document_text",
              input: JSON.stringify({
                summary: "Replace contact block",
                originalText: "## Contact us\n\nExisting text",
                replacementText: "## Contact us\n\nUpdated text",
              }),
            },
          ],
          trailingText:
            "I'll inspect the existing page and compose the edit closely.",
        },
        { type: "text", text: "I've proposed the testimonial section." },
      ],
    });
    const orchestrator = createAiOrchestrator({
      provider,
      clock: fixedClock,
      idFactory,
    });

    const events: AiChatStreamEvent[] = [];
    for await (const event of orchestrator.runChatStream({
      message: "Add testimonials",
      project: "demo",
      environment: "draft",
      activeDocument: {
        documentId: "doc_1",
        path: "content/pages/home",
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
    })) {
      events.push(event);
    }

    const deltas = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("");
    assert.equal(
      deltas,
      "I'll inspect the existing page and compose the edit closely.\n\nI've proposed the testimonial section.",
    );

    const done = events.find((event) => event.type === "done");
    assert.ok(done);
    assert.equal(
      done.text,
      "I'll inspect the existing page and compose the edit closely.\n\nI've proposed the testimonial section.",
    );
  });

  test("chat stream maps model error parts to a terminal error event", async () => {
    const orchestrator = createAiOrchestrator({
      provider: createStreamErrorAiProvider(
        new APICallError({
          message: "Request too large for model token budget",
          url: "https://api.example.test/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseBody:
            '{"error":{"message":"Request too large for model token budget"}}',
          isRetryable: false,
        }),
      ),
      clock: fixedClock,
      idFactory,
    });

    const events: AiChatStreamEvent[] = [];
    for await (const event of orchestrator.runChatStream({
      message: "Build a larger section",
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
    })) {
      events.push(event);
    }

    const errorEvent = events.find((event) => event.type === "error");
    assert.ok(errorEvent);
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
      "stream errors must not fall through to a succeeded done event",
    );
    assert.equal(errorEvent.audit.outcome, "provider_error");
    assert.equal(errorEvent.audit.errorCode, "AI_RATE_LIMITED");
    assert.equal(errorEvent.code, "AI_RATE_LIMITED");
    assert.match(errorEvent.message, /rate limit/i);
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
