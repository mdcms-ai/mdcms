import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioAiProposal } from "../../../ai-route-api.js";
import type {
  InlineAiState,
  InlineAiTransformIntent,
} from "../../hooks/use-inline-ai-transform.js";
import { InlineAiResultBody } from "./inline-ai-panel.js";

function buildProposal(
  overrides: Partial<StudioAiProposal> = {},
): StudioAiProposal {
  return {
    proposalId: "p_1",
    kind: "replace_selection",
    project: "demo",
    environment: "draft",
    documentId: "doc_1",
    baseDraftRevision: 4,
    type: "post",
    locale: "en",
    summary: "Tightened intro.",
    operations: [
      {
        op: "replace_selection",
        selectionId: "sel_1",
        originalText: "Hello",
        replacementText: "Hi there.",
      },
    ],
    validation: { status: "valid" },
    expiresAt: "2026-05-01T00:05:00.000Z",
    provider: {
      providerId: "echo",
      model: "echo-1",
      promptTemplateId: "copy_improvement.v1",
    },
    ...overrides,
  };
}

const intent: InlineAiTransformIntent = { action: "rewrite" };

function render(state: InlineAiState): string {
  return renderToStaticMarkup(
    createElement(InlineAiResultBody, {
      state,
      onAccept: () => {},
      onReject: () => {},
      onRetry: () => {},
    }),
  );
}

describe("InlineAiResultBody — CMS-224 UI states", () => {
  test("idle state renders nothing", () => {
    const markup = render({ status: "idle" });
    assert.equal(markup, "");
  });

  test("loading state renders a 'Generating' status row", () => {
    const markup = render({ status: "loading", intent });
    assert.match(markup, /Generating…/);
    assert.match(markup, /^<output /);
    assert.match(markup, /aria-live="polite"/);
  });

  test("empty state renders the no-proposal hint", () => {
    const markup = render({ status: "empty", intent });
    assert.match(markup, /AI did not return a usable proposal/);
  });

  test("proposal state renders a fallback Accept/Reject pair", () => {
    // The Option-A redesign moves the inline preview into the editor;
    // the in-popover fallback is just a brief notice + Accept/Reject so
    // unmasked callers don't end up with a dead UI.
    const proposal = buildProposal();
    const markup = render({ status: "proposal", proposal, intent });

    assert.match(markup, /Proposal ready/);
    assert.match(markup, />Accept</);
    assert.match(markup, />Reject</);
  });

  test("validation_invalid state lists errors and offers Try again", () => {
    const markup = render({
      status: "validation_invalid",
      proposal: buildProposal({
        validation: {
          status: "invalid",
          errors: [
            {
              code: "MDX_UNKNOWN_COMPONENT",
              message: "Component <Callout> is not registered.",
            },
          ],
        },
      }),
      intent,
    });

    assert.match(markup, /failed validation/);
    assert.match(markup, /MDX_UNKNOWN_COMPONENT/);
    assert.match(markup, /Component &lt;Callout&gt; is not registered\./);
    assert.match(markup, /Try again/);
    assert.match(markup, /Dismiss/);
  });

  test("applying state renders an 'Applying' polite status row", () => {
    const markup = render({ status: "applying", proposal: buildProposal() });
    assert.match(markup, /Applying…/);
    assert.match(markup, /aria-live="polite"/);
  });

  test("applied state announces success", () => {
    const proposal = buildProposal();
    const markup = render({
      status: "applied",
      proposal,
      document: {
        documentId: "doc_1",
        translationGroupId: "tg_1",
        project: "demo",
        environment: "draft",
        path: "blog/welcome",
        type: "post",
        locale: "en",
        format: "md",
        isDeleted: false,
        hasUnpublishedChanges: true,
        version: 1,
        publishedVersion: null,
        draftRevision: 5,
        frontmatter: {},
        body: "Hi there.",
        createdBy: "u",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedBy: "u",
        updatedAt: "2026-05-01T00:00:01.000Z",
      },
    });

    assert.match(markup, /Proposal applied/);
  });

  test("stale state surfaces server message + Try again", () => {
    const markup = render({
      status: "stale",
      proposal: buildProposal(),
      message: "Proposal base draft revision no longer matches the live draft.",
    });

    assert.match(markup, /no longer matches/);
    assert.match(markup, /Try again/);
    assert.match(markup, /Dismiss/);
  });

  test("forbidden state shows the unavailable copy", () => {
    const markup = render({
      status: "forbidden",
      message: "AI provider is not configured for this deployment.",
    });

    assert.match(markup, /AI is unavailable/);
    assert.match(markup, /provider is not configured/);
  });

  test("error state surfaces the error code + message and Try again / Dismiss", () => {
    const markup = render({
      status: "error",
      code: "AI_RATE_LIMITED",
      message: "Slow down.",
    });

    assert.match(markup, /AI_RATE_LIMITED/);
    assert.match(markup, /Slow down\./);
    assert.match(markup, /Try again/);
    assert.match(markup, /Dismiss/);
  });
});
