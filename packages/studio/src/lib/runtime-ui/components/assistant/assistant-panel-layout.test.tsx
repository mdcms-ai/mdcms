import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { AssistantBubble } from "./assistant-panel.js";

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
