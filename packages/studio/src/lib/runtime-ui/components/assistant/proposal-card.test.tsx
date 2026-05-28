import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppliedBanner, ProposalCard } from "./proposal-card.js";
import type { AssistantProposalEdit } from "./assistant-types.js";

function buildAcceptedEditProposal(
  overrides: Partial<AssistantProposalEdit> = {},
): AssistantProposalEdit {
  return {
    proposalId: "proposal_1",
    kind: "replace_selection",
    docPath: "posts/releases/mdcms-milestone-2-0-technical",
    type: "post",
    locale: "en",
    summary: "Remove section",
    acceptedAt: "2026-05-18T10:00:00Z",
    validation: { status: "valid" },
    diffStats: { added: 0, removed: 4 },
    op: {
      op: "replace_selection",
      selectionId: "sel_1",
      originalText: "Performance Benchmarks\n- Build Time",
      replacementText: "",
    },
    ...overrides,
  };
}

test("AppliedBanner uses the bright lime token for the check icon", () => {
  const markup = renderToStaticMarkup(
    createElement(AppliedBanner, {
      proposal: buildAcceptedEditProposal(),
      canUndo: false,
      onExpire: () => {},
    }),
  );

  assert.match(markup, /text-vibrant-green/);
  assert.doesNotMatch(markup, /text-vibrant-green-foreground/);
});

test("ProposalCard keeps collapse header padding stable when expanded or collapsed", () => {
  const collapsed = renderToStaticMarkup(
    createElement(ProposalCard, {
      proposal: buildAcceptedEditProposal({ acceptedAt: undefined }),
      defaultCollapsed: true,
      onAccept: () => {},
      onReject: () => {},
    }),
  );
  const expanded = renderToStaticMarkup(
    createElement(ProposalCard, {
      proposal: buildAcceptedEditProposal({ acceptedAt: undefined }),
      defaultCollapsed: false,
      onAccept: () => {},
      onReject: () => {},
    }),
  );

  assert.doesNotMatch(collapsed, /pb-2\.5|pb-1/);
  assert.doesNotMatch(expanded, /pb-2\.5|pb-1/);
});

test("ProposalCard keeps accepted proposal details expandable for history", () => {
  const markup = renderToStaticMarkup(
    createElement(ProposalCard, {
      proposal: buildAcceptedEditProposal({
        diffStats: { added: 1, removed: 1 },
        op: {
          op: "replace_selection",
          selectionId: "sel_1",
          originalText: "Old homepage copy",
          replacementText: "New homepage copy",
        },
      }),
      onAccept: () => {},
      onReject: () => {},
    }),
  );

  assert.match(markup, /View applied change/);
  assert.match(markup, /Old homepage copy/);
  assert.match(markup, /New homepage copy/);
  assert.doesNotMatch(markup, />Accept</);
});
