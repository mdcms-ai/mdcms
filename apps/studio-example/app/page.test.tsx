import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";

test("home page renders the CMS-backed home page document", async () => {
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));

    assert.equal(url.pathname, "/api/v1/content");
    assert.equal(url.searchParams.get("type"), "page");
    assert.equal(url.searchParams.get("path"), "content/pages/home");
    assert.equal(url.searchParams.get("draft"), "true");
    assert.equal(
      (init?.headers as Headers).get("authorization"),
      "Bearer mdcms_key_test",
    );

    return new Response(
      JSON.stringify({
        data: [
          {
            documentId: "11111111-1111-1111-1111-111111111111",
            translationGroupId: "22222222-2222-2222-2222-222222222222",
            project: "marketing-site",
            environment: "staging",
            path: "content/pages/home",
            type: "page",
            locale: "en",
            format: "mdx",
            isDeleted: false,
            hasUnpublishedChanges: false,
            version: 1,
            publishedVersion: 1,
            draftRevision: 2,
            frontmatter: {
              title: "MDCMS Demo Home",
            },
            body: "# CMS home page\n\nRendered from the page category.",
            createdBy: "33333333-3333-3333-3333-333333333333",
            createdAt: "2026-05-22T08:00:00.000Z",
            updatedAt: "2026-05-22T09:00:00.000Z",
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

  const element = await HomePage();
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /MDCMS Demo/i);
  assert.match(markup, /content\/pages\/home/i);
  assert.match(markup, /CMS home page/i);
  assert.match(markup, /Rendered from the page category/i);
  assert.match(markup, /\/pages/i);
  assert.doesNotMatch(markup, /Raw Content API/i);

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
});
