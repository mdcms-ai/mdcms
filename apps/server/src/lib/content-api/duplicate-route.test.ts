import assert from "node:assert/strict";

import { test } from "bun:test";

import { mountContentApiRoutes } from "./routes.js";
import { authorizeTestRequest } from "../content-api-test-support.js";
import type {
  ContentDocument,
  ContentRouteApp,
  ContentStore,
} from "./types.js";

type RouteHandler = (ctx: any) => unknown;

const baseDocument: ContentDocument = {
  documentId: "doc-1",
  translationGroupId: "tg-1",
  project: "test-project",
  environment: "staging",
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
  updatedBy: "user-1",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-20T00:00:00.000Z",
};

function createRouteCapture() {
  const routes: Record<string, RouteHandler> = {};
  const app: ContentRouteApp = {
    get: (path, handler) => {
      routes[`GET ${path}`] = handler;
      return app;
    },
    post: (path, handler) => {
      routes[`POST ${path}`] = handler;
      return app;
    },
    put: (path, handler) => {
      routes[`PUT ${path}`] = handler;
      return app;
    },
    delete: (path, handler) => {
      routes[`DELETE ${path}`] = handler;
      return app;
    },
  };
  return { app, routes };
}

function createRequest(
  overrides?: Partial<{ headers: Record<string, string> }>,
) {
  const headers: Record<string, string> = {
    "x-mdcms-project": "test-project",
    "x-mdcms-environment": "staging",
    "x-mdcms-schema-hash": "test-hash",
    ...(overrides?.headers ?? {}),
  };
  return new Request("http://localhost:4000/api/v1/content/doc-1/duplicate", {
    method: "POST",
    headers,
  });
}

function createStore(overrides?: Partial<ContentStore>): ContentStore {
  return {
    getSchema: async () => undefined,
    create: async () => baseDocument,
    list: async () => ({ rows: [], total: 0, limit: 20, offset: 0 }),
    getOverviewCounts: async () => [],
    getById: async () => baseDocument,
    update: async () => baseDocument,
    softDelete: async () => baseDocument,
    restore: async () => baseDocument,
    listVersions: async () => ({ rows: [], total: 0, limit: 20, offset: 0 }),
    getVersion: async () => ({
      ...baseDocument,
      publishedAt: "2026-03-20T00:00:00.000Z",
      publishedBy: "user-1",
    }),
    restoreVersion: async () => baseDocument,
    publish: async () => baseDocument,
    unpublish: async () => baseDocument,
    listVariants: async () => undefined,
    ...overrides,
  };
}

function mountAndGetDuplicateHandler(
  storeOverrides?: Partial<ContentStore>,
): RouteHandler {
  const { app, routes } = createRouteCapture();
  const store = createStore(storeOverrides);
  mountContentApiRoutes(app, {
    store,
    authorize: authorizeTestRequest,
    requireCsrf: async () => {},
    getWriteSchemaSyncState: async () => ({ schemaHash: "test-hash" }),
  });
  const handler = routes["POST /api/v1/content/:documentId/duplicate"];
  assert.ok(handler, "duplicate route must be registered");
  return handler;
}

test("duplicate returns new document on success", async () => {
  const createdDoc = {
    ...baseDocument,
    documentId: "doc-copy",
    path: "blog/hello-copy",
  };
  const handler = mountAndGetDuplicateHandler({
    getById: async () => baseDocument,
    create: async () => createdDoc,
  });

  const result = (await handler({
    request: createRequest(),
    params: { documentId: "doc-1" },
    body: {},
  })) as any;

  assert.equal(result.data.documentId, "doc-copy");
  assert.equal(result.data.path, "blog/hello-copy");
});

test("duplicate returns 404 when source document not found", async () => {
  const handler = mountAndGetDuplicateHandler({
    getById: async () => undefined,
  });

  const result = (await handler({
    request: createRequest(),
    params: { documentId: "missing" },
    body: {},
  })) as any;

  assert.equal(result.status, 404);
});

test("duplicate returns 404 when source document is deleted", async () => {
  const handler = mountAndGetDuplicateHandler({
    getById: async () => ({ ...baseDocument, isDeleted: true }),
  });

  const result = (await handler({
    request: createRequest(),
    params: { documentId: "doc-1" },
    body: {},
  })) as any;

  assert.equal(result.status, 404);
});
