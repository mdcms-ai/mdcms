import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMdcmsCli } from "./framework.js";
import { createMcpCommand, createMdcmsMcpServer } from "./mcp.js";

const remoteTool = {
  name: "remote_write",
  inputSchema: { type: "object" as const },
  annotations: { destructiveHint: true },
};
test("bridges discovery, identity, target and results without retries", async () => {
  const requests: Array<{ method: string; params?: any }> = [];
  let fail = false;
  let collision = false;
  let protocolError = false;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-secret");
    assert.equal(headers.get("x-mdcms-project"), "project");
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (!("id" in body)) return new Response(null, { status: 202 });
    if (protocolError)
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32602,
            message: "Invalid remote input",
            data: { field: "schemaHash" },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (fail) throw new Error("lost response test-secret");
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                collision ? { ...remoteTool, name: "sync_schema" } : remoteTool,
              ],
              ...(body.params?.cursor ? {} : { nextCursor: "page-2" }),
            }
          : { content: [{ type: "text", text: "denied" }], isError: true };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const server = createMdcmsMcpServer({
    serverUrl: "http://localhost:1234",
    project: "project",
    environment: "staging",
    apiKey: "test-secret",
    cwd: ".",
    configPath: "mdcms.config.ts",
    fetcher,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const wireErrors: unknown[] = [];
  const send = a.send.bind(a);
  a.send = async (message, options) => {
    if ("error" in message) wireErrors.push(message.error);
    await send(message, options);
  };
  const client = new Client({ name: "downstream", version: "2" });
  await server.connect(a);
  await client.connect(b);
  try {
    const first = await client.listTools();
    assert.deepEqual(first.tools, [remoteTool]);
    assert.equal(first.nextCursor, "page-2");
    const last = await client.listTools({ cursor: first.nextCursor });
    assert.deepEqual(
      last.tools.map((t) => t.name),
      ["remote_write", "sync_schema"],
    );
    assert.deepEqual(
      await client.callTool({
        name: "remote_write",
        arguments: { schemaHash: "explicit" },
      }),
      { content: [{ type: "text", text: "denied" }], isError: true },
    );
    const call = requests.find((r) => r.method === "tools/call")!;
    assert.deepEqual(call.params._meta["ai.mdcms/clientInfo"], {
      name: "downstream",
      version: "2",
    });
    assert.deepEqual(call.params.arguments, { schemaHash: "explicit" });
    assert.deepEqual(requests[0]!.params.clientInfo, {
      name: "downstream",
      version: "2",
    });
    protocolError = true;
    await assert.rejects(client.callTool({ name: "remote_write" }), (error) => {
      assert.equal(
        (error as Error).message,
        "MCP error -32602: Invalid remote input",
      );
      assert.equal((error as { code: number }).code, -32602);
      assert.deepEqual((error as { data: unknown }).data, {
        field: "schemaHash",
      });
      return true;
    });
    assert.deepEqual(wireErrors.at(-1), {
      code: -32602,
      message: "Invalid remote input",
      data: { field: "schemaHash" },
    });
    protocolError = false;
    collision = true;
    await assert.rejects(client.listTools(), /collides/);
    collision = false;
    fail = true;
    await assert.rejects(
      client.listTools(),
      (e) => !String(e).includes("test-secret"),
    );
    const before = requests.filter((r) => r.method === "tools/call").length;
    await assert.rejects(
      client.callTool({ name: "remote_write", arguments: {} }),
    );
    assert.equal(
      requests.filter((r) => r.method === "tools/call").length,
      before + 1,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("relays cancellation to the upstream SDK transport", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => {
    resolveStarted = r;
  });
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((r) => {
    resolveCancelled = r;
  });
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const body = JSON.parse(String(init?.body));
    if (body.method === "notifications/cancelled") resolveCancelled();
    if (!("id" in body)) return new Response(null, { status: 202 });
    if (body.method === "tools/call" && body.params.name === "remote_read")
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "still usable" }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (body.method === "tools/call") {
      resolveStarted();
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const server = createMdcmsMcpServer({
    serverUrl: "http://localhost:1234",
    project: "project",
    environment: "staging",
    apiKey: "secret",
    cwd: ".",
    configPath: "mdcms.config.ts",
    fetcher,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "client", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const controller = new AbortController();
    const call = client.callTool({ name: "remote", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(call);
    await started;
    controller.abort();
    await rejected;
    await Promise.race([
      cancelled,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Cancellation not relayed")), 1000),
      ),
    ]);
    assert.deepEqual(await client.callTool({ name: "remote_read" }), {
      content: [{ type: "text", text: "still usable" }],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("mcp command exits 1 before starting when no API key resolves", async () => {
  let stderr = "";
  let stdout = "";

  const exitCode = await runMdcmsCli(["mcp"], {
    commands: [createMcpCommand()],
    env: {},
    loadConfig: async () => ({
      config: {
        serverUrl: "http://localhost:1234",
        project: "project",
        environment: "staging",
      },
      configPath: "/tmp/mdcms.config.ts",
    }),
    resolveStoredApiKey: async () => undefined,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /MISSING_CREDENTIALS/);
  assert.match(stderr, /MDCMS_API_KEY/);
});

for (const failedMethod of ["tools/list", "tools/call"]) {
  test(`mcp command exits 1 after post-start ${failedMethod} transport failure`, async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    let fail = false;
    let attempts = 0;
    let stderr = "";
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body));
      if (!("id" in body)) return new Response(null, { status: 202 });
      if (fail && body.method === failedMethod) {
        attempts++;
        throw new Error("fetch failed secret-credential");
      }
      const result =
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [remoteTool] };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const command = runMdcmsCli(["mcp"], {
      commands: [
        createMcpCommand({
          createTransport: () => {
            resolveReady();
            return a;
          },
        }),
      ],
      env: { MDCMS_API_KEY: "secret-credential" },
      loadConfig: async () => ({
        config: {
          serverUrl: "http://localhost:1234",
          project: "project",
          environment: "staging",
        },
        configPath: "mdcms.config.ts",
      }),
      resolveStoredApiKey: async () => undefined,
      fetcher,
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    });
    await ready;
    const client = new Client({ name: "command-test", version: "1" });
    try {
      await client.connect(b);
      await client.listTools();
      fail = true;
      await assert.rejects(
        failedMethod === "tools/list"
          ? client.listTools()
          : client.callTool({ name: "remote_write" }),
      );
      assert.equal(
        await Promise.race([
          command,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error("Fatal transport did not stop the command")),
              1000,
            ).unref(),
          ),
        ]),
        1,
      );
      assert.match(stderr, /MCP_CONNECTION_FAILED/);
      assert.ok(!stderr.includes("secret-credential"));
      assert.equal(attempts, 1);
    } finally {
      await client.close();
      await a.close();
      await command;
    }
  });
}
