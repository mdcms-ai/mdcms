import assert from "node:assert/strict";
import { test } from "bun:test";

import { Editor, Extension } from "@tiptap/core";

import {
  MdxComponentExtension,
  MdxIntrinsicElementExtension,
  MdxRawJsxExtension,
  EditorImageExtension,
  createEditorCoreExtensions,
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
  parseMdxMarkdownToTipTapDocument,
  roundTripMarkdown,
  serializeDocumentToMarkdown,
} from "@mdcms/editor-core";

test("editor core parses and serializes markdown without React", () => {
  const document = parseMarkdownToDocument("# Launch Notes\n\nShip it.");
  const markdown = serializeDocumentToMarkdown(document);

  assert.match(markdown, /# Launch Notes/);
  assert.match(markdown, /Ship it\./);
});

test("editor core preserves MDX components and native images", () => {
  const source = [
    '<Callout type="warning">',
    "![Hero image](https://cdn.example.com/hero.png)",
    "",
    "Body",
    "</Callout>",
  ].join("\n");

  const markdown = roundTripMarkdown(source).markdown;

  assert.match(markdown, /<Callout type="warning">/);
  assert.match(
    markdown,
    /!\[Hero image\]\(https:\/\/cdn\.example\.com\/hero\.png\)/,
  );
  assert.match(markdown, /Body/);
  assert.match(markdown, /<\/Callout>/);
});

test("editor core exposes a neutral image extension name", async () => {
  const core = (await import("@mdcms/editor-core")) as Record<string, unknown>;

  assert.ok(core.EditorImageExtension);
});

test("editor core exposes the MDX parser helper", () => {
  const document = parseMdxMarkdownToTipTapDocument('<Hero title="Launch" />');

  assert.deepEqual(document.content?.[0], {
    type: "mdxComponent",
    attrs: {
      componentName: "Hero",
      isVoid: true,
      props: {
        title: "Launch",
      },
    },
  });
});

test("editor core extensions support headless markdown extraction", () => {
  const editor = new Editor({
    content: parseMarkdownToDocument("# Launch Notes"),
    contentType: "json",
    extensions: createEditorCoreExtensions(),
  });

  try {
    assert.match(extractMarkdownFromEditor(editor), /# Launch Notes/);
  } finally {
    editor.destroy();
  }
});

test("editor core extension factory accepts node extension overrides", () => {
  const customCodeBlock = Extension.create({ name: "codeBlock" });
  const customImage = EditorImageExtension.extend({});
  const customComponent = MdxComponentExtension.extend({});
  const customIntrinsicElement = MdxIntrinsicElementExtension.extend({});
  const customRawJsx = MdxRawJsxExtension.extend({});

  const extensions = createEditorCoreExtensions({
    codeBlock: customCodeBlock,
    image: customImage,
    mdxComponent: customComponent,
    mdxIntrinsicElement: customIntrinsicElement,
    mdxRawJsx: customRawJsx,
  });

  assert.equal(extensions.includes(customCodeBlock), true);
  assert.equal(extensions.includes(customImage), true);
  assert.equal(extensions.includes(customComponent), true);
  assert.equal(extensions.includes(customIntrinsicElement), true);
  assert.equal(extensions.includes(customRawJsx), true);
});
