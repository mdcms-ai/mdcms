import assert from "node:assert/strict";
import { test } from "bun:test";

import type { MdcmsPreviewDocument } from "@mdcms/shared";

import {
  createStudioClientConfig,
  toSerializableStudioConfig,
  type SerializableStudioConfig,
} from "./client-config.js";
import type { MdcmsConfig } from "./studio.js";

function Callout() {
  return null;
}

function createPreparedConfig(): MdcmsConfig {
  return {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    contentDirectories: ["content"],
    locales: { default: "en", supported: ["en", "fr"] },
    types: [
      {
        name: "post",
        directory: "content/posts",
        fields: {},
        resolvePreviewUrl: () => "/preview",
        extend: (overlay) => overlay,
      },
      {
        name: "campaign",
        directory: "content/campaigns",
        localized: true,
        fields: {},
        extend: (overlay) => overlay,
      },
    ],
    components: [
      {
        name: "Box",
        importPath: "@mdcms/sdk/react-primitives",
        load: async () => null,
      },
      {
        name: "Callout",
        importPath: "./components/callout",
        description: "Highlighted note",
        propHints: { note: { widget: "textarea" } },
        load: async () => Callout,
        extractedProps: {
          title: { type: "string", required: true },
        },
      },
      {
        name: "PricingTable",
        importPath: "./components/pricing-table",
        propsEditor: "./components/pricing-table.editor",
        load: async () => null,
        loadPropsEditor: async () => null,
      },
    ],
    _schemaHash: "hash-staging",
    _documentRouteMetadata: {
      schemaHashesByEnvironment: { staging: "hash-staging" },
      environmentFieldTargets: {},
    },
  };
}

test("toSerializableStudioConfig keeps only plain values", () => {
  const serializable = toSerializableStudioConfig(createPreparedConfig());

  assert.deepEqual(serializable, {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    contentDirectories: ["content"],
    locales: { default: "en", supported: ["en", "fr"] },
    types: [
      { name: "post", directory: "content/posts" },
      { name: "campaign", directory: "content/campaigns", localized: true },
    ],
    components: [
      {
        name: "Callout",
        importPath: "./components/callout",
        description: "Highlighted note",
        propHints: { note: { widget: "textarea" } },
        extractedProps: {
          title: { type: "string", required: true },
        },
      },
      {
        name: "PricingTable",
        importPath: "./components/pricing-table",
        propsEditor: "./components/pricing-table.editor",
      },
    ],
    _schemaHash: "hash-staging",
    _documentRouteMetadata: {
      schemaHashesByEnvironment: { staging: "hash-staging" },
      environmentFieldTargets: {},
    },
  } satisfies SerializableStudioConfig);
  assert.deepEqual(JSON.parse(JSON.stringify(serializable)), serializable);
});

test("toSerializableStudioConfig omits values the prepared config does not have", () => {
  const serializable = toSerializableStudioConfig({
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
  });

  assert.deepEqual(serializable, {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    components: [],
  });
});

test("createStudioClientConfig attaches loaders by component name", async () => {
  const loadCallout = async () => ({ Callout });
  const loadPricingTable = async () => null;
  const loadPricingTableEditor = async () => null;
  const config = createStudioClientConfig(
    toSerializableStudioConfig(createPreparedConfig()),
    {
      loaders: {
        Callout: loadCallout,
        PricingTable: {
          load: loadPricingTable,
          loadPropsEditor: loadPricingTableEditor,
        },
        NotRegistered: async () => null,
      },
    },
  );

  assert.deepEqual(
    config.components?.map((component) => component.name),
    ["Callout", "PricingTable"],
  );

  const [callout, pricingTable] = config.components ?? [];

  assert.equal(callout?.load, loadCallout);
  assert.equal(callout?.loadPropsEditor, undefined);
  assert.equal(callout?.description, "Highlighted note");
  assert.deepEqual(callout?.extractedProps, {
    title: { type: "string", required: true },
  });
  assert.equal(pricingTable?.load, loadPricingTable);
  assert.equal(pricingTable?.loadPropsEditor, loadPricingTableEditor);
  assert.equal(pricingTable?.propsEditor, "./components/pricing-table.editor");
});

test("createStudioClientConfig keeps components without a loader", () => {
  const config = createStudioClientConfig(
    toSerializableStudioConfig(createPreparedConfig()),
  );

  assert.deepEqual(
    config.components?.map((component) => [
      component.name,
      "load" in component,
    ]),
    [
      ["Callout", false],
      ["PricingTable", false],
    ],
  );
});

test("createStudioClientConfig drops built-in component names", () => {
  const serializable = toSerializableStudioConfig(createPreparedConfig());
  const config = createStudioClientConfig(
    {
      ...serializable,
      components: [
        { name: "Link", importPath: "./components/link" },
        ...serializable.components,
      ],
    },
    { loaders: { Link: async () => null } },
  );

  assert.deepEqual(
    config.components?.map((component) => component.name),
    ["Callout", "PricingTable"],
  );
});

test("createStudioClientConfig carries the schema hash, routing metadata and locales", () => {
  const config = createStudioClientConfig(
    toSerializableStudioConfig(createPreparedConfig()),
  );

  assert.equal(config.project, "marketing-site");
  assert.equal(config.environment, "staging");
  assert.equal(config.serverUrl, "http://localhost:4000");
  assert.equal(config._schemaHash, "hash-staging");
  assert.deepEqual(config._documentRouteMetadata, {
    schemaHashesByEnvironment: { staging: "hash-staging" },
    environmentFieldTargets: {},
  });
  assert.deepEqual(config.locales, {
    default: "en",
    supported: ["en", "fr"],
  });
  assert.deepEqual(config.contentDirectories, ["content"]);
});

test("createStudioClientConfig attaches preview URL resolvers by type name", () => {
  const resolvePostPreviewUrl = (document: MdcmsPreviewDocument) =>
    `/preview/${document.type}/${String(document.frontmatter.slug)}`;
  const config = createStudioClientConfig(
    toSerializableStudioConfig(createPreparedConfig()),
    { previewUrlResolvers: { post: resolvePostPreviewUrl } },
  );
  const [post, campaign] = config.types ?? [];

  assert.equal(post?.name, "post");
  assert.equal(post?.directory, "content/posts");
  assert.equal(post?.resolvePreviewUrl, resolvePostPreviewUrl);
  assert.deepEqual(post?.fields, {});
  assert.equal(campaign?.name, "campaign");
  assert.equal(campaign?.localized, true);
  assert.equal(campaign?.resolvePreviewUrl, undefined);
});

test("createStudioClientConfig returns equal configs for equal input", () => {
  const serializable = toSerializableStudioConfig(createPreparedConfig());
  const loaders = { Callout: async () => Callout };

  const first = createStudioClientConfig(serializable, { loaders });
  const second = createStudioClientConfig(
    JSON.parse(JSON.stringify(serializable)) as SerializableStudioConfig,
    { loaders },
  );

  assert.equal(first.components?.[0]?.load, second.components?.[0]?.load);
  assert.deepEqual(
    JSON.stringify({ ...first, types: undefined }),
    JSON.stringify({ ...second, types: undefined }),
  );
});
