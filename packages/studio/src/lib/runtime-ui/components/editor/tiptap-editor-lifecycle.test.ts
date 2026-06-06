import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { MediaAsset } from "@mdcms/shared";

import { createMediaAssetsInsertContent } from "./media-markdown-insertion.js";
import {
  createTipTapEditorDependencies,
  getSelectionMarkdownForAi,
  resolveSlashPickerCoordsForEditor,
} from "./tiptap-editor-utils.js";
import {
  insertUploadedMediaFiles,
  resolveMediaUploadFileEvent,
  TipTapEditor,
} from "./tiptap-editor.js";
import { createDocumentEditor } from "../../../document-editor.js";

function createMediaAsset(asset: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "media_1",
    project: "default",
    filename: "asset.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    url: "https://cdn.example.com/asset.png",
    uploadedBy: "user_1",
    uploadedAt: "2026-06-06T12:00:00.000Z",
    ...asset,
  };
}

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

test("TipTapEditor renders an enabled media upload input and toolbar button for writable upload targets", () => {
  const markup = renderToStaticMarkup(
    createElement(TipTapEditor, {
      initialContent: "# Launch Notes",
      mediaUpload: {
        canUpload: true,
        isUploading: false,
        uploadFiles: async () => [],
      },
    }),
  );

  assert.match(markup, /type="file"/);
  assert.match(markup, /multiple=""/);
  assert.match(markup, /aria-label="Upload media"/);
  assert.match(markup, /<button(?=[^>]*aria-label="Upload media")[^>]*>/);
  assert.doesNotMatch(
    markup,
    /<button(?=[^>]*aria-label="Upload media")(?=[^>]*\sdisabled(?:=""|\s|>))[^>]*>/,
  );
});

test("TipTapEditor disables the image toolbar control when media upload is unavailable", () => {
  const markup = renderToStaticMarkup(
    createElement(TipTapEditor, {
      initialContent: "# Launch Notes",
    }),
  );

  assert.match(
    markup,
    /<button(?=[^>]*aria-label="Upload media unavailable in this target\.")(?=[^>]*\sdisabled(?:=""|\s|>))[^>]*>/,
  );
});

test("resolveMediaUploadFileEvent handles paste and drop files without filtering", () => {
  const files = [
    new File(["image"], "image.png", { type: "image/png" }),
    new File(["data"], "data.custom", { type: "application/x-custom" }),
  ];

  assert.deepEqual(
    resolveMediaUploadFileEvent({
      canUpload: true,
      files,
    }),
    {
      files,
      shouldPreventDefault: true,
      shouldUpload: true,
    },
  );

  assert.deepEqual(
    resolveMediaUploadFileEvent({
      canUpload: false,
      files,
    }),
    {
      files,
      shouldPreventDefault: true,
      shouldUpload: false,
    },
  );

  assert.deepEqual(
    resolveMediaUploadFileEvent({
      canUpload: true,
      files: [],
      types: ["Files"],
    }),
    {
      files: [],
      shouldPreventDefault: true,
      shouldUpload: false,
    },
  );
});

test("insertUploadedMediaFiles uploads unfiltered files and inserts returned media at the current selection", async () => {
  const files = [
    new File(["hero"], "hero.unsupported", {
      type: "application/x-custom",
    }),
    new File(["brief"], "brief.pdf", { type: "application/pdf" }),
  ];
  const assets = [
    createMediaAsset({
      id: "media_hero",
      filename: "hero.png",
      mimeType: "image/png",
      url: "https://cdn.example.com/hero.png",
    }),
    createMediaAsset({
      id: "media_brief",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      url: "https://cdn.example.com/brief.pdf",
    }),
  ];
  let uploadedFiles: File[] = [];
  const insertedContent: unknown[] = [];
  let updateCount = 0;

  const didInsert = await insertUploadedMediaFiles({
    editor: {
      commands: {
        insertContent(content: unknown) {
          insertedContent.push(content);
          return true;
        },
      },
    } as never,
    files,
    mediaUpload: {
      canUpload: true,
      isUploading: false,
      uploadFiles: async (nextFiles) => {
        uploadedFiles = nextFiles;
        return assets;
      },
    },
    onInserted: () => {
      updateCount += 1;
    },
  });

  assert.equal(didInsert, true);
  assert.deepEqual(uploadedFiles, files);
  assert.deepEqual(insertedContent, [createMediaAssetsInsertContent(assets)]);
  assert.equal(updateCount, 1);
});

test("insertUploadedMediaFiles resolves the insertion target after upload completes", async () => {
  const asset = createMediaAsset({
    filename: "mapped.png",
    mimeType: "image/png",
    url: "https://cdn.example.com/mapped.png",
  });
  const insertions: Array<{
    range: { from: number; to: number };
    content: unknown;
  }> = [];
  let mappedSelection = { from: 4, to: 4 };

  const didInsert = await insertUploadedMediaFiles({
    editor: {
      commands: {
        insertContentAt(range: { from: number; to: number }, content: unknown) {
          insertions.push({ range, content });
          return true;
        },
      },
    } as never,
    files: [new File(["mapped"], "mapped.png", { type: "image/png" })],
    mediaUpload: {
      canUpload: true,
      isUploading: false,
      uploadFiles: async () => {
        mappedSelection = { from: 9, to: 9 };
        return [asset];
      },
    },
    resolveInsertion: () => ({ selection: mappedSelection }),
    onInserted: () => {},
  });

  assert.equal(didInsert, true);
  assert.deepEqual(insertions, [
    {
      range: { from: 9, to: 9 },
      content: createMediaAssetsInsertContent([asset]),
    },
  ]);
});

test("insertUploadedMediaFiles replaces the initiating non-empty selection", async () => {
  const asset = createMediaAsset({
    filename: "selected.png",
    mimeType: "image/png",
    url: "https://cdn.example.com/selected.png",
  });
  const insertions: Array<{
    range: { from: number; to: number };
    content: unknown;
  }> = [];

  const didInsert = await insertUploadedMediaFiles({
    editor: {
      commands: {
        insertContentAt(range: { from: number; to: number }, content: unknown) {
          insertions.push({ range, content });
          return true;
        },
      },
    } as never,
    files: [new File(["selected"], "selected.png", { type: "image/png" })],
    mediaUpload: {
      canUpload: true,
      isUploading: false,
      uploadFiles: async () => [asset],
    },
    selection: { from: 5, to: 12 },
    onInserted: () => {},
  });

  assert.equal(didInsert, true);
  assert.deepEqual(insertions, [
    {
      range: { from: 5, to: 12 },
      content: createMediaAssetsInsertContent([asset]),
    },
  ]);
});

test("insertUploadedMediaFiles inserts uploaded media at a supplied drop position", async () => {
  const asset = createMediaAsset({
    filename: "drop.png",
    mimeType: "image/png",
    url: "https://cdn.example.com/drop.png",
  });
  const insertions: Array<{ position: number; content: unknown }> = [];

  const didInsert = await insertUploadedMediaFiles({
    editor: {
      commands: {
        insertContentAt(position: number, content: unknown) {
          insertions.push({ position, content });
          return true;
        },
      },
    } as never,
    files: [new File(["drop"], "drop.bin")],
    mediaUpload: {
      canUpload: true,
      isUploading: false,
      uploadFiles: async () => [asset],
    },
    position: 42,
    onInserted: () => {},
  });

  assert.equal(didInsert, true);
  assert.deepEqual(insertions, [
    { position: 42, content: createMediaAssetsInsertContent([asset]) },
  ]);
});

test("insertUploadedMediaFiles aborts insertion when the editor target becomes stale after upload", async () => {
  const asset = createMediaAsset();
  let insertCount = 0;

  const didInsert = await insertUploadedMediaFiles({
    editor: {
      commands: {
        insertContent() {
          insertCount += 1;
          return true;
        },
      },
    } as never,
    files: [new File(["hero"], "hero.png", { type: "image/png" })],
    mediaUpload: {
      canUpload: true,
      isUploading: false,
      uploadFiles: async () => [asset],
    },
    canInsert: () => false,
    onInserted: () => {
      throw new Error("onInserted should not run");
    },
  });

  assert.equal(didInsert, false);
  assert.equal(insertCount, 0);
});

test("insertUploadedMediaFiles propagates upload failures without emitting an editor update", async () => {
  const failure = new Error("Upload failed");
  let updateCount = 0;

  await assert.rejects(
    insertUploadedMediaFiles({
      editor: {
        commands: {
          insertContent() {
            throw new Error("insertContent should not run");
          },
        },
      } as never,
      files: [new File(["hero"], "hero.png", { type: "image/png" })],
      mediaUpload: {
        canUpload: true,
        isUploading: false,
        uploadFiles: async () => {
          throw failure;
        },
      },
      onInserted: () => {
        updateCount += 1;
      },
    }),
    failure,
  );

  assert.equal(updateCount, 0);
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
