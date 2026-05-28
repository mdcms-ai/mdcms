import {
  Node,
  mergeAttributes,
  type JSONContent,
  type MarkdownToken,
} from "@tiptap/core";
import type { Node as PmNode, Slice } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";

type MdxComponentToken = {
  type: "mdxComponent";
  raw: string;
  componentName: string;
  props: Record<string, unknown>;
  isVoid: boolean;
  content: string;
  tokens?: MarkdownToken[];
};

type OpeningTagMatch = {
  componentName: string;
  propsSource: string;
  isVoid: boolean;
  raw: string;
  endIndex: number;
};

type ClosingTagMatch = {
  componentName: string;
  raw: string;
  startIndex: number;
  endIndex: number;
};

const MDX_EXPRESSION_VALUE_KEY = "__mdxExpression";

function findNextTagStart(input: string, startIndex: number): number {
  return input.indexOf("<", startIndex);
}

export type MdxExpressionValue = {
  [MDX_EXPRESSION_VALUE_KEY]: string;
};

function isUppercaseComponentName(value: string): boolean {
  return /^[A-Z][A-Za-z0-9._-]*$/.test(value);
}

function createMdxExpressionValue(expression: string): MdxExpressionValue {
  return {
    [MDX_EXPRESSION_VALUE_KEY]: expression,
  };
}

export function isMdxExpressionValue(
  value: unknown,
): value is MdxExpressionValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof (value as Record<string, unknown>)[MDX_EXPRESSION_VALUE_KEY] ===
    "string"
  );
}

function decodeEscapedQuotedValue(
  input: string,
  index: number,
): [string, number] {
  const current = input[index + 1];

  if (current === undefined) {
    return ["\\", index + 1];
  }

  switch (current) {
    case '"':
      return ['"', index + 2];
    case "'":
      return ["'", index + 2];
    case "\\":
      return ["\\", index + 2];
    case "n":
      return ["\n", index + 2];
    case "r":
      return ["\r", index + 2];
    case "t":
      return ["\t", index + 2];
    default:
      return [`\\${current}`, index + 2];
  }
}

function readQuotedValue(input: string, index: number): [string, number] {
  const quote = input[index];
  let cursor = index + 1;
  let value = "";

  while (cursor < input.length) {
    const current = input[cursor];

    if (current === "\\" && cursor + 1 < input.length) {
      const [decodedValue, nextCursor] = decodeEscapedQuotedValue(
        input,
        cursor,
      );
      value += decodedValue;
      cursor = nextCursor;
      continue;
    }

    if (current === quote) {
      return [value, cursor + 1];
    }

    value += current;
    cursor += 1;
  }

  throw new Error("Unterminated quoted JSX attribute value.");
}

function readBracedValue(input: string, index: number): [string, number] {
  let cursor = index + 1;
  let depth = 1;
  let value = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (cursor < input.length) {
    const current = input[cursor];
    const previous = input[cursor - 1];

    if (current === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      value += current;
      cursor += 1;
      continue;
    }

    if (current === '"' && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      value += current;
      cursor += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (current === "{") {
        depth += 1;
      } else if (current === "}") {
        depth -= 1;

        if (depth === 0) {
          return [value, cursor + 1];
        }
      }
    }

    value += current;
    cursor += 1;
  }

  throw new Error("Unterminated braced JSX attribute value.");
}

function parseMdxExpressionValue(input: string): unknown {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return createMdxExpressionValue(trimmed);
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (trimmed === "null") {
    return null;
  }

  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return createMdxExpressionValue(trimmed);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  return createMdxExpressionValue(trimmed);
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let start = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (cursor < input.length) {
    const current = input[cursor]!;
    const previous = input[cursor - 1];

    if (current === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      cursor += 1;
      continue;
    }

    if (current === '"' && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      cursor += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (current === "{") {
        braceDepth += 1;
      } else if (current === "}") {
        braceDepth -= 1;
      } else if (current === "[") {
        bracketDepth += 1;
      } else if (current === "]") {
        bracketDepth -= 1;
      } else if (
        current === separator &&
        braceDepth === 0 &&
        bracketDepth === 0
      ) {
        parts.push(input.slice(start, cursor));
        start = cursor + 1;
      }
    }

    cursor += 1;
  }

  parts.push(input.slice(start));
  return parts;
}

function parseObjectKey(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const [value, nextCursor] = readQuotedValue(trimmed, 0);
    return nextCursor === trimmed.length ? value : null;
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function parseFlatStyleObjectExpression(
  input: string,
): Record<string, string | number> | null {
  const trimmed = input.trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  const body = trimmed.slice(1, -1).trim();

  if (body.length === 0) {
    return {};
  }

  const result: Record<string, string | number> = {};

  for (const pair of splitTopLevel(body, ",")) {
    if (pair.trim().length === 0) {
      continue;
    }

    const segments = splitTopLevel(pair, ":");
    const [keySource, valueSource] = segments;

    if (
      keySource === undefined ||
      valueSource === undefined ||
      segments.length !== 2
    ) {
      return null;
    }

    const key = parseObjectKey(keySource);
    const value = parseMdxExpressionValue(valueSource);

    if (key === null) {
      return null;
    }

    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }

    result[key] = value;
  }

  return result;
}

export function parseMdxAttributeValue(
  attributeName: string,
  input: string,
): unknown {
  const parsed = parseMdxExpressionValue(input);

  if (
    attributeName !== "style" ||
    (parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      !isMdxExpressionValue(parsed))
  ) {
    return parsed;
  }

  return parseFlatStyleObjectExpression(input) ?? parsed;
}

export function parseMdxJsxAttributes(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor]!)) {
      cursor += 1;
    }

    if (cursor >= input.length) {
      break;
    }

    const nameStart = cursor;

    while (cursor < input.length && /[A-Za-z0-9._:-]/.test(input[cursor]!)) {
      cursor += 1;
    }

    const attributeName = input.slice(nameStart, cursor);

    if (attributeName.length === 0) {
      throw new Error(
        `Invalid JSX attribute syntax near "${input.slice(cursor)}".`,
      );
    }

    while (cursor < input.length && /\s/.test(input[cursor]!)) {
      cursor += 1;
    }

    if (input[cursor] !== "=") {
      result[attributeName] = true;
      continue;
    }

    cursor += 1;

    while (cursor < input.length && /\s/.test(input[cursor]!)) {
      cursor += 1;
    }

    const current = input[cursor];

    if (current === '"' || current === "'") {
      const [rawValue, nextCursor] = readQuotedValue(input, cursor);
      result[attributeName] = rawValue;
      cursor = nextCursor;
      continue;
    }

    if (current === "{") {
      const [rawValue, nextCursor] = readBracedValue(input, cursor);
      result[attributeName] = parseMdxAttributeValue(attributeName, rawValue);
      cursor = nextCursor;
      continue;
    }

    throw new Error(
      `Unsupported JSX attribute value for "${attributeName}" near "${input.slice(cursor)}".`,
    );
  }

  return result;
}

function escapeMdxStringAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

function formatAttributeValue(value: unknown): string {
  if (isMdxExpressionValue(value)) {
    return `{${value[MDX_EXPRESSION_VALUE_KEY]}}`;
  }

  if (typeof value === "string") {
    return `"${escapeMdxStringAttribute(value)}"`;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    Array.isArray(value) ||
    typeof value === "object"
  ) {
    return `{${JSON.stringify(value)}}`;
  }

  return `{${JSON.stringify(String(value))}}`;
}

export function serializeMdxJsxAttributes(
  input: Record<string, unknown>,
): string {
  return Object.entries(input)
    .flatMap(([name, value]) =>
      value === undefined ? [] : [`${name}=${formatAttributeValue(value)}`],
    )
    .join(" ");
}

type FenceState = {
  marker: "`" | "~";
  length: number;
};

function readFenceState(line: string): FenceState | null {
  const match = line.match(/^ {0,3}([`~]{3,})/);

  if (!match) {
    return null;
  }

  const marker = match[1][0];

  if (marker !== "`" && marker !== "~") {
    return null;
  }

  return {
    marker,
    length: match[1].length,
  };
}

function getLineEnd(input: string, index: number): number {
  const lineEnd = input.indexOf("\n", index);
  return lineEnd === -1 ? input.length : lineEnd;
}

function getBlockTagOffset(input: string, index: number): number | null {
  const lineEnd = getLineEnd(input, index);
  let cursor = index;
  let spaces = 0;

  while (cursor < lineEnd && input[cursor] === " " && spaces < 4) {
    cursor += 1;
    spaces += 1;
  }

  if (spaces > 3 || input[cursor] === "\t") {
    return null;
  }

  return cursor;
}

function readOpeningTag(input: string, offset = 0): OpeningTagMatch | null {
  if (input[offset] !== "<" || input[offset + 1] === "/") {
    return null;
  }

  let cursor = offset + 1;

  while (cursor < input.length && /\s/.test(input[cursor]!)) {
    cursor += 1;
  }

  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const componentName = input.slice(nameStart, cursor);

  if (!isUppercaseComponentName(componentName)) {
    return null;
  }

  const propsStart = cursor;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let braceDepth = 0;

  while (cursor < input.length) {
    const current = input[cursor]!;
    const previous = input[cursor - 1];

    if (current === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      cursor += 1;
      continue;
    }

    if (current === '"' && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      cursor += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (current === "{") {
        braceDepth += 1;
      } else if (current === "}") {
        braceDepth -= 1;
      } else if (current === ">" && braceDepth === 0) {
        const raw = input.slice(offset, cursor + 1);
        const beforeClose = input.slice(propsStart, cursor).trimEnd();
        const isVoid = beforeClose.endsWith("/");
        const propsSource = isVoid
          ? beforeClose.slice(0, -1).trim()
          : beforeClose.trim();

        return {
          componentName,
          propsSource,
          isVoid,
          raw,
          endIndex: cursor + 1,
        };
      }
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

  while (cursor < input.length && /\s/.test(input[cursor]!)) {
    cursor += 1;
  }

  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const componentName = input.slice(nameStart, cursor);

  if (!isUppercaseComponentName(componentName)) {
    return null;
  }

  while (cursor < input.length && /\s/.test(input[cursor]!)) {
    cursor += 1;
  }

  if (input[cursor] !== ">") {
    return null;
  }

  return {
    componentName,
    raw: input.slice(offset, cursor + 1),
    startIndex: offset,
    endIndex: cursor + 1,
  };
}

function findMatchingClosingTag(
  input: string,
  componentName: string,
  searchStart: number,
): ClosingTagMatch | null {
  let depth = 0;
  let cursor = searchStart;
  let activeFence: FenceState | null = null;

  while (cursor < input.length) {
    const lineEnd = getLineEnd(input, cursor);
    const nextCursor = lineEnd === input.length ? input.length : lineEnd + 1;
    const blockTagOffset = getBlockTagOffset(input, cursor);

    if (blockTagOffset === null) {
      cursor = nextCursor;
      continue;
    }

    const line = input.slice(blockTagOffset, lineEnd);

    if (activeFence) {
      const maybeFenceEnd = readFenceState(line);

      if (
        maybeFenceEnd &&
        maybeFenceEnd.marker === activeFence.marker &&
        maybeFenceEnd.length >= activeFence.length
      ) {
        activeFence = null;
      }

      cursor = nextCursor;
      continue;
    }

    const fenceStart = readFenceState(line);

    if (fenceStart) {
      activeFence = fenceStart;
      cursor = nextCursor;
      continue;
    }

    let tagCursor = Math.max(cursor, blockTagOffset);

    while (tagCursor < lineEnd) {
      const tagOffset = findNextTagStart(input, tagCursor);

      if (tagOffset === -1 || tagOffset >= lineEnd) {
        break;
      }

      const openingTag = readOpeningTag(input, tagOffset);

      if (
        openingTag &&
        openingTag.componentName === componentName &&
        !openingTag.isVoid
      ) {
        depth += 1;
        tagCursor = openingTag.endIndex;
        continue;
      }

      if (openingTag) {
        tagCursor = openingTag.endIndex;
        continue;
      }

      const closingTag = readClosingTag(input, tagOffset);

      if (closingTag?.componentName === componentName) {
        if (depth === 0) {
          return closingTag;
        }

        depth -= 1;
        tagCursor = closingTag.endIndex;
        continue;
      }

      if (closingTag) {
        tagCursor = closingTag.endIndex;
        continue;
      }

      tagCursor = tagOffset + 1;
    }

    cursor = nextCursor;
  }

  return null;
}

export function tokenizeMdxComponentBlock(
  input: string,
): Omit<MdxComponentToken, "type"> | null {
  const openingTag = readOpeningTag(input, 0);

  if (!openingTag) {
    return null;
  }

  const props = parseMdxJsxAttributes(openingTag.propsSource);

  if (openingTag.isVoid) {
    return {
      componentName: openingTag.componentName,
      isVoid: true,
      props,
      raw: openingTag.raw,
      content: "",
    };
  }

  const closingTag = findMatchingClosingTag(
    input,
    openingTag.componentName,
    openingTag.endIndex,
  );

  if (!closingTag) {
    return null;
  }

  return {
    componentName: openingTag.componentName,
    isVoid: false,
    props,
    raw: input.slice(0, closingTag.endIndex),
    content: input.slice(openingTag.endIndex, closingTag.startIndex).trim(),
  };
}

function renderMdxComponentMarkdown(
  node: JSONContent,
  childrenMarkdown: string,
) {
  const componentName = node.attrs?.componentName;
  const isVoid = node.attrs?.isVoid === true;
  const props =
    (node.attrs?.props as Record<string, unknown> | undefined) ?? {};

  if (typeof componentName !== "string" || componentName.trim().length === 0) {
    return "";
  }

  const serializedProps = serializeMdxJsxAttributes(props);
  const attrSegment = serializedProps.length > 0 ? ` ${serializedProps}` : "";

  if (isVoid) {
    if (hasMeaningfulMdxComponentChildren(node.content)) {
      throw new Error(
        `Void MDX component "${componentName}" cannot serialize with child content.`,
      );
    }

    return `<${componentName}${attrSegment} />`;
  }

  if (hasOnlyEmptyParagraphChild(node.content)) {
    return `<${componentName}${attrSegment}></${componentName}>`;
  }

  if (childrenMarkdown.trim().length === 0) {
    return `<${componentName}${attrSegment}></${componentName}>`;
  }

  return `<${componentName}${attrSegment}>\n${childrenMarkdown}\n</${componentName}>`;
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

function hasMeaningfulMdxComponentChildren(
  content: JSONContent[] | undefined,
): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    !hasOnlyEmptyParagraphChild(content)
  );
}

function countMdxComponentNodes(root: PmNode): number {
  let count = 0;

  root.descendants((node) => {
    if (node.type.name === "mdxComponent") {
      count += 1;
      return false;
    }
    return true;
  });

  return count;
}

function anyVoidMdxNodeHasContent(root: PmNode): boolean {
  let found = false;

  root.descendants((node) => {
    if (found) {
      return false;
    }

    if (
      node.type.name === "mdxComponent" &&
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

function sliceContainsMdxComponent(slice: Slice): boolean {
  let found = false;

  slice.content.descendants((node) => {
    if (found) {
      return false;
    }

    if (node.type.name === "mdxComponent") {
      found = true;
      return false;
    }

    return true;
  });

  return found;
}

export const MdxComponentExtension = Node.create({
  name: "mdxComponent",
  group: "block",
  // A single generic node type covers both wrapper and self-closing MDX
  // components. Void components simply keep `isVoid: true` and empty content.
  content: "block*",
  isolating: true,
  selectable: true,
  // Marks the whole node as a ProseMirror drag source. The node view scopes
  // the drag to a specific child via `[data-drag-handle]` so clicking inside
  // the wrapper still places a caret rather than starting a drag.
  draggable: true,
  priority: 1000,

  addProseMirrorPlugins() {
    // MDX components survive clicks cleanly, but the default text-editing path
    // happily destroys them: a NodeSelection on the block plus a keystroke (or
    // a TextSelection that spans the block, e.g. from Cmd+A / Shift+Click)
    // hands ProseMirror a ReplaceStep that wipes the node out and loses the
    // rendered preview. This plugin refuses any transaction that would make
    // an mdxComponent disappear from the document, except when the user has
    // explicitly selected exactly that node (Backspace, Delete, Cut, drag).
    return [
      new Plugin({
        key: new PluginKey("mdxComponentNodeGuard"),
        filterTransaction(tr, state) {
          if (!tr.docChanged) {
            return true;
          }

          // `editor.commands.setContent(...)` always stamps `preventUpdate` on
          // its transaction. Programmatic content replacement (e.g. switching
          // documents, version rollback, autosave restore) is trusted by
          // definition and must never be blocked by the guard.
          if (tr.getMeta("preventUpdate") !== undefined) {
            return true;
          }

          // Void components are self-closing by definition (`<Chart />`), so
          // they must never accumulate child content. If a transaction would
          // leave a void mdxComponent holding children — which is what rapid
          // double-click + typing tries to do via the hidden content hole the
          // schema still exposes — reject it.
          if (anyVoidMdxNodeHasContent(tr.doc)) {
            return false;
          }

          const beforeCount = countMdxComponentNodes(state.doc);
          const afterCount = countMdxComponentNodes(tr.doc);

          if (afterCount >= beforeCount) {
            return true;
          }

          // MDX nodes are disappearing. Distinguish intentional clears
          // (Backspace/Delete, Cut, Cmd+A+Delete, drag move) from accidental
          // destruction (typing or pasting over the node). Intentional clears
          // never introduce new inline text where the node used to be — they
          // either insert nothing, move the node itself, or leave a bare
          // placeholder paragraph to satisfy `block+`. Replace-style
          // destruction, on the other hand, always brings typed or pasted
          // inline content with it.
          for (const step of tr.steps) {
            if (!(step instanceof ReplaceStep)) {
              continue;
            }

            if (step.slice.content.size === 0) {
              continue;
            }

            if (sliceContainsMdxComponent(step.slice)) {
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
              selection.node.type.name !== "mdxComponent"
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
      componentName: {
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
    return [{ tag: "mdx-component" }];
  },

  renderHTML({ HTMLAttributes }) {
    const componentName =
      typeof HTMLAttributes.componentName === "string"
        ? HTMLAttributes.componentName
        : "";
    const attributes = mergeAttributes(HTMLAttributes, {
      "data-mdcms-mdx-component": componentName,
      "data-mdcms-mdx-void": HTMLAttributes.isVoid === true ? "true" : "false",
    });

    return HTMLAttributes.isVoid === true
      ? ["mdx-component", attributes]
      : ["mdx-component", attributes, 0];
  },

  markdownTokenName: "mdxComponent",

  parseMarkdown(token, helpers) {
    const mdxToken = token as unknown as MdxComponentToken;

    return helpers.createNode(
      "mdxComponent",
      {
        componentName: mdxToken.componentName,
        props: mdxToken.props ?? {},
        isVoid: mdxToken.isVoid === true,
      },
      mdxToken.isVoid ? [] : helpers.parseChildren(mdxToken.tokens ?? []),
    );
  },

  renderMarkdown(node, helpers) {
    return renderMdxComponentMarkdown(
      node,
      helpers.renderChildren(node.content ?? [], "\n\n"),
    );
  },

  markdownTokenizer: {
    name: "mdxComponent",
    level: "block",
    start(src) {
      const match = src.match(/^<[A-Z][A-Za-z0-9._-]*/m);
      return match?.index ?? -1;
    },
    tokenize(src, _tokens, lexer) {
      const token = tokenizeMdxComponentBlock(src);

      if (!token) {
        return undefined;
      }

      const contentTokens =
        token.isVoid || token.content.trim().length === 0
          ? []
          : lexer.blockTokens(token.content);

      return {
        type: "mdxComponent",
        raw: token.raw,
        componentName: token.componentName,
        props: token.props,
        isVoid: token.isVoid,
        content: token.content,
        tokens: contentTokens,
      } satisfies MdxComponentToken;
    },
  },
});
