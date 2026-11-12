import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { ContentDocumentResponse } from "@mdcms/shared";
import { defineConfig, defineType, parseMdcmsConfig } from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";
import { z } from "zod";

import { runMdcmsCli } from "./framework.js";

type RemoteDocument = Pick<
  ContentDocumentResponse,
  | "documentId"
  | "type"
  | "locale"
  | "path"
  | "format"
  | "frontmatter"
  | "body"
  | "draftRevision"
  | "publishedVersion"
>;

function createContentListResponse(input: {
  rows: RemoteDocument[];
  hasMore?: boolean;
}): Response {
  return new Response(
    JSON.stringify({
      data: input.rows,
      pagination: {
        hasMore: input.hasMore ?? false,
        limit: 100,
        offset: 0,
        total: input.rows.length,
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-status-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function defaultLoadConfig(cwd: string) {
  return async () => ({
    config: {
      serverUrl: "http://localhost:4000",
      project: "marketing-site",
      environment: "staging",
      types: [{ name: "BlogPost", directory: "content/blog", localized: true }],
    },
    configPath: join(cwd, "mdcms.config.ts"),
  });
}

async function writeManifest(
  cwd: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const manifestDir = join(cwd, ".mdcms", "manifests");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "marketing-site.staging.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

async function writeLocalFile(
  cwd: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const absolutePath = join(cwd, relativePath);
  const dir = dirname(absolutePath);
  await mkdir(dir, { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

test("status --help prints help text and exits 0", async () => {
  let stdout = "";

  const exitCode = await runMdcmsCli(["status", "--help"], {
    env: {} as NodeJS.ProcessEnv,
    fetcher: async () => {
      throw new Error("fetch should not be called");
    },
    loadConfig: async () => ({
      config: {
        serverUrl: "http://localhost:4000",
        project: "test-project",
        environment: "staging",
      },
      configPath: "/repo/mdcms.config.ts",
    }),
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: () => undefined,
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("status"));
});

test("status -h prints help text and exits 0", async () => {
  let stdout = "";

  const exitCode = await runMdcmsCli(["status", "-h"], {
    env: {} as NodeJS.ProcessEnv,
    fetcher: async () => {
      throw new Error("fetch should not be called");
    },
    loadConfig: async () => ({
      config: {
        serverUrl: "http://localhost:4000",
        project: "test-project",
        environment: "staging",
      },
      configPath: "/repo/mdcms.config.ts",
    }),
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: () => undefined,
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("status"));
});

test("status reports all in sync when local hash matches manifest and server revision matches", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Hello\n---\n\nBody content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body content\n",
      draftRevision: 5,
      publishedVersion: 3,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/hello-world.en.md",
        format: "md",
        draftRevision: 5,
        publishedVersion: 3,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/hello-world.en.md", fileContent);

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Unchanged"),
      `Expected "Unchanged" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("No synced schema found"),
      `Expected schema no_state in output, got: ${stdout}`,
    );
  });
});

test("status reports modified locally when local file hash differs from manifest", async () => {
  await withTempDir(async (cwd) => {
    const originalContent = "---\ntitle: Hello\n---\n\nOriginal body\n";
    const originalHash = hashContent(originalContent);

    const modifiedContent = "---\ntitle: Hello\n---\n\nModified body\n";

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/about",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Original body\n",
      draftRevision: 8,
      publishedVersion: null,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/about.en.md",
        format: "md",
        draftRevision: 8,
        publishedVersion: null,
        hash: originalHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/about.en.md", modifiedContent);

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Modified locally"),
      `Expected "Modified locally" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("content/blog/about.en.md"),
      `Expected file path in output, got: ${stdout}`,
    );
  });
});

test("status reports modified on server when server draftRevision differs from manifest", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Hello\n---\n\nBody content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body content\n",
      draftRevision: 15,
      publishedVersion: 3,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/hello-world.en.md",
        format: "md",
        draftRevision: 12,
        publishedVersion: 3,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/hello-world.en.md", fileContent);

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Modified on server"),
      `Expected "Modified on server" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("r12"),
      `Expected manifest revision r12 in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("r15"),
      `Expected server revision r15 in output, got: ${stdout}`,
    );
  });
});

test("status reports both modified when local hash and server revision both differ", async () => {
  await withTempDir(async (cwd) => {
    const originalContent = "---\ntitle: Original\n---\n\nOriginal body\n";
    const originalHash = hashContent(originalContent);

    const modifiedContent =
      "---\ntitle: Original\n---\n\nLocally modified body\n";

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/conflict-post",
      format: "md",
      frontmatter: { title: "Original" },
      body: "Server modified body\n",
      draftRevision: 5,
      publishedVersion: null,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/conflict-post.en.md",
        format: "md",
        draftRevision: 3,
        publishedVersion: null,
        hash: originalHash,
      },
    });

    await writeLocalFile(
      cwd,
      "content/blog/conflict-post.en.md",
      modifiedContent,
    );

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Both modified"),
      `Expected "Both modified" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("r3"),
      `Expected manifest revision r3 in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("r5"),
      `Expected server revision r5 in output, got: ${stdout}`,
    );
  });
});

test("status reports new on server when document exists on server but not in manifest", async () => {
  await withTempDir(async (cwd) => {
    const serverDoc: RemoteDocument = {
      documentId: "doc-new",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/new-post",
      format: "md",
      frontmatter: { title: "New Post" },
      body: "New content\n",
      draftRevision: 1,
      publishedVersion: null,
    };

    await writeManifest(cwd, {});

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("New on server"),
      `Expected "New on server" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("content/blog/new-post.en.md"),
      `Expected resolved path in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("r1"),
      `Expected server revision r1 in output, got: ${stdout}`,
    );
  });
});

test("status reports deleted on server when document is in manifest but not on server", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Deprecated\n---\n\nDeprecated content\n";
    const fileHash = hashContent(fileContent);

    await writeManifest(cwd, {
      "doc-deleted": {
        path: "content/blog/deprecated-post.en.md",
        format: "md",
        draftRevision: 4,
        publishedVersion: 2,
        hash: fileHash,
      },
    });

    await writeLocalFile(
      cwd,
      "content/blog/deprecated-post.en.md",
      fileContent,
    );

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Deleted on server"),
      `Expected "Deleted on server" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("content/blog/deprecated-post.en.md"),
      `Expected file path in output, got: ${stdout}`,
    );
  });
});

test("status reports moved/renamed when server path differs from manifest path", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Slug Post\n---\n\nSlug content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-moved",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/new-slug",
      format: "md",
      frontmatter: { title: "Slug Post" },
      body: "Slug content\n",
      draftRevision: 3,
      publishedVersion: null,
    };

    await writeManifest(cwd, {
      "doc-moved": {
        path: "content/blog/old-slug.en.md",
        format: "md",
        draftRevision: 3,
        publishedVersion: null,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/old-slug.en.md", fileContent);

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Moved/Renamed"),
      `Expected "Moved/Renamed" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("content/blog/old-slug.en.md"),
      `Expected old path in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("content/blog/new-slug.en.md"),
      `Expected new path in output, got: ${stdout}`,
    );
  });
});

const parsedConfigWithTypes = parseMdcmsConfig(
  defineConfig({
    project: "marketing-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    locales: { default: "en", supported: ["en"] },
    types: [
      defineType("BlogPost", {
        directory: "content/blog",
        localized: true,
        fields: { title: z.string() },
      }),
    ],
    environments: { staging: {} },
  }),
);

function schemaAwareLoadConfig(cwd: string) {
  return async () => ({
    config: parsedConfigWithTypes,
    configPath: join(cwd, "mdcms.config.ts"),
  });
}

async function writeSchemaState(
  cwd: string,
  state: { schemaHash: string; syncedAt: string; serverUrl: string },
): Promise<void> {
  const dir = join(cwd, ".mdcms", "schema");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "marketing-site.staging.json"),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

test("status reports schema in sync when local hash matches stored state", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Hello\n---\n\nBody content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body content\n",
      draftRevision: 5,
      publishedVersion: 3,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/hello-world.en.md",
        format: "md",
        draftRevision: 5,
        publishedVersion: 3,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/hello-world.en.md", fileContent);

    const { schemaHash } = buildSchemaSyncPayload(
      parsedConfigWithTypes,
      "staging",
    );

    await writeSchemaState(cwd, {
      schemaHash,
      syncedAt: "2026-03-30T14:22:00Z",
      serverUrl: "http://localhost:4000",
    });

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: schemaAwareLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 0);
    assert.ok(
      stdout.includes("In sync"),
      `Expected "In sync" in output, got: ${stdout}`,
    );
    assert.ok(
      stdout.includes("2026-03-30T14:22:00Z"),
      `Expected syncedAt timestamp in output, got: ${stdout}`,
    );
  });
});

test("status reports schema drifted when local hash differs from stored state", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Hello\n---\n\nBody content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body content\n",
      draftRevision: 5,
      publishedVersion: 3,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/hello-world.en.md",
        format: "md",
        draftRevision: 5,
        publishedVersion: 3,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/hello-world.en.md", fileContent);

    await writeSchemaState(cwd, {
      schemaHash: "stale-hash",
      syncedAt: "2026-03-29T10:00:00Z",
      serverUrl: "http://localhost:4000",
    });

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: schemaAwareLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("Local schema differs"),
      `Expected "Local schema differs" in output, got: ${stdout}`,
    );
  });
});

test("status reports no synced schema when state file is missing", async () => {
  await withTempDir(async (cwd) => {
    const fileContent = "---\ntitle: Hello\n---\n\nBody content\n";
    const fileHash = hashContent(fileContent);

    const serverDoc: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body content\n",
      draftRevision: 5,
      publishedVersion: 3,
    };

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/hello-world.en.md",
        format: "md",
        draftRevision: 5,
        publishedVersion: 3,
        hash: fileHash,
      },
    });

    await writeLocalFile(cwd, "content/blog/hello-world.en.md", fileContent);

    let stdout = "";

    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [serverDoc] }),
      loadConfig: schemaAwareLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(
      stdout.includes("No synced schema found"),
      `Expected "No synced schema found" in output, got: ${stdout}`,
    );
  });
});

test("status works with no manifest (never pulled)", async () => {
  await withTempDir(async (cwd) => {
    const document: RemoteDocument = {
      documentId: "doc-1",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: { title: "Hello" },
      body: "Body\n",
      draftRevision: 1,
      publishedVersion: null,
    };

    const output: string[] = [];
    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () => createContentListResponse({ rows: [document] }),
      confirm: async () => true,
      loadConfig: async () => ({
        config: {
          serverUrl: "http://localhost:4000",
          project: "marketing-site",
          environment: "staging",
          types: [{ name: "BlogPost", localized: true }],
        },
        configPath: join(cwd, "mdcms.config.ts"),
      }),
      stdout: {
        write: (chunk: string) => {
          output.push(chunk);
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    const text = output.join("");
    assert.equal(text.includes("New on server"), true);
  });
});

test("status reports a .md to .mdx rename as a local change of the same document", async () => {
  await withTempDir(async (cwd) => {
    const content = "---\ntitle: Hello\n---\n\nOriginal body\n";

    await writeManifest(cwd, {
      "doc-1": {
        path: "content/blog/about.en.md",
        format: "md",
        draftRevision: 8,
        publishedVersion: null,
        hash: hashContent(content),
      },
    });
    await writeLocalFile(cwd, "content/blog/about.en.mdx", content);

    let stdout = "";
    const exitCode = await runMdcmsCli(["status"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () =>
        createContentListResponse({
          rows: [
            {
              documentId: "doc-1",
              type: "BlogPost",
              locale: "en",
              path: "content/blog/about",
              format: "md",
              frontmatter: { title: "Hello" },
              body: "Original body\n",
              draftRevision: 8,
              publishedVersion: null,
            },
          ],
        }),
      loadConfig: defaultLoadConfig(cwd),
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: { write: () => undefined },
    });

    assert.equal(exitCode, 1);
    assert.ok(stdout.includes("Modified locally"), stdout);
    assert.ok(stdout.includes("content/blog/about.en.mdx"), stdout);
    assert.equal(stdout.includes("Deleted"), false, stdout);
  });
});
