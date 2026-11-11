import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { z } from "zod";

import { defineConfig, defineType, parseMdcmsConfig } from "@mdcms/shared";

import { runMdcmsCli } from "./framework.js";
import { createSchemaSyncCommand, performSchemaSync } from "./schema-sync.js";
import { resolveSchemaStatePath } from "./schema-state.js";

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-schema-sync-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const STUB_CONFIG = parseMdcmsConfig(
  defineConfig({
    serverUrl: "http://localhost:4000",
    project: "test-project",
    environment: "staging",
    contentDirectories: ["content"],
    types: [
      defineType("Post", {
        directory: "content/posts",
        localized: false,
        fields: {
          title: z.string(),
        },
      }),
    ],
    environments: {
      staging: {},
    },
  }),
);

function createSyncSuccessResponse(body: { schemaHash: string }): Response {
  return new Response(
    JSON.stringify({
      data: {
        schemaHash: body.schemaHash,
        syncedAt: "2026-03-31T12:00:00.000Z",
        affectedTypes: ["Post"],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("schema sync sends PUT /api/v1/schema with correct payload and headers", async () => {
  await withTempDir(async (cwd) => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const exitCode = await runMdcmsCli(["schema", "sync"], {
      cwd,
      commands: [createSchemaSyncCommand()],
      loadConfig: async () => ({
        config: STUB_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return createSyncSuccessResponse({
          schemaHash: capturedBody.schemaHash as string,
        });
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);
    assert.equal(capturedUrl, "http://localhost:4000/api/v1/schema");
    assert.equal(capturedInit?.method, "PUT");

    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("x-mdcms-client"), "cli/0.0.0");
    assert.equal(headers.get("x-mdcms-project"), "test-project");
    assert.equal(headers.get("x-mdcms-environment"), "staging");

    assert.ok(capturedBody?.rawConfigSnapshot);
    assert.ok(capturedBody?.resolvedSchema);
    assert.equal(typeof capturedBody?.schemaHash, "string");
  });
});

test("schema sync writes state file on success", async () => {
  await withTempDir(async (cwd) => {
    const exitCode = await runMdcmsCli(["schema", "sync"], {
      cwd,
      commands: [createSchemaSyncCommand()],
      loadConfig: async () => ({
        config: STUB_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { schemaHash: string };
        return createSyncSuccessResponse({ schemaHash: body.schemaHash });
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);

    const statePath = resolveSchemaStatePath({
      cwd,
      project: "test-project",
      environment: "staging",
    });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(typeof state.schemaHash, "string");
    assert.equal(state.schemaHash.length, 64);
    assert.equal(state.syncedAt, "2026-03-31T12:00:00.000Z");
    assert.equal(state.serverUrl, "http://localhost:4000");
  });
});

test("schema sync prints summary to stdout", async () => {
  await withTempDir(async (cwd) => {
    let output = "";

    const exitCode = await runMdcmsCli(["schema", "sync"], {
      cwd,
      commands: [createSchemaSyncCommand()],
      loadConfig: async () => ({
        config: STUB_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { schemaHash: string };
        return createSyncSuccessResponse({ schemaHash: body.schemaHash });
      },
      stdout: {
        write: (chunk: string) => {
          output += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);
    assert.ok(output.includes("Schema synced"));
    assert.ok(output.includes("Post"));
  });
});

test("schema sync returns 1 on SCHEMA_INCOMPATIBLE", async () => {
  await withTempDir(async (cwd) => {
    let stderrOutput = "";

    const exitCode = await runMdcmsCli(["schema", "sync"], {
      cwd,
      commands: [createSchemaSyncCommand()],
      loadConfig: async () => ({
        config: STUB_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      fetcher: async () => {
        return new Response(
          JSON.stringify({
            code: "SCHEMA_INCOMPATIBLE",
            message: 'Removing schema type "Post" requires a migration.',
            details: { type: "Post", reason: "type_removed_with_documents" },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      },
      stdout: { write: () => undefined },
      stderr: {
        write: (chunk: string) => {
          stderrOutput += chunk;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.ok(stderrOutput.includes("SCHEMA_INCOMPATIBLE"));
  });
});

test("schema sync returns 1 on non-200 response", async () => {
  await withTempDir(async (cwd) => {
    const exitCode = await runMdcmsCli(["schema", "sync"], {
      cwd,
      commands: [createSchemaSyncCommand()],
      loadConfig: async () => ({
        config: STUB_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      fetcher: async () => {
        return new Response(
          JSON.stringify({ code: "UNAUTHORIZED", message: "Invalid API key" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
  });
});

test("schema sync sends authorization header when apiKey is present", async () => {
  await withTempDir(async (cwd) => {
    let capturedHeaders = new Headers();

    const exitCode = await runMdcmsCli(
      ["schema", "sync", "--api-key", "test-token"],
      {
        cwd,
        commands: [createSchemaSyncCommand()],
        loadConfig: async () => ({
          config: STUB_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        fetcher: async (_input, init) => {
          capturedHeaders = new Headers(init?.headers);
          const body = JSON.parse(String(init?.body)) as { schemaHash: string };
          return createSyncSuccessResponse({ schemaHash: body.schemaHash });
        },
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(capturedHeaders.get("authorization"), "Bearer test-token");
  });
});

test("performSchemaSync uploads schema and writes local state", async () => {
  await withTempDir(async (cwd) => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      const body = JSON.parse(String(init?.body)) as { schemaHash: string };
      return createSyncSuccessResponse({ schemaHash: body.schemaHash });
    };

    const result = await performSchemaSync({
      config: STUB_CONFIG,
      serverUrl: "http://server",
      project: "p1",
      environment: "staging",
      apiKey: "k",
      cwd,
      fetcher,
    });

    assert.equal(result.outcome, "success");
    if (result.outcome !== "success") return;
    assert.match(result.schemaHash, /^[a-f0-9]{64}$/);
    assert.equal(result.syncedAt, "2026-03-31T12:00:00.000Z");
    assert.deepEqual(result.affectedTypes, ["Post"]);

    assert.equal(capturedUrl, "http://server/api/v1/schema");
    assert.equal(capturedInit?.method, "PUT");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("x-mdcms-project"), "p1");
    assert.equal(headers.get("x-mdcms-environment"), "staging");
    assert.equal(headers.get("authorization"), "Bearer k");

    const statePath = resolveSchemaStatePath({
      cwd,
      project: "p1",
      environment: "staging",
    });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.schemaHash, result.schemaHash);
    assert.equal(state.syncedAt, "2026-03-31T12:00:00.000Z");
    assert.equal(state.serverUrl, "http://server");
  });
});

test("performSchemaSync returns failure on server 4xx", async () => {
  await withTempDir(async (cwd) => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          code: "INVALID_SCHEMA",
          message: "Schema failed validation",
          details: { field: "types" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const result = await performSchemaSync({
      config: STUB_CONFIG,
      serverUrl: "http://server",
      project: "p1",
      environment: "staging",
      apiKey: "k",
      cwd,
      fetcher,
    });

    assert.equal(result.outcome, "failure");
    if (result.outcome !== "failure") return;
    assert.equal(result.errorCode, "INVALID_SCHEMA");
    assert.ok(result.message);
    assert.deepEqual(result.details, { field: "types" });
  });
});

test("performSchemaSync does not write local state on failure", async () => {
  await withTempDir(async (cwd) => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          code: "INVALID_SCHEMA",
          message: "Schema failed validation",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    await performSchemaSync({
      config: STUB_CONFIG,
      serverUrl: "http://server",
      project: "p1",
      environment: "staging",
      apiKey: "k",
      cwd,
      fetcher,
    });

    const statePath = resolveSchemaStatePath({
      cwd,
      project: "p1",
      environment: "staging",
    });
    await assert.rejects(() => access(statePath));
  });
});
