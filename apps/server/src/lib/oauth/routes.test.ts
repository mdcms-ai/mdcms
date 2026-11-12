import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { oauthTestDatabase } from "./test-database.js";
import { createServerRequestHandler } from "../server.js";
import { createAuthService } from "../auth.js";
import { parseServerEnv } from "../env.js";
import { mountOAuthRoutes } from "./routes.js";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createServerRequestHandlerWithModules } from "../runtime-with-modules.js";
import {
  authUsers,
  environments,
  projects,
  rbacGrants,
  oauthClients,
  oauthGrants,
} from "../db/schema.js";

const { url: url, test: databaseTest } = oauthTestDatabase();

databaseTest(
  "mounted OAuth login, consent, exchange and connection revocation",
  async () => {
    const runtime = createServerRequestHandlerWithModules({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: url,
        MDCMS_SERVER_URL: "https://cms.example",
        MDCMS_OAUTH_REGISTER_RATE_LIMIT: "100",
      },
    });
    const db = runtime.dbConnection.db;
    const projectId = randomUUID();
    const email = `${projectId}@example.invalid`;
    let userId: string | undefined;
    let clientId: string | undefined;
    const otherUserId = randomUUID();
    const request = (path: string, init?: RequestInit) =>
      runtime.handler(new Request(`https://cms.example${path}`, init));
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      for (const endpoint of ["register", "token", "revoke", "authorize"]) {
        const oversized = await request(`/api/v1/oauth/${endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "content-length": "65537",
          },
          body: "x",
        });
        assert.equal(oversized.status, 413);
        assert.equal(oversized.headers.get("cache-control"), "no-store");
        assert.match(
          oversized.headers.get("content-type") ?? "",
          endpoint === "authorize" ? /text\/html/ : /application\/json/,
        );
      }
      assert.equal(
        (
          await request(
            "/api/v1/auth/sign-up/email",
            json({
              email,
              password: "TestPassword123!",
              name: "OAuth fixture",
            }),
          )
        ).status,
        200,
      );
      const login = await request(
        "/api/v1/auth/login",
        json({ email, password: "TestPassword123!" }),
      );
      assert.equal(login.status, 200);
      const session = (await login.json()).data;
      userId = session.session.userId;
      const cookies = new Map<string, string>();
      const absorb = (response: Response) => {
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(";")[0]!;
          const index = pair.indexOf("=");
          cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
      };
      absorb(login);
      const cookie = () =>
        [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      await db.insert(projects).values({
        id: projectId,
        name: "OAuth fixture",
        slug: projectId,
        createdBy: projectId,
      });
      await db
        .insert(environments)
        .values({ projectId, name: "draft", createdBy: projectId });
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "editor",
        scopeKind: "project",
        project: projectId,
        createdByUserId: userId!,
      });
      const registered = await request(
        "/api/v1/oauth/register",
        json({
          client_name: "<Unverified client>",
          redirect_uris: ["http://127.0.0.1:1234/callback"],
          token_endpoint_auth_method: "none",
        }),
      );
      assert.equal(registered.status, 201);
      clientId = (await registered.json()).client_id;
      const verifier = "a".repeat(43);
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId!,
        redirect_uri: "http://127.0.0.1:4567/callback",
        scope: (
          await (
            await request("/.well-known/oauth-protected-resource/api/v1/mcp")
          ).json()
        ).scopes_supported.join(" "),
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource: "https://cms.example/api/v1/mcp",
        state: "state",
      });
      const initial = await request(`/api/v1/oauth/authorize?${params}`);
      assert.equal(initial.status, 200);
      assert.match(
        initial.headers.get("content-security-policy")!,
        /form-action 'self';/,
      );
      const initialHtml = await initial.text();
      assert.match(
        initialHtml,
        /<form id="login" method="POST" action="\/api\/v1\/auth\/login">/,
      );
      const handle = initialHtml.match(/consent=([A-Za-z0-9_-]+)/)?.[1];
      assert.ok(handle);
      const page = await request(`/api/v1/oauth/authorize?consent=${handle}`, {
        headers: { cookie: cookie() },
      });
      assert.equal(page.status, 200);
      assert.match(
        page.headers.get("content-security-policy")!,
        /form-action 'self' http:\/\/127\.0\.0\.1:4567;/,
      );
      absorb(page);
      const content = await page.text();
      assert.match(content, /&lt;Unverified client&gt;/);
      const csrf = content.match(/name="csrfToken" value="([^"]+)"/)?.[1];
      assert.ok(csrf);
      const secondLogin = await request(
        "/api/v1/auth/login",
        json({ email, password: "TestPassword123!" }),
      );
      const secondCookies = secondLogin.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      assert.equal(
        (
          await request(`/api/v1/oauth/authorize?consent=${handle}`, {
            headers: { cookie: secondCookies },
          })
        ).status,
        403,
      );
      for (const suffix of [`&consent=${handle}`, "&scope=content:read"])
        assert.equal(
          (
            await request(
              `/api/v1/oauth/authorize?consent=${handle}${suffix}`,
              { headers: { cookie: cookie() } },
            )
          ).status,
          400,
        );
      const consentForm = new URLSearchParams({
        consent: handle,
        decision: "allow",
        project: projectId,
        environment: "draft",
        csrfToken: csrf,
        scope: content.match(/name="scope" value="([^"]+)"/)![1]!,
      });
      for (const invalidScope of [
        "schema:write",
        "schema:read schema:read",
        "migrations:run",
      ]) {
        const tampered = new URLSearchParams(consentForm);
        tampered.set("scope", invalidScope);
        const rejected = await request("/api/v1/oauth/authorize", {
          method: "POST",
          headers: {
            cookie: cookie(),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: tampered,
        });
        assert.equal(rejected.status, 400);
      }
      const invalidCsrf = new URLSearchParams(consentForm);
      invalidCsrf.set("csrfToken", "invalid");
      assert.equal(
        (
          await request("/api/v1/oauth/authorize", {
            method: "POST",
            headers: {
              cookie: cookie(),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: invalidCsrf,
          })
        ).status,
        403,
      );
      const deniedPage = await request(`/api/v1/oauth/authorize?${params}`, {
        headers: { cookie: cookie() },
      });
      const deniedHtml = await deniedPage.text();
      absorb(deniedPage);
      const deniedForm = new URLSearchParams({
        consent: deniedHtml.match(/name="consent" value="([^"]+)"/)![1]!,
        csrfToken: deniedHtml.match(/name="csrfToken" value="([^"]+)"/)![1]!,
        decision: "deny",
      });
      const denied = await request("/api/v1/oauth/authorize", {
        method: "POST",
        headers: {
          cookie: cookie(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: deniedForm,
      });
      assert.equal(denied.status, 303);
      assert.equal(
        new URL(denied.headers.get("location")!).searchParams.get("error"),
        "access_denied",
      );
      assert.equal(
        (
          await db
            .select()
            .from(oauthGrants)
            .where(eq(oauthGrants.userId, userId!))
        ).length,
        0,
      );
      const consent = await request("/api/v1/oauth/authorize", {
        method: "POST",
        headers: {
          cookie: cookie(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: consentForm,
      });
      assert.equal(consent.status, 303);
      const callback = new URL(consent.headers.get("location")!);
      assert.equal(callback.port, "4567");
      assert.equal(callback.searchParams.get("state"), "state");
      const tokenForm = new URLSearchParams({
        client_id: clientId!,
        grant_type: "authorization_code",
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:4567/callback",
        resource: "https://cms.example/api/v1/mcp",
      });
      for (const [field, value, expected] of [
        ["code_verifier", "b".repeat(43), "invalid_grant"],
        ["redirect_uri", "http://127.0.0.1:9999/callback", "invalid_grant"],
        ["resource", "https://other.example/api/v1/mcp", "invalid_target"],
      ]) {
        const invalid = new URLSearchParams(tokenForm);
        invalid.set(field!, value!);
        const rejected = await request("/api/v1/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: invalid,
        });
        assert.equal(rejected.status, 400);
        assert.deepEqual(await rejected.json(), { error: expected });
      }
      const exchange = await request("/api/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenForm,
      });
      assert.equal(exchange.status, 200);
      assert.equal(exchange.headers.get("cache-control"), "no-store");
      let tokens = await exchange.json();
      assert.ok(tokens.scope.split(" ").includes("content:write"));
      assert.equal(tokens.scope.split(" ").includes("schema:write"), false);
      assert.equal(
        tokens.scope.split(" ").includes("environments:read"),
        false,
      );
      const sdk = new Client({ name: "editor-client", version: "1" });
      try {
        await sdk.connect(
          new StreamableHTTPClientTransport(
            new URL("https://cms.example/api/v1/mcp"),
            {
              requestInit: {
                headers: { authorization: `Bearer ${tokens.access_token}` },
              },
              fetch: (input, init) => runtime.handler(new Request(input, init)),
            },
          ),
        );
        const names = (await sdk.listTools()).tools.map((tool) => tool.name);
        assert.ok(names.includes("get_schema"));
        assert.ok(names.includes("create_document"));
        assert.equal(
          (await sdk.callTool({ name: "get_schema", arguments: {} })).isError,
          false,
        );
      } finally {
        await sdk.close();
      }
      const failingAuth = createAuthService({
        db,
        env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
      });
      failingAuth.getOAuthUserGrants = async () => {
        throw new Error("private database outage details");
      };
      const failingHandler = createServerRequestHandler({
        env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
        configureApp(app) {
          mountOAuthRoutes(app, {
            db,
            auth: failingAuth,
            env: parseServerEnv({
              NODE_ENV: "test",
              MDCMS_SERVER_URL: "https://cms.example",
            }),
          });
        },
      });
      const refreshBody = new URLSearchParams({
        client_id: clientId!,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: "https://cms.example/api/v1/mcp",
      });
      const outage = await failingHandler(
        new Request("https://cms.example/api/v1/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: refreshBody,
        }),
      );
      assert.equal(outage.status, 503);
      assert.deepEqual(await outage.json(), {
        error: "temporarily_unavailable",
      });
      const refreshed = await request("/api/v1/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: refreshBody,
      });
      assert.equal(refreshed.status, 200);
      tokens = await refreshed.json();
      await db.insert(authUsers).values({
        id: otherUserId,
        email: `${otherUserId}@example.invalid`,
        name: "Other member",
      });
      const foreignGrant = randomUUID();
      await db.insert(oauthGrants).values({
        id: foreignGrant,
        clientId: clientId!,
        userId: otherUserId,
        project: projectId,
        environment: "draft",
        resource: "https://cms.example/api/v1/mcp",
        scopes: ["content:read"],
        createdAt: new Date(),
      });
      assert.equal(
        (
          await request("/api/v1/oauth/connections", {
            headers: { cookie: cookie() },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            `/api/v1/oauth/connections/${foreignGrant}?project=${projectId}`,
            {
              method: "DELETE",
              headers: { cookie: cookie(), "x-mdcms-csrf-token": csrf },
            },
          )
        ).status,
        404,
      );
      const connections = await request(
        `/api/v1/oauth/connections?project=${projectId}`,
        { headers: { cookie: cookie() } },
      );
      assert.equal(connections.status, 200);
      const data = (await connections.json()).data;
      assert.equal(data.length, 1);
      assert.equal(JSON.stringify(data).includes(tokens.access_token), false);
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "admin",
        scopeKind: "global",
        createdByUserId: userId!,
      });
      const adminView = await request(
        `/api/v1/oauth/connections?project=${projectId}`,
        { headers: { cookie: cookie() } },
      );
      assert.equal((await adminView.json()).data.length, 2);
      await db.delete(rbacGrants).where(eq(rbacGrants.userId, userId!));
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "editor",
        scopeKind: "project",
        project: projectId,
        createdByUserId: userId!,
      });
      assert.equal(
        (
          await request(
            `/api/v1/oauth/connections/${"-".repeat(36)}?project=${projectId}`,
            {
              method: "DELETE",
              headers: { cookie: cookie(), "x-mdcms-csrf-token": csrf },
            },
          )
        ).status,
        404,
      );
      const revokePath = `/api/v1/oauth/connections/${data[0].id}?project=${projectId}`;
      assert.equal(
        (
          await request(revokePath, {
            method: "DELETE",
            headers: { cookie: cookie() },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(revokePath, {
            method: "DELETE",
            headers: {
              cookie: cookie(),
              authorization: "Bearer mdcms_key_spoof",
            },
          })
        ).status,
        403,
      );
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await request(revokePath, {
              method: "DELETE",
              headers: { cookie: cookie(), "x-mdcms-csrf-token": csrf },
            })
          ).status,
          200,
        );
      const rejected = await request("/api/v1/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(rejected.status, 401);
      if (process.env.MDCMS_OAUTH_BROWSER_EXECUTABLE) {
        const { verifyConsentBrowser } = await import(
          "./browser-verification.js"
        );
        await verifyConsentBrowser({
          executablePath: process.env.MDCMS_OAUTH_BROWSER_EXECUTABLE,
          handler: runtime.handler,
          authorizeUrl: `https://cms.example/api/v1/oauth/authorize?${params}`,
          cookie: cookie(),
        });
      }
    } finally {
      if (clientId)
        await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
      await db
        .delete(environments)
        .where(eq(environments.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
      await db.delete(authUsers).where(eq(authUsers.id, otherUserId));
      if (userId) await db.delete(authUsers).where(eq(authUsers.id, userId));
      else await db.delete(authUsers).where(eq(authUsers.email, email));
      await runtime.shutdown();
    }
  },
);

databaseTest(
  "malformed machine requests consume global quota before parsing",
  async () => {
    const { createDatabaseConnection } = await import("../db.js");
    const { createOAuthRateLimiter } = await import("./rate-limit.js");
    const { oauthCounters } = await import("../db/schema.js");
    const { like } = await import("drizzle-orm");
    const connection = createDatabaseConnection({ env: { DATABASE_URL: url } });
    const namespace = randomUUID();
    const env = parseServerEnv({
      NODE_ENV: "test",
      MDCMS_OAUTH_REGISTER_RATE_LIMIT: "1",
    });
    const auth = createAuthService({
      db: connection.db,
      env: { NODE_ENV: "test" },
    });
    const limiter = createOAuthRateLimiter(
      connection.db,
      () => new Date(180000),
      namespace,
    );
    const handler = createServerRequestHandler({
      env: { NODE_ENV: "test" },
      configureApp(app) {
        mountOAuthRoutes(app, { db: connection.db, auth, env, limiter });
      },
    });
    try {
      const send = () =>
        handler(
          new Request("http://localhost:4000/api/v1/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
        );
      assert.equal((await send()).status, 400);
      const blocked = await send();
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("retry-after"), "60");
      assert.deepEqual(await blocked.json(), { error: "rate_limit_exceeded" });
    } finally {
      await connection.db
        .delete(oauthCounters)
        .where(like(oauthCounters.key, `${namespace}:%`));
      await connection.close();
    }
  },
);
