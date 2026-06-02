import assert from "node:assert/strict";

import { RuntimeError } from "@mdcms/shared";
import { test } from "bun:test";

import {
  createStudioDocumentRouteApi,
  type StudioDocumentRouteApiOptions,
} from "./document-route-api.js";

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

function createDocumentRouteApi(options: StudioDocumentRouteApiOptions = {}) {
  return createStudioDocumentRouteApi(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

test("loadStudioDocumentDraft fetches draft content with scoped headers", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    fetcher: async (input, init) => {
      calls.push({ input, init });

      return new Response(
        JSON.stringify({
          data: {
            documentId: "11111111-1111-4111-8111-111111111111",
            translationGroupId: "22222222-2222-4222-8222-222222222222",
            project: "marketing-site",
            environment: "staging",
            type: "BlogPost",
            locale: "en",
            path: "blog/launch-notes",
            format: "md",
            isDeleted: false,
            hasUnpublishedChanges: true,
            version: 5,
            publishedVersion: 5,
            draftRevision: 12,
            frontmatter: {},
            body: "# Launch Notes",
            createdBy: "44444444-4444-4444-8444-444444444444",
            createdAt: "2026-03-04T09:00:00.000Z",
            updatedBy: "44444444-4444-4444-8444-444444444444",
            updatedAt: "2026-03-04T10:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await api.loadDraft({
    type: "BlogPost",
    documentId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
  });

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/content/11111111-1111-4111-8111-111111111111?draft=true",
  );
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "staging");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-locale"), "en");
  assert.equal(result.path, "blog/launch-notes");
});

test("cookie-authenticated mutations bootstrap CSRF from auth/session", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });

      if (String(input) === "http://localhost:4000/api/v1/auth/session") {
        assert.equal(init?.method, "GET");
        assert.equal(init?.credentials, "include");

        return new Response(
          JSON.stringify({
            data: {
              csrfToken: "csrf-cookie-token",
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

      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-4111-8111-111111111111",
      );
      assert.equal(readHeader(init, "x-mdcms-csrf-token"), "csrf-cookie-token");
      assert.equal(readHeader(init, "x-mdcms-schema-hash"), "schema-hash-123");
      assert.equal(readHeader(init, "authorization"), null);
      assert.deepEqual(readJsonBody(init), {
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: {},
        body: "# Updated",
      });

      return new Response(
        JSON.stringify({
          data: {
            documentId: "11111111-1111-4111-8111-111111111111",
            translationGroupId: "22222222-2222-4222-8222-222222222222",
            project: "marketing-site",
            environment: "staging",
            type: "BlogPost",
            locale: "en",
            path: "blog/launch-notes",
            format: "md",
            isDeleted: false,
            hasUnpublishedChanges: true,
            version: 5,
            publishedVersion: 5,
            draftRevision: 13,
            frontmatter: {},
            body: "# Updated",
            createdBy: "44444444-4444-4444-8444-444444444444",
            createdAt: "2026-03-04T09:00:00.000Z",
            updatedBy: "44444444-4444-4444-8444-444444444444",
            updatedAt: "2026-03-05T10:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await api.updateDraft({
    documentId: "11111111-1111-4111-8111-111111111111",
    schemaHash: "schema-hash-123",
    payload: {
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "# Updated",
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.body, "# Updated");
});

test("token-authenticated mutations do not bootstrap CSRF", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });

      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-4111-8111-111111111111/publish",
      );
      assert.equal(readHeader(init, "authorization"), "Bearer mdcms_key_test");
      assert.equal(readHeader(init, "x-mdcms-csrf-token"), null);

      return new Response(
        JSON.stringify({
          data: {
            documentId: "11111111-1111-4111-8111-111111111111",
            translationGroupId: "22222222-2222-4222-8222-222222222222",
            project: "marketing-site",
            environment: "staging",
            type: "BlogPost",
            locale: "en",
            path: "blog/launch-notes",
            format: "md",
            isDeleted: false,
            hasUnpublishedChanges: false,
            version: 6,
            publishedVersion: 6,
            draftRevision: 13,
            frontmatter: {},
            body: "# Published",
            createdBy: "44444444-4444-4444-8444-444444444444",
            createdAt: "2026-03-04T09:00:00.000Z",
            updatedBy: "44444444-4444-4444-8444-444444444444",
            updatedAt: "2026-03-06T10:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await api.publish({
    documentId: "11111111-1111-4111-8111-111111111111",
    changeSummary: "Polished introduction",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(readJsonBody(calls[0]?.init), {
    changeSummary: "Polished introduction",
  });
  assert.equal(result.body, "# Published");
});

test("createPreviewToken posts the resolved preview URL with scoped headers and CSRF", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });

      if (String(input) === "http://localhost:4000/api/v1/auth/session") {
        return new Response(
          JSON.stringify({
            data: {
              csrfToken: "csrf-cookie-token",
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

      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-4111-8111-111111111111/preview-token",
      );
      assert.equal(init?.method, "POST");
      assert.equal(readHeader(init, "x-mdcms-csrf-token"), "csrf-cookie-token");
      assert.equal(readHeader(init, "x-mdcms-project"), "marketing-site");
      assert.equal(readHeader(init, "x-mdcms-environment"), "staging");
      assert.deepEqual(readJsonBody(init), {
        previewUrl: "/preview/blog/launch-notes?preview=true",
      });

      return new Response(
        JSON.stringify({
          data: {
            token: "preview.jwt",
            expiresAt: "2026-06-02T10:05:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await api.createPreviewToken({
    documentId: "11111111-1111-4111-8111-111111111111",
    previewUrl: "/preview/blog/launch-notes?preview=true",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(result, {
    token: "preview.jwt",
    expiresAt: "2026-06-02T10:05:00.000Z",
  });
});

test("cookie-authenticated mutations preserve a path-prefixed studio serverUrl", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createStudioDocumentRouteApi(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000/review-api/editor",
    },
    {
      auth: { mode: "cookie" },
      fetcher: async (input, init) => {
        calls.push({ input, init });

        if (
          String(input) ===
          "http://localhost:4000/review-api/editor/api/v1/auth/session"
        ) {
          return new Response(
            JSON.stringify({
              data: {
                csrfToken: "csrf-cookie-token",
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

        assert.equal(
          String(input),
          "http://localhost:4000/review-api/editor/api/v1/content/11111111-1111-4111-8111-111111111111",
        );
        assert.equal(
          readHeader(init, "x-mdcms-csrf-token"),
          "csrf-cookie-token",
        );

        return new Response(
          JSON.stringify({
            data: {
              documentId: "11111111-1111-4111-8111-111111111111",
              translationGroupId: "22222222-2222-4222-8222-222222222222",
              project: "marketing-site",
              environment: "staging",
              type: "BlogPost",
              locale: "en",
              path: "blog/launch-notes",
              format: "md",
              isDeleted: false,
              hasUnpublishedChanges: true,
              version: 5,
              publishedVersion: 5,
              draftRevision: 13,
              frontmatter: {},
              body: "# Updated",
              createdBy: "44444444-4444-4444-8444-444444444444",
              createdAt: "2026-03-04T09:00:00.000Z",
              updatedBy: "44444444-4444-4444-8444-444444444444",
              updatedAt: "2026-03-05T10:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    },
  );

  await api.updateDraft({
    documentId: "11111111-1111-4111-8111-111111111111",
    payload: {
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "# Updated",
    },
  });

  assert.deepEqual(
    calls.map((call) => String(call.input)),
    [
      "http://localhost:4000/review-api/editor/api/v1/auth/session",
      "http://localhost:4000/review-api/editor/api/v1/content/11111111-1111-4111-8111-111111111111",
    ],
  );
});

test("version summary helper validates required fields and rejects malformed payloads", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    fetcher: async (input, init) => {
      calls.push({ input, init });

      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            data: [
              {
                documentId: "11111111-1111-4111-8111-111111111111",
                translationGroupId: "22222222-2222-4222-8222-222222222222",
                project: "marketing-site",
                environment: "staging",
                version: 3,
                path: "blog/launch-notes",
                type: "BlogPost",
                locale: "en",
                format: "md",
                publishedAt: "2026-03-06T10:00:00.000Z",
                publishedBy: "33333333-3333-4333-8333-333333333333",
                changeSummary: "Polished introduction",
              },
            ],
            pagination: {
              total: 1,
              limit: 20,
              offset: 0,
              hasMore: false,
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

      return new Response(
        JSON.stringify({
          data: [
            {
              documentId: "11111111-1111-4111-8111-111111111111",
              project: "marketing-site",
              environment: "staging",
              version: 3,
              path: "blog/launch-notes",
              type: "BlogPost",
              locale: "en",
              format: "md",
              publishedAt: "2026-03-06T10:00:00.000Z",
              publishedBy: "33333333-3333-4333-8333-333333333333",
            },
          ],
          pagination: {
            total: 1,
            limit: 20,
            offset: 0,
            hasMore: false,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const summary = await api.listVersions({
    documentId: "11111111-1111-4111-8111-111111111111",
  });

  assert.equal(summary.pagination.total, 1);
  assert.equal(summary.data[0]?.version, 3);
  assert.equal(
    summary.data[0]?.translationGroupId,
    "22222222-2222-4222-8222-222222222222",
  );

  await assert.rejects(
    () =>
      api.listVersions({
        documentId: "11111111-1111-4111-8111-111111111111",
      }),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_ROUTE_RESPONSE_INVALID",
  );
});

const newMethodsConfig = {
  project: "marketing-site",
  environment: "production",
  serverUrl: "http://localhost:4000",
};

const validDocumentResponse = {
  data: {
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
};

function createNewMethodsApi(options: StudioDocumentRouteApiOptions = {}) {
  return createStudioDocumentRouteApi(newMethodsConfig, options);
}

function createMockFetcher(responses: Response[]) {
  let callIndex = 0;
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const fetcher = async (input: any, init?: any) => {
    calls.push({ input, init });
    return responses[callIndex++] ?? new Response(null, { status: 500 });
  };
  return { fetcher, calls };
}

function sessionResponse(csrfToken: string) {
  return new Response(
    JSON.stringify({ data: { csrfToken, email: "test@test.com" } }),
    { status: 200 },
  );
}

test("create sends POST /api/v1/content with payload and CSRF token", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 201 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.create({
    type: "BlogPost",
    path: "blog/new-post",
    locale: "en",
    format: "mdx",
  });

  assert.equal(result.documentId, "doc-1");
  assert.equal(calls.length, 2);
  const createCall = calls[1];
  assert.ok(String(createCall?.input).endsWith("/api/v1/content"));
  assert.equal(createCall?.init?.method, "POST");
  const body = JSON.parse(createCall?.init?.body as string);
  assert.equal(body.type, "BlogPost");
  assert.equal(body.path, "blog/new-post");
});

test("duplicate sends POST /api/v1/content/:documentId/duplicate", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 201 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.duplicate({ documentId: "doc-1" });

  assert.equal(result.documentId, "doc-1");
  assert.equal(calls.length, 2);
  const dupCall = calls[1];
  assert.ok(String(dupCall?.input).includes("/api/v1/content/doc-1/duplicate"));
  assert.equal(dupCall?.init?.method, "POST");
});

test("unpublish sends POST /api/v1/content/:documentId/unpublish", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 200 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.unpublish({ documentId: "doc-1" });

  assert.equal(result.documentId, "doc-1");
  const unpubCall = calls[1];
  assert.ok(
    String(unpubCall?.input).includes("/api/v1/content/doc-1/unpublish"),
  );
  assert.equal(unpubCall?.init?.method, "POST");
});

test("softDelete sends DELETE /api/v1/content/:documentId", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 200 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.softDelete({ documentId: "doc-1" });

  assert.equal(result.documentId, "doc-1");
  const deleteCall = calls[1];
  assert.ok(String(deleteCall?.input).endsWith("/api/v1/content/doc-1"));
  assert.equal(deleteCall?.init?.method, "DELETE");
  assert.equal(readHeader(deleteCall?.init, "x-mdcms-csrf-token"), "csrf-abc");
});

test("create throws RuntimeError on 403", async () => {
  const { fetcher } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify({ code: "FORBIDDEN", message: "Forbidden" }), {
      status: 403,
    }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  await assert.rejects(
    () => api.create({ type: "BlogPost", path: "blog/test" }),
    (error: unknown) =>
      error instanceof RuntimeError && error.statusCode === 403,
  );
});

test("restore sends POST /api/v1/content/:documentId/restore with CSRF token", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 200 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.restore({ documentId: "doc-1" });

  assert.equal(result.documentId, "doc-1");
  const restoreCall = calls[1];
  assert.ok(
    String(restoreCall?.input).endsWith("/api/v1/content/doc-1/restore"),
  );
  assert.equal(restoreCall?.init?.method, "POST");
  assert.equal(readHeader(restoreCall?.init, "x-mdcms-csrf-token"), "csrf-abc");
});

test("restoreVersion sends POST /api/v1/content/:documentId/versions/:version/restore", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 200 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  const result = await api.restoreVersion({ documentId: "doc-1", version: 3 });

  assert.equal(result.documentId, "doc-1");
  const restoreCall = calls[1];
  assert.ok(
    String(restoreCall?.input).endsWith(
      "/api/v1/content/doc-1/versions/3/restore",
    ),
  );
  assert.equal(restoreCall?.init?.method, "POST");
  assert.equal(readHeader(restoreCall?.init, "x-mdcms-csrf-token"), "csrf-abc");
  // Default body is empty — server defaults targetStatus to "draft", so the
  // client deliberately sends no targetStatus when the caller doesn't
  // override (avoids accidentally re-publishing under content:write).
  const body = restoreCall?.init?.body;
  assert.ok(typeof body === "string");
  assert.deepEqual(JSON.parse(body), {});
});

test("restoreVersion forwards targetStatus + changeSummary when provided", async () => {
  const { fetcher, calls } = createMockFetcher([
    sessionResponse("csrf-abc"),
    new Response(JSON.stringify(validDocumentResponse), { status: 200 }),
  ]);
  const api = createNewMethodsApi({ auth: { mode: "cookie" }, fetcher });

  await api.restoreVersion({
    documentId: "doc-1",
    version: 5,
    targetStatus: "published",
    changeSummary: "rolled back the broken FeatureGrid copy",
  });

  const body = calls[1]?.init?.body;
  assert.ok(typeof body === "string");
  assert.deepEqual(JSON.parse(body), {
    targetStatus: "published",
    changeSummary: "rolled back the broken FeatureGrid copy",
  });
});

test("version detail helper validates required fields and rejects malformed payloads", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createDocumentRouteApi({
    fetcher: async (input, init) => {
      calls.push({ input, init });

      if (String(input).includes("/versions/2")) {
        return new Response(
          JSON.stringify({
            data: {
              documentId: "11111111-1111-4111-8111-111111111111",
              translationGroupId: "22222222-2222-4222-8222-222222222222",
              project: "marketing-site",
              environment: "staging",
              version: 2,
              path: "blog/launch-notes",
              type: "BlogPost",
              locale: "en",
              format: "md",
              publishedAt: "2026-03-05T10:00:00.000Z",
              publishedBy: "33333333-3333-4333-8333-333333333333",
              frontmatter: {},
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

      return new Response(
        JSON.stringify({
          data: {
            documentId: "11111111-1111-4111-8111-111111111111",
            translationGroupId: "22222222-2222-4222-8222-222222222222",
            project: "marketing-site",
            environment: "staging",
            version: 3,
            path: "blog/launch-notes",
            type: "BlogPost",
            locale: "en",
            format: "md",
            publishedAt: "2026-03-06T10:00:00.000Z",
            publishedBy: "33333333-3333-4333-8333-333333333333",
            frontmatter: {},
            body: "# Published",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const version = await api.getVersion({
    documentId: "11111111-1111-4111-8111-111111111111",
    version: 3,
  });

  assert.equal(version.version, 3);
  assert.equal(version.body, "# Published");

  await assert.rejects(
    () =>
      api.getVersion({
        documentId: "11111111-1111-4111-8111-111111111111",
        version: 2,
      }),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_ROUTE_RESPONSE_INVALID",
  );
});
