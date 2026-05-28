import assert from "node:assert/strict";

import { test } from "bun:test";

import type { ApiKeyCreateResult } from "../../api-keys-api.js";
import {
  apiKeyCreateDialogFormReducer,
  buildApiKeyCreateInput,
  createInitialApiKeyCreateDialogFormState,
  isApiKeyCreateDialogSubmittable,
} from "./api-key-create-dialog.js";

test("buildApiKeyCreateInput trims labels and scopes the key to the mounted target", () => {
  const input = buildApiKeyCreateInput({
    label: " CI deploy ",
    selectedScopes: new Set(["content:read", "schema:read"]),
    expiresAt: "2026-06-01",
    project: "marketing-site",
    environment: "production",
  });

  assert.equal(input.label, "CI deploy");
  assert.deepEqual(input.scopes, ["content:read", "schema:read"]);
  assert.deepEqual(input.contextAllowlist, [
    { project: "marketing-site", environment: "production" },
  ]);
  assert.equal(input.expiresAt, "2026-06-01T00:00:00.000Z");
});

test("isApiKeyCreateDialogSubmittable requires a label, at least one scope, and idle mutation state", () => {
  const state = apiKeyCreateDialogFormReducer(
    apiKeyCreateDialogFormReducer(createInitialApiKeyCreateDialogFormState(), {
      type: "label-change",
      value: "Preview",
    }),
    { type: "scope-toggle", scope: "content:read" },
  );

  assert.equal(isApiKeyCreateDialogSubmittable(state, false), true);
  assert.equal(isApiKeyCreateDialogSubmittable(state, true), false);
  assert.equal(
    isApiKeyCreateDialogSubmittable(
      { ...state, selectedScopes: new Set() },
      false,
    ),
    false,
  );
});

test("apiKeyCreateDialogFormReducer preserves the one-time API key reveal after creation", () => {
  const result: ApiKeyCreateResult = {
    id: "key-1",
    label: "Preview",
    keyPrefix: "mdcms_key_abc123",
    key: "mdcms_key_secret_once",
    scopes: ["content:read"],
    contextAllowlist: [{ project: "marketing-site", environment: "staging" }],
    createdByUserId: "user-1",
    createdAt: "2026-03-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  };

  const state = apiKeyCreateDialogFormReducer(
    createInitialApiKeyCreateDialogFormState(),
    { type: "submit-success", result },
  );

  assert.equal(state.step, "created");
  assert.equal(state.createdResult?.key, "mdcms_key_secret_once");
  assert.equal(state.createdResult?.keyPrefix, "mdcms_key_abc123");
});
