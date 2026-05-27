import { isMdxExpressionValue } from "../../../mdx-component-extension.js";

export function formatMdxComponentPropsSummary(
  props: Record<string, unknown> | undefined,
): string {
  const entries = Object.entries(props ?? {}).filter(
    ([, value]) => value !== undefined,
  );

  if (entries.length === 0) {
    return "No props set yet";
  }

  return entries
    .map(([name, value]) => {
      if (isMdxExpressionValue(value)) {
        return `${name}={${value.__mdxExpression}}`;
      }

      if (typeof value === "string") {
        return `${name}="${value}"`;
      }

      return `${name}={${JSON.stringify(value)}}`;
    })
    .join(" ");
}
