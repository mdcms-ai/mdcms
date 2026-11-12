import { test } from "bun:test";
import assert from "node:assert/strict";
import { createServerRequestHandler } from "../server.js";
import { baseEnv } from "../content-api-test-support.js";
import {
  createInternalDispatcher,
  stripInternalHeaders,
  trustedInternalChannel,
} from "./dispatcher.js";

test("public server handler strips internal headers before mounted routes", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      (
        app as {
          get: (
            path: string,
            handler: (ctx: { request: Request }) => unknown,
          ) => unknown;
        }
      ).get("/api/v1/content", ({ request }) => ({
        channel: request.headers.get("x-mdcms-internal-channel"),
        secret: request.headers.get("x-mdcms-internal"),
        future: request.headers.get("x-mdcms-internal-future"),
      }));
    },
  });
  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      headers: {
        "x-mdcms-project": "site",
        "x-mdcms-environment": "draft",
        "x-mdcms-internal": "forged",
        "x-mdcms-internal-channel": "mcp",
        "x-mdcms-internal-future": "forged",
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    channel: null,
    secret: null,
    future: null,
  });
});

test("dispatch fixes target and forwards only caller credentials", async () => {
  let received: Request | undefined;
  const dispatch = createInternalDispatcher(
    async (request) => {
      received = request;
      return new Response("ok");
    },
    "private-secret",
    {
      request: new Request("https://example.test/api/v1/ai", {
        headers: {
          authorization: "Bearer caller",
          cookie: "session=caller",
          "x-mdcms-csrf-token": "csrf",
          "x-mdcms-project": "spoof",
          "x-mdcms-internal-channel": "studio_ai",
        },
      }),
      project: "project",
      environment: "draft",
      channel: "mcp",
    },
  );
  await dispatch({
    method: "PUT",
    path: "/api/v1/content/doc",
    body: { body: "text" },
    schemaHash: "pinned",
  });
  assert.equal(received!.headers.get("authorization"), "Bearer caller");
  assert.equal(received!.headers.get("cookie"), null);
  assert.equal(received!.headers.get("x-mdcms-project"), "project");
  assert.equal(received!.headers.get("x-mdcms-schema-hash"), "pinned");
  assert.equal(trustedInternalChannel(received!, "private-secret"), "mcp");
  assert.equal(trustedInternalChannel(received!, "wrong"), undefined);
  assert.deepEqual(await received!.json(), { body: "text" });
});

test("session dispatch preserves cookie and CSRF without elevating credentials", async () => {
  const dispatch = createInternalDispatcher(
    async (request) => {
      assert.equal(request.headers.get("cookie"), "session=caller");
      assert.equal(request.headers.get("x-mdcms-csrf-token"), "csrf");
      assert.equal(request.headers.get("authorization"), null);
      return new Response();
    },
    "secret",
    {
      request: new Request("https://example.test", {
        headers: { cookie: "session=caller", "x-mdcms-csrf-token": "csrf" },
      }),
      project: "p",
      environment: "e",
      channel: "studio_ai",
    },
  );
  await dispatch({ method: "GET", path: "/api/v1/schema" });
});

for (const cookie of [undefined, "session=another-user"]) {
  test(`session-header dispatch preserves identity ${cookie ? "over an ambient cookie" : "without cookies"}`, async () => {
    const dispatch = createInternalDispatcher(
      async (request) => {
        assert.equal(request.headers.get("x-mdcms-session"), "studio-session");
        assert.equal(request.headers.get("cookie"), null);
        assert.equal(request.headers.get("authorization"), null);
        return new Response();
      },
      "secret",
      {
        request: new Request("https://example.test", {
          headers: {
            "x-mdcms-session": "studio-session",
            ...(cookie ? { cookie } : {}),
          },
        }),
        project: "p",
        environment: "e",
        channel: "studio_ai",
      },
    );
    await dispatch({ method: "GET", path: "/api/v1/schema" });
    await dispatch({ method: "POST", path: "/api/v1/content", body: {} });
  });
}

test("dispatch rejects escaped paths and target overrides before invoking handler", async () => {
  let calls = 0;
  const dispatch = createInternalDispatcher(
    async () => {
      calls++;
      return new Response();
    },
    "secret",
    {
      request: new Request("https://example.test"),
      project: "p",
      environment: "e",
      channel: "mcp",
    },
  );
  for (const path of [
    "https://evil.test/api/v1/content",
    "/api/v1/content/../auth",
    "/api/v1/content/%2e%2e/auth",
    "/api/v1/content?project=other",
    "/api/v1/auth",
    "/api/v1/content\\..\\auth",
    "/api/v1/content/%252e%252e/auth",
  ]) {
    await assert.rejects(dispatch({ method: "GET", path }));
  }
  await assert.rejects(
    dispatch({
      method: "GET",
      path: "/api/v1/content",
      query: { project: "other" },
    }),
  );
  assert.equal(calls, 0);
});

test("external ingress removes every internal header and preserves body and CSRF", async () => {
  const request = stripInternalHeaders(
    new Request("https://example.test/api/v1/content", {
      method: "POST",
      body: "body",
      headers: {
        "X-MDCMS-Internal": "secret",
        "X-MDCMS-Internal-Channel": "mcp",
        "X-MDCMS-InternalFuture": "forged",
        "X-MDCMS-CSRF-Token": "csrf",
      },
    }),
  );
  request.headers.forEach((_value, key) =>
    assert.equal(key.startsWith("x-mdcms-internal"), false),
  );
  assert.equal(trustedInternalChannel(request, "secret"), undefined);
  assert.equal(request.headers.get("x-mdcms-csrf-token"), "csrf");
  assert.equal(await request.text(), "body");
});
