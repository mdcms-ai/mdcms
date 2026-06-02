import assert from "node:assert/strict";
import { test } from "node:test";

import type { MdcmsConfig } from "@mdcms/studio";

import {
  createClientStudioConfig,
  extractPreparedStudioComponentMetadata,
} from "./studio-config";

test("extractPreparedStudioComponentMetadata strips non-serializable fields", () => {
  const metadata = extractPreparedStudioComponentMetadata({
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    components: [
      {
        name: "Chart",
        importPath: "./components/mdx/Chart",
        load: async () => null,
        extractedProps: {
          data: {
            type: "array",
            items: "number",
            required: true,
          },
        },
      },
    ],
  } satisfies MdcmsConfig);

  assert.deepEqual(metadata, [
    {
      name: "Chart",
      extractedProps: {
        data: {
          type: "array",
          items: "number",
          required: true,
        },
      },
    },
  ]);
});

test("createClientStudioConfig merges prepared extracted props onto authored components", () => {
  const config = createClientStudioConfig([
    {
      name: "Chart",
      extractedProps: {
        data: {
          type: "array",
          items: "number",
          required: true,
        },
      },
    },
  ]);

  const chart = config.components?.find(
    (component) => component.name === "Chart",
  );

  assert.equal(typeof chart?.load, "function");
  assert.deepEqual(chart?.extractedProps, {
    data: {
      type: "array",
      items: "number",
      required: true,
    },
  });
});

test("createClientStudioConfig preserves explicit locale metadata", () => {
  const config = createClientStudioConfig([]);

  assert.deepEqual(config.locales, {
    default: "en",
    supported: ["en", "fr"],
  });
});

test("createClientStudioConfig includes content type preview URL resolvers", () => {
  const config = createClientStudioConfig([]);
  const post = config.types?.find((type) => type.name === "post");
  const page = config.types?.find((type) => type.name === "page");
  const author = config.types?.find((type) => type.name === "author");

  assert.equal(typeof post?.resolvePreviewUrl, "function");
  assert.equal(typeof page?.resolvePreviewUrl, "function");
  assert.equal(author?.resolvePreviewUrl, undefined);
  assert.equal(
    post?.resolvePreviewUrl?.({
      documentId: "11111111-1111-4111-8111-111111111111",
      type: "post",
      path: "content/posts/hello-mdcms",
      locale: "en",
      frontmatter: {
        slug: "hello-mdcms",
      },
      draftRevision: 5,
    }),
    "/preview/post/hello-mdcms",
  );
  assert.equal(
    page?.resolvePreviewUrl?.({
      documentId: "22222222-2222-4222-8222-222222222222",
      type: "page",
      path: "content/pages/docs/getting-started.mdx",
      locale: "en",
      frontmatter: {
        title: "Getting started",
      },
      draftRevision: 3,
    }),
    "/preview/page/docs/getting-started",
  );
});
