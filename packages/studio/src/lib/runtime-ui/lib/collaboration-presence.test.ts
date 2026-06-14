import assert from "node:assert/strict";

import { test } from "bun:test";
import type { CollaborationPresenceUser } from "@mdcms/shared";

import {
  createPresenceConnectionKey,
  createPresenceWebSocketUrl,
  groupPresenceByDocument,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  parsePresenceSnapshot,
} from "./collaboration-presence.js";

const DOCUMENT_A = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_B = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_HIDDEN = "33333333-3333-4333-8333-333333333333";
const SERVER_PRESENCE_TTL_MS = 30_000;

function presenceUser(
  overrides: Partial<CollaborationPresenceUser>,
): CollaborationPresenceUser {
  return {
    userId: "user-1",
    sessionId: "session-1",
    label: "Ada",
    color: "#2563eb",
    documentId: DOCUMENT_A,
    mode: "view",
    updatedAt: "2026-06-14T10:00:00.000Z",
    ...overrides,
  };
}

test("createPresenceWebSocketUrl converts http server URLs to the presence ws endpoint", () => {
  assert.equal(
    createPresenceWebSocketUrl({
      serverUrl: "http://localhost:4000",
      project: "marketing",
      environment: "draft",
    }),
    "ws://localhost:4000/api/v1/collaboration/presence?project=marketing&environment=draft",
  );
});

test("createPresenceWebSocketUrl preserves server path prefixes when converting https URLs", () => {
  assert.equal(
    createPresenceWebSocketUrl({
      serverUrl: "https://cms.example.com/api",
      project: "marketing site",
      environment: "preview/draft",
    }),
    "wss://cms.example.com/api/api/v1/collaboration/presence?project=marketing+site&environment=preview%2Fdraft",
  );
});

test("PRESENCE_HEARTBEAT_INTERVAL_MS refreshes presence before the server TTL", () => {
  assert.equal(PRESENCE_HEARTBEAT_INTERVAL_MS, 20_000);
  assert.ok(PRESENCE_HEARTBEAT_INTERVAL_MS < SERVER_PRESENCE_TTL_MS);
});

test("createPresenceConnectionKey changes when the authenticated session changes", () => {
  const webSocketUrl =
    "ws://localhost:4000/api/v1/collaboration/presence?project=marketing&environment=draft";

  assert.notEqual(
    createPresenceConnectionKey({
      webSocketUrl,
      currentSessionId: "session-1",
    }),
    createPresenceConnectionKey({
      webSocketUrl,
      currentSessionId: "session-2",
    }),
  );
});

test("parsePresenceSnapshot returns a parsed snapshot and rejects unknown shapes", () => {
  const parsed = parsePresenceSnapshot(
    JSON.stringify({
      type: "presence.snapshot",
      project: "marketing",
      environment: "draft",
      users: [
        presenceUser({
          sessionId: "session-ada",
          label: "Ada",
          mode: "edit",
          cursor: { anchor: 2, head: 7 },
        }),
      ],
    }),
  );

  assert.equal(parsed?.users[0]?.label, "Ada");
  assert.equal(parsePresenceSnapshot('{"type":"presence.unknown"}'), null);
  assert.equal(parsePresenceSnapshot({ type: "presence.snapshot" }), null);
  assert.equal(parsePresenceSnapshot("not json"), null);
});

test("groupPresenceByDocument filters current and hidden users then sorts edit users first", () => {
  const grouped = groupPresenceByDocument(
    [
      presenceUser({
        sessionId: "current-session",
        label: "Current",
        documentId: DOCUMENT_A,
        mode: "edit",
      }),
      presenceUser({
        sessionId: "session-grace",
        label: "Grace",
        documentId: DOCUMENT_A,
        mode: "view",
      }),
      presenceUser({
        sessionId: "session-zed",
        label: "Zed",
        documentId: DOCUMENT_A,
        mode: "edit",
      }),
      presenceUser({
        sessionId: "session-ada",
        label: "Ada",
        documentId: DOCUMENT_A,
        mode: "edit",
      }),
      presenceUser({
        sessionId: "session-hidden",
        label: "Hidden",
        documentId: DOCUMENT_HIDDEN,
        mode: "edit",
      }),
      presenceUser({
        sessionId: "session-target",
        label: "Target",
        documentId: null,
        mode: "view",
      }),
      presenceUser({
        sessionId: "session-ben",
        label: "Ben",
        documentId: DOCUMENT_B,
        mode: "view",
      }),
    ],
    {
      visibleDocumentIds: [DOCUMENT_A, DOCUMENT_B],
      currentSessionId: "current-session",
    },
  );

  assert.deepEqual(Array.from(grouped.keys()), [DOCUMENT_A, DOCUMENT_B]);
  assert.deepEqual(
    grouped.get(DOCUMENT_A)?.map((user) => `${user.label}:${user.mode}`),
    ["Ada:edit", "Zed:edit", "Grace:view"],
  );
  assert.deepEqual(
    grouped.get(DOCUMENT_B)?.map((user) => `${user.label}:${user.mode}`),
    ["Ben:view"],
  );
});
