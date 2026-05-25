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
            body: [
              '<HomeHero eyebrow="CMS home" title="CMS-owned headline" summary="Every section comes from the home page body." primaryHref="/pages" primaryLabel="Browse pages" secondaryHref="/admin" secondaryLabel="Open Studio" />',
              "",
              '<HomeSection eyebrow="Overview" title="CMS-owned overview" summary="The homepage route only renders this document.">',
              "  <HomeFeatureGrid>",
              '    <HomeFeature title="Draft pages">Rendered by the consumer app.</HomeFeature>',
              '    <HomeFeature title="Studio handoff">Edited in the same document.</HomeFeature>',
              "  </HomeFeatureGrid>",
              "</HomeSection>",
              "",
              '<HomeSection eyebrow="Workflow" title="CMS-owned workflow" summary="The homepage route only renders this document.">',
              "  <HomeFeatureGrid>",
              '    <HomeFeature title="One source">The public page, preview, and SDK demo share the same body.</HomeFeature>',
              "  </HomeFeatureGrid>",
              "</HomeSection>",
              "",
              '<HomeCta title="Ship the same document" href="/demo/sdk-content" label="Inspect SDK output">Rendered previews stay tied to the content contract.</HomeCta>',
            ].join("\n"),
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
  assert.match(markup, /CMS-owned headline/i);
  assert.match(markup, /Every section comes from the home page body/i);
  assert.match(markup, /Draft pages/i);
  assert.match(markup, /CMS-owned workflow/i);
  assert.match(markup, /Ship the same document/i);
  assert.match(markup, /\/pages/i);
  assert.doesNotMatch(markup, /Rendered from a page document/i);
  assert.doesNotMatch(markup, /One content layer/i);
  assert.doesNotMatch(markup, /Raw Content API/i);

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
});
