import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  getCollaborationReconnectDelayMs,
  isCollaborationCloseRetryable,
} from "./collaboration-reconnect.js";

test("collaboration reconnect delays retry immediately then back off with a cap", () => {
  assert.equal(getCollaborationReconnectDelayMs(0), 0);
  assert.equal(getCollaborationReconnectDelayMs(1), 1000);
  assert.equal(getCollaborationReconnectDelayMs(2), 2000);
  assert.equal(getCollaborationReconnectDelayMs(3), 4000);
  assert.equal(getCollaborationReconnectDelayMs(4), 10_000);
  assert.equal(getCollaborationReconnectDelayMs(99), 10_000);
});

test("collaboration reconnect retries transient closes but not authorization failures", () => {
  assert.equal(isCollaborationCloseRetryable({ code: 1001 }), true);
  assert.equal(isCollaborationCloseRetryable({ code: 1006 }), true);
  assert.equal(isCollaborationCloseRetryable({ code: 1011 }), true);
  assert.equal(isCollaborationCloseRetryable({ code: 4401 }), false);
  assert.equal(isCollaborationCloseRetryable({ code: 4403 }), false);
});
