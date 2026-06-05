import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import { assertWebhookTargetAllowed } from "./target-url.js";

test("webhook target validation rejects resolver results that are not IP addresses", async () => {
  await assert.rejects(
    () =>
      assertWebhookTargetAllowed("https://customer-webhook.example/hooks", {
        resolveAddresses: async () => ["customer-webhook.example"],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.code, "WEBHOOK_TARGET_FORBIDDEN");
      assert.equal(error.details?.reason, "resolved_address_invalid");
      return true;
    },
  );
});
