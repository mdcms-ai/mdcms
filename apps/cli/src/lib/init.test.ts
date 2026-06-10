import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CredentialStore } from "./credentials.js";
import { runMdcmsCli } from "./framework.js";
import { createInitCommand, parseInitOptions } from "./init.js";
import { createMockPrompter } from "./init/prompt.js";

function createInMemoryCredentialStore(): CredentialStore {
  const profiles = new Map<string, unknown>();
  const key = (t: {
    serverUrl: string;
    project: string;
    environment: string;
  }) => `${t.serverUrl}|${t.project}|${t.environment}`;
  return {
    async getProfile(tuple) {
      return profiles.get(key(tuple)) as never;
    },
    async setProfile(tuple, profile) {
      profiles.set(key(tuple), profile);
    },
    async deleteProfile(tuple) {
      return profiles.delete(key(tuple));
    },
  };
}

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-init-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function createMockFetcher(
  handlers: Record<
    string,
    (url: string, init?: RequestInit) => Response | Promise<Response>
  >,
): typeof fetch {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);

    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

function createDefaultFetchHandlers() {
  return {
    "/healthz": () =>
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    "/api/v1/projects": (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        return new Response(
          JSON.stringify({
            data: {
              id: "proj-001",
              slug: body.name,
              name: body.name,
              environments: [{ id: "env-001", name: "production" }],
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/environments")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "env-001", name: "production" },
              { id: "env-002", name: "staging" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "proj-001",
              slug: "my-project",
              name: "my-project",
              environmentCount: 2,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    "/api/v1/schema": () =>
      new Response(
        JSON.stringify({
          data: {
            schemaHash:
              "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
            syncedAt: "2026-03-31T12:00:00.000Z",
            affectedTypes: ["post"],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    "/api/v1/content": () =>
      new Response(
        JSON.stringify({
          data: {
            documentId: "doc-hello-001",
            draftRevision: 1,
            publishedVersion: null,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  };
}

test("full init wizard creates config, schema state, and manifest", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello World\nslug: hello\n---\nBody content\n",
    );

    const fetcher = createMockFetcher(createDefaultFetchHandlers());

    const prompter = createMockPrompter({
      text: ["http://localhost:4000", "my-project", "staging"],
      select: [],
      multiSelect: [["content/posts"]],
      confirm: [true, true, false],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);

    const configPath = join(cwd, "mdcms.config.ts");
    assert.ok(existsSync(configPath), "mdcms.config.ts should exist");
    const configContent = await readFile(configPath, "utf-8");
    assert.ok(
      configContent.includes("my-project"),
      "config should contain project",
    );
    assert.ok(
      configContent.includes("http://localhost:4000"),
      "config should contain serverUrl",
    );
    assert.ok(
      configContent.includes("defineType"),
      "config should contain defineType",
    );

    const schemaStatePath = join(
      cwd,
      ".mdcms",
      "schema",
      "my-project.staging.json",
    );
    assert.ok(existsSync(schemaStatePath), "schema state file should exist");
    const schemaState = JSON.parse(await readFile(schemaStatePath, "utf-8"));
    assert.equal(typeof schemaState.schemaHash, "string");
    assert.equal(schemaState.syncedAt, "2026-03-31T12:00:00.000Z");

    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "my-project.staging.json",
    );
    assert.ok(existsSync(manifestPath), "manifest file should exist");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.ok(
      manifest["doc-hello-001"],
      "manifest should contain document entry",
    );
    assert.equal(manifest["doc-hello-001"].format, "md");
    assert.equal(manifest["doc-hello-001"].draftRevision, 1);
  });
});

test("init schema sync preserves reference metadata for inferred reference fields", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await mkdir(join(cwd, "content", "authors"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello World\nauthor: jane-doe\n---\nBody content\n",
    );
    await writeFile(
      join(cwd, "content", "authors", "jane.md"),
      "---\nname: Jane Doe\n---\n",
    );

    let schemaRequestBody:
      | {
          resolvedSchema?: Record<string, { fields?: Record<string, unknown> }>;
          schemaHash?: string;
        }
      | undefined;

    const fetcher = createMockFetcher({
      ...createDefaultFetchHandlers(),
      "/api/v1/schema": (_url: string, init?: RequestInit) => {
        schemaRequestBody = JSON.parse(
          String(init?.body),
        ) as typeof schemaRequestBody;

        return new Response(
          JSON.stringify({
            data: {
              schemaHash: schemaRequestBody?.schemaHash,
              syncedAt: "2026-03-31T12:00:00.000Z",
              affectedTypes: ["author", "post"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({
      text: ["http://localhost:4000", "my-project", "staging"],
      select: [],
      multiSelect: [["content/posts", "content/authors"]],
      confirm: [true],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init", "--no-import"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(schemaRequestBody?.resolvedSchema?.post?.fields?.author, {
      kind: "string",
      required: true,
      nullable: false,
      reference: {
        targetType: "author",
      },
    });
  });
});

test("init imports localized suffix files into one translation group", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "campaigns"), { recursive: true });
    await writeFile(
      join(cwd, "content", "campaigns", "summer-sale.en.md"),
      "---\ntitle: Summer sale\nslug: summer-sale\n---\nEnglish body\n",
    );
    await writeFile(
      join(cwd, "content", "campaigns", "summer-sale.fr.md"),
      "---\ntitle: Vente d'été\nslug: summer-sale\n---\nFrench body\n",
    );

    const createPayloads: Array<Record<string, unknown>> = [];
    let contentCreateCount = 0;

    const fetcher = createMockFetcher({
      "/healthz": () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      "/api/v1/projects": (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          return new Response(
            JSON.stringify({
              data: {
                id: "proj-001",
                slug: body.name,
                name: body.name,
                environments: [{ id: "env-001", name: "production" }],
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/environments")) {
          return new Response(
            JSON.stringify({
              data: [{ id: "env-002", name: "staging" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
      "/api/v1/schema": () =>
        new Response(
          JSON.stringify({
            data: {
              schemaHash:
                "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
              syncedAt: "2026-03-31T12:00:00.000Z",
              affectedTypes: ["campaign"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/v1/content": (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createPayloads.push(body);
        contentCreateCount += 1;

        return new Response(
          JSON.stringify({
            data: {
              documentId: `doc-${contentCreateCount}`,
              draftRevision: 1,
              publishedVersion: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({
      text: ["http://localhost:4000", "marketing-demo", "staging"],
      select: [],
      multiSelect: [["content/campaigns"]],
      confirm: [true, true, true],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);
    assert.equal(createPayloads.length, 2);
    assert.deepEqual(
      createPayloads.map((payload) => payload.path),
      ["content/campaigns/summer-sale", "content/campaigns/summer-sale"],
    );
    assert.deepEqual(
      createPayloads.map((payload) => payload.locale),
      ["en", "fr"],
    );
    assert.equal(createPayloads[0]!.sourceDocumentId, undefined);
    assert.equal(createPayloads[1]!.sourceDocumentId, "doc-1");
  });
});

test("init strips locale suffixes from import paths even when locale comes from frontmatter", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "campaigns"), { recursive: true });
    await writeFile(
      join(cwd, "content", "campaigns", "launch.en.mdx"),
      [
        "---",
        "title: Spring launch",
        "slug: launch",
        "locale: en",
        "---",
        "",
        "English body",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "content", "campaigns", "launch.fr.mdx"),
      [
        "---",
        "title: Lancement de printemps",
        "slug: launch",
        "locale: fr",
        "---",
        "",
        "French body",
        "",
      ].join("\n"),
    );

    const createPayloads: Array<Record<string, unknown>> = [];
    let contentCreateCount = 0;

    const fetcher = createMockFetcher({
      "/healthz": () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      "/api/v1/projects": (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          return new Response(
            JSON.stringify({
              data: {
                id: "proj-001",
                slug: body.name,
                name: body.name,
                environments: [{ id: "env-001", name: "production" }],
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/environments")) {
          return new Response(
            JSON.stringify({
              data: [{ id: "env-002", name: "staging" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
      "/api/v1/schema": () =>
        new Response(
          JSON.stringify({
            data: {
              schemaHash:
                "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
              syncedAt: "2026-03-31T12:00:00.000Z",
              affectedTypes: ["campaign"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/v1/content": (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createPayloads.push(body);
        contentCreateCount += 1;

        return new Response(
          JSON.stringify({
            data: {
              documentId: `doc-${contentCreateCount}`,
              draftRevision: 1,
              publishedVersion: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({
      text: ["http://localhost:4000", "marketing-demo", "staging"],
      select: [],
      multiSelect: [["content/campaigns"]],
      confirm: [true, true, true],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);
    assert.equal(createPayloads.length, 2);
    assert.deepEqual(
      createPayloads.map((payload) => payload.path),
      ["content/campaigns/launch", "content/campaigns/launch"],
    );
    assert.deepEqual(
      createPayloads.map((payload) => payload.locale),
      ["en", "fr"],
    );
    assert.equal(createPayloads[0]!.sourceDocumentId, undefined);
    assert.equal(createPayloads[1]!.sourceDocumentId, "doc-1");
  });
});

test("init preserves non-locale directory segments that resemble locale tags", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "campaigns", "us"), {
      recursive: true,
    });
    await writeFile(
      join(cwd, "content", "campaigns", "us", "launch.en.mdx"),
      [
        "---",
        "title: Spring launch",
        "slug: launch",
        "locale: en",
        "---",
        "",
        "English body",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(cwd, "content", "campaigns", "us", "launch.fr.mdx"),
      [
        "---",
        "title: Lancement de printemps",
        "slug: launch",
        "locale: fr",
        "---",
        "",
        "French body",
        "",
      ].join("\n"),
    );

    const createPayloads: Array<Record<string, unknown>> = [];
    let contentCreateCount = 0;

    const fetcher = createMockFetcher({
      "/healthz": () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      "/api/v1/projects": (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          return new Response(
            JSON.stringify({
              data: {
                id: "proj-001",
                slug: body.name,
                name: body.name,
                environments: [{ id: "env-001", name: "production" }],
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/environments")) {
          return new Response(
            JSON.stringify({
              data: [{ id: "env-002", name: "staging" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Not Found", { status: 404 });
      },
      "/api/v1/schema": () =>
        new Response(
          JSON.stringify({
            data: {
              schemaHash:
                "abc123def456abc123def456abc123def456abc123def456abc123def456abcd",
              syncedAt: "2026-03-31T12:00:00.000Z",
              affectedTypes: ["campaign"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      "/api/v1/content": (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createPayloads.push(body);
        contentCreateCount += 1;

        return new Response(
          JSON.stringify({
            data: {
              documentId: `doc-${contentCreateCount}`,
              draftRevision: 1,
              publishedVersion: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({
      text: ["http://localhost:4000", "marketing-demo", "staging"],
      select: [],
      multiSelect: [["content/campaigns"]],
      confirm: [true, true, true],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);
    assert.equal(createPayloads.length, 2);
    assert.deepEqual(
      createPayloads.map((payload) => payload.path),
      ["content/campaigns/us/launch", "content/campaigns/us/launch"],
    );
    assert.deepEqual(
      createPayloads.map((payload) => payload.locale),
      ["en", "fr"],
    );
    assert.equal(createPayloads[0]!.sourceDocumentId, undefined);
    assert.equal(createPayloads[1]!.sourceDocumentId, "doc-1");
  });
});

test("init fails when server unreachable", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher({
      "/healthz": () => new Response("Service Unavailable", { status: 503 }),
    });

    const prompter = createMockPrompter({
      text: ["http://localhost:4000"],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 1);
  });
});

test("init with no content files still generates config", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher({
      ...createDefaultFetchHandlers(),
      "/api/v1/schema": (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { schemaHash: string };
        return new Response(
          JSON.stringify({
            data: {
              schemaHash: body.schemaHash,
              syncedAt: "2026-03-31T12:00:00.000Z",
              affectedTypes: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({
      text: [
        "http://localhost:4000",
        "my-project",
        "production",
        "content/posts",
      ],
      select: [],
      multiSelect: [],
      confirm: [],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);

    const configPath = join(cwd, "mdcms.config.ts");
    assert.ok(existsSync(configPath), "mdcms.config.ts should exist");
    const configContent = await readFile(configPath, "utf-8");
    assert.ok(
      configContent.includes("my-project"),
      "config should contain project",
    );
  });
});

test("init creates new project and generates config", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher({
      ...createDefaultFetchHandlers(),
      "/api/v1/projects": (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          return new Response(
            JSON.stringify({
              data: {
                id: "proj-new",
                slug: body.name,
                name: body.name,
                environments: [{ id: "env-001", name: "production" }],
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/environments")) {
          return new Response(
            JSON.stringify({
              data: [{ id: "env-001", name: "production" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const prompter = createMockPrompter({
      text: [
        "http://localhost:4000",
        "new-project",
        "production",
        "content/posts",
      ],
      select: [],
      multiSelect: [],
      confirm: [],
    });

    const command = createInitCommand({
      prompter,
      fetcher,
      skipAuth: true,
    });

    const exitCode = await runMdcmsCli(["init"], {
      cwd,
      commands: [command],
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      fetcher,
    });

    assert.equal(exitCode, 0);

    const configPath = join(cwd, "mdcms.config.ts");
    assert.ok(existsSync(configPath), "mdcms.config.ts should exist");
    const configContent = await readFile(configPath, "utf-8");
    assert.ok(
      configContent.includes("new-project"),
      "config should contain new project name",
    );
  });
});

test("parseInitOptions parses all recognized flags", () => {
  const opts = parseInitOptions([
    "--non-interactive",
    "--directory",
    "content/posts",
    "--directory",
    "content/pages",
    "--default-locale",
    "en",
    "--no-import",
    "--no-git-cleanup",
    "--no-example-post",
  ]);

  assert.equal(opts.nonInteractive, true);
  assert.deepEqual(opts.directories, ["content/posts", "content/pages"]);
  assert.equal(opts.defaultLocale, "en");
  assert.equal(opts.noImport, true);
  assert.equal(opts.noGitCleanup, true);
  assert.equal(opts.noExamplePost, true);
  assert.equal(opts.help, false);
});

test("parseInitOptions treats -y and --yes as --non-interactive", () => {
  assert.equal(parseInitOptions(["-y"]).nonInteractive, true);
  assert.equal(parseInitOptions(["--yes"]).nonInteractive, true);
  assert.equal(parseInitOptions(["--non-interactive"]).nonInteractive, true);
});

test("parseInitOptions parses --directories csv and inline =value forms", () => {
  const viaCsv = parseInitOptions([
    "--directories",
    "content/posts,content/pages",
  ]);
  assert.deepEqual(viaCsv.directories, ["content/posts", "content/pages"]);

  const viaInline = parseInitOptions([
    "--directories=content/posts, content/pages",
    "--default-locale=fr",
  ]);
  assert.deepEqual(viaInline.directories, ["content/posts", "content/pages"]);
  assert.equal(viaInline.defaultLocale, "fr");
});

test("parseInitOptions throws on unknown flag", () => {
  assert.throws(() => parseInitOptions(["--not-a-real-flag"]), /Unknown flag/);
});

test("parseInitOptions throws when flag value is missing", () => {
  assert.throws(() => parseInitOptions(["--directory"]), /requires a value/);
});

test("parseInitOptions rejects empty inline flag values", () => {
  assert.throws(() => parseInitOptions(["--directory="]), /requires a value/);
  assert.throws(() => parseInitOptions(["--directories="]), /requires a value/);
  assert.throws(
    () => parseInitOptions(["--default-locale="]),
    /requires a value/,
  );
});

test("init --non-interactive completes without prompting", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello\nslug: hello\n---\nBody\n",
    );

    const fetcher = createMockFetcher(createDefaultFetchHandlers());

    // Empty queues — any prompter call throws and fails the test.
    const prompter = createMockPrompter({});

    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    const exitCode = await runMdcmsCli(
      ["init", "--non-interactive", "--directory", "content/posts"],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
          MDCMS_API_KEY: "test-api-key",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        fetcher,
      },
    );

    assert.equal(exitCode, 0);
    const configPath = join(cwd, "mdcms.config.ts");
    assert.ok(existsSync(configPath), "mdcms.config.ts should exist");
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "my-project.staging.json",
    );
    assert.ok(existsSync(manifestPath), "manifest should exist");
  });
});

test("init --non-interactive fails loud when project is missing", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher(createDefaultFetchHandlers());
    const prompter = createMockPrompter({});

    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    let stderr = "";
    const exitCode = await runMdcmsCli(["init", "--non-interactive"], {
      cwd,
      commands: [command],
      env: {
        MDCMS_SERVER_URL: "http://localhost:4000",
        MDCMS_API_KEY: "test-api-key",
      },
      resolveStoredApiKey: async () => undefined,
      stdout: { write: () => undefined },
      stderr: {
        write: (c) => {
          stderr += c;
        },
      },
      fetcher,
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Project name/i);
    assert.match(stderr, /--project/);
  });
});

test("init --non-interactive fails loud when api-key is missing", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello\n---\nBody\n",
    );
    const fetcher = createMockFetcher(createDefaultFetchHandlers());
    const prompter = createMockPrompter({});

    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    let stderr = "";
    const exitCode = await runMdcmsCli(
      ["init", "--non-interactive", "--directory", "content/posts"],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: { write: () => undefined },
        stderr: {
          write: (c) => {
            stderr += c;
          },
        },
        fetcher,
      },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /API key/i);
    assert.match(stderr, /--api-key/);
  });
});

test("init --non-interactive --no-import skips content import", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello\n---\nBody\n",
    );

    let contentCallCount = 0;
    const fetcher = createMockFetcher({
      ...createDefaultFetchHandlers(),
      "/api/v1/content": (_url: string) => {
        contentCallCount += 1;
        return new Response(
          JSON.stringify({
            data: {
              documentId: "doc-1",
              draftRevision: 1,
              publishedVersion: null,
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    const prompter = createMockPrompter({});
    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    const exitCode = await runMdcmsCli(
      [
        "init",
        "--non-interactive",
        "--directory",
        "content/posts",
        "--no-import",
      ],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
          MDCMS_API_KEY: "test-api-key",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        fetcher,
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(contentCallCount, 0, "no content POSTs should be made");
    const manifestPath = join(
      cwd,
      ".mdcms",
      "manifests",
      "my-project.staging.json",
    );
    assert.equal(
      existsSync(manifestPath),
      false,
      "manifest should not be written when import is skipped",
    );
  });
});

test("init --non-interactive --no-example-post on empty repo skips example.md", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher(createDefaultFetchHandlers());
    const prompter = createMockPrompter({});
    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    let stdout = "";
    const exitCode = await runMdcmsCli(
      [
        "init",
        "--non-interactive",
        "--directory",
        "content/posts",
        "--no-example-post",
      ],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
          MDCMS_API_KEY: "test-api-key",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: {
          write: (c) => {
            stdout += c;
          },
        },
        stderr: { write: () => undefined },
        fetcher,
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(
      existsSync(join(cwd, "content", "posts", "example.md")),
      false,
      "example.md should not be scaffolded",
    );
    assert.ok(
      existsSync(join(cwd, "mdcms.config.ts")),
      "config should still be written",
    );
    assert.doesNotMatch(
      stdout,
      /Example post created/,
      "outro should not advertise an example.md that was never written",
    );
  });
});

test("init --non-interactive rejects multiple --directory on empty repo", async () => {
  await withTempDir(async (cwd) => {
    const fetcher = createMockFetcher(createDefaultFetchHandlers());
    const prompter = createMockPrompter({});
    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    let stderr = "";
    const exitCode = await runMdcmsCli(
      [
        "init",
        "--non-interactive",
        "--directory",
        "content/posts",
        "--directory",
        "content/pages",
      ],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
          MDCMS_API_KEY: "test-api-key",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: { write: () => undefined },
        stderr: {
          write: (c) => {
            stderr += c;
          },
        },
        fetcher,
      },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /Scaffolding only supports a single starter/i);
  });
});

test("init --non-interactive rejects --directory that doesn't match any found content", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(join(cwd, "content", "posts"), { recursive: true });
    await writeFile(
      join(cwd, "content", "posts", "hello.md"),
      "---\ntitle: Hello\n---\nBody\n",
    );
    const fetcher = createMockFetcher(createDefaultFetchHandlers());
    const prompter = createMockPrompter({});
    const command = createInitCommand({
      prompter,
      fetcher,
      credentialStore: createInMemoryCredentialStore(),
    });

    let stderr = "";
    const exitCode = await runMdcmsCli(
      ["init", "--non-interactive", "--directory", "content/pages"],
      {
        cwd,
        commands: [command],
        env: {
          MDCMS_SERVER_URL: "http://localhost:4000",
          MDCMS_PROJECT: "my-project",
          MDCMS_ENVIRONMENT: "staging",
          MDCMS_API_KEY: "test-api-key",
        },
        resolveStoredApiKey: async () => undefined,
        stdout: { write: () => undefined },
        stderr: {
          write: (c) => {
            stderr += c;
          },
        },
        fetcher,
      },
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /content\/pages/);
  });
});
