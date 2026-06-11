import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { ContentDocumentResponse, ParsedMdcmsConfig } from "@mdcms/shared";
import { z } from "zod";
import { defineConfig, defineType, parseMdcmsConfig } from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";

import { runMdcmsCli } from "./framework.js";
import { parsePushOptions, renderPushHelp } from "./push.js";

type RemoteDocument = Pick<
  ContentDocumentResponse,
  | "documentId"
  | "type"
  | "locale"
  | "path"
  | "format"
  | "draftRevision"
  | "publishedVersion"
>;

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-push-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createSuccessResponse(data: RemoteDocument): Response {
  return new Response(
    JSON.stringify({
      data,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function createSchemaListResponse(
  config: ParsedMdcmsConfig,
  environment: string,
): Response {
  const payload = buildSchemaSyncPayload(config, environment);
  return new Response(
    JSON.stringify({
      data: {
        types: Object.entries(payload.resolvedSchema).map(
          ([type, snapshot]) => ({
            type,
            directory: (snapshot as { directory: string }).directory,
            localized: (snapshot as { localized: boolean }).localized,
            schemaHash: payload.schemaHash,
            syncedAt: "2026-04-14T00:00:00.000Z",
            resolvedSchema: snapshot,
          }),
        ),
        schemaHash: payload.schemaHash,
        syncedAt: "2026-04-14T00:00:00.000Z",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function createSchemaListResponseWithHash(input: {
  types: Array<{
    type: string;
    directory: string;
    localized: boolean;
    resolvedSchema: unknown;
  }>;
  schemaHash: string | null;
}): Response {
  return new Response(
    JSON.stringify({
      data: {
        types: input.types.map((entry) => ({
          ...entry,
          schemaHash: input.schemaHash ?? "no-hash",
          syncedAt: "2026-04-14T00:00:00.000Z",
        })),
        schemaHash: input.schemaHash,
        syncedAt: input.schemaHash ? "2026-04-14T00:00:00.000Z" : null,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const BLOG_POST_CONFIG = parseMdcmsConfig(
  defineConfig({
    serverUrl: "http://localhost:4000",
    project: "marketing-site",
    environment: "staging",
    contentDirectories: ["content"],
    locales: {
      default: "en",
      supported: ["en"],
    },
    types: [
      defineType("BlogPost", {
        directory: "content/blog",
        localized: true,
        fields: {
          title: z.string(),
        },
      }),
    ],
    environments: { staging: {} },
  }),
);

function isSchemaGetRequest(
  input: string | URL | Request,
  init?: RequestInit,
): boolean {
  return (
    String(input).endsWith("/api/v1/schema") &&
    (init?.method ?? "GET") === "GET"
  );
}

function parseRequestUrl(input: string | URL | Request): URL {
  return new URL(String(input));
}

function setTTY(value: boolean): () => void {
  const previous = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: previous,
      configurable: true,
      writable: true,
    });
  };
}

function hashRawContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writeSchemaStateFile(
  cwd: string,
  project: string,
  environment: string,
): Promise<void> {
  const dir = join(cwd, ".mdcms", "schema");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${project}.${environment}.json`),
    JSON.stringify({
      schemaHash: "test-schema-hash-" + "a".repeat(48),
      syncedAt: "2026-03-31T12:00:00.000Z",
      serverUrl: "http://localhost:4000",
    }),
    "utf8",
  );
}

test("push updates an existing manifest-tracked document via PUT", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-1": {
            path: "content/blog/hello-world.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: 1,
            hash: "old-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const localPath = join(cwd, "content/blog/hello-world.en.md");
    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      localPath,
      '---\ntitle: "Hello World"\n---\n\nUpdated draft body\n',
      "utf8",
    );

    let requestCount = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        assert.equal(
          String(input),
          "http://localhost:4000/api/v1/content/doc-1?fileFields=raw",
        );
        assert.equal(init?.method, "PUT");

        const headers = new Headers(init?.headers as Record<string, string>);
        assert.ok(
          headers.get("x-mdcms-schema-hash"),
          "x-mdcms-schema-hash header must be present",
        );

        const body = JSON.parse(String(init?.body)) as {
          format: string;
          body: string;
          frontmatter: Record<string, unknown>;
          draftRevision: number;
          publishedVersion: number | null;
        };
        assert.equal(body.format, "md");
        assert.equal(body.body.includes("Updated draft body"), true);
        assert.equal(body.frontmatter.title, "Hello World");
        assert.equal(body.draftRevision, 1);
        assert.equal(body.publishedVersion, 1);

        return createSuccessResponse({
          documentId: "doc-1",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/hello-world",
          format: "md",
          draftRevision: 2,
          publishedVersion: 1,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(requestCount, 1);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      {
        draftRevision: number;
        hash: string;
      }
    >;

    assert.equal(manifest["doc-1"]?.draftRevision, 2);
    assert.notEqual(manifest["doc-1"]?.hash, "old-hash");
  });
});

test("push falls back to POST and rewrites manifest key when PUT target is missing", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-missing": {
            path: "content/blog/new-post.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      join(cwd, "content/blog/new-post.en.md"),
      '---\ntitle: "New Post"\n---\n\nHello\n',
      "utf8",
    );

    let putCalls = 0;
    let postCalls = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        const url = String(input);

        const requestUrl = parseRequestUrl(url);

        if (requestUrl.pathname === "/api/v1/content/doc-missing") {
          putCalls += 1;
          assert.equal(init?.method, "PUT");
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          return new Response(
            JSON.stringify({
              code: "NOT_FOUND",
              message: "Document not found.",
            }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }

        assert.equal(
          url,
          "http://localhost:4000/api/v1/content?fileFields=raw",
        );
        postCalls += 1;
        assert.equal(init?.method, "POST");

        const body = JSON.parse(String(init?.body)) as {
          type: string;
          locale: string;
          path: string;
          format: string;
        };

        assert.equal(body.type, "BlogPost");
        assert.equal(body.locale, "en");
        assert.equal(body.path, "content/blog/new-post");
        assert.equal(body.format, "md");

        return createSuccessResponse({
          documentId: "doc-created",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/new-post",
          format: "md",
          draftRevision: 1,
          publishedVersion: null,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(putCalls, 1);
    assert.equal(postCalls, 1);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { path: string }
    >;

    assert.equal(existsSync(join(cwd, "content/blog/new-post.en.md")), true);
    assert.equal(manifest["doc-missing"], undefined);
    assert.equal(manifest["doc-created"]?.path, "content/blog/new-post.en.md");
  });
});

test("push sends only changed documents and skips unchanged manifest entries", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    const changedContent = "# Changed\n";
    const unchangedOneContent = "# Unchanged one\n";
    const unchangedTwoContent = "# Unchanged two\n";

    await writeFile(
      join(cwd, "content/blog/changed.en.md"),
      changedContent,
      "utf8",
    );
    await writeFile(
      join(cwd, "content/blog/unchanged-one.en.md"),
      unchangedOneContent,
      "utf8",
    );
    await writeFile(
      join(cwd, "content/blog/unchanged-two.en.md"),
      unchangedTwoContent,
      "utf8",
    );

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-changed": {
            path: "content/blog/changed.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "outdated-hash",
          },
          "doc-unchanged-1": {
            path: "content/blog/unchanged-one.en.md",
            format: "md",
            draftRevision: 4,
            publishedVersion: null,
            hash: hashRawContent(unchangedOneContent),
          },
          "doc-unchanged-2": {
            path: "content/blog/unchanged-two.en.md",
            format: "md",
            draftRevision: 7,
            publishedVersion: 2,
            hash: hashRawContent(unchangedTwoContent),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let stdout = "";
    let requestCount = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        assert.equal(
          String(input).endsWith("/api/v1/content/doc-changed?fileFields=raw"),
          true,
        );
        assert.equal(init?.method, "PUT");
        return createSuccessResponse({
          documentId: "doc-changed",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/changed",
          format: "md",
          draftRevision: 2,
          publishedVersion: null,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(requestCount, 1);
    assert.equal(stdout.includes("Unchanged (skipped): 2"), true);
  });
});

test("push exits successfully without API calls when no changed documents are found", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    const localContent = "# Stable document\n";
    await writeFile(
      join(cwd, "content/blog/stable.en.md"),
      localContent,
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-stable": {
            path: "content/blog/stable.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 1,
            hash: hashRawContent(localContent),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let stdout = "";
    let requestCount = 0;
    let confirmCount = 0;
    const exitCode = await runMdcmsCli(["push"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        throw new Error("fetch should not be called");
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => {
        confirmCount += 1;
        return true;
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(requestCount, 0);
    assert.equal(confirmCount, 0);
    assert.equal(stdout.includes("No changes to push"), true);
  });
});

test("push exits successfully without local schema state when no content writes are needed", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    const localContent = "# Stable document\n";
    await writeFile(
      join(cwd, "content/blog/stable.en.md"),
      localContent,
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-stable": {
            path: "content/blog/stable.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 1,
            hash: hashRawContent(localContent),
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const restoreTTY = setTTY(false);
    try {
      let stdout = "";
      let requestCount = 0;
      let confirmCount = 0;
      const exitCode = await runMdcmsCli(["push"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
          }
          requestCount += 1;
          throw new Error("fetch should not be called");
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: {
          write: (chunk) => {
            stdout += chunk;
          },
        },
        stderr: { write: () => undefined },
        confirm: async () => {
          confirmCount += 1;
          return true;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(requestCount, 0);
      assert.equal(confirmCount, 0);
      assert.equal(stdout.includes("No changes to push"), true);
    } finally {
      restoreTTY();
    }
  });
});

test("push treats missing manifest hash as changed and repairs hash after success", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    const localContent = "# Missing hash compatibility\n";
    await writeFile(
      join(cwd, "content/blog/missing-hash.en.md"),
      localContent,
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-legacy": {
            path: "content/blog/missing-hash.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let requestCount = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        return createSuccessResponse({
          documentId: "doc-legacy",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/missing-hash",
          format: "md",
          draftRevision: 2,
          publishedVersion: null,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(requestCount, 1);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { hash?: string }
    >;
    assert.equal(typeof manifest["doc-legacy"]?.hash, "string");
    assert.equal((manifest["doc-legacy"]?.hash ?? "").length > 0, true);
  });
});

test("push fails with deterministic error on unsupported file extension", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-1": {
            path: "content/blog/hello-world.txt",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(join(cwd, "content/blog/hello-world.txt"), "hello", "utf8");

    let stderr = "";
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        throw new Error("fetch should not be called");
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
      confirm: async () => true,
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr.includes("UNSUPPORTED_EXTENSION"), true);
  });
});

test("push reports stale document as failed and continues pushing remaining documents", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-stale": {
            path: "content/blog/stale-post.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash-1",
          },
          "doc-fresh": {
            path: "content/blog/fresh-post.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 2,
            hash: "old-hash-2",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      join(cwd, "content/blog/stale-post.en.md"),
      '---\ntitle: "Stale"\n---\nstale body\n',
      "utf8",
    );
    await writeFile(
      join(cwd, "content/blog/fresh-post.en.md"),
      '---\ntitle: "Fresh"\n---\nfresh body\n',
      "utf8",
    );

    const stdoutChunks: string[] = [];
    let requestCount = 0;

    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        const url = String(input);
        const requestUrl = parseRequestUrl(url);

        if (requestUrl.pathname === "/api/v1/content/doc-stale") {
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          return new Response(
            JSON.stringify({
              code: "STALE_DRAFT_REVISION",
              message: "Draft has been modified since your last pull.",
              statusCode: 409,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }

        return createSuccessResponse({
          documentId: "doc-fresh",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/fresh-post",
          format: "md",
          draftRevision: 4,
          publishedVersion: 2,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          stdoutChunks.push(chunk);
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    // Exit code 1 because there is at least one failure
    assert.equal(exitCode, 1);
    // Both documents were sent
    assert.equal(requestCount, 2);

    const output = stdoutChunks.join("");

    // Stale doc reported as failed
    assert.ok(output.includes("[FAILED]"));
    assert.ok(output.includes("doc-stale"));
    assert.ok(output.includes("STALE_DRAFT_REVISION"));

    // Fresh doc reported as updated
    assert.ok(output.includes("[UPDATED]"));
    assert.ok(output.includes("doc-fresh"));

    // Actionable summary printed
    assert.ok(output.includes("cms pull"));

    // Manifest updated for fresh doc, stale doc unchanged
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { draftRevision: number; hash: string }
    >;
    assert.equal(manifest["doc-fresh"]?.draftRevision, 4);
    assert.equal(manifest["doc-stale"]?.draftRevision, 1);
    assert.equal(manifest["doc-stale"]?.hash, "old-hash-1");
  });
});

test("push reports collaboration-active document as failed and continues pushing remaining documents", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-locked": {
            path: "content/blog/locked-post.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash-1",
          },
          "doc-open": {
            path: "content/blog/open-post.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 2,
            hash: "old-hash-2",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      join(cwd, "content/blog/locked-post.en.md"),
      '---\ntitle: "Locked"\n---\nlocked body\n',
      "utf8",
    );
    await writeFile(
      join(cwd, "content/blog/open-post.en.md"),
      '---\ntitle: "Open"\n---\nopen body\n',
      "utf8",
    );

    const stdoutChunks: string[] = [];
    let requestCount = 0;

    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        const url = String(input);
        const requestUrl = parseRequestUrl(url);

        if (requestUrl.pathname === "/api/v1/content/doc-locked") {
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          return new Response(
            JSON.stringify({
              code: "DOCUMENT_COLLABORATION_ACTIVE",
              message: "Document has an active collaboration session.",
              statusCode: 409,
              details: { documentId: "doc-locked" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }

        return createSuccessResponse({
          documentId: "doc-open",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/open-post",
          format: "md",
          draftRevision: 4,
          publishedVersion: 2,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          stdoutChunks.push(chunk);
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 1);
    assert.equal(requestCount, 2);

    const output = stdoutChunks.join("");

    assert.ok(output.includes("[FAILED]"));
    assert.ok(output.includes("doc-locked"));
    assert.ok(output.includes("collaboration_active"));
    assert.ok(output.includes("active Studio collaboration session"));
    assert.ok(output.includes("[UPDATED]"));
    assert.ok(output.includes("doc-open"));

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { draftRevision: number; hash: string }
    >;
    assert.equal(manifest["doc-open"]?.draftRevision, 4);
    assert.equal(manifest["doc-locked"]?.draftRevision, 1);
    assert.equal(manifest["doc-locked"]?.hash, "old-hash-1");
  });
});

test("push reports schema-mismatch document as failed and continues pushing remaining documents", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-mismatch": {
            path: "content/blog/mismatch-post.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash-1",
          },
          "doc-ok": {
            path: "content/blog/ok-post.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 2,
            hash: "old-hash-2",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      join(cwd, "content/blog/mismatch-post.en.md"),
      '---\ntitle: "Mismatch"\n---\nmismatch body\n',
      "utf8",
    );
    await writeFile(
      join(cwd, "content/blog/ok-post.en.md"),
      '---\ntitle: "OK"\n---\nok body\n',
      "utf8",
    );

    const stdoutChunks: string[] = [];
    let requestCount = 0;

    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        requestCount += 1;
        const url = String(input);
        const requestUrl = parseRequestUrl(url);

        if (requestUrl.pathname === "/api/v1/content/doc-mismatch") {
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          return new Response(
            JSON.stringify({
              code: "SCHEMA_HASH_MISMATCH",
              message: "Schema hash does not match the server schema.",
              statusCode: 409,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }

        return createSuccessResponse({
          documentId: "doc-ok",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/ok-post",
          format: "md",
          draftRevision: 4,
          publishedVersion: 2,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          stdoutChunks.push(chunk);
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    // Exit code 1 because there is at least one failure
    assert.equal(exitCode, 1);
    // Both documents were sent
    assert.equal(requestCount, 2);

    const output = stdoutChunks.join("");

    // Mismatch doc reported as failed
    assert.ok(output.includes("[FAILED]"));
    assert.ok(output.includes("doc-mismatch"));
    assert.ok(output.includes("SCHEMA_HASH_MISMATCH"));

    // OK doc reported as updated
    assert.ok(output.includes("[UPDATED]"));
    assert.ok(output.includes("doc-ok"));

    // Actionable summary printed — race-condition message (preflight passed but a concurrent sync changed server hash)
    assert.ok(output.includes("schema changed during push"));
    assert.ok(output.includes("Re-run: cms push"));
    assert.ok(!output.includes("'cms schema sync'"));

    // Manifest updated for ok doc, mismatch doc unchanged
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { draftRevision: number; hash: string }
    >;
    assert.equal(manifest["doc-ok"]?.draftRevision, 4);
    assert.equal(manifest["doc-mismatch"]?.draftRevision, 1);
    assert.equal(manifest["doc-mismatch"]?.hash, "old-hash-1");
  });
});

test("push --validate blocks push on validation errors", async () => {
  await withTempDir(async (cwd) => {
    await writeSchemaStateFile(cwd, "test-project", "staging");
    const config = parseMdcmsConfig(
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
        environments: { staging: {} },
      }),
    );

    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "test-project.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({
        "doc-1": {
          path: "content/posts/bad.md",
          format: "md",
          draftRevision: 1,
          publishedVersion: null,
          hash: "old-hash",
        },
      }),
      "utf8",
    );

    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content/posts/bad.md"),
      "---\n---\nBody\n",
      "utf8",
    );

    let requestCount = 0;

    const exitCode = await runMdcmsCli(["push", "--validate", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(config, "staging");
        }
        requestCount += 1;
        throw new Error("fetch should not be called");
      },
      loadConfig: async () => ({
        config,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 1);
    assert.equal(requestCount, 0);
  });
});

test("push --force auto-selects all new files and creates them via POST", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");

    // Empty manifest — no tracked documents
    await writeFile(manifestPath, JSON.stringify({}), "utf8");

    // One new untracked file
    await mkdir(join(cwd, "content", "blog"), { recursive: true });
    await writeFile(
      join(cwd, "content/blog/new-post.en.md"),
      '---\ntitle: "New"\n---\nNew body\n',
      "utf8",
    );

    let postCalls = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        const url = String(input);
        assert.equal(
          url,
          "http://localhost:4000/api/v1/content?fileFields=raw",
        );
        assert.equal(init?.method, "POST");
        postCalls += 1;

        const body = JSON.parse(String(init?.body)) as {
          type: string;
          locale: string;
          path: string;
          format: string;
          frontmatter: Record<string, unknown>;
          body: string;
        };
        assert.equal(body.type, "BlogPost");
        assert.equal(body.locale, "en");
        assert.equal(body.path, "content/blog/new-post");
        assert.equal(body.format, "md");
        assert.equal(body.frontmatter.title, "New");

        return createSuccessResponse({
          documentId: "doc-new-1",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/new-post",
          format: "md",
          draftRevision: 1,
          publishedVersion: null,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(postCalls, 1);

    // Manifest should now contain the new document
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { path: string; draftRevision: number }
    >;
    assert.equal(manifest["doc-new-1"]?.path, "content/blog/new-post.en.md");
    assert.equal(manifest["doc-new-1"]?.draftRevision, 1);
  });
});

test("push --force deletes locally-missing files via DELETE and removes from manifest", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");

    // File exists in manifest but NOT on disk
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-to-delete": {
            path: "content/blog/old-post.en.md",
            format: "md",
            draftRevision: 5,
            publishedVersion: 3,
            hash: "some-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Create content dir so scanning works, but no files
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    let deleteCalls = 0;
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        const url = String(input);
        assert.ok(url.endsWith("/api/v1/content/doc-to-delete"));
        assert.equal(init?.method, "DELETE");
        deleteCalls += 1;

        return createSuccessResponse({
          documentId: "doc-to-delete",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/old-post",
          format: "md",
          draftRevision: 5,
          publishedVersion: 3,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(deleteCalls, 1);

    // Manifest should no longer contain the deleted document
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(manifest["doc-to-delete"], undefined);
  });
});

test("push --force reports collaboration-active delete as failed and continues deleting remaining documents", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-delete-locked": {
            path: "content/blog/delete-locked.en.md",
            format: "md",
            draftRevision: 5,
            publishedVersion: 3,
            hash: "locked-hash",
          },
          "doc-delete-open": {
            path: "content/blog/delete-open.en.md",
            format: "md",
            draftRevision: 2,
            publishedVersion: null,
            hash: "open-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    let deleteCalls = 0;
    let stdout = "";
    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        const url = String(input);
        const requestUrl = parseRequestUrl(url);
        assert.equal(init?.method, "DELETE");
        deleteCalls += 1;

        if (requestUrl.pathname === "/api/v1/content/doc-delete-locked") {
          return new Response(
            JSON.stringify({
              code: "DOCUMENT_COLLABORATION_ACTIVE",
              message: "Document has an active collaboration session.",
              statusCode: 409,
              details: { documentId: "doc-delete-locked" },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }

        assert.equal(requestUrl.pathname, "/api/v1/content/doc-delete-open");
        return createSuccessResponse({
          documentId: "doc-delete-open",
          type: "BlogPost",
          locale: "en",
          path: "content/blog/delete-open",
          format: "md",
          draftRevision: 2,
          publishedVersion: null,
        });
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 1);
    assert.equal(deleteCalls, 2);
    assert.ok(stdout.includes("[FAILED]"));
    assert.ok(stdout.includes("doc-delete-locked"));
    assert.ok(stdout.includes("collaboration_active"));
    assert.ok(stdout.includes("active Studio collaboration session"));
    assert.ok(stdout.includes("[DELETED]"));
    assert.ok(stdout.includes("doc-delete-open"));

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.ok(manifest["doc-delete-locked"]);
    assert.equal(manifest["doc-delete-open"], undefined);
  });
});

test("push --force handles mixed changed + new + deleted documents in one run", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeSchemaStateFile(cwd, "marketing-site", "staging");

    await mkdir(join(cwd, "content", "blog"), { recursive: true });

    // Changed file (exists in manifest, content differs)
    await writeFile(
      join(cwd, "content/blog/changed.en.md"),
      '---\ntitle: "Changed"\n---\nUpdated body\n',
      "utf8",
    );

    // New file (not in manifest)
    await writeFile(
      join(cwd, "content/blog/brand-new.en.md"),
      '---\ntitle: "Brand New"\n---\nNew body\n',
      "utf8",
    );

    // Deleted file (in manifest, not on disk)
    // content/blog/deleted.en.md intentionally does NOT exist

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-changed": {
            path: "content/blog/changed.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
            hash: "old-hash",
          },
          "doc-to-delete": {
            path: "content/blog/deleted.en.md",
            format: "md",
            draftRevision: 3,
            publishedVersion: 1,
            hash: "delete-hash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let putCalls = 0;
    let postCalls = 0;
    let deleteCalls = 0;
    let stdout = "";

    const exitCode = await runMdcmsCli(["push", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input, init) => {
        if (isSchemaGetRequest(input, init)) {
          return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
        }
        const url = String(input);
        const method = init?.method;
        const requestUrl = parseRequestUrl(url);

        if (
          method === "PUT" &&
          requestUrl.pathname === "/api/v1/content/doc-changed"
        ) {
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          putCalls += 1;
          return createSuccessResponse({
            documentId: "doc-changed",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/changed",
            format: "md",
            draftRevision: 2,
            publishedVersion: null,
          });
        }

        if (method === "POST" && requestUrl.pathname === "/api/v1/content") {
          assert.equal(requestUrl.searchParams.get("fileFields"), "raw");
          postCalls += 1;
          return createSuccessResponse({
            documentId: "doc-brand-new",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/brand-new",
            format: "md",
            draftRevision: 1,
            publishedVersion: null,
          });
        }

        if (
          method === "DELETE" &&
          url.endsWith("/api/v1/content/doc-to-delete")
        ) {
          deleteCalls += 1;
          return createSuccessResponse({
            documentId: "doc-to-delete",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/deleted",
            format: "md",
            draftRevision: 3,
            publishedVersion: 1,
          });
        }

        throw new Error(`Unexpected request: ${method} ${url}`);
      },
      loadConfig: async () => ({
        config: BLOG_POST_CONFIG,
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
      confirm: async () => true,
    });

    assert.equal(exitCode, 0);
    assert.equal(putCalls, 1);
    assert.equal(postCalls, 1);
    assert.equal(deleteCalls, 1);

    assert.ok(stdout.includes("[UPDATED]"));
    assert.ok(stdout.includes("[CREATED]"));
    assert.ok(stdout.includes("[DELETED]"));

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { path: string; draftRevision: number }
    >;
    assert.equal(manifest["doc-changed"]?.draftRevision, 2);
    assert.equal(
      manifest["doc-brand-new"]?.path,
      "content/blog/brand-new.en.md",
    );
    assert.equal(manifest["doc-to-delete"], undefined);
  });
});

test("parsePushOptions accepts --sync-schema", () => {
  const options = parsePushOptions(["--sync-schema"]);
  assert.equal(options.syncSchema, true);
});

test("parsePushOptions defaults syncSchema to false", () => {
  const options = parsePushOptions([]);
  assert.equal(options.syncSchema, false);
});

test("parsePushOptions accepts --sync-schema with other flags", () => {
  const options = parsePushOptions(["--force", "--sync-schema"]);
  assert.equal(options.syncSchema, true);
  assert.equal(options.force, true);
});

test("renderPushHelp documents --sync-schema and preflight behavior", () => {
  const help = renderPushHelp();
  assert.ok(help.includes("--sync-schema"));
  assert.ok(help.includes("non-interactive"));
  assert.ok(help.includes("preflight"));
});

// -----------------------------------------------------------------------------
// Preflight tests (Tasks 9-12)
// -----------------------------------------------------------------------------

// Divergent config used to synthesize a drift response.
const DRIFT_CONFIG = parseMdcmsConfig(
  defineConfig({
    serverUrl: "http://localhost:4000",
    project: "marketing-site",
    environment: "staging",
    contentDirectories: ["content"],
    locales: {
      default: "en",
      supported: ["en"],
    },
    types: [
      defineType("BlogPost", {
        directory: "content/blog",
        localized: true,
        fields: {
          // Add an extra required field so the server schema differs from local.
          title: z.string(),
          subtitle: z.string(),
        },
      }),
    ],
    environments: { staging: {} },
  }),
);

async function seedPushableWorkspace(
  cwd: string,
  options: { writeSchemaState?: boolean } = {},
): Promise<void> {
  const manifestPath = join(
    cwd,
    ".mdcms",
    "manifests",
    "marketing-site.staging.json",
  );
  await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
  if (options.writeSchemaState !== false) {
    await writeSchemaStateFile(cwd, "marketing-site", "staging");
  }
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        "doc-1": {
          path: "content/blog/hello-world.en.md",
          format: "md",
          draftRevision: 1,
          publishedVersion: 1,
          hash: "old-hash",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await mkdir(join(cwd, "content", "blog"), { recursive: true });
  await writeFile(
    join(cwd, "content/blog/hello-world.en.md"),
    '---\ntitle: "Hello World"\n---\n\nUpdated draft body\n',
    "utf8",
  );
}

test("push --dry-run does not require local schema state before writes", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd, { writeSchemaState: false });
    const restoreTTY = setTTY(false);
    try {
      let schemaGetCalls = 0;
      let contentWriteCalls = 0;
      let stdout = "";

      const exitCode = await runMdcmsCli(["push", "--force", "--dry-run"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          if (isSchemaGetRequest(input, init)) {
            schemaGetCalls += 1;
            return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
          }
          contentWriteCalls += 1;
          throw new Error("dry run should not write content");
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: {
          write: (chunk: string) => {
            stdout += chunk;
          },
        },
        stderr: { write: () => undefined },
        confirm: async () => true,
      });

      assert.equal(exitCode, 0);
      assert.equal(schemaGetCalls, 1);
      assert.equal(contentWriteCalls, 0);
      assert.ok(stdout.includes("Dry run complete. No changes were pushed."));
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: no drift continues to content writes", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let putContentCalls = 0;
      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(BLOG_POST_CONFIG, "staging");
          }
          putContentCalls += 1;
          return createSuccessResponse({
            documentId: "doc-1",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/hello-world",
            format: "md",
            draftRevision: 2,
            publishedVersion: 1,
          });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async () => true,
      });

      assert.equal(exitCode, 0);
      assert.equal(putContentCalls, 1);
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: drift + TTY + accept syncs and continues", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(true);
    try {
      let schemaPutCalls = 0;
      let contentPutCalls = 0;
      let confirmCount = 0;
      let schemaSyncedHash: string | undefined;
      let contentHashHeader: string | undefined;

      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            // Return server schema that differs from local.
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            const body = JSON.parse(String(init?.body)) as {
              schemaHash: string;
            };
            schemaSyncedHash = body.schemaHash;
            return new Response(
              JSON.stringify({
                data: {
                  schemaHash: body.schemaHash,
                  syncedAt: "2026-04-14T00:00:00.000Z",
                  affectedTypes: ["BlogPost"],
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          contentPutCalls += 1;
          const headers = new Headers(init?.headers as Record<string, string>);
          contentHashHeader = headers.get("x-mdcms-schema-hash") ?? undefined;
          return createSuccessResponse({
            documentId: "doc-1",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/hello-world",
            format: "md",
            draftRevision: 2,
            publishedVersion: 1,
          });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async () => {
          confirmCount += 1;
          return true;
        },
      });

      assert.equal(exitCode, 0);
      assert.equal(schemaPutCalls, 1);
      assert.equal(contentPutCalls, 1);
      assert.ok(confirmCount >= 1);
      // E2E contract: content write carries the freshly-synced hash, not the stale state.
      assert.ok(schemaSyncedHash, "sync should have produced a schemaHash");
      assert.equal(contentHashHeader, schemaSyncedHash);
      // Local schema state file was updated to the fresh hash.
      const statePath = join(
        cwd,
        ".mdcms",
        "schema",
        "marketing-site.staging.json",
      );
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        schemaHash: string;
      };
      assert.equal(persisted.schemaHash, schemaSyncedHash);
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: drift + TTY + decline aborts with no writes", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(true);
    try {
      let schemaPutCalls = 0;
      let contentCalls = 0;

      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            return new Response("{}", { status: 200 });
          }
          contentCalls += 1;
          return new Response("{}", { status: 200 });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async () => false,
      });

      assert.equal(exitCode, 1);
      assert.equal(schemaPutCalls, 0);
      assert.equal(contentCalls, 0);
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: drift + non-interactive + no flag fails closed with hint", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let schemaPutCalls = 0;
      let contentCalls = 0;
      let stderr = "";

      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            return new Response("{}", { status: 200 });
          }
          contentCalls += 1;
          return new Response("{}", { status: 200 });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
          },
        },
        confirm: async () => true,
      });

      assert.equal(exitCode, 1);
      assert.equal(schemaPutCalls, 0);
      assert.equal(contentCalls, 0);
      assert.ok(stderr.includes("SCHEMA_DRIFT"));
      assert.ok(stderr.includes("--sync-schema"));
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: drift + non-interactive + --sync-schema syncs and continues", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let schemaPutCalls = 0;
      let contentPutCalls = 0;

      const exitCode = await runMdcmsCli(["push", "--force", "--sync-schema"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            const body = JSON.parse(String(init?.body)) as {
              schemaHash: string;
            };
            return new Response(
              JSON.stringify({
                data: {
                  schemaHash: body.schemaHash,
                  syncedAt: "2026-04-14T00:00:00.000Z",
                  affectedTypes: ["BlogPost"],
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          contentPutCalls += 1;
          return createSuccessResponse({
            documentId: "doc-1",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/hello-world",
            format: "md",
            draftRevision: 2,
            publishedVersion: 1,
          });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async () => true,
      });

      assert.equal(exitCode, 0);
      assert.equal(schemaPutCalls, 1);
      assert.equal(contentPutCalls, 1);
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: drift + --sync-schema + sync fails aborts before content writes", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let schemaPutCalls = 0;
      let contentCalls = 0;

      const exitCode = await runMdcmsCli(["push", "--force", "--sync-schema"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            return new Response(
              JSON.stringify({
                code: "SCHEMA_SYNC_FAILED",
                message: "Bad schema.",
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }
          contentCalls += 1;
          return new Response("{}", { status: 200 });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async () => true,
      });

      assert.equal(exitCode, 1);
      assert.equal(schemaPutCalls, 1);
      assert.equal(contentCalls, 0);
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: GET /api/v1/schema fails returns SCHEMA_PREFLIGHT_FAILED", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let contentCalls = 0;
      let stderr = "";
      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          if (isSchemaGetRequest(input, init)) {
            return new Response("oops", { status: 500 });
          }
          contentCalls += 1;
          return new Response("{}", { status: 200 });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
          },
        },
        confirm: async () => true,
      });

      assert.equal(exitCode, 1);
      assert.equal(contentCalls, 0);
      assert.ok(stderr.includes("SCHEMA_PREFLIGHT_FAILED"));
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: server schemaHash null treated as drift", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(false);
    try {
      let contentCalls = 0;
      let stderr = "";
      const exitCode = await runMdcmsCli(["push", "--force"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponseWithHash({
              types: [],
              schemaHash: null,
            });
          }
          contentCalls += 1;
          return new Response("{}", { status: 200 });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: {
          write: (chunk: string) => {
            stderr += chunk;
          },
        },
        confirm: async () => true,
      });

      assert.equal(exitCode, 1);
      assert.equal(contentCalls, 0);
      assert.ok(stderr.includes("SCHEMA_DRIFT"));
    } finally {
      restoreTTY();
    }
  });
});

test("preflight: --sync-schema in TTY mode is silently ignored, prompt shown", async () => {
  await withTempDir(async (cwd) => {
    await seedPushableWorkspace(cwd);
    const restoreTTY = setTTY(true);
    try {
      let schemaPutCalls = 0;
      let contentPutCalls = 0;
      let confirmCount = 0;
      let promptSeen = false;

      const exitCode = await runMdcmsCli(["push", "--force", "--sync-schema"], {
        cwd,
        env: {} as NodeJS.ProcessEnv,
        fetcher: async (input, init) => {
          const url = String(input);
          if (isSchemaGetRequest(input, init)) {
            return createSchemaListResponse(DRIFT_CONFIG, "staging");
          }
          if (url.endsWith("/api/v1/schema") && init?.method === "PUT") {
            schemaPutCalls += 1;
            const body = JSON.parse(String(init?.body)) as {
              schemaHash: string;
            };
            return new Response(
              JSON.stringify({
                data: {
                  schemaHash: body.schemaHash,
                  syncedAt: "2026-04-14T00:00:00.000Z",
                  affectedTypes: ["BlogPost"],
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          contentPutCalls += 1;
          return createSuccessResponse({
            documentId: "doc-1",
            type: "BlogPost",
            locale: "en",
            path: "content/blog/hello-world",
            format: "md",
            draftRevision: 2,
            publishedVersion: 1,
          });
        },
        loadConfig: async () => ({
          config: BLOG_POST_CONFIG,
          configPath: join(cwd, "mdcms.config.ts"),
        }),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        confirm: async (message: string) => {
          confirmCount += 1;
          if (message.toLowerCase().includes("sync schema")) {
            promptSeen = true;
          }
          return true;
        },
      });

      assert.equal(exitCode, 0);
      assert.ok(promptSeen, "interactive prompt should have been shown");
      assert.equal(schemaPutCalls, 1);
      assert.equal(contentPutCalls, 1);
      assert.ok(confirmCount >= 1);
    } finally {
      restoreTTY();
    }
  });
});
