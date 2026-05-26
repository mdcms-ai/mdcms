import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";

import {
  isMdxExpressionValue,
  parseMdxJsxAttributes,
} from "./mdx-component-extension.js";

type MdxRawJsxToken = {
  type: "mdxRawJsx";
  raw: string;
  source: string;
};

type RawOpeningTag = {
  name: string;
  attrsSource: string;
  raw: string;
  isVoid: boolean;
  endIndex: number;
};

type RawClosingTag = {
  name: string;
  startIndex: number;
  endIndex: number;
};

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function isLowercaseRawTagName(name: string): boolean {
  return /^[a-z][A-Za-z0-9._-]*$/.test(name);
}

function isSafeHtmlAttributeName(name: string): boolean {
  return /^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function renderStyleValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const declarations: string[] = [];

  for (const [key, declarationValue] of Object.entries(value)) {
    if (
      typeof declarationValue !== "string" &&
      typeof declarationValue !== "number"
    ) {
      return null;
    }

    declarations.push(`${toKebabCase(key)}:${String(declarationValue)}`);
  }

  return declarations.join(";");
}

function normalizeHtmlAttributeName(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

function isUnsafeUrlAttribute(name: string, value: string): boolean {
  if (!["action", "href", "src", "xlink:href"].includes(name)) {
    return false;
  }

  return /^\s*javascript:/i.test(value);
}

function renderHtmlAttributes(attrsSource: string): string {
  const attrs = parseMdxJsxAttributes(attrsSource);
  const rendered: string[] = [];

  for (const [rawName, rawValue] of Object.entries(attrs)) {
    if (/^on/i.test(rawName)) {
      continue;
    }

    const name = normalizeHtmlAttributeName(rawName);

    if (!isSafeHtmlAttributeName(name) || rawValue === false) {
      continue;
    }

    if (rawValue === true) {
      rendered.push(`${name}=""`);
      continue;
    }

    if (rawValue === null || rawValue === undefined) {
      continue;
    }

    if (name === "style") {
      const style = renderStyleValue(rawValue);
      if (style !== null) {
        rendered.push(`style="${escapeHtmlAttribute(style)}"`);
      }
      continue;
    }

    if (isMdxExpressionValue(rawValue)) {
      continue;
    }

    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      continue;
    }

    const value = String(rawValue);

    if (isUnsafeUrlAttribute(name, value)) {
      continue;
    }

    rendered.push(`${name}="${escapeHtmlAttribute(value)}"`);
  }

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

function readRawOpeningTag(
  input: string,
  offset: number,
): RawOpeningTag | null {
  if (input[offset] !== "<" || !/[a-z]/.test(input[offset + 1] ?? "")) {
    return null;
  }

  let cursor = offset + 1;
  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const name = input.slice(nameStart, cursor);

  if (!isLowercaseRawTagName(name)) {
    return null;
  }

  const attrsStart = cursor;
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;

  while (cursor < input.length) {
    const current = input[cursor]!;
    const previous = input[cursor - 1];

    if (quote) {
      if (current === quote && previous !== "\\") {
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
      const beforeClose = input.slice(attrsStart, cursor).trimEnd();
      const hasTrailingSlash = beforeClose.endsWith("/");
      const attrsSource = hasTrailingSlash
        ? beforeClose.slice(0, -1).trim()
        : beforeClose.trim();

      return {
        name,
        attrsSource,
        raw: input.slice(offset, cursor + 1),
        isVoid: hasTrailingSlash || VOID_HTML_ELEMENTS.has(name),
        endIndex: cursor + 1,
      };
    }

    cursor += 1;
  }

  return null;
}

function readRawClosingTag(
  input: string,
  offset: number,
): RawClosingTag | null {
  if (input.slice(offset, offset + 2) !== "</") {
    return null;
  }

  let cursor = offset + 2;
  const nameStart = cursor;

  while (cursor < input.length && /[A-Za-z0-9._-]/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  const name = input.slice(nameStart, cursor);

  if (!isLowercaseRawTagName(name)) {
    return null;
  }

  while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  if (input[cursor] !== ">") {
    return null;
  }

  return {
    name,
    startIndex: offset,
    endIndex: cursor + 1,
  };
}

function findRawClosingTag(
  input: string,
  tagName: string,
  searchStart: number,
): RawClosingTag | null {
  let cursor = searchStart;
  let depth = 0;

  while (cursor < input.length) {
    const tagOffset = input.indexOf("<", cursor);

    if (tagOffset < 0) {
      return null;
    }

    const openingTag = readRawOpeningTag(input, tagOffset);

    if (openingTag) {
      if (openingTag.name === tagName && !openingTag.isVoid) {
        depth += 1;
      }
      cursor = openingTag.endIndex;
      continue;
    }

    const closingTag = readRawClosingTag(input, tagOffset);

    if (closingTag) {
      if (closingTag.name === tagName) {
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

export function tokenizeMdxRawJsxBlock(
  input: string,
): Omit<MdxRawJsxToken, "type"> | null {
  const openingTag = readRawOpeningTag(input, 0);

  if (!openingTag) {
    return null;
  }

  if (openingTag.isVoid) {
    return {
      raw: openingTag.raw,
      source: openingTag.raw,
    };
  }

  const closingTag = findRawClosingTag(
    input,
    openingTag.name,
    openingTag.endIndex,
  );

  if (!closingTag) {
    return null;
  }

  const source = input.slice(0, closingTag.endIndex);

  return {
    raw: source,
    source,
  };
}

function renderRawOpeningTag(openingTag: RawOpeningTag): string {
  const attrs = renderHtmlAttributes(openingTag.attrsSource);
  const selfClosing = openingTag.isVoid ? " /" : "";

  return `<${openingTag.name}${attrs}${selfClosing}>`;
}

export function renderRawMdxJsxPreview(source: string): string {
  const withoutScripts = source.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  let cursor = 0;
  let rendered = "";

  while (cursor < withoutScripts.length) {
    const tagOffset = withoutScripts.indexOf("<", cursor);

    if (tagOffset < 0) {
      rendered += withoutScripts.slice(cursor);
      break;
    }

    rendered += withoutScripts.slice(cursor, tagOffset);

    const closingTag = readRawClosingTag(withoutScripts, tagOffset);
    if (closingTag) {
      rendered += withoutScripts.slice(tagOffset, closingTag.endIndex);
      cursor = closingTag.endIndex;
      continue;
    }

    const openingTag = readRawOpeningTag(withoutScripts, tagOffset);
    if (openingTag) {
      rendered += renderRawOpeningTag(openingTag);
      cursor = openingTag.endIndex;
      continue;
    }

    rendered += "&lt;";
    cursor = tagOffset + 1;
  }

  return rendered;
}

export const MdxRawJsxExtension = Node.create({
  name: "mdxRawJsx",
  group: "block",
  atom: true,
  selectable: true,
  isolating: true,
  priority: 900,

  addAttributes() {
    return {
      source: {
        default: "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "mdx-raw-jsx" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "mdx-raw-jsx",
      mergeAttributes(HTMLAttributes, {
        "data-mdcms-mdx-raw-jsx": "true",
      }),
    ];
  },

  markdownTokenName: "mdxRawJsx",

  parseMarkdown(token, helpers) {
    const rawToken = token as unknown as MdxRawJsxToken;

    return helpers.createNode("mdxRawJsx", {
      source: rawToken.source,
    });
  },

  renderMarkdown(node: JSONContent) {
    return typeof node.attrs?.source === "string" ? node.attrs.source : "";
  },

  markdownTokenizer: {
    name: "mdxRawJsx",
    level: "block",
    start(src) {
      const match = src.match(/^<[a-z][A-Za-z0-9._-]*/m);
      return match?.index ?? -1;
    },
    tokenize(src) {
      const token = tokenizeMdxRawJsxBlock(src);

      if (!token) {
        return undefined;
      }

      return {
        type: "mdxRawJsx",
        raw: token.raw,
        source: token.source,
      } satisfies MdxRawJsxToken;
    },
  },
});
