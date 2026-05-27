import { Fragment, createElement, type ReactNode } from "react";

import { parseMarkdownToDocument } from "@mdcms/studio/markdown-pipeline";

import { Callout } from "../components/mdx/Callout";
import { Chart } from "../components/mdx/Chart";
import { PricingTable } from "../components/mdx/PricingTable";

type RenderNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{
    type?: string;
    attrs?: Record<string, unknown>;
  }>;
  content?: RenderNode[];
};

const mdxComponents = {
  Callout,
  Chart,
  PricingTable,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getContent(node: RenderNode): RenderNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function getMdxProps(attrs: Record<string, unknown> | undefined) {
  return isRecord(attrs?.props) ? attrs.props : {};
}

function getHeadingLevel(attrs: Record<string, unknown> | undefined) {
  const level = attrs?.level;

  return typeof level === "number" && level >= 1 && level <= 6 ? level : 2;
}

function getNodeKey(node: RenderNode): string {
  return JSON.stringify({
    type: node.type,
    text: node.text,
    attrs: node.attrs,
    content: node.content?.length ?? 0,
  });
}

function RenderInlineNodes({ nodes }: { nodes: RenderNode[] }) {
  return nodes.map((node) => (
    <RenderInlineNode key={getNodeKey(node)} node={node} />
  ));
}

function RenderInlineNode({ node }: { node: RenderNode }) {
  if (node.type === "hardBreak") {
    return <br />;
  }

  if (node.type !== "text") {
    return <RenderBlockNodes nodes={getContent(node)} />;
  }

  let value: ReactNode = node.text ?? "";

  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") {
      value = <strong>{value}</strong>;
    } else if (mark.type === "italic") {
      value = <em>{value}</em>;
    } else if (mark.type === "code") {
      value = <code>{value}</code>;
    } else if (mark.type === "link" && typeof mark.attrs?.href === "string") {
      value = (
        <a href={mark.attrs.href} rel="noreferrer">
          {value}
        </a>
      );
    }
  }

  return <Fragment>{value}</Fragment>;
}

function RenderListItem({ node }: { node: RenderNode }) {
  const content = getContent(node);

  if (content.length === 1 && content[0]?.type === "paragraph") {
    return (
      <li>
        <RenderInlineNodes nodes={getContent(content[0])} />
      </li>
    );
  }

  return (
    <li>
      <RenderBlockNodes nodes={content} />
    </li>
  );
}

function RenderMdxComponent({ node }: { node: RenderNode }) {
  const componentName = node.attrs?.componentName;

  if (typeof componentName !== "string" || !(componentName in mdxComponents)) {
    return (
      <div data-mdcms-rendered-mdx-state="unsupported">
        Unsupported MDX component
      </div>
    );
  }

  const Component = mdxComponents[componentName as keyof typeof mdxComponents];
  const props = getMdxProps(node.attrs);
  const children = getContent(node);

  return createElement(
    Component as never,
    props as never,
    children.length > 0 ? <RenderBlockNodes nodes={children} /> : undefined,
  );
}

function RenderBlockNode({ node }: { node: RenderNode }) {
  switch (node.type) {
    case "heading": {
      const tag = `h${getHeadingLevel(node.attrs)}`;

      return createElement(
        tag,
        null,
        <RenderInlineNodes nodes={getContent(node)} />,
      );
    }
    case "paragraph":
      return (
        <p>
          <RenderInlineNodes nodes={getContent(node)} />
        </p>
      );
    case "bulletList":
      return (
        <ul>
          {getContent(node).map((child) => (
            <RenderListItem key={getNodeKey(child)} node={child} />
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol>
          {getContent(node).map((child) => (
            <RenderListItem key={getNodeKey(child)} node={child} />
          ))}
        </ol>
      );
    case "listItem":
      return <RenderListItem node={node} />;
    case "blockquote":
      return (
        <blockquote>
          <RenderBlockNodes nodes={getContent(node)} />
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre>
          <code>
            {getContent(node)
              .map((child) => child.text ?? "")
              .join("")}
          </code>
        </pre>
      );
    case "horizontalRule":
      return <hr />;
    case "mdxComponent":
      return <RenderMdxComponent node={node} />;
    default:
      return <RenderBlockNodes nodes={getContent(node)} />;
  }
}

function RenderBlockNodes({ nodes }: { nodes: RenderNode[] }) {
  return nodes.map((node) => (
    <RenderBlockNode key={getNodeKey(node)} node={node} />
  ));
}

export function RenderedContent({ body }: { body: string }) {
  const document = parseMarkdownToDocument(body) as RenderNode;

  return (
    <div data-mdcms-rendered-content="true">
      <RenderBlockNodes nodes={getContent(document)} />
    </div>
  );
}
