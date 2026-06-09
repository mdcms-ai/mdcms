import { Extension } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";

import { MdxComponentExtension } from "./mdx-component-extension.js";
import { MdxIntrinsicElementExtension } from "./mdx-intrinsic-element-extension.js";
import { MdxIntrinsicInlineExtension } from "./mdx-intrinsic-inline-extension.js";
import { MdxRawJsxExtension } from "./mdx-raw-jsx-extension.js";
import { StudioImageExtension } from "./studio-image-extension.js";

// Returns a lowlight instance seeded with the common language set and with
// `highlightAuto` replaced by a plain-text no-op. CodeBlockLowlight falls
// back to `highlightAuto` whenever a block has no language attribute; the
// default guesses at a grammar and renders tokens inside what the user
// thinks is a plain-text block. Overriding it keeps "Plain text" honest
// and matches the spec's "no auto-detection" decision.
export function createStudioLowlight() {
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
const lowlightInstance = createStudioLowlight();

const BlurSelectionPreserver = Extension.create({
  name: "blurSelectionPreserver",

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey("blurSelectionPreserver");
    let focused = true;

    return [
      new Plugin({
        key: pluginKey,
        props: {
          decorations(state) {
            if (focused) return DecorationSet.empty;
            const { from, to } = state.selection;
            if (from === to) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, {
                class: "ProseMirror-blur-selection",
              }),
            ]);
          },
        },
        view(editorView) {
          const onFocus = () => {
            focused = true;
            editorView.dispatch(editorView.state.tr);
          };
          const onBlur = () => {
            focused = false;
            editorView.dispatch(editorView.state.tr);
          };
          editorView.dom.addEventListener("focus", onFocus);
          editorView.dom.addEventListener("blur", onBlur);
          return {
            destroy() {
              editorView.dom.removeEventListener("focus", onFocus);
              editorView.dom.removeEventListener("blur", onBlur);
            },
          };
        },
      }),
    ];
  },
});

// EmptyParagraphHint adds a `data-mdcms-empty-hint="true"` attribute to the
// empty top-level paragraph containing the caret while the editor is
// focused. CSS in styles.css renders the design's "Type / to insert a
// component…" affordance via a `::before` on that node — scoped to the
// active block only, and only when the block is a doc-root paragraph, so
// the hint appears exactly where `/` would actually open the component
// picker (lists, blockquotes, code blocks, and MDX wrappers do not).
const EmptyParagraphHint = Extension.create({
  name: "emptyParagraphHint",

  addProseMirrorPlugins() {
    const pluginKey = new PluginKey<{ focused: boolean }>("emptyParagraphHint");

    return [
      new Plugin<{ focused: boolean }>({
        key: pluginKey,
        state: {
          init: () => ({ focused: true }),
          apply: (tr, value) => {
            const meta = tr.getMeta(pluginKey);
            if (meta && typeof meta.focused === "boolean") {
              return { focused: meta.focused };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            const pluginState = pluginKey.getState(state);
            if (!pluginState?.focused) return DecorationSet.empty;
            const { selection } = state;
            if (selection.from !== selection.to) return DecorationSet.empty;
            const $pos = selection.$from;
            const node = $pos.parent;
            // The hint only fires on top-level empty paragraphs. Depth 1
            // means the paragraph's direct parent is the doc root —
            // anything deeper (blockquote, list item, MDX wrapper, code
            // block, custom container) suppresses the hint, since "/"
            // does not insert a component there.
            if (
              node.type.name !== "paragraph" ||
              node.content.size > 0 ||
              $pos.depth !== 1
            ) {
              return DecorationSet.empty;
            }
            const start = $pos.before($pos.depth);
            const end = $pos.after($pos.depth);
            return DecorationSet.create(state.doc, [
              Decoration.node(start, end, {
                "data-mdcms-empty-hint": "true",
              }),
            ]);
          },
        },
        view(editorView) {
          const setFocused = (focused: boolean) => {
            editorView.dispatch(
              editorView.state.tr.setMeta(pluginKey, { focused }),
            );
          };
          const onFocus = () => setFocused(true);
          const onBlur = () => setFocused(false);
          editorView.dom.addEventListener("focus", onFocus);
          editorView.dom.addEventListener("blur", onBlur);
          return {
            destroy() {
              editorView.dom.removeEventListener("focus", onFocus);
              editorView.dom.removeEventListener("blur", onBlur);
            },
          };
        },
      }),
    ];
  },
});

const HeadlessCodeBlock = CodeBlockLowlight.configure({
  lowlight: lowlightInstance,
  defaultLanguage: null,
});

// `createEditorExtensions` is safe to import from headless contexts (the
// markdown pipeline, the CLI, document-editor.ts). The UI layer passes its
// own React-wrapped `codeBlock` override so `@tiptap/react` only loads when
// an editor is actually mounting in a browser.
export function createEditorExtensions(options?: {
  mdxRawJsx?: Extensions[number];
  mdxComponent?: Extensions[number];
  mdxIntrinsicElement?: Extensions[number];
  image?: Extensions[number];
  codeBlock?: Extensions[number];
}): Extensions {
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
    BlurSelectionPreserver,
    EmptyParagraphHint,
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
    options?.image ?? StudioImageExtension,
    MdxIntrinsicInlineExtension,
    options?.mdxComponent ?? MdxComponentExtension,
    options?.mdxIntrinsicElement ?? MdxIntrinsicElementExtension,
    options?.mdxRawJsx ?? MdxRawJsxExtension,
    Markdown,
  ];
}
