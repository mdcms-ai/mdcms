import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import { AdminStudioClient } from "../admin-studio-client";
import { resolveStudioExampleAppRoot } from "../resolve-studio-example-app-root";
import AdminCatchAllPage from "./page";

test("resolveStudioExampleAppRoot is stable from the workspace root", () => {
  assert.equal(
    resolveStudioExampleAppRoot("/workspace"),
    resolve("/workspace", "apps/studio-example"),
  );
});

test("resolveStudioExampleAppRoot does not duplicate the app path", () => {
  assert.equal(
    resolveStudioExampleAppRoot("/workspace/apps/studio-example"),
    "/workspace/apps/studio-example",
  );
});

test("admin catch-all page prepares studio config with local MDX metadata", async () => {
  const element = await AdminCatchAllPage();

  assert.equal(element.type, AdminStudioClient);
  assert.ok(Array.isArray(element.props.preparedComponents));

  const components = element.props.preparedComponents as Array<{
    name: string;
    extractedProps?: Record<
      string,
      { type: string; required: boolean; items?: string; values?: string[] }
    >;
  }>;
  const names = components.map((component) => component.name);
  const chart = components.find((component) => component.name === "Chart");
  const callout = components.find((component) => component.name === "Callout");

  assert.deepEqual(names, [
    "Box",
    "Text",
    "Image",
    "Link",
    "Chart",
    "Callout",
    "PricingTable",
    "HomeHero",
    "HomeSection",
    "HomeFeatureGrid",
    "HomeFeature",
    "HomeCta",
  ]);
  assert.deepEqual(chart?.extractedProps?.data, {
    type: "array",
    items: "number",
    required: true,
  });
  assert.deepEqual(chart?.extractedProps?.type, {
    type: "enum",
    values: ["bar", "line", "pie"],
    required: true,
  });
  assert.deepEqual(callout?.extractedProps?.children, {
    type: "rich-text",
    required: false,
  });
});
