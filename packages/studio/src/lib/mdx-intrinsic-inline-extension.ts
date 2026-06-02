import { Mark, mergeAttributes, type JSONContent } from "@tiptap/core";

import { isMdxIntrinsicInlineName } from "./mdx-intrinsic-inline.js";
import { serializeMdxJsxAttributes } from "./mdx-component-extension.js";

type InlineStyle = Record<string, string | number>;

const URL_BEARING_ATTRIBUTES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "xlinkhref",
]);
const UNSAFE_ATTRIBUTES = new Set(["srcdoc", "dangerouslysetinnerhtml"]);

function normalizeHtmlAttributeName(name: string): string {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

function isFlatStyleRecord(value: unknown): value is InlineStyle {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    )
  );
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

function renderStyleValue(value: InlineStyle): string {
  return Object.entries(value)
    .map(([name, declaration]) => `${toKebabCase(name)}:${String(declaration)}`)
    .join(";");
}

function createSafeInlineHtmlAttributes(
  props: Record<string, unknown>,
): Record<string, string | number> {
  const safeProps: Record<string, string | number> = {};

  for (const [rawName, value] of Object.entries(props)) {
    const name = normalizeHtmlAttributeName(rawName);
    const normalizedName = name.toLowerCase();

    if (
      normalizedName.startsWith("on") ||
      URL_BEARING_ATTRIBUTES.has(normalizedName) ||
      UNSAFE_ATTRIBUTES.has(normalizedName) ||
      value === undefined ||
      value === null ||
      value === false
    ) {
      continue;
    }

    if (name === "style") {
      if (isFlatStyleRecord(value)) {
        safeProps.style = renderStyleValue(value);
      }
      continue;
    }

    if (
      value === true ||
      typeof value === "string" ||
      typeof value === "number"
    ) {
      safeProps[name] = value === true ? "" : value;
    }
  }

  return safeProps;
}

function getInlineTagName(attrs: Record<string, unknown> | undefined): string {
  const tagName = attrs?.tagName;

  return typeof tagName === "string" && isMdxIntrinsicInlineName(tagName)
    ? tagName
    : "span";
}

function getInlineProps(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = attrs?.props;

  return props && typeof props === "object" && !Array.isArray(props)
    ? (props as Record<string, unknown>)
    : {};
}

export const MdxIntrinsicInlineExtension = Mark.create({
  name: "mdxIntrinsicInline",
  inclusive: false,
  spanning: false,

  addAttributes() {
    return {
      tagName: {
        default: "span",
      },
      props: {
        default: {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "[data-mdcms-mdx-intrinsic-inline]" }];
  },

  renderHTML({ mark }) {
    const tagName = getInlineTagName(mark.attrs);
    const props = getInlineProps(mark.attrs);

    return [
      tagName,
      mergeAttributes(createSafeInlineHtmlAttributes(props), {
        "data-mdcms-mdx-intrinsic-inline": tagName,
      }),
      0,
    ];
  },

  renderMarkdown(node: JSONContent, helpers) {
    const attrs = node.attrs as Record<string, unknown> | undefined;
    const tagName = getInlineTagName(attrs);
    const props = getInlineProps(attrs);
    const serializedProps = serializeMdxJsxAttributes(props);
    const attrSegment = serializedProps.length > 0 ? ` ${serializedProps}` : "";

    return `<${tagName}${attrSegment}>${helpers.renderChildren(
      node.content ?? [],
      "",
    )}</${tagName}>`;
  },
});
