import type { ReactNode } from "react";

import type { StudioMountContext } from "@mdcms/shared";
import {
  createMdxAutoFormFields,
  type MdxAutoFormField,
} from "@mdcms/shared/mdx/auto-form";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const MDX_CHILDREN_PROP_NAME = "children";

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

export type MdxPropsEditorHostState =
  | { status: "loading" }
  | { status: "ready"; editor: PropsEditorComponent }
  | { status: "auto-form"; fields: MdxAutoFormField[] }
  | { status: "content-only" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "forbidden" };

export type MdxPropsEditorHostStateInput = {
  component: MdxCatalogComponent;
  context: StudioMountContext;
  readOnly: boolean;
  forbidden?: boolean;
  hiddenFieldNames?: readonly string[];
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
    return createFallbackState(input.component, input.hiddenFieldNames);
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
      return createFallbackState(input.component, input.hiddenFieldNames);
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

function createFallbackState(
  component: MdxCatalogComponent,
  hiddenFieldNames: readonly string[] = [],
): MdxPropsEditorHostState {
  const hiddenFieldNameSet = new Set(hiddenFieldNames);
  const fields = createMdxAutoFormFields(
    component.extractedProps,
    component.propHints,
  ).filter((field) => {
    return (
      !hiddenFieldNameSet.has(field.name) &&
      !(field.name === MDX_CHILDREN_PROP_NAME && field.control === "rich-text")
    );
  });

  return fields.length > 0
    ? { status: "auto-form", fields }
    : hasNestedRichTextChildren(component)
      ? { status: "content-only" }
      : { status: "empty" };
}

function hasNestedRichTextChildren(component: MdxCatalogComponent): boolean {
  return (
    component.extractedProps?.[MDX_CHILDREN_PROP_NAME]?.type === "rich-text"
  );
}

function formatPropsEditorError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  const message = String(error).trim();

  return message.length > 0 ? message : "Failed to load custom editor.";
}
