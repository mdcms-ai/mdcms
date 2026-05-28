import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AssistantProvider } from "./assistant-context.js";
import { AssistantBubble, AssistantPanel } from "./assistant-panel.js";
import {
  AssistantRail,
  useAssistantMainPadding,
  useAssistantMainPaddingStyle,
} from "./assistant-rail.js";

function AssistantPaddingProbe() {
  return (
    <main
      data-mdcms-assistant-padding-probe=""
      className={useAssistantMainPadding()}
      style={useAssistantMainPaddingStyle()}
    />
  );
}

test("assistant message sparkle aligns with the first prose line", () => {
  const markup = renderToStaticMarkup(
    <AssistantBubble
      message={{
        id: "msg-1",
        role: "assistant",
        text: "I could update that section.",
        at: "2026-05-22T12:00:00.000Z",
      }}
      proposalsById={{}}
      documentPathById={new Map()}
      isStreamingPlaceholder={false}
      onAccept={() => undefined}
      onReject={() => undefined}
    />,
  );

  assert.match(markup, /w-6 shrink-0 pt-2 text-primary/);
});

test("assistant rail exposes a resize handle and default width", () => {
  const markup = renderToStaticMarkup(
    <AssistantProvider initialMode="rail">
      <AssistantRail sidebarCollapsed={false} />
    </AssistantProvider>,
  );

  assert.match(markup, /data-mdcms-assistant-rail-width="420"/);
  assert.match(markup, /data-mdcms-assistant-resize-handle/);
  assert.match(markup, /aria-label="Resize AI assistant"/);
  assert.match(markup, /role="separator"/);
});

test("assistant main padding uses the current rail width variable", () => {
  const markup = renderToStaticMarkup(
    <AssistantProvider initialMode="rail" initialRailWidth={560}>
      <AssistantPaddingProbe />
    </AssistantProvider>,
  );

  assert.match(markup, /pr-\[var\(--mdcms-assistant-rail-width\)\]/);
  assert.match(markup, /--mdcms-assistant-rail-width:560px/);
});

test("assistant composer stays editable while a response is pending", () => {
  const markup = renderToStaticMarkup(
    <AssistantProvider initialMode="rail" initialPending>
      <AssistantPanel hideClose hideThreadList />
    </AssistantProvider>,
  );

  assert.match(markup, /Streaming… Esc to stop/);
  assert.match(markup, /aria-label="Stop generating"/);
  assert.match(markup, /placeholder="Draft your next message…"/);
  assert.doesNotMatch(markup, /<textarea[^>]*disabled/);
  assert.doesNotMatch(markup, /cursor-not-allowed/);
});
