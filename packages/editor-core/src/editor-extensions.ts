import type { Extensions } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";

import { MdxComponentExtension } from "./mdx-component-extension.js";
import { MdxIntrinsicElementExtension } from "./mdx-intrinsic-element-extension.js";
import { MdxIntrinsicInlineExtension } from "./mdx-intrinsic-inline-extension.js";
import { MdxRawJsxExtension } from "./mdx-raw-jsx-extension.js";
import { EditorImageExtension } from "./studio-image-extension.js";

// Returns a lowlight instance seeded with the common language set and with
// `highlightAuto` replaced by a plain-text no-op. CodeBlockLowlight falls
// back to `highlightAuto` whenever a block has no language attribute; the
// default guesses at a grammar and renders tokens inside what the user
// thinks is a plain-text block. Overriding it keeps "Plain text" honest
// and matches the spec's "no auto-detection" decision.
export function createEditorCoreLowlight() {
  const instance = createLowlight(common);

  (instance as { highlightAuto: (value: string) => unknown }).highlightAuto = (
    value: string,
  ) => ({
    type: "root",
    data: { language: undefined },
    children: [{ type: "text", value }],
  });

  return instance;
}

// Module-scope lowlight instance — language grammars are registered exactly
// once for the lifetime of the process rather than per editor mount.
const lowlightInstance = createEditorCoreLowlight();

const HeadlessCodeBlock = CodeBlockLowlight.configure({
  lowlight: lowlightInstance,
  defaultLanguage: null,
});

export type EditorCoreExtensionOverrides = {
  mdxRawJsx?: Extensions[number];
  mdxComponent?: Extensions[number];
  mdxIntrinsicElement?: Extensions[number];
  image?: Extensions[number];
  codeBlock?: Extensions[number];
};

export type EditorCoreExtensionOptions = EditorCoreExtensionOverrides & {
  extensionsAfterHighlight?: Extensions;
};

export function createEditorCoreExtensions(
  options?: EditorCoreExtensionOptions,
): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      // The default dropcursor is a 1px `currentColor` line, which is
      // almost invisible on the editor's typical white background and
      // makes it hard to tell where a dragged MDX block will land. Use
      // a thicker bar in the theme's primary accent so the drop target
      // reads at a glance during reorder.
      dropcursor: {
        width: 4,
        color: "var(--color-primary, #2563eb)",
      },
    }),
    Underline,
    Highlight,
    ...(options?.extensionsAfterHighlight ?? []),
    Link.configure({
      openOnClick: false,
      HTMLAttributes: {
        rel: "noopener noreferrer nofollow",
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    options?.codeBlock ?? HeadlessCodeBlock,
    options?.image ?? EditorImageExtension,
    MdxIntrinsicInlineExtension,
    options?.mdxComponent ?? MdxComponentExtension,
    options?.mdxIntrinsicElement ?? MdxIntrinsicElementExtension,
    options?.mdxRawJsx ?? MdxRawJsxExtension,
    Markdown,
  ];
}
