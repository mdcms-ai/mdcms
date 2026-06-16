import { expect, test } from "bun:test";

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

async function expectRejected(
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject.");
}

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
      expect(String(input)).toBe(
        "http://localhost:4000/api/v1/content?type=BlogPost",
      );
      expect(init?.method).toBe("GET");
      expect((init?.headers as Headers).get("authorization")).toBe(
        "Bearer mdcms_key_test",
      );
      expect((init?.headers as Headers).get("x-mdcms-project")).toBe(
        "marketing-site",
      );
      expect((init?.headers as Headers).get("x-mdcms-environment")).toBe(
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

  expect(result.data.length).toBe(1);
  expect(result.data[0]?.documentId).toBe(document.documentId);
  expect(result.pagination.total).toBe(1);
  expect(result.pagination.hasMore).toBe(false);
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
      expect(String(input)).toBe(
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

  expect(result.data[0]?.frontmatter.heroImage).toEqual(expandedHeroImage);
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
      expect(String(input)).toBe(
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

  expect(result.data[0]?.frontmatter.heroImage).toBe("media-hero");
});

test("createClient list serializes q search query parameter", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        "http://localhost:4000/api/v1/content?type=BlogPost&q=launch+plan",
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
    q: "launch plan",
  });
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

  const error = await expectRejected(() => client.list("BlogPost"));
  expect(error).toBeInstanceOf(MdcmsApiError);
  if (!(error instanceof MdcmsApiError)) {
    throw new Error("Expected MdcmsApiError.");
  }

  expect(error.statusCode).toBe(403);
  expect(error.code).toBe("FORBIDDEN");
  expect(error.message).toBe("Forbidden.");
  expect(error.requestId).toBe("req-123");
  expect(error.timestamp).toBe("2026-03-26T12:00:00.000Z");
  expect(error.details).toEqual({
    requiredScope: "content:read",
  });
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

  const error = await expectRejected(() => client.list("BlogPost"));
  expect(error).toBeInstanceOf(MdcmsClientError);
  if (!(error instanceof MdcmsClientError)) {
    throw new Error("Expected MdcmsClientError.");
  }

  expect(error.code).toBe("INVALID_RESPONSE");
  expect(error.message).toMatch(/response\.data/i);
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
      expect(String(input)).toBe(
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111",
      );
      expect(init?.method).toBe("GET");

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

  expect(result.documentId).toBe(document.documentId);
  expect(result.type).toBe("BlogPost");
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
      expect(String(input)).toBe(
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

  expect(result.frontmatter.heroImage).toEqual(expandedHeroImage);
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
      expect(String(input)).toBe(
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

  expect(result.frontmatter.heroImage).toBe("media-hero");
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
      expect(String(input)).toBe(
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

  expect(result.documentId).toBe(document.documentId);
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
      expect(String(input)).toBe(
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

  expect(result.frontmatter.heroImage).toBe("media-hero");
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

  const error = await expectRejected(() =>
    client.get("BlogPost", { slug: "hello-world" }),
  );
  expect(error).toBeInstanceOf(MdcmsClientError);
  if (!(error instanceof MdcmsClientError)) {
    throw new Error("Expected MdcmsClientError.");
  }

  expect(error.code).toBe("NOT_FOUND");
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

  const error = await expectRejected(() =>
    client.get("BlogPost", { slug: "hello-world" }),
  );
  expect(error).toBeInstanceOf(MdcmsClientError);
  if (!(error instanceof MdcmsClientError)) {
    throw new Error("Expected MdcmsClientError.");
  }

  expect(error.code).toBe("AMBIGUOUS_RESULT");
});

test("createClient list allows per-call routing overrides", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Headers).get("x-mdcms-project")).toBe(
        "docs-site",
      );
      expect((init?.headers as Headers).get("x-mdcms-environment")).toBe(
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

  expect(result.pagination.total).toBe(0);
});

test("createClient list serializes locale, resolve, and draft query parameters", async () => {
  const client = createClient({
    serverUrl: "http://localhost:4000",
    apiKey: "mdcms_key_test",
    project: "marketing-site",
    environment: "production",
    fetch: async (input: string | URL | Request) => {
      expect(String(input)).toBe(
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
      expect(String(input)).toBe(
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

  expect(result.locale).toBe("fr");
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
      expect(String(input)).toBe(
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

  expect(result.locale).toBe("fr");
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

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.claims.type).toBe("BlogPost");
    expect(result.claims.draftRevision).toBe(5);
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
      expect(String(input)).toBe(
        "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111?locale=en&resolve=author&draft=true",
      );
      expect((init?.headers as Headers).get("x-mdcms-project")).toBe(
        "marketing-site",
      );
      expect((init?.headers as Headers).get("x-mdcms-environment")).toBe(
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

  expect(result.documentId).toBe(document.documentId);
  expect(result.body).toBe("Draft body");
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

  const error = await expectRejected(() =>
    client.getPreviewDocumentFromRequest(
      new Request("https://preview.example.com/blog/hello?preview=true"),
      { secret: "test-preview-secret" },
    ),
  );
  expect(error).toBeInstanceOf(MdcmsClientError);
  if (!(error instanceof MdcmsClientError)) {
    throw new Error("Expected MdcmsClientError.");
  }

  expect(error.code).toBe("PREVIEW_TOKEN_INVALID");
  expect(error.message).toMatch(/missing/i);
});
