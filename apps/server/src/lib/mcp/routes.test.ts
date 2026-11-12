import assert from "node:assert/strict";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServerRequestHandler } from "../server.js";
import { mountMcpRoutes } from "./routes.js";
import { createAgentToolRegistry } from "../agent-tools/registry.js";

test("real SDK client initializes and lists through independent stateless requests", async () => {
  let requests = 0;
  const handler = createServerRequestHandler({
    env: { NODE_ENV: "test", MDCMS_SERVER_URL: "https://cms.example" },
    configureApp(app) {
      mountMcpRoutes(app, {
        origin: "https://cms.example",
        version: "test",
        registry: createAgentToolRegistry(),
        authenticate: async () => ({
          authorization: {
            mode: "api_key",
            principal: {
              type: "api_key",
              keyId: "key",
              createdByUserId: "user",
              createdByUserEmail: "user@example.invalid",
              keyPrefix: "mdcms_key",
              label: "Test",
              scopes: ["media:read"],
              contextAllowlist: [{ project: "project", environment: "draft" }],
            },
          },
          target: { project: "project", environment: "draft" },
        }),
        dispatch: () => async () => new Response("{}"),
      });
    },
  });
  const client = new Client({ name: "test-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://cms.example/api/v1/mcp"),
    {
      fetch: async (input, init) => {
        requests++;
        return handler(new Request(input, init));
      },
    },
  );
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools, []);
    const denied = await client.callTool({ name: "get_schema", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /FORBIDDEN/);
    await assert.rejects(
      client.callTool({ name: "not_a_tool", arguments: {} }),
      (error: any) => error.code === -32602,
    );
    await assert.rejects(
      client.callTool({ name: "get_schema", arguments: { unexpected: true } }),
      (error: any) => error.code === -32602,
    );
    for (const method of ["GET", "DELETE"]) {
      const rejected = await handler(
        new Request("https://cms.example/api/v1/mcp", { method }),
      );
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get("allow"), "POST");
    }
    const malformed = await handler(
      new Request("https://cms.example/api/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: "{",
      }),
    );
    assert.equal((await malformed.json()).error.code, -32700);
    assert.ok(requests >= 2);
  } finally {
    await client.close();
  }
});

test("MCP preserves routing errors and sanitizes infrastructure failures", async () => {
  const { RuntimeError } = await import("@mdcms/shared");
  for (const failure of [
    new RuntimeError({
      code: "MISSING_TARGET_ROUTING",
      message: "Target required.",
      statusCode: 400,
    }),
    new Error("private database details"),
  ]) {
    const handler = createServerRequestHandler({
      env: { NODE_ENV: "test" },
      configureApp(app) {
        mountMcpRoutes(app, {
          origin: "http://localhost:4000",
          version: "test",
          registry: createAgentToolRegistry([]),
          authenticate: async () => {
            throw failure;
          },
          dispatch: () => async () => new Response(),
        });
      },
    });
    const response = await handler(
      new Request("http://localhost:4000/api/v1/mcp", { method: "POST" }),
    );
    assert.equal(response.status, failure instanceof RuntimeError ? 400 : 500);
    const body = await response.json();
    assert.equal(
      body.code,
      failure instanceof RuntimeError
        ? "MISSING_TARGET_ROUTING"
        : "INTERNAL_ERROR",
    );
    assert.equal(
      JSON.stringify(body).includes("private database details"),
      false,
    );
  }
});

test("shared credentials never retain initialize identity and call inputs parse once", async () => {
  const { z } = await import("zod");
  const { defineAgentTool } = await import("../agent-tools/types.js");
  let parses = 0;
  const registry = createAgentToolRegistry([
    defineAgentTool({
      name: "identity_probe",
      title: "Identity",
      description: "Test identity",
      requiredScopes: [],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: z
        .object({})
        .strict()
        .superRefine(() => {
          parses++;
        }),
      outputSchema: z.object({ declared: z.string().optional() }),
      execute: async (_input, context) =>
        (
          await context.dispatch({ method: "GET", path: "/api/v1/schema" })
        ).json(),
    }),
  ]);
  const handler = createServerRequestHandler({
    env: { NODE_ENV: "test" },
    configureApp(app) {
      mountMcpRoutes(app, {
        origin: "http://localhost:4000",
        version: "test-version",
        registry,
        authenticate: async () => ({
          authorization: {
            mode: "oauth",
            principal: {
              type: "oauth",
              clientId: "shared",
              userId: "user",
              email: "user@example.invalid",
              scopes: [],
              target: { project: "p", environment: "draft" },
            },
          },
          target: { project: "p", environment: "draft" },
        }),
        dispatch: (_request, _target, declared) => async () =>
          Response.json({ declared }),
      });
    },
  });
  const clients = [
    new Client({ name: "first-initialize", version: "1" }),
    new Client({ name: "second-initialize", version: "2" }),
  ];
  try {
    await Promise.all(
      clients.map((client) =>
        client.connect(
          new StreamableHTTPClientTransport(
            new URL("http://localhost:4000/api/v1/mcp"),
            { fetch: (input, init) => handler(new Request(input, init)) },
          ),
        ),
      ),
    );
    const [declared, absent] = await Promise.all([
      clients[0]!.callTool({
        name: "identity_probe",
        arguments: {},
        _meta: {
          "ai.mdcms/clientInfo": { name: " call-client ", version: " 3 " },
        },
      }),
      clients[1]!.callTool({ name: "identity_probe", arguments: {} }),
    ]);
    assert.deepEqual(declared.structuredContent, { declared: "call-client/3" });
    assert.deepEqual(absent.structuredContent, {});
    assert.equal(parses, 2);
    assert.equal(clients[0]!.getServerVersion()?.version, "test-version");
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});
