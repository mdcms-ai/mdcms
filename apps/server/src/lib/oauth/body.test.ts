import assert from "node:assert/strict";
import { test } from "bun:test";
import { readOAuthBody } from "./body.js";
test("OAuth body rejects excessive declared and streamed bytes", async () => {
  await assert.rejects(
    readOAuthBody(
      new Request("https://cms.example", {
        method: "POST",
        headers: { "content-length": "65537" },
        body: "x",
      }),
    ),
    (error: any) => error.status === 413,
  );
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(32769));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readOAuthBody(
      new Request("https://cms.example", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    ),
    (error: any) => error.status === 413,
  );
  assert.equal(cancelled, true);
  assert.equal(
    (
      await readOAuthBody(
        new Request("https://cms.example", {
          method: "POST",
          body: "x".repeat(65536),
        }),
      )
    ).length,
    65536,
  );
});
