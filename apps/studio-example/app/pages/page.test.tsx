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
    format: "mdx" as const,
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 1,
    publishedVersion: 1,
    draftRevision: 2,
    frontmatter: {
      title: input.title,
      slug: input.slug,
    },
    body: input.body,
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-05-22T08:00:00.000Z",
    updatedAt: "2026-05-22T09:00:00.000Z",
  };
}

test("pages index lists pages before posts with rendered previews", async () => {
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  const requestedTypes: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const type = url.searchParams.get("type");
    assert.ok(type);
    requestedTypes.push(type);

    const data =
      type === "page"
        ? [
            makeDocument({
              documentId: "66666666-6666-6666-6666-666666666666",
              type,
              path: "content/pages/case-studies",
              title: "Case Studies",
              body: [
                "# Case Studies",
                "",
                "<Box style={{ padding: '1rem' }}>",
                '  <Text children="Raw component text" />',
                "</Box>",
                "",
                "Plain summary after component.",
              ].join("\n"),
            }),
            makeDocument({
              documentId: "11111111-1111-1111-1111-111111111111",
              type,
              path: "content/pages/about",
              title: "About Demo",
              body: "# About Demo\n\nThis page is rendered.",
            }),
            makeDocument({
              documentId: "55555555-5555-5555-5555-555555555555",
              type,
              path: "content/pages/custom-carousel",
              title: "Image Carousel Demo",
              body: [
                "# Image Carousel Demo",
                "",
                "This page has unsupported raw browser script.",
                "",
                "<style>",
                ".carousel { position: relative; overflow: hidden; }",
                "</style>",
                "",
                "<script>",
                "const slides = document.querySelectorAll('.carousel-slide');",
                "</script>",
              ].join("\n"),
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
                body: "# Hello MDCMS\n\nThis post is rendered.",
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

  const module = await import("./page");
  const element = await module.default();
  const markup = renderToStaticMarkup(element);

  assert.deepEqual(requestedTypes.slice(0, 2), ["page", "post"]);
  assert.match(markup, /Content library/i);
  assert.match(markup, /Case Studies/i);
  assert.match(markup, /Plain summary after component/i);
  assert.doesNotMatch(markup, /&lt;Box/i);
  assert.match(markup, /About Demo/i);
  assert.match(markup, /This page is rendered/i);
  assert.match(markup, /Image Carousel Demo/i);
  assert.match(markup, /Preview could not be rendered/i);
  assert.match(markup, /Hello MDCMS/i);
  assert.match(markup, /This post is rendered/i);
  assert.doesNotMatch(markup, /Documents could not be loaded/i);
  assert.ok(markup.indexOf("Pages") < markup.indexOf("Posts"));
  assert.doesNotMatch(markup, /frontmatter/i);
  assert.doesNotMatch(markup, /body \(raw\)/i);

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
});
