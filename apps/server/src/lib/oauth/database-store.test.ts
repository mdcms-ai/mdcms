import { oauthTestDatabase } from "./test-database.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServerRequestHandlerWithModules } from "../runtime-with-modules.js";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuthService } from "../auth.js";
import { createDatabaseConnection } from "../db.js";
import {
  authUsers,
  projects,
  oauthClients,
  oauthGrants,
  oauthCodes,
  oauthTokens,
  rbacGrants,
} from "../db/schema.js";
import { createOAuthStore, hashCredential } from "./database-store.js";

const { url: databaseUrl, test: databaseTest } = oauthTestDatabase();

databaseTest(
  "atomic redemption and committed refresh replay revocation",
  async () => {
    const connection = createDatabaseConnection({
      env: { DATABASE_URL: databaseUrl },
    });
    const db = connection.db;
    const id = randomUUID();
    // The mounted runtime authenticates these tokens using the system clock.
    let clock = new Date();
    const store = createOAuthStore(db, () => clock);
    let clientId: string | undefined;
    try {
      await db
        .insert(authUsers)
        .values({ id, name: "OAuth test", email: `${id}@example.invalid` });
      await db.insert(projects).values({ name: id, slug: id, createdBy: id });
      const client = await store.register("Test client", [
        "https://client.example/callback",
      ]);
      clientId = client.id;
      const consent = await store.createConsent(
        client.id,
        {
          redirectUri: "https://client.example/callback",
          resource: "https://cms.example/api/v1/mcp",
          scopes: ["content:read", "schema:read"],
          challenge: "a".repeat(43),
          state: "state",
        },
        { userId: id, sessionId: "session" },
      );
      assert.ok(await store.readConsent(consent));
      await assert.rejects(
        store.consumeConsent(consent, { userId: id, sessionId: "other" }),
      );
      await store.consumeConsent(consent, { userId: id, sessionId: "session" });
      await assert.rejects(
        store.consumeConsent(consent, { userId: id, sessionId: "session" }),
      );
      const expiredConsent = await store.createConsent(
        client.id,
        {
          redirectUri: "https://client.example/callback",
          resource: "https://cms.example/api/v1/mcp",
          scopes: ["content:read", "schema:read"],
          challenge: "a".repeat(43),
          state: "state",
        },
        { userId: id, sessionId: "session" },
      );
      await store.readConsent(expiredConsent);
      clock = new Date(clock.getTime() + 600000);
      await store.cleanup();
      await assert.rejects(
        store.consumeConsent(expiredConsent, {
          userId: id,
          sessionId: "session",
        }),
        (error: any) => error.status === 410,
      );
      for (const handle of [consent, expiredConsent]) {
        for (const operation of [
          () => store.readConsent(handle),
          () => store.bindConsent(handle, { userId: id, sessionId: "session" }),
          () =>
            store.consumeConsent(handle, { userId: id, sessionId: "session" }),
        ])
          await assert.rejects(
            operation(),
            (error: any) => error.status === 410,
          );
      }
      await db.insert(oauthGrants).values({
        id,
        clientId: client.id,
        userId: id,
        project: id,
        environment: "draft",
        resource: "https://cms.example/api/v1/mcp",
        scopes: ["content:read", "schema:read"],
        createdAt: clock,
      });
      const verifier = "a".repeat(43);
      const code = "test-code-" + id;
      await db.insert(oauthCodes).values({
        hash: hashCredential(code),
        grantId: id,
        redirectUri: "https://client.example/callback",
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        expiresAt: new Date(clock.getTime() + 300000),
      });
      const request = {
        clientId: client.id,
        code,
        verifier,
        redirectUri: "https://client.example/callback",
        resource: "https://cms.example/api/v1/mcp",
      };
      await assert.rejects(
        store.exchangeCode(
          { ...request, verifier: "b".repeat(43) },
          async () => true,
        ),
      );
      const results = await Promise.allSettled([
        store.exchangeCode(request, async () => true),
        store.exchangeCode(request, async () => true),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const result = results.find((r) => r.status === "fulfilled")!;
      assert.equal(result.status, "fulfilled");
      if (result.status !== "fulfilled") throw new Error("No redemption");
      const tokens = result.value;
      assert.ok(
        await store.authenticate(tokens.access_token, request.resource),
      );
      assert.equal(
        await store.authenticate(
          tokens.access_token,
          "https://other.example/api/v1/mcp",
        ),
        undefined,
      );
      await db.insert(rbacGrants).values({
        userId: id,
        role: "viewer",
        scopeKind: "global",
        createdByUserId: id,
      });
      const auth = createAuthService({
        db,
        env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
        oauthStore: store,
      });
      const ingress = new Request(request.resource, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      const authenticated = await auth.authenticateMcp(ingress);
      assert.equal(authenticated.authorization.principal.type, "oauth");
      await db.delete(rbacGrants).where(eq(rbacGrants.userId, id));
      await db.insert(rbacGrants).values({
        userId: id,
        role: "viewer",
        scopeKind: "folder_prefix",
        project: id,
        environment: "draft",
        pathPrefix: "allowed",
        createdByUserId: id,
      });
      await auth.authorizeRequest(ingress, {
        requiredScope: "content:read",
        project: id,
        environment: "draft",
        documentPath: "allowed/file",
      });
      await assert.rejects(
        auth.authorizeRequest(ingress, {
          requiredScope: "content:read",
          project: id,
          environment: "draft",
          documentPath: "private/file",
        }),
      );
      await db.delete(rbacGrants).where(eq(rbacGrants.userId, id));
      await db.insert(rbacGrants).values({
        userId: id,
        role: "viewer",
        scopeKind: "global",
        createdByUserId: id,
      });
      const runtime = createServerRequestHandlerWithModules({
        env: {
          NODE_ENV: "test",
          MDCMS_SERVER_URL: "https://cms.example",
          DATABASE_URL: databaseUrl,
        },
      });
      const metadataResponse = await runtime.handler(
        new Request(
          "https://cms.example/.well-known/oauth-authorization-server",
        ),
      );
      assert.equal(metadataResponse.status, 200);
      assert.equal(
        (await metadataResponse.json()).issuer,
        "https://cms.example",
      );
      const authorizationUrl = new URL(
        "https://cms.example/api/v1/oauth/authorize",
      );
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: request.redirectUri,
        scope: "content:read",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource: request.resource,
        state: "state",
      }).toString();
      const signInPage = await runtime.handler(new Request(authorizationUrl));
      assert.equal(signInPage.status, 200);
      assert.match(
        signInPage.headers.get("content-security-policy") ?? "",
        /nonce-/,
      );
      assert.match(await signInPage.text(), /Sign in/);
      const sdk = new Client({ name: "integration-client", version: "1" });
      try {
        await sdk.connect(
          new StreamableHTTPClientTransport(new URL(request.resource), {
            requestInit: {
              headers: { authorization: `Bearer ${tokens.access_token}` },
            },
            fetch: (input, init) => runtime.handler(new Request(input, init)),
          }),
        );
        const listed = await sdk.listTools();
        assert.ok(listed.tools.some((tool) => tool.name === "get_schema"));
      } finally {
        await sdk.close();
        await runtime.shutdown();
      }

      assert.deepEqual(authenticated.target, {
        project: id,
        environment: "draft",
      });
      await assert.rejects(
        auth.authorizeRequest(
          new Request("https://cms.example/api/v1/content", {
            headers: {
              authorization: `Bearer ${tokens.access_token}`,
              "x-mdcms-internal": "spoof",
              "x-mdcms-internal-channel": "mcp",
            },
          }),
          { requiredScope: "content:read", project: id, environment: "draft" },
        ),
      );
      clock = new Date(clock.getTime() + 30 * 86400000 - 1500);
      await store.cleanup();
      const rotated = await store.refresh(
        {
          clientId: client.id,
          token: tokens.refresh_token,
          resource: request.resource,
        },
        async () => true,
      );
      assert.equal(rotated.expires_in, 1);
      const nearExpiry = clock.getTime();
      assert.ok(
        await store.authenticate(rotated.access_token, request.resource),
      );
      await store.cleanup();
      clock = new Date(nearExpiry + 1000);
      assert.equal(
        await store.authenticate(rotated.access_token, request.resource),
        undefined,
      );
      await assert.rejects(
        store.refresh(
          {
            clientId: client.id,
            token: rotated.refresh_token,
            resource: request.resource,
          },
          async () => true,
        ),
      );
      await assert.rejects(
        store.refresh(
          {
            clientId: client.id,
            token: tokens.refresh_token,
            resource: request.resource,
          },
          async () => true,
        ),
      );
      assert.equal(
        await store.authenticate(rotated.access_token, request.resource),
        undefined,
      );
      const secondCode = "second-" + code;
      await db.insert(oauthCodes).values({
        hash: hashCredential(secondCode),
        grantId: id,
        redirectUri: request.redirectUri,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        expiresAt: new Date(clock.getTime() + 300000),
      });
      const second = await store.exchangeCode(
        { ...request, code: secondCode },
        async () => true,
      );
      assert.ok(
        await store.authenticate(second.access_token, request.resource),
      );
      const raceCode = "race-" + code;
      await db.insert(oauthCodes).values({
        hash: hashCredential(raceCode),
        grantId: id,
        redirectUri: request.redirectUri,
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        expiresAt: new Date(clock.getTime() + 300000),
      });
      const raceTokens = await store.exchangeCode(
        { ...request, code: raceCode },
        async () => true,
      );
      const races = await Promise.allSettled([
        store.refresh(
          {
            clientId: client.id,
            token: raceTokens.refresh_token,
            resource: request.resource,
          },
          async () => true,
        ),
        store.refresh(
          {
            clientId: client.id,
            token: raceTokens.refresh_token,
            resource: request.resource,
          },
          async () => true,
        ),
      ]);
      assert.equal(
        races.filter((result) => result.status === "fulfilled").length,
        1,
      );
      for (const result of races)
        if (result.status === "fulfilled")
          assert.equal(
            await store.authenticate(
              result.value.access_token,
              request.resource,
            ),
            undefined,
          );
      assert.ok(
        await store.authenticate(second.access_token, request.resource),
      );
      await store.revokeToken("unrelated-client", second.refresh_token);
      assert.ok(
        await store.authenticate(second.access_token, request.resource),
      );
      await store.revokeToken(client.id, second.refresh_token);
      assert.equal(
        await store.authenticate(second.access_token, request.resource),
        undefined,
      );
      await assert.rejects(
        store.refresh(
          {
            clientId: client.id,
            token: second.refresh_token,
            resource: request.resource,
          },
          async () => true,
        ),
      );
      await store.cleanup();
      await store.revokeGrant(id);
      const rows = await db.select().from(oauthTokens);
      assert.equal(JSON.stringify(rows).includes(tokens.access_token), false);
      assert.equal(JSON.stringify(rows).includes(tokens.refresh_token), false);
      await db.delete(oauthClients).where(eq(oauthClients.id, client.id));
    } finally {
      if (clientId)
        await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
      await db.delete(projects).where(eq(projects.slug, id));
      await db.delete(authUsers).where(eq(authUsers.id, id));
      await connection.close();
    }
  },
);

databaseTest(
  "bounded registration admission serializes at capacity",
  async () => {
    const connection = createDatabaseConnection({
      env: { DATABASE_URL: databaseUrl },
    });
    const prefix = randomUUID();
    const ids = Array.from({ length: 9999 }, (_, i) => `${prefix}-${i}`);
    const created: string[] = [];
    try {
      assert.equal(
        (await connection.db.select().from(oauthClients)).length,
        0,
        "capacity fixture requires empty isolated OAuth client registry",
      );
      for (let offset = 0; offset < ids.length; offset += 500)
        await connection.db.insert(oauthClients).values(
          ids.slice(offset, offset + 500).map((id) => ({
            id,
            name: "Capacity fixture",
            redirectUris: ["https://client.example/cb"],
            createdAt: new Date(),
          })),
        );
      const store = createOAuthStore(connection.db);
      const results = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          store.register("Capacity race", ["https://client.example/cb"]),
        ),
      );
      for (const result of results)
        if (result.status === "fulfilled") created.push(result.value.id);
      assert.equal(created.length, 1);
      for (const result of results)
        if (result.status === "rejected")
          assert.equal(result.reason.status, 503);
    } finally {
      for (const id of created)
        await connection.db.delete(oauthClients).where(eq(oauthClients.id, id));
      await connection.client`delete from oauth_clients where id like ${prefix + "-%"}`;
      await connection.close();
    }
  },
);

databaseTest(
  "grant revalidation uses the token transaction with a one-connection pool",
  async () => {
    const client = postgres(databaseUrl!, {
      max: 1,
      onnotice: () => undefined,
    });
    const db = drizzle(client, { schema, casing: "snake_case" });
    const id = randomUUID();
    const store = createOAuthStore(db);
    const auth = createAuthService({
      db,
      env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
      oauthStore: store,
      isTrustedMcpRequest: (request) => request === trustedEnvironmentRequest,
    });
    let trustedEnvironmentRequest: Request;
    let clientId: string | undefined;
    try {
      await db
        .insert(authUsers)
        .values({ id, name: "Pool fixture", email: `${id}@example.invalid` });
      await db.insert(projects).values({ name: id, slug: id, createdBy: id });
      await db.insert(rbacGrants).values({
        userId: id,
        role: "owner",
        scopeKind: "global",
        createdByUserId: id,
      });
      clientId = (
        await store.register("Pool fixture", ["https://client.example/cb"])
      ).id;
      await db.insert(oauthGrants).values({
        id,
        clientId,
        userId: id,
        project: id,
        environment: "draft",
        resource: "https://cms.example/api/v1/mcp",
        scopes: ["content:read", "environments:read"],
        createdAt: new Date(),
      });
      const verifier = "v".repeat(43);
      await db.insert(oauthCodes).values({
        hash: hashCredential(id),
        grantId: id,
        redirectUri: "https://client.example/cb",
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        expiresAt: new Date(Date.now() + 300000),
      });
      const check = async (
        _grant: unknown,
        _scopes: string[],
        tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      ) => {
        assert.ok(tx, "Grant checks must share the token transaction");
        return (await auth.getOAuthUserGrants(id, tx)).length === 1;
      };
      const issued = await store.exchangeCode(
        {
          clientId,
          code: id,
          verifier,
          redirectUri: "https://client.example/cb",
          resource: "https://cms.example/api/v1/mcp",
        },
        check,
      );
      const rotated = await store.refresh(
        {
          clientId,
          token: issued.refresh_token,
          resource: "https://cms.example/api/v1/mcp",
        },
        check,
      );
      assert.ok(
        await store.authenticate(
          rotated.access_token,
          "https://cms.example/api/v1/mcp",
        ),
      );
      trustedEnvironmentRequest = new Request(
        `http://mdcms.internal/api/v1/environments?project=${id}`,
        {
          headers: { authorization: `Bearer ${rotated.access_token}` },
        },
      );
      await auth.authorizeEnvironmentList(trustedEnvironmentRequest, id);
      await assert.rejects(
        auth.authorizeEnvironmentList(
          trustedEnvironmentRequest,
          "another-project",
        ),
        (error: any) => error.code === "TARGET_ROUTING_MISMATCH",
      );
      assert.deepEqual(
        (
          await auth.authenticateMcp(
            new Request("https://cms.example/api/v1/mcp", {
              headers: { authorization: `Bearer ${rotated.access_token}` },
            }),
          )
        ).target,
        { project: id, environment: "draft" },
      );
      await db
        .update(rbacGrants)
        .set({ role: "viewer" })
        .where(eq(rbacGrants.userId, id));
      await assert.rejects(
        auth.authorizeEnvironmentList(trustedEnvironmentRequest, id),
        (error: any) => error.code === "FORBIDDEN",
      );
    } finally {
      if (clientId)
        await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
      await db.delete(projects).where(eq(projects.slug, id));
      await db.delete(authUsers).where(eq(authUsers.id, id));
      await client.end({ timeout: 1 });
    }
  },
);
