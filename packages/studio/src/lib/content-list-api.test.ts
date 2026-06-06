import assert from "node:assert/strict";

import { RuntimeError } from "@mdcms/shared";
import { test } from "bun:test";

import {
  createStudioContentListApi,
  type StudioContentListApiOptions,
} from "./content-list-api.js";

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | null {
  const headers = init?.headers;

  if (headers instanceof Headers) {
    return headers.get(name);
  }

  if (headers && !Array.isArray(headers)) {
    const value = (headers as Record<string, string>)[name];
    if (typeof value === "string") {
      return value;
    }
  }

  return null;
}

function readJsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    return undefined;
  }

  return JSON.parse(init.body);
}

function createApi(options: StudioContentListApiOptions = {}) {
  return createStudioContentListApi(
    {
      project: "marketing-site",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

const validPaginatedResponse = {
  data: [
    {
      documentId: "doc-1",
      translationGroupId: "tg-1",
      project: "marketing-site",
      environment: "production",
      path: "blog/hello",
      type: "BlogPost",
      locale: "en",
      format: "md",
      isDeleted: false,
      hasUnpublishedChanges: false,
      version: 1,
      publishedVersion: 1,
      draftRevision: 0,
      frontmatter: { title: "Hello" },
      body: "# Hello",
      createdBy: "user-1",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedBy: "user-1",
      updatedAt: "2026-03-20T00:00:00.000Z",
    },
  ],
  pagination: {
    total: 42,
    limit: 1,
    offset: 0,
    hasMore: true,
  },
};

const validBulkResponse = {
  data: {
    action: "publish",
    requested: 2,
    succeeded: 1,
    failed: 1,
    results: [
      {
        documentId: "doc-1",
        status: "succeeded",
        document: validPaginatedResponse.data[0],
      },
      {
        documentId: "doc-missing",
        status: "failed",
        error: {
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
        },
      },
    ],
  },
};

test("list fetches content with project and environment headers", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.list({ limit: 1 });

  assert.equal(calls.length, 1);
  const url = String(calls[0]?.input);
  assert.ok(url.startsWith("http://localhost:4000/api/v1/content"));
  assert.ok(url.includes("limit=1"));
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(result.pagination.total, 42);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.type, "BlogPost");
});

test("list passes type and published filters as query params", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({ type: "BlogPost", published: true, limit: 1 });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("type"), "BlogPost");
  assert.equal(url.searchParams.get("published"), "true");
  assert.equal(url.searchParams.get("limit"), "1");
});

test("list passes draft and hasUnpublishedChanges filters as query params", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({
    type: "BlogPost",
    draft: true,
    hasUnpublishedChanges: true,
    limit: 1,
  });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("type"), "BlogPost");
  assert.equal(url.searchParams.get("draft"), "true");
  assert.equal(url.searchParams.get("hasUnpublishedChanges"), "true");
  assert.equal(url.searchParams.get("limit"), "1");
});

test("list serializes an explicit false draft filter", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({ type: "BlogPost", draft: false, limit: 1 });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("draft"), "false");
});

test("list passes sort and order query params", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({ sort: "updatedAt", order: "desc", limit: 5 });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("sort"), "updatedAt");
  assert.equal(url.searchParams.get("order"), "desc");
  assert.equal(url.searchParams.get("limit"), "5");
});

test("list passes translation-group grouping as a query param", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({
    type: "BlogPost",
    limit: 5,
    groupBy: "translationGroup",
  });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("groupBy"), "translationGroup");
});

test("list returns empty result for malformed response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });

  const result = await api.list();

  assert.deepEqual(result.data, []);
  assert.equal(result.pagination.total, 0);
});

test("list throws RuntimeError on 401", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({ code: "UNAUTHORIZED", message: "Unauthorized" }),
        { status: 401 },
      ),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError && error.statusCode === 401,
  );
});

test("list throws RuntimeError on 403", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          code: "FORBIDDEN_ORIGIN",
          message: "Origin not allowed",
        }),
        { status: 403 },
      ),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError && error.statusCode === 403,
  );
});

test("list throws RuntimeError on 500 with server error code", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "Something broke",
        }),
        { status: 500 },
      ),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.statusCode === 500 &&
      error.code === "INTERNAL_ERROR",
  );
});

test("list defaults to empty query when called with no args", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list();

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.toString(), "");
});

test("list passes q search param when provided", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({ type: "BlogPost", q: "hello world", limit: 10 });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("q"), "hello world");
  assert.equal(url.searchParams.get("type"), "BlogPost");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("list omits q param when not provided", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createApi({
    fetcher: async (input) => {
      calls.push({ input });
      return new Response(JSON.stringify(validPaginatedResponse), {
        status: 200,
      });
    },
  });

  await api.list({ type: "BlogPost" });

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.searchParams.get("q"), null);
});

test("bulkOperation sends scoped JSON request with CSRF and schema hash in cookie auth mode", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const controller = new AbortController();
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });

      if (String(input) === "http://localhost:4000/api/v1/auth/session") {
        assert.equal(init?.method, "GET");
        assert.equal(init?.credentials, "include");

        return new Response(
          JSON.stringify({ data: { csrfToken: "csrf-cookie-token" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      assert.equal(String(input), "http://localhost:4000/api/v1/content/bulk");
      assert.equal(init?.method, "POST");
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.credentials, "include");
      assert.equal(readHeader(init, "x-mdcms-project"), "marketing-site");
      assert.equal(readHeader(init, "x-mdcms-environment"), "production");
      assert.equal(readHeader(init, "content-type"), "application/json");
      assert.equal(readHeader(init, "x-mdcms-csrf-token"), "csrf-cookie-token");
      assert.equal(readHeader(init, "x-mdcms-schema-hash"), "schema-hash-123");
      assert.equal(readHeader(init, "authorization"), null);
      assert.deepEqual(readJsonBody(init), {
        action: "move",
        documentIds: ["doc-1", "doc-2"],
        move: { targetDirectory: "archive/news" },
      });

      return new Response(
        JSON.stringify({
          data: {
            ...validBulkResponse.data,
            action: "move",
            requested: 2,
            succeeded: 2,
            failed: 0,
            results: [
              {
                documentId: "doc-1",
                status: "succeeded",
                document: validPaginatedResponse.data[0],
              },
              {
                documentId: "doc-2",
                status: "succeeded",
                document: {
                  ...validPaginatedResponse.data[0],
                  documentId: "doc-2",
                  path: "archive/news/second",
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await api.bulkOperation({
    action: "move",
    documentIds: ["doc-1", "doc-2"],
    move: { targetDirectory: "archive/news" },
    schemaHash: "schema-hash-123",
    signal: controller.signal,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.action, "move");
  assert.equal(result.requested, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 2);
});

test("bulkOperation uses Authorization and omits CSRF bootstrap in token auth mode", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });

      assert.equal(String(input), "http://localhost:4000/api/v1/content/bulk");
      assert.equal(init?.method, "POST");
      assert.equal(readHeader(init, "authorization"), "Bearer mdcms_key_test");
      assert.equal(readHeader(init, "x-mdcms-csrf-token"), null);
      assert.deepEqual(readJsonBody(init), {
        action: "publish",
        documentIds: ["doc-1", "doc-2"],
        changeSummary: "Ready",
        actorId: "user-1",
      });

      return new Response(JSON.stringify(validBulkResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.bulkOperation({
    action: "publish",
    documentIds: ["doc-1", "doc-2"],
    changeSummary: "Ready",
    actorId: "user-1",
  });

  assert.equal(calls.length, 1);
  assert.equal(result.action, "publish");
  assert.equal(result.results[1]?.status, "failed");
});

test("bulkOperation throws RuntimeError when cookie auth session lacks CSRF token", async () => {
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () =>
      api.bulkOperation({
        action: "delete",
        documentIds: ["doc-1"],
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "CONTENT_LIST_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});

test("bulkOperation throws RuntimeError with route payload for non-2xx responses", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          code: "SCHEMA_HASH_MISMATCH",
          message: "Schema hash mismatch.",
          details: { expected: "server-hash" },
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  await assert.rejects(
    () =>
      api.bulkOperation({
        action: "move",
        documentIds: ["doc-1"],
        move: { targetDirectory: "archive" },
        schemaHash: "client-hash",
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "SCHEMA_HASH_MISMATCH" &&
      error.message === "Schema hash mismatch." &&
      error.statusCode === 409,
  );
});

test("bulkOperation throws RuntimeError for invalid success payloads", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          data: {
            action: "publish",
            requested: 1,
            succeeded: 1,
            failed: 0,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      api.bulkOperation({
        action: "publish",
        documentIds: ["doc-1"],
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "CONTENT_LIST_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});

test("bulkOperation throws RuntimeError for succeeded results with invalid documents", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({
          data: {
            action: "publish",
            requested: 1,
            succeeded: 1,
            failed: 0,
            results: [
              {
                documentId: "doc-1",
                status: "succeeded",
                document: {},
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      api.bulkOperation({
        action: "publish",
        documentIds: ["doc-1"],
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "CONTENT_LIST_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});
