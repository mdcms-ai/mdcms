import assert from "node:assert/strict";
import { test } from "bun:test";

import { resolveMdxComponentExport } from "./mdx-component-export.js";

function Callout() {
  return null;
}

test("a component is used as is", () => {
  assert.equal(resolveMdxComponentExport("Callout", Callout), Callout);

  const memoLike = { $$typeof: Symbol.for("react.memo"), type: Callout };
  assert.equal(resolveMdxComponentExport("Callout", memoLike), memoLike);
});

test("a module resolves to its default export, then the named export", () => {
  assert.equal(
    resolveMdxComponentExport("Callout", { default: Callout }),
    Callout,
  );
  assert.equal(
    resolveMdxComponentExport("Callout", { Callout, Other: () => null }),
    Callout,
  );
});

test("anything else is not a component", () => {
  assert.equal(resolveMdxComponentExport("Callout", undefined), undefined);
  assert.equal(resolveMdxComponentExport("Callout", { Other: 1 }), undefined);
  assert.equal(resolveMdxComponentExport("Callout", "Callout"), undefined);
});
