import { RuntimeError } from "@mdcms/shared";
import type { JSONContent } from "@tiptap/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { mdx } from "micromark-extension-mdx";

import { parseMdxAttributeValue } from "./mdx-component-extension.js";

type AstPosition = {
  start?: { offset?: number };
  end?: { offset?: number };
};

type MdxAstNode = {
  type: string;
  value?: string;
  name?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  children?: MdxAstNode[];
  attributes?: MdxJsxAttribute[];
  position?: AstPosition;
};

type MdxJsxAttribute = {
  type: string;
  name?: string;
  value?: string | null | { type: string; value?: string };
  position?: AstPosition;
};

function isUppercaseComponentName(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[A-Z][A-Za-z0-9._-]*$/.test(value);
}

function getSourceSlice(source: string, node: { position?: AstPosition }) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;

  if (typeof start !== "number" || typeof end !== "number" || end < start) {
    return null;
  }

  return source.slice(start, end);
}

function hasMeaningfulContent(content: JSONContent[] | undefined): boolean {
  return Array.isArray(content) && content.length > 0;
}

function compactContent(content: JSONContent[]): JSONContent[] | undefined {
  return content.length > 0 ? content : undefined;
}

function createParagraph(content: JSONContent[] = []): JSONContent {
  return {
    type: "paragraph",
    ...(content.length > 0 ? { content } : {}),
  };
}

function createText(text: string, marks?: JSONContent["marks"]): JSONContent[] {
  if (text.length === 0) {
    return [];
  }

  return [
    {
      type: "text",
      text,
      ...(marks && marks.length > 0 ? { marks } : {}),
    },
  ];
}

function withMark(
  marks: JSONContent["marks"] | undefined,
  mark: NonNullable<JSONContent["marks"]>[number],
): JSONContent["marks"] {
  return [...(marks ?? []), mark];
}

function isInlineAstNode(node: MdxAstNode): boolean {
  if (
    node.type === "mdxJsxTextElement" &&
    isUppercaseComponentName(node.name)
  ) {
    return false;
  }

  return [
    "break",
    "delete",
    "emphasis",
    "html",
    "image",
    "inlineCode",
    "link",
    "mdxJsxTextElement",
    "strong",
    "text",
  ].includes(node.type);
}

function convertInlineChildren(
  children: MdxAstNode[],
  source: string,
  marks?: JSONContent["marks"],
): JSONContent[] {
  return children.flatMap((child) => convertInlineNode(child, source, marks));
}

function convertInlineNode(
  node: MdxAstNode,
  source: string,
  marks?: JSONContent["marks"],
): JSONContent[] {
  switch (node.type) {
    case "text":
      return createText(node.value ?? "", marks);
    case "break":
      return [{ type: "hardBreak" }];
    case "inlineCode":
      return createText(node.value ?? "", withMark(marks, { type: "code" }));
    case "emphasis":
      return convertInlineChildren(
        node.children ?? [],
        source,
        withMark(marks, { type: "italic" }),
      );
    case "strong":
      return convertInlineChildren(
        node.children ?? [],
        source,
        withMark(marks, { type: "bold" }),
      );
    case "delete":
      return convertInlineChildren(
        node.children ?? [],
        source,
        withMark(marks, { type: "strike" }),
      );
    case "link":
      return convertInlineChildren(
        node.children ?? [],
        source,
        withMark(marks, {
          type: "link",
          attrs: {
            href: node.url ?? "",
            target: null,
            rel: null,
            class: null,
          },
        }),
      );
    case "html":
    case "image":
    case "mdxJsxTextElement":
      return createText(
        getSourceSlice(source, node) ?? node.value ?? "",
        marks,
      );
    default:
      return createText(
        getSourceSlice(source, node) ?? node.value ?? "",
        marks,
      );
  }
}

function convertInlineNodesToParagraph(nodes: MdxAstNode[], source: string) {
  const inlineContent = convertInlineChildren(nodes, source);
  return hasMeaningfulContent(inlineContent)
    ? [createParagraph(inlineContent)]
    : [];
}

function convertParagraphNode(node: MdxAstNode, source: string): JSONContent[] {
  const children = node.children ?? [];
  const hasBlockMdxTextElement = children.some(
    (child) =>
      child.type === "mdxJsxTextElement" &&
      isUppercaseComponentName(child.name),
  );

  if (!hasBlockMdxTextElement) {
    return [createParagraph(convertInlineChildren(children, source))];
  }

  const blocks: JSONContent[] = [];
  let inlineBuffer: MdxAstNode[] = [];

  const flushInlineBuffer = () => {
    const paragraph = convertInlineNodesToParagraph(inlineBuffer, source);
    blocks.push(...paragraph);
    inlineBuffer = [];
  };

  for (const child of children) {
    if (
      child.type === "mdxJsxTextElement" &&
      isUppercaseComponentName(child.name)
    ) {
      flushInlineBuffer();
      blocks.push(convertMdxJsxElementNode(child, source));
      continue;
    }

    if (child.type === "text" && typeof child.value === "string") {
      const segments = child.value.split("\n");

      segments.forEach((segment, index) => {
        if (index > 0) {
          flushInlineBuffer();
        }

        const normalized =
          inlineBuffer.length === 0 ? segment.trimStart() : segment;

        if (normalized.length > 0) {
          inlineBuffer.push({ ...child, value: normalized });
        }
      });
      continue;
    }

    inlineBuffer.push(child);
  }

  flushInlineBuffer();
  return blocks.length > 0 ? blocks : [createParagraph()];
}

function convertChildrenToBlocks(
  children: MdxAstNode[],
  source: string,
): JSONContent[] {
  const blocks: JSONContent[] = [];
  let inlineBuffer: MdxAstNode[] = [];

  const flushInlineBuffer = () => {
    blocks.push(...convertInlineNodesToParagraph(inlineBuffer, source));
    inlineBuffer = [];
  };

  for (const child of children) {
    if (isInlineAstNode(child)) {
      inlineBuffer.push(child);
      continue;
    }

    flushInlineBuffer();
    blocks.push(...convertBlockNode(child, source));
  }

  flushInlineBuffer();
  return blocks;
}

function parseMdxElementProps(
  node: MdxAstNode,
  _source: string,
): Record<string, unknown> | null {
  const attributes = node.attributes ?? [];

  if (attributes.length === 0) {
    return {};
  }

  const props: Record<string, unknown> = {};

  for (const attribute of attributes) {
    if (attribute.type !== "mdxJsxAttribute") {
      return null;
    }

    if (typeof attribute.name !== "string" || attribute.name.length === 0) {
      return null;
    }

    if (attribute.value === null || attribute.value === undefined) {
      props[attribute.name] = true;
      continue;
    }

    if (typeof attribute.value === "string") {
      props[attribute.name] = attribute.value;
      continue;
    }

    if (
      attribute.value.type === "mdxJsxAttributeValueExpression" &&
      typeof attribute.value.value === "string"
    ) {
      props[attribute.name] = parseMdxAttributeValue(
        attribute.name,
        attribute.value.value,
      );
      continue;
    }

    return null;
  }

  return props;
}

function convertMdxJsxElementNode(
  node: MdxAstNode,
  source: string,
): JSONContent {
  const rawSource = getSourceSlice(source, node);
  const name = node.name ?? "";

  if (!isUppercaseComponentName(name)) {
    return {
      type: "mdxRawJsx",
      attrs: {
        source: rawSource ?? "",
      },
    };
  }

  const props = parseMdxElementProps(node, source);

  if (props === null) {
    return {
      type: "mdxRawJsx",
      attrs: {
        source: rawSource ?? "",
      },
    };
  }

  const isVoid = rawSource?.trimEnd().endsWith("/>") ?? false;
  const content = isVoid
    ? []
    : convertChildrenToBlocks(node.children ?? [], source);

  return {
    type: "mdxComponent",
    attrs: {
      componentName: name,
      isVoid,
      props,
    },
    ...(content.length > 0 ? { content } : {}),
  };
}

function convertListNode(node: MdxAstNode, source: string): JSONContent[] {
  const children = node.children ?? [];
  const isTaskList = children.some(
    (child) => typeof child.checked === "boolean",
  );

  if (isTaskList) {
    return [
      {
        type: "taskList",
        content: children.map((child) => ({
          type: "taskItem",
          attrs: {
            checked: child.checked === true,
          },
          content: convertChildrenToBlocks(child.children ?? [], source),
        })),
      },
    ];
  }

  return [
    {
      type: node.ordered === true ? "orderedList" : "bulletList",
      ...(node.ordered === true
        ? {
            attrs: {
              start: node.start ?? 1,
              type: null,
            },
          }
        : {}),
      content: children.flatMap((child) => convertBlockNode(child, source)),
    },
  ];
}

function convertBlockNode(node: MdxAstNode, source: string): JSONContent[] {
  switch (node.type) {
    case "root":
      return convertChildrenToBlocks(node.children ?? [], source);
    case "paragraph":
      return convertParagraphNode(node, source);
    case "heading":
      return [
        {
          type: "heading",
          attrs: {
            level: node.depth ?? 1,
          },
          content: compactContent(
            convertInlineChildren(node.children ?? [], source),
          ),
        },
      ];
    case "blockquote":
      return [
        {
          type: "blockquote",
          content: convertChildrenToBlocks(node.children ?? [], source),
        },
      ];
    case "list":
      return convertListNode(node, source);
    case "listItem":
      return [
        {
          type: "listItem",
          content: convertChildrenToBlocks(node.children ?? [], source),
        },
      ];
    case "code":
      return [
        {
          type: "codeBlock",
          attrs: {
            language: node.lang ?? null,
          },
          content: createText(node.value ?? ""),
        },
      ];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return [convertMdxJsxElementNode(node, source)];
    case "html":
    case "mdxFlowExpression":
    case "mdxTextExpression":
      return [
        {
          type: "mdxRawJsx",
          attrs: {
            source: getSourceSlice(source, node) ?? node.value ?? "",
          },
        },
      ];
    case "text":
    case "break":
    case "delete":
    case "emphasis":
    case "inlineCode":
    case "link":
    case "strong":
      return [createParagraph(convertInlineNode(node, source))];
    default:
      return convertInlineNodesToParagraph([node], source);
  }
}

export function parseMdxMarkdownToTipTapDocument(
  markdown: string,
): JSONContent {
  let tree: MdxAstNode;

  try {
    tree = fromMarkdown(markdown, {
      extensions: [mdx()],
      mdastExtensions: [mdxFromMarkdown()],
    }) as MdxAstNode;
  } catch (error) {
    throw new RuntimeError({
      code: "MARKDOWN_PARSE_FAILED",
      message: "Failed to parse Markdown/MDX into a Studio document.",
      statusCode: 400,
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const content = convertBlockNode(tree, markdown);

  return {
    type: "doc",
    content: content.length > 0 ? content : [createParagraph()],
  };
}
