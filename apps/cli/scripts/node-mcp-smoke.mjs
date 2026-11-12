// Run with Node against an installed tarball fixture: node node-mcp-smoke.mjs <fixture>.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const fixture = resolve(process.argv[2]);
const require = createRequire(join(fixture, "package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
);
const calls = [];
const schemas = [];
let holdInitialize = false;
let fatalMethod;
let fatalAttempts = 0;
let applicationError = false;
let cancellationStarted;
let cancellationObserved;
let handshakeStarted;
const pendingHandshake = new Promise((resolve) => {
  handshakeStarted = resolve;
});
const http = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-secret");
  assert.equal(req.headers["x-mdcms-project"], "original");
  assert.equal(req.headers["x-mdcms-environment"], "production");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.method === "GET") {
    res.writeHead(405).end();
    return;
  }
  const body = JSON.parse(raw);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/v1/schema") {
    schemas.push(body);
    res.end(
      JSON.stringify({
        data: {
          schemaHash: "synced",
          syncedAt: "2026-11-12T00:00:00Z",
          affectedTypes: ["Post"],
        },
      }),
    );
    return;
  }
  calls.push(body);
  if (fatalMethod && body.method === fatalMethod) {
    fatalAttempts++;
    res.destroy();
    return;
  }
  if (body.method === "notifications/cancelled") cancellationObserved?.();
  if (body.method === "tools/call" && body.params.arguments?.cancel) {
    cancellationStarted?.();
    res.writeHead(202).end();
    return;
  }
  if (applicationError && body.method === "tools/call") {
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32602,
          message: "Application rejected",
          data: { field: "input" },
        },
      }),
    );
    return;
  }

  if (holdInitialize && body.method === "initialize") {
    handshakeStarted();
    return;
  }
  if (!("id" in body)) {
    res.writeHead(202).end();
    return;
  }
  const result =
    body.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : body.method === "tools/list"
        ? { tools: [{ name: "remote", inputSchema: { type: "object" } }] }
        : {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { preserved: true },
            isError: false,
          };
  res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}`;
const dependency = (field) =>
  `import { z } from '@mdcms/cli';\nenum Field { Name = ${JSON.stringify(field)} }\nconsole.log('schema-dependency-loaded', process.env.MDCMS_API_KEY);\nconsole.error('Bearer unknown-diagnostic-secret');\nprocess.stdout.write(Buffer.from('direct stdout Bear'));\nprocess.stdout.write(new Uint8Array(Buffer.from('er fixture-secret\\n')));\nprocess.stderr.write('split: fixture-');\nprocess.stderr.write('secret\\n');\nconsole.error('mdcms_key_synthetic');\nexport const fields = { [Field.Name]: z.string() };\n`;
const config = (_title, target = url) =>
  `import { defineConfig, defineType } from '@mdcms/cli';\nimport { fields } from './schema';\nconsole.log('config-loaded');\nexport default defineConfig({ project: 'original', serverUrl: ${JSON.stringify(target)}, environment: 'production', contentDirectories: ['content'], types: [defineType('Post', { directory: 'content/posts', fields })], environments: { production: {} } });\n`;
await writeFile(join(fixture, "schema.ts"), dependency("title"));
await writeFile(join(fixture, "mdcms.config.ts"), config("title"));
await mkdir(join(fixture, "node-only"), { recursive: true });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(fixture, "node_modules/@mdcms/cli/dist/bin/mdcms.js"), "mcp"],
  cwd: fixture,
  env: {
    PATH: join(fixture, "node-only"),
    MDCMS_API_KEY: "fixture-secret",
    MDCMS_DOTENV: "0",
  },
  stderr: "pipe",
});
let stderr = "";
let stdout = "";
transport.stderr.on("data", (c) => (stderr += c));
// Observe the actual SDK-spawned process before initialization can write output.
const start = transport.start.bind(transport);
let exited;
transport.start = async () => {
  await start();
  const child = transport._process;
  child.stdout.on("data", (c) => (stdout += c));
  exited = new Promise((r) =>
    child.once("exit", (code, signal) => r({ code, signal })),
  );
};
const client = new Client({ name: "packed-smoke", version: "1" });
try {
  await client.connect(transport);
  assert.deepEqual(
    (await client.listTools()).tools.map((t) => t.name),
    ["remote", "sync_schema"],
  );
  assert.equal(
    (
      await client.callTool({
        name: "remote",
        arguments: { schemaHash: "explicit" },
      })
    ).structuredContent.preserved,
    true,
  );
  assert.equal(
    (await client.callTool({ name: "sync_schema", arguments: {} })).isError,
    false,
  );
  await writeFile(
    join(fixture, "mdcms.config.ts"),
    config("changedTitle", "https://must-not-contact.invalid"),
  );
  await writeFile(join(fixture, "schema.ts"), dependency("changedTitle"));
  assert.equal(
    (await client.callTool({ name: "sync_schema", arguments: {} })).isError,
    false,
  );
  assert.ok(schemas[0].resolvedSchema.Post.fields.title);
  assert.ok(schemas[1].resolvedSchema.Post.fields.changedTitle);
  await writeFile(
    join(fixture, "schema.ts"),
    dependency("dependencyOnlyChange"),
  );
  assert.equal(
    (await client.callTool({ name: "sync_schema", arguments: {} })).isError,
    false,
  );
  assert.ok(schemas[2].resolvedSchema.Post.fields.dependencyOnlyChange);
  assert.ok((stderr.match(/config-loaded/g) ?? []).length >= 4);
  assert.ok((stderr.match(/schema-dependency-loaded/g) ?? []).length >= 4);
  assert.deepEqual(
    calls.find((c) => c.method === "tools/call").params._meta[
      "ai.mdcms/clientInfo"
    ],
    { name: "packed-smoke", version: "1" },
  );
  transport._process.stdin.end();
  assert.deepEqual(
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("stdin close timeout")),
          5000,
        ).unref(),
      ),
    ]),
    { code: 0, signal: null },
  );
  for (const line of stdout.trim().split("\n"))
    assert.equal(JSON.parse(line).jsonrpc, "2.0");
  assert.ok(!stderr.includes("fixture-secret"));
  assert.ok(!stderr.includes("unknown-diagnostic-secret"));
  assert.ok(!stderr.includes("mdcms_key_synthetic"));
  assert.match(stderr, /direct stdout Bearer \[redacted\]/);
  assert.match(stderr, /split: \[redacted\]/);
  const state = JSON.parse(
    await readFile(
      join(fixture, ".mdcms/schema/original.production.json"),
      "utf8",
    ),
  );
  assert.equal(state.serverUrl, url);
  await writeFile(join(fixture, "mdcms.config.ts"), config("title"));
  const restorationRunner = join(fixture, "verify-routing-restoration.mjs");
  await writeFile(
    restorationRunner,
    `import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
const out = process.stdout.write; const err = process.stderr.write;
const methods = ['log', 'info', 'debug', 'warn', 'error'];
const originals = methods.map(name => console[name]);
process.once('exit', () => {
  assert.equal(process.stdout.write, out); assert.equal(process.stderr.write, err);
  methods.forEach((name, index) => assert.equal(console[name], originals[index]));
  writeSync(2, 'routing-restored\\n');
});
const bin = new URL('./node_modules/@mdcms/cli/dist/bin/mdcms.js', import.meta.url);
process.argv = [process.execPath, bin.pathname, 'mcp'];
await import(bin.href);
`,
  );

  for (const failedMethod of ["tools/list", "tools/call"]) {
    await writeFile(join(fixture, "mdcms.config.ts"), config("title"));
    const fatalTransport = new StdioClientTransport({
      command: process.execPath,
      args: [restorationRunner],
      cwd: fixture,
      env: {
        PATH: join(fixture, "node-only"),
        MDCMS_API_KEY: "fixture-secret",
        MDCMS_DOTENV: "0",
      },
      stderr: "pipe",
    });
    let fatalStderr = "";
    let fatalStdout = "";
    let fatalExit;
    fatalTransport.stderr.on("data", (chunk) => (fatalStderr += chunk));
    const startFatal = fatalTransport.start.bind(fatalTransport);
    fatalTransport.start = async () => {
      await startFatal();
      const child = fatalTransport._process;
      child.stdout.on("data", (chunk) => (fatalStdout += chunk));
      fatalExit = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
    };
    const fatalClient = new Client({ name: "fatal-lifecycle", version: "1" });
    try {
      await fatalClient.connect(fatalTransport);
      await fatalClient.listTools();
      applicationError = true;
      await assert.rejects(
        fatalClient.callTool({ name: "remote" }),
        /Application rejected/,
      );
      applicationError = false;
      await assert.rejects(
        fatalClient.callTool({
          name: "sync_schema",
          arguments: { invalid: true },
        }),
      );
      await writeFile(
        join(fixture, "mdcms.config.ts"),
        "throw new Error('fixture-secret');",
      );
      assert.equal(
        (await fatalClient.callTool({ name: "sync_schema" })).isError,
        true,
      );
      await fatalClient.listTools();
      const started = new Promise((resolve) => {
        cancellationStarted = resolve;
      });
      const cancelled = new Promise((resolve) => {
        cancellationObserved = resolve;
      });
      const abort = new AbortController();
      const cancellation = fatalClient.callTool(
        { name: "remote", arguments: { cancel: true } },
        undefined,
        { signal: abort.signal },
      );
      const cancellationRejected = assert.rejects(cancellation);
      await started;
      abort.abort();
      await cancellationRejected;
      await cancelled;
      await fatalClient.callTool({ name: "remote" });
      fatalAttempts = 0;
      fatalMethod = failedMethod;
      await assert.rejects(
        failedMethod === "tools/list"
          ? fatalClient.listTools()
          : fatalClient.callTool({ name: "remote" }),
      );
      assert.deepEqual(
        await Promise.race([
          fatalExit,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("fatal shutdown timeout")),
              5000,
            ).unref(),
          ),
        ]),
        { code: 1, signal: null },
      );
      assert.equal(fatalAttempts, 1);
      assert.match(fatalStderr, /MCP_CONNECTION_FAILED/);
      assert.match(fatalStderr, /routing-restored/);
      assert.ok(!fatalStderr.includes("fixture-secret"));
      for (const line of fatalStdout.trim().split("\n"))
        assert.equal(JSON.parse(line).jsonrpc, "2.0");
    } finally {
      fatalMethod = undefined;
      applicationError = false;
      await fatalClient.close();
    }
  }
  await writeFile(join(fixture, "mdcms.config.ts"), config("title"));
  holdInitialize = true;
  const pendingTransport = new StdioClientTransport({
    command: process.execPath,
    args: [restorationRunner],
    cwd: fixture,
    env: {
      PATH: join(fixture, "node-only"),
      MDCMS_API_KEY: "fixture-secret",
      MDCMS_DOTENV: "0",
    },
    stderr: "pipe",
  });
  let pendingStderr = "";
  pendingTransport.stderr.on("data", (chunk) => (pendingStderr += chunk));
  const pendingClient = new Client({ name: "pending-handshake", version: "1" });
  try {
    await pendingClient.connect(pendingTransport);
    const child = pendingTransport._process;
    const pendingExit = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await pendingHandshake;
    child.stdin.end();
    assert.deepEqual(
      await Promise.race([
        pendingExit,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("pending handshake shutdown timeout")),
            5000,
          ).unref(),
        ),
      ]),
      { code: 0, signal: null },
    );
    assert.ok(!pendingStderr.includes("MCP_CONNECTION_FAILED"), pendingStderr);
    assert.match(pendingStderr, /routing-restored/);
  } finally {
    await pendingClient.close();
  }

  await writeFile(
    join(fixture, "mdcms.config.ts"),
    `console.error('fixture-secret Bearer unknown-startup-secret'); process.stdout.write(Buffer.from('Bearer chunked-')); process.stdout.write('startup-secret\\n'); process.stderr.write('mdcms_key_startup\\n'); throw new Error('fixture-secret arbitrary-private-failure-text');`,
  );
  const failed = spawn(process.execPath, [restorationRunner], {
    cwd: fixture,
    env: {
      PATH: join(fixture, "node-only"),
      MDCMS_API_KEY: "fixture-secret",
      MDCMS_DOTENV: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let failedOut = "";
  let failedErr = "";
  failed.stdout.on("data", (chunk) => (failedOut += chunk));
  failed.stderr.on("data", (chunk) => (failedErr += chunk));
  assert.equal(
    await new Promise((resolve) => failed.once("close", resolve)),
    1,
  );
  assert.equal(failedOut, "");
  for (const secret of [
    "fixture-secret",
    "unknown-startup-secret",
    "chunked-startup-secret",
    "mdcms_key_startup",
    "arbitrary-private-failure-text",
  ])
    assert.ok(!failedErr.includes(secret), failedErr);
  assert.match(failedErr, /CONFIG_LOAD_FAILED/);
  assert.match(failedErr, /routing-restored/);
  console.log(
    `Packed MCP smoke passed on ${process.version}: initialize, list, remote call, TypeScript config reload, schema sync, stdin close, JSON-RPC stdout.`,
  );
} finally {
  await client.close();
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
}
