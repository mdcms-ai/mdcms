import assert from "node:assert/strict";
import { test } from "node:test";

import { signMdcmsPreviewToken } from "@mdcms/shared";
import { renderToStaticMarkup } from "react-dom/server";

test("post preview route renders draft content after verifying a preview token", async () => {
  process.env.MDCMS_DEMO_API_KEY = "mdcms_key_test";
  process.env.MDCMS_PREVIEW_TOKEN_SECRET = "test-preview-secret";
  const originalFetch = globalThis.fetch;
  const { token } = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    ttlSeconds: 300,
    claims: {
      project: "marketing-site",
      environment: "staging",
      documentId: "11111111-1111-1111-1111-111111111111",
      type: "post",
      path: "content/posts/hello-mdcms",
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
      "/api/v1/content/11111111-1111-1111-1111-111111111111",
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
          documentId: "11111111-1111-1111-1111-111111111111",
          translationGroupId: "22222222-2222-2222-2222-222222222222",
          project: "marketing-site",
          environment: "staging",
          path: "content/posts/hello-mdcms",
          type: "post",
          locale: "en",
          format: "md",
          isDeleted: false,
          hasUnpublishedChanges: true,
          version: 3,
          publishedVersion: 2,
          draftRevision: 5,
          frontmatter: {
            title: "Hello MDCMS",
            slug: "hello-mdcms",
          },
          body: "# Hello MDCMS\n\nThis draft is rendered.",
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
    params: Promise.resolve({ slug: "hello-mdcms" }),
    searchParams: Promise.resolve({ mdcms_preview_token: token }),
  });
  const markup = renderToStaticMarkup(element);

  assert.match(markup, /Post Preview/);
  assert.match(markup, /Hello MDCMS/);
  assert.match(markup, /This draft is rendered/);
  assert.match(markup, /data-mdcms-live-preview-ready-signal/);
  assert.match(
    markup,
    /\/admin\/content\/post\/11111111-1111-1111-1111-111111111111/,
  );

  globalThis.fetch = originalFetch;
  delete process.env.MDCMS_DEMO_API_KEY;
  delete process.env.MDCMS_PREVIEW_TOKEN_SECRET;
});
