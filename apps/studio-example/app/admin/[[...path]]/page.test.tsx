import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import { AdminStudioClient } from "../admin-studio-client";
import { resetPreparedAdminStudioConfigCacheForTests } from "../prepared-studio-config-cache";
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

test("admin catch-all page passes a serializable studio config with local MDX metadata", async () => {
  resetPreparedAdminStudioConfigCacheForTests();
  const element = await AdminCatchAllPage();

  assert.equal(element.type, AdminStudioClient);
  assert.deepEqual(
    JSON.parse(JSON.stringify(element.props.config)),
    element.props.config,
  );
  assert.ok(Array.isArray(element.props.config.components));
  assert.equal(typeof element.props.config._schemaHash, "string");

  const components = element.props.config.components as Array<{
    name: string;
    extractedProps?: Record<
      string,
      { type: string; required: boolean; items?: string; values?: string[] }
    >;
  }>;
  const names = components.map((component) => component.name);
  const chart = components.find((component) => component.name === "Chart");
  const callout = components.find((component) => component.name === "Callout");
  const homeHero = components.find(
    (component) => component.name === "HomeHero",
  );
  const customRichTextChildrenComponents = components
    .filter(
      (component) => component.extractedProps?.children?.type === "rich-text",
    )
    .map((component) => component.name);

  assert.deepEqual(names, [
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
  assert.equal(homeHero?.extractedProps?.children, undefined);
  assert.deepEqual(customRichTextChildrenComponents, [
    "Callout",
    "HomeSection",
    "HomeFeatureGrid",
    "HomeFeature",
    "HomeCta",
  ]);
});
