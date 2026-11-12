import assert from "node:assert/strict";
import { test } from "node:test";

import type { SerializableStudioConfig } from "@mdcms/studio/client-config";

import { createAdminStudioClientConfig } from "./studio-config";

const serializableConfig: SerializableStudioConfig = {
  project: "marketing-site",
  environment: "staging",
  serverUrl: "http://localhost:4000",
  contentDirectories: ["content"],
  locales: { default: "en", supported: ["en", "fr"] },
  types: [
    { name: "post", directory: "content/posts" },
    { name: "author", directory: "content/authors" },
    { name: "page", directory: "content/pages" },
    { name: "campaign", directory: "content/campaigns", localized: true },
  ],
  components: [
    {
      name: "Chart",
      importPath: "./components/mdx/Chart",
      extractedProps: {
        data: {
          type: "array",
          items: "number",
          required: true,
        },
      },
    },
    {
      name: "PricingTable",
      importPath: "./components/mdx/PricingTable",
      propsEditor: "./components/mdx/PricingTable.editor",
    },
  ],
  _schemaHash: "schema-hash",
};

test("createAdminStudioClientConfig attaches the example component loaders", () => {
  const config = createAdminStudioClientConfig(serializableConfig);
  const chart = config.components?.find(
    (component) => component.name === "Chart",
  );
  const pricingTable = config.components?.find(
    (component) => component.name === "PricingTable",
  );

  assert.equal(typeof chart?.load, "function");
  assert.deepEqual(chart?.extractedProps, {
    data: {
      type: "array",
      items: "number",
      required: true,
    },
  });
  assert.equal(typeof pricingTable?.load, "function");
  assert.equal(typeof pricingTable?.loadPropsEditor, "function");
  assert.equal(config._schemaHash, "schema-hash");
});

test("createAdminStudioClientConfig preserves explicit locale metadata", () => {
  const config = createAdminStudioClientConfig(serializableConfig);

  assert.deepEqual(config.locales, {
    default: "en",
    supported: ["en", "fr"],
  });
});

test("createAdminStudioClientConfig includes content type preview URL resolvers", () => {
  const config = createAdminStudioClientConfig(serializableConfig);
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
    "/preview/post/hello-mdcms?preview=true",
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
    "/preview/page/docs/getting-started?preview=true",
  );
});
