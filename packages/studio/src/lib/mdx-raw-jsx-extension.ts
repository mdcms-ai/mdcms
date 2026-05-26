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

const RAW_PREVIEW_ALLOWED_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "meter",
  "nav",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "select",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
]);

const RAW_PREVIEW_DROPPED_ELEMENTS = new Set(["script", "style"]);
const RAW_PREVIEW_URL_ATTRIBUTES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);
const RAW_PREVIEW_UNSAFE_ATTRIBUTES = new Set(["srcdoc"]);

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

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function normalizeCssPropertyName(value: string): string | null {
  const name = toKebabCase(value).trim().toLowerCase();

  if (!/^(?:--[a-z0-9-]+|-?[a-z][a-z0-9-]*)$/.test(name)) {
    return null;
  }

  if (name === "behavior" || name === "-moz-binding") {
    return null;
  }

  return name;
}

function isSafeCssValue(value: string): boolean {
  const normalized = value.replace(/\/\*[\s\S]*?\*\//g, "").trim();

  if (/[<>]/.test(normalized)) {
    return false;
  }

  return !/(?:@import|expression\s*\(|javascript\s*:|url\s*\(|behavior\s*:|-moz-binding)/i.test(
    normalized,
  );
}

function renderStyleDeclaration(name: string, value: unknown): string | null {
  const propertyName = normalizeCssPropertyName(name);

  if (
    propertyName === null ||
    (typeof value !== "string" && typeof value !== "number")
  ) {
    return null;
  }

  const cssValue = String(value).trim();

  if (!isSafeCssValue(cssValue)) {
    return null;
  }

  return `${propertyName}:${cssValue}`;
}

function renderStyleString(value: string): string | null {
  const declarations: string[] = [];

  for (const rawDeclaration of value.split(";")) {
    const declaration = rawDeclaration.trim();

    if (!declaration) {
      continue;
    }

    const separatorIndex = declaration.indexOf(":");

    if (separatorIndex <= 0) {
      return null;
    }

    const rendered = renderStyleDeclaration(
      declaration.slice(0, separatorIndex),
      declaration.slice(separatorIndex + 1),
    );

    if (rendered === null) {
      return null;
    }

    declarations.push(rendered);
  }

  return declarations.length > 0 ? declarations.join(";") : null;
}

function renderStyleValue(value: unknown): string | null {
  if (typeof value === "string") {
    return renderStyleString(value);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const declarations: string[] = [];

  for (const [key, declarationValue] of Object.entries(value)) {
    const rendered = renderStyleDeclaration(key, declarationValue);

    if (rendered !== null) {
      declarations.push(rendered);
    }
  }

  return declarations.length > 0 ? declarations.join(";") : null;
}

function normalizeHtmlAttributeName(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

function renderHtmlAttributes(attrsSource: string): string {
  const attrs = parseMdxJsxAttributes(attrsSource);
  const rendered: string[] = [];

  for (const [rawName, rawValue] of Object.entries(attrs)) {
    if (/^on/i.test(rawName)) {
      continue;
    }

    const name = normalizeHtmlAttributeName(rawName);
    const lowerName = name.toLowerCase();

    if (
      RAW_PREVIEW_URL_ATTRIBUTES.has(lowerName) ||
      RAW_PREVIEW_UNSAFE_ATTRIBUTES.has(lowerName) ||
      !isSafeHtmlAttributeName(name) ||
      rawValue === false
    ) {
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

    rendered.push(`${name}="${escapeHtmlAttribute(value)}"`);
  }

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

function countPrecedingBackslashes(input: string, index: number): number {
  let count = 0;
  let cursor = index - 1;

  while (cursor >= 0 && input[cursor] === "\\") {
    count += 1;
    cursor -= 1;
  }

  return count;
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

    if (quote) {
      if (
        current === quote &&
        countPrecedingBackslashes(input, cursor) % 2 === 0
      ) {
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

function renderRawOpeningTag(openingTag: RawOpeningTag): string | null {
  if (!RAW_PREVIEW_ALLOWED_ELEMENTS.has(openingTag.name)) {
    return null;
  }

  const attrs = renderHtmlAttributes(openingTag.attrsSource);
  const selfClosing = openingTag.isVoid ? " /" : "";

  return `<${openingTag.name}${attrs}${selfClosing}>`;
}

export function renderRawMdxJsxPreview(source: string): string {
  let cursor = 0;
  let rendered = "";

  while (cursor < source.length) {
    const tagOffset = source.indexOf("<", cursor);

    if (tagOffset < 0) {
      rendered += source.slice(cursor);
      break;
    }

    rendered += source.slice(cursor, tagOffset);

    const closingTag = readRawClosingTag(source, tagOffset);
    if (closingTag) {
      if (RAW_PREVIEW_ALLOWED_ELEMENTS.has(closingTag.name)) {
        rendered += `</${closingTag.name}>`;
      } else if (!RAW_PREVIEW_DROPPED_ELEMENTS.has(closingTag.name)) {
        rendered += escapeHtmlText(
          source.slice(tagOffset, closingTag.endIndex),
        );
      }
      cursor = closingTag.endIndex;
      continue;
    }

    const openingTag = readRawOpeningTag(source, tagOffset);
    if (openingTag) {
      if (RAW_PREVIEW_DROPPED_ELEMENTS.has(openingTag.name)) {
        const closingDroppedTag = openingTag.isVoid
          ? null
          : findRawClosingTag(source, openingTag.name, openingTag.endIndex);
        cursor = closingDroppedTag
          ? closingDroppedTag.endIndex
          : openingTag.endIndex;
        continue;
      }

      rendered +=
        renderRawOpeningTag(openingTag) ?? escapeHtmlText(openingTag.raw);
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
