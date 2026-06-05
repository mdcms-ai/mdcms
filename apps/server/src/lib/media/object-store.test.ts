import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import {
  createMediaObjectKey,
  createS3CompatibleMediaObjectStore,
} from "./object-store.js";

type FetchCall = {
  input: string | URL | Request;
  init: RequestInit | undefined;
};

function createFetchRecorder(response: Response): {
  calls: FetchCall[];
  fetch: typeof fetch;
} {
  const calls: FetchCall[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ input, init });
    return response;
  }) as typeof fetch;

  return { calls, fetch: fetcher };
}

function headersFrom(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

test("createMediaObjectKey includes encoded project media id and sanitized basename", () => {
  assert.equal(
    createMediaObjectKey({
      project: "marketing-site",
      mediaId: "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
      filename: "../Hero Image.png",
    }),
    "projects/marketing-site/media/8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7/Hero%20Image.png",
  );
});

test("createMediaObjectKey falls back to upload.bin for empty path-only filenames", () => {
  assert.equal(
    createMediaObjectKey({
      project: "marketing-site",
      mediaId: "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
      filename: "../",
    }),
    "projects/marketing-site/media/8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7/upload.bin",
  );
});

test("publicUrlForKey uses public base URL when configured", () => {
  const store = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    publicBaseUrl: "http://localhost:9000/mdcms-media",
    fetch: async () => new Response(null, { status: 200 }),
  });

  assert.equal(
    store.publicUrlForKey("projects/marketing-site/media/id/Hero Image.png"),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/Hero%20Image.png",
  );
});

test("publicUrlForKey derives endpoint bucket and key when public base URL is omitted", () => {
  const store = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000/",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: async () => new Response(null, { status: 200 }),
  });

  assert.equal(
    store.publicUrlForKey("projects/marketing-site/media/id/Hero Image.png"),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/Hero%20Image.png",
  );
});

test("createS3CompatibleMediaObjectStore throws MEDIA_STORAGE_UNAVAILABLE for blank or missing required config", () => {
  assert.throws(
    () =>
      createS3CompatibleMediaObjectStore({
        endpoint: "http://localhost:9000",
        accessKey: "minioadmin",
        secretKey: "",
        bucket: "mdcms-media",
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_STORAGE_UNAVAILABLE" &&
      error.statusCode === 503,
  );

  for (const publicBaseUrl of [
    "http://localhost:9000/mdcms-media?",
    "http://localhost:9000/mdcms-media#",
  ]) {
    assert.throws(
      () =>
        createS3CompatibleMediaObjectStore({
          endpoint: "http://localhost:9000",
          accessKey: "minioadmin",
          secretKey: "minioadmin",
          bucket: "mdcms-media",
          publicBaseUrl,
        }),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "MEDIA_STORAGE_UNAVAILABLE" &&
        error.statusCode === 503,
    );
  }
});

test("putObject calls injected fetch with PUT and throws MEDIA_OBJECT_WRITE_FAILED on non-2xx", async () => {
  const success = createFetchRecorder(new Response(null, { status: 200 }));
  const store = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: success.fetch,
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });

  await store.putObject({
    key: "projects/marketing-site/media/id/hero.png",
    body: new TextEncoder().encode("image-bytes"),
    contentType: "image/png",
  });

  assert.equal(
    String(success.calls[0]?.input),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/hero.png",
  );
  assert.equal(success.calls[0]?.init?.method, "PUT");
  assert.deepEqual(
    success.calls[0]?.init?.body,
    new TextEncoder().encode("image-bytes"),
  );

  const successHeaders = headersFrom(success.calls[0]?.init);
  assert.equal(successHeaders.get("content-type"), "image/png");
  assert.equal(successHeaders.get("x-amz-date"), "20260605T123456Z");
  assert.ok(
    successHeaders.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "),
  );
  assert.ok(successHeaders.get("x-amz-content-sha256"));

  const failed = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: async () => new Response("nope", { status: 500 }),
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });

  await assert.rejects(
    () =>
      failed.putObject({
        key: "projects/marketing-site/media/id/hero.png",
        body: new Uint8Array(),
        contentType: "image/png",
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_OBJECT_WRITE_FAILED" &&
      error.statusCode === 502 &&
      error.details?.status === 500,
  );
});

test("putObject signs AWS-encoded canonical URIs for reserved filename characters", async () => {
  const success = createFetchRecorder(new Response(null, { status: 200 }));
  const store = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: success.fetch,
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });

  await store.putObject({
    key: "projects/marketing-site/media/id/hero(1)*!.png",
    body: new TextEncoder().encode("image-bytes"),
    contentType: "image/png",
  });

  assert.equal(
    String(success.calls[0]?.input),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/hero%281%29%2A%21.png",
  );
  assert.equal(
    headersFrom(success.calls[0]?.init).get("authorization"),
    "AWS4-HMAC-SHA256 Credential=minioadmin/20260605/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=5acbf542b4a4ba58406810506dd6fb2d6724abd8572ba8754ab6bf334334df51",
  );
});

test("deleteObject calls injected fetch with DELETE treats 404 as success and throws MEDIA_OBJECT_DELETE_FAILED on other non-2xx", async () => {
  const success = createFetchRecorder(new Response(null, { status: 204 }));
  const store = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: success.fetch,
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });

  await store.deleteObject({
    key: "projects/marketing-site/media/id/hero.png",
  });

  assert.equal(
    String(success.calls[0]?.input),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/hero.png",
  );
  assert.equal(success.calls[0]?.init?.method, "DELETE");

  const missing = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: async () => new Response(null, { status: 404 }),
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });
  await missing.deleteObject({
    key: "projects/marketing-site/media/id/missing.png",
  });

  const failed = createS3CompatibleMediaObjectStore({
    endpoint: "http://localhost:9000",
    accessKey: "minioadmin",
    secretKey: "minioadmin",
    bucket: "mdcms-media",
    fetch: async () => new Response("nope", { status: 503 }),
    now: () => new Date("2026-06-05T12:34:56.000Z"),
  });

  await assert.rejects(
    () =>
      failed.deleteObject({
        key: "projects/marketing-site/media/id/hero.png",
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_OBJECT_DELETE_FAILED" &&
      error.statusCode === 502 &&
      error.details?.status === 503,
  );
});
