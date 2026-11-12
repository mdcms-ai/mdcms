import assert from "node:assert/strict";
import { test } from "bun:test";
import type { DragEvent as ReactDragEvent } from "react";

import { createDocumentEditor } from "../../../document-editor.js";
import { extractMarkdownFromEditor } from "../../../markdown-pipeline.js";
import { insertVisualCompositionBlock } from "./visual-composition-commands.js";
import {
  handleVisualCompositionDrop,
  writeVisualCompositionDragPayload,
  type VisualCompositionDropEventLike,
} from "./visual-composition-palette-dnd.js";
import type {
  VisualCompositionBlock,
  VisualCompositionMdxComponentBlock,
} from "./visual-composition-types.js";

const ctaBlock: VisualCompositionMdxComponentBlock = {
  kind: "mdx-component",
  id: "component:Cta",
  label: "Cta",
  group: "Components",
  component: {
    name: "Cta",
    importPath: "@/components/Cta",
    extractedProps: {
      label: { type: "string", required: false },
    },
  },
};

function createDataTransfer() {
  const data = new Map<string, string>();

  return {
    effectAllowed: "uninitialized",
    dropEffect: "none",
    get types() {
      return Array.from(data.keys());
    },
    setData(format: string, value: string) {
      data.set(format, value);
    },
    getData(format: string) {
      return data.get(format) ?? "";
    },
  };
}

function createDropEvent(dataTransfer: ReturnType<typeof createDataTransfer>) {
  let defaultPrevented = false;
  const event: VisualCompositionDropEventLike & {
    readonly defaultPrevented: boolean;
  } = {
    dataTransfer,
    clientX: 120,
    clientY: 80,
    preventDefault: () => {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };

  return event;
}

function createPaletteDropEvent(block: VisualCompositionBlock) {
  const dataTransfer = createDataTransfer();
  writeVisualCompositionDragPayload(
    { dataTransfer } as unknown as ReactDragEvent<HTMLElement>,
    block,
  );

  return createDropEvent(dataTransfer);
}

function listTopLevelNodes(editor: ReturnType<typeof createDocumentEditor>) {
  const nodes: Array<{ type: string; text: string; componentName?: string }> =
    [];

  editor.state.doc.forEach((node) => {
    nodes.push({
      type: node.type.name,
      text: node.textContent,
      ...(node.type.name === "mdxComponent"
        ? { componentName: node.attrs.componentName as string }
        : {}),
    });
  });

  return nodes;
}

test("a palette drop inserts an mdxComponent node at the drop position instead of the label text", () => {
  const editor = createDocumentEditor({
    content: "First paragraph\n\nSecond paragraph",
  });

  try {
    const event = createPaletteDropEvent(ctaBlock);
    // The payload carries the label as text/plain; that is what an unclaimed
    // drop would paste into the document.
    assert.equal(event.dataTransfer?.getData("text/plain"), "Cta");

    const betweenParagraphs = editor.state.doc.child(0).nodeSize;
    const handled = handleVisualCompositionDrop(event, {
      readOnly: false,
      resolvePosition: () => betweenParagraphs,
      requestInsertion: (block, position) => {
        insertVisualCompositionBlock(editor, { block, position });
      },
    });

    assert.equal(handled, true);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(listTopLevelNodes(editor), [
      { type: "paragraph", text: "First paragraph" },
      { type: "mdxComponent", text: "", componentName: "Cta" },
      { type: "paragraph", text: "Second paragraph" },
    ]);
    assert.equal(editor.state.doc.textContent.includes("Cta"), false);
    assert.match(extractMarkdownFromEditor(editor), /<Cta\s*\/>/);
  } finally {
    editor.destroy();
  }
});

test("a palette drop over paragraph text inserts the component beside the paragraph without splitting it", () => {
  const editor = createDocumentEditor({
    content: "First paragraph\n\nSecond paragraph",
  });

  try {
    // Inside "First paragraph", past its midpoint ("First paragr|aph").
    const insideFirstParagraphText = 13;
    const handled = handleVisualCompositionDrop(
      createPaletteDropEvent(ctaBlock),
      {
        readOnly: false,
        resolvePosition: () => insideFirstParagraphText,
        requestInsertion: (block, position) => {
          insertVisualCompositionBlock(editor, { block, position });
        },
      },
    );

    assert.equal(handled, true);
    assert.deepEqual(listTopLevelNodes(editor), [
      { type: "paragraph", text: "First paragraph" },
      { type: "mdxComponent", text: "", componentName: "Cta" },
      { type: "paragraph", text: "Second paragraph" },
    ]);
  } finally {
    editor.destroy();
  }
});

test("a palette drop in a read-only editor is claimed without inserting anything", () => {
  const event = createPaletteDropEvent(ctaBlock);
  const requested: unknown[] = [];

  const handled = handleVisualCompositionDrop(event, {
    readOnly: true,
    resolvePosition: () => 1,
    requestInsertion: (block, position) => {
      requested.push({ block, position });
    },
  });

  assert.equal(handled, true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(requested, []);
});

test("a drop without a palette payload is left to other handlers", () => {
  const dataTransfer = createDataTransfer();
  dataTransfer.setData("text/plain", "Cta");
  const event = createDropEvent(dataTransfer);
  const requested: unknown[] = [];

  const handled = handleVisualCompositionDrop(event, {
    readOnly: false,
    resolvePosition: () => 1,
    requestInsertion: (block, position) => {
      requested.push({ block, position });
    },
  });

  assert.equal(handled, false);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(requested, []);
});
