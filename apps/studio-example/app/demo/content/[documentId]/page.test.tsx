import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

test("direct API content detail page renders the document body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          documentId: "11111111-1111-1111-1111-111111111111",
          type: "post",
          locale: "en",
          path: "content/posts/hello-mdcms",
          format: "md",
          frontmatter: {
            title: "Hello MDCMS",
            slug: "hello-mdcms",
          },
          body: "Hello world",
          draftRevision: 5,
          publishedVersion: 3,
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
  const element = await module.default({
    params: Promise.resolve({
      documentId: "11111111-1111-1111-1111-111111111111",
    }),
  });
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /API detail/i);
  assert.match(markup, /Direct content API response/i);
  assert.match(
    markup,
    /\/demo\/sdk-content\/11111111-1111-1111-1111-111111111111/i,
  );
  assert.match(markup, /\/preview\/post\/hello-mdcms/i);
  assert.match(markup, /Hello world/i);
  assert.doesNotMatch(markup, /frontmatter \(raw JSON\):/i);
  assert.doesNotMatch(markup, /body \(raw\):/i);

  globalThis.fetch = originalFetch;
});
