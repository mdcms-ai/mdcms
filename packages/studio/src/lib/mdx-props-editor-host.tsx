import {
  Component,
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { StudioMountContext } from "@mdcms/shared";
import {
  createMdxAutoFormFields,
  type MdxAutoFormField,
} from "@mdcms/shared/mdx/auto-form";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type PropsEditorValue = Record<string, unknown>;
export type PropsEditorChangeHandler<TValue extends object = PropsEditorValue> =
  (nextValue: Partial<TValue>) => void;
export type PropsEditorComponentProps<
  TValue extends object = PropsEditorValue,
> = {
  value: Partial<TValue>;
  onChange: PropsEditorChangeHandler<TValue>;
  readOnly: boolean;
};
export type PropsEditorComponent<TValue extends object = PropsEditorValue> = (
  props: PropsEditorComponentProps<TValue>,
) => ReactNode;

const MDX_CHILDREN_PROP_NAME = "children";

export type MdxPropsEditorHostState =
  | { status: "loading" }
  | { status: "ready"; editor: PropsEditorComponent }
  | { status: "auto-form"; fields: MdxAutoFormField[] }
  | { status: "content-only" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "forbidden" };

type MdxPropsEditorHostStateInput = {
  component: MdxCatalogComponent;
  context: StudioMountContext;
  readOnly: boolean;
  forbidden?: boolean;
};

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

  override componentDidUpdate(prevProps: PropsEditorRenderBoundaryProps): void {
    if (
      prevProps.componentName !== this.props.componentName &&
      this.state.hasError
    ) {
      this.setState({ hasError: false });
    }
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
};

export function createMdxPropsEditorBindings(input: {
  value: PropsEditorValue;
  onChange: PropsEditorChangeHandler;
  readOnly: boolean;
}): PropsEditorComponentProps {
  return {
    value: input.value,
    readOnly: input.readOnly,
    onChange: (nextValue) => {
      if (input.readOnly) {
        return;
      }

      input.onChange(nextValue);
    },
  };
}

export function createInitialMdxPropsEditorHostState(
  input: MdxPropsEditorHostStateInput,
): MdxPropsEditorHostState {
  if (input.forbidden) {
    return { status: "forbidden" };
  }

  if (!input.component.propsEditor || !input.context.mdx) {
    return createFallbackState(input.component);
  }

  return { status: "loading" };
}

export async function resolveMdxPropsEditorHostState(
  input: MdxPropsEditorHostStateInput,
): Promise<MdxPropsEditorHostState> {
  const initialState = createInitialMdxPropsEditorHostState(input);

  if (initialState.status !== "loading") {
    return initialState;
  }

  try {
    const resolvedEditor = await input.context.mdx?.resolvePropsEditor(
      input.component.name,
    );

    if (!resolvedEditor) {
      return createFallbackState(input.component);
    }

    if (typeof resolvedEditor !== "function") {
      return {
        status: "error",
        message: `Custom editor for "${input.component.name}" must resolve to a function component.`,
      };
    }

    return {
      status: "ready",
      editor: resolvedEditor as PropsEditorComponent,
    };
  } catch (error) {
    return {
      status: "error",
      message: formatPropsEditorError(error),
    };
  }
}

export function MdxPropsEditorHost({
  component,
  context,
  initialValue,
  value: controlledValue,
  onChange,
  readOnly = false,
  forbidden = false,
}: MdxPropsEditorHostProps) {
  const [state, setState] = useState<MdxPropsEditorHostState>(() =>
    createInitialMdxPropsEditorHostState({
      component,
      context,
      readOnly,
      forbidden,
    }),
  );
  const [uncontrolledValue, setUncontrolledValue] = useState<PropsEditorValue>(
    () => initialValue ?? {},
  );
  const value = controlledValue ?? uncontrolledValue;
  const handleChange = onChange ?? setUncontrolledValue;

  useEffect(() => {
    if (controlledValue !== undefined) {
      return;
    }

    setUncontrolledValue(initialValue ?? {});
  }, [component.name, controlledValue, initialValue]);

  useEffect(() => {
    let cancelled = false;
    const input = {
      component,
      context,
      readOnly,
      forbidden,
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
  }, [component, context, forbidden, readOnly]);

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
        onChange: handleChange,
        readOnly,
      });

      return (
        <PropsEditorRenderBoundary componentName={component.name}>
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
        handleChange,
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

function createFallbackState(
  component: MdxCatalogComponent,
): MdxPropsEditorHostState {
  const fields = createMdxAutoFormFields(
    component.extractedProps,
    component.propHints,
  ).filter((field) => {
    return !(
      field.name === MDX_CHILDREN_PROP_NAME && field.control === "rich-text"
    );
  });

  return fields.length > 0
    ? { status: "auto-form", fields }
    : hasNestedRichTextChildren(component)
      ? { status: "content-only" }
      : { status: "empty" };
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

function hasNestedRichTextChildren(component: MdxCatalogComponent): boolean {
  return (
    component.extractedProps?.[MDX_CHILDREN_PROP_NAME]?.type === "rich-text"
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
          {...commonProps}
          key={controlId}
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
          {...commonProps}
          key={controlId}
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
          {...commonProps}
          key={controlId}
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
            {...commonProps}
            key={controlId}
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
          {...commonProps}
          key={controlId}
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
          {...commonProps}
          key={controlId}
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
          {...commonProps}
          key={controlId}
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
          {...commonProps}
          key={controlId}
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

function formatPropsEditorError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  const message = String(error).trim();

  return message.length > 0 ? message : "Failed to load custom editor.";
}
