import assert from "node:assert/strict";
import { test } from "bun:test";

import type { StudioMountContext } from "@mdcms/shared";

import { createDocumentEditor } from "../../../document-editor.js";
import { extractMarkdownFromEditor } from "../../../markdown-pipeline.js";
import {
  createVisualCompositionPaletteGroups,
  getRequiredMdxComponentPropNames,
  insertVisualCompositionBlock,
  patchSelectedMdxComponentStyle,
  validateMdxComponentRequiredProps,
} from "./visual-composition-commands.js";

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

function findMdxComponentPosition(
  editor: ReturnType<typeof createDocumentEditor>,
) {
  let found = -1;

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "mdxComponent") {
      found = pos;
      return false;
    }

    return true;
  });

  return found;
}

test("createVisualCompositionPaletteGroups exposes Markdown, built-in, and host blocks", () => {
  const groups = createVisualCompositionPaletteGroups([
    createComponent({
      name: "Box",
      builtIn: true,
      extractedProps: {
        style: { type: "style", required: false },
        children: { type: "rich-text", required: false },
      },
    }),
    createComponent({
      name: "Image",
      builtIn: true,
      extractedProps: {
        src: { type: "string", required: true },
        alt: { type: "string", required: true },
        style: { type: "style", required: false },
      },
    }),
    createComponent({
      name: "Link",
      builtIn: true,
      extractedProps: {
        href: { type: "string", required: true },
        style: { type: "style", required: false },
        children: { type: "rich-text", required: false },
      },
    }),
    createComponent({
      name: "Hero",
      description: "Marketing hero",
      extractedProps: {
        eyebrow: { type: "string", required: false },
      },
    }),
  ]);

  assert.deepEqual(
    groups.map((group) => [
      group.label,
      group.blocks.map((block) => block.label),
    ]),
    [
      ["Text", ["Paragraph", "Heading", "List", "Quote"]],
      ["Layout", ["Box"]],
      ["Media", ["Image"]],
      ["Actions", ["Link"]],
      ["Components", ["Hero"]],
    ],
  );
});

test("validateMdxComponentRequiredProps ignores rich-text children and reports missing required props", () => {
  const image = createComponent({
    name: "Image",
    extractedProps: {
      src: { type: "string", required: true },
      alt: { type: "string", required: true },
      style: { type: "style", required: false },
    },
  });
  const wrapper = createComponent({
    name: "Callout",
    extractedProps: {
      children: { type: "rich-text", required: true },
      tone: { type: "enum", required: true, values: ["info", "warning"] },
    },
  });

  assert.deepEqual(getRequiredMdxComponentPropNames(image), ["src", "alt"]);
  assert.deepEqual(validateMdxComponentRequiredProps(image, {}).missing, [
    "src",
    "alt",
  ]);
  assert.deepEqual(
    validateMdxComponentRequiredProps(image, { src: "/hero.png", alt: "Hero" }),
    { valid: true, missing: [] },
  );
  assert.deepEqual(getRequiredMdxComponentPropNames(wrapper), ["tone"]);
});

test("insertVisualCompositionBlock inserts Markdown and MDX blocks through the current editor document", () => {
  const editor = createDocumentEditor({ content: "" });
  const box = createComponent({
    name: "Box",
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
  });

  try {
    assert.equal(
      insertVisualCompositionBlock(editor, {
        kind: "markdown",
        id: "heading",
        label: "Heading",
        group: "Text",
        nodeType: "heading",
      }),
      true,
    );
    assert.equal(
      insertVisualCompositionBlock(editor, {
        kind: "mdx-component",
        id: "component:Box",
        label: "Box",
        group: "Layout",
        component: box,
      }),
      true,
    );

    assert.match(extractMarkdownFromEditor(editor), /^## Heading/);
    assert.match(extractMarkdownFromEditor(editor), /<Box><\/Box>/);
  } finally {
    editor.destroy();
  }
});

test("patchSelectedMdxComponentStyle updates flat style keys without dropping existing keys", () => {
  const editor = createDocumentEditor({
    content: '<Box style={{"padding":"8px","color":"red"}}>\nBody\n</Box>',
  });

  try {
    const pos = findMdxComponentPosition(editor);
    assert.notEqual(pos, -1);
    editor.commands.setNodeSelection(pos);

    assert.equal(
      patchSelectedMdxComponentStyle(editor, { backgroundColor: "#fff" }),
      true,
    );

    assert.match(
      extractMarkdownFromEditor(editor),
      /style=\{\{"padding":"8px","color":"red","backgroundColor":"#fff"\}\}/,
    );
  } finally {
    editor.destroy();
  }
});
