import { Extension } from "@tiptap/core";
import type { Extensions } from "@tiptap/core";
// Keep these empty type imports: TipTap packages register TypeScript module
// augmentations through their declarations, so cleanup tools must not remove
// them as unused imports.
import type {} from "@tiptap/extension-code-block-lowlight";
import type {} from "@tiptap/extension-highlight";
import type {} from "@tiptap/extension-link";
import type {} from "@tiptap/extension-task-item";
import type {} from "@tiptap/extension-task-list";
import type {} from "@tiptap/extension-underline";
import type {} from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type {} from "@tiptap/starter-kit";
import {
  createEditorCoreExtensions,
  createEditorCoreLowlight,
  type EditorCoreExtensionOverrides,
} from "@mdcms/editor-core";

// Returns a lowlight instance seeded with the common language set and with
// `highlightAuto` replaced by a plain-text no-op. CodeBlockLowlight falls
// back to `highlightAuto` whenever a block has no language attribute; the
// default guesses at a grammar and renders tokens inside what the user
// thinks is a plain-text block. Overriding it keeps "Plain text" honest
// and matches the spec's "no auto-detection" decision.
export const createStudioLowlight = createEditorCoreLowlight;

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

// `createEditorExtensions` is safe to import from headless contexts (the
// markdown pipeline, the CLI, document-editor.ts). The UI layer passes its
// own React-wrapped `codeBlock` override so `@tiptap/react` only loads when
// an editor is actually mounting in a browser.
export function createEditorExtensions(
  options?: EditorCoreExtensionOverrides,
): Extensions {
  return createEditorCoreExtensions({
    ...options,
    extensionsAfterHighlight: [BlurSelectionPreserver, EmptyParagraphHint],
  });
}
