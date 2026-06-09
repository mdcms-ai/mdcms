import assert from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeError, type MediaAsset } from "@mdcms/shared";

import {
  createStudioMediaUploadApi,
  type StudioMediaUploadApiOptions,
} from "./media-upload-api.js";

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

function createApi(options: StudioMediaUploadApiOptions = {}) {
  return createStudioMediaUploadApi(
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

test("cookie upload sends routed multipart request with csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: asset }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const file = new File(["hello"], "hero.png", { type: "image/png" });

  const result = await api.upload(file);

  assert.deepEqual(result, asset);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/media/upload",
  );
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "content-type"), null);

  const body = calls[0]?.init?.body;
  assert.ok(body instanceof FormData);
  assert.deepEqual(Array.from(body.keys()), ["file"]);
  const uploadedFile = body.get("file");
  assert.ok(uploadedFile instanceof File);
  assert.equal(uploadedFile.name, "hero.png");
  assert.equal(uploadedFile.type, "image/png");
  assert.equal(await uploadedFile.text(), "hello");
});

test("token upload sends authorization and omits csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: asset }));
    },
  });

  await api.upload(new File(["hello"], "hero.png", { type: "image/png" }));

  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(
    readHeader(calls[0]?.init, "authorization"),
    "Bearer mdcms_key_test",
  );
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), null);
});

test("cookie upload rejects missing csrf before fetch", async () => {
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async () => {
      throw new Error("request should not be sent without csrf");
    },
  });

  await assert.rejects(
    () => api.upload(new File(["hello"], "hero.png", { type: "image/png" })),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "CSRF_TOKEN_MISSING" &&
      error.message ===
        "CSRF token is not available. You must be authenticated.",
  );
});

test("upload surfaces route error code, status, and payload details", async () => {
  const payload = {
    code: "MEDIA_UPLOAD_TOO_LARGE",
    message: "Upload exceeds configured media limit.",
    details: { limitBytes: 10, sizeBytes: 12 },
  };
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async () =>
      new Response(JSON.stringify(payload), {
        status: 413,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () => api.upload(new File(["hello"], "hero.png", { type: "image/png" })),
    (error: unknown) => {
      const details = error instanceof RuntimeError ? error.details : undefined;
      return (
        error instanceof RuntimeError &&
        error.code === "MEDIA_UPLOAD_TOO_LARGE" &&
        error.message === "Upload exceeds configured media limit." &&
        error.statusCode === 413 &&
        details?.operation === "POST /api/v1/media/upload" &&
        details.status === 413 &&
        JSON.stringify(details.payload) === JSON.stringify(payload)
      );
    },
  );
});

test("upload rejects invalid success responses", async () => {
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => api.upload(new File(["hello"], "hero.png", { type: "image/png" })),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_UPLOAD_RESPONSE_INVALID",
  );
});
