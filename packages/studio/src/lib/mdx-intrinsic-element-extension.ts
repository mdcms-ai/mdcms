import {
  Node,
  mergeAttributes,
  type JSONContent,
  type MarkdownToken,
} from "@tiptap/core";
import type { Node as PmNode, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

import { HTML_VOID_ELEMENTS } from "./html-void-elements.js";
import {
  parseMdxJsxAttributes,
  serializeMdxJsxAttributes,
} from "./mdx-component-extension.js";

type MdxIntrinsicElementToken = {
  type: "mdxIntrinsicElement";
  raw: string;
  tagName: string;
  props: Record<string, unknown>;
  isVoid: boolean;
  content: string;
  tokens?: MarkdownToken[];
};

type OpeningTagMatch = {
  tagName: string;
  propsSource: string;
  isVoid: boolean;
  raw: string;
  endIndex: number;
};

type ClosingTagMatch = {
  tagName: string;
  startIndex: number;
  endIndex: number;
};

function isLowercaseIntrinsicName(value: string): boolean {
  return /^[a-z][A-Za-z0-9._-]*$/.test(value);
}

function findNextTagStart(input: string, startIndex: number): number {
  return input.indexOf("<", startIndex);
}

function readOpeningTag(input: string, offset = 0): OpeningTagMatch | null {
  if (input[offset] !== "<" || input[offset + 1] === "/") {
    return null;
  }

  let cursor = offset + 1;
  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const tagName = input.slice(nameStart, cursor);

  if (!isLowercaseIntrinsicName(tagName)) {
    return null;
  }

  const propsStart = cursor;
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;

  while (cursor < input.length) {
    const current = input[cursor]!;

    if (quote) {
      if (current === quote && input[cursor - 1] !== "\\") {
        quote = null;
      }
      cursor += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      quote = current;
      cursor += 1;
      continue;
    }

    if (current === "{") {
      braceDepth += 1;
      cursor += 1;
      continue;
    }

    if (current === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      cursor += 1;
      continue;
    }

    if (current === ">" && braceDepth === 0) {
      const raw = input.slice(offset, cursor + 1);
      const beforeClose = input.slice(propsStart, cursor).trimEnd();
      const selfClosing = beforeClose.endsWith("/");
      const propsSource = selfClosing
        ? beforeClose.slice(0, -1).trim()
        : beforeClose.trim();

      return {
        tagName,
        propsSource,
        isVoid: selfClosing || HTML_VOID_ELEMENTS.has(tagName),
        raw,
        endIndex: cursor + 1,
      };
    }

    cursor += 1;
  }

  return null;
}

function readClosingTag(input: string, offset: number): ClosingTagMatch | null {
  if (input.slice(offset, offset + 2) !== "</") {
    return null;
  }

  let cursor = offset + 2;
  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const tagName = input.slice(nameStart, cursor);

  if (!isLowercaseIntrinsicName(tagName)) {
    return null;
  }

  while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  if (input[cursor] !== ">") {
    return null;
  }

  return {
    tagName,
    startIndex: offset,
    endIndex: cursor + 1,
  };
}

function findMatchingClosingTag(
  input: string,
  tagName: string,
  searchStart: number,
): ClosingTagMatch | null {
  let cursor = searchStart;
  let depth = 0;

  while (cursor < input.length) {
    const tagOffset = findNextTagStart(input, cursor);

    if (tagOffset < 0) {
      return null;
    }

    const openingTag = readOpeningTag(input, tagOffset);

    if (openingTag) {
      if (openingTag.tagName === tagName && !openingTag.isVoid) {
        depth += 1;
      }
      cursor = openingTag.endIndex;
      continue;
    }

    const closingTag = readClosingTag(input, tagOffset);

    if (closingTag) {
      if (closingTag.tagName === tagName) {
        if (depth === 0) {
          return closingTag;
        }
        depth -= 1;
      }
      cursor = closingTag.endIndex;
      continue;
    }

    cursor = tagOffset + 1;
  }

  return null;
}

export function tokenizeMdxIntrinsicElementBlock(
  input: string,
): Omit<MdxIntrinsicElementToken, "type"> | null {
  const openingTag = readOpeningTag(input, 0);

  if (!openingTag) {
    return null;
  }

  const props = parseMdxJsxAttributes(openingTag.propsSource);

  if (openingTag.isVoid) {
    return {
      tagName: openingTag.tagName,
      isVoid: true,
      props,
      raw: openingTag.raw,
      content: "",
    };
  }

  const closingTag = findMatchingClosingTag(
    input,
    openingTag.tagName,
    openingTag.endIndex,
  );

  if (!closingTag) {
    return null;
  }

  return {
    tagName: openingTag.tagName,
    isVoid: false,
    props,
    raw: input.slice(0, closingTag.endIndex),
    content: input.slice(openingTag.endIndex, closingTag.startIndex).trim(),
  };
}

function hasOnlyEmptyParagraphChild(
  content: JSONContent[] | undefined,
): boolean {
  if (content?.length !== 1) {
    return false;
  }

  const [child] = content;

  return child?.type === "paragraph" && (child.content?.length ?? 0) === 0;
}

function hasMeaningfulChildren(content: JSONContent[] | undefined): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    !hasOnlyEmptyParagraphChild(content)
  );
}

function renderMdxIntrinsicElementMarkdown(
  node: JSONContent,
  childrenMarkdown: string,
) {
  const tagName = node.attrs?.tagName;
  const isVoid = node.attrs?.isVoid === true;
  const props =
    (node.attrs?.props as Record<string, unknown> | undefined) ?? {};

  if (typeof tagName !== "string" || tagName.trim().length === 0) {
    return "";
  }

  const serializedProps = serializeMdxJsxAttributes(props);
  const attrSegment = serializedProps.length > 0 ? ` ${serializedProps}` : "";

  if (isVoid) {
    if (hasMeaningfulChildren(node.content)) {
      throw new Error(
        `Void MDX intrinsic element "${tagName}" cannot serialize with child content.`,
      );
    }

    return `<${tagName}${attrSegment} />`;
  }

  if (
    childrenMarkdown.trim().length === 0 ||
    hasOnlyEmptyParagraphChild(node.content)
  ) {
    return `<${tagName}${attrSegment}></${tagName}>`;
  }

  return `<${tagName}${attrSegment}>\n${childrenMarkdown}\n</${tagName}>`;
}

function countIntrinsicNodes(root: PmNode): number {
  let count = 0;

  root.descendants((node) => {
    if (node.type.name === "mdxIntrinsicElement") {
      count += 1;
      return false;
    }
    return true;
  });

  return count;
}

function anyVoidIntrinsicNodeHasContent(root: PmNode): boolean {
  let found = false;

  root.descendants((node) => {
    if (found) {
      return false;
    }

    if (
      node.type.name === "mdxIntrinsicElement" &&
      node.attrs.isVoid === true &&
      node.content.size > 0
    ) {
      found = true;
      return false;
    }

    return true;
  });

  return found;
}

function sliceContainsTextContent(slice: Slice): boolean {
  let found = false;

  slice.content.descendants((node) => {
    if (found) {
      return false;
    }

    if (node.isText) {
      found = true;
      return false;
    }

    return true;
  });

  return found;
}

function sliceContainsIntrinsicNode(slice: Slice): boolean {
  let found = false;

  slice.content.descendants((node) => {
    if (found) {
      return false;
    }

    if (node.type.name === "mdxIntrinsicElement") {
      found = true;
      return false;
    }

    return true;
  });

  return found;
}

export const MdxIntrinsicElementExtension = Node.create({
  name: "mdxIntrinsicElement",
  group: "block",
  content: "block*",
  isolating: true,
  selectable: true,
  draggable: true,
  priority: 950,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("mdxIntrinsicElementNodeGuard"),
        filterTransaction(tr, state) {
          if (!tr.docChanged) {
            return true;
          }

          if (tr.getMeta("preventUpdate") !== undefined) {
            return true;
          }

          if (anyVoidIntrinsicNodeHasContent(tr.doc)) {
            return false;
          }

          const beforeCount = countIntrinsicNodes(state.doc);
          const afterCount = countIntrinsicNodes(tr.doc);

          if (afterCount >= beforeCount) {
            return true;
          }

          for (const step of tr.steps) {
            if (!(step instanceof ReplaceStep)) {
              continue;
            }

            if (step.slice.content.size === 0) {
              continue;
            }

            if (sliceContainsIntrinsicNode(step.slice)) {
              continue;
            }

            if (!sliceContainsTextContent(step.slice)) {
              continue;
            }

            return false;
          }

          return true;
        },
        props: {
          handleTextInput(view, _from, _to, text) {
            const { selection } = view.state;

            if (
              !(selection instanceof NodeSelection) ||
              selection.node.type.name !== "mdxIntrinsicElement"
            ) {
              return false;
            }

            const after = selection.to;
            view.dispatch(view.state.tr.insertText(text, after, after));
            return true;
          },
        },
      }),
    ];
  },

  addAttributes() {
    return {
      tagName: {
        default: "",
      },
      props: {
        default: {},
      },
      isVoid: {
        default: false,
      },
    };
  },

  parseHTML() {
    return [{ tag: "mdx-intrinsic-element" }];
  },

  renderHTML({ HTMLAttributes }) {
    const tagName =
      typeof HTMLAttributes.tagName === "string" ? HTMLAttributes.tagName : "";
    const attributes = mergeAttributes(HTMLAttributes, {
      "data-mdcms-mdx-intrinsic-element": tagName,
      "data-mdcms-mdx-void": HTMLAttributes.isVoid === true ? "true" : "false",
    });

    return HTMLAttributes.isVoid === true
      ? ["mdx-intrinsic-element", attributes]
      : ["mdx-intrinsic-element", attributes, 0];
  },

  markdownTokenName: "mdxIntrinsicElement",

  parseMarkdown(token, helpers) {
    const intrinsicToken = token as unknown as MdxIntrinsicElementToken;

    return helpers.createNode(
      "mdxIntrinsicElement",
      {
        tagName: intrinsicToken.tagName,
        props: intrinsicToken.props ?? {},
        isVoid: intrinsicToken.isVoid === true,
      },
      intrinsicToken.isVoid
        ? []
        : helpers.parseChildren(intrinsicToken.tokens ?? []),
    );
  },

  renderMarkdown(node, helpers) {
    return renderMdxIntrinsicElementMarkdown(
      node,
      helpers.renderChildren(node.content ?? [], "\n\n"),
    );
  },

  markdownTokenizer: {
    name: "mdxIntrinsicElement",
    level: "block",
    start(src) {
      const match = src.match(/^<[a-z][A-Za-z0-9._-]*/m);
      return match?.index ?? -1;
    },
    tokenize(src, _tokens, lexer) {
      const token = tokenizeMdxIntrinsicElementBlock(src);

      if (!token) {
        return undefined;
      }

      const contentTokens =
        token.isVoid || token.content.trim().length === 0
          ? []
          : lexer.blockTokens(token.content);

      return {
        type: "mdxIntrinsicElement",
        raw: token.raw,
        tagName: token.tagName,
        props: token.props,
        isVoid: token.isVoid,
        content: token.content,
        tokens: contentTokens,
      } satisfies MdxIntrinsicElementToken;
    },
  },
});
