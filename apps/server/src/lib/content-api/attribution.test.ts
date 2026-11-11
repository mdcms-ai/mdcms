import assert from "node:assert/strict";
import { test } from "bun:test";

import type { AuthorizedRequest } from "../auth.js";
import {
  attributionFromAuthorizedRequest,
  systemAttribution,
} from "./attribution.js";
import { DEFAULT_ACTOR } from "./types.js";

const sessionAuthorization = {
  mode: "session",
  principal: {
    type: "session",
    session: {
      id: "session-1",
      userId: "user-ada",
      email: "ada@example.com",
      issuedAt: "2026-11-11T00:00:00.000Z",
      expiresAt: "2026-11-12T00:00:00.000Z",
    },
  },
} satisfies AuthorizedRequest;

const apiKeyAuthorization = {
  mode: "api_key",
  principal: {
    type: "api_key",
    keyId: "key-1",
    createdByUserId: "user-grace",
    createdByUserEmail: "grace@example.com",
    keyPrefix: "mdcms_key_ab",
    label: "cli:site/production",
    scopes: ["content:write"],
    contextAllowlist: [{ project: "site", environment: "production" }],
  },
} satisfies AuthorizedRequest;

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/content", { headers });
}

test("session requests are attributed to the session user through Studio", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request(),
      authorization: sessionAuthorization,
    }),
    {
      actorId: "user-ada",
      origin: { channel: "studio", credential: "session" },
    },
  );
});

test("API key requests are attributed to the key creator with the key id", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request({ "x-mdcms-client": "cli/0.4.0" }),
      authorization: apiKeyAuthorization,
    }),
    {
      actorId: "user-grace",
      origin: {
        channel: "api",
        credential: "api_key",
        apiKeyId: "key-1",
        declared: "cli/0.4.0",
      },
    },
  );
});

test("an explicit channel and declared name override the defaults", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request({ "x-mdcms-client": "ignored/1.0" }),
      authorization: sessionAuthorization,
      channel: "studio_ai",
      declared: "assistant",
    }),
    {
      actorId: "user-ada",
      origin: {
        channel: "studio_ai",
        credential: "session",
        declared: "assistant",
      },
    },
  );
});

test("an invalid declared header is dropped", () => {
  const attribution = attributionFromAuthorizedRequest({
    request: request({ "x-mdcms-client": "x".repeat(200) }),
    authorization: apiKeyAuthorization,
  });

  assert.equal(attribution.origin.declared, undefined);
});

test("system attribution uses the placeholder actor by default", () => {
  assert.deepEqual(systemAttribution(), {
    actorId: DEFAULT_ACTOR,
    origin: { channel: "system", credential: "system" },
  });
  assert.equal(systemAttribution("user-seed").actorId, "user-seed");
});
