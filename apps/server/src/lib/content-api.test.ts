import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import {
  RuntimeError,
  type MediaAsset,
  type SchemaRegistryTypeSnapshot,
  verifyMdcmsPreviewToken,
} from "@mdcms/shared";

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
  stableFixtureName,
  testWithDatabase,
  wrapHandlerWithAutoSchemaHash,
} from "./content-api-test-support.js";
import { createServerRequestHandler } from "./server.js";

const mediaFieldImageAsset = {
  id: "07ebb057-eeab-4849-94e4-2162cb921c8e",
  project: "marketing-site",
  filename: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 100,
  url: "https://cdn.example.test/hero.jpg",
  uploadedBy: "user_1",
  uploadedAt: "2026-06-09T10:00:00.000Z",
} satisfies MediaAsset;

const mediaFieldPdfAsset = {
  ...mediaFieldImageAsset,
  id: "31d87a14-4c4f-4ed3-8a27-1e5fb7dce19f",
  filename: "terms.pdf",
  mimeType: "application/pdf",
  url: "https://cdn.example.test/terms.pdf",
} satisfies MediaAsset;

function createMediaFieldSchema(
  fields: SchemaRegistryTypeSnapshot["fields"],
): SchemaRegistryTypeSnapshot {
  return {
    type: "MediaPage",
    directory: "content/media-pages",
    localized: true,
    fields,
  };
}

function requiredImageField(): SchemaRegistryTypeSnapshot["fields"][string] {
  return {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    },
  };
}

function createMediaLookup(assets: MediaAsset[], calls: string[] = []) {
  return async (
    _scope: { project: string; environment: string },
    id: string,
  ) => {
    calls.push(id);
    return assets.find((asset) => asset.id === id);
  };
}

function optionalImageField(): SchemaRegistryTypeSnapshot["fields"][string] {
  return {
    ...requiredImageField(),
    required: false,
    nullable: true,
    file: {
      preset: "image",
      accept: [],
      emptyStringAsUnset: true,
    },
  };
}

function mediaReadSchemas(): Record<string, SchemaRegistryTypeSnapshot> {
  return {
    Article: {
      type: "Article",
      directory: "content/articles",
      localized: true,
      fields: {
        slug: {
          kind: "string",
          required: true,
          nullable: false,
        },
        title: {
          kind: "string",
          required: false,
          nullable: true,
        },
        author: {
          kind: "string",
          required: false,
          nullable: true,
          reference: {
            targetType: "Author",
          },
        },
        heroImage: optionalImageField(),
      },
    },
    Gallery: {
      type: "Gallery",
      directory: "content/galleries",
      localized: true,
      fields: {
        slug: {
          kind: "string",
          required: true,
          nullable: false,
        },
        coverImage: optionalImageField(),
      },
    },
    Author: {
      type: "Author",
      directory: "content/authors",
      localized: true,
      fields: {
        slug: {
          kind: "string",
          required: true,
          nullable: false,
        },
        name: {
          kind: "string",
          required: true,
          nullable: false,
        },
        avatar: optionalImageField(),
      },
    },
  };
}

function createMediaReadHandler(
  input: {
    assets?: MediaAsset[];
    lookupCalls?: string[];
    getWriteSchemaSyncState?: () => Promise<{ schemaHash: string } | undefined>;
  } = {},
) {
  const assets = [...(input.assets ?? [mediaFieldImageAsset])];
  const store = createInMemoryContentStore({
    lookupMediaAsset: async (_scope, id) =>
      assets.find((asset) => asset.id === id),
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: mediaReadSchemas(),
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
        getWriteSchemaSyncState:
          input.getWriteSchemaSyncState ??
          (async () => ({
            schemaHash: inMemorySchemaHash,
          })),
        lookupMediaAsset: async (scope, id) =>
          createMediaLookup(assets, input.lookupCalls)(scope, id),
      });
    },
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  });

  return {
    assets,
    store,
    handler: wrapHandlerWithAutoSchemaHash(
      rawHandler,
      () => inMemorySchemaHash,
    ),
  };
}

function jsonContentRequest(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...scopeHeaders,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createMediaArticle(
  handler: ReturnType<typeof createServerRequestHandler>,
  slug: string,
  frontmatter: Record<string, unknown> = {},
) {
  const response = await handler(
    jsonContentRequest("/api/v1/content?fileFields=raw", "POST", {
      path: `articles/${slug}`,
      type: "Article",
      locale: "en",
      format: "md",
      frontmatter: {
        slug,
        heroImage: mediaFieldImageAsset.id,
        ...frontmatter,
      },
      body: `${slug} body`,
    }),
  );
  const body = (await response.json()) as {
    data: { documentId: string; frontmatter: Record<string, unknown> };
  };

  assert.equal(response.status, 200);
  return body.data;
}

async function assertContentWriteRuntimeError(
  action: () => Promise<unknown>,
  expected: {
    code: string;
    statusCode: number;
    details: Record<string, unknown>;
  },
) {
  await assert.rejects(action, (error: unknown) => {
    const actual = error as {
      code?: string;
      statusCode?: number;
      details?: Record<string, unknown>;
    };
    assert.equal(actual.code, expected.code);
    assert.equal(actual.statusCode, expected.statusCode);
    assert.deepEqual(actual.details, expected.details);
    return true;
  });
}

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

test("in-memory content store validates schema file field media assets on writes", async () => {
  const scope = {
    project: "media-field-write-validation",
    environment: "production",
  };
  const missingAssetId = "76e8cc2a-43c8-48cf-91d6-fc4deebaf8c8";
  const store = createInMemoryContentStore({
    lookupMediaAsset: createMediaLookup([
      mediaFieldImageAsset,
      mediaFieldPdfAsset,
    ]),
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: {
          MediaPage: createMediaFieldSchema({
            slug: {
              kind: "string",
              required: true,
              nullable: false,
            },
            primaryImage: requiredImageField(),
            defaultImage: {
              ...requiredImageField(),
              required: false,
              default: mediaFieldImageAsset.id,
            },
            zodDefaultImage: {
              ...requiredImageField(),
              required: false,
              default: mediaFieldImageAsset.id,
            },
          }),
        },
      },
    ],
  });

  const created = await store.create(scope, {
    path: "content/media-pages/valid",
    type: "MediaPage",
    locale: "en",
    format: "md",
    frontmatter: {
      slug: "valid",
      primaryImage: mediaFieldImageAsset.id,
    },
    body: "body",
  });

  assert.equal(created.frontmatter.primaryImage, mediaFieldImageAsset.id);
  assert.equal(created.frontmatter.defaultImage, mediaFieldImageAsset.id);
  assert.equal(created.frontmatter.zodDefaultImage, mediaFieldImageAsset.id);

  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ] as const) {
    await assertContentWriteRuntimeError(
      () =>
        store.create(scope, {
          path: `content/media-pages/${label}`,
          type: "MediaPage",
          locale: "en",
          format: "md",
          frontmatter: {
            slug: label,
            ...(value !== undefined ? { primaryImage: value } : {}),
          },
          body: "body",
        }),
      {
        code: "INVALID_INPUT",
        statusCode: 400,
        details: {
          field: "frontmatter.primaryImage",
          reason: "MEDIA_REQUIRED",
        },
      },
    );
  }

  await assertContentWriteRuntimeError(
    () =>
      store.create(scope, {
        path: "content/media-pages/non-image",
        type: "MediaPage",
        locale: "en",
        format: "md",
        frontmatter: {
          slug: "non-image",
          primaryImage: mediaFieldPdfAsset.id,
        },
        body: "body",
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: mediaFieldPdfAsset.id,
        reason: "MEDIA_TYPE_MISMATCH",
        expectedMime: "image/*",
        actualMimeType: "application/pdf",
      },
    },
  );

  await assertContentWriteRuntimeError(
    () =>
      store.update(scope, created.documentId, {
        frontmatter: {
          slug: "missing-update",
          primaryImage: missingAssetId,
        },
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: missingAssetId,
        reason: "MEDIA_NOT_FOUND",
      },
    },
  );
});

test("in-memory content store normalizes malformed media id lookup errors", async () => {
  const scope = {
    project: "media-field-malformed-id-validation",
    environment: "production",
  };
  const malformedId = "not-a-media-uuid";
  const store = createInMemoryContentStore({
    lookupMediaAsset: async () => {
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Media id must be a UUID.",
        statusCode: 400,
        details: { field: "id" },
      });
    },
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: {
          MediaPage: createMediaFieldSchema({
            primaryImage: requiredImageField(),
          }),
        },
      },
    ],
  });

  await assertContentWriteRuntimeError(
    () =>
      store.create(scope, {
        path: "content/media-pages/malformed-id",
        type: "MediaPage",
        locale: "en",
        format: "md",
        frontmatter: {
          primaryImage: malformedId,
        },
        body: "body",
      }),
    {
      code: "INVALID_INPUT",
      statusCode: 400,
      details: {
        field: "frontmatter.primaryImage",
        mediaAssetId: malformedId,
        reason: "MEDIA_NOT_FOUND",
      },
    },
  );
});

test("in-memory content store treats optional file field unset values as absent", async () => {
  const scope = {
    project: "media-field-optional-validation",
    environment: "production",
  };
  const calls: string[] = [];
  const store = createInMemoryContentStore({
    lookupMediaAsset: createMediaLookup([mediaFieldImageAsset], calls),
    schemaScopes: [
      {
        project: scope.project,
        environment: scope.environment,
        schemas: {
          MediaPage: createMediaFieldSchema({
            optionalImage: {
              ...requiredImageField(),
              required: false,
              nullable: true,
              file: {
                preset: "image",
                accept: [],
                emptyStringAsUnset: true,
              },
            },
          }),
        },
      },
    ],
  });

  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ] as const) {
    const created = await store.create(scope, {
      path: `content/media-pages/optional-${label}`,
      type: "MediaPage",
      locale: "en",
      format: "md",
      frontmatter: value === undefined ? {} : { optionalImage: value },
      body: "body",
    });

    assert.equal("optionalImage" in created.frontmatter, false);
  }

  assert.deepEqual(calls, []);
});

test("content API expands file fields by default and supports raw mode on reads", async () => {
  const { handler } = createMediaReadHandler();
  const article = await createMediaArticle(handler, "read-expansion");
  const publishResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/publish?fileFields=raw`,
      "POST",
    ),
  );
  assert.equal(publishResponse.status, 200);

  const expandedResponse = await handler(
    new Request(`http://localhost/api/v1/content/${article.documentId}`, {
      headers: scopeHeaders,
    }),
  );
  const expanded = (await expandedResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(expandedResponse.status, 200);
  assert.deepEqual(expanded.data.frontmatter.heroImage, mediaFieldImageAsset);

  const rawResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?fileFields=raw`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const raw = (await rawResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(rawResponse.status, 200);
  assert.equal(raw.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const draftRawResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?draft=true&fileFields=raw`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const draftRaw = (await draftRawResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(draftRawResponse.status, 200);
  assert.equal(draftRaw.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const invalidResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?fileFields=banana`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const invalid = (await invalidResponse.json()) as { code: string };
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.code, "INVALID_QUERY_PARAM");

  const repeatedResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?fileFields=raw&fileFields=banana`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const repeated = (await repeatedResponse.json()) as {
    code: string;
    details?: { field?: string };
  };
  assert.equal(repeatedResponse.status, 400);
  assert.equal(repeated.code, "INVALID_QUERY_PARAM");
  assert.equal(repeated.details?.field, "fileFields");

  const emptyResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?fileFields=`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const empty = (await emptyResponse.json()) as {
    code: string;
    details?: { field?: string };
  };
  assert.equal(emptyResponse.status, 400);
  assert.equal(empty.code, "INVALID_QUERY_PARAM");
  assert.equal(empty.details?.field, "fileFields");
});

test("content API caches duplicate media asset lookups within a list response", async () => {
  const lookupCalls: string[] = [];
  const { handler } = createMediaReadHandler({ lookupCalls });
  const first = await createMediaArticle(handler, "cached-list-one");
  const second = await createMediaArticle(handler, "cached-list-two");

  for (const documentId of [first.documentId, second.documentId]) {
    const publishResponse = await handler(
      jsonContentRequest(
        `/api/v1/content/${documentId}/publish?fileFields=raw`,
        "POST",
      ),
    );
    assert.equal(publishResponse.status, 200);
  }

  lookupCalls.length = 0;

  const response = await handler(
    new Request("http://localhost/api/v1/content?type=Article", {
      headers: scopeHeaders,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(lookupCalls, [mediaFieldImageAsset.id]);
});

test("content API merges unresolved reference and media resolve errors", async () => {
  const { assets, handler } = createMediaReadHandler();

  const authorResponse = await handler(
    jsonContentRequest("/api/v1/content?fileFields=raw", "POST", {
      path: "authors/unresolved-media-author",
      type: "Author",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "unresolved-media-author",
        name: "Unresolved Media Author",
      },
      body: "author body",
    }),
  );
  const author = (await authorResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(authorResponse.status, 200);

  const article = await createMediaArticle(handler, "resolve-error-merge", {
    author: author.data.documentId,
  });

  const deleteAuthorResponse = await handler(
    jsonContentRequest(`/api/v1/content/${author.data.documentId}`, "DELETE"),
  );
  assert.equal(deleteAuthorResponse.status, 200);
  assets.length = 0;

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?draft=true&resolve=author`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: {
      frontmatter: Record<string, unknown>;
      resolveErrors?: Record<string, { code: string }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.frontmatter.author, null);
  assert.equal(body.data.frontmatter.heroImage, null);
  assert.equal(
    body.data.resolveErrors?.["frontmatter.author"]?.code,
    "REFERENCE_DELETED",
  );
  assert.equal(
    body.data.resolveErrors?.["frontmatter.heroImage"]?.code,
    "MEDIA_NOT_FOUND",
  );
});

test("content API expands file fields inside resolved reference documents", async () => {
  const { handler } = createMediaReadHandler();

  const authorResponse = await handler(
    jsonContentRequest("/api/v1/content?fileFields=raw", "POST", {
      path: "authors/media-author",
      type: "Author",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "media-author",
        name: "Media Author",
        avatar: mediaFieldImageAsset.id,
      },
      body: "author body",
    }),
  );
  const author = (await authorResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(authorResponse.status, 200);

  const article = await createMediaArticle(handler, "resolved-media-author", {
    author: author.data.documentId,
  });

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?draft=true&resolve=author`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };

  assert.equal(response.status, 200);
  const resolvedAuthor = body.data.frontmatter.author as {
    frontmatter: Record<string, unknown>;
  };
  assert.deepEqual(resolvedAuthor.frontmatter.avatar, mediaFieldImageAsset);

  const rawResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}?draft=true&resolve=author&fileFields=raw`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const rawBody = (await rawResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };

  assert.equal(rawResponse.status, 200);
  const rawAuthor = rawBody.data.frontmatter.author as {
    frontmatter: Record<string, unknown>;
  };
  assert.equal(rawAuthor.frontmatter.avatar, mediaFieldImageAsset.id);
});

test("content API expands file fields for typed and mixed list reads", async () => {
  const { handler } = createMediaReadHandler({
    assets: [mediaFieldImageAsset, mediaFieldPdfAsset],
  });
  const article = await createMediaArticle(handler, "typed-list-expansion");
  const galleryResponse = await handler(
    jsonContentRequest("/api/v1/content?fileFields=raw", "POST", {
      path: "galleries/mixed-list-expansion",
      type: "Gallery",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "mixed-list-expansion",
        coverImage: mediaFieldImageAsset.id,
      },
      body: "gallery body",
    }),
  );
  const gallery = (await galleryResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(galleryResponse.status, 200);

  for (const documentId of [article.documentId, gallery.data.documentId]) {
    const publishResponse = await handler(
      jsonContentRequest(
        `/api/v1/content/${documentId}/publish?fileFields=raw`,
        "POST",
      ),
    );
    assert.equal(publishResponse.status, 200);
  }

  const typedResponse = await handler(
    new Request("http://localhost/api/v1/content?type=Article", {
      headers: scopeHeaders,
    }),
  );
  const typed = (await typedResponse.json()) as {
    data: Array<{ documentId: string; frontmatter: Record<string, unknown> }>;
  };
  assert.equal(typedResponse.status, 200);
  assert.deepEqual(
    typed.data.find((document) => document.documentId === article.documentId)
      ?.frontmatter.heroImage,
    mediaFieldImageAsset,
  );

  const mixedResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      headers: scopeHeaders,
    }),
  );
  const mixed = (await mixedResponse.json()) as {
    data: Array<{
      documentId: string;
      type: string;
      frontmatter: Record<string, unknown>;
    }>;
  };
  assert.equal(mixedResponse.status, 200);
  assert.deepEqual(
    mixed.data.find((document) => document.documentId === article.documentId)
      ?.frontmatter.heroImage,
    mediaFieldImageAsset,
  );
  assert.deepEqual(
    mixed.data.find(
      (document) => document.documentId === gallery.data.documentId,
    )?.frontmatter.coverImage,
    mediaFieldImageAsset,
  );
});

test("content API applies fileFields to version detail reads", async () => {
  const { handler } = createMediaReadHandler();
  const article = await createMediaArticle(handler, "version-raw");
  const publishResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/publish?fileFields=raw`,
      "POST",
    ),
  );
  assert.equal(publishResponse.status, 200);

  const rawVersionResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${article.documentId}/versions/1?fileFields=raw`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const rawVersion = (await rawVersionResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(rawVersionResponse.status, 200);
  assert.equal(rawVersion.data.frontmatter.heroImage, mediaFieldImageAsset.id);
});

test("content API applies fileFields to write responses", async () => {
  const { handler } = createMediaReadHandler();

  const rawCreateResponse = await handler(
    jsonContentRequest("/api/v1/content?fileFields=raw", "POST", {
      path: "articles/create-raw",
      type: "Article",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "create-raw",
        heroImage: mediaFieldImageAsset.id,
      },
      body: "raw create body",
    }),
  );
  const rawCreate = (await rawCreateResponse.json()) as {
    data: { documentId: string; frontmatter: Record<string, unknown> };
  };
  assert.equal(rawCreateResponse.status, 200);
  assert.equal(rawCreate.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const expandedCreateResponse = await handler(
    jsonContentRequest("/api/v1/content", "POST", {
      path: "articles/create-expanded",
      type: "Article",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "create-expanded",
        heroImage: mediaFieldImageAsset.id,
      },
      body: "expanded create body",
    }),
  );
  const expandedCreate = (await expandedCreateResponse.json()) as {
    data: { documentId: string; frontmatter: Record<string, unknown> };
  };
  assert.equal(expandedCreateResponse.status, 200);
  assert.deepEqual(
    expandedCreate.data.frontmatter.heroImage,
    mediaFieldImageAsset,
  );

  const rawUpdateResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${expandedCreate.data.documentId}?fileFields=raw`,
      "PUT",
      {
        frontmatter: {
          slug: "create-expanded",
          heroImage: mediaFieldImageAsset.id,
          title: "Raw update",
        },
      },
    ),
  );
  const rawUpdate = (await rawUpdateResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(rawUpdateResponse.status, 200);
  assert.equal(rawUpdate.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const expandedUpdateResponse = await handler(
    jsonContentRequest(`/api/v1/content/${rawCreate.data.documentId}`, "PUT", {
      frontmatter: {
        slug: "create-raw",
        heroImage: mediaFieldImageAsset.id,
        title: "Expanded update",
      },
    }),
  );
  const expandedUpdate = (await expandedUpdateResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(expandedUpdateResponse.status, 200);
  assert.deepEqual(
    expandedUpdate.data.frontmatter.heroImage,
    mediaFieldImageAsset,
  );
});

test("content API duplicate applies fileFields and enforces schema hash gate", async () => {
  const { handler } = createMediaReadHandler();
  const article = await createMediaArticle(handler, "duplicate-file-fields");

  const rawDuplicateResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/duplicate?fileFields=raw`,
      "POST",
      undefined,
      {
        "x-mdcms-schema-hash": inMemorySchemaHash,
      },
    ),
  );
  const rawDuplicate = (await rawDuplicateResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(rawDuplicateResponse.status, 200);
  assert.equal(
    rawDuplicate.data.frontmatter.heroImage,
    mediaFieldImageAsset.id,
  );

  const missingHashResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/duplicate`,
      "POST",
    ),
  );
  const missingHash = (await missingHashResponse.json()) as { code: string };
  assert.equal(missingHashResponse.status, 400);
  assert.equal(missingHash.code, "SCHEMA_HASH_REQUIRED");

  const mismatchResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/duplicate`,
      "POST",
      undefined,
      {
        "x-mdcms-schema-hash": "wrong-hash",
      },
    ),
  );
  const mismatch = (await mismatchResponse.json()) as { code: string };
  assert.equal(mismatchResponse.status, 409);
  assert.equal(mismatch.code, "SCHEMA_HASH_MISMATCH");

  const unsynced = createMediaReadHandler({
    getWriteSchemaSyncState: async () => undefined,
  });
  const source = await unsynced.store.create(
    {
      project: scopeHeaders["x-mdcms-project"],
      environment: scopeHeaders["x-mdcms-environment"],
    },
    {
      path: "articles/duplicate-unsynced",
      type: "Article",
      locale: "en",
      format: "md",
      frontmatter: {
        slug: "duplicate-unsynced",
        heroImage: mediaFieldImageAsset.id,
      },
      body: "unsynced source body",
    },
  );
  const unsyncedResponse = await unsynced.handler(
    jsonContentRequest(
      `/api/v1/content/${source.documentId}/duplicate`,
      "POST",
      undefined,
      {
        "x-mdcms-schema-hash": inMemorySchemaHash,
      },
    ),
  );
  const unsyncedBody = (await unsyncedResponse.json()) as { code: string };
  assert.equal(unsyncedResponse.status, 409);
  assert.equal(unsyncedBody.code, "SCHEMA_NOT_SYNCED");
});

test("content API bulk applies fileFields only to succeeded result documents", async () => {
  const { handler } = createMediaReadHandler();
  const article = await createMediaArticle(handler, "bulk-file-fields");

  const rawBulkResponse = await handler(
    jsonContentRequest("/api/v1/content/bulk?fileFields=raw", "POST", {
      action: "publish",
      documentIds: [article.documentId, "missing-bulk-file-field-doc"],
      changeSummary: "Bulk raw",
    }),
  );
  const rawBulk = (await rawBulkResponse.json()) as {
    data: {
      results: Array<{
        status: "succeeded" | "failed";
        document?: { frontmatter: Record<string, unknown> };
        error?: { code: string };
      }>;
    };
  };
  assert.equal(rawBulkResponse.status, 200);
  assert.equal(rawBulk.data.results[0]?.status, "succeeded");
  assert.equal(
    rawBulk.data.results[0]?.document?.frontmatter.heroImage,
    mediaFieldImageAsset.id,
  );
  assert.equal(rawBulk.data.results[1]?.status, "failed");
  assert.equal(rawBulk.data.results[1]?.document, undefined);

  const expandedBulkResponse = await handler(
    jsonContentRequest("/api/v1/content/bulk", "POST", {
      action: "unpublish",
      documentIds: [article.documentId],
    }),
  );
  const expandedBulk = (await expandedBulkResponse.json()) as {
    data: {
      results: Array<{
        document?: { frontmatter: Record<string, unknown> };
      }>;
    };
  };
  assert.equal(expandedBulkResponse.status, 200);
  assert.deepEqual(
    expandedBulk.data.results[0]?.document?.frontmatter.heroImage,
    mediaFieldImageAsset,
  );
});

test("content API lifecycle endpoints apply raw fileFields to returned documents", async () => {
  const { handler } = createMediaReadHandler();
  const article = await createMediaArticle(handler, "lifecycle-raw");

  const publishResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/publish?fileFields=raw`,
      "POST",
      { changeSummary: "publish raw" },
    ),
  );
  const published = (await publishResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(publishResponse.status, 200);
  assert.equal(published.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const unpublishResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/unpublish?fileFields=raw`,
      "POST",
    ),
  );
  const unpublished = (await unpublishResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(unpublishResponse.status, 200);
  assert.equal(unpublished.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const deleteResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}?fileFields=raw`,
      "DELETE",
    ),
  );
  const deleted = (await deleteResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleted.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const restoreResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/restore?fileFields=raw`,
      "POST",
    ),
  );
  const restored = (await restoreResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(restoreResponse.status, 200);
  assert.equal(restored.data.frontmatter.heroImage, mediaFieldImageAsset.id);

  const updateResponse = await handler(
    jsonContentRequest(`/api/v1/content/${article.documentId}`, "PUT", {
      body: "version two body",
    }),
  );
  assert.equal(updateResponse.status, 200);
  const secondPublishResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/publish?fileFields=raw`,
      "POST",
      { changeSummary: "publish v2" },
    ),
  );
  assert.equal(secondPublishResponse.status, 200);

  const versionRestoreResponse = await handler(
    jsonContentRequest(
      `/api/v1/content/${article.documentId}/versions/1/restore?fileFields=raw`,
      "POST",
      { targetStatus: "draft" },
    ),
  );
  const versionRestore = (await versionRestoreResponse.json()) as {
    data: { frontmatter: Record<string, unknown> };
  };
  assert.equal(versionRestoreResponse.status, 200);
  assert.equal(
    versionRestore.data.frontmatter.heroImage,
    mediaFieldImageAsset.id,
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
  const requestJson = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
          ...headers,
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

test("content API emits webhook events for duplicate and version restore mutations", async () => {
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
  }> = [];
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
        lifecycleEvents: {
          async emitContentEvent(input) {
            emitted.push({
              event: input.event,
              documentId: input.document.documentId,
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
  const requestJson = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...scopeHeaders,
          "content-type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  const createResponse = await requestJson("/api/v1/content", "POST", {
    path: "blog/webhook-restore-source",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "webhook-restore-source" },
    body: "version one body",
  });
  const created = (await createResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(createResponse.status, 200);
  emitted.length = 0;

  const duplicateResponse = await requestJson(
    `/api/v1/content/${created.data.documentId}/duplicate`,
    "POST",
    undefined,
    {
      "x-mdcms-schema-hash": inMemorySchemaHash,
    },
  );
  const duplicated = (await duplicateResponse.json()) as {
    data: { documentId: string };
  };
  assert.equal(duplicateResponse.status, 200);
  assert.deepEqual(emitted, [
    {
      event: "content.created",
      documentId: duplicated.data.documentId,
    },
  ]);

  assert.equal(
    (
      await requestJson(
        `/api/v1/content/${created.data.documentId}/publish`,
        "POST",
        { changeSummary: "publish v1" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await requestJson(`/api/v1/content/${created.data.documentId}`, "PUT", {
        body: "version two body",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await requestJson(
        `/api/v1/content/${created.data.documentId}/publish`,
        "POST",
        { changeSummary: "publish v2" },
      )
    ).status,
    200,
  );
  emitted.length = 0;

  assert.equal(
    (
      await requestJson(
        `/api/v1/content/${created.data.documentId}/versions/1/restore`,
        "POST",
        { targetStatus: "draft" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await requestJson(
        `/api/v1/content/${created.data.documentId}/versions/2/restore`,
        "POST",
        { targetStatus: "published", changeSummary: "republish v2" },
      )
    ).status,
    200,
  );

  assert.deepEqual(emitted, [
    {
      event: "content.updated",
      documentId: created.data.documentId,
    },
    {
      event: "content.published",
      documentId: created.data.documentId,
    },
  ]);
});

test("content API bulk publish returns per-document partial results", async () => {
  const handler = createHandler();
  const first = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-publish-one",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-publish-one" },
      body: "one",
    },
  );

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        documentIds: [first.documentId, "missing-document"],
        changeSummary: "Bulk publish",
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      action: "publish";
      requested: number;
      succeeded: number;
      failed: number;
      results: Array<{
        documentId: string;
        status: string;
        document?: { publishedVersion: number | null };
        error?: { code: string };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.action, "publish");
  assert.equal(body.data.requested, 2);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.documentId, first.documentId);
  assert.equal(body.data.results[0]?.status, "succeeded");
  assert.equal(body.data.results[0]?.document?.publishedVersion, 1);
  assert.equal(body.data.results[1]?.documentId, "missing-document");
  assert.equal(body.data.results[1]?.status, "failed");
  assert.equal(body.data.results[1]?.error?.code, "NOT_FOUND");
});

test("content API update rejects an active collaboration document", async () => {
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/collaboration-locked-update",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "collaboration-locked-update" },
      body: "before",
    },
  );

  activeDocumentIds.add(String(created.documentId));

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "collaboration-locked-update" },
        body: "after",
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: { documentId?: string };
  };

  assert.equal(response.status, 409);
  assert.equal(body.code, "DOCUMENT_COLLABORATION_ACTIVE");
  assert.equal(body.details?.documentId, created.documentId);

  const draftResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}?draft=true`,
      { headers: scopeHeaders },
    ),
  );
  const draft = (await draftResponse.json()) as { data: { body: string } };

  assert.equal(draft.data.body, "before");
});

test("content API update invalidates inactive collaboration cache after successful commit", async () => {
  const invalidated: Array<{ documentId: string; body: string }> = [];
  let handler: ReturnType<typeof createHandler>;
  handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        const draftResponse = await handler(
          new Request(
            `http://localhost/api/v1/content/${documentId}?draft=true`,
            { headers: scopeHeaders },
          ),
        );
        const draft = (await draftResponse.json()) as {
          data: { body: string };
        };

        invalidated.push({ documentId, body: draft.data.body });
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidate-after-update",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidate-after-update" },
      body: "before",
    },
  );
  const documentId = String(created.documentId);

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "invalidate-after-update" },
        body: "after",
        draftRevision: created.draftRevision,
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [{ documentId, body: "after" }]);
});

test("content API delete invalidates inactive collaboration cache after successful commit", async () => {
  const invalidated: string[] = [];
  const handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidate-after-delete",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidate-after-delete" },
      body: "delete me",
    },
  );
  const documentId = String(created.documentId);

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}`, {
      method: "DELETE",
      headers: { ...scopeHeaders, "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [documentId]);
});

test("content API does not invalidate inactive collaboration cache when active collaboration blocks update", async () => {
  const invalidated: string[] = [];
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/no-invalidate-when-active",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "no-invalidate-when-active" },
      body: "before",
    },
  );
  const documentId = String(created.documentId);

  activeDocumentIds.add(documentId);

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "no-invalidate-when-active" },
        body: "after",
      }),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(invalidated, []);
});

test("content API update remains successful when inactive collaboration cache invalidation fails", async () => {
  const attempted: string[] = [];
  const handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        attempted.push(documentId);
        throw new Error("redis unavailable");
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidation-failure-still-updates",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidation-failure-still-updates" },
      body: "before",
    },
  );
  const documentId = String(created.documentId);

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "invalidation-failure-still-updates" },
        body: "after",
        draftRevision: created.draftRevision,
      }),
    }),
  );
  const body = (await response.json()) as { data: { body: string } };

  assert.equal(response.status, 200);
  assert.equal(body.data.body, "after");
  assert.deepEqual(attempted, [documentId]);

  const draftResponse = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}?draft=true`, {
      headers: scopeHeaders,
    }),
  );
  const draft = (await draftResponse.json()) as { data: { body: string } };

  assert.equal(draftResponse.status, 200);
  assert.equal(draft.data.body, "after");
});

test("content API create remains allowed while another document is active", async () => {
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => documentId === "locked-document",
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        path: "blog/create-while-collaboration-active",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "create-while-collaboration-active" },
        body: "new document",
      }),
    }),
  );
  const body = (await response.json()) as {
    data: { documentId: string; body: string };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.body, "new document");
});

test("content API bulk delete reports active collaboration per document and continues", async () => {
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
  });
  const locked = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-collaboration-locked",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-collaboration-locked" },
      body: "locked",
    },
  );
  const unlocked = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-collaboration-unlocked",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-collaboration-unlocked" },
      body: "unlocked",
    },
  );

  activeDocumentIds.add(String(locked.documentId));

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        documentIds: [locked.documentId, unlocked.documentId],
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      requested: number;
      succeeded: number;
      failed: number;
      results: Array<{
        documentId: string;
        status: string;
        document?: { documentId: string; isDeleted: boolean };
        error?: { code: string; details?: { documentId?: string } };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.requested, 2);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.documentId, locked.documentId);
  assert.equal(body.data.results[0]?.status, "failed");
  assert.equal(
    body.data.results[0]?.error?.code,
    "DOCUMENT_COLLABORATION_ACTIVE",
  );
  assert.equal(
    body.data.results[0]?.error?.details?.documentId,
    locked.documentId,
  );
  assert.equal(body.data.results[1]?.documentId, unlocked.documentId);
  assert.equal(body.data.results[1]?.status, "succeeded");
  assert.equal(body.data.results[1]?.document?.isDeleted, true);
});

test("content API bulk delete invalidates inactive collaboration cache for successful documents only", async () => {
  const invalidated: string[] = [];
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const locked = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-invalidate-delete-locked",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-invalidate-delete-locked" },
      body: "locked",
    },
  );
  const unlocked = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-invalidate-delete-unlocked",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-invalidate-delete-unlocked" },
      body: "unlocked",
    },
  );
  const lockedDocumentId = String(locked.documentId);
  const unlockedDocumentId = String(unlocked.documentId);

  activeDocumentIds.add(lockedDocumentId);

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        documentIds: [lockedDocumentId, unlockedDocumentId],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [unlockedDocumentId]);
});

test("content API restore rejects an active collaboration document", async () => {
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/collaboration-locked-restore",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "collaboration-locked-restore" },
      body: "restore me",
    },
  );

  const deleteResponse = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );

  assert.equal(deleteResponse.status, 200);
  activeDocumentIds.add(String(created.documentId));

  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}/restore`,
      {
        method: "POST",
        headers: scopeHeaders,
      },
    ),
  );
  const body = (await response.json()) as {
    code: string;
    details?: { documentId?: string };
  };

  assert.equal(response.status, 409);
  assert.equal(body.code, "DOCUMENT_COLLABORATION_ACTIVE");
  assert.equal(body.details?.documentId, created.documentId);
});

test("content API bulk rejects duplicate document IDs", async () => {
  const handler = createHandler();

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        documentIds: ["duplicate-document", "duplicate-document"],
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: { field?: string };
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(body.details?.field, "documentIds");
});

test("content API bulk trims document IDs before uniqueness validation", async () => {
  const handler = createHandler();

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        documentIds: [" duplicate-document ", "duplicate-document"],
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: { field?: string };
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(body.details?.field, "documentIds");
});

test("content API bulk move constructs archive slug paths and updates drafts", async () => {
  const handler = createHandler();
  const document = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-move-slug",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-move-slug" },
      body: "move me",
    },
  );

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [document.documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      requested: number;
      succeeded: number;
      failed: number;
      results: Array<{
        status: string;
        document?: { documentId: string; path: string; draftRevision: number };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.requested, 1);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 0);
  assert.equal(body.data.results[0]?.status, "succeeded");
  assert.equal(body.data.results[0]?.document?.path, "archive/bulk-move-slug");

  const draftResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${document.documentId}?draft=true`,
      {
        headers: scopeHeaders,
      },
    ),
  );
  const draft = (await draftResponse.json()) as {
    data: { path: string; draftRevision: number };
  };

  assert.equal(draftResponse.status, 200);
  assert.equal(draft.data.path, "archive/bulk-move-slug");
  assert.equal(draft.data.draftRevision, 2);
});

test("content API bulk move invalidates inactive collaboration cache after successful commit", async () => {
  const invalidated: Array<{ documentId: string; path: string }> = [];
  let handler: ReturnType<typeof createHandler>;
  handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        const draftResponse = await handler(
          new Request(
            `http://localhost/api/v1/content/${documentId}?draft=true`,
            { headers: scopeHeaders },
          ),
        );
        const draft = (await draftResponse.json()) as {
          data: { path: string };
        };

        invalidated.push({ documentId, path: draft.data.path });
      },
    },
  });
  const document = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-invalidate-move",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-invalidate-move" },
      body: "move me",
    },
  );
  const documentId = String(document.documentId);

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [
    { documentId, path: "archive/bulk-invalidate-move" },
  ]);
});

test("content API bulk move requires schema hash when write schema state exists", async () => {
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
    path: "blog/bulk-move-needs-hash",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-needs-hash" },
    body: "move me",
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
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [document.documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 400);
  assert.equal(body.code, "SCHEMA_HASH_REQUIRED");
});

test("content API bulk rejects changeSummary for actions other than publish", async () => {
  const handler = createHandler();

  for (const action of ["unpublish", "delete", "move"] as const) {
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          documentIds: [`bulk-${action}-change-summary`],
          changeSummary: "not allowed",
          ...(action === "move"
            ? { move: { targetDirectory: "archive" } }
            : undefined),
        }),
      }),
    );
    const body = (await response.json()) as {
      code: string;
      details?: { field?: string; action?: string };
    };

    assert.equal(response.status, 400);
    assert.equal(body.code, "INVALID_INPUT");
    assert.equal(body.details?.field, "changeSummary");
    assert.equal(body.details?.action, action);
  }
});

test("content API bulk rejects actorId for delete and move", async () => {
  const handler = createHandler();

  for (const action of ["delete", "move"] as const) {
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          documentIds: [`bulk-${action}-actor`],
          actorId: "user-2",
          ...(action === "move"
            ? { move: { targetDirectory: "archive" } }
            : undefined),
        }),
      }),
    );
    const body = (await response.json()) as {
      code: string;
      details?: { field?: string; action?: string };
    };

    assert.equal(response.status, 400);
    assert.equal(body.code, "INVALID_INPUT");
    assert.equal(body.details?.field, "actorId");
    assert.equal(body.details?.action, action);
  }
});

test("content API bulk rejects move payloads for non-move actions", async () => {
  const handler = createHandler();

  for (const action of ["publish", "unpublish", "delete"] as const) {
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          documentIds: [`bulk-${action}-move-payload`],
          move: {
            targetDirectory: "archive",
          },
        }),
      }),
    );
    const body = (await response.json()) as {
      code: string;
      details?: { field?: string; action?: string };
    };

    assert.equal(response.status, 400);
    assert.equal(body.code, "INVALID_INPUT");
    assert.equal(body.details?.field, "move");
    assert.equal(body.details?.action, action);
  }
});

test("content API bulk validates documentIds shape", async () => {
  const handler = createHandler();

  for (const [label, documentIds] of [
    ["empty", []],
    ["too-many", Array.from({ length: 101 }, (_, index) => `doc-${index}`)],
    ["empty-string", [""]],
    ["whitespace-string", ["   "]],
    ["non-string", [123]],
  ] as const) {
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          documentIds,
        }),
      }),
    );
    const body = (await response.json()) as {
      code: string;
      details?: { field?: string };
    };

    assert.equal(response.status, 400, label);
    assert.equal(body.code, "INVALID_INPUT", label);
    assert.equal(body.details?.field, "documentIds", label);
  }
});

test("content API bulk rejects invalid move target directories", async () => {
  const handler = createHandler();

  for (const [label, input] of [
    [
      "missing move object",
      {
        action: "move",
        documentIds: ["bulk-missing-move-object"],
      },
    ],
    [
      "missing targetDirectory",
      {
        action: "move",
        documentIds: ["bulk-missing-target-directory"],
        move: {},
      },
    ],
    [
      "non-string targetDirectory",
      {
        action: "move",
        documentIds: ["bulk-non-string-target-directory"],
        move: { targetDirectory: 123 },
      },
    ],
    [
      "leading slash",
      {
        action: "move",
        documentIds: ["bulk-leading-slash-target-directory"],
        move: { targetDirectory: "/archive" },
      },
    ],
    [
      "trailing slash",
      {
        action: "move",
        documentIds: ["bulk-trailing-slash-target-directory"],
        move: { targetDirectory: "archive/" },
      },
    ],
    [
      "path traversal",
      {
        action: "move",
        documentIds: ["bulk-path-traversal-target-directory"],
        move: { targetDirectory: "archive/../drafts" },
      },
    ],
  ] as const) {
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    const body = (await response.json()) as {
      code: string;
      details?: { field?: string };
    };

    assert.equal(response.status, 400, label);
    assert.equal(body.code, "INVALID_INPUT", label);
    assert.equal(body.details?.field, "move.targetDirectory", label);
  }
});

test("content API bulk move accepts an empty target directory for root moves", async () => {
  const handler = createHandler();
  const document = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-move-to-root",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-move-to-root" },
      body: "move me to root",
    },
  );

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [document.documentId],
        move: {
          targetDirectory: "   ",
        },
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      succeeded: number;
      failed: number;
      results: Array<{
        status: string;
        document?: { path: string };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 0);
  assert.equal(body.data.results[0]?.status, "succeeded");
  assert.equal(body.data.results[0]?.document?.path, "bulk-move-to-root");
});

test("content API bulk requires CSRF before authorization", async () => {
  let authorizeCalls = 0;
  const store = createInMemoryContentStore({
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async () => {
          authorizeCalls += 1;
          return authorizeTestRequest();
        },
        requireCsrf: async () => {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message:
              "Valid CSRF token is required for session-authenticated state-changing requests.",
            statusCode: 403,
          });
        },
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        documentIds: ["bulk-csrf-document"],
      }),
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(authorizeCalls, 0);
});

test("content API bulk authorizes the required global scope for each action", async () => {
  for (const [action, expectedScope] of [
    ["publish", "content:publish"],
    ["unpublish", "content:publish"],
    ["delete", "content:delete"],
    ["move", "content:write"],
  ] as const) {
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

    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          documentIds: [`missing-${action}-document`],
          ...(action === "move"
            ? { move: { targetDirectory: "archive" } }
            : undefined),
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(authorizeCalls, [
      {
        requiredScope: expectedScope,
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
      },
    ]);
  }
});

test("content API bulk reports current path authorization failures per document and continues", async () => {
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
  const forbidden = await store.create(scope, {
    path: "blog/bulk-current-path-forbidden",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-current-path-forbidden" },
    body: "forbidden",
  });
  const allowed = await store.create(scope, {
    path: "blog/bulk-current-path-allowed",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-current-path-allowed" },
    body: "allowed",
  });
  const pathAuthorizeCalls: string[] = [];
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (requirement.documentPath) {
            pathAuthorizeCalls.push(requirement.documentPath);
          }

          if (requirement.documentPath === forbidden.path) {
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
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        documentIds: [forbidden.documentId, allowed.documentId],
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      succeeded: number;
      failed: number;
      results: Array<{
        documentId: string;
        status: string;
        document?: { publishedVersion: number | null };
        error?: { code: string; statusCode: number };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.documentId, forbidden.documentId);
  assert.equal(body.data.results[0]?.status, "failed");
  assert.equal(body.data.results[0]?.error?.code, "FORBIDDEN");
  assert.equal(body.data.results[0]?.error?.statusCode, 403);
  assert.equal(body.data.results[1]?.documentId, allowed.documentId);
  assert.equal(body.data.results[1]?.status, "succeeded");
  assert.equal(body.data.results[1]?.document?.publishedVersion, 1);
  assert.deepEqual(pathAuthorizeCalls, [forbidden.path, allowed.path]);
});

test("content API bulk reports move destination authorization failures per document and continues", async () => {
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
  const forbidden = await store.create(scope, {
    path: "blog/bulk-move-destination-forbidden",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-destination-forbidden" },
    body: "forbidden",
  });
  const allowed = await store.create(scope, {
    path: "blog/bulk-move-destination-allowed",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-destination-allowed" },
    body: "allowed",
  });
  const forbiddenDestination = "archive/bulk-move-destination-forbidden";
  const allowedDestination = "archive/bulk-move-destination-allowed";
  const pathAuthorizeCalls: string[] = [];
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (requirement.documentPath) {
            pathAuthorizeCalls.push(requirement.documentPath);
          }

          if (requirement.documentPath === forbiddenDestination) {
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
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [forbidden.documentId, allowed.documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      succeeded: number;
      failed: number;
      results: Array<{
        documentId: string;
        status: string;
        document?: { path: string };
        error?: { code: string; statusCode: number };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.documentId, forbidden.documentId);
  assert.equal(body.data.results[0]?.status, "failed");
  assert.equal(body.data.results[0]?.error?.code, "FORBIDDEN");
  assert.equal(body.data.results[0]?.error?.statusCode, 403);
  assert.equal(body.data.results[1]?.documentId, allowed.documentId);
  assert.equal(body.data.results[1]?.status, "succeeded");
  assert.equal(body.data.results[1]?.document?.path, allowedDestination);
  assert.deepEqual(pathAuthorizeCalls, [
    forbidden.path,
    forbiddenDestination,
    allowed.path,
    allowedDestination,
  ]);
});

test("content API bulk move rethrows schema hash mismatch from item mutation", async () => {
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
    path: "blog/bulk-move-schema-hash-mismatch",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-schema-hash-mismatch" },
    body: "move me",
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store: {
          ...store,
          async update() {
            throw new RuntimeError({
              code: "SCHEMA_HASH_MISMATCH",
              message:
                "Client schema hash does not match the server schema hash for the target project/environment.",
              statusCode: 409,
            });
          },
        },
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
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [document.documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );
  const body = (await response.json()) as { code: string; data?: unknown };

  assert.equal(response.status, 409);
  assert.equal(body.code, "SCHEMA_HASH_MISMATCH");
  assert.equal(body.data, undefined);
});

test("content API bulk move reports item-level invalid input from mutations and continues", async () => {
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
  const invalid = await store.create(scope, {
    path: "blog/bulk-move-invalid-input",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-invalid-input" },
    body: "invalid",
  });
  const valid = await store.create(scope, {
    path: "blog/bulk-move-valid-after-invalid-input",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-move-valid-after-invalid-input" },
    body: "valid",
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store: {
          ...store,
          async update(updateScope, documentId, payload, options) {
            if (documentId === invalid.documentId) {
              throw new RuntimeError({
                code: "INVALID_INPUT",
                message: "Field validation failed for this document.",
                statusCode: 400,
                details: { documentId },
              });
            }

            return store.update(updateScope, documentId, payload, options);
          },
        },
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
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "move",
        documentIds: [invalid.documentId, valid.documentId],
        move: {
          targetDirectory: "archive",
        },
      }),
    }),
  );
  const body = (await response.json()) as {
    data: {
      succeeded: number;
      failed: number;
      results: Array<{
        documentId: string;
        status: string;
        document?: { path: string };
        error?: { code: string; statusCode: number };
      }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.documentId, invalid.documentId);
  assert.equal(body.data.results[0]?.status, "failed");
  assert.equal(body.data.results[0]?.error?.code, "INVALID_INPUT");
  assert.equal(body.data.results[0]?.error?.statusCode, 400);
  assert.equal(body.data.results[1]?.documentId, valid.documentId);
  assert.equal(body.data.results[1]?.status, "succeeded");
  assert.equal(
    body.data.results[1]?.document?.path,
    "archive/bulk-move-valid-after-invalid-input",
  );
});

test("content API bulk rethrows unauthorized errors from per-document authorization", async () => {
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
    path: "blog/bulk-path-unauthorized",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-path-unauthorized" },
    body: "publish me",
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (requirement.documentPath === document.path) {
            throw new RuntimeError({
              code: "UNAUTHORIZED",
              message: "Authentication required.",
              statusCode: 401,
            });
          }

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

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        documentIds: [document.documentId],
      }),
    }),
  );
  const body = (await response.json()) as { code: string; data?: unknown };

  assert.equal(response.status, 401);
  assert.equal(body.code, "UNAUTHORIZED");
  assert.equal(body.data, undefined);
});

test("content API bulk operations emit lifecycle events per successful document", async () => {
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
  }> = [];
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
        lifecycleEvents: {
          async emitContentEvent(input) {
            emitted.push({
              event: input.event,
              documentId: input.document.documentId,
            });
          },
        },
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });
  const handler = wrapHandlerWithAutoSchemaHash(
    rawHandler,
    () => inMemorySchemaHash,
  );
  const first = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-event-one",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-event-one" },
      body: "one",
    },
  );
  const second = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/bulk-event-two",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "bulk-event-two" },
      body: "two",
    },
  );
  emitted.length = 0;

  const response = await handler(
    new Request("http://localhost/api/v1/content/bulk", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish",
        documentIds: [
          first.documentId,
          "missing-bulk-event-document",
          second.documentId,
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(emitted, [
    {
      event: "content.published",
      documentId: first.documentId,
    },
    {
      event: "content.published",
      documentId: second.documentId,
    },
  ]);
});

test("content API bulk unpublish delete and move emit lifecycle events per successful document", async () => {
  for (const [action, event] of [
    ["unpublish", "content.unpublished"],
    ["delete", "content.deleted"],
    ["move", "content.updated"],
  ] as const) {
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
    }> = [];
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
          lifecycleEvents: {
            async emitContentEvent(input) {
              emitted.push({
                event: input.event,
                documentId: input.document.documentId,
              });
            },
          },
        });
      },
      now: () => new Date("2026-03-02T10:00:00.000Z"),
    });
    const handler = wrapHandlerWithAutoSchemaHash(
      rawHandler,
      () => inMemorySchemaHash,
    );
    const first = await createContentDocument(
      handler,
      (headers = {}) => headers,
      scopeHeaders,
      {
        path: `blog/bulk-${action}-event-one`,
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: `bulk-${action}-event-one` },
        body: "one",
      },
    );
    const second = await createContentDocument(
      handler,
      (headers = {}) => headers,
      scopeHeaders,
      {
        path: `blog/bulk-${action}-event-two`,
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: `bulk-${action}-event-two` },
        body: "two",
      },
    );

    if (action === "unpublish") {
      assert.equal(
        (
          await handler(
            new Request(
              `http://localhost/api/v1/content/${first.documentId}/publish`,
              {
                method: "POST",
                headers: {
                  ...scopeHeaders,
                  "content-type": "application/json",
                },
                body: JSON.stringify({}),
              },
            ),
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await handler(
            new Request(
              `http://localhost/api/v1/content/${second.documentId}/publish`,
              {
                method: "POST",
                headers: {
                  ...scopeHeaders,
                  "content-type": "application/json",
                },
                body: JSON.stringify({}),
              },
            ),
          )
        ).status,
        200,
      );
    }

    emitted.length = 0;
    const response = await handler(
      new Request("http://localhost/api/v1/content/bulk", {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          action,
          documentIds: [
            first.documentId,
            `missing-bulk-${action}-event-document`,
            second.documentId,
          ],
          ...(action === "move"
            ? { move: { targetDirectory: "archive" } }
            : undefined),
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(emitted, [
      {
        event,
        documentId: first.documentId,
      },
      {
        event,
        documentId: second.documentId,
      },
    ]);
  }
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

test("content API authorizes draft search before listing content", async () => {
  let listCalls = 0;
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
        store: {
          ...store,
          async list(scope, query) {
            listCalls += 1;
            return store.list(scope, query);
          },
        },
        authorize: async (_request, requirement) => {
          assert.equal(requirement.requiredScope, "content:read:draft");
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
    new Request("http://localhost/api/v1/content?draft=true&q=secret", {
      headers: scopeHeaders,
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.equal(listCalls, 0);
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

testWithDatabase(
  "database content API draft search includes explicitly requested deleted documents",
  async () => {
    const context = await createDatabaseTestContext(
      "test:content-api-draft-search-deleted",
    );
    const project = `db-draft-search-${stableFixtureName(randomUUID())}`;
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
    };

    try {
      const deleted = (await createContentDocument(
        context.handler,
        context.csrfHeaders,
        testScopeHeaders,
        {
          path: `blog/${stableFixtureName("deleted draft search")}`,
          type: "BlogPost",
          locale: "en",
          format: "md",
          frontmatter: { slug: "deleted-draft-search" },
          body: "soft deleted draft search body",
        },
      )) as { documentId: string };

      const deleteResponse = await context.handler(
        new Request(`http://localhost/api/v1/content/${deleted.documentId}`, {
          method: "DELETE",
          headers: context.csrfHeaders(testScopeHeaders),
        }),
      );
      assert.equal(deleteResponse.status, 200);

      const searchResponse = await context.handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&isDeleted=true&q=soft%20deleted%20draft%20search&sort=path&order=asc",
          {
            headers: context.csrfHeaders(testScopeHeaders),
          },
        ),
      );
      const searchBody = (await searchResponse.json()) as {
        data: Array<{
          documentId: string;
          body: string;
          isDeleted: boolean;
        }>;
      };

      assert.equal(searchResponse.status, 200);
      assert.deepEqual(
        searchBody.data.map((document) => ({
          documentId: document.documentId,
          body: document.body,
          isDeleted: document.isDeleted,
        })),
        [
          {
            documentId: deleted.documentId,
            body: "soft deleted draft search body",
            isDeleted: true,
          },
        ],
      );
    } finally {
      await context.dbConnection.close();
    }
  },
);

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

test("content API version restore invalidates inactive collaboration cache after commit and ignores failure", async () => {
  const invalidated: Array<{ documentId: string; body: string }> = [];
  let handler: ReturnType<typeof createHandler>;
  handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        const draftResponse = await handler(
          new Request(
            `http://localhost/api/v1/content/${documentId}?draft=true`,
            { headers: scopeHeaders },
          ),
        );
        const draft = (await draftResponse.json()) as {
          data: { body: string };
        };

        invalidated.push({ documentId, body: draft.data.body });
        throw new Error("redis unavailable");
      },
    },
  });

  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "blog/restore-version-invalidate",
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: {
          slug: "restore-version-invalidate",
          title: "Version One",
        },
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
        headers: scopeHeaders,
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
        frontmatter: {
          slug: "restore-version-invalidate",
          title: "Version Two",
        },
        body: "version two body",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);
  invalidated.length = 0;

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
    data: { body: string };
  };

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreBody.data.body, "version one body");
  assert.deepEqual(invalidated, [
    { documentId: created.data.documentId, body: "version one body" },
  ]);
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

  const longSearchResponse = await handler(
    new Request(`http://localhost/api/v1/content?q=${"x".repeat(201)}`, {
      headers: scopeHeaders,
    }),
  );
  const longSearchBody = (await longSearchResponse.json()) as {
    code: string;
    details?: Record<string, unknown>;
  };

  assert.equal(longSearchResponse.status, 400);
  assert.equal(longSearchBody.code, "INVALID_QUERY_PARAM");
  assert.equal(longSearchBody.details?.field, "q");

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
