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
import type { AssistantMessage } from "./assistant-types.js";

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

test("assistant pending progress renders between streamed text blocks and collapses earlier groups", () => {
  const message = {
    id: "msg-stream",
    role: "assistant",
    text: "Let me check what components are available.\nGot what I need. Now I'll build the page.",
    streamBlocks: [
      {
        kind: "text",
        text: "Let me check what components are available.",
      },
      {
        kind: "progress",
        events: [
          {
            phase: "tool-call",
            status: "started",
            toolName: "component_reference",
            message: "Read component reference tool started",
          },
          {
            phase: "tool-result",
            status: "completed",
            toolName: "component_reference",
            message: "Read component reference completed",
          },
          {
            phase: "tool-call",
            status: "started",
            toolName: "component_reference",
            message: "Read component reference tool started",
          },
          {
            phase: "tool-result",
            status: "completed",
            toolName: "component_reference",
            message: "Read component reference completed",
          },
        ],
      },
      {
        kind: "text",
        text: "Got what I need. Now I'll build the page.",
      },
      {
        kind: "progress",
        events: [
          {
            phase: "thinking",
            message: "Thinking through the request",
          },
        ],
      },
    ],
    progress: [
      {
        phase: "thinking",
        message: "Thinking through the request",
      },
    ],
    at: "2026-05-22T12:00:00.000Z",
  } satisfies AssistantMessage;

  const markup = renderToStaticMarkup(
    <AssistantBubble
      message={message}
      proposalsById={{}}
      documentPathById={new Map()}
      isStreamingPlaceholder
      onAccept={() => undefined}
      onReject={() => undefined}
    />,
  );

  assert.match(markup, /data-mdcms-assistant-progress-collapsed/);
  assert.match(markup, /2 tool calls appended/);

  const firstTextIndex = markup.indexOf(
    "Let me check what components are available.",
  );
  const collapsedIndex = markup.indexOf("2 tool calls appended");
  const secondTextIndex = markup.indexOf(
    "Got what I need. Now I&#x27;ll build the page.",
  );
  const trailingProgressIndex = markup.indexOf("Thinking through the request");

  assert.ok(firstTextIndex >= 0);
  assert.ok(collapsedIndex > firstTextIndex);
  assert.ok(secondTextIndex > collapsedIndex);
  assert.ok(trailingProgressIndex > secondTextIndex);
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
