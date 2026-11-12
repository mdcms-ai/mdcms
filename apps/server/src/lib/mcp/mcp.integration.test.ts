import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { createDatabaseConnection } from "../db.js";
import { mcpIntegrationEndpoints } from "./test-endpoints.js";
import {
  apiKeys,
  authUsers,
  documents,
  documentVersions,
  environments,
  projects,
  rbacGrants,
  schemaRegistryEntries,
  schemaSyncs,
  oauthClients,
  oauthGrants,
} from "../db/schema.js";

const endpoints = mcpIntegrationEndpoints();
const databaseUrl = endpoints?.databaseUrl;
const serverUrl = endpoints?.serverUrl;
const integrationTest = (name: string, fn: () => Promise<void>) =>
  endpoints ? test(name, fn) : test.skip(name, fn);

integrationTest(
  "real HTTP MCP SDK content lifecycle, authorization, attribution and OAuth rotation/revocation",
  async () => {
    assert.ok(
      databaseUrl,
      "MDCMS_TEST_DATABASE_URL is required for mandatory MCP integration",
    );
    assert.ok(
      serverUrl,
      "MDCMS_TEST_SERVER_URL is required for mandatory MCP integration",
    );
    const origin = new URL(serverUrl).origin;
    const resource = `${origin}/api/v1/mcp`;
    const connection = createDatabaseConnection({
      env: { DATABASE_URL: databaseUrl },
    });
    const db = connection.db;
    const project = randomUUID();
    const environmentId = randomUUID();
    const key = `mdcms_key_${randomBytes(32).toString("hex")}`;
    const keyId = randomUUID();
    const scopes = [
      "schema:read",
      "content:read",
      "content:read:draft",
      "content:write",
      "content:publish",
    ];
    const email = `${randomUUID()}@example.invalid`;
    const password = `Fixture-${randomBytes(24).toString("hex")}`;
    let userId: string | undefined;
    let oauthClientId: string | undefined;
    const clients: Client[] = [];
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${origin}${path}`, {
        ...init,
        redirect: "manual",
        headers: { "user-agent": "research-client/1.0", ...init.headers },
      });
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const cookies = new Map<string, string>();
    const absorb = (response: Response) => {
      for (const item of response.headers.getSetCookie()) {
        const pair = item.split(";")[0]!;
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    };
    const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const sdk = async (token: string, routed = true) => {
      const client = new Client({
        name: "integration-fixture",
        version: "1.0",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: {
            headers: {
              authorization: `Bearer ${token}`,
              "user-agent": "research-client/1.0",
              ...(routed
                ? { "x-mdcms-project": project, "x-mdcms-environment": "draft" }
                : {}),
            },
          },
        }),
      );
      return client;
    };
    const call = async (
      client: Client,
      name: string,
      input: Record<string, unknown>,
    ) => {
      const result = await client.callTool({ name, arguments: input });
      assert.equal(result.isError, false, `${name} must succeed`);
      return result.structuredContent as any;
    };
    try {
      await connection.client`select 1`;
      assert.equal(
        (
          await request(
            "/api/v1/auth/sign-up/email",
            json({ email, password, name: "MCP integration fixture" }),
          )
        ).status,
        200,
      );
      const login = await request(
        "/api/v1/auth/login",
        json({ email, password }),
      );
      assert.equal(login.status, 200);
      userId = (await login.json()).data.session.userId;
      absorb(login);
      await db.insert(projects).values({
        id: project,
        slug: project,
        name: "MCP fixture",
        createdBy: userId!,
      });
      await db.insert(environments).values({
        id: environmentId,
        projectId: project,
        name: "draft",
        createdBy: userId!,
      });
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "editor",
        scopeKind: "folder_prefix",
        project,
        environment: "draft",
        pathPrefix: "allowed",
        createdByUserId: userId!,
      });
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "viewer",
        scopeKind: "project",
        project,
        createdByUserId: userId!,
      });
      const [editingGrant] = await db
        .insert(rbacGrants)
        .values({
          userId: userId!,
          role: "editor",
          scopeKind: "project",
          project,
          createdByUserId: userId!,
        })
        .returning();
      await db.insert(apiKeys).values({
        id: keyId,
        label: "MCP fixture",
        keyPrefix: key.slice(0, 16),
        keyHash: createHash("sha256").update(key).digest("hex"),
        scopes,
        contextAllowlist: [{ project, environment: "draft" }],
        createdByUserId: userId!,
      });
      const snapshot = {
        type: "Note",
        directory: "notes",
        localized: false,
        fields: { title: { kind: "string", required: true, nullable: false } },
      };
      await db.insert(schemaSyncs).values({
        projectId: project,
        environmentId,
        schemaHash: "fixture-hash",
        rawConfigSnapshot: {},
      });
      await db.insert(schemaRegistryEntries).values({
        projectId: project,
        environmentId,
        schemaType: "Note",
        directory: "notes",
        localized: false,
        schemaHash: "fixture-hash",
        resolvedSchema: snapshot,
      });
      const client = await sdk(key);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "create_document"));
      assert.ok(
        !listed.tools.some((tool) => tool.name === "list_environments"),
      );
      const schema = await call(client, "get_schema", {});
      assert.equal(schema.data.schemaHash, "fixture-hash");
      const created = await call(client, "create_document", {
        type: "Note",
        path: "allowed/one",
        frontmatter: { title: "One" },
        body: "initial",
        schemaHash: schema.data.schemaHash,
      });
      const documentId = created.data.documentId;
      await call(client, "update_document", {
        documentId,
        body: "updated",
        schemaHash: schema.data.schemaHash,
      });
      assert.equal(
        (await call(client, "get_document", { documentId })).data.body,
        "updated",
      );
      await call(client, "publish_document", { documentId });
      const before = await db
        .select()
        .from(documents)
        .where(eq(documents.documentId, documentId));
      assert.equal(before[0]!.updatedBy, userId!);
      assert.equal(
        (before[0]!.updatedOrigin as { channel?: string })?.channel,
        "mcp",
      );
      assert.equal(
        (before[0]!.updatedOrigin as { credential?: string })?.credential,
        "api_key",
      );
      const stale = await client.callTool({
        name: "update_document",
        arguments: { documentId, body: "stale", schemaHash: "wrong" },
      });
      assert.equal(stale.isError, true);
      await db.delete(rbacGrants).where(eq(rbacGrants.id, editingGrant!.id));
      const denied = await client.callTool({
        name: "create_document",
        arguments: {
          type: "Note",
          path: "denied/one",
          frontmatter: { title: "Denied" },
          body: "denied",
          schemaHash: schema.data.schemaHash,
        },
      });
      assert.equal(denied.isError, true);
      assert.equal(
        (
          await db
            .select()
            .from(documents)
            .where(eq(documents.projectId, project))
        ).length,
        1,
      );
      assert.deepEqual(
        await db
          .select()
          .from(documents)
          .where(eq(documents.documentId, documentId)),
        before,
      );
      const history = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, documentId));
      assert.equal(history.length, 1);
      assert.equal(history[0]!.publishedBy, userId!);
      assert.equal(
        (history[0]!.publishedOrigin as { channel?: string })?.channel,
        "mcp",
      );
      await db.insert(rbacGrants).values({
        userId: userId!,
        role: "editor",
        scopeKind: "project",
        project,
        createdByUserId: userId!,
      });
      const registration = await request(
        "/api/v1/oauth/register",
        json({
          client_name: "MCP fixture",
          redirect_uris: ["http://127.0.0.1:23456/callback"],
          token_endpoint_auth_method: "none",
        }),
      );
      assert.equal(registration.status, 201);
      oauthClientId = (await registration.json()).client_id;
      const verifier = randomBytes(32).toString("base64url");
      const parameters = new URLSearchParams({
        response_type: "code",
        client_id: oauthClientId!,
        redirect_uri: "http://127.0.0.1:23456/callback",
        scope: scopes.join(" "),
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        resource,
        state: randomUUID(),
      });
      const consentPage = await request(
        `/api/v1/oauth/authorize?${parameters}`,
        { headers: { cookie: cookie() } },
      );
      assert.equal(consentPage.status, 200);
      absorb(consentPage);
      const html = await consentPage.text();
      const hidden = (name: string) => {
        const value = html.match(
          new RegExp(`name="${name}" value="([^"]+)"`),
        )?.[1];
        assert.ok(value, `consent form needs ${name}`);
        return value;
      };
      const consent = await request("/api/v1/oauth/authorize", {
        method: "POST",
        headers: {
          cookie: cookie(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          consent: hidden("consent"),
          csrfToken: hidden("csrfToken"),
          scope: hidden("scope"),
          decision: "allow",
          project,
          environment: "draft",
        }),
      });
      assert.equal(consent.status, 303);
      const tokenForm = new URLSearchParams({
        client_id: oauthClientId!,
        grant_type: "authorization_code",
        code: new URL(consent.headers.get("location")!).searchParams.get(
          "code",
        )!,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:23456/callback",
        resource,
      });
      const formPost = (path: string, body: URLSearchParams) =>
        request(path, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      const exchange = await formPost("/api/v1/oauth/token", tokenForm);
      assert.equal(exchange.status, 200);
      let tokens = await exchange.json();
      assert.equal(
        (await formPost("/api/v1/oauth/token", tokenForm)).status,
        400,
      );
      const oauth = await sdk(tokens.access_token, false);
      assert.equal(
        (await call(oauth, "get_document", { documentId })).data.documentId,
        documentId,
      );
      const mismatch = await request("/api/v1/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "x-mdcms-environment": "other",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(mismatch.status, 400);
      const wrongResource = new URLSearchParams({
        client_id: oauthClientId!,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: `${origin}/wrong`,
      });
      assert.equal(
        (await formPost("/api/v1/oauth/token", wrongResource)).status,
        400,
      );
      const refresh = await formPost(
        "/api/v1/oauth/token",
        new URLSearchParams({
          client_id: oauthClientId!,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          resource,
        }),
      );
      assert.equal(refresh.status, 200);
      tokens = await refresh.json();
      await sdk(tokens.access_token, false);
      assert.equal(
        (
          await formPost(
            "/api/v1/oauth/revoke",
            new URLSearchParams({
              client_id: oauthClientId!,
              token: tokens.refresh_token,
              token_type_hint: "refresh_token",
            }),
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request("/api/v1/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${tokens.access_token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await formPost(
            "/api/v1/oauth/token",
            new URLSearchParams({
              client_id: oauthClientId!,
              grant_type: "refresh_token",
              refresh_token: tokens.refresh_token,
              resource,
            }),
          )
        ).status,
        400,
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await db
        .update(documents)
        .set({ publishedVersion: null })
        .where(eq(documents.projectId, project));
      await db
        .delete(documentVersions)
        .where(eq(documentVersions.projectId, project));
      await db.delete(documents).where(eq(documents.projectId, project));
      await db
        .delete(schemaRegistryEntries)
        .where(eq(schemaRegistryEntries.projectId, project));
      await db.delete(schemaSyncs).where(eq(schemaSyncs.projectId, project));
      await db.delete(environments).where(eq(environments.projectId, project));
      await db.delete(projects).where(eq(projects.id, project));
      await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
      if (userId) {
        await db.delete(oauthGrants).where(eq(oauthGrants.userId, userId));
        await db.delete(rbacGrants).where(eq(rbacGrants.userId, userId));
        await db.delete(authUsers).where(eq(authUsers.id, userId));
      }
      if (oauthClientId)
        await db.delete(oauthClients).where(eq(oauthClients.id, oauthClientId));
      await connection.close();
    }
  },
);
