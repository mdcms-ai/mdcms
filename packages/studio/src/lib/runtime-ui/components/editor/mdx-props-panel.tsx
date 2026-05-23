"use client";

import type { StudioMountContext } from "@mdcms/shared";
import { createMdxAutoFormFields } from "@mdcms/shared/mdx/auto-form";

import {
  MdxPropsEditorHost,
  type PropsEditorChangeHandler,
  type PropsEditorValue,
} from "../../../mdx-props-editor-host.js";
import { VisualStyleInspector } from "./visual-style-inspector.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

const COMPONENT_PANEL_HIDDEN_PROP_FIELDS = ["style"] as const;
const COMPONENT_PANEL_HIDDEN_PROP_FIELD_NAMES = new Set<string>(
  COMPONENT_PANEL_HIDDEN_PROP_FIELDS,
);
const MDX_CHILDREN_PROP_NAME = "children";

export type MdxPropsPanelSelection = {
  component: MdxCatalogComponent | undefined;
  componentName: string;
  isVoid: boolean;
  props: PropsEditorValue;
  onPropsChange: PropsEditorChangeHandler;
  readOnly: boolean;
  forbidden: boolean;
};

export function MdxPropsPanel({
  context,
  selection,
}: {
  context: StudioMountContext;
  selection: MdxPropsPanelSelection | null;
}) {
  if (!selection) {
    return (
      <section data-mdcms-mdx-props-panel="idle" className="space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            MDX component props
          </p>
          <p className="text-xs text-foreground-muted">
            Select an MDX component block to inspect or edit its props.
          </p>
        </div>
      </section>
    );
  }

  if (!selection.component) {
    return (
      <section data-mdcms-mdx-props-panel="unregistered" className="space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            MDX component props
          </p>
          <p className="text-xs text-foreground-muted">
            {selection.componentName} is not registered in the local MDX
            component catalog.
          </p>
        </div>
      </section>
    );
  }

  const component = selection.component;
  const hasPropsEditor = hasConcreteComponentPanelProps(component);

  return (
    <section data-mdcms-mdx-props-panel={component.name} className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          MDX component props
        </p>
        <p className="text-xs text-foreground-muted">Selected component</p>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{component.name}</p>
        {component.description ? (
          <p className="text-xs text-foreground-muted">
            {component.description}
          </p>
        ) : null}
      </div>

      {hasPropsEditor ? (
        <div className="rounded-md border border-border bg-background-subtle p-3">
          <MdxPropsEditorHost
            component={component}
            context={context}
            value={selection.props}
            onChange={selection.onPropsChange}
            readOnly={selection.readOnly}
            forbidden={selection.forbidden}
            hiddenFieldNames={COMPONENT_PANEL_HIDDEN_PROP_FIELDS}
          />
        </div>
      ) : null}

      <VisualStyleInspector
        component={component}
        value={selection.props}
        onChange={selection.onPropsChange}
        readOnly={selection.readOnly || selection.forbidden}
      />
    </section>
  );
}

function hasConcreteComponentPanelProps(
  component: MdxCatalogComponent,
): boolean {
  if (component.propsEditor) {
    return true;
  }

  return createMdxAutoFormFields(
    component.extractedProps,
    component.propHints,
  ).some((field) => {
    return (
      !COMPONENT_PANEL_HIDDEN_PROP_FIELD_NAMES.has(field.name) &&
      !(field.name === MDX_CHILDREN_PROP_NAME && field.control === "rich-text")
    );
  });
}
