import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BUILT_IN_MDX_COMPONENTS, Box, Image, Link, Text } from "./index.js";

test("Box renders a div with children and passes style through", () => {
  const markup = renderToStaticMarkup(
    createElement(Box, { style: { marginTop: 8, color: "red" } }, "Box copy"),
  );

  assert.equal(markup, '<div style="margin-top:8px;color:red">Box copy</div>');
});

test("Text renders a span with children and passes style through", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Text,
      { style: { fontWeight: 600, lineHeight: 1.4 } },
      "Text copy",
    ),
  );

  assert.equal(
    markup,
    '<span style="font-weight:600;line-height:1.4">Text copy</span>',
  );
});

test("Image renders an img with src, alt, and style", () => {
  const markup = renderToStaticMarkup(
    createElement(Image, {
      src: "https://example.com/hero.png",
      alt: "Hero",
      style: { width: 320 },
    }),
  );

  assert.match(
    markup,
    /<img src="https:\/\/example\.com\/hero\.png" alt="Hero" style="width:320px"\/>/,
  );
});

test("Link renders an anchor with href, children, and style", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Link,
      { href: "https://example.com", style: { textDecoration: "none" } },
      "Example",
    ),
  );

  assert.equal(
    markup,
    '<a href="https://example.com" style="text-decoration:none">Example</a>',
  );
});

test("BUILT_IN_MDX_COMPONENTS exports deterministic built-in catalog entries", () => {
  assert.deepEqual(BUILT_IN_MDX_COMPONENTS, [
    {
      name: "Box",
      importPath: "@mdcms/sdk/react-primitives",
      builtIn: true,
      extractedProps: {
        style: { type: "style", required: false },
        children: { type: "rich-text", required: false },
      },
    },
    {
      name: "Text",
      importPath: "@mdcms/sdk/react-primitives",
      builtIn: true,
      extractedProps: {
        style: { type: "style", required: false },
        children: { type: "rich-text", required: false },
      },
    },
    {
      name: "Image",
      importPath: "@mdcms/sdk/react-primitives",
      builtIn: true,
      extractedProps: {
        src: { type: "string", required: true },
        alt: { type: "string", required: true },
        style: { type: "style", required: false },
      },
    },
    {
      name: "Link",
      importPath: "@mdcms/sdk/react-primitives",
      builtIn: true,
      extractedProps: {
        href: { type: "string", required: true },
        style: { type: "style", required: false },
        children: { type: "rich-text", required: false },
      },
    },
  ]);
});
