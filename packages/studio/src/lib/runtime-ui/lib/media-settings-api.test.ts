import assert from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeError, type MediaSettings } from "@mdcms/shared";

import {
  createStudioMediaSettingsApi,
  type StudioMediaSettingsApiOptions,
} from "./media-settings-api.js";

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

function createApi(options: StudioMediaSettingsApiOptions = {}) {
  return createStudioMediaSettingsApi(
    {
      project: "marketing-site",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

const settings: MediaSettings = {
  media: { image: { maxUploadSizeBytes: 10_485_760 } },
};

test("getSettings fetches routed media settings with cookie auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: settings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.getSettings();

  assert.deepEqual(result, settings);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/media/settings",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
});

test("updateSettings sends JSON media settings with target routing and csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: settings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const input: MediaSettings = {
    media: { image: { maxUploadSizeBytes: null } },
  };

  const result = await api.updateSettings(input);

  assert.deepEqual(result, settings);
  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/media/settings",
  );
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(readHeader(calls[0]?.init, "content-type"), "application/json");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
});

test("updateSettings rejects missing csrf for cookie mutations", async () => {
  const api = createApi({ auth: { mode: "cookie" } });

  await assert.rejects(
    () => api.updateSettings(settings),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CSRF_TOKEN_MISSING",
  );
});

test("media settings API surfaces route errors and invalid responses", async () => {
  const failingApi = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "Nope." }), {
        status: 403,
      }),
  });

  await assert.rejects(
    () => failingApi.getSettings(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN" &&
      error.statusCode === 403,
  );

  const invalidApi = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => invalidApi.getSettings(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_SETTINGS_RESPONSE_INVALID",
  );
});
