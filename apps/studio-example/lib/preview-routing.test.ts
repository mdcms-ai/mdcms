import assert from "node:assert/strict";
import { test } from "node:test";

import { getPreviewHrefForDocument } from "./preview-routing";

test("post documents link to the draft post preview by slug", () => {
  assert.equal(
    getPreviewHrefForDocument({
      type: "post",
      path: "content/posts/hello-mdcms",
      frontmatter: {
        slug: "hello-mdcms",
      },
    }),
    "/preview/post/hello-mdcms?preview=true",
  );
});

test("page documents link to the draft page preview by content path", () => {
  assert.equal(
    getPreviewHrefForDocument({
      type: "page",
      path: "content/pages/docs/getting-started",
      frontmatter: {
        title: "Getting Started",
      },
    }),
    "/preview/page/docs/getting-started?preview=true",
  );
});

test("documents without a supported preview route do not link to previews", () => {
  assert.equal(
    getPreviewHrefForDocument({
      type: "campaign",
      path: "content/campaigns/global-launch",
      frontmatter: {
        slug: "global-launch",
      },
    }),
    undefined,
  );
});
