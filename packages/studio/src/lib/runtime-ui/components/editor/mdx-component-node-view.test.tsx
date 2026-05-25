import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatMdxComponentPropsSummary,
  MdxComponentNodeFrame,
} from "./mdx-component-node-view.js";

test("MdxComponentNodeFrame renders wrapper content once as the editable surface", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Callout",
        isVoid: false,
        propsSummary: 'type="warning"',
        previewState: "ready",
        previewSurface: createElement(
          "div",
          { "data-test-preview": "ready" },
          "Child content",
        ),
      },
      createElement("div", { "data-test-slot": "children" }, "Child content"),
    ),
  );

  assert.match(markup, /data-mdcms-mdx-component-frame="Callout"/);
  assert.match(markup, /data-mdcms-mdx-component-kind="wrapper"/);
  assert.match(markup, /&lt;Callout \/&gt;/);
  assert.match(markup, /data-test-slot="children"/);
  assert.doesNotMatch(markup, /data-mdcms-mdx-preview-state="ready"/);
  assert.doesNotMatch(markup, /data-test-preview="ready"/);
  assert.equal(markup.match(/Child content/g)?.length, 1);
  assert.doesNotMatch(markup, />Wrapper</);
  assert.doesNotMatch(markup, /type=&quot;warning&quot;/);
});

test("MdxComponentNodeFrame renders void component chrome without child slot", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "HeroBanner",
      isVoid: true,
      propsSummary: 'title="Launch"',
      previewState: "empty",
    }),
  );

  assert.match(markup, /data-mdcms-mdx-component-frame="HeroBanner"/);
  assert.match(markup, /data-mdcms-mdx-component-kind="void"/);
  assert.match(markup, /data-mdcms-mdx-preview-state="empty"/);
  assert.match(markup, /&lt;HeroBanner \/&gt;/);
  assert.doesNotMatch(markup, /Local preview unavailable/);
  assert.doesNotMatch(markup, /Self-closing component/);
  assert.doesNotMatch(markup, /data-test-slot="children"/);
  assert.doesNotMatch(markup, />Void</);
});

test("formatMdxComponentPropsSummary distinguishes empty props from non-editable components", () => {
  assert.equal(formatMdxComponentPropsSummary({}), "No props set yet");
  assert.equal(formatMdxComponentPropsSummary(undefined), "No props set yet");
});

test("MdxComponentNodeFrame renders content-label data attribute for wrapper components", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Callout",
        isVoid: false,
        propsSummary: 'type="warning"',
        previewState: "empty",
      },
      createElement("div", { "data-test-slot": "children" }, "Child content"),
    ),
  );

  assert.match(markup, /data-mdcms-mdx-content-label="Callout"/);
  assert.doesNotMatch(markup, />Inner content</);
  assert.doesNotMatch(markup, /Edit nested markdown directly in this block/);
});

test("MdxComponentNodeFrame does not draw a separator before wrapper children", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Box",
        isVoid: false,
        propsSummary: "",
        previewState: "ready",
        previewSurface: null,
        canReceiveChildDrops: true,
      },
      createElement("div", { "data-test-slot": "children" }),
    ),
  );

  assert.doesNotMatch(markup, /border-t border-border/);
});

test("MdxComponentNodeFrame does not render content label for void components", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "HeroBanner",
      isVoid: true,
      propsSummary: 'title="Launch"',
      previewState: "empty",
    }),
  );

  assert.doesNotMatch(markup, /data-mdcms-mdx-content-label/);
});

test("MdxComponentNodeFrame renders action buttons when callbacks are provided", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Alert",
      isVoid: true,
      propsSummary: "",
      previewState: "empty",
      onEditProps: () => {},
      onDelete: () => {},
      onDuplicate: () => {},
      onWrapInBox: () => {},
      ...({
        onMoveUp: () => {},
        onMoveDown: () => {},
      } as Record<string, unknown>),
    }),
  );

  assert.match(markup, /aria-label="Edit Alert props"/);
  assert.match(markup, /aria-label="Delete Alert"/);
  assert.match(markup, /aria-label="Duplicate Alert"/);
  assert.match(markup, /aria-label="Wrap Alert in Box"/);
  assert.doesNotMatch(markup, /aria-label="Move Alert up"/);
  assert.doesNotMatch(markup, /aria-label="Move Alert down"/);
});

test("MdxComponentNodeFrame omits action buttons when callbacks are not provided", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Alert",
      isVoid: true,
      propsSummary: "",
      previewState: "empty",
    }),
  );

  assert.doesNotMatch(markup, /aria-label="Edit Alert props"/);
  assert.doesNotMatch(markup, /aria-label="Delete Alert"/);
  assert.doesNotMatch(markup, /aria-label="Duplicate Alert"/);
});

test("MdxComponentNodeFrame exposes an inside drop target for structural wrappers", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Callout",
        isVoid: false,
        propsSummary: "",
        previewState: "empty",
        canReceiveChildDrops: true,
      },
      createElement("div", { "data-test-slot": "children" }, "Body"),
    ),
  );

  assert.match(markup, /data-mdcms-visual-drop-target="inside"/);
  assert.match(
    markup,
    /data-mdcms-visual-drop-target="inside"[^>]+class="[^"]*absolute/,
  );
  assert.doesNotMatch(
    markup,
    /data-mdcms-visual-drop-target="inside"[^>]+class="[^"]*mb-2/,
  );
});

test("MdxComponentNodeFrame hides inside drop target for inline wrappers", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Text",
        isVoid: false,
        propsSummary: "",
        previewState: "empty",
        canReceiveChildDrops: false,
      },
      createElement("div", { "data-test-slot": "children" }, "Body"),
    ),
  );

  assert.doesNotMatch(markup, /data-mdcms-visual-drop-target="inside"/);
});

test("MdxComponentNodeFrame applies selected styles when selected", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Banner",
      isVoid: true,
      propsSummary: "",
      selected: true,
      previewState: "empty",
    }),
  );

  assert.match(markup, /border-l-primary bg-accent-subtle/);
});

test("MdxComponentNodeFrame applies unselected styles when not selected", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Banner",
      isVoid: true,
      propsSummary: "",
      selected: false,
      previewState: "empty",
    }),
  );

  assert.match(markup, /border-l-primary\/20/);
  assert.doesNotMatch(markup, /bg-accent-subtle/);
});

test("MdxComponentNodeFrame renders collapse toggle when handler is provided", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Hero",
      isVoid: true,
      propsSummary: 'title="Welcome"',
      previewState: "ready",
      onToggleCollapsed: () => {},
    }),
  );

  assert.match(markup, /aria-label="Collapse Hero"/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /data-mdcms-mdx-component-collapsed="false"/);
});

test("MdxComponentNodeFrame omits collapse toggle when handler is not provided", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Hero",
      isVoid: true,
      propsSummary: "",
      previewState: "ready",
    }),
  );

  assert.doesNotMatch(markup, /aria-label="Collapse Hero"/);
  assert.doesNotMatch(markup, /aria-label="Expand Hero"/);
});

test("MdxComponentNodeFrame collapsed wrapper hides editable content but keeps it mounted", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentNodeFrame,
      {
        componentName: "Hero",
        isVoid: false,
        propsSummary: 'title="Welcome"',
        previewState: "ready",
        collapsed: true,
        onToggleCollapsed: () => {},
        previewSurface: createElement("div", { "data-test-preview": "ready" }),
      },
      createElement("div", { "data-test-slot": "children" }, "Body"),
    ),
  );

  assert.match(markup, /data-mdcms-mdx-component-collapsed="true"/);
  assert.match(markup, /aria-label="Expand Hero"/);
  assert.match(markup, /aria-expanded="false"/);

  // The editable child slot remains in the DOM — ProseMirror tracks the
  // editable region through the live node, so unmounting it on collapse would
  // break re-expansion. Hiding via a `hidden` Tailwind utility on the wrapper
  // is what we expect instead.
  assert.doesNotMatch(markup, /data-test-preview="ready"/);
  assert.match(markup, /data-test-slot="children"/);
  assert.match(markup, /class="hidden"/);

  // The collapsed chip surfaces the props summary inline so users can
  // identify the block without expanding it.
  assert.match(markup, /data-mdcms-mdx-collapsed-props="Hero"/);
  assert.match(markup, /title=&quot;Welcome&quot;/);
});

test("MdxComponentNodeFrame collapsed chip omits props summary when no props are set", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxComponentNodeFrame, {
      componentName: "Spacer",
      isVoid: true,
      propsSummary: "No props set yet",
      previewState: "empty",
      collapsed: true,
      onToggleCollapsed: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-mdx-component-collapsed="true"/);
  assert.doesNotMatch(markup, /data-mdcms-mdx-collapsed-props/);
  assert.doesNotMatch(markup, /No props set yet/);
});
