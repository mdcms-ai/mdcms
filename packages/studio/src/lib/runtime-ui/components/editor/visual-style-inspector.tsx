"use client";

import type { ReactNode } from "react";

import type { StudioMountContext } from "@mdcms/shared";
import {
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceBetween,
  AlignStartVertical,
  Columns2,
  Grid3x3,
  MoveHorizontal,
  Rows2,
  Square,
  StretchHorizontal,
  StretchVertical,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextWrap,
  type LucideIcon,
} from "lucide-react";

import type { PropsEditorChangeHandler } from "../../../mdx-props-editor-host.js";
import { cn } from "../../lib/utils.js";
import {
  parseAdvancedStyleObject,
  patchInlineStyleValue,
  type InlineStyle,
} from "./visual-style-inspector-utils.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const DISPLAY_OPTIONS = [
  { value: "block", label: "Block", icon: Square },
  { value: "flex", label: "Flex", icon: StretchHorizontal },
  { value: "grid", label: "Grid", icon: Grid3x3 },
] as const;

const FLEX_DIRECTION_OPTIONS = [
  { value: "row", label: "Row", icon: Columns2 },
  { value: "column", label: "Column", icon: Rows2 },
] as const;

const FLEX_WRAP_OPTIONS = [
  { value: "nowrap", label: "No wrap", icon: MoveHorizontal },
  { value: "wrap", label: "Wrap", icon: TextWrap },
] as const;

const ALIGN_OPTIONS = [
  { value: "flex-start", label: "Start", icon: AlignStartVertical },
  { value: "center", label: "Center", icon: AlignCenterVertical },
  { value: "flex-end", label: "End", icon: AlignEndVertical },
  { value: "stretch", label: "Stretch", icon: StretchVertical },
] as const;

const JUSTIFY_OPTIONS = [
  { value: "flex-start", label: "Start", icon: AlignHorizontalJustifyStart },
  { value: "center", label: "Center", icon: AlignHorizontalJustifyCenter },
  { value: "flex-end", label: "End", icon: AlignHorizontalJustifyEnd },
  {
    value: "space-between",
    label: "Between",
    icon: AlignHorizontalSpaceBetween,
  },
] as const;

const GRID_FLOW_OPTIONS = [
  { value: "row", label: "Row", icon: Rows2 },
  { value: "column", label: "Column", icon: Columns2 },
  { value: "dense", label: "Dense", icon: Grid3x3 },
] as const;

const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "Left", icon: TextAlignStart },
  { value: "center", label: "Center", icon: TextAlignCenter },
  { value: "right", label: "Right", icon: TextAlignEnd },
] as const;

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
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Style</p>
          <p className="text-xs text-foreground-muted">
            Visual controls for the component&apos;s inline style.
          </p>
        </div>
        <span className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase text-foreground-muted">
          Flat CSS
        </span>
      </div>

      <StyleSection title="Layout" id="layout">
        <InspectorRow label="Display">
          <SegmentedControl
            controlId="display"
            options={DISPLAY_OPTIONS}
            value={getStyleValue(style, "display")}
            readOnly={readOnly}
            onChange={(nextValue) => updateStyleKey("display", nextValue)}
          />
        </InspectorRow>
        <InspectorRow label="Direction">
          <SegmentedControl
            controlId="flexDirection"
            options={FLEX_DIRECTION_OPTIONS}
            value={getStyleValue(style, "flexDirection")}
            readOnly={readOnly}
            onChange={(nextValue) => updateStyleKey("flexDirection", nextValue)}
          />
        </InspectorRow>
        <InspectorRow label="Align">
          <SegmentedControl
            controlId="alignItems"
            options={ALIGN_OPTIONS}
            value={getStyleValue(style, "alignItems")}
            readOnly={readOnly}
            onChange={(nextValue) => updateStyleKey("alignItems", nextValue)}
          />
        </InspectorRow>
        <InspectorRow label="Justify">
          <SegmentedControl
            controlId="justifyContent"
            options={JUSTIFY_OPTIONS}
            value={getStyleValue(style, "justifyContent")}
            readOnly={readOnly}
            onChange={(nextValue) =>
              updateStyleKey("justifyContent", nextValue)
            }
          />
        </InspectorRow>
        <InspectorRow label="Wrap">
          <SegmentedControl
            controlId="flexWrap"
            options={FLEX_WRAP_OPTIONS}
            value={getStyleValue(style, "flexWrap")}
            readOnly={readOnly}
            onChange={(nextValue) => updateStyleKey("flexWrap", nextValue)}
          />
        </InspectorRow>
        <div className="grid grid-cols-2 gap-2">
          <StyleValueField
            label="Gap"
            styleKey="gap"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="16px"
          />
          <StyleValueField
            label="Column gap"
            styleKey="columnGap"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="24px"
          />
          <StyleValueField
            label="Row gap"
            styleKey="rowGap"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="24px"
          />
          <div className="space-y-1">
            <span className="block text-[11px] font-medium text-foreground-muted">
              Flow
            </span>
            <SegmentedControl
              controlId="gridAutoFlow"
              options={GRID_FLOW_OPTIONS}
              value={getStyleValue(style, "gridAutoFlow")}
              readOnly={readOnly}
              onChange={(nextValue) =>
                updateStyleKey("gridAutoFlow", nextValue)
              }
            />
          </div>
          <StyleValueField
            label="Columns"
            styleKey="gridTemplateColumns"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="repeat(3, 1fr)"
          />
          <StyleValueField
            label="Rows"
            styleKey="gridTemplateRows"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="auto"
          />
        </div>
      </StyleSection>

      <StyleSection title="Spacing" id="spacing">
        <BoxModelControl
          title="Margin"
          style={style}
          allKey="margin"
          topKey="marginTop"
          rightKey="marginRight"
          bottomKey="marginBottom"
          leftKey="marginLeft"
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
        <BoxModelControl
          title="Padding"
          style={style}
          allKey="padding"
          topKey="paddingTop"
          rightKey="paddingRight"
          bottomKey="paddingBottom"
          leftKey="paddingLeft"
          readOnly={readOnly}
          onChange={updateStyleKey}
        />
      </StyleSection>

      <StyleSection title="Fill" id="fill">
        <ColorControl
          label="Text"
          styleKey="color"
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
          placeholder="#111827"
        />
        <ColorControl
          label="Background"
          styleKey="backgroundColor"
          style={style}
          readOnly={readOnly}
          onChange={updateStyleKey}
          placeholder="#ffffff"
        />
      </StyleSection>

      <StyleSection title="Typography" id="typography">
        <div className="grid grid-cols-3 gap-2">
          <StyleValueField
            label="Size"
            styleKey="fontSize"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="16px"
          />
          <StyleValueField
            label="Weight"
            styleKey="fontWeight"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="600"
          />
          <StyleValueField
            label="Line"
            styleKey="lineHeight"
            style={style}
            readOnly={readOnly}
            onChange={updateStyleKey}
            placeholder="1.5"
          />
        </div>
        <InspectorRow label="Align">
          <SegmentedControl
            controlId="textAlign"
            options={TEXT_ALIGN_OPTIONS}
            value={getStyleValue(style, "textAlign")}
            readOnly={readOnly}
            onChange={(nextValue) => updateStyleKey("textAlign", nextValue)}
          />
        </InspectorRow>
      </StyleSection>

      <details
        data-mdcms-visual-style-section="advanced"
        data-mdcms-style-advanced-details={component.name}
        className="group border-t border-border/70 pt-3"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md p-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary/40">
          <span>Advanced CSS object</span>
          <span className="font-mono text-[10px] uppercase text-foreground-muted group-open:hidden">
            Show JSON
          </span>
          <span className="hidden font-mono text-[10px] uppercase text-foreground-muted group-open:inline">
            Hide JSON
          </span>
        </summary>
        <textarea
          data-mdcms-visual-style-advanced={component.name}
          aria-label={`${component.name} advanced CSS object`}
          rows={8}
          disabled={readOnly}
          defaultValue={JSON.stringify(style, null, 2)}
          onChange={(event) => {
            const parsed = parseAdvancedStyleObject(event.currentTarget.value);

            if (parsed.ok) {
              updateStyle(parsed.value);
            }
          }}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground shadow-xs disabled:cursor-not-allowed disabled:opacity-60"
        />
      </details>
    </section>
  );
}

function StyleSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section data-mdcms-visual-style-section={id} className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        {title}
      </p>
      {children}
    </section>
  );
}

function InspectorRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[74px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] font-medium text-foreground-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

type SegmentedOption = {
  value: string;
  label: string;
  icon?: LucideIcon;
};

function SegmentedControl({
  controlId,
  options,
  value,
  readOnly,
  onChange,
}: {
  controlId: string;
  options: readonly SegmentedOption[];
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div
      data-mdcms-style-segmented-control={controlId}
      className="grid auto-cols-fr grid-flow-col rounded-md border border-border bg-background p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            data-mdcms-style-option-icon={
              Icon ? `${controlId}:${option.value}` : undefined
            }
            disabled={readOnly}
            onClick={() => onChange(active ? "" : option.value)}
            className={cn(
              "h-7 min-w-0 rounded-sm px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              active
                ? "bg-primary/15 text-primary shadow-xs"
                : "text-foreground-muted hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {Icon ? (
              <span className="flex items-center justify-center">
                <Icon className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{option.label}</span>
              </span>
            ) : (
              <span className="block truncate">{option.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function BoxModelControl({
  title,
  style,
  allKey,
  topKey,
  rightKey,
  bottomKey,
  leftKey,
  readOnly,
  onChange,
}: {
  title: string;
  style: InlineStyle;
  allKey: string;
  topKey: string;
  rightKey: string;
  bottomKey: string;
  leftKey: string;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div
      data-mdcms-style-box-model={allKey}
      className="rounded-lg border border-border bg-background/40 p-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground">
          {title}
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase text-foreground-muted">
            All
          </span>
          <StyleValueInput
            styleKey={allKey}
            value={getStyleValue(style, allKey)}
            readOnly={readOnly}
            onChange={onChange}
            placeholder="0"
            className="w-20"
          />
        </div>
      </div>
      <div className="grid grid-cols-[52px_minmax(0,1fr)_52px] grid-rows-[30px_34px_30px] items-center gap-1">
        <div className="col-start-2 row-start-1">
          <StyleValueInput
            styleKey={topKey}
            value={getStyleValue(style, topKey)}
            readOnly={readOnly}
            onChange={onChange}
            placeholder="T"
            ariaLabel={`${title} top`}
          />
        </div>
        <div className="col-start-1 row-start-2">
          <StyleValueInput
            styleKey={leftKey}
            value={getStyleValue(style, leftKey)}
            readOnly={readOnly}
            onChange={onChange}
            placeholder="L"
            ariaLabel={`${title} left`}
          />
        </div>
        <div className="col-start-2 row-start-2 flex h-8 items-center justify-center rounded-md border border-dashed border-border bg-foreground/[0.03] font-mono text-[10px] uppercase text-foreground-muted">
          {title}
        </div>
        <div className="col-start-3 row-start-2">
          <StyleValueInput
            styleKey={rightKey}
            value={getStyleValue(style, rightKey)}
            readOnly={readOnly}
            onChange={onChange}
            placeholder="R"
            ariaLabel={`${title} right`}
          />
        </div>
        <div className="col-start-2 row-start-3">
          <StyleValueInput
            styleKey={bottomKey}
            value={getStyleValue(style, bottomKey)}
            readOnly={readOnly}
            onChange={onChange}
            placeholder="B"
            ariaLabel={`${title} bottom`}
          />
        </div>
      </div>
    </div>
  );
}

function ColorControl({
  label,
  styleKey,
  style,
  readOnly,
  onChange,
  placeholder,
}: {
  label: string;
  styleKey: string;
  style: InlineStyle;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
  placeholder: string;
}) {
  const value = getStyleValue(style, styleKey);

  return (
    <label className="grid grid-cols-[74px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] font-medium text-foreground-muted">
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          data-mdcms-style-swatch={styleKey}
          className="size-8 shrink-0 rounded-md border border-border bg-background shadow-inner"
          style={value ? { backgroundColor: value } : undefined}
        />
        <StyleValueInput
          styleKey={styleKey}
          value={value}
          readOnly={readOnly}
          onChange={onChange}
          placeholder={placeholder}
        />
      </span>
    </label>
  );
}

function StyleValueField({
  label,
  styleKey,
  style,
  readOnly,
  onChange,
  placeholder,
}: {
  label: string;
  styleKey: string;
  style: InlineStyle;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[11px] font-medium text-foreground-muted">
        {label}
      </span>
      <StyleValueInput
        styleKey={styleKey}
        value={getStyleValue(style, styleKey)}
        readOnly={readOnly}
        onChange={onChange}
        placeholder={placeholder}
      />
    </label>
  );
}

function StyleValueInput({
  styleKey,
  value,
  readOnly,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  styleKey: string;
  value: string;
  readOnly: boolean;
  onChange: (key: string, value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <input
      data-mdcms-style-field={styleKey}
      data-mdcms-visual-style-control={styleKey}
      aria-label={ariaLabel ?? styleKey}
      disabled={readOnly}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(styleKey, event.currentTarget.value)}
      className={cn(
        "h-8 min-w-0 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-foreground shadow-xs outline-none transition-colors placeholder:text-foreground-muted/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60",
        className ?? "w-full",
      )}
    />
  );
}

function getStyleValue(style: InlineStyle, key: string): string {
  return style[key] !== undefined ? String(style[key]) : "";
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
