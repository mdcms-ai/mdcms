import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

test("page preview route renders draft content by content path", async () => {
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));

    assert.equal(url.pathname, "/api/v1/content");
    assert.equal(url.searchParams.get("type"), "page");
    assert.equal(url.searchParams.get("draft"), "true");
    assert.equal(url.searchParams.get("path"), "content/pages/about");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(
      (init?.headers as Headers).get("authorization"),
      "Bearer mdcms_key_test",
    );

    return new Response(
      JSON.stringify({
        data: [
          {
            documentId: "44444444-4444-4444-4444-444444444444",
            translationGroupId: "55555555-5555-5555-5555-555555555555",
            project: "marketing-site",
            environment: "staging",
            path: "content/pages/about",
            type: "page",
            locale: "en",
            format: "mdx",
            isDeleted: false,
            hasUnpublishedChanges: true,
            version: 3,
            publishedVersion: 2,
            draftRevision: 5,
            frontmatter: {
              title: "About Demo",
            },
            body: [
              "# About Demo",
              "",
              '<Callout tone="info">Rendered page content.</Callout>',
              "",
              '<Link href="/contact" style={{color:"#176f5d"}}>Contact us</Link>',
            ].join("\n"),
            createdBy: "33333333-3333-3333-3333-333333333333",
            createdAt: "2026-03-27T08:00:00.000Z",
            updatedAt: "2026-03-27T09:00:00.000Z",
          },
        ],
        pagination: {
          total: 1,
          limit: 2,
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
  };

  const module = await import("./page");
  const element = await module.default({
    params: Promise.resolve({ path: ["about"] }),
  });
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /Page Preview/);
  assert.match(markup, /About Demo/);
  assert.match(markup, /Rendered page content/);
  assert.match(markup, /href="\/contact"/);
  assert.match(markup, /Contact us/);
  assert.match(
    markup,
    /\/admin\/content\/page\/44444444-4444-4444-4444-444444444444/,
  );

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
});
