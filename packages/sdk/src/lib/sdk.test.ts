import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
  ErrorEnvelope,
  MediaAsset,
} from "@mdcms/shared";
import {
  appendMdcmsPreviewTokenToUrl,
  signMdcmsPreviewToken,
} from "@mdcms/shared";

import {
  MdcmsApiError,
  MdcmsClientError,
  createClient,
  verifyMdcmsPreviewRequest,
} from "./sdk.js";

function createContentListResponse(
  rows: ContentDocumentResponse[],
): ApiPaginatedEnvelope<ContentDocumentResponse> {
  return {
    data: rows,
    pagination: {
      total: rows.length,
      limit: 20,
      offset: 0,
      hasMore: false,
    },
  };
}

function createBlogPostDocument(
  frontmatter: Record<string, unknown>,
): ContentDocumentResponse {
  return {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter,
    body: "Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };
}

const expandedHeroImage: MediaAsset = {
  id: "media-hero",
  project: "marketing-site",
  filename: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 12345,
  url: "https://cdn.example.com/media/hero.jpg",
  uploadedBy: "33333333-3333-3333-3333-333333333333",
  uploadedAt: "2026-06-09T12:00:00.000Z",
};

test("createClient list unwraps the paginated content envelope", async () => {
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost",
      );
      assert.equal(init?.method, "GET");
      assert.equal(
        (init?.headers as Headers).get("authorization"),
        "Bearer mdcms_key_test",
      );
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-project"),
        "marketing-site",
      );
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-environment"),
        "production",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.list("BlogPost");

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.documentId, document.documentId);
  assert.equal(result.pagination.total, 1);
  assert.equal(result.pagination.hasMore, false);
});

test("createClient list defaults to expanded schema file fields", async () => {
  const document = createBlogPostDocument({
    title: "Hello World",
    slug: "hello-world",
    heroImage: expandedHeroImage,
  });

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.list("BlogPost");

  assert.deepEqual(result.data[0]?.frontmatter.heroImage, expandedHeroImage);
});

test("createClient list sends raw schema file fields when requested", async () => {
  const document = createBlogPostDocument({
    title: "Hello World",
    slug: "hello-world",
    heroImage: "media-hero",
  });

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost&fileFields=raw",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.list("BlogPost", { fileFields: "raw" });

  assert.equal(result.data[0]?.frontmatter.heroImage, "media-hero");
});

test("createClient list throws MdcmsApiError for API error envelopes", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async () => {
      const envelope: ErrorEnvelope = {
        status: "error",
        code: "FORBIDDEN",
        message: "Forbidden.",
        details: {
          requiredScope: "content:read",
        },
        requestId: "req-123",
        timestamp: "2026-03-26T12:00:00.000Z",
      };

      return new Response(JSON.stringify(envelope), {
        status: 403,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  await assert.rejects(
    () => client.list("BlogPost"),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsApiError, true);
      if (!(error instanceof MdcmsApiError)) {
        return false;
      }

      assert.equal(error.statusCode, 403);
      assert.equal(error.code, "FORBIDDEN");
      assert.equal(error.message, "Forbidden.");
      assert.equal(error.requestId, "req-123");
      assert.equal(error.timestamp, "2026-03-26T12:00:00.000Z");
      assert.deepEqual(error.details, {
        requiredScope: "content:read",
      });
      return true;
    },
  );
});

test("createClient list throws MdcmsClientError for malformed success payloads", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async () =>
      new Response(
        JSON.stringify({
          pagination: {
            total: 0,
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
      ),
  });

  await assert.rejects(
    () => client.list("BlogPost"),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsClientError, true);
      if (!(error instanceof MdcmsClientError)) {
        return false;
      }

      assert.equal(error.code, "INVALID_RESPONSE");
      assert.match(error.message, /response\.data/i);
      return true;
    },
  );
});

test("createClient get by id unwraps a single-document envelope", async () => {
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111",
      );
      assert.equal(init?.method, "GET");

      return new Response(
        JSON.stringify({
          data: document,
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

  const result = await client.get("BlogPost", {
    id: "11111111-1111-1111-1111-111111111111",
  });

  assert.equal(result.documentId, document.documentId);
  assert.equal(result.type, "BlogPost");
});

test("createClient get by id defaults to expanded schema file fields", async () => {
  const document = createBlogPostDocument({
    title: "Hello World",
    slug: "hello-world",
    heroImage: expandedHeroImage,
  });

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111",
      );

      return new Response(JSON.stringify({ data: document }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.get("BlogPost", {
    id: "11111111-1111-1111-1111-111111111111",
  });

  assert.deepEqual(result.frontmatter.heroImage, expandedHeroImage);
});

test("createClient get by id sends raw schema file fields when requested", async () => {
  const document = createBlogPostDocument({
    title: "Hello World",
    slug: "hello-world",
    heroImage: "media-hero",
  });

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111?fileFields=raw",
      );

      return new Response(JSON.stringify({ data: document }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.get("BlogPost", {
    id: "11111111-1111-1111-1111-111111111111",
    fileFields: "raw",
  });

  assert.equal(result.frontmatter.heroImage, "media-hero");
});

test("createClient get by slug resolves a single typed list match", async () => {
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost&slug=hello-world",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.get("BlogPost", { slug: "hello-world" });

  assert.equal(result.documentId, document.documentId);
});

test("createClient get by slug sends raw schema file fields through list lookup", async () => {
  const document = createBlogPostDocument({
    title: "Hello World",
    slug: "hello-world",
    heroImage: "media-hero",
  });

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost&slug=hello-world&fileFields=raw",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.get("BlogPost", {
    slug: "hello-world",
    fileFields: "raw",
  });

  assert.equal(result.frontmatter.heroImage, "media-hero");
});

test("createClient get by slug throws MdcmsClientError when no documents match", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async () =>
      new Response(JSON.stringify(createContentListResponse([])), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
  });

  await assert.rejects(
    () => client.get("BlogPost", { slug: "hello-world" }),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsClientError, true);
      if (!(error instanceof MdcmsClientError)) {
        return false;
      }

      assert.equal(error.code, "NOT_FOUND");
      return true;
    },
  );
});

test("createClient get by slug throws MdcmsClientError when multiple documents match", async () => {
  const first: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };
  const second: ContentDocumentResponse = {
    ...first,
    documentId: "44444444-4444-4444-4444-444444444444",
    path: "blog/hello-world-2",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async () =>
      new Response(JSON.stringify(createContentListResponse([first, second])), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
  });

  await assert.rejects(
    () => client.get("BlogPost", { slug: "hello-world" }),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsClientError, true);
      if (!(error instanceof MdcmsClientError)) {
        return false;
      }

      assert.equal(error.code, "AMBIGUOUS_RESULT");
      return true;
    },
  );
});

test("createClient list allows per-call routing overrides", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-project"),
        "docs-site",
      );
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-environment"),
        "staging",
      );

      return new Response(JSON.stringify(createContentListResponse([])), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.list("BlogPost", {
    project: "docs-site",
    environment: "staging",
  });

  assert.equal(result.pagination.total, 0);
});

test("createClient list serializes locale, resolve, and draft query parameters", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost&locale=fr&resolve=author&resolve=hero.author&draft=true",
      );

      return new Response(JSON.stringify(createContentListResponse([])), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  await client.list("BlogPost", {
    locale: "fr",
    resolve: ["author", "hero.author"],
    draft: true,
  });
});

test("createClient get by id serializes locale, resolve, and draft query parameters", async () => {
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "fr",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Bonjour",
      slug: "bonjour",
    },
    body: "Bonjour le monde",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111?locale=fr&resolve=author&resolve=hero.author&draft=true",
      );

      return new Response(JSON.stringify({ data: document }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.get("BlogPost", {
    id: "11111111-1111-1111-1111-111111111111",
    locale: "fr",
    resolve: ["author", "hero.author"],
    draft: true,
  });

  assert.equal(result.locale, "fr");
});

test("createClient get by slug serializes locale and repeated resolve query parameters", async () => {
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/bonjour",
    type: "BlogPost",
    locale: "fr",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Bonjour",
      slug: "bonjour",
    },
    body: "Bonjour le monde",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };

  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content?type=BlogPost&locale=fr&resolve=author&resolve=hero.author&slug=bonjour",
      );

      return new Response(
        JSON.stringify(createContentListResponse([document])),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });

  const result = await client.get("BlogPost", {
    slug: "bonjour",
    locale: "fr",
    resolve: ["author", "hero.author"],
  });

  assert.equal(result.locale, "fr");
});

test("verifyMdcmsPreviewRequest extracts and verifies preview tokens from request URLs", async () => {
  const previewUrl = "https://preview.example.com/blog/hello?preview=true";
  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    now: new Date("2026-06-02T10:00:00.000Z"),
    claims: {
      project: "marketing-site",
      environment: "production",
      documentId: "11111111-1111-1111-1111-111111111111",
      type: "BlogPost",
      path: "blog/hello-world",
      locale: "en",
      draftRevision: 5,
      previewUrl,
    },
  });

  const result = await verifyMdcmsPreviewRequest(
    new Request(appendMdcmsPreviewTokenToUrl(previewUrl, token)),
    {
      secret: "test-preview-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
      expected: {
        documentId: "11111111-1111-1111-1111-111111111111",
        previewUrl,
      },
    },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.type, "BlogPost");
    assert.equal(result.claims.draftRevision, 5);
  }
});

test("createClient getPreviewDocumentFromRequest verifies the token and fetches the draft document", async () => {
  const previewUrl = "https://preview.example.com/blog/hello?preview=true";
  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    now: new Date("2026-06-02T10:00:00.000Z"),
    claims: {
      project: "marketing-site",
      environment: "staging",
      documentId: "11111111-1111-1111-1111-111111111111",
      type: "BlogPost",
      path: "blog/hello-world",
      locale: "en",
      draftRevision: 5,
      previewUrl,
    },
  });
  const document: ContentDocumentResponse = {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "staging",
    path: "blog/hello-world",
    type: "BlogPost",
    locale: "en",
    format: "md",
    isDeleted: false,
    hasUnpublishedChanges: true,
    version: 3,
    publishedVersion: 2,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "Draft body",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
  };
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "fallback-project",
    environment: "fallback-environment",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(input),
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111?locale=en&resolve=author&draft=true",
      );
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-project"),
        "marketing-site",
      );
      assert.equal(
        (init?.headers as Headers).get("x-mdcms-environment"),
        "staging",
      );

      return new Response(JSON.stringify({ data: document }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  const result = await client.getPreviewDocumentFromRequest(
    new Request(appendMdcmsPreviewTokenToUrl(previewUrl, token)),
    {
      secret: "test-preview-secret",
      now: new Date("2026-06-02T10:01:00.000Z"),
      expected: { previewUrl },
      resolve: ["author"],
    },
  );

  assert.equal(result.documentId, document.documentId);
  assert.equal(result.body, "Draft body");
});

test("createClient getPreviewDocumentFromRequest rejects invalid preview requests before fetching drafts", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async () => {
      throw new Error("draft fetch should not run");
    },
  });

  await assert.rejects(
    () =>
      client.getPreviewDocumentFromRequest(
        new Request("https://preview.example.com/blog/hello?preview=true"),
        { secret: "test-preview-secret" },
      ),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsClientError, true);
      if (!(error instanceof MdcmsClientError)) {
        return false;
      }

      assert.equal(error.code, "PREVIEW_TOKEN_INVALID");
      assert.match(error.message, /missing/i);
      return true;
    },
  );
});
