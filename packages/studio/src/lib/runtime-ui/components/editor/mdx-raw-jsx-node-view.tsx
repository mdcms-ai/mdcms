"use client";

import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";

import { renderRawMdxJsxPreview } from "../../../mdx-raw-jsx-extension.js";

function renderSafeRawMdxJsxPreview(source: string): string {
  try {
    return renderRawMdxJsxPreview(source);
  } catch (error) {
    console.error("Failed to render raw MDX JSX preview.", error);
    return "";
  }
}

export function MdxRawJsxNodeView(props: ReactNodeViewProps) {
  const source =
    typeof props.node.attrs.source === "string" ? props.node.attrs.source : "";
  const html = renderSafeRawMdxJsxPreview(source);
  const previewHtmlProps = {
    dangerouslySetInnerHTML: { __html: html },
  };

  return (
    <NodeViewWrapper
      as="div"
      data-mdcms-mdx-raw-jsx
      contentEditable={false}
      suppressContentEditableWarning
      className="not-prose my-4 text-foreground"
      {...previewHtmlProps}
    />
  );
}
