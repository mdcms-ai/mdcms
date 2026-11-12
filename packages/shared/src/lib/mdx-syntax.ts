import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { mdx } from "micromark-extension-mdx";

/** Parse MDX syntax without evaluating expressions or resolving components. */
export function parseMdxSyntax(source: string): void {
  fromMarkdown(source, {
    extensions: [mdx()],
    mdastExtensions: [mdxFromMarkdown()],
  });
}
