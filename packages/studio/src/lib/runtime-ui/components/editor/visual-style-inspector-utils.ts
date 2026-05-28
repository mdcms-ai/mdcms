export type InlineStyle = Record<string, string | number>;
export type LayoutDisplayControlValue =
  | ""
  | "block"
  | "row"
  | "column"
  | "grid";

export type ParseAdvancedStyleResult =
  | { ok: true; value: InlineStyle }
  | { ok: false; message: string };

export function patchInlineStyleValue(
  style: InlineStyle,
  key: string,
  value: string | number | undefined,
): InlineStyle {
  const nextStyle = { ...style };

  if (value === undefined || value === "") {
    delete nextStyle[key];
    return nextStyle;
  }

  nextStyle[key] = value;
  return nextStyle;
}

export function getLayoutDisplayControlValue(
  style: InlineStyle,
): LayoutDisplayControlValue {
  if (style.display === "flex") {
    return style.flexDirection === "column" ? "column" : "row";
  }

  if (style.display === "block" || style.display === "grid") {
    return style.display;
  }

  return "";
}

export function patchLayoutDisplayControlValue(
  style: InlineStyle,
  value: LayoutDisplayControlValue,
): InlineStyle {
  const nextStyle = { ...style };

  delete nextStyle.display;
  delete nextStyle.flexDirection;

  switch (value) {
    case "block":
      nextStyle.display = "block";
      break;
    case "grid":
      nextStyle.display = "grid";
      break;
    case "row":
      nextStyle.display = "flex";
      nextStyle.flexDirection = "row";
      break;
    case "column":
      nextStyle.display = "flex";
      nextStyle.flexDirection = "column";
      break;
    case "":
      break;
  }

  return nextStyle;
}

export function parseAdvancedStyleObject(
  source: string,
): ParseAdvancedStyleResult {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    return { ok: true, value: {} };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "Style must be valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Style must be a JSON object." };
  }

  if (
    !Object.values(parsed as Record<string, unknown>).every(
      (value) => typeof value === "string" || typeof value === "number",
    )
  ) {
    return {
      ok: false,
      message: "Style values must be strings or numbers.",
    };
  }

  return { ok: true, value: parsed as InlineStyle };
}

export function normalizeColorPickerValue(value: string): string {
  const trimmed = value.trim();
  const shortHexMatch = /^#([\da-f]{3})$/i.exec(trimmed);

  if (shortHexMatch) {
    return `#${shortHexMatch[1]
      .split("")
      .map((character) => `${character}${character}`)
      .join("")}`.toLowerCase();
  }

  if (/^#[\da-f]{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return "#000000";
}
