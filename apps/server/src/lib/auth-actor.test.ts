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
