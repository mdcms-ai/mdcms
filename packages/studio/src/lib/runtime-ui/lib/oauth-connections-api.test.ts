import assert from "node:assert/strict";
import { test } from "bun:test";
import { createOAuthConnectionsApi } from "./oauth-connections-api.js";

test("lists with explicit project and cookie transport, revokes with CSRF", async () => {
  const calls: RequestInit[] = [];
  const urls: string[] = [];
  const api = createOAuthConnectionsApi(
    { serverUrl: "https://cms.example.com", project: "demo" },
    {
      auth: { mode: "cookie" },
      csrfToken: "fixture-csrf",
      fetcher: (async (url, init) => {
        urls.push(String(url));
        calls.push(init!);
        return Response.json({
          data: init?.method === "DELETE" ? { id: "a/b", revoked: true } : [],
        });
      }) as typeof fetch,
    },
  );
  assert.deepEqual(await api.list(), []);
  await api.revoke("a/b");
  assert.equal(calls[0]?.credentials, "include");
  assert.equal(new Headers(calls[0]?.headers).get("x-mdcms-project"), "demo");
  assert.equal(
    new Headers(calls[1]?.headers).get("x-mdcms-csrf-token"),
    "fixture-csrf",
  );
  assert.ok(urls[1]?.endsWith("/a%2Fb"));
});
test("token auth and missing CSRF never fetch management endpoints", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ data: [] });
  }) as typeof fetch;
  const config = { serverUrl: "https://cms.example.com", project: "demo" };
  await assert.rejects(
    createOAuthConnectionsApi(config, {
      auth: { mode: "token", token: "fixture" },
      fetcher,
    }).list(),
    /Sign in/,
  );
  await assert.rejects(
    createOAuthConnectionsApi(config, { fetcher }).revoke("id"),
    /CSRF/,
  );
  assert.equal(calls, 0);
});
test("failed revoke and malformed success are rejected", async () => {
  for (const response of [
    Response.json({ message: "Forbidden" }, { status: 403 }),
    Response.json({ data: { revoked: false } }),
  ]) {
    const api = createOAuthConnectionsApi(
      { serverUrl: "https://cms.example.com", project: "demo" },
      { csrfToken: "fixture", fetcher: (async () => response) as typeof fetch },
    );
    await assert.rejects(api.revoke("id"));
  }
});
