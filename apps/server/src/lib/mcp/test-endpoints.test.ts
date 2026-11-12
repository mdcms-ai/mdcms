import assert from "node:assert/strict";
import { test } from "bun:test";
import { mcpIntegrationEndpoints } from "./test-endpoints.js";

const fixture = {
  MDCMS_MCP_INTEGRATION: "1",
  MDCMS_TEST_DATABASE_URL: "postgres://127.0.0.1:12345/mdcms_test",
  MDCMS_TEST_SERVER_URL: "http://127.0.0.1:12346",
};

test("ambient endpoints never opt into mutating MCP integration", () => {
  assert.equal(
    mcpIntegrationEndpoints({ ...fixture, MDCMS_MCP_INTEGRATION: undefined }),
    undefined,
  );
});

test("MCP integration requires explicit loopback test endpoints", () => {
  for (const overrides of [
    { MDCMS_TEST_DATABASE_URL: undefined },
    { MDCMS_TEST_DATABASE_URL: "postgres://remote.test/mdcms_test" },
    { MDCMS_TEST_DATABASE_URL: "postgres://127.0.0.1/mdcms" },
    { MDCMS_TEST_SERVER_URL: undefined },
    { MDCMS_TEST_SERVER_URL: "https://example.test" },
    { MDCMS_TEST_SERVER_URL: "http://user:password@127.0.0.1:12346" },
    { MDCMS_TEST_SERVER_URL: "http://127.0.0.1:12346/other" },
    { MDCMS_TEST_SERVER_URL: "http://127.0.0.1:12346?target=other" },
  ]) {
    assert.throws(() => mcpIntegrationEndpoints({ ...fixture, ...overrides }));
  }
  assert.deepEqual(mcpIntegrationEndpoints(fixture), {
    databaseUrl: fixture.MDCMS_TEST_DATABASE_URL,
    serverUrl: fixture.MDCMS_TEST_SERVER_URL,
  });
});
