import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import type { ContentDocumentResponse } from "@mdcms/shared";

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
  limit?: number;
  offset?: number;
  total?: number;
}): Response {
  return new Response(
    JSON.stringify({
      data: input.rows,
      pagination: {
        hasMore: input.hasMore ?? false,
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
        total: input.total ?? input.rows.length,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-pull-"));

  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("pull defaults to prompt-and-apply using draft reads", async () => {
  await withTempDir(async (cwd) => {
    let requests = 0;
    const document: RemoteDocument = {
      documentId: "11111111-1111-1111-1111-111111111111",
      type: "BlogPost",
      locale: "en",
      path: "content/blog/hello-world",
      format: "md",
      frontmatter: {
        title: "Hello World",
        slug: "hello-world",
      },
      body: "Hello draft content",
      draftRevision: 2,
      publishedVersion: 1,
    };
    const exitCode = await runMdcmsCli(["pull"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input) => {
        requests += 1;
        const url = String(input);
        assert.equal(url.includes("draft=true"), true);
        assert.equal(url.includes("fileFields=raw"), true);
        return createContentListResponse({ rows: [document] });
      },
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
        write: () => undefined,
      },
      stderr: {
        write: () => undefined,
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(requests, 1);
    const localPath = join(cwd, "content/blog/hello-world.en.md");
    assert.equal(existsSync(localPath), true);
    const localContent = await readFile(localPath, "utf8");
    assert.equal(localContent.includes("Hello draft content"), true);
    assert.equal(localContent.includes("draftRevision"), false);
    assert.equal(localContent.includes("publishedVersion"), false);
    assert.equal(localContent.includes("documentId"), false);

    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    assert.equal(existsSync(manifestPath), true);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      { path: string }
    >;
    assert.equal(
      manifest["11111111-1111-1111-1111-111111111111"]?.path,
      "content/blog/hello-world.en.md",
    );
  });
});

test("pull --published fetches published snapshots", async () => {
  await withTempDir(async (cwd) => {
    const exitCode = await runMdcmsCli(["pull", "--published", "--dry-run"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input) => {
        const url = String(input);
        assert.equal(url.includes("draft=false"), true);
        assert.equal(url.includes("fileFields=raw"), true);
        return createContentListResponse({
          rows: [],
        });
      },
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
        write: () => undefined,
      },
      stderr: {
        write: () => undefined,
      },
    });

    assert.equal(exitCode, 0);
  });
});

test("pull preserves raw schema file field ids in local frontmatter", async () => {
  await withTempDir(async (cwd) => {
    const exitCode = await runMdcmsCli(["pull"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async (input) => {
        assert.equal(String(input).includes("fileFields=raw"), true);
        return createContentListResponse({
          rows: [
            {
              documentId: "22222222-2222-2222-2222-222222222222",
              type: "BlogPost",
              locale: "en",
              path: "content/blog/with-image",
              format: "md",
              frontmatter: {
                title: "With Image",
                primaryImage: "07ebb057-eeab-4849-94e4-2162cb921c8e",
              },
              body: "Image body",
              draftRevision: 1,
              publishedVersion: null,
            },
          ],
        });
      },
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
        write: () => undefined,
      },
      stderr: {
        write: () => undefined,
      },
    });

    assert.equal(exitCode, 0);
    const localContent = await readFile(
      join(cwd, "content/blog/with-image.en.md"),
      "utf8",
    );
    assert.equal(
      localContent.includes(
        "primaryImage: 07ebb057-eeab-4849-94e4-2162cb921c8e",
      ),
      true,
    );
  });
});

test("pull handles move/rename and deleted-on-server cleanup", async () => {
  await withTempDir(async (cwd) => {
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "marketing-site.staging.json",
    );
    await mkdir(join(cwd, ".mdcms", "manifests"), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          "doc-1": {
            path: "content/blog/old-path.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: 1,
            hash: "oldhash",
          },
          "doc-2": {
            path: "content/blog/delete-me.en.md",
            format: "md",
            draftRevision: 1,
            publishedVersion: 1,
            hash: "oldhash",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(join(cwd, "content/blog"), { recursive: true });
    await writeFile(join(cwd, "content/blog/old-path.en.md"), "old\n", "utf8");
    await writeFile(join(cwd, "content/blog/delete-me.en.md"), "old\n", "utf8");

    const exitCode = await runMdcmsCli(["pull", "--force"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () =>
        createContentListResponse({
          rows: [
            {
              documentId: "doc-1",
              type: "BlogPost",
              locale: "en",
              path: "content/blog/new-path",
              format: "md",
              frontmatter: { title: "New Path" },
              body: "new",
              draftRevision: 2,
              publishedVersion: 1,
            },
          ],
        }),
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
        write: () => undefined,
      },
      stderr: {
        write: () => undefined,
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(existsSync(join(cwd, "content/blog/old-path.en.md")), false);
    assert.equal(existsSync(join(cwd, "content/blog/delete-me.en.md")), false);
    assert.equal(existsSync(join(cwd, "content/blog/new-path.en.md")), true);
  });
});

test("pull gracefully skips documents with unknown types", async () => {
  await withTempDir(async (cwd) => {
    let stderr = "";
    let stdout = "";
    const exitCode = await runMdcmsCli(["pull", "--dry-run"], {
      cwd,
      env: {} as NodeJS.ProcessEnv,
      fetcher: async () =>
        createContentListResponse({
          rows: [
            {
              documentId: "doc-1",
              type: "MissingType",
              locale: "en",
              path: "content/blog/new-path",
              format: "md",
              frontmatter: {},
              body: "new",
              draftRevision: 1,
              publishedVersion: null,
            },
          ],
        }),
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
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(
      stderr.includes('Skipping 1 document(s) of type "MissingType"'),
      true,
    );
    assert.equal(stdout.includes("Skipped (unknown type)"), true);
  });
});
