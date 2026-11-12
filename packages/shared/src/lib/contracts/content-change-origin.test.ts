import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  DECLARED_CLIENT_MAX_LENGTH,
  formatContentChangeOrigin,
  parseContentChangeOrigin,
  parseDeclaredClient,
} from "./content-change-origin.js";

test("parseDeclaredClient trims and accepts printable ASCII", () => {
  assert.equal(parseDeclaredClient("  cli/0.4.0 "), "cli/0.4.0");
  assert.equal(parseDeclaredClient("claude-code 1.2"), "claude-code 1.2");
});

test("parseDeclaredClient ignores missing, empty, long and non-printable values", () => {
  assert.equal(parseDeclaredClient(null), undefined);
  assert.equal(parseDeclaredClient(undefined), undefined);
  assert.equal(parseDeclaredClient("   "), undefined);
  assert.equal(
    parseDeclaredClient("x".repeat(DECLARED_CLIENT_MAX_LENGTH + 1)),
    undefined,
  );
  assert.equal(parseDeclaredClient("cli\u0007"), undefined);
  assert.equal(parseDeclaredClient("klient/1 ż"), undefined);
});

test("parseContentChangeOrigin accepts a valid origin and rejects others", () => {
  assert.deepEqual(
    parseContentChangeOrigin({
      channel: "api",
      credential: "api_key",
      apiKeyId: "key-1",
      declared: "cli/0.4.0",
    }),
    {
      channel: "api",
      credential: "api_key",
      apiKeyId: "key-1",
      declared: "cli/0.4.0",
    },
  );
  assert.equal(parseContentChangeOrigin(null), undefined);
  assert.equal(
    parseContentChangeOrigin({ channel: "fax", credential: "session" }),
    undefined,
  );
  assert.equal(
    parseContentChangeOrigin({
      channel: "api",
      credential: "api_key",
      declared: "klient/1 \u017c",
    }),
    undefined,
  );
});

test("formatContentChangeOrigin labels channels and appends the declared name", () => {
  assert.equal(
    formatContentChangeOrigin({ channel: "studio", credential: "session" }),
    "Studio",
  );
  assert.equal(
    formatContentChangeOrigin({ channel: "studio_ai", credential: "session" }),
    "Studio AI",
  );
  assert.equal(
    formatContentChangeOrigin({
      channel: "mcp",
      credential: "oauth",
      oauthClientId: "client-1",
      declared: "claude-code 1.2",
    }),
    "MCP (claude-code 1.2)",
  );
  assert.equal(
    formatContentChangeOrigin({ channel: "system", credential: "system" }),
    "System",
  );
});
