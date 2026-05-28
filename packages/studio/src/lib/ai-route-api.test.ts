import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import {
  createStudioAiRouteApi,
  type StudioAiInlineTransformResult,
} from "./ai-route-api.js";

const config = {
  project: "demo",
  environment: "draft",
  serverUrl: "http://localhost:4000",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createStudioAiRouteApi", () => {
  test("inlineTransform sends target headers and unwraps proposals", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({
        data: {
          proposals: [
            {
              proposalId: "p_1",
              kind: "replace_selection",
              operations: [],
            },
          ],
        },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    const result = (await api.inlineTransform({
      selectionId: "sel_1",
      selectedText: "Hello",
      action: "rewrite",
    })) as StudioAiInlineTransformResult;

    assert.equal(result.proposals.length, 1);
    assert.match(capturedUrl ?? "", /\/api\/v1\/ai\/inline-transform$/);
    const headers = new Headers(capturedInit?.headers ?? {});
    assert.equal(headers.get("x-mdcms-project"), "demo");
    assert.equal(headers.get("x-mdcms-environment"), "draft");
    const body = JSON.parse((capturedInit?.body as string) ?? "{}");
    assert.equal(body.action, "rewrite");
    assert.equal(body.selectionId, "sel_1");
  });

  test("inlineTransform translates non-2xx into RuntimeError", async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse(
        {
          code: "AI_DISABLED",
          message: "AI is not configured.",
          statusCode: 403,
        },
        403,
      );

    const api = createStudioAiRouteApi(config, { fetcher });
    await assert.rejects(
      () =>
        api.inlineTransform({
          selectionId: "sel_1",
          selectedText: "Hello",
          action: "rewrite",
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_DISABLED" &&
        error.statusCode === 403,
    );
  });

  test("applyProposal posts to the proposal id endpoint", async () => {
    let capturedUrl: string | undefined;
    const fetcher: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return jsonResponse({
        data: {
          proposal: {
            proposalId: "p_1",
            kind: "replace_selection",
          },
          document: { documentId: "doc_1", body: "ok" },
        },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    const result = await api.applyProposal({
      proposalId: "p_1",
      schemaHash: "h",
      draftRevision: 5,
    });

    assert.match(capturedUrl ?? "", /\/api\/v1\/ai\/proposals\/p_1\/apply$/);
    assert.equal(result.proposal.proposalId, "p_1");
    assert.equal(result.document.body, "ok");
  });

  test("applyProposal raises stable error on conflict", async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse(
        {
          code: "AI_PROPOSAL_CONFLICT",
          message: "Stale revision.",
          statusCode: 409,
        },
        409,
      );

    const api = createStudioAiRouteApi(config, { fetcher });
    await assert.rejects(
      () =>
        api.applyProposal({
          proposalId: "p_1",
          schemaHash: "h",
        }),
      (error) =>
        error instanceof RuntimeError && error.code === "AI_PROPOSAL_CONFLICT",
    );
  });

  test("undoProposal posts to the undo endpoint with priorDraft + documentId", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({
        data: {
          proposal: { proposalId: "p_1", kind: "replace_selection" },
          document: { documentId: "doc_1", body: "Welcome." },
        },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    const result = await api.undoProposal({
      proposalId: "p_1",
      proposal: {
        proposalId: "p_1",
        kind: "replace_selection",
        operations: [],
      } as never,
      documentId: "doc_1",
      schemaHash: "h",
      priorDraft: { body: "Welcome.", frontmatter: { title: "Hi" } },
      postApplyDraftRevision: 5,
    });

    assert.match(capturedUrl ?? "", /\/api\/v1\/ai\/proposals\/p_1\/undo$/);
    const body = capturedBody as {
      documentId: string;
      schemaHash: string;
      priorDraft: { body: string };
      postApplyDraftRevision: number;
    };
    assert.equal(body.documentId, "doc_1");
    assert.equal(body.schemaHash, "h");
    assert.equal(body.priorDraft.body, "Welcome.");
    assert.equal(body.postApplyDraftRevision, 5);
    assert.equal(result.document.body, "Welcome.");
  });

  test("rejectProposal hits the reject endpoint", async () => {
    let capturedUrl: string | undefined;
    const fetcher: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return jsonResponse({
        data: { proposal: { proposalId: "p_1", kind: "replace_selection" } },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    const result = await api.rejectProposal({ proposalId: "p_1" });
    assert.match(capturedUrl ?? "", /\/api\/v1\/ai\/proposals\/p_1\/reject$/);
    assert.equal(result.proposal.proposalId, "p_1");
  });

  test("chatMessage sends target headers and unwraps the response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({
        data: {
          conversationId: "conv_1",
          message: {
            id: "m_1",
            role: "assistant",
            at: "2026-05-10T10:00:00.000Z",
            proposals: ["p_chat_1"],
          },
          proposals: [
            {
              proposalId: "p_chat_1",
              kind: "replace_selection",
              operations: [],
            },
          ],
        },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    const result = await api.chatMessage({
      message: "Tighten the lede",
      conversationId: "conv_1",
      attachedSelection: {
        documentId: "doc_1",
        draftRevision: 4,
        selectionId: "sel_1",
        text: "Welcome",
      },
      allowedActions: ["edit_document"],
      mdxCatalog: {
        components: [
          {
            name: "Callout",
            importPath: "@/components/mdx/Callout",
          },
        ],
      },
      componentReferences: [
        {
          componentName: "HomeHero",
          source: "studio_host_preview",
          renderedHtml: '<section class="landing-hero">Hero</section>',
          text: "Hero",
        },
      ],
    });

    assert.match(capturedUrl ?? "", /\/api\/v1\/ai\/chat\/messages$/);
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["x-mdcms-project"], "demo");
    assert.equal(headers["x-mdcms-environment"], "draft");

    const sent = JSON.parse(String(capturedInit?.body ?? "{}")) as {
      message: string;
      conversationId: string;
      attachedSelection?: { documentId: string };
      allowedActions?: string[];
      mdxCatalog?: { components: Array<{ name: string }> };
      componentReferences?: Array<{ componentName: string }>;
    };
    assert.equal(sent.message, "Tighten the lede");
    assert.equal(sent.conversationId, "conv_1");
    assert.equal(sent.attachedSelection?.documentId, "doc_1");
    assert.deepEqual(sent.allowedActions, ["edit_document"]);
    assert.equal(sent.mdxCatalog?.components[0]?.name, "Callout");
    assert.equal(sent.componentReferences?.[0]?.componentName, "HomeHero");

    assert.equal(result.conversationId, "conv_1");
    assert.equal(result.message.id, "m_1");
    assert.equal(result.proposals?.[0]?.proposalId, "p_chat_1");
  });

  test("chatMessage surfaces AI_UNSUPPORTED_ACTION errors from the server", async () => {
    const fetcher: typeof fetch = async () =>
      jsonResponse(
        {
          code: "AI_UNSUPPORTED_ACTION",
          message: "Caller is not allowed to propose document deletes.",
        },
        403,
      );

    const api = createStudioAiRouteApi(config, { fetcher });
    await assert.rejects(
      () =>
        api.chatMessage({
          message: "delete this draft",
          attachedDocumentIds: ["doc_1"],
        }),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "AI_UNSUPPORTED_ACTION" &&
        error.statusCode === 403,
    );
  });

  test("chatMessage omits optional fields from the request body", async () => {
    let capturedBody: string | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse({
        data: {
          conversationId: "conv_x",
          message: {
            id: "m_x",
            role: "assistant",
            at: "2026-05-10T10:00:00.000Z",
            text: "ok",
          },
        },
      });
    };

    const api = createStudioAiRouteApi(config, { fetcher });
    await api.chatMessage({ message: "hello" });
    const sent = JSON.parse(capturedBody ?? "{}") as Record<string, unknown>;
    // Only `message` should be present when no other fields are supplied.
    assert.deepEqual(Object.keys(sent), ["message"]);
  });
});
