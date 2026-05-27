import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createTipTapEditorDependencies,
  getSelectionMarkdownForAi,
  resolveSlashPickerCoordsForEditor,
} from "./tiptap-editor-utils.js";
import { createDocumentEditor } from "../../../document-editor.js";

test("createTipTapEditorDependencies keeps editor lifetime independent of onChange identity", () => {
  const hostBridge = {
    version: "1" as const,
    resolveComponent: () => null,
    renderMdxPreview: () => () => {},
  };

  assert.deepEqual(
    createTipTapEditorDependencies({
      placeholder: "Start writing, or press / for commands...",
      hostBridge,
      readOnly: false,
      forbidden: false,
    }),
    ["Start writing, or press / for commands...", hostBridge, false, false],
  );
});

test("resolveSlashPickerCoordsForEditor returns null while the editor view is remounting", () => {
  const trigger = {
    query: "PricingTable",
    from: 12,
    to: 25,
  };
  const container = {
    getBoundingClientRect: () => ({
      top: 32,
      left: 24,
    }),
  };

  assert.equal(
    resolveSlashPickerCoordsForEditor({
      editor: {
        get view() {
          throw new Error(
            "[tiptap error]: The editor view is not available. Cannot access view['coordsAtPos']. The editor may not be mounted yet.",
          );
        },
      } as never,
      trigger,
      container,
    }),
    null,
  );
});

test("getSelectionMarkdownForAi keeps list markers for whole-list text selections", () => {
  const editor = createDocumentEditor({
    content: [
      "The sample stack seeds:",
      "",
      "- one demo user",
      "- one fixed demo API key",
      "- sample content documents",
    ].join("\n"),
  });

  try {
    let from = -1;
    let to = -1;

    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "text" && node.text === "one demo user") {
        from = pos;
      }
      if (
        node.type.name === "text" &&
        node.text === "sample content documents"
      ) {
        to = pos + node.text.length;
      }

      return true;
    });

    assert.equal(from >= 0, true);
    assert.equal(to > from, true);

    assert.deepEqual(getSelectionMarkdownForAi(editor, { from, to }), {
      mode: "markdown",
      text: [
        "- one demo user",
        "- one fixed demo API key",
        "- sample content documents",
      ].join("\n"),
    });
  } finally {
    editor.destroy();
  }
});
