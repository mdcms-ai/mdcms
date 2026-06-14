import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CollaborationPresenceCursorSchema,
  CollaborationPresenceSnapshotSchema,
  CollaborationPresenceUpdateSchema,
} from "./collaboration.js";

test("collaboration presence schemas parse updates and snapshots", () => {
  const update = CollaborationPresenceUpdateSchema.parse({
    type: "presence.update",
    documentId: "11111111-1111-4111-8111-111111111111",
    mode: "edit",
    cursor: { anchor: 2, head: 7 },
  });
  assert.equal(update.mode, "edit");

  const snapshot = CollaborationPresenceSnapshotSchema.parse({
    type: "presence.snapshot",
    project: "marketing",
    environment: "draft",
    users: [
      {
        userId: "user-1",
        sessionId: "session-1",
        label: "Ada",
        color: "#2563eb",
        documentId: "11111111-1111-4111-8111-111111111111",
        mode: "view",
        cursor: { anchor: 1, head: 1 },
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ],
  });
  assert.equal(snapshot.users[0]?.label, "Ada");
});

test("collaboration presence schemas reject invalid modes and cursors", () => {
  assert.equal(
    CollaborationPresenceUpdateSchema.safeParse({
      type: "presence.update",
      mode: "publish",
    }).success,
    false,
  );
  assert.equal(
    CollaborationPresenceCursorSchema.safeParse({ anchor: -1, head: 1 })
      .success,
    false,
  );
});
