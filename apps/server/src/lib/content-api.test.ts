import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { RuntimeError, verifyMdcmsPreviewToken } from "@mdcms/shared";

import {
  createInMemoryContentStore,
  mountContentApiRoutes,
} from "./content-api.js";
import {
  authorizeTestRequest,
  baseEnv,
  createContentDocument,
  createDatabaseTestContext,
  createHandler,
  createCms26ResolvedSchemas,
  createCms28BlogPostPayload,
  inMemorySchemaHash,
  scopeHeaders,
  wrapHandlerWithAutoSchemaHash,
} from "./content-api-test-support.js";
import { createServerRequestHandler } from "./server.js";

test("cms-28 in-memory content store enforces reference identity when schema snapshots are present", async () => {
  const scope = {
    project: "cms28-in-memory",
    environment: "production",
  };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const page = await store.create(scope, {
    path: `pages/cms28-memory-page-${Date.now()}`,
    type: "Page",
    locale: "en",
    format: "md",
    frontmatter: {
      slug: `cms28-memory-page-${Math.random().toString(36).slice(2, 8)}`,
    },
    body: "page body",
  });
  const blogPayload = createCms28BlogPostPayload({
    title: "memory base",
  });
  const blog = await store.create(scope, blogPayload);

  await assert.rejects(
    () =>
      store.create(scope, {
        ...createCms28BlogPostPayload({
          author: page.documentId,
        }),
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_INPUT");
      return true;
    },
  );

  await assert.rejects(
    () =>
      store.update(scope, blog.documentId, {
        frontmatter: {
          ...(blogPayload.frontmatter ?? {}),
          author: randomUUID(),
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_INPUT");
      return true;
    },
  );
});

test("content API in-memory resolve supports configured schema scopes", async () => {
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: authorizeTestRequest,
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );

  const authorCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "authors/in-memory-author",
        type: "Author",
        locale: "en",
        format: "md",
        frontmatter: {
          slug: "in-memory-author",
          name: "In Memory Author",
        },
        body: "author body",
      }),
    }),
  );
  const authorCreateBody = (await authorCreateResponse.json()) as {
    data: {
      documentId: string;
    };
  };
  assert.equal(authorCreateResponse.status, 200);

  const blogCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/in-memory-resolve",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: {
          slug: "in-memory-resolve",
          author: authorCreateBody.data.documentId,
        },
        body: "blog body",
      }),
    }),
  );
  const blogCreateBody = (await blogCreateResponse.json()) as {
    data: {
      documentId: string;
    };
  };
  assert.equal(blogCreateResponse.status, 200);

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${blogCreateBody.data.documentId}?draft=true&resolve=author`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: Record<string, unknown>;
  };

  assert.equal(response.status, 200);
  const frontmatter = body.data.frontmatter as Record<string, unknown>;
  const resolvedAuthor = frontmatter.author as Record<string, unknown>;
  assert.equal(resolvedAuthor?.documentId, authorCreateBody.data.documentId);
  assert.equal(body.data.resolveErrors, undefined);
});

test("content API supports create/list filters/sort/pagination", async () => {
  const handler = createHandler();

  const createBodies = [
    {
      path: "blog/alpha",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "alpha" },
      body: "alpha body",
    },
    {
      path: "blog/beta",
      type: "BlogPost",
      locale: "fr",
      format: "mdx",
      frontmatter: { slug: "beta" },
      body: "beta body",
    },
    {
      path: "page/about",
      type: "Page",
      locale: "en",
      format: "md",
      frontmatter: { slug: "about" },
      body: "about body",
    },
  ];

  for (const payload of createBodies) {
    const response = await handler(
      new Request("http://localhost/api/v1/content", {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    );

    assert.equal(response.status, 200);
  }

  const response = await handler(
    new Request(
      "http://localhost/api/v1/content?draft=true&type=BlogPost&path=blog/&limit=1&offset=1&sort=path&order=asc",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: Array<{ path: string; type: string }>;
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.pagination.total, 2);
  assert.equal(body.pagination.limit, 1);
  assert.equal(body.pagination.offset, 1);
  assert.equal(body.pagination.hasMore, false);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]?.path, "blog/beta");
  assert.equal(body.data[0]?.type, "BlogPost");
});

test("content API emits webhook events for document lifecycle mutations", async () => {
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const emitted: Array<{
    event: string;
    documentId: string;
    actorId: string;
  }> = [];
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async () => ({
          mode: "session" as const,
          principal: {
            type: "session" as const,
            session: {
              id: "session-1",
              userId: "user-1",
              email: "editor@example.com",
              issuedAt: "2026-06-03T00:00:00.000Z",
              expiresAt: "2026-06-03T01:00:00.000Z",
            },
          },
        }),
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
        lifecycleEvents: {
          async emitContentEvent(input) {
            emitted.push({
              event: input.event,
              documentId: input.document.documentId,
              actorId: input.actor.id,
            });
          },
        },
      });
    },
    now: () => new Date("2026-06-03T00:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );
  const requestJson = (path: string, method: string, body?: unknown) =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  const createResponse = await requestJson("/api/v1/content", "POST", {
    path: "blog/webhook-lifecycle",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "webhook-lifecycle" },
    body: "initial body",
  });
  const createBody = (await createResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(createResponse.status, 200);

  const documentId = createBody.data.documentId;

  assert.equal(
    (
      await requestJson(`/api/v1/content/${documentId}`, "PUT", {
        body: "updated body",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await requestJson(`/api/v1/content/${documentId}/publish`, "POST", {
        changeSummary: "publish",
      })
    ).status,
    200,
  );
  assert.equal(
    (await requestJson(`/api/v1/content/${documentId}/unpublish`, "POST"))
      .status,
    200,
  );
  assert.equal(
    (await requestJson(`/api/v1/content/${documentId}`, "DELETE")).status,
    200,
  );
  assert.equal(
    (await requestJson(`/api/v1/content/${documentId}/restore`, "POST")).status,
    200,
  );

  assert.deepEqual(
    emitted.map((entry) => entry.event),
    [
      "content.created",
      "content.updated",
      "content.published",
      "content.unpublished",
      "content.deleted",
      "content.restored",
    ],
  );
  assert.deepEqual(
    emitted.map((entry) => entry.documentId),
    Array.from({ length: 6 }, () => documentId),
  );
  assert.deepEqual(
    emitted.map((entry) => entry.actorId),
    Array.from({ length: 6 }, () => "user-1"),
  );
});

test("content API rejects translation group grouping for non-localized types", async () => {
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: {
          SettingsPage: {
            type: "SettingsPage",
            directory: "content/settings",
            localized: false,
            fields: {},
          },
        },
      },
    ],
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: authorizeTestRequest,
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );

  const response = await handler(
    new Request(
      "http://localhost/api/v1/content?draft=true&type=SettingsPage&groupBy=translationGroup",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    code: string;
    details?: {
      field?: string;
      value?: string;
    };
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_QUERY_PARAM");
  assert.equal(body.details?.field, "groupBy");
  assert.equal(body.details?.value, "translationGroup");
});

test("content API authorizes list reads before validating translation grouping", async () => {
  let schemaReads = 0;
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: {
          SettingsPage: {
            type: "SettingsPage",
            directory: "content/settings",
            localized: false,
            fields: {},
          },
        },
      },
    ],
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store: {
          ...store,
          async getSchema(scope, type) {
            schemaReads += 1;
            return store.getSchema(scope, type);
          },
        },
        authorize: async () => {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: "Forbidden",
            statusCode: 403,
          });
        },
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );

  const response = await handler(
    new Request(
      "http://localhost/api/v1/content?draft=true&type=SettingsPage&groupBy=translationGroup",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(schemaReads, 0);
});

test("content API preview token endpoint signs document-bound draft preview tokens", async () => {
  const scope = {
    project: scopeHeaders["x-mdcms-project"],
    environment: scopeHeaders["x-mdcms-environment"],
  };
  const authorizeCalls: Array<Record<string, unknown>> = [];
  let csrfCalls = 0;
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const document = await store.create(scope, {
    path: "blog/preview-token",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "preview-token" },
    body: "draft body",
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          authorizeCalls.push(requirement as Record<string, unknown>);
          return authorizeTestRequest();
        },
        requireCsrf: async () => {
          csrfCalls += 1;
        },
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
        previewTokenSecret: "test-preview-secret",
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${document.documentId}/preview-token`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          previewUrl: "/preview/post/preview-token?preview=true",
        }),
      },
    ),
  );
  const body = (await response.json()) as {
    data: {
      token: string;
      expiresAt: string;
    };
  };
  const verified = await verifyMdcmsPreviewToken(body.data.token, {
    secret: "test-preview-secret",
  });

  assert.equal(response.status, 200);
  assert.equal(typeof body.data.expiresAt, "string");
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.claims.documentId, document.documentId);
    assert.equal(verified.claims.sub, document.documentId);
    assert.equal(verified.claims.project, scope.project);
    assert.equal(verified.claims.environment, scope.environment);
    assert.equal(verified.claims.path, document.path);
    assert.equal(verified.claims.type, document.type);
    assert.equal(verified.claims.locale, document.locale);
    assert.equal(verified.claims.draftRevision, document.draftRevision);
    assert.equal(
      verified.claims.previewUrl,
      "/preview/post/preview-token?preview=true",
    );
  }
  assert.equal(csrfCalls, 1);
  assert.deepEqual(authorizeCalls, [
    {
      requiredScope: "content:read:draft",
      project: scope.project,
      environment: scope.environment,
    },
    {
      requiredScope: "content:read:draft",
      project: scope.project,
      environment: scope.environment,
      documentPath: document.path,
    },
  ]);
});

test("content API preview token endpoint returns unavailable when signing is not configured", async () => {
  const scope = {
    project: scopeHeaders["x-mdcms-project"],
    environment: scopeHeaders["x-mdcms-environment"],
  };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const document = await store.create(scope, {
    path: "blog/preview-token-missing-secret",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "preview-token-missing-secret" },
    body: "draft body",
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: authorizeTestRequest,
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${document.documentId}/preview-token`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 503);
  assert.equal(body.code, "PREVIEW_TOKEN_UNAVAILABLE");
});

test("content API preview token endpoint enforces document path authorization", async () => {
  const scope = {
    project: scopeHeaders["x-mdcms-project"],
    environment: scopeHeaders["x-mdcms-environment"],
  };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const document = await store.create(scope, {
    path: "blog/preview-token-forbidden",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "preview-token-forbidden" },
    body: "draft body",
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (requirement.documentPath === document.path) {
            throw new RuntimeError({
              code: "FORBIDDEN",
              message: "Forbidden.",
              statusCode: 403,
            });
          }
          return authorizeTestRequest();
        },
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
        previewTokenSecret: "test-preview-secret",
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${document.documentId}/preview-token`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
});

test("content API overview returns metadata-only counts per type using content:read scope", async () => {
  const authorizeCalls: Array<Record<string, unknown>> = [];
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          authorizeCalls.push(requirement as Record<string, unknown>);
          return authorizeTestRequest();
        },
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );

  const publishedCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/overview-published",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "overview-published" },
        body: "published body",
      }),
    }),
  );
  const publishedCreated = (await publishedCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(publishedCreateResponse.status, 200);

  const publishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${publishedCreated.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ),
  );
  assert.equal(publishResponse.status, 200);

  const draftCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/overview-draft",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "overview-draft" },
        body: "draft body",
      }),
    }),
  );
  assert.equal(draftCreateResponse.status, 200);

  const response = await handler(
    new Request(
      "http://localhost/api/v1/content/overview?type=BlogPost&type=Page",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: Array<{
      type: string;
      total: number;
      published: number;
      drafts: number;
      documentId?: string;
      path?: string;
    }>;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(authorizeCalls.at(-1), {
    requiredScope: "content:read",
    project: scopeHeaders["x-mdcms-project"],
    environment: scopeHeaders["x-mdcms-environment"],
  });
  assert.deepEqual(body.data, [
    {
      type: "BlogPost",
      total: 2,
      published: 1,
      drafts: 1,
    },
    {
      type: "Page",
      total: 0,
      published: 0,
      drafts: 0,
    },
  ]);
});

test("content API creates a locale variant from sourceDocumentId with a fresh documentId", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/hello-world",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "hello-world" },
        body: "hello world",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string; translationGroupId: string };
  };

  assert.equal(sourceCreateResponse.status, 200);

  const variantCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/hello-world",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "bonjour-le-monde" },
        body: "bonjour le monde",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const variantCreated = (await variantCreateResponse.json()) as {
    data: { documentId: string; translationGroupId: string; locale: string };
  };

  assert.equal(variantCreateResponse.status, 200);
  assert.notEqual(
    variantCreated.data.documentId,
    sourceCreated.data.documentId,
  );
  assert.equal(
    variantCreated.data.translationGroupId,
    sourceCreated.data.translationGroupId,
  );
  assert.equal(variantCreated.data.locale, "fr");
});

test("content API rejects duplicate locale variants in the same translation group", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/hello-world",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "hello-world" },
        body: "hello world",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(sourceCreateResponse.status, 200);

  const firstVariantResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/bonjour-le-monde",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "bonjour-le-monde" },
        body: "bonjour le monde",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );

  assert.equal(firstVariantResponse.status, 200);

  const duplicateVariantResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/salut-le-monde",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "salut-le-monde" },
        body: "salut le monde",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const duplicateVariantBody = (await duplicateVariantResponse.json()) as {
    code: string;
  };

  assert.equal(duplicateVariantResponse.status, 409);
  assert.equal(duplicateVariantBody.code, "TRANSLATION_VARIANT_CONFLICT");
});

test("content API returns CONTENT_PATH_CONFLICT before translation variant conflict in memory create", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/path-conflict-source",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "path-conflict-source" },
        body: "source body",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(sourceCreateResponse.status, 200);

  const existingLocaleResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/path-conflict-target",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "path-conflict-target" },
        body: "existing body",
      }),
    }),
  );
  assert.equal(existingLocaleResponse.status, 200);

  const variantCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/path-conflict-target",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "variant-path-conflict-target" },
        body: "variant body",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const variantCreateBody = (await variantCreateResponse.json()) as {
    code: string;
  };

  assert.equal(variantCreateResponse.status, 409);
  assert.equal(variantCreateBody.code, "CONTENT_PATH_CONFLICT");
});

test("content API returns NOT_FOUND for missing sourceDocumentId in memory create", async () => {
  const handler = createHandler();

  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/missing-source",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "missing-source" },
        body: "body",
        sourceDocumentId: "00000000-0000-0000-0000-000000000123",
      }),
    }),
  );
  const responseBody = (await response.json()) as {
    code: string;
  };

  assert.equal(response.status, 404);
  assert.equal(responseBody.code, "NOT_FOUND");
});

test("content API returns NOT_FOUND for soft-deleted sourceDocumentId in memory create", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/deleted-source",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "deleted-source" },
        body: "source body",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(sourceCreateResponse.status, 200);

  const deleteResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${sourceCreated.data.documentId}`,
      {
        method: "DELETE",
        headers: scopeHeaders,
      },
    ),
  );
  assert.equal(deleteResponse.status, 200);

  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/deleted-source-variant",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "deleted-source-variant" },
        body: "variant body",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const responseBody = (await response.json()) as {
    code: string;
  };

  assert.equal(response.status, 404);
  assert.equal(responseBody.code, "NOT_FOUND");
});

test("content API returns INVALID_INPUT for source type mismatch in memory create", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/type-mismatch-source",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "type-mismatch-source" },
        body: "source body",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(sourceCreateResponse.status, 200);

  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "page/type-mismatch-variant",
        type: "Page",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "type-mismatch-variant" },
        body: "variant body",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const responseBody = (await response.json()) as {
    code: string;
  };

  assert.equal(response.status, 400);
  assert.equal(responseBody.code, "INVALID_INPUT");
});

test("content API returns TRANSLATION_VARIANT_CONFLICT for in-memory variant locale collisions on update", async () => {
  const handler = createHandler();

  const sourceCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/update-source",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "update-source" },
        body: "source body",
      }),
    }),
  );
  const sourceCreated = (await sourceCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(sourceCreateResponse.status, 200);

  const frVariantResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/update-fr",
        type: "BlogPost",
        locale: "fr",
        format: "md",
        frontmatter: { slug: "update-fr" },
        body: "fr body",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  assert.equal(frVariantResponse.status, 200);

  const deVariantResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/update-de",
        type: "BlogPost",
        locale: "de",
        format: "md",
        frontmatter: { slug: "update-de" },
        body: "de body",
        sourceDocumentId: sourceCreated.data.documentId,
      }),
    }),
  );
  const deVariantCreated = (await deVariantResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(deVariantResponse.status, 200);

  const updateResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${deVariantCreated.data.documentId}`,
      {
        method: "PUT",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          locale: "fr",
        }),
      },
    ),
  );
  const updateBody = (await updateResponse.json()) as {
    code: string;
  };

  assert.equal(updateResponse.status, 409);
  assert.equal(updateBody.code, "TRANSLATION_VARIANT_CONFLICT");
});

test("content API supports draft/publish/unpublish lifecycle", async () => {
  const handler = createHandler();

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/hello-world",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "hello-world", title: "Hello World" },
        body: "hello",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(createResponse.status, 200);
  assert.ok(created.data.documentId);

  const getPublishedBeforePublishResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  assert.equal(getPublishedBeforePublishResponse.status, 404);

  const getDraftResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}?draft=true`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  assert.equal(getDraftResponse.status, 200);

  const publishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          change_summary: "Initial publish",
        }),
      },
    ),
  );
  const published = (await publishResponse.json()) as {
    data: {
      publishedVersion: number | null;
      version: number;
      hasUnpublishedChanges: boolean;
    };
  };

  assert.equal(publishResponse.status, 200);
  assert.equal(published.data.publishedVersion, 1);
  assert.equal(published.data.version, 1);
  assert.equal(published.data.hasUnpublishedChanges, false);

  const getPublishedAfterPublishResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  assert.equal(getPublishedAfterPublishResponse.status, 200);

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/hello-world-updated",
        body: "updated body",
      }),
    }),
  );
  const updated = (await updateResponse.json()) as {
    data: {
      path: string;
      draftRevision: number;
      hasUnpublishedChanges: boolean;
    };
  };

  assert.equal(updateResponse.status, 200);
  assert.equal(updated.data.path, "blog/hello-world-updated");
  assert.equal(updated.data.draftRevision, 2);
  assert.equal(updated.data.hasUnpublishedChanges, true);

  const getPublishedAfterDraftEditResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const getPublishedAfterDraftEditBody =
    (await getPublishedAfterDraftEditResponse.json()) as {
      data: { path: string; body: string };
    };

  assert.equal(getPublishedAfterDraftEditResponse.status, 200);
  assert.equal(getPublishedAfterDraftEditBody.data.path, "blog/hello-world");
  assert.equal(getPublishedAfterDraftEditBody.data.body, "hello");

  const unpublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/unpublish`,
      {
        method: "POST",
        headers: scopeHeaders,
      },
    ),
  );
  const unpublished = (await unpublishResponse.json()) as {
    data: { publishedVersion: number | null; hasUnpublishedChanges: boolean };
  };

  assert.equal(unpublishResponse.status, 200);
  assert.equal(unpublished.data.publishedVersion, null);
  assert.equal(unpublished.data.hasUnpublishedChanges, true);

  const getPublishedAfterUnpublishResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const getPublishedAfterUnpublishBody =
    (await getPublishedAfterUnpublishResponse.json()) as {
      code: string;
    };

  assert.equal(getPublishedAfterUnpublishResponse.status, 404);
  assert.equal(getPublishedAfterUnpublishBody.code, "NOT_FOUND");

  const deleteResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const deleted = (await deleteResponse.json()) as {
    data: { isDeleted: boolean };
  };

  assert.equal(deleteResponse.status, 200);
  assert.equal(deleted.data.isDeleted, true);

  const getDeletedResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const getDeletedBody = (await getDeletedResponse.json()) as {
    code: string;
  };

  assert.equal(getDeletedResponse.status, 404);
  assert.equal(getDeletedBody.code, "NOT_FOUND");
});

test("content API list uses published snapshots by default and hides deleted draft rows unless explicitly requested", async () => {
  const handler = createHandler();

  const publishedCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/list-visible-published",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "list-visible-published" },
        body: "published body",
      }),
    }),
  );
  const publishedCreated = (await publishedCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(publishedCreateResponse.status, 200);

  const publishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${publishedCreated.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          change_summary: "Publish visible baseline",
        }),
      },
    ),
  );
  assert.equal(publishResponse.status, 200);

  const publishedUpdateResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${publishedCreated.data.documentId}`,
      {
        method: "PUT",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: "blog/list-visible-draft",
          body: "draft body",
        }),
      },
    ),
  );
  assert.equal(publishedUpdateResponse.status, 200);

  const unpublishedCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/list-unpublished-only",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "list-unpublished-only" },
        body: "unpublished draft body",
      }),
    }),
  );
  const unpublishedCreated = (await unpublishedCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(unpublishedCreateResponse.status, 200);

  const deletedCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/list-deleted-doc",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "list-deleted-doc" },
        body: "deleted body",
      }),
    }),
  );
  const deletedCreated = (await deletedCreateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(deletedCreateResponse.status, 200);

  const deletedPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${deletedCreated.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          change_summary: "Publish before delete",
        }),
      },
    ),
  );
  assert.equal(deletedPublishResponse.status, 200);

  const deletedDeleteResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${deletedCreated.data.documentId}`,
      {
        method: "DELETE",
        headers: scopeHeaders,
      },
    ),
  );
  assert.equal(deletedDeleteResponse.status, 200);

  const publishedListResponse = await handler(
    new Request("http://localhost/api/v1/content?sort=path&order=asc", {
      headers: scopeHeaders,
    }),
  );
  const publishedListBody = (await publishedListResponse.json()) as {
    data: Array<{
      documentId: string;
      path: string;
      body: string;
      isDeleted: boolean;
    }>;
  };
  assert.equal(publishedListResponse.status, 200);
  assert.deepEqual(
    publishedListBody.data.map((document) => ({
      documentId: document.documentId,
      path: document.path,
      body: document.body,
      isDeleted: document.isDeleted,
    })),
    [
      {
        documentId: publishedCreated.data.documentId,
        path: "blog/list-visible-published",
        body: "published body",
        isDeleted: false,
      },
    ],
  );

  const draftListResponse = await handler(
    new Request(
      "http://localhost/api/v1/content?draft=true&sort=path&order=asc",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const draftListBody = (await draftListResponse.json()) as {
    data: Array<{
      documentId: string;
      path: string;
      body: string;
      isDeleted: boolean;
    }>;
  };
  assert.equal(draftListResponse.status, 200);
  assert.deepEqual(
    draftListBody.data.map((document) => ({
      documentId: document.documentId,
      path: document.path,
      body: document.body,
      isDeleted: document.isDeleted,
    })),
    [
      {
        documentId: unpublishedCreated.data.documentId,
        path: "blog/list-unpublished-only",
        body: "unpublished draft body",
        isDeleted: false,
      },
      {
        documentId: publishedCreated.data.documentId,
        path: "blog/list-visible-draft",
        body: "draft body",
        isDeleted: false,
      },
    ],
  );

  const deletedDraftListResponse = await handler(
    new Request(
      "http://localhost/api/v1/content?draft=true&isDeleted=true&sort=path&order=asc",
      {
        headers: scopeHeaders,
      },
    ),
  );
  const deletedDraftListBody = (await deletedDraftListResponse.json()) as {
    data: Array<{
      documentId: string;
      path: string;
      body: string;
      isDeleted: boolean;
    }>;
  };
  assert.equal(deletedDraftListResponse.status, 200);
  assert.deepEqual(
    deletedDraftListBody.data.map((document) => ({
      documentId: document.documentId,
      path: document.path,
      body: document.body,
      isDeleted: document.isDeleted,
    })),
    [
      {
        documentId: deletedCreated.data.documentId,
        path: "blog/list-deleted-doc",
        body: "deleted body",
        isDeleted: true,
      },
    ],
  );
});

test("content API restore undeletes the current head without appending a version", async () => {
  const handler = createHandler();

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-me",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "restore-me", title: "Restore Me" },
        body: "restore me body",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(createResponse.status, 200);

  const publishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          changeSummary: "Publish before trash",
        }),
      },
    ),
  );
  const published = (await publishResponse.json()) as {
    data: { publishedVersion: number | null };
  };

  assert.equal(publishResponse.status, 200);
  assert.equal(published.data.publishedVersion, 1);

  const deleteResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );

  assert.equal(deleteResponse.status, 200);

  const restoreResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/restore`,
      {
        method: "POST",
        headers: scopeHeaders,
      },
    ),
  );
  const restoreBody = (await restoreResponse.json()) as {
    data: {
      isDeleted: boolean;
      publishedVersion: number | null;
      body: string;
    };
  };

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreBody.data.isDeleted, false);
  assert.equal(restoreBody.data.publishedVersion, 1);
  assert.equal(restoreBody.data.body, "restore me body");

  const versionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const versionsBody = (await versionsResponse.json()) as {
    data: Array<{ version: number }>;
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };

  assert.equal(versionsResponse.status, 200);
  assert.equal(versionsBody.data.length, 1);
  assert.equal(versionsBody.data[0]?.version, 1);
  assert.deepEqual(versionsBody.pagination, {
    total: 1,
    limit: 20,
    offset: 0,
    hasMore: false,
  });

  const publishedReadResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const publishedReadBody = (await publishedReadResponse.json()) as {
    data: { body: string };
  };

  assert.equal(publishedReadResponse.status, 200);
  assert.equal(publishedReadBody.data.body, "restore me body");
});

test("content API restore returns CONTENT_PATH_CONFLICT when undelete collides with an active path", async () => {
  const handler = createHandler();

  const trashedCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/conflict-path",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "conflict-path" },
        body: "trashed body",
      }),
    }),
  );
  const trashedDocument = (await trashedCreateResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(trashedCreateResponse.status, 200);

  const deleteResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${trashedDocument.data.documentId}`,
      {
        method: "DELETE",
        headers: scopeHeaders,
      },
    ),
  );

  assert.equal(deleteResponse.status, 200);

  const conflictingCreateResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/conflict-path",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "conflict-path-live" },
        body: "live body",
      }),
    }),
  );

  assert.equal(conflictingCreateResponse.status, 200);

  const restoreResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${trashedDocument.data.documentId}/restore`,
      {
        method: "POST",
        headers: scopeHeaders,
      },
    ),
  );
  const restoreBody = (await restoreResponse.json()) as {
    code: string;
    details?: { path?: string; locale?: string; conflictDocumentId?: string };
  };

  assert.equal(restoreResponse.status, 409);
  assert.equal(restoreBody.code, "CONTENT_PATH_CONFLICT");
  assert.equal(restoreBody.details?.path, "blog/conflict-path");
  assert.equal(restoreBody.details?.locale, "en");
  assert.ok(restoreBody.details?.conflictDocumentId);
});

test("content API returns version history summaries and immutable snapshots", async () => {
  const handler = createHandler();

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/version-history",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "version-history", title: "Version One" },
        body: "version one body",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(createResponse.status, 200);

  const firstPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          changeSummary: "Version one",
        }),
      },
    ),
  );

  assert.equal(firstPublishResponse.status, 200);

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/version-history-updated",
        frontmatter: { slug: "version-history", title: "Version Two" },
        body: "version two body",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);

  const secondPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          changeSummary: "Version two",
        }),
      },
    ),
  );

  assert.equal(secondPublishResponse.status, 200);

  const versionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const versionsBody = (await versionsResponse.json()) as {
    data: Array<{
      version: number;
      path: string;
      changeSummary?: string;
    }>;
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };

  assert.equal(versionsResponse.status, 200);
  assert.equal(versionsBody.data.length, 2);
  assert.equal(versionsBody.data[0]?.version, 2);
  assert.equal(versionsBody.data[0]?.path, "blog/version-history-updated");
  assert.equal(versionsBody.data[0]?.changeSummary, "Version two");
  assert.equal(versionsBody.data[1]?.version, 1);
  assert.equal(versionsBody.data[1]?.path, "blog/version-history");
  assert.equal(versionsBody.data[1]?.changeSummary, "Version one");
  assert.deepEqual(versionsBody.pagination, {
    total: 2,
    limit: 20,
    offset: 0,
    hasMore: false,
  });

  const pagedVersionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions?limit=1&offset=0`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const pagedVersionsBody = (await pagedVersionsResponse.json()) as {
    data: Array<{
      version: number;
      path: string;
      changeSummary?: string;
    }>;
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };

  assert.equal(pagedVersionsResponse.status, 200);
  assert.equal(pagedVersionsBody.data.length, 1);
  assert.equal(pagedVersionsBody.data[0]?.version, 2);
  assert.deepEqual(pagedVersionsBody.pagination, {
    total: 2,
    limit: 1,
    offset: 0,
    hasMore: true,
  });

  const offsetVersionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions?limit=1&offset=1`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const offsetVersionsBody = (await offsetVersionsResponse.json()) as {
    data: Array<{
      version: number;
      path: string;
      changeSummary?: string;
    }>;
    pagination: {
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  };

  assert.equal(offsetVersionsResponse.status, 200);
  assert.equal(offsetVersionsBody.data.length, 1);
  assert.equal(offsetVersionsBody.data[0]?.version, 1);
  assert.deepEqual(offsetVersionsBody.pagination, {
    total: 2,
    limit: 1,
    offset: 1,
    hasMore: false,
  });

  const versionOneResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions/1`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const versionOneBody = (await versionOneResponse.json()) as {
    data: {
      version: number;
      path: string;
      body: string;
      frontmatter: { title?: string };
      changeSummary?: string;
    };
  };

  assert.equal(versionOneResponse.status, 200);
  assert.equal(versionOneBody.data.version, 1);
  assert.equal(versionOneBody.data.path, "blog/version-history");
  assert.equal(versionOneBody.data.body, "version one body");
  assert.equal(versionOneBody.data.frontmatter.title, "Version One");
  assert.equal(versionOneBody.data.changeSummary, "Version one");
});

test("content API restores a historical version to draft state by default", async () => {
  const handler = createHandler();

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-draft",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "restore-draft", title: "Draft Version One" },
        body: "draft version one body",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(createResponse.status, 200);

  const firstPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
      },
    ),
  );

  assert.equal(firstPublishResponse.status, 200);

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-draft-updated",
        frontmatter: { slug: "restore-draft", title: "Draft Version Two" },
        body: "draft version two body",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);

  const secondPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
      },
    ),
  );

  assert.equal(secondPublishResponse.status, 200);

  const restoreResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions/1/restore`,
      {
        method: "POST",
        headers: scopeHeaders,
      },
    ),
  );
  const restoreBody = (await restoreResponse.json()) as {
    data: {
      body: string;
      path: string;
      publishedVersion: number | null;
      hasUnpublishedChanges: boolean;
    };
  };

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreBody.data.body, "draft version one body");
  assert.equal(restoreBody.data.path, "blog/restore-draft");
  assert.equal(restoreBody.data.publishedVersion, 2);
  assert.equal(restoreBody.data.hasUnpublishedChanges, true);

  const publishedReadResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const publishedReadBody = (await publishedReadResponse.json()) as {
    data: { body: string; path: string };
  };

  assert.equal(publishedReadResponse.status, 200);
  assert.equal(publishedReadBody.data.body, "draft version two body");
  assert.equal(publishedReadBody.data.path, "blog/restore-draft-updated");

  const versionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const versionsBody = (await versionsResponse.json()) as {
    data: Array<{ version: number }>;
  };

  assert.equal(versionsResponse.status, 200);
  assert.equal(versionsBody.data.length, 2);
  assert.equal(versionsBody.data[0]?.version, 2);
  assert.equal(versionsBody.data[1]?.version, 1);
});

test("content API restores a historical version to published state when requested", async () => {
  const handler = createHandler();

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-published",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "restore-published", title: "Published One" },
        body: "published one body",
      }),
    }),
  );
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };

  assert.equal(createResponse.status, 200);

  const firstPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
      },
    ),
  );

  assert.equal(firstPublishResponse.status, 200);

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.data.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-published-updated",
        frontmatter: { slug: "restore-published", title: "Published Two" },
        body: "published two body",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);

  const secondPublishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/publish`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
      },
    ),
  );

  assert.equal(secondPublishResponse.status, 200);

  const restoreResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions/1/restore`,
      {
        method: "POST",
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetStatus: "published",
          changeSummary: "Republish v1",
        }),
      },
    ),
  );
  const restoreBody = (await restoreResponse.json()) as {
    data: {
      body: string;
      path: string;
      publishedVersion: number | null;
      version: number;
      hasUnpublishedChanges: boolean;
    };
  };

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreBody.data.body, "published one body");
  assert.equal(restoreBody.data.path, "blog/restore-published");
  assert.equal(restoreBody.data.publishedVersion, 3);
  assert.equal(restoreBody.data.version, 3);
  assert.equal(restoreBody.data.hasUnpublishedChanges, false);

  const versionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const versionsBody = (await versionsResponse.json()) as {
    data: Array<{ version: number }>;
  };

  assert.equal(versionsResponse.status, 200);
  assert.equal(versionsBody.data.length, 3);
  assert.equal(versionsBody.data[0]?.version, 3);
  assert.equal(versionsBody.data[1]?.version, 2);
  assert.equal(versionsBody.data[2]?.version, 1);

  const latestVersionResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.data.documentId}/versions/3`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const latestVersionBody = (await latestVersionResponse.json()) as {
    data: { body: string; path: string; changeSummary?: string };
  };

  assert.equal(latestVersionResponse.status, 200);
  assert.equal(latestVersionBody.data.body, "published one body");
  assert.equal(latestVersionBody.data.path, "blog/restore-published");
  assert.equal(latestVersionBody.data.changeSummary, "Republish v1");
});

test("content API enforces list query validation and routing requirements", async () => {
  const handler = createHandler();

  const invalidLimitResponse = await handler(
    new Request("http://localhost/api/v1/content?limit=999", {
      headers: scopeHeaders,
    }),
  );
  const invalidLimitBody = (await invalidLimitResponse.json()) as {
    code: string;
  };

  assert.equal(invalidLimitResponse.status, 400);
  assert.equal(invalidLimitBody.code, "INVALID_QUERY_PARAM");

  const malformedLimitResponse = await handler(
    new Request("http://localhost/api/v1/content?limit=1abc", {
      headers: scopeHeaders,
    }),
  );
  const malformedLimitBody = (await malformedLimitResponse.json()) as {
    code: string;
  };

  assert.equal(malformedLimitResponse.status, 400);
  assert.equal(malformedLimitBody.code, "INVALID_QUERY_PARAM");

  const missingScopeResponse = await handler(
    new Request("http://localhost/api/v1/content"),
  );
  const missingScopeBody = (await missingScopeResponse.json()) as {
    code: string;
  };

  assert.equal(missingScopeResponse.status, 400);
  assert.equal(missingScopeBody.code, "MISSING_TARGET_ROUTING");
});

test("createDatabaseTestContext closes dbConnection if setup fails before returning", async () => {
  let closed = false;

  await assert.rejects(() =>
    createDatabaseTestContext("test:content-api-db-setup-failure", () => ({
      handler: async () =>
        new Response(JSON.stringify({ code: "INVALID_INPUT" }), {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        }),
      dbConnection: {
        db: {} as any,
        close: async () => {
          closed = true;
        },
      },
    })),
  );

  assert.equal(closed, true);
});

test("CMS-151: stale draftRevision is rejected with 409 STALE_DRAFT_REVISION", async () => {
  const handler = createHandler();
  const noopCsrf = (headers: Record<string, string> = {}) => headers;

  const created = await createContentDocument(handler, noopCsrf, scopeHeaders, {
    path: "blog/cms151-stale",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "cms151-stale" },
    body: "original body",
  });

  const firstUpdateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "updated body",
      }),
    }),
  );
  assert.equal(firstUpdateResponse.status, 200);

  const staleUpdateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "stale body",
        draftRevision: 1,
      }),
    }),
  );
  const staleBody = (await staleUpdateResponse.json()) as {
    code: string;
    details: {
      expectedDraftRevision: number;
      currentDraftRevision: number;
    };
  };

  assert.equal(staleUpdateResponse.status, 409);
  assert.equal(staleBody.code, "STALE_DRAFT_REVISION");
  assert.equal(staleBody.details.expectedDraftRevision, 1);
  assert.equal(staleBody.details.currentDraftRevision, 2);
});

test("CMS-151: correct draftRevision succeeds and increments revision", async () => {
  const handler = createHandler();
  const noopCsrf = (headers: Record<string, string> = {}) => headers;

  const created = await createContentDocument(handler, noopCsrf, scopeHeaders, {
    path: "blog/cms151-correct",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "cms151-correct" },
    body: "original body",
  });

  assert.equal(created.draftRevision, 1);

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "updated body",
        draftRevision: 1,
      }),
    }),
  );
  const updateBody = (await updateResponse.json()) as {
    data: {
      draftRevision: number;
    };
  };

  assert.equal(updateResponse.status, 200);
  assert.equal(updateBody.data.draftRevision, 2);
});

test("CMS-151: omitting draftRevision skips concurrency check (backward compat)", async () => {
  const handler = createHandler();
  const noopCsrf = (headers: Record<string, string> = {}) => headers;

  const created = await createContentDocument(handler, noopCsrf, scopeHeaders, {
    path: "blog/cms151-no-revision",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "cms151-no-revision" },
    body: "original body",
  });

  const updateResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "updated body",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);
});

test("in-memory store listVariants returns sibling locale variants", async () => {
  const scope = {
    project: "cms63-in-memory-variants",
    environment: "production",
  };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });

  const source = await store.create(scope, {
    path: "blog/variant-test",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "variant-test" },
    body: "english body",
  });

  await store.create(scope, {
    path: "blog/variant-test",
    type: "BlogPost",
    locale: "fr",
    format: "md",
    frontmatter: { slug: "variant-test" },
    body: "french body",
    sourceDocumentId: source.documentId,
  });

  const variants = await store.listVariants(scope, source.documentId);

  assert.ok(variants !== undefined);
  assert.equal(variants.length, 2);
  const locales = variants.map((v) => v.locale).sort();
  assert.deepEqual(locales, ["en", "fr"]);
  assert.ok(variants.every((v) => v.path === "blog/variant-test"));
});

test("in-memory store listVariants returns undefined for missing document", async () => {
  const scope = {
    project: "cms63-in-memory-variants-missing",
    environment: "production",
  };
  const store = createInMemoryContentStore();

  const result = await store.listVariants(scope, "nonexistent-id");
  assert.equal(result, undefined);
});

test("in-memory store listVariants excludes soft-deleted variants", async () => {
  const scope = {
    project: "cms63-in-memory-variants-deleted",
    environment: "production",
  };
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });

  const source = await store.create(scope, {
    path: "blog/delete-variant-test",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "delete-variant-test" },
    body: "english body",
  });

  const variant = await store.create(scope, {
    path: "blog/delete-variant-test",
    type: "BlogPost",
    locale: "fr",
    format: "md",
    frontmatter: { slug: "delete-variant-test" },
    body: "french body",
    sourceDocumentId: source.documentId,
  });

  await store.softDelete(scope, variant.documentId);

  const variants = await store.listVariants(scope, source.documentId);
  assert.ok(variants !== undefined);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].locale, "en");
});
