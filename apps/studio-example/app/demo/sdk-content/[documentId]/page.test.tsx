import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

test("SDK content detail page clearly identifies the SDK data source", async () => {
  const originalApiKey = process.env.MDCMS_DEMO_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    assert.equal(
      String(input),
      "http://localhost:4000/api/v1/content/11111111-1111-1111-1111-111111111111?draft=true",
    );
    assert.equal(
      (init?.headers as Headers).get("authorization"),
      "Bearer mdcms_key_test",
    );
    assert.equal(
      (init?.headers as Headers).get("x-mdcms-project"),
      "marketing-site",
    );
    assert.equal(
      (init?.headers as Headers).get("x-mdcms-environment"),
      "staging",
    );

    return new Response(
      JSON.stringify({
        data: {
          documentId: "11111111-1111-1111-1111-111111111111",
          translationGroupId: "22222222-2222-2222-2222-222222222222",
          project: "marketing-site",
          environment: "staging",
          path: "blog/hello-world",
          type: "post",
          locale: "en",
          format: "md",
          isDeleted: false,
          hasUnpublishedChanges: false,
          version: 3,
          publishedVersion: 3,
          draftRevision: 5,
          frontmatter: {
            title: "Hello World",
            slug: "hello-world",
          },
          body: "# Hello **rendered**",
          createdBy: "33333333-3333-3333-3333-333333333333",
          createdAt: "2026-03-27T08:00:00.000Z",
          updatedAt: "2026-03-27T09:00:00.000Z",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  try {
    const module = await import("./page");
    const element = await module.default({
      params: Promise.resolve({
        documentId: "11111111-1111-1111-1111-111111111111",
      }),
    });
    const markup = renderToStaticMarkup(element);

    assert.match(markup, /SDK detail/i);
    assert.match(markup, /@mdcms\/sdk/i);
    assert.match(markup, /\/demo\/sdk-content/i);
    assert.match(markup, /\/demo\/content/i);
    assert.match(markup, /\/preview\/post\/hello-world/i);
    assert.match(markup, /Hello World/);
    assert.match(markup, /<h1>Hello <strong>rendered<\/strong><\/h1>/i);
    assert.doesNotMatch(markup, /body \(raw\):/i);
    assert.doesNotMatch(markup, /frontmatter \(raw JSON\):/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.MDCMS_DEMO_API_KEY;
    } else {
      process.env.MDCMS_DEMO_API_KEY = originalApiKey;
    }
  }
});
