import assert from "node:assert/strict";
import { test } from "bun:test";

import { MdxPreviewErrorBoundary } from "./mdx-preview-error-boundary.js";
import { serializePreviewResetKey } from "./runtime-ui/components/editor/mdx-component-node-view.js";

function createBoundary(resetKey: string) {
  const boundary = new MdxPreviewErrorBoundary({
    componentName: "Callout",
    fallback: null,
    resetKey,
  });
  const updates: unknown[] = [];
  boundary.setState = ((state: unknown) => {
    updates.push(state);
  }) as typeof boundary.setState;
  return { boundary, updates };
}

test("a failed preview shows the fallback", () => {
  assert.deepEqual(MdxPreviewErrorBoundary.getDerivedStateFromError(), {
    hasError: true,
  });
});

test("a failed preview retries when the reset key changes", () => {
  const { boundary, updates } = createBoundary("tone=info");
  boundary.state = { hasError: true };

  boundary.componentDidUpdate({
    componentName: "Callout",
    fallback: null,
    resetKey: "tone=",
  });

  assert.deepEqual(updates, [{ hasError: false }]);
});

test("an unchanged reset key or a healthy preview does not reset", () => {
  const failed = createBoundary("same");
  failed.boundary.state = { hasError: true };
  failed.boundary.componentDidUpdate({
    componentName: "Callout",
    fallback: null,
    resetKey: "same",
  });
  assert.deepEqual(failed.updates, []);

  const healthy = createBoundary("next");
  healthy.boundary.componentDidUpdate({
    componentName: "Callout",
    fallback: null,
    resetKey: "previous",
  });
  assert.deepEqual(healthy.updates, []);
});

test("the reset key follows prop values and tolerates unserializable props", () => {
  assert.notEqual(
    serializePreviewResetKey({ tone: "info" }),
    serializePreviewResetKey({ tone: "warning" }),
  );

  const circular: Record<string, unknown> = { tone: "info" };
  circular.self = circular;
  assert.equal(serializePreviewResetKey(circular), "self,tone");
});
