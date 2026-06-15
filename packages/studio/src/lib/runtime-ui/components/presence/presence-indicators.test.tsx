import assert from "node:assert/strict";

import { test } from "bun:test";
import type { CollaborationPresenceUser } from "@mdcms/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PresenceIndicators } from "./presence-indicators.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function presenceUser(
  overrides: Partial<CollaborationPresenceUser>,
): CollaborationPresenceUser {
  return {
    userId: "user-1",
    sessionId: "session-1",
    label: "Ada",
    color: "#2563eb",
    documentId: DOCUMENT_ID,
    mode: "view",
    updatedAt: "2026-06-14T10:00:00.000Z",
    ...overrides,
  };
}

test("PresenceIndicators renders compact mode-marked avatars with accessible labels", () => {
  const markup = renderToStaticMarkup(
    createElement(PresenceIndicators, {
      users: [
        presenceUser({
          sessionId: "session-ada",
          label: "Ada Lovelace",
          mode: "edit",
          color: "#2563eb",
        }),
        presenceUser({
          sessionId: "session-grace",
          label: "Grace Hopper",
          mode: "view",
          color: "#16a34a",
        }),
      ],
    }),
  );

  assert.match(markup, /data-mdcms-presence-indicators="true"/);
  assert.match(markup, /data-mdcms-presence-mode="edit"/);
  assert.match(markup, /data-mdcms-presence-mode="view"/);
  assert.match(markup, /role="img"/);
  assert.match(markup, /Ada Lovelace editing/);
  assert.match(markup, /Grace Hopper viewing/);
  assert.match(markup, /AL/);
  assert.match(markup, /GH/);
});

test("PresenceIndicators renders nothing without users", () => {
  const markup = renderToStaticMarkup(
    createElement(PresenceIndicators, { users: [] }),
  );

  assert.equal(markup, "");
});
