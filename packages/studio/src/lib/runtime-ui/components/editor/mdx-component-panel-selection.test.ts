import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createPublishedMdxComponentSelectionSnapshot,
  hasPublishedMdxComponentSelectionChanged,
} from "./mdx-component-panel-selection.js";

const registeredComponent = {
  name: "Chart",
  description: "Demo chart",
  importPath: "@/components/mdx/Chart",
  extractedProps: {},
  propHints: {},
};

test("does not republish the same MDX selection snapshot", () => {
  const previous = createPublishedMdxComponentSelectionSnapshot({
    selected: {
      kind: "component",
      component: registeredComponent,
      componentName: "Chart",
      isVoid: true,
      props: {
        title: "Revenue",
        data: [1, 2, 3],
      },
      pos: 12,
    },
    readOnly: false,
    forbidden: false,
  });
  const next = createPublishedMdxComponentSelectionSnapshot({
    selected: {
      kind: "component",
      component: registeredComponent,
      componentName: "Chart",
      isVoid: true,
      props: {
        title: "Revenue",
        data: [1, 2, 3],
      },
      pos: 12,
    },
    readOnly: false,
    forbidden: false,
  });

  assert.equal(hasPublishedMdxComponentSelectionChanged(previous, next), false);
});

test("republishes the MDX selection when the snapshot meaningfully changes", () => {
  const previous = createPublishedMdxComponentSelectionSnapshot({
    selected: {
      kind: "component",
      component: registeredComponent,
      componentName: "Chart",
      isVoid: true,
      props: {
        title: "Revenue",
      },
      pos: 12,
    },
    readOnly: false,
    forbidden: false,
  });
  const next = createPublishedMdxComponentSelectionSnapshot({
    selected: {
      kind: "component",
      component: registeredComponent,
      componentName: "Chart",
      isVoid: true,
      props: {
        title: "Forecast",
      },
      pos: 12,
    },
    readOnly: false,
    forbidden: false,
  });

  assert.equal(hasPublishedMdxComponentSelectionChanged(previous, next), true);
});

test("republishes the MDX selection when it is cleared", () => {
  const previous = createPublishedMdxComponentSelectionSnapshot({
    selected: {
      kind: "component",
      component: registeredComponent,
      componentName: "Chart",
      isVoid: true,
      props: {},
      pos: 12,
    },
    readOnly: false,
    forbidden: false,
  });

  assert.equal(hasPublishedMdxComponentSelectionChanged(previous, null), true);
  assert.equal(hasPublishedMdxComponentSelectionChanged(null, null), false);
});
