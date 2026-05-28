import assert from "node:assert/strict";
import { test } from "bun:test";

import type { StudioMountContext } from "@mdcms/shared";

import { extractMarkdownFromEditor } from "../../../markdown-pipeline.js";
import { createDocumentEditor } from "../../../document-editor.js";
import { createMdxComponentInsertContent } from "./mdx-component-catalog.js";
import {
  getSelectedMdxComponent,
  selectAdjacentMdxComponent,
  updateSelectedMdxComponentProps,
} from "./mdx-component-selection.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const components: MdxCatalogComponent[] = [
  {
    name: "Callout",
    importPath: "@/components/mdx/Callout",
    description: "Callout",
    extractedProps: {
      type: { type: "enum", required: true, values: ["info", "warning"] },
      children: { type: "rich-text", required: false },
    },
  },
  {
    name: "HeroBanner",
    importPath: "@/components/mdx/HeroBanner",
    extractedProps: {
      title: { type: "string", required: true },
    },
  },
];

test("getSelectedMdxComponent resolves wrapper components when selection is inside nested content", () => {
  const editor = createDocumentEditor({
    content: ['<Callout type="warning">', "Body", "</Callout>"].join("\n"),
  });

  try {
    let textPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "text" && node.text === "Body") {
        textPos = pos + 1;
        return false;
      }

      return true;
    });

    editor.commands.setTextSelection(textPos);

    assert.deepEqual(getSelectedMdxComponent(editor, components), {
      kind: "component",
      component: components[0],
      componentName: "Callout",
      isVoid: false,
      props: { type: "warning" },
      pos: 0,
    });
  } finally {
    editor.destroy();
  }
});

test("getSelectedMdxComponent resolves selected void component nodes", () => {
  const editor = createDocumentEditor({
    content: '<HeroBanner title="Launch" />',
  });

  try {
    let componentPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mdxComponent") {
        componentPos = pos;
        return false;
      }

      return true;
    });

    assert.equal(componentPos >= 0, true);
    editor.commands.setNodeSelection(componentPos);

    assert.deepEqual(getSelectedMdxComponent(editor, components), {
      kind: "component",
      component: components[1],
      componentName: "HeroBanner",
      isVoid: true,
      props: { title: "Launch" },
      pos: componentPos,
    });
  } finally {
    editor.destroy();
  }
});

test("getSelectedMdxComponent resolves intrinsic elements when selection is inside nested content", () => {
  const editor = createDocumentEditor({
    content: ['<div style={{display: "flex"}}>', "Body", "</div>"].join("\n"),
  });

  try {
    let textPos = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "text" && node.text === "Body") {
        textPos = pos + 1;
        return false;
      }

      return true;
    });

    editor.commands.setTextSelection(textPos);

    assert.deepEqual(getSelectedMdxComponent(editor, components), {
      kind: "intrinsic",
      component: undefined,
      componentName: "div",
      isVoid: false,
      props: { style: { display: "flex" } },
      pos: 0,
    });
  } finally {
    editor.destroy();
  }
});

test("updateSelectedMdxComponentProps merges props onto the selected component node", () => {
  const editor = createDocumentEditor({
    content: '<HeroBanner title="Launch" />',
  });

  try {
    let componentPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mdxComponent") {
        componentPos = pos;
        return false;
      }

      return true;
    });

    editor.commands.setNodeSelection(componentPos);

    assert.equal(
      updateSelectedMdxComponentProps(editor, components, {
        title: "Updated",
        theme: "dark",
      }),
      true,
    );

    assert.match(
      extractMarkdownFromEditor(editor),
      /<HeroBanner title="Updated" theme="dark" \/>/,
    );
  } finally {
    editor.destroy();
  }
});

test("updateSelectedMdxComponentProps merges props onto the selected intrinsic element node", () => {
  const editor = createDocumentEditor({
    content: ['<div style={{display: "block"}}>', "Body", "</div>"].join("\n"),
  });

  try {
    let elementPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mdxIntrinsicElement") {
        elementPos = pos;
        return false;
      }

      return true;
    });

    editor.commands.setNodeSelection(elementPos);

    assert.equal(
      updateSelectedMdxComponentProps(editor, components, {
        style: { display: "flex", gap: "1rem" },
      }),
      true,
    );

    assert.match(
      extractMarkdownFromEditor(editor),
      /<div style=\{\{"display":"flex","gap":"1rem"\}\}>/,
    );
  } finally {
    editor.destroy();
  }
});

test("updateSelectedMdxComponentProps refuses mutation when readOnly or forbidden is set", () => {
  const editor = createDocumentEditor({
    content: '<HeroBanner title="Launch" />',
  });

  try {
    let componentPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mdxComponent") {
        componentPos = pos;
        return false;
      }

      return true;
    });

    editor.commands.setNodeSelection(componentPos);

    assert.equal(
      updateSelectedMdxComponentProps(
        editor,
        components,
        { title: "Blocked" },
        { readOnly: true },
      ),
      false,
    );
    assert.equal(
      updateSelectedMdxComponentProps(
        editor,
        components,
        { title: "Blocked" },
        { forbidden: true },
      ),
      false,
    );
    assert.match(extractMarkdownFromEditor(editor), /title="Launch"/);
  } finally {
    editor.destroy();
  }
});

test("selectAdjacentMdxComponent promotes a newly inserted void component to the active node selection", () => {
  const editor = createDocumentEditor({
    content: "Placeholder",
  });

  try {
    editor.commands.selectAll();
    assert.equal(
      editor.commands.insertContent(
        createMdxComponentInsertContent(components[1]!),
      ),
      true,
    );
    assert.equal(getSelectedMdxComponent(editor, components), null);
    assert.equal(selectAdjacentMdxComponent(editor), true);
    assert.deepEqual(getSelectedMdxComponent(editor, components), {
      kind: "component",
      component: components[1],
      componentName: "HeroBanner",
      isVoid: true,
      props: {},
      pos: 0,
    });
  } finally {
    editor.destroy();
  }
});
