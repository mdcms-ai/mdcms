import assert from "node:assert/strict";
import { test } from "node:test";

import { signMdcmsPreviewToken } from "@mdcms/shared";
import { renderToStaticMarkup } from "react-dom/server";

test("page preview route renders draft content after verifying a preview token", async () => {
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  process.env.MDCMS_PREVIEW_TOKEN_SECRET = "test-preview-secret";
  const originalFetch = globalThis.fetch;
  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    ttlSeconds: 300,
    claims: {
      project: "marketing-site",
      environment: "staging",
      documentId: "44444444-4444-4444-4444-444444444444",
      type: "page",
      path: "content/pages/about",
      locale: "en",
      draftRevision: 5,
    },
  });

  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));

    assert.equal(
      url.pathname,
      "/api/v1/content/44444444-4444-4444-4444-444444444444",
    );
    assert.equal(url.searchParams.get("draft"), "true");
    assert.equal(url.searchParams.get("locale"), "en");
    assert.equal(
      (init?.headers as Headers).get("authorization"),
      "Bearer mdcms_key_test",
    );

    return new Response(
      JSON.stringify({
        data: {
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
          updatedBy: "33333333-3333-3333-3333-333333333333",
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

  const module = await import("./page");
  const element = await module.default({
    params: Promise.resolve({ path: ["about"] }),
    searchParams: Promise.resolve({ mdcms_preview_token: token }),
  });
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /Page Preview/);
  assert.match(markup, /About Demo/);
  assert.match(markup, /Rendered page content/);
  assert.match(markup, /href="\/contact"/);
  assert.match(markup, /Contact us/);
  assert.match(markup, /data-mdcms-live-preview-ready-signal/);
  assert.match(
    markup,
    /\/admin\/content\/page\/44444444-4444-4444-4444-444444444444/,
  );

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
  delete process.env.MDCMS_PREVIEW_TOKEN_SECRET;
});
