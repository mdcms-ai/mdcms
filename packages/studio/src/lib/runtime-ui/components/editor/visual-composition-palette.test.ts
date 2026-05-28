import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import { createVisualCompositionPaletteGroups } from "./visual-composition-commands.js";
import { writeVisualCompositionDragPayload } from "./visual-composition-palette-dnd.js";
import { VisualCompositionPalette } from "./visual-composition-palette.js";

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

test("VisualCompositionPalette renders grouped Markdown, built-in, and host blocks", () => {
  const groups = createVisualCompositionPaletteGroups([
    createComponent({
      name: "Box",
      builtIn: true,
      extractedProps: {
        children: { type: "rich-text", required: false },
      },
    }),
    createComponent({
      name: "Image",
      builtIn: true,
      extractedProps: {
        src: { type: "string", required: true },
        alt: { type: "string", required: true },
      },
    }),
    createComponent({
      name: "Hero",
      description: "Marketing hero",
    }),
  ]);

  const markup = renderToStaticMarkup(
    createElement(VisualCompositionPalette, {
      groups,
      query: "",
      readOnly: false,
      onQueryChange: () => {},
      onInsert: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-visual-palette="true"/);
  assert.match(markup, /data-mdcms-visual-palette-group="Text"/);
  assert.match(markup, /data-mdcms-visual-palette-group="Layout"/);
  assert.match(markup, /data-mdcms-visual-palette-item="paragraph"/);
  assert.match(markup, /data-mdcms-visual-palette-item="component:Box"/);
  assert.match(markup, /data-mdcms-visual-palette-item="component:Image"/);
  assert.match(markup, /data-mdcms-visual-palette-item="component:Hero"/);
  assert.match(markup, /draggable="true"/);
});

test("VisualCompositionPalette filters by query across block labels and descriptions", () => {
  const groups = createVisualCompositionPaletteGroups([
    createComponent({
      name: "Box",
      builtIn: true,
      extractedProps: {
        children: { type: "rich-text", required: false },
      },
    }),
    createComponent({
      name: "Hero",
      description: "Marketing hero",
    }),
  ]);

  const markup = renderToStaticMarkup(
    createElement(VisualCompositionPalette, {
      groups,
      query: "marketing",
      readOnly: false,
      onQueryChange: () => {},
      onInsert: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-visual-palette-item="component:Hero"/);
  assert.doesNotMatch(markup, /data-mdcms-visual-palette-item="paragraph"/);
  assert.doesNotMatch(markup, /data-mdcms-visual-palette-item="component:Box"/);
});

test("writeVisualCompositionDragPayload also exposes plain text for ProseMirror dropcursor", () => {
  const calls: Array<[string, string]> = [];
  const dataTransfer = {
    effectAllowed: "",
    setData(type: string, value: string) {
      calls.push([type, value]);
    },
  };

  writeVisualCompositionDragPayload(
    {
      dataTransfer,
    } as unknown as Parameters<typeof writeVisualCompositionDragPayload>[0],
    {
      kind: "mdx-component",
      id: "component:Image",
      label: "Image",
      group: "Media",
      component: createComponent({
        name: "Image",
        builtIn: true,
      }),
    },
  );

  assert.equal(dataTransfer.effectAllowed, "copy");
  assert.equal(
    calls.some(([type]) => type === "text/plain"),
    true,
  );
  assert.equal(calls.find(([type]) => type === "text/plain")?.[1], "Image");
});
