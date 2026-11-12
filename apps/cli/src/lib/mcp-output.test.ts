import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";
import { installMcpOutputRouting } from "./mcp-output.js";

test("MCP diagnostics sanitize split buffers, preserve callbacks, and isolate protocol writes", async () => {
  let protocol = "";
  let diagnostics = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      protocol += chunk;
      setImmediate(callback);
    },
  });
  const stderr = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      diagnostics += chunk;
      setImmediate(callback);
    },
  });
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const originalConsole = console.error;
  const routing = installMcpOutputRouting({
    stdout,
    stderr,
    secrets: ["explicit-secret", "explicit-secret-long", "Bearer"],
  });
  let callbacks = 0;
  try {
    stdout.write(Buffer.from("hello Bear"), () => callbacks++);
    stdout.write(
      new Uint8Array(Buffer.from("er unknown-token\nexplicit-")),
      () => callbacks++,
    );
    stderr.write("secret mdcms_", "utf8", () => callbacks++);
    stderr.write("key_unknown\n", () => callbacks++);
    routing.addSecret("profile-secret");
    console.error("profile-secret explicit-secret-long Bearer unknown-overlap");
    stdout.write(Buffer.from("unicode: café\n"), () => callbacks++);
    const payload =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          text: "explicit-secret Bearer untouched",
          padding: "p".repeat(100_000),
        },
      }) + "\n";
    const protocolDrained = once(routing.protocolOutput, "drain");
    await new Promise<void>((resolve, reject) => {
      assert.equal(
        routing.protocolOutput.write(payload, (error) =>
          error ? reject(error) : resolve(),
        ),
        false,
      );
    });
    await protocolDrained;
    assert.equal(protocol, payload);
  } finally {
    await routing.restore();
  }
  assert.equal(callbacks, 5);
  assert.match(diagnostics, /hello \[redacted\] \[redacted\]/);
  assert.match(diagnostics, /unicode: café/);
  for (const secret of [
    "explicit-secret",
    "unknown-token",
    "mdcms_key_unknown",
    "profile-secret",
    "explicit-secret-long",
    "unknown-overlap",
  ])
    assert.ok(!diagnostics.includes(secret), diagnostics);
  assert.equal(stdout.write, originalOut);
  assert.equal(stderr.write, originalErr);
  assert.equal(console.error, originalConsole);
});

test("MCP diagnostic backpressure and oversized unterminated records stay bounded", async () => {
  let release: (() => void) | undefined;
  let diagnostics = "";
  const stdout = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, cb) {
      diagnostics += chunk;
      release = cb;
    },
  });
  const routing = installMcpOutputRouting({ stdout, stderr, secrets: [] });
  try {
    const drained = once(stdout, "drain");
    assert.equal(stdout.write("x".repeat(100_000) + "\n"), false);
    release!();
    await drained;
    assert.ok(diagnostics.length < 1000);
  } finally {
    await routing.restore();
  }
});
