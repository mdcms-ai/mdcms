import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import {
  parseAdvancedStyleObject,
  patchInlineStyleValue,
} from "./visual-style-inspector-utils.js";
import { VisualStyleInspector } from "./visual-style-inspector.js";

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

test("VisualStyleInspector renders intentional style controls for components with style props", () => {
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
  assert.match(markup, /data-mdcms-visual-style-section="layout"/);
  assert.match(markup, /data-mdcms-visual-style-section="spacing"/);
  assert.match(markup, /data-mdcms-visual-style-section="fill"/);
  assert.match(markup, /data-mdcms-visual-style-section="typography"/);
  assert.match(markup, /data-mdcms-visual-style-section="advanced"/);
  assert.match(markup, /data-mdcms-style-segmented-control="display"/);
  assert.match(markup, /data-mdcms-style-option-icon="display:flex"/);
  assert.match(markup, /data-mdcms-style-option-icon="textAlign:center"/);
  assert.match(markup, /aria-label="Flex"/);
  assert.match(markup, /aria-label="Center"/);
  assert.match(markup, /data-mdcms-style-box-model="margin"/);
  assert.match(markup, /data-mdcms-style-box-model="padding"/);
  assert.match(markup, /data-mdcms-style-swatch="backgroundColor"/);
  assert.match(markup, /data-mdcms-style-color-picker="backgroundColor"/);
  assert.match(markup, /type="color"/);
  assert.match(markup, /aria-label="Pick Background color"/);
  assert.match(markup, /value="#ffffff"/);
  assert.match(markup, /data-mdcms-style-field="gap"/);
  assert.match(markup, /value="12px"/);
  assert.match(markup, /value="#fff"/);
  assert.doesNotMatch(markup, /data-mdcms-visual-style-group=/);
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

test("VisualStyleInspector keeps the advanced JSON editor collapsed", () => {
  const component = createComponent({
    name: "Box",
    extractedProps: {
      style: { type: "style", required: false },
    },
  });

  const markup = renderToStaticMarkup(
    createElement(VisualStyleInspector, {
      component,
      value: {
        style: {
          borderRadius: "8px",
        },
      },
      readOnly: false,
      onChange: () => {},
    }),
  );

  assert.match(markup, /<details[^>]+data-mdcms-style-advanced-details="Box"/);
  assert.match(markup, /data-mdcms-visual-style-advanced="Box"/);
  assert.doesNotMatch(markup, /<details[^>]+open/);
});
