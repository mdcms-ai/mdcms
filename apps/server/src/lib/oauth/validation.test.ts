import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  matchesRedirect,
  parseRegistration,
  parseAuthorization,
} from "./validation.js";

test("registration rejects unsafe redirects and unsupported metadata", () => {
  for (const uri of [
    "http://example.com/cb",
    "https://user@example.com/cb",
    "https://example.com/cb#",
    "https://*.example.com/cb",
    "http://localhost/cb",
    "http://127.1/cb",
    "http://2130706433/cb",
  ])
    assert.throws(() =>
      parseRegistration({
        client_name: "Client",
        redirect_uris: [uri],
        token_endpoint_auth_method: "none",
      }),
    );
  assert.throws(() =>
    parseRegistration({
      client_name: "Client",
      redirect_uris: ["https://example.com"],
      token_endpoint_auth_method: "none",
      client_uri: "https://example.com",
    }),
  );
});
test("only literal HTTP loopback ports may vary during authorization", () => {
  for (const host of ["127.0.0.1", "[::1]"]) {
    assert.equal(
      matchesRedirect(
        `http://${host}:1234/cb?q=1`,
        `http://${host}:9999/cb?q=1`,
      ),
      true,
    );
    assert.equal(
      matchesRedirect(
        `http://${host}:1234/cb?q=1`,
        `http://${host}:9999/other?q=1`,
      ),
      false,
    );
    assert.equal(
      matchesRedirect(`https://${host}:1234/cb`, `https://${host}:9999/cb`),
      false,
    );
  }
  assert.equal(
    matchesRedirect("http://127.0.0.1/cb", "http://[::1]/cb"),
    false,
  );
  assert.equal(
    matchesRedirect(
      "http://127.0.0.1:123/cb",
      "http://127.0.0.1:456/other/../cb",
    ),
    false,
  );
});
test("authorization requires S256, exact resource, scopes and state", () => {
  const request = new URLSearchParams({
    response_type: "code",
    client_id: "client",
    redirect_uri: "https://client.example/cb",
    scope: "content:read",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    resource: "https://cms.example/api/v1/mcp",
    state: "opaque",
  });
  assert.equal(
    parseAuthorization(request, "https://cms.example/api/v1/mcp").clientId,
    "client",
  );
  request.set("code_challenge_method", "plain");
  assert.throws(() =>
    parseAuthorization(request, "https://cms.example/api/v1/mcp"),
  );
});
