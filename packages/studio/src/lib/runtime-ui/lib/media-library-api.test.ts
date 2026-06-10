import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  RuntimeError,
  type MediaAsset,
  type MediaAssetListResponse,
} from "@mdcms/shared";

import {
  createStudioMediaLibraryApi,
  type StudioMediaLibraryApiOptions,
} from "./media-library-api.js";

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get(name);
  if (headers && !Array.isArray(headers)) {
    const value = (headers as Record<string, string>)[name];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function createApi(options: StudioMediaLibraryApiOptions = {}) {
  return createStudioMediaLibraryApi(
    {
      project: "marketing-site",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

const asset: MediaAsset = {
  id: "asset_123",
  project: "marketing-site",
  filename: "hero.png",
  mimeType: "image/png",
  sizeBytes: 12,
  url: "https://cdn.example.com/media/hero.png",
  uploadedBy: "user_123",
  uploadedAt: "2026-06-05T12:00:00.000Z",
};

const listResponse: MediaAssetListResponse = {
  data: [asset],
  pagination: {
    total: 1,
    limit: 30,
    offset: 0,
    hasMore: false,
  },
};

test("list fetches routed media assets with cookie auth and provided query params", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(listResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.list({
    q: "hero",
    category: "image",
    uploadedBy: "user_123",
    uploadedFrom: "2026-06-01",
    uploadedTo: "2026-06-05",
    sort: "filename",
    order: "asc",
    limit: 30,
    offset: 60,
  });

  assert.deepEqual(result, listResponse);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);

  const url = new URL(String(calls[0]?.input));
  assert.equal(url.origin + url.pathname, "http://localhost:4000/api/v1/media");
  assert.deepEqual(Array.from(url.searchParams.entries()), [
    ["q", "hero"],
    ["category", "image"],
    ["uploadedBy", "user_123"],
    ["uploadedFrom", "2026-06-01"],
    ["uploadedTo", "2026-06-05"],
    ["sort", "filename"],
    ["order", "asc"],
    ["limit", "30"],
    ["offset", "60"],
  ]);
});

test("list omits undefined query params and supports token auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ ...listResponse, data: [] }));
    },
  });

  await api.list({
    q: "logo",
    category: undefined,
    uploadedBy: undefined,
    uploadedFrom: undefined,
    uploadedTo: undefined,
    sort: undefined,
    order: undefined,
    limit: 10,
    offset: 0,
  });

  const url = new URL(String(calls[0]?.input));
  assert.deepEqual(Array.from(url.searchParams.entries()), [
    ["q", "logo"],
    ["limit", "10"],
    ["offset", "0"],
  ]);
  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
});

test("list omits blank optional string query params", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(listResponse));
    },
  });

  await api.list({
    q: "   ",
    uploadedBy: "",
    uploadedFrom: " ",
    uploadedTo: "",
    limit: 30,
    offset: 0,
  });

  const url = new URL(String(calls[0]?.input));
  assert.deepEqual(Array.from(url.searchParams.entries()), [
    ["limit", "30"],
    ["offset", "0"],
  ]);
});

test("list without query sends the bare media route", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(listResponse));
    },
  });

  await api.list();

  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/media");
});

test("get fetches a routed media asset with project and environment headers", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: asset }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.get("07ebb057-eeab-4849-94e4-2162cb921c8e");

  assert.deepEqual(result, asset);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/media/07ebb057-eeab-4849-94e4-2162cb921c8e",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
});

test("list surfaces route error code, status, and payload details", async () => {
  const payload = {
    code: "INVALID_QUERY_PARAM",
    message: "The media list query is invalid.",
    details: { field: "limit" },
  };
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async () =>
      new Response(JSON.stringify(payload), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => api.list({ limit: 0 }),
    (error: unknown) => {
      const details = error instanceof RuntimeError ? error.details : undefined;
      return (
        error instanceof RuntimeError &&
        error.code === "INVALID_QUERY_PARAM" &&
        error.message === "The media list query is invalid." &&
        error.statusCode === 400 &&
        details?.operation === "GET /api/v1/media" &&
        details.status === 400 &&
        JSON.stringify(details.payload) === JSON.stringify(payload)
      );
    },
  );
});

test("list falls back to a media-library-specific route error code", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ details: { cause: "upstream" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_LIBRARY_REQUEST_FAILED" &&
      error.message === "Media library request failed." &&
      error.statusCode === 502,
  );
});

test("list rejects invalid success responses", async () => {
  const api = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_LIBRARY_RESPONSE_INVALID",
  );
});

test("delete sends a routed DELETE with csrf for cookie auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ data: { deleted: true, id: "asset 123/raw" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await api.delete("asset 123/raw");

  assert.deepEqual(result, { deleted: true, id: "asset 123/raw" });
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/media/asset%20123%2Fraw",
  );
  assert.equal(calls[0]?.init?.method, "DELETE");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
});

test("delete omits csrf and sends authorization for token auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(
        JSON.stringify({ data: { deleted: true, id: "asset_123" } }),
      );
    },
  });

  await api.delete("asset_123");

  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), null);
});

test("delete rejects missing csrf before issuing the request", async () => {
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async () => {
      throw new Error("request should not be sent without csrf");
    },
  });

  await assert.rejects(
    () => api.delete("asset_123"),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CSRF_TOKEN_MISSING",
  );
});

test("delete surfaces route error code, status, and payload details", async () => {
  const payload = {
    code: "NOT_FOUND",
    message: "Media asset not found.",
    details: { id: "asset_missing" },
  };
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async () =>
      new Response(JSON.stringify(payload), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => api.delete("asset_missing"),
    (error: unknown) => {
      const details = error instanceof RuntimeError ? error.details : undefined;
      return (
        error instanceof RuntimeError &&
        error.code === "NOT_FOUND" &&
        error.statusCode === 404 &&
        details?.operation === "DELETE /api/v1/media/asset_missing" &&
        details.status === 404
      );
    },
  );
});

test("delete rejects invalid success responses", async () => {
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async () => new Response(JSON.stringify({ data: { deleted: 1 } })),
  });

  await assert.rejects(
    () => api.delete("asset_123"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_LIBRARY_RESPONSE_INVALID",
  );
});
