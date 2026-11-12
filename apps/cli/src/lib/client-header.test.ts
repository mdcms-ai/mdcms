import assert from "node:assert/strict";
import { test } from "node:test";

import { withMdcmsClientHeader } from "./client-header.js";

function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetcher = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response("{}");
  }) as typeof fetch;
  return { fetcher, calls };
}

test("adds the client header to requests for the configured server", async () => {
  const { fetcher, calls } = recordingFetch();
  const wrapped = withMdcmsClientHeader(
    fetcher,
    "https://cms.example.com",
    "cli/0.4.0",
  );

  await wrapped("https://cms.example.com/api/v1/content", {
    headers: { authorization: "Bearer k" },
  });

  assert.equal(calls[0]?.headers.get("x-mdcms-client"), "cli/0.4.0");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer k");
});

test("leaves other origins and explicit values alone", async () => {
  const { fetcher, calls } = recordingFetch();
  const wrapped = withMdcmsClientHeader(
    fetcher,
    "https://cms.example.com",
    "cli/0.4.0",
  );

  await wrapped("https://registry.npmjs.org/mdcms");
  await wrapped("https://cms.example.com/api/v1/schema", {
    headers: { "x-mdcms-client": "custom/1" },
  });

  assert.equal(calls[0]?.headers.get("x-mdcms-client"), null);
  assert.equal(calls[1]?.headers.get("x-mdcms-client"), "custom/1");
});

test("preserves Request headers and respects init header overrides", async () => {
  const { fetcher, calls } = recordingFetch();
  const wrapped = withMdcmsClientHeader(
    fetcher,
    "https://cms.example.com",
    "cli/0.4.0",
  );
  const request = new Request("https://cms.example.com/api/v1/content", {
    headers: { authorization: "Bearer k", "x-mdcms-client": "request/1" },
  });
  await wrapped(request);
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer k");
  assert.equal(calls[0]?.headers.get("x-mdcms-client"), "request/1");
  await wrapped(request, { headers: { authorization: "Bearer override" } });
  assert.equal(calls[1]?.headers.get("authorization"), "Bearer override");
  assert.equal(calls[1]?.headers.get("x-mdcms-client"), "cli/0.4.0");
});
