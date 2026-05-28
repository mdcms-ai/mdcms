import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import { VisualCompositionInsertionDialog } from "./visual-composition-insertion-dialog.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

function createContext(component: MdxCatalogComponent): StudioMountContext {
  return {
    apiBaseUrl: "http://localhost:4000",
    basePath: "/admin",
    auth: { mode: "cookie" },
    hostBridge: {
      version: "1",
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    mdx: {
      catalog: {
        components: [component],
      },
      resolvePropsEditor: async () => null,
    },
  };
}

function createImageComponent(): MdxCatalogComponent {
  return {
    name: "Image",
    importPath: "@mdcms/sdk/react-primitives",
    builtIn: true,
    extractedProps: {
      src: { type: "string", required: true },
      alt: { type: "string", required: true },
      style: { type: "style", required: false },
    },
  };
}

test("VisualCompositionInsertionDialog disables submit until required props are present", () => {
  const image = createImageComponent();
  const markup = renderToStaticMarkup(
    createElement(VisualCompositionInsertionDialog, {
      context: createContext(image),
      pendingInsertion: {
        block: {
          kind: "mdx-component",
          id: "component:Image",
          label: "Image",
          group: "Media",
          component: image,
        },
      },
      value: {},
      onValueChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-visual-insertion-dialog="Image"/);
  assert.match(markup, /Missing required props: src, alt/);
  assert.match(markup, /disabled=""/);
});

test("VisualCompositionInsertionDialog enables submit when required props are valid", () => {
  const image = createImageComponent();
  const markup = renderToStaticMarkup(
    createElement(VisualCompositionInsertionDialog, {
      context: createContext(image),
      pendingInsertion: {
        block: {
          kind: "mdx-component",
          id: "component:Image",
          label: "Image",
          group: "Media",
          component: image,
        },
      },
      value: { src: "/hero.png", alt: "Hero" },
      onValueChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-visual-insertion-dialog="Image"/);
  assert.doesNotMatch(markup, /Missing required props/);
  assert.match(markup, /Insert block/);
  assert.doesNotMatch(markup, /disabled=""/);
});

test("VisualCompositionInsertionDialog renders nothing for safe Markdown insertions", () => {
  const image = createImageComponent();
  const markup = renderToStaticMarkup(
    createElement(VisualCompositionInsertionDialog, {
      context: createContext(image),
      pendingInsertion: {
        block: {
          kind: "markdown",
          id: "paragraph",
          label: "Paragraph",
          group: "Text",
          nodeType: "paragraph",
        },
      },
      value: {},
      onValueChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );

  assert.equal(markup, "");
});
