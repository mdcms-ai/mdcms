import assert from "node:assert/strict";

import { RuntimeError } from "@mdcms/shared";
import { test } from "bun:test";

import {
  API_KEY_OPERATION_SCOPES,
  createStudioApiKeysApi,
  type ApiKeyCreateInput,
  type ApiKeyCreateResult,
  type ApiKeyMetadata,
  type StudioApiKeysApiOptions,
} from "./api-keys-api.js";

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

function createApi(options: StudioApiKeysApiOptions = {}) {
  return createStudioApiKeysApi(
    { serverUrl: "http://localhost:4000" },
    options,
  );
}

test("API key operation scopes include read-only media keys", () => {
  assert.equal(API_KEY_OPERATION_SCOPES.includes("media:read"), true);
});

const validApiKey: ApiKeyMetadata = {
  id: "key-1",
  label: "CI deploy key",
  keyPrefix: "mdcms_key_abc12345...",
  scopes: ["content:read", "content:write"],
  contextAllowlist: [{ project: "marketing-site", environment: "production" }],
  createdByUserId: "user-1",
  createdAt: "2026-03-01T00:00:00.000Z",
  expiresAt: "2026-06-01T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: "2026-04-08T12:00:00.000Z",
};

const validListResponse = {
  data: [validApiKey],
};

test("list fetches API keys with cookie auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validListResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.list();

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/auth/api-keys",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "key-1");
  assert.equal(result[0]?.label, "CI deploy key");
});

test("list attaches bearer token in token auth mode", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validListResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.list();

  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.label, "CI deploy key");
});

test("list does not send project or environment headers", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validListResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await api.list();

  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), null);
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), null);
});

test("list returns multiple API keys", async () => {
  const secondKey: ApiKeyMetadata = {
    id: "key-2",
    label: "Preview key",
    keyPrefix: "mdcms_key_xyz98765...",
    scopes: ["content:read", "content:read:draft"],
    contextAllowlist: [],
    createdByUserId: "user-2",
    createdAt: "2026-03-15T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  };

  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ data: [validApiKey, secondKey] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const result = await api.list();

  assert.equal(result.length, 2);
  assert.equal(result[0]?.id, "key-1");
  assert.equal(result[1]?.id, "key-2");
  assert.equal(result[1]?.label, "Preview key");
  assert.equal(result[1]?.expiresAt, null);
});

test("list returns empty array when server returns empty data", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const result = await api.list();

  assert.deepEqual(result, []);
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
      error instanceof RuntimeError &&
      error.code === "UNAUTHORIZED" &&
      error.statusCode === 401,
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
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN_ORIGIN" &&
      error.statusCode === 403,
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
      error.code === "INTERNAL_ERROR" &&
      error.statusCode === 500,
  );
});

test("list uses fallback error code when server returns no code", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ message: "Bad request" }), { status: 400 }),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_REQUEST_FAILED" &&
      error.statusCode === 400,
  );
});

test("list throws API_KEYS_RESPONSE_INVALID on malformed response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});

test("list throws API_KEYS_RESPONSE_INVALID when data is not an array", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ data: "not-an-array" }), { status: 200 }),
  });

  await assert.rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID",
  );
});

test("list preserves a path-prefixed serverUrl", async () => {
  const calls: Array<{ input: string | URL | Request }> = [];
  const api = createStudioApiKeysApi(
    { serverUrl: "http://localhost:4000/review-api/editor" },
    {
      auth: { mode: "token", token: "mdcms_key_test" },
      fetcher: async (input) => {
        calls.push({ input });
        return new Response(JSON.stringify(validListResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  await api.list();

  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/review-api/editor/api/v1/auth/api-keys",
  );
});

/* -------------------------------------------------------------------------- */
/*  create                                                                    */
/* -------------------------------------------------------------------------- */

const validCreateInput: ApiKeyCreateInput = {
  label: "CI deploy key",
  scopes: ["content:read", "content:write"],
  contextAllowlist: [{ project: "marketing-site", environment: "production" }],
  expiresAt: "2026-06-01T00:00:00.000Z",
};

const validCreateResult: ApiKeyCreateResult = {
  ...validApiKey,
  key: "mdcms_key_full_secret_value",
};

const validCreateResponse = { data: validCreateResult };

test("create sends POST with correct URL, CSRF header, content-type, JSON body, and returns key + metadata", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validCreateResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.create(validCreateInput, "csrf-tok");

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/auth/api-keys",
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(readHeader(calls[0]?.init, "content-type"), "application/json");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-tok");
  assert.deepEqual(
    JSON.parse(calls[0]?.init?.body as string),
    validCreateInput,
  );

  assert.equal(result.key, "mdcms_key_full_secret_value");
  assert.equal(result.id, "key-1");
  assert.equal(result.label, "CI deploy key");
});

test("create uses cookie auth (credentials: include)", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validCreateResponse), {
        status: 200,
      });
    },
  });

  await api.create(validCreateInput, "csrf-tok");

  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
});

test("create uses token auth (Bearer header)", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validCreateResponse), {
        status: 200,
      });
    },
  });

  await api.create(validCreateInput, "csrf-tok");

  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(calls[0]?.init?.credentials, undefined);
});

test("create throws RuntimeError on non-ok response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({ code: "UNAUTHORIZED", message: "Unauthorized" }),
        { status: 401 },
      ),
  });

  await assert.rejects(
    () => api.create(validCreateInput, "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "UNAUTHORIZED" &&
      error.statusCode === 401,
  );
});

test("create throws RuntimeError with fallback code when server returns no code", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ message: "Bad request" }), { status: 400 }),
  });

  await assert.rejects(
    () => api.create(validCreateInput, "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_REQUEST_FAILED" &&
      error.statusCode === 400,
  );
});

test("create throws API_KEYS_RESPONSE_INVALID on malformed response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });

  await assert.rejects(
    () => api.create(validCreateInput, "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});

test("create throws API_KEYS_RESPONSE_INVALID when data has no key field", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ data: { id: "key-1" } }), { status: 200 }),
  });

  await assert.rejects(
    () => api.create(validCreateInput, "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID",
  );
});

/* -------------------------------------------------------------------------- */
/*  revoke                                                                    */
/* -------------------------------------------------------------------------- */

const revokedApiKey: ApiKeyMetadata = {
  ...validApiKey,
  revokedAt: "2026-04-09T10:00:00.000Z",
};

const validRevokeResponse = { data: revokedApiKey };

test("revoke sends POST to correct URL with keyId in path, CSRF header, and returns metadata", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validRevokeResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.revoke("key-1", "csrf-tok");

  assert.equal(calls.length, 1);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/auth/api-keys/key-1/revoke",
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-tok");

  assert.equal(result.id, "key-1");
  assert.equal(result.revokedAt, "2026-04-09T10:00:00.000Z");
});

test("revoke encodes keyId in the URL path", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validRevokeResponse), {
        status: 200,
      });
    },
  });

  await api.revoke("key/with spaces", "csrf-tok");

  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/auth/api-keys/key%2Fwith%20spaces/revoke",
  );
});

test("revoke uses cookie auth (credentials: include)", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validRevokeResponse), {
        status: 200,
      });
    },
  });

  await api.revoke("key-1", "csrf-tok");

  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
});

test("revoke uses token auth (Bearer header)", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(validRevokeResponse), {
        status: 200,
      });
    },
  });

  await api.revoke("key-1", "csrf-tok");

  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(calls[0]?.init?.credentials, undefined);
});

test("revoke throws RuntimeError on non-ok response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(
        JSON.stringify({ code: "UNAUTHORIZED", message: "Unauthorized" }),
        { status: 401 },
      ),
  });

  await assert.rejects(
    () => api.revoke("key-1", "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "UNAUTHORIZED" &&
      error.statusCode === 401,
  );
});

test("revoke throws RuntimeError with fallback code when server returns no code", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ message: "Not found" }), { status: 404 }),
  });

  await assert.rejects(
    () => api.revoke("key-1", "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_REQUEST_FAILED" &&
      error.statusCode === 404,
  );
});

test("revoke throws API_KEYS_RESPONSE_INVALID on malformed response", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  });

  await assert.rejects(
    () => api.revoke("key-1", "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID" &&
      error.statusCode === 500,
  );
});

test("revoke throws API_KEYS_RESPONSE_INVALID when data is not an object", async () => {
  const api = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ data: "not-an-object" }), { status: 200 }),
  });

  await assert.rejects(
    () => api.revoke("key-1", "csrf-tok"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "API_KEYS_RESPONSE_INVALID",
  );
});
