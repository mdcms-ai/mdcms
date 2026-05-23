export type InlineStyle = Record<string, string | number>;

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
