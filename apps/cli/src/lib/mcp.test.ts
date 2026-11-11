import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runMdcmsCli } from "./framework.js";
import { createMcpCommand, createMdcmsMcpServer } from "./mcp.js";
import { writeSchemaState } from "./schema-state.js";

const SERVER_URL = "http://localhost:4000";
const PROJECT = "test-project";
const ENVIRONMENT = "staging";
const SCHEMA_HASH = "hash-local-1";

type RecordedRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
};

type FakeRoute = (request: RecordedRequest) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSchemaResponse(): Response {
  return json({
    data: {
      schemaHash: "hash-server-1",
      syncedAt: "2026-06-01T12:00:00.000Z",
      types: [
        {
          type: "post",
          directory: "content/posts",
          localized: false,
          schemaHash: "hash-server-1",
          syncedAt: "2026-06-01T12:00:00.000Z",
          resolvedSchema: {
            type: "post",
            directory: "content/posts",
            localized: false,
            fields: {
              title: { kind: "string", required: true, nullable: false },
              tags: {
                kind: "array",
                required: false,
                nullable: false,
                item: { kind: "string", required: true, nullable: false },
              },
            },
          },
        },
      ],
    },
  });
}

function createDocument(overrides: Record<string, unknown> = {}) {
  return {
    documentId: "doc-1",
    type: "post",
    path: "content/posts/hello",
    locale: "en",
    format: "md",
    draftRevision: 4,
    publishedVersion: null,
    hasUnpublishedChanges: true,
    updatedAt: "2026-06-01T12:00:00.000Z",
    frontmatter: { title: "Hello", tags: ["a"] },
    body: "Body text",
    ...overrides,
  };
}

async function withHarness(
  run: (harness: {
    client: Client;
    requests: RecordedRequest[];
    cwd: string;
    setRoute: (route: FakeRoute) => void;
  }) => Promise<void>,
  options: { withSchemaState?: boolean } = {},
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mdcms-cli-mcp-"));
  const requests: RecordedRequest[] = [];
  let route: FakeRoute = () => undefined;

  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const recorded: RecordedRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);

    const routed = route(recorded);
    if (routed) {
      return routed;
    }

    if (
      recorded.method === "GET" &&
      recorded.url.pathname === "/api/v1/schema"
    ) {
      return createSchemaResponse();
    }

    return json({ code: "NOT_FOUND", message: "No fake route." }, 404);
  }) as typeof fetch;

  if (options.withSchemaState !== false) {
    await writeSchemaState(
      { cwd, project: PROJECT, environment: ENVIRONMENT },
      {
        schemaHash: SCHEMA_HASH,
        syncedAt: "2026-06-01T12:00:00.000Z",
        serverUrl: SERVER_URL,
      },
    );
  }

  const server = createMdcmsMcpServer({
    serverUrl: SERVER_URL,
    project: PROJECT,
    environment: ENVIRONMENT,
    apiKey: "mdcms_key_test",
    cwd,
    configPath: join(cwd, "mdcms.config.ts"),
    fetcher,
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    await run({
      client,
      requests,
      cwd,
      setRoute: (next) => {
        route = next;
      },
    });
  } finally {
    await client.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
}

function readResult(result: unknown): {
  isError: boolean;
  payload: Record<string, any>;
} {
  const typed = result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };

  return {
    isError: typed.isError === true,
    payload: JSON.parse(typed.content[0]!.text),
  };
}

test("mcp server exposes the preview tool surface", async () => {
  await withHarness(async ({ client }) => {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "create_document",
      "get_document",
      "get_schema",
      "list_documents",
      "publish_document",
      "sync_schema",
      "update_document",
    ]);
  });
});

test("list_documents reads draft heads for the target and omits bodies", async () => {
  await withHarness(async ({ client, requests, setRoute }) => {
    setRoute((request) =>
      request.url.pathname === "/api/v1/content"
        ? json({
            data: [createDocument()],
            pagination: { total: 1, limit: 20, offset: 0 },
          })
        : undefined,
    );

    const { isError, payload } = readResult(
      await client.callTool({
        name: "list_documents",
        arguments: { type: "post", published: false },
      }),
    );

    assert.equal(isError, false);
    assert.equal(payload.documents.length, 1);
    assert.equal(payload.documents[0].documentId, "doc-1");
    assert.deepEqual(payload.documents[0].frontmatter, {
      title: "Hello",
      tags: ["a"],
    });
    assert.equal("body" in payload.documents[0], false);
    assert.deepEqual(payload.pagination, { total: 1, limit: 20, offset: 0 });

    const request = requests[0]!;
    assert.equal(request.url.searchParams.get("draft"), "true");
    assert.equal(request.url.searchParams.get("type"), "post");
    assert.equal(request.url.searchParams.get("published"), "false");
    assert.equal(request.url.searchParams.get("limit"), "20");
    assert.equal(request.headers.get("authorization"), "Bearer mdcms_key_test");
    assert.equal(request.headers.get("x-mdcms-project"), PROJECT);
    assert.equal(request.headers.get("x-mdcms-environment"), ENVIRONMENT);
  });
});

test("update_document merges the frontmatter patch and pins revision and schema hash", async () => {
  await withHarness(async ({ client, requests, setRoute }) => {
    setRoute((request) => {
      if (request.url.pathname !== "/api/v1/content/doc-1") {
        return undefined;
      }

      if (request.method === "GET") {
        return json({ data: createDocument() });
      }

      return json({
        data: createDocument({
          draftRevision: 5,
          frontmatter: (request.body as { frontmatter: unknown }).frontmatter,
        }),
      });
    });

    const { isError, payload } = readResult(
      await client.callTool({
        name: "update_document",
        arguments: {
          documentId: "doc-1",
          frontmatter: { title: "Hello again", tags: null },
        },
      }),
    );

    assert.equal(isError, false);
    assert.equal(payload.updated.draftRevision, 5);

    const put = requests.find((request) => request.method === "PUT")!;
    assert.deepEqual(put.body, {
      frontmatter: { title: "Hello again" },
      draftRevision: 4,
    });
    assert.equal(put.headers.get("x-mdcms-schema-hash"), SCHEMA_HASH);
  });
});

test("update_document rejects frontmatter that violates the schema without writing", async () => {
  await withHarness(async ({ client, requests, setRoute }) => {
    setRoute((request) =>
      request.url.pathname === "/api/v1/content/doc-1" &&
      request.method === "GET"
        ? json({ data: createDocument() })
        : undefined,
    );

    const { isError, payload } = readResult(
      await client.callTool({
        name: "update_document",
        arguments: { documentId: "doc-1", frontmatter: { title: 42 } },
      }),
    );

    assert.equal(isError, true);
    assert.equal(payload.code, "INVALID_FRONTMATTER");
    assert.match(payload.details.errors[0], /title/);
    assert.equal(
      requests.some((request) => request.method === "PUT"),
      false,
    );
  });
});

test("write tools fail with SCHEMA_STATE_MISSING when no local schema state exists", async () => {
  await withHarness(
    async ({ client, requests }) => {
      const { isError, payload } = readResult(
        await client.callTool({
          name: "update_document",
          arguments: { documentId: "doc-1", body: "New body" },
        }),
      );

      assert.equal(isError, true);
      assert.equal(payload.code, "SCHEMA_STATE_MISSING");
      assert.equal(requests.length, 0);
    },
    { withSchemaState: false },
  );
});

test("create_document rejects a path outside the content type directory", async () => {
  await withHarness(async ({ client, requests }) => {
    const { isError, payload } = readResult(
      await client.callTool({
        name: "create_document",
        arguments: {
          type: "post",
          path: "elsewhere/new-post",
          frontmatter: { title: "New" },
          body: "Body",
        },
      }),
    );

    assert.equal(isError, true);
    assert.equal(payload.code, "INVALID_INPUT");
    assert.equal(
      requests.some((request) => request.method === "POST"),
      false,
    );
  });
});

test("create_document posts a draft with the non-localized locale and default format", async () => {
  await withHarness(async ({ client, requests, setRoute }) => {
    setRoute((request) =>
      request.method === "POST" && request.url.pathname === "/api/v1/content"
        ? json({
            data: createDocument({
              documentId: "doc-2",
              path: "content/posts/new-post",
              draftRevision: 1,
              frontmatter: { title: "New" },
            }),
          })
        : undefined,
    );

    const { isError, payload } = readResult(
      await client.callTool({
        name: "create_document",
        arguments: {
          type: "post",
          path: "content/posts/new-post",
          frontmatter: { title: "New" },
          body: "Body",
        },
      }),
    );

    assert.equal(isError, false);
    assert.equal(payload.created.documentId, "doc-2");

    const post = requests.find((request) => request.method === "POST")!;
    assert.deepEqual(post.body, {
      type: "post",
      path: "content/posts/new-post",
      locale: "en",
      format: "md",
      frontmatter: { title: "New" },
      body: "Body",
    });
    assert.equal(post.headers.get("x-mdcms-schema-hash"), SCHEMA_HASH);
  });
});

test("server error envelopes pass through with their original code", async () => {
  await withHarness(async ({ client, setRoute }) => {
    setRoute((request) =>
      request.url.pathname === "/api/v1/content/doc-1/publish"
        ? json(
            {
              status: "error",
              code: "FORBIDDEN",
              message: "Missing required scope content:publish.",
            },
            403,
          )
        : undefined,
    );

    const { isError, payload } = readResult(
      await client.callTool({
        name: "publish_document",
        arguments: { documentId: "doc-1" },
      }),
    );

    assert.equal(isError, true);
    assert.equal(payload.code, "FORBIDDEN");
    assert.equal(payload.message, "Missing required scope content:publish.");
  });
});

test("network failures report SERVER_UNREACHABLE", async () => {
  await withHarness(async ({ client, setRoute }) => {
    setRoute(() => {
      throw new Error("connect ECONNREFUSED");
    });

    const { isError, payload } = readResult(
      await client.callTool({ name: "get_schema", arguments: {} }),
    );

    assert.equal(isError, true);
    assert.equal(payload.code, "SERVER_UNREACHABLE");
  });
});

test("mcp command exits 1 before starting when no API key resolves", async () => {
  let stderr = "";
  let stdout = "";

  const exitCode = await runMdcmsCli(["mcp"], {
    commands: [createMcpCommand()],
    env: {},
    loadConfig: async () => ({
      config: {
        serverUrl: SERVER_URL,
        project: PROJECT,
        environment: ENVIRONMENT,
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
});
