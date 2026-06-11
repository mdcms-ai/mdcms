export const MDX_INTRINSIC_INLINE_ELEMENTS = new Set([
  "abbr",
  "b",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

export const MDX_INTRINSIC_TEXT_BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "button",
  "caption",
  "details",
  "dialog",
  "div",
  "dl",
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
  "label",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

export function isMdxIntrinsicInlineName(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && MDX_INTRINSIC_INLINE_ELEMENTS.has(value);
}

export function isMdxIntrinsicTextBlockName(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" && MDX_INTRINSIC_TEXT_BLOCK_ELEMENTS.has(value)
  );
}
