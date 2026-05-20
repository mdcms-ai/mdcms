import assert from "node:assert/strict";
import { test } from "bun:test";

import type { StudioMountContext } from "@mdcms/shared";

import {
  createMdxComponentNodeAttributes,
  createMdxComponentInsertContent,
  getMdxComponentAutoFormFields,
  getMdxComponentKind,
  isMdxComponentVisibleInInsertUi,
} from "./mdx-component-catalog.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

function createComponent(
  overrides: Partial<MdxCatalogComponent> = {},
): MdxCatalogComponent {
  return {
    name: "HeroBanner",
    importPath: "@/components/mdx/HeroBanner",
    extractedProps: {
      title: { type: "string", required: true },
    },
    ...overrides,
  };
}

test("getMdxComponentKind treats rich-text children components as wrappers", () => {
  const component = createComponent({
    name: "Callout",
    extractedProps: {
      type: { type: "enum", required: true, values: ["info", "warning"] },
      children: { type: "rich-text", required: false },
    },
  });

  assert.equal(getMdxComponentKind(component), "wrapper");
});

test("getMdxComponentKind treats components without rich-text children as void", () => {
  const component = createComponent({
    extractedProps: {
      children: { type: "array", required: true, items: "string" },
    },
  });

  assert.equal(getMdxComponentKind(component), "void");
});

test("isMdxComponentVisibleInInsertUi hides built-in components only", () => {
  assert.equal(isMdxComponentVisibleInInsertUi(createComponent()), true);
  assert.equal(
    isMdxComponentVisibleInInsertUi(
      createComponent({
        name: "Box",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
      }),
    ),
    false,
  );
});

test("getMdxComponentAutoFormFields omits nested rich-text children from props editing controls", () => {
  const component = createComponent({
    name: "Callout",
    extractedProps: {
      title: { type: "string", required: false },
      children: { type: "rich-text", required: false },
    },
  });

  assert.deepEqual(getMdxComponentAutoFormFields(component), [
    { name: "title", control: "text", required: false },
  ]);
});

test("createMdxComponentNodeAttributes creates shared attrs for void and wrapper components", () => {
  assert.deepEqual(
    createMdxComponentNodeAttributes(
      createComponent({
        name: "Callout",
        extractedProps: {
          children: { type: "rich-text", required: false },
        },
      }),
      { tone: "warning" },
    ),
    {
      componentName: "Callout",
      props: { tone: "warning" },
      isVoid: false,
    },
  );

  assert.deepEqual(
    createMdxComponentNodeAttributes(createComponent(), { title: "Launch" }),
    {
      componentName: "HeroBanner",
      props: { title: "Launch" },
      isVoid: true,
    },
  );
});

test("createMdxComponentInsertContent seeds wrapper components with an editable paragraph", () => {
  assert.deepEqual(
    createMdxComponentInsertContent(
      createComponent({
        name: "Callout",
        extractedProps: {
          children: { type: "rich-text", required: false },
        },
      }),
      { tone: "warning" },
    ),
    {
      type: "mdxComponent",
      attrs: {
        componentName: "Callout",
        props: { tone: "warning" },
        isVoid: false,
      },
      content: [{ type: "paragraph" }],
    },
  );
});
