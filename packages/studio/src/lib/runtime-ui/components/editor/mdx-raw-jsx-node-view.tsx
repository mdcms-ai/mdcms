"use client";

import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";

import { renderRawMdxJsxPreview } from "../../../mdx-raw-jsx-extension.js";

export function MdxRawJsxNodeView(props: ReactNodeViewProps) {
  const source =
    typeof props.node.attrs.source === "string" ? props.node.attrs.source : "";
  const html = renderRawMdxJsxPreview(source);
  const sanitizedPreviewHtmlProps = {
    dangerouslySetInnerHTML: { __html: html },
  };

  return (
    <NodeViewWrapper
      as="div"
      data-mdcms-mdx-raw-jsx
      contentEditable={false}
      suppressContentEditableWarning
      className="not-prose my-4 text-foreground"
      {...sanitizedPreviewHtmlProps}
    />
  );
}
