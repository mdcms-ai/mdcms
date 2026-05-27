import {
  Component,
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { StudioMountContext } from "@mdcms/shared";
import type { MdxAutoFormField } from "@mdcms/shared/mdx/auto-form";
import {
  createInitialMdxPropsEditorHostState,
  createMdxPropsEditorBindings,
  resolveMdxPropsEditorHostState,
  type MdxPropsEditorHostState,
  type PropsEditorChangeHandler,
  type PropsEditorComponent,
  type PropsEditorComponentProps,
  type PropsEditorValue,
} from "./mdx-props-editor-host-state.js";

export type {
  MdxPropsEditorHostState,
  PropsEditorChangeHandler,
  PropsEditorComponent,
  PropsEditorComponentProps,
  PropsEditorValue,
} from "./mdx-props-editor-host-state.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const EMPTY_HIDDEN_FIELD_NAMES: readonly string[] = [];

type PropsEditorRenderBoundaryProps = {
  componentName: string;
  children: ReactNode;
};

type PropsEditorRenderBoundaryState = {
  hasError: boolean;
};

class PropsEditorRenderBoundary extends Component<
  PropsEditorRenderBoundaryProps,
  PropsEditorRenderBoundaryState
> {
  override state: PropsEditorRenderBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): PropsEditorRenderBoundaryState {
    return {
      hasError: true,
    };
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <span
          data-mdcms-mdx-props-editor-state={`${this.props.componentName}:error`}
        >
          Custom editor failed to render.
        </span>
      );
    }

    return this.props.children;
  }
}

export type MdxPropsEditorHostProps = {
  component: MdxCatalogComponent;
  context: StudioMountContext;
  initialValue?: PropsEditorValue;
  value?: PropsEditorValue;
  onChange?: PropsEditorChangeHandler;
  readOnly?: boolean;
  forbidden?: boolean;
  hiddenFieldNames?: readonly string[];
};

export function MdxPropsEditorHost({
  component,
  context,
  initialValue,
  value: controlledValue,
  onChange,
  readOnly = false,
  forbidden = false,
  hiddenFieldNames = EMPTY_HIDDEN_FIELD_NAMES,
}: MdxPropsEditorHostProps) {
  const commonProps = {
    component,
    context,
    readOnly,
    forbidden,
    hiddenFieldNames,
  };

  if (controlledValue !== undefined) {
    return (
      <MdxPropsEditorHostResolved
        {...commonProps}
        value={controlledValue}
        onChange={onChange ?? (() => undefined)}
      />
    );
  }

  return (
    <MdxPropsEditorHostUncontrolled
      key={component.name}
      {...commonProps}
      initialValue={initialValue ?? {}}
    />
  );
}

type MdxPropsEditorHostResolvedProps = {
  component: MdxCatalogComponent;
  context: StudioMountContext;
  value: PropsEditorValue;
  onChange: PropsEditorChangeHandler;
  readOnly: boolean;
  forbidden: boolean;
  hiddenFieldNames: readonly string[];
};

function MdxPropsEditorHostUncontrolled({
  initialValue,
  ...props
}: Omit<MdxPropsEditorHostResolvedProps, "value" | "onChange"> & {
  initialValue: PropsEditorValue;
}) {
  const [value, setValue] = useState<PropsEditorValue>(() => initialValue);

  return (
    <MdxPropsEditorHostResolved {...props} value={value} onChange={setValue} />
  );
}

function MdxPropsEditorHostResolved({
  component,
  context,
  value,
  onChange,
  readOnly,
  forbidden,
  hiddenFieldNames,
}: MdxPropsEditorHostResolvedProps) {
  const [state, setState] = useState<MdxPropsEditorHostState>(() =>
    createInitialMdxPropsEditorHostState({
      component,
      context,
      readOnly,
      forbidden,
      hiddenFieldNames,
    }),
  );

  useEffect(() => {
    let cancelled = false;
    const input = {
      component,
      context,
      readOnly,
      forbidden,
      hiddenFieldNames,
    };
    const initialState = createInitialMdxPropsEditorHostState(input);

    setState(initialState);

    if (initialState.status !== "loading") {
      return;
    }

    void resolveMdxPropsEditorHostState(input).then((resolvedState) => {
      if (!cancelled) {
        setState(resolvedState);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [component, context, forbidden, hiddenFieldNames, readOnly]);

  switch (state.status) {
    case "loading":
      return (
        <span data-mdcms-mdx-props-editor-state={`${component.name}:loading`}>
          Loading custom editor.
        </span>
      );
    case "ready": {
      const bindings = createMdxPropsEditorBindings({
        value,
        onChange,
        readOnly,
      });

      return (
        <PropsEditorRenderBoundary
          key={component.name}
          componentName={component.name}
        >
          <ReadyMdxPropsEditor
            componentName={component.name}
            editor={state.editor as PropsEditorComponent<PropsEditorValue>}
            bindings={bindings}
          />
        </PropsEditorRenderBoundary>
      );
    }
    case "auto-form":
      return renderAutoFormFields(
        component.name,
        state.fields,
        value,
        onChange,
        readOnly,
      );
    case "empty":
      return (
        <span data-mdcms-mdx-props-editor-state={`${component.name}:empty`}>
          No editable props.
        </span>
      );
    case "content-only":
      return (
        <span
          data-mdcms-mdx-props-editor-state={`${component.name}:content-only`}
        >
          This wrapper component is edited through its nested content block in
          the editor canvas.
        </span>
      );
    case "error":
      return (
        <span data-mdcms-mdx-props-editor-state={`${component.name}:error`}>
          {state.message}
        </span>
      );
    case "forbidden":
      return (
        <span data-mdcms-mdx-props-editor-state={`${component.name}:forbidden`}>
          Editing is unavailable.
        </span>
      );
  }
}

export function ReadyMdxPropsEditor(input: {
  componentName: string;
  editor: PropsEditorComponent<PropsEditorValue>;
  bindings: PropsEditorComponentProps<PropsEditorValue>;
}): ReactNode {
  return (
    <>
      <span
        hidden
        data-mdcms-mdx-props-editor-state={`${input.componentName}:ready`}
      />
      <span hidden data-mdcms-mdx-props-editor={input.componentName} />
      <div data-mdcms-mdx-props-editor-surface={input.componentName}>
        {createElement(input.editor, input.bindings)}
      </div>
    </>
  );
}

function renderAutoFormFields(
  componentName: string,
  fields: MdxAutoFormField[],
  value: PropsEditorValue,
  onChange: PropsEditorChangeHandler,
  readOnly: boolean,
): ReactNode {
  return (
    <div data-mdcms-mdx-auto-form={componentName} className="space-y-3">
      {fields.map((field) => (
        <div
          key={`${componentName}:${field.name}:${field.control}`}
          className="space-y-2"
        >
          <label
            htmlFor={getAutoFormFieldId(componentName, field.name)}
            className="flex items-baseline gap-1.5 text-xs font-medium text-foreground"
          >
            <span>
              {field.name}
              {field.required ? (
                <span className="ml-1 text-destructive">*</span>
              ) : null}
            </span>
            <span
              data-mdcms-mdx-auto-field-hint={`${componentName}:${field.name}`}
              className="font-mono text-[10px] text-foreground-muted"
            >
              {formatAutoFormFieldTypeHint(field)}
            </span>
          </label>
          <AutoFormFieldControl
            componentName={componentName}
            field={field}
            value={value[field.name]}
            onChange={onChange}
            readOnly={readOnly}
          />
        </div>
      ))}
    </div>
  );
}

function AutoFormFieldControl(input: {
  componentName: string;
  field: MdxAutoFormField;
  value: unknown;
  onChange: PropsEditorChangeHandler;
  readOnly: boolean;
}): ReactNode {
  const id = getAutoFormFieldId(input.componentName, input.field.name);
  const controlId = `${input.componentName}:${input.field.name}:${input.field.control}`;
  const commonProps = {
    id,
    disabled: input.readOnly,
    "aria-label": input.field.name,
    "data-mdcms-mdx-auto-control": controlId,
    className:
      "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs disabled:cursor-not-allowed disabled:opacity-60",
  } as const;

  switch (input.field.control) {
    case "text":
    case "url":
    case "color-picker":
    case "date":
    case "image":
      return (
        <input
          key={controlId}
          {...commonProps}
          type={getAutoFormInputType(input.field.control)}
          defaultValue={
            typeof input.value === "string"
              ? input.value
              : String(input.value ?? "")
          }
          onChange={(event) => {
            input.onChange({
              [input.field.name]:
                event.currentTarget.value.length > 0
                  ? event.currentTarget.value
                  : undefined,
            });
          }}
        />
      );
    case "textarea":
      return (
        <textarea
          key={controlId}
          {...commonProps}
          rows={4}
          defaultValue={
            typeof input.value === "string"
              ? input.value
              : String(input.value ?? "")
          }
          onChange={(event) => {
            input.onChange({
              [input.field.name]:
                event.currentTarget.value.length > 0
                  ? event.currentTarget.value
                  : undefined,
            });
          }}
        />
      );
    case "number":
      return (
        <input
          key={controlId}
          {...commonProps}
          type="number"
          defaultValue={
            typeof input.value === "number" ? String(input.value) : ""
          }
          onChange={(event) => {
            const nextValue = event.currentTarget.value.trim();

            if (nextValue.length === 0) {
              input.onChange({ [input.field.name]: undefined });
              return;
            }

            const parsedValue = Number(nextValue);

            if (Number.isFinite(parsedValue)) {
              input.onChange({ [input.field.name]: parsedValue });
            }
          }}
        />
      );
    case "slider":
      return (
        <div className="space-y-1">
          <input
            key={controlId}
            {...commonProps}
            type="range"
            min={input.field.min}
            max={input.field.max}
            step={input.field.step}
            defaultValue={String(
              typeof input.value === "number" ? input.value : input.field.min,
            )}
            onChange={(event) => {
              input.onChange({
                [input.field.name]: Number(event.currentTarget.value),
              });
            }}
          />
          <p className="text-xs text-foreground-muted">
            Current value:{" "}
            {typeof input.value === "number" ? input.value : input.field.min}
          </p>
        </div>
      );
    case "boolean":
      return (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            id={id}
            aria-label={input.field.name}
            key={controlId}
            type="checkbox"
            disabled={input.readOnly}
            defaultChecked={Boolean(input.value)}
            data-mdcms-mdx-auto-control={controlId}
            onChange={(event) => {
              input.onChange({
                [input.field.name]: event.currentTarget.checked,
              });
            }}
          />
          <span>Enabled</span>
        </label>
      );
    case "select": {
      const selectField = input.field as Extract<
        MdxAutoFormField,
        { control: "select" }
      >;

      return (
        <select
          key={controlId}
          {...commonProps}
          defaultValue={serializeAutoFormSelectValue(input.value)}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;

            input.onChange({
              [selectField.name]:
                nextValue.length > 0
                  ? parseAutoFormSelectValue(selectField, nextValue)
                  : undefined,
            });
          }}
        >
          <option value="">Select…</option>
          {selectField.options.map((option) => {
            const value = getAutoFormSelectOptionValue(option);

            return (
              <option
                key={`${controlId}:${serializeAutoFormSelectValue(value)}`}
                value={serializeAutoFormSelectValue(value)}
              >
                {getAutoFormSelectOptionLabel(option)}
              </option>
            );
          })}
        </select>
      );
    }
    case "string-list":
      return (
        <textarea
          key={controlId}
          {...commonProps}
          rows={4}
          defaultValue={formatAutoFormListValue(input.value)}
          onChange={(event) => {
            input.onChange({
              [input.field.name]: parseAutoFormStringListValue(
                event.currentTarget.value,
              ),
            });
          }}
        />
      );
    case "number-list":
      return (
        <textarea
          key={controlId}
          {...commonProps}
          rows={4}
          defaultValue={formatAutoFormListValue(input.value)}
          onChange={(event) => {
            const nextValue = event.currentTarget.value.trim();

            if (nextValue.length === 0) {
              input.onChange({
                [input.field.name]: undefined,
              });
              return;
            }

            const parsed = parseAutoFormNumberListValue(
              event.currentTarget.value,
            );

            if (parsed) {
              input.onChange({
                [input.field.name]: parsed,
              });
            }
          }}
        />
      );
    case "json":
    case "style":
      return (
        <textarea
          key={controlId}
          {...commonProps}
          rows={6}
          defaultValue={formatAutoFormJsonValue(input.value)}
          onChange={(event) => {
            const nextValue = event.currentTarget.value.trim();

            if (nextValue.length === 0) {
              input.onChange({ [input.field.name]: undefined });
              return;
            }

            try {
              input.onChange({
                [input.field.name]: JSON.parse(nextValue),
              });
            } catch {
              return;
            }
          }}
        />
      );
    case "rich-text":
      return (
        <p
          data-mdcms-mdx-auto-control={controlId}
          className="text-xs text-foreground-muted"
        >
          Rich-text content is edited inline inside the component block.
        </p>
      );
  }
}

function getAutoFormFieldId(componentName: string, fieldName: string): string {
  return `${componentName}-${fieldName}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

function formatAutoFormFieldTypeHint(field: MdxAutoFormField): string {
  switch (field.control) {
    case "text":
    case "textarea":
      return "string";
    case "url":
      return "url";
    case "color-picker":
      return "color";
    case "number":
    case "slider":
      return "number";
    case "boolean":
      return "boolean";
    case "image":
      return "image";
    case "string-list":
      return "string[]";
    case "number-list":
      return "number[]";
    case "date":
      return "date";
    case "json":
      return "JSON";
    case "style":
      return "style";
    case "rich-text":
      return "rich text";
    case "select":
      return formatAutoFormSelectTypeHint(field.options);
  }
}

function formatAutoFormSelectTypeHint(
  options: Extract<MdxAutoFormField, { control: "select" }>["options"],
): string {
  const labels = options.map((option) => getAutoFormSelectOptionLabel(option));
  const compactLabel = labels.join(" | ");

  return labels.length > 0 && labels.length <= 4 && compactLabel.length <= 32
    ? compactLabel
    : "enum";
}

function getAutoFormInputType(
  control: "text" | "url" | "color-picker" | "date" | "image",
): string {
  switch (control) {
    case "url":
      return "url";
    case "color-picker":
      return "color";
    case "date":
      return "date";
    default:
      return "text";
  }
}

function formatAutoFormListValue(value: unknown): string {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).join("\n")
    : "";
}

function parseAutoFormStringListValue(value: string): string[] | undefined {
  const items = value.split("\n").flatMap((entry) => {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });

  return items.length > 0 ? items : undefined;
}

function parseAutoFormNumberListValue(value: string): number[] | undefined {
  const items = value.split("\n").flatMap((entry) => {
    const trimmed = entry.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });

  if (items.length === 0) {
    return undefined;
  }

  const numbers = items.map((entry) => Number(entry));

  return numbers.every((entry) => Number.isFinite(entry)) ? numbers : undefined;
}

function formatAutoFormJsonValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function serializeAutoFormSelectValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return `string:${value}`;
    case "number":
      return `number:${value}`;
    case "boolean":
      return `boolean:${value ? "true" : "false"}`;
    default:
      return "";
  }
}

function parseAutoFormSelectValue(
  field: Extract<MdxAutoFormField, { control: "select" }>,
  value: string,
): string | number | boolean | undefined {
  const matchedOption = field.options.find((option) => {
    return (
      serializeAutoFormSelectValue(getAutoFormSelectOptionValue(option)) ===
      value
    );
  });

  return matchedOption
    ? getAutoFormSelectOptionValue(matchedOption)
    : undefined;
}

function getAutoFormSelectOptionValue(
  option: Extract<MdxAutoFormField, { control: "select" }>["options"][number],
): string | number | boolean {
  return typeof option === "object" ? option.value : option;
}

function getAutoFormSelectOptionLabel(
  option: Extract<MdxAutoFormField, { control: "select" }>["options"][number],
): string {
  return typeof option === "object" ? option.label : String(option);
}
