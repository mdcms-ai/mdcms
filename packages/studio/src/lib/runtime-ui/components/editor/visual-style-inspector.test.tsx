import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import {
  parseAdvancedStyleObject,
  patchInlineStyleValue,
  VisualStyleInspector,
} from "./visual-style-inspector.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

function createComponent(
  component: Partial<MdxCatalogComponent> & Pick<MdxCatalogComponent, "name">,
): MdxCatalogComponent {
  return {
    importPath: `@/components/${component.name}`,
    ...component,
  };
}

test("patchInlineStyleValue preserves unrelated keys and removes undefined values", () => {
  assert.deepEqual(
    patchInlineStyleValue(
      { padding: "8px", color: "red", borderRadius: "4px" },
      "backgroundColor",
      "#fff",
    ),
    {
      padding: "8px",
      color: "red",
      borderRadius: "4px",
      backgroundColor: "#fff",
    },
  );

  assert.deepEqual(
    patchInlineStyleValue({ padding: "8px", color: "red" }, "color", undefined),
    { padding: "8px" },
  );
});

test("parseAdvancedStyleObject accepts only flat string and number style values", () => {
  assert.deepEqual(parseAdvancedStyleObject('{"padding":"8px","zIndex":2}'), {
    ok: true,
    value: { padding: "8px", zIndex: 2 },
  });
  assert.deepEqual(parseAdvancedStyleObject('{"hover":{"color":"red"}}'), {
    ok: false,
    message: "Style values must be strings or numbers.",
  });
});

test("VisualStyleInspector renders grouped controls for components with style props", () => {
  const component = createComponent({
    name: "Box",
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
  });

  const markup = renderToStaticMarkup(
    createElement(VisualStyleInspector, {
      component,
      value: {
        style: {
          padding: "12px",
          backgroundColor: "#fff",
          display: "flex",
        },
      },
      readOnly: false,
      onChange: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-visual-style-inspector="Box"/);
  assert.match(markup, /data-mdcms-visual-style-group="spacing"/);
  assert.match(markup, /data-mdcms-visual-style-group="color"/);
  assert.match(markup, /data-mdcms-visual-style-group="typography"/);
  assert.match(markup, /data-mdcms-visual-style-group="layout"/);
  assert.match(markup, /data-mdcms-visual-style-group="advanced"/);
  assert.match(markup, /value="12px"/);
  assert.match(markup, /value="#fff"/);
});

test("VisualStyleInspector renders nothing for components without style props", () => {
  const component = createComponent({
    name: "Hero",
    extractedProps: {
      title: { type: "string", required: true },
    },
  });

  const markup = renderToStaticMarkup(
    createElement(VisualStyleInspector, {
      component,
      value: { title: "Launch" },
      readOnly: false,
      onChange: () => {},
    }),
  );

  assert.equal(markup, "");
});
