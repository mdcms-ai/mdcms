import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuthService } from "../auth.js";
import { createDatabaseConnection } from "../db.js";
import { apiKeys, authUsers, rbacGrants } from "../db/schema.js";
import {
  createInternalDispatcher,
  trustedInternalChannel,
} from "../agent-tools/dispatcher.js";
import { hashCredential } from "./database-store.js";
import { oauthTestDatabase } from "./test-database.js";

const { url, test } = oauthTestDatabase();
test("trusted agent API-key dispatch intersects current owner grants without changing REST semantics", async () => {
  const connection = createDatabaseConnection({ env: { DATABASE_URL: url } });
  const db = connection.db;
  const id = randomUUID();
  const token = `mdcms_key_${randomUUID()}`;
  const secret = randomUUID();
  const auth = createAuthService({
    db,
    env: { NODE_ENV: "test" },
    isTrustedAgentRequest: (request) =>
      trustedInternalChannel(request, secret) !== undefined,
    isTrustedMcpRequest: (request) =>
      trustedInternalChannel(request, secret) === "mcp",
  });
  const request = new Request("http://cms.example/api/v1/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-mdcms-project": id,
      "x-mdcms-environment": "draft",
      "x-mdcms-internal": "forged",
      "x-mdcms-internal-channel": "studio_ai",
    },
  });
  const dispatchFor = (channel: "mcp" | "studio_ai") =>
    createInternalDispatcher(
      async (request) => {
        await auth.authorizeRequest(request, {
          requiredScope:
            request.method === "GET" ? "content:read" : "content:write",
          project: id,
          environment: "draft",
          documentPath: new URL(request.url).searchParams.get("path")!,
        });
        return new Response(null, { status: 204 });
      },
      secret,
      { request, project: id, environment: "draft", channel },
    );
  const dispatch = dispatchFor("mcp");
  try {
    await db
      .insert(authUsers)
      .values({ id, email: `${id}@example.invalid`, name: "Key owner" });
    await db.insert(apiKeys).values({
      label: "MCP fixture",
      keyPrefix: "mdcms_key_",
      keyHash: hashCredential(token),
      scopes: ["content:read", "content:write"],
      contextAllowlist: [{ project: id, environment: "draft" }],
      createdByUserId: id,
    });
    await db.insert(rbacGrants).values({
      userId: id,
      role: "editor",
      scopeKind: "project",
      project: id,
      createdByUserId: id,
    });
    await dispatch({
      method: "POST",
      path: "/api/v1/content",
      query: { path: "private/file" },
    });
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
    await dispatch({
      method: "GET",
      path: "/api/v1/content",
      query: { path: "allowed/file" },
    });
    for (const [method, path] of [
      ["GET", "private/file"],
      ["POST", "allowed/file"],
      ["POST", "private/file"],
    ] as const)
      await assert.rejects(
        dispatch({ method, path: "/api/v1/content", query: { path } }),
        (error: any) => error.code === "FORBIDDEN",
      );
    await assert.rejects(
      dispatchFor("studio_ai")({
        method: "POST",
        path: "/api/v1/content",
        query: { path: "allowed/file" },
      }),
      (error: any) => error.code === "FORBIDDEN",
    );
    await auth.authorizeRequest(
      new Request("http://cms.example/api/v1/content", {
        headers: request.headers,
      }),
      {
        requiredScope: "content:write",
        project: id,
        environment: "draft",
        documentPath: "private/file",
      },
    );
    for (const scope of ["media:read", "content:publish"]) {
      await db
        .update(apiKeys)
        .set({ scopes: [scope] })
        .where(eq(apiKeys.createdByUserId, id));
      assert.equal(
        (await auth.authenticateMcp(request)).authorization.mode,
        "api_key",
      );
    }
  } finally {
    await db.delete(apiKeys).where(eq(apiKeys.createdByUserId, id));
    await db.delete(authUsers).where(eq(authUsers.id, id));
    await connection.close();
  }
});
