import assert from "node:assert/strict";
import { test } from "bun:test";

import { actorFromAuthorizedRequest } from "./auth.js";

test("authorized API key actors resolve to the API key owner email", () => {
  const actor = actorFromAuthorizedRequest({
    mode: "api_key",
    principal: {
      type: "api_key",
      keyId: "key-1",
      createdByUserId: "user-1",
      createdByUserEmail: "owner@example.com",
      keyPrefix: "mdcms_live_1234",
      label: "Build hook",
      scopes: ["content:write"],
      contextAllowlist: [
        {
          project: "marketing-site",
          environment: "production",
        },
      ],
    },
  });

  assert.deepEqual(actor, {
    id: "user-1",
    email: "owner@example.com",
  });
});

test("OAuth attribution uses the granting user", () => {
  assert.deepEqual(
    actorFromAuthorizedRequest({
      mode: "oauth",
      principal: {
        type: "oauth",
        clientId: "client",
        userId: "user",
        email: "user@example.invalid",
        scopes: ["content:read"],
        target: { project: "project", environment: "draft" },
      },
    }),
    { id: "user", email: "user@example.invalid" },
  );
});

test("environment metadata scopes are issuable only by global admins and owners", async () => {
  const { assertGrantsCanIssueApiKeyScopes } = await import("./auth.js");
  for (const role of ["admin", "owner"] as const)
    assert.doesNotThrow(() =>
      assertGrantsCanIssueApiKeyScopes(
        [{ role, scope: { kind: "global" } }],
        ["environments:read"],
        [{ project: "p", environment: "draft" }],
      ),
    );
  for (const role of ["viewer", "editor"] as const)
    assert.throws(() =>
      assertGrantsCanIssueApiKeyScopes(
        [{ role, scope: { kind: "global" } }],
        ["environments:read"],
        [{ project: "p", environment: "draft" }],
      ),
    );
});
