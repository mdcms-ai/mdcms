import assert from "node:assert/strict";
import { test } from "bun:test";
import { integrationTestDatabaseUrl } from "./integration-test-database.js";

test("ordinary discovery ignores ambient application database", () => {
  assert.equal(
    integrationTestDatabaseUrl({ DATABASE_URL: "postgres://localhost/mdcms" }),
    undefined,
  );
});
test("mandatory integration requires explicit test database on loopback", () => {
  for (const env of [
    { MDCMS_REQUIRE_TEST_DATABASE: "1" },
    { MDCMS_TEST_DATABASE_URL: "postgres://localhost/mdcms" },
    { MDCMS_TEST_DATABASE_URL: "postgres://remote/mdcms_test" },
  ]) {
    assert.throws(() => integrationTestDatabaseUrl(env));
  }
  assert.equal(
    integrationTestDatabaseUrl({
      MDCMS_TEST_DATABASE_URL: "postgres://127.0.0.1:12345/mdcms_test",
    }),
    "postgres://127.0.0.1:12345/mdcms_test",
  );
});
