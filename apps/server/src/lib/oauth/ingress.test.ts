import assert from "node:assert/strict";
import { test } from "bun:test";
import { createConsoleLogger } from "@mdcms/shared";
import { Elysia } from "elysia";
import { createServerRequestHandler } from "../server.js";

const handler = createServerRequestHandler({
  logger: createConsoleLogger({ level: "error", sink: () => undefined }),
  env: {
    NODE_ENV: "test",
    MDCMS_SERVER_URL: "https://cms.example",
    MDCMS_STUDIO_ALLOWED_ORIGINS: "https://app.example",
  },
  configureApp(app) {
    (app as Elysia)
      .all(
        "/api/v1/oauth/authorize",
        ({ request }) =>
          new Response("<p>Restart authorization</p>", {
            status: Number(request.headers.get("x-test-status") ?? 410),
            headers: {
              "content-type": "text/html",
              "cache-control": "no-store",
              "retry-after": "60",
            },
          }),
      )
      .post(
        "/api/v1/mcp",
        () =>
          new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://cms.example/.well-known/oauth-protected-resource/api/v1/mcp"',
            },
          }),
      );
  },
});
test("OAuth HTML errors survive external ingress with security headers", async () => {
  for (const method of ["GET", "POST"])
    for (const status of [400, 410, 429, 503]) {
      const response = await handler(
        new Request("https://cms.example/api/v1/oauth/authorize", {
          method,
          headers: {
            origin: "https://app.example",
            "x-test-status": String(status),
          },
        }),
      );
      assert.equal(response.status, status);
      assert.ok(response.headers.get("content-type")?.includes("text/html"));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "60");
      assert.equal(await response.text(), "<p>Restart authorization</p>");
    }
});
test("MCP CORS preflight precedes authentication and exposes challenge headers", async () => {
  const preflight = await handler(
    new Request("https://cms.example/api/v1/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "MCP-Protocol-Version",
      },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /MCP-Protocol-Version/,
  );
  const response = await handler(
    new Request("https://cms.example/api/v1/mcp", {
      method: "POST",
      headers: { origin: "https://app.example" },
    }),
  );
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /resource_metadata/,
  );
  assert.match(
    response.headers.get("access-control-expose-headers") ?? "",
    /WWW-Authenticate/,
  );
  for (const origin of ["null", "https://attacker.invalid"]) {
    const rejected = await handler(
      new Request("https://attacker.invalid/api/v1/mcp", {
        method: "POST",
        headers: { origin },
      }),
    );
    assert.equal(rejected.status, 403);
  }
});

test("external OAuth errors never log consent, code, verifier or token values", async () => {
  const logs: unknown[] = [];
  const ingress = createServerRequestHandler({
    env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
    logger: createConsoleLogger({
      level: "error",
      sink: (value) => {
        logs.push(value);
      },
    }),
    configureApp(app) {
      (app as Elysia).post(
        "/api/v1/oauth/token",
        () => new Response(null, { status: 503 }),
      );
    },
  });
  await ingress(
    new Request(
      "https://cms.example/api/v1/oauth/token?consent=private-consent&code=private-code",
      {
        method: "POST",
        headers: {
          authorization: "Bearer private-access",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "refresh_token=private-refresh&code_verifier=private-verifier",
      },
    ),
  );
  assert.ok(logs.length > 0);
  assert.equal(JSON.stringify(logs).includes("private-"), false);
});

test("canonical auth origin survives TLS termination without trusting forwarded headers", async () => {
  const ingress = createServerRequestHandler({
    env: {
      NODE_ENV: "production",
      MDCMS_SERVER_URL: "https://cms.example",
      MDCMS_STUDIO_ALLOWED_ORIGINS: "",
    },
    logger: createConsoleLogger({ level: "error", sink: () => undefined }),
    configureApp(app) {
      (app as Elysia).post("/api/v1/auth/login", () =>
        Response.json({ ok: true }),
      );
    },
  });
  for (const [origin, expected] of [
    ["https://cms.example", 200],
    ["null", 403],
    ["https://attacker.invalid", 403],
  ] as const) {
    const response = await ingress(
      new Request("http://internal:4000/api/v1/auth/login", {
        method: "POST",
        headers: {
          origin,
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "https",
        },
      }),
    );
    assert.equal(response.status, expected);
  }
});
