import { RuntimeError } from "../runtime/error.js";
import type {
  MdxExtractedProp,
  MdxExtractedProps,
} from "../contracts/extensibility.js";
import {
  getMdxPropHintWidget,
  type MdxPropHint,
  type MdxSelectOption,
} from "./prop-hints.js";

export type MdxAutoFormField =
  | { name: string; control: "text"; required: boolean }
  | { name: string; control: "url"; required: boolean }
  | { name: string; control: "color-picker"; required: boolean }
  | { name: string; control: "textarea"; required: boolean }
  | { name: string; control: "number"; required: boolean }
  | {
      name: string;
      control: "slider";
      required: boolean;
      min: number;
      max: number;
      step?: number;
    }
  | { name: string; control: "boolean"; required: boolean }
  | {
      name: string;
      control: "select";
      required: boolean;
      options: MdxSelectOption[];
    }
  | { name: string; control: "image"; required: boolean }
  | { name: string; control: "string-list"; required: boolean }
  | { name: string; control: "number-list"; required: boolean }
  | { name: string; control: "date"; required: boolean }
  | { name: string; control: "style"; required: boolean }
  | { name: string; control: "json"; required: boolean }
  | { name: string; control: "rich-text"; required: boolean };

export function createMdxAutoFormFields(
  extractedProps: MdxExtractedProps | undefined,
  propHints?: Record<string, MdxPropHint>,
): MdxAutoFormField[] {
  if (!extractedProps) {
    return [];
  }

  const fields: MdxAutoFormField[] = [];

  for (const [name, prop] of Object.entries(extractedProps)) {
    const hint = propHints?.[name];
    const widget = getMdxPropHintWidget(hint);

    if (widget) {
      assertCompatiblePropHint(name, prop, hint);

      switch (widget) {
        case "color-picker":
          fields.push({
            name,
            control: "color-picker",
            required: prop.required,
          });
          continue;
        case "textarea":
          fields.push({ name, control: "textarea", required: prop.required });
          continue;
        case "slider": {
          assertSliderPropHint(name, hint);
          const sliderHint = hint as Extract<MdxPropHint, { widget: "slider" }>;
          fields.push({
            name,
            control: "slider",
            required: prop.required,
            min: sliderHint.min,
            max: sliderHint.max,
            ...(sliderHint.step !== undefined ? { step: sliderHint.step } : {}),
          });
          continue;
        }
        case "image":
          fields.push({ name, control: "image", required: prop.required });
          continue;
        case "select": {
          assertSelectPropHint(name, hint);
          const selectHint = hint as Extract<MdxPropHint, { widget: "select" }>;
          fields.push({
            name,
            control: "select",
            required: prop.required,
            options: selectHint.options.map(cloneSelectOption),
          });
          continue;
        }
        case "hidden":
          continue;
        case "json":
          fields.push({ name, control: "json", required: prop.required });
          continue;
      }
    }

    switch (prop.type) {
      case "string":
        fields.push({
          name,
          control: prop.format === "url" ? "url" : "text",
          required: prop.required,
        });
        break;
      case "number":
        fields.push({ name, control: "number", required: prop.required });
        break;
      case "boolean":
        fields.push({ name, control: "boolean", required: prop.required });
        break;
      case "enum":
        fields.push({
          name,
          control: "select",
          required: prop.required,
          options: [...prop.values],
        });
        break;
      case "array":
        fields.push({
          name,
          control: prop.items === "number" ? "number-list" : "string-list",
          required: prop.required,
        });
        break;
      case "date":
        fields.push({ name, control: "date", required: prop.required });
        break;
      case "rich-text":
        fields.push({ name, control: "rich-text", required: prop.required });
        break;
      case "style":
        fields.push({ name, control: "style", required: prop.required });
        break;
      case "json":
        break;
    }
  }

  return fields;
}

function assertCompatiblePropHint(
  name: string,
  prop: MdxExtractedProp,
  hint: MdxPropHint | undefined,
): void {
  if (!hint) {
    return;
  }

  const widget = getMdxPropHintWidget(hint);

  switch (widget) {
    case "color-picker":
    case "textarea":
    case "image":
      if (prop.type !== "string") {
        throw invalidConfig(
          name,
          `widget "${widget}" is only valid for extracted string props.`,
        );
      }
      return;
    case "slider":
      if (prop.type !== "number") {
        throw invalidConfig(
          name,
          'widget "slider" is only valid for extracted number props.',
        );
      }
      return;
    case "select":
      assertSelectPropHint(name, hint);
      assertCompatibleSelectHint(
        name,
        prop,
        (hint as Extract<MdxPropHint, { widget: "select" }>).options,
      );
      return;
    case "json":
      if (prop.type !== "json") {
        throw invalidConfig(
          name,
          'widget "json" is only valid for extracted json props.',
        );
      }
      return;
    case "hidden":
    case undefined:
      return;
  }
}

function assertCompatibleSelectHint(
  name: string,
  prop: MdxExtractedProp,
  options: MdxSelectOption[],
): void {
  switch (prop.type) {
    case "string":
    case "number":
    case "boolean":
      if (
        !options.every(
          (option) => typeof getSelectOptionValue(option) === prop.type,
        )
      ) {
        throw invalidConfig(
          name,
          'widget "select" option values must match the target prop scalar kind.',
        );
      }
      return;
    case "enum":
      if (
        !options.every((option) => {
          const value = getSelectOptionValue(option);
          return typeof value === "string" && prop.values.includes(value);
        })
      ) {
        throw invalidConfig(
          name,
          'widget "select" option values must be strings within the extracted enum values.',
        );
      }
      return;
    default:
      throw invalidConfig(
        name,
        'widget "select" is only valid for extracted string, number, boolean, or enum props.',
      );
  }
}

function cloneSelectOption(option: MdxSelectOption): MdxSelectOption {
  return typeof option === "object" ? { ...option } : option;
}

function assertSliderPropHint(
  field: string,
  hint: MdxPropHint | undefined,
): asserts hint is Extract<MdxPropHint, { widget: "slider" }> {
  if (!hint || !("widget" in hint) || hint.widget !== "slider") {
    throw invalidConfig(field, 'widget "slider" is invalid for this prop.');
  }
}

function assertSelectPropHint(
  field: string,
  hint: MdxPropHint | undefined,
): asserts hint is Extract<MdxPropHint, { widget: "select" }> {
  if (!hint || !("widget" in hint) || hint.widget !== "select") {
    throw invalidConfig(field, 'widget "select" is invalid for this prop.');
  }
}

function getSelectOptionValue(option: MdxSelectOption) {
  return typeof option === "object" ? option.value : option;
}

function invalidConfig(field: string, message: string): RuntimeError {
  return new RuntimeError({
    code: "INVALID_CONFIG",
    message: `Config field "propHints.${field}" ${message}`,
    statusCode: 400,
    details: { field: `propHints.${field}` },
  });
}
