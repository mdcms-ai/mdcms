import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import { MdxComponentPicker } from "./mdx-component-picker.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const components: MdxCatalogComponent[] = [
  {
    name: "Callout",
    importPath: "@/components/mdx/Callout",
    description: "A wrapper callout",
    extractedProps: {
      children: { type: "rich-text", required: false },
    },
  },
  {
    name: "HeroBanner",
    importPath: "@/components/mdx/HeroBanner",
    description: "A hero banner",
    extractedProps: {
      title: { type: "string", required: true },
    },
  },
];

test("MdxComponentPicker renders catalog components with kind badges", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components,
      onSelect: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-picker-item="Callout"/);
  assert.match(markup, /data-mdcms-mdx-picker-item="HeroBanner"/);
  // Slash-menu rows no longer surface the wrapper/void kind label — the
  // distinction is implementation detail and the picker just lists each
  // component by name + description.
  assert.doesNotMatch(markup, />wrapper</);
  assert.doesNotMatch(markup, />void</);
});

test("MdxComponentPicker filters components by query", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components,
      query: "hero",
      onSelect: () => {},
    }),
  );

  assert.doesNotMatch(markup, /data-mdcms-mdx-picker-item="Callout"/);
  assert.match(markup, /data-mdcms-mdx-picker-item="HeroBanner"/);
});

test("MdxComponentPicker hides built-in components from insert surfaces", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components: [
        {
          name: "Box",
          importPath: "@mdcms/sdk/react-primitives",
          builtIn: true,
          extractedProps: {
            children: { type: "rich-text", required: false },
          },
        },
        ...components,
      ],
      onSelect: () => {},
    }),
  );

  assert.doesNotMatch(markup, /data-mdcms-mdx-picker-item="Box"/);
  assert.match(markup, /data-mdcms-mdx-picker-item="Callout"/);
});

test("MdxComponentPicker renders empty when only built-in components exist", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components: [
        {
          name: "Box",
          importPath: "@mdcms/sdk/react-primitives",
          builtIn: true,
          extractedProps: {
            children: { type: "rich-text", required: false },
          },
        },
      ],
      onSelect: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-picker-state="empty"/);
});

test("MdxComponentPicker renders empty and forbidden states deterministically", () => {
  const emptyMarkup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components: [],
      onSelect: () => {},
    }),
  );
  const forbiddenMarkup = renderToStaticMarkup(
    createElement(MdxComponentPicker, {
      components,
      forbidden: true,
      onSelect: () => {},
    }),
  );

  assert.match(emptyMarkup, /data-mdcms-mdx-picker-state="empty"/);
  assert.match(forbiddenMarkup, /data-mdcms-mdx-picker-state="forbidden"/);
  assert.match(forbiddenMarkup, /disabled=""/);
});
