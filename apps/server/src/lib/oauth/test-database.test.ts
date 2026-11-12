import assert from "node:assert/strict";
import { test } from "bun:test";
import { oauthTestDatabase } from "./test-database.js";

test("OAuth database tests require explicit isolated integration configuration", () => {
  assert.equal(
    oauthTestDatabase({ DATABASE_URL: "postgres://localhost/development" }).url,
    undefined,
  );
  assert.throws(
    () => oauthTestDatabase({ MDCMS_OAUTH_INTEGRATION: "1" }),
    /required/,
  );
  assert.throws(
    () =>
      oauthTestDatabase({
        MDCMS_TEST_DATABASE_URL: "postgres://localhost/mdcms",
      }),
    /test or verify/,
  );
  assert.equal(
    oauthTestDatabase({
      MDCMS_TEST_DATABASE_URL: "postgres://localhost/oauth_test",
    }).test,
    test,
  );
});
