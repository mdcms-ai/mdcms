import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { createStudioLowlight } from "../../../editor-extensions.js";
import { CodeBlockNodeView } from "./code-block-node-view.js";

// UI-facing code block: the same lowlight-backed extension but wrapped in a
// React NodeView that renders the language dropdown. Kept separate from the
// NodeView component so the component module only exports React components.
export const CodeBlockWithNodeView = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
}).configure({
  lowlight: createStudioLowlight(),
  defaultLanguage: null,
});
