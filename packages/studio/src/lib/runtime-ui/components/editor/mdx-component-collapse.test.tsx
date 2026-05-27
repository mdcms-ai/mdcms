import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MdxComponentCollapseProvider,
  useMdxComponentCollapseSnapshot,
} from "./mdx-component-collapse.js";
import {
  nextMdxComponentCollapseSnapshot,
  toggleMdxComponentCollapseSnapshot,
  type MdxComponentCollapseSnapshot,
} from "./mdx-component-collapse-state.js";

const initialSnapshot: MdxComponentCollapseSnapshot = {
  globalState: null,
  generation: 0,
};

test("nextMdxComponentCollapseSnapshot bumps generation and applies the requested mode", () => {
  const collapsed = nextMdxComponentCollapseSnapshot(
    initialSnapshot,
    "collapsed",
  );
  assert.equal(collapsed.globalState, "collapsed");
  assert.equal(collapsed.generation, 1);

  const expanded = nextMdxComponentCollapseSnapshot(collapsed, "expanded");
  assert.equal(expanded.globalState, "expanded");
  assert.equal(expanded.generation, 2);
});

test("nextMdxComponentCollapseSnapshot bumps generation even when the mode is unchanged", () => {
  // Re-broadcasting the same mode is the contract for "force every node
  // view back into the announced mode" — node views snap their local
  // state on every generation bump, so the generation must change even
  // if the global mode does not.
  const first = nextMdxComponentCollapseSnapshot(initialSnapshot, "collapsed");
  const second = nextMdxComponentCollapseSnapshot(first, "collapsed");

  assert.equal(second.globalState, "collapsed");
  assert.equal(second.generation, 2);
});

test("toggleMdxComponentCollapseSnapshot collapses from the default snapshot", () => {
  const next = toggleMdxComponentCollapseSnapshot(initialSnapshot);
  assert.equal(next.globalState, "collapsed");
  assert.equal(next.generation, 1);
});

test("toggleMdxComponentCollapseSnapshot flips between collapsed and expanded", () => {
  const collapsed = toggleMdxComponentCollapseSnapshot(initialSnapshot);
  const expanded = toggleMdxComponentCollapseSnapshot(collapsed);
  const collapsedAgain = toggleMdxComponentCollapseSnapshot(expanded);

  assert.equal(collapsed.globalState, "collapsed");
  assert.equal(expanded.globalState, "expanded");
  assert.equal(collapsedAgain.globalState, "collapsed");

  // Generation is monotonically increasing across toggles.
  assert.equal(collapsed.generation, 1);
  assert.equal(expanded.generation, 2);
  assert.equal(collapsedAgain.generation, 3);
});

// Mirrors the seeding pattern used by `MdxComponentNodeView` so the
// "consumer mounts after a global broadcast" path is covered without
// having to spin up a full Tiptap editor.
function CollapseConsumerStub(props: { name: string }) {
  const snapshot = useMdxComponentCollapseSnapshot();
  const [collapsed] = useState(() => snapshot.globalState === "collapsed");

  return createElement(
    "div",
    {
      "data-test-consumer": props.name,
      "data-test-collapsed": collapsed ? "true" : "false",
    },
    null,
  );
}

test("a consumer mounted after a 'collapsed' broadcast initializes as collapsed", () => {
  // Reproduces the regression: a brand-new MDX component is inserted while
  // the document is already in "collapse all" mode. The new node view must
  // mount collapsed, not expanded.
  const snapshot: MdxComponentCollapseSnapshot = {
    globalState: "collapsed",
    generation: 1,
  };

  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentCollapseProvider,
      { snapshot },
      createElement(CollapseConsumerStub, { name: "late-mount" }),
    ),
  );

  assert.match(markup, /data-test-consumer="late-mount"/);
  assert.match(markup, /data-test-collapsed="true"/);
});

test("a consumer mounted with no prior broadcast initializes as expanded", () => {
  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentCollapseProvider,
      { snapshot: initialSnapshot },
      createElement(CollapseConsumerStub, { name: "fresh-mount" }),
    ),
  );

  assert.match(markup, /data-test-collapsed="false"/);
});

test("a consumer mounted after an 'expanded' broadcast initializes as expanded", () => {
  const snapshot: MdxComponentCollapseSnapshot = {
    globalState: "expanded",
    generation: 4,
  };

  const markup = renderToStaticMarkup(
    createElement(
      MdxComponentCollapseProvider,
      { snapshot },
      createElement(CollapseConsumerStub, { name: "after-expand" }),
    ),
  );

  assert.match(markup, /data-test-collapsed="false"/);
});
