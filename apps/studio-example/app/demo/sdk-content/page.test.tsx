import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

function makeDocument(input: {
  documentId: string;
  type: string;
  path: string;
  title: string;
  slug?: string;
  body: string;
}) {
  return {
    documentId: input.documentId,
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "staging",
    path: input.path,
    type: input.type,
    locale: "en",
    format: "md" as const,
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: input.title,
      slug: input.slug,
    },
    body: input.body,
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-27T08:00:00.000Z",
    updatedAt: "2026-03-27T09:00:00.000Z",
  };
}

test("SDK content list page renders all configured document groups", async () => {
  const originalApiKey = process.env.MDCMS_DEMO_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  const requestedTypes: string[] = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const type = url.searchParams.get("type");
    assert.equal(url.pathname, "/api/v1/content");
    assert.ok(type);
    requestedTypes.push(type);
    assert.equal(url.searchParams.get("draft"), "true");
    assert.equal(url.searchParams.get("limit"), "50");
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

    const data =
      type === "page"
        ? [
            makeDocument({
              documentId: "11111111-1111-1111-1111-111111111111",
              type,
              path: "content/pages/about",
              title: "About Demo",
              body: "# About Demo\n\nRendered page copy.",
            }),
          ]
        : type === "post"
          ? [
              makeDocument({
                documentId: "44444444-4444-4444-4444-444444444444",
                type,
                path: "content/posts/hello-mdcms",
                title: "Hello MDCMS",
                slug: "hello-mdcms",
                body: "# Hello MDCMS\n\nRendered post copy.",
              }),
            ]
          : [];

    return new Response(
      JSON.stringify({
        data,
        pagination: {
          total: data.length,
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
  };

  try {
    const module = await import("./page");
    const element = await module.default();
    const markup = renderToStaticMarkup(element);

    assert.deepEqual(requestedTypes.slice(0, 2), ["page", "post"]);
    assert.match(markup, /SDK client/i);
    assert.match(markup, /@mdcms\/sdk/i);
    assert.match(markup, /Pages/i);
    assert.match(markup, /Posts/i);
    assert.match(markup, /About Demo/i);
    assert.match(markup, /Hello MDCMS/i);
    assert.match(markup, /Rendered page copy/i);
    assert.match(markup, /Rendered post copy/i);
    assert.doesNotMatch(markup, /frontmatter \(raw JSON\)/i);
    assert.doesNotMatch(markup, /body \(raw\)/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.MDCMS_DEMO_API_KEY;
    } else {
      process.env.MDCMS_DEMO_API_KEY = originalApiKey;
    }
  }
});
