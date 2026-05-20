import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import {
  createInitialMdxPropsEditorHostState,
  createMdxPropsEditorBindings,
  MdxPropsEditorHost,
  ReadyMdxPropsEditor,
  resolveMdxPropsEditorHostState,
  type PropsEditorComponentProps,
} from "./mdx-props-editor-host.js";

function createContext(
  resolvePropsEditor: NonNullable<
    StudioMountContext["mdx"]
  >["resolvePropsEditor"],
): StudioMountContext {
  return {
    apiBaseUrl: "http://localhost:4000",
    basePath: "/admin",
    auth: { mode: "cookie" },
    hostBridge: {
      version: "1",
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    mdx: {
      catalog: {
        components: [],
      },
      resolvePropsEditor,
    },
  };
}

function createComponent(
  overrides: Partial<
    NonNullable<StudioMountContext["mdx"]>["catalog"]["components"][number]
  > = {},
): NonNullable<StudioMountContext["mdx"]>["catalog"]["components"][number] {
  return {
    name: "Chart",
    importPath: "@/components/mdx/Chart",
    extractedProps: {
      title: { type: "string", required: false },
    },
    ...overrides,
  };
}

test("createInitialMdxPropsEditorHostState starts in loading for components with a custom editor", () => {
  const state = createInitialMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
    }),
    context: createContext(async () => null),
    readOnly: false,
  });

  assert.deepEqual(state, {
    status: "loading",
  });
});

test("resolveMdxPropsEditorHostState returns ready with editor bindings", async () => {
  const changes: Array<Record<string, unknown>> = [];
  const Editor = (_props: PropsEditorComponentProps) => null;
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
    }),
    context: createContext(async () => Editor),
    readOnly: false,
  });

  assert.equal(state.status, "ready");
  assert.equal(state.editor, Editor);
  const bindings = createMdxPropsEditorBindings({
    value: { title: "Launch" },
    onChange: (nextValue) => {
      changes.push(nextValue);
    },
    readOnly: false,
  });

  assert.deepEqual(bindings.value, { title: "Launch" });
  assert.equal(bindings.readOnly, false);

  bindings.onChange({ title: "Updated" });

  assert.deepEqual(changes, [{ title: "Updated" }]);
});

test("resolveMdxPropsEditorHostState falls back to auto-form fields when no custom editor resolves", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
      propHints: {
        title: { widget: "textarea" },
      },
    }),
    context: createContext(async () => null),
    readOnly: false,
  });

  assert.deepEqual(state, {
    status: "auto-form",
    fields: [{ name: "title", control: "textarea", required: false }],
  });
});

test("resolveMdxPropsEditorHostState omits nested rich-text children from auto-form fallback fields", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      name: "Callout",
      propsEditor: "@/components/mdx/Callout.editor",
      extractedProps: {
        tone: { type: "enum", required: false, values: ["info", "warning"] },
        children: { type: "rich-text", required: false },
      },
    }),
    context: createContext(async () => null),
    readOnly: false,
  });

  assert.deepEqual(state, {
    status: "auto-form",
    fields: [
      {
        name: "tone",
        control: "select",
        required: false,
        options: ["info", "warning"],
      },
    ],
  });
});

test("resolveMdxPropsEditorHostState returns empty when no editor or auto-form controls exist", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
      extractedProps: undefined,
    }),
    context: createContext(async () => null),
    readOnly: false,
  });

  assert.deepEqual(state, {
    status: "empty",
  });
});

test("resolveMdxPropsEditorHostState returns content-only for wrapper components whose editable surface is nested children", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      name: "Callout",
      extractedProps: {
        children: { type: "rich-text", required: false },
      },
    }),
    context: createContext(async () => null),
    readOnly: false,
  });

  assert.deepEqual(state, {
    status: "content-only",
  });
});

test("resolveMdxPropsEditorHostState returns error when the custom editor resolver rejects", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
    }),
    context: createContext(async () => {
      throw new Error("boom");
    }),
    readOnly: false,
  });

  assert.equal(state.status, "error");
  assert.match(state.message, /boom/);
});

test("resolveMdxPropsEditorHostState keeps custom editors on the ready path in read-only mode", async () => {
  const Editor = (_props: PropsEditorComponentProps) => null;
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
    }),
    context: createContext(async () => Editor),
    readOnly: true,
  });

  assert.deepEqual(state, {
    status: "ready",
    editor: Editor,
  });
});

test("resolveMdxPropsEditorHostState returns forbidden when access is explicitly unavailable", async () => {
  const state = await resolveMdxPropsEditorHostState({
    component: createComponent({
      propsEditor: "@/components/mdx/Chart.editor",
    }),
    context: createContext(async () => {
      throw new Error("should not resolve");
    }),
    readOnly: true,
    forbidden: true,
  });

  assert.deepEqual(state, {
    status: "forbidden",
  });
});

test("createMdxPropsEditorBindings suppresses mutation in read-only mode", () => {
  const changes: Array<Record<string, unknown>> = [];
  const bindings = createMdxPropsEditorBindings({
    value: { title: "Launch" },
    onChange: (nextValue) => {
      changes.push(nextValue);
    },
    readOnly: true,
  });

  bindings.onChange({ title: "Updated" });

  assert.deepEqual(changes, []);
  assert.equal(bindings.readOnly, true);
});

test("MdxPropsEditorHost renders interactive auto-form controls for fallback props editing", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxPropsEditorHost, {
      component: createComponent({
        propHints: {
          title: { widget: "textarea" },
        },
        extractedProps: {
          title: { type: "string", required: false },
          published: { type: "boolean", required: false },
          variant: {
            type: "enum",
            required: false,
            values: ["info", "warning"],
          },
        },
      }),
      context: createContext(async () => null),
      value: {
        title: "Launch copy",
        published: true,
        variant: "warning",
      },
      onChange: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-auto-form="Chart"/);
  assert.match(markup, /textarea/);
  assert.match(markup, /data-mdcms-mdx-auto-control="Chart:published:boolean"/);
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /data-mdcms-mdx-auto-control="Chart:variant:select"/);
  assert.match(markup, /<select/);
});

test("MdxPropsEditorHost renders style props with the style auto-form control", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxPropsEditorHost, {
      component: createComponent({
        name: "Box",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
        extractedProps: {
          style: { type: "style", required: false },
        },
      }),
      context: createContext(async () => null),
      value: {
        style: {
          padding: "16px",
          marginTop: 4,
        },
      },
      onChange: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-auto-control="Box:style:style"/);
  assert.match(markup, /data-mdcms-mdx-auto-field-hint="Box:style"/);
  assert.match(markup, />style</);
  assert.match(markup, /&quot;padding&quot;: &quot;16px&quot;/);
});

test("MdxPropsEditorHost renders compact type hints for generated auto-form fields", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxPropsEditorHost, {
      component: createComponent({
        propHints: {
          color: { widget: "color-picker" },
        },
        extractedProps: {
          data: { type: "array", required: true, items: "number" },
          type: {
            type: "enum",
            required: true,
            values: ["bar", "line", "pie"],
          },
          title: { type: "string", required: false },
          color: { type: "string", required: false },
        },
      }),
      context: createContext(async () => null),
      value: {},
      onChange: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-auto-field-hint="Chart:data"/);
  assert.match(markup, />number\[\]</);
  assert.match(markup, /data-mdcms-mdx-auto-field-hint="Chart:type"/);
  assert.match(markup, />bar \| line \| pie</);
  assert.match(markup, /data-mdcms-mdx-auto-field-hint="Chart:title"/);
  assert.match(markup, />string</);
  assert.match(markup, /data-mdcms-mdx-auto-field-hint="Chart:color"/);
  assert.match(markup, />color</);
});

test("ReadyMdxPropsEditor keeps diagnostics out of the visible custom editor surface", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "section",
      null,
      createElement(ReadyMdxPropsEditor, {
        componentName: "PricingTable",
        editor: (_props: PropsEditorComponentProps) =>
          createElement(
            "div",
            { "data-test-editor": "PricingTable" },
            "Editor",
          ),
        bindings: {
          value: {},
          readOnly: false,
          onChange: () => {},
        },
      }),
    ),
  );

  assert.match(markup, /data-mdcms-mdx-props-editor-surface="PricingTable"/);
  assert.match(markup, /data-test-editor="PricingTable"/);
  assert.doesNotMatch(markup, /Custom editor ready/);
  assert.doesNotMatch(markup, />Custom editor</);
});
