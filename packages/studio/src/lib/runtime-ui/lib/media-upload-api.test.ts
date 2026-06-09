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

test("upload reports byte-level progress over XMLHttpRequest when no fetcher is injected", async () => {
  type ProgressListener = (event: {
    lengthComputable: boolean;
    loaded: number;
    total: number;
  }) => void;

  const sent: Array<{
    method: string;
    url: string;
    withCredentials: boolean;
    headers: Record<string, string>;
    body: unknown;
  }> = [];

  class FakeXhr {
    method = "";
    url = "";
    withCredentials = false;
    headers: Record<string, string> = {};
    status = 0;
    responseText = "";
    upload: { onprogress: ProgressListener | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    send(body: unknown) {
      sent.push({
        method: this.method,
        url: this.url,
        withCredentials: this.withCredentials,
        headers: this.headers,
        body,
      });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 5 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 });
      this.status = 200;
      this.responseText = JSON.stringify({ data: asset });
      this.onload?.();
    }
  }

  const originalXhr = (globalThis as { XMLHttpRequest?: unknown })
    .XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest =
    FakeXhr as unknown as typeof XMLHttpRequest;

  const progress: Array<{ loaded: number; total: number }> = [];

  try {
    const api = createApi({ auth: { mode: "token", token: "mdcms_key_test" } });
    const result = await api.upload(
      new File(["hello"], "hero.png", { type: "image/png" }),
      { onProgress: (event) => progress.push(event) },
    );

    assert.deepEqual(result, asset);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "POST");
    assert.equal(sent[0]?.url, "http://localhost:4000/api/v1/media/upload");
    assert.equal(sent[0]?.headers["x-mdcms-project"], "marketing-site");
    assert.equal(sent[0]?.headers["x-mdcms-environment"], "production");
    assert.equal(sent[0]?.headers["authorization"], "Bearer mdcms_key_test");
    assert.ok(sent[0]?.body instanceof FormData);
    assert.deepEqual(progress[0], { loaded: 2, total: 5 });
    assert.deepEqual(progress[1], { loaded: 5, total: 5 });
    assert.equal(progress.at(-1)?.loaded, progress.at(-1)?.total);
  } finally {
    if (originalXhr === undefined) {
      Reflect.deleteProperty(globalThis, "XMLHttpRequest");
    } else {
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
    }
  }
});

test("upload falls back to fetch when the XMLHttpRequest transport errors", async () => {
  class ErroringXhr {
    upload: { onprogress: (() => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    status = 0;
    responseText = "";
    open() {}
    setRequestHeader() {}
    send() {
      this.onerror?.();
    }
  }

  const originalXhr = (globalThis as { XMLHttpRequest?: unknown })
    .XMLHttpRequest;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest =
    ErroringXhr as unknown as typeof XMLHttpRequest;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: asset }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const api = createApi({ auth: { mode: "token", token: "mdcms_key_test" } });
    const result = await api.upload(
      new File(["hello"], "hero.png", { type: "image/png" }),
      { onProgress: () => {} },
    );

    assert.deepEqual(result, asset);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalXhr === undefined) {
      Reflect.deleteProperty(globalThis, "XMLHttpRequest");
    } else {
      (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXhr;
    }
  }
});
