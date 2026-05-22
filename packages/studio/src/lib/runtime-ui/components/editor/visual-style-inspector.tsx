"use client";

import type { ReactNode } from "react";

import type { StudioMountContext } from "@mdcms/shared";

import type { PropsEditorChangeHandler } from "../../../mdx-props-editor-host.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

type InlineStyle = Record<string, string | number>;

type ParseAdvancedStyleResult =
  | { ok: true; value: InlineStyle }
  | { ok: false; message: string };

const SPACING_KEYS = [
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "gap",
] as const;

const COLOR_KEYS = ["color", "backgroundColor"] as const;

const TYPOGRAPHY_KEYS = [
  "fontSize",
  "fontWeight",
  "lineHeight",
  "textAlign",
] as const;

const LAYOUT_KEYS = [
  "display",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "flexWrap",
  "gridTemplateColumns",
  "gridTemplateRows",
  "gridAutoFlow",
  "columnGap",
  "rowGap",
] as const;

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

export function VisualStyleInspector({
  component,
  value,
  readOnly,
  onChange,
}: {
  component: MdxCatalogComponent;
  value: Record<string, unknown>;
  readOnly: boolean;
  onChange: PropsEditorChangeHandler;
}) {
  if (component.extractedProps?.style?.type !== "style") {
    return null;
  }

  const style = isInlineStyle(value.style) ? value.style : {};
  const updateStyle = (nextStyle: InlineStyle) => {
    onChange({
      style: Object.keys(nextStyle).length > 0 ? nextStyle : undefined,
    });
  };
  const updateStyleKey = (key: string, nextValue: string) => {
    updateStyle(
      patchInlineStyleValue(
        style,
        key,
        nextValue.trim().length > 0 ? nextValue : undefined,
      ),
    );
  };

  return (
    <section
      data-mdcms-visual-style-inspector={component.name}
      className="space-y-4"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Style</p>
        <p className="text-xs text-foreground-muted">
          Flat inline style props only.
        </p>
      </div>

      <StyleGroup title="Spacing" id="spacing">
        <StyleInputGrid
          keys={SPACING_KEYS}
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
      </StyleGroup>

      <StyleGroup title="Color" id="color">
        <StyleInputGrid
          keys={COLOR_KEYS}
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
      </StyleGroup>

      <StyleGroup title="Typography" id="typography">
        <StyleInputGrid
          keys={TYPOGRAPHY_KEYS}
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
      </StyleGroup>

      <StyleGroup title="Layout" id="layout">
        <StyleInputGrid
          keys={LAYOUT_KEYS}
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
      </StyleGroup>

      <StyleGroup title="Advanced style object" id="advanced">
        <textarea
          data-mdcms-visual-style-advanced={component.name}
          rows={8}
          disabled={readOnly}
          defaultValue={JSON.stringify(style, null, 2)}
          onChange={(event) => {
            const parsed = parseAdvancedStyleObject(event.currentTarget.value);

            if (parsed.ok) {
              updateStyle(parsed.value);
            }
          }}
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground shadow-xs disabled:cursor-not-allowed disabled:opacity-60"
        />
      </StyleGroup>
    </section>
  );
}

function StyleGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section data-mdcms-visual-style-group={id} className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        {title}
      </p>
      {children}
    </section>
  );
}

function StyleInputGrid({
  keys,
  style,
  readOnly,
  onChange,
}: {
  keys: readonly string[];
  style: InlineStyle;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {keys.map((key) => (
        <label key={key} className="space-y-1 text-xs text-foreground-muted">
          <span className="font-mono text-[10px]">{key}</span>
          <input
            data-mdcms-visual-style-control={key}
            disabled={readOnly}
            defaultValue={style[key] !== undefined ? String(style[key]) : ""}
            onChange={(event) => onChange(key, event.currentTarget.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground shadow-xs disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
      ))}
    </div>
  );
}

function isInlineStyle(value: unknown): value is InlineStyle {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    )
  );
}
