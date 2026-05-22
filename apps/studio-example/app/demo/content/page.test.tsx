import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

test("direct API content list page renders diagnostic previews", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [],
        pagination: {
          total: 0,
          limit: 50,
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
    );

  const module = await import("./page");
  const element = await module.default();
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /Direct API/i);
  assert.match(markup, /Rendered documents from the content API/i);
  assert.match(markup, /\/demo\/sdk-content/i);

  globalThis.fetch = originalFetch;
});
