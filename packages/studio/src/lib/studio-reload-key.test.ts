import assert from "node:assert/strict";
import { test } from "bun:test";

import type { MdcmsConfig } from "./studio.js";
import {
  createStudioAuthReloadKey,
  createStudioConfigReloadKey,
} from "./studio-reload-key.js";

class FieldSchema {
  constructor(readonly kind: string) {}
}

const titleSchema = new FieldSchema("string");

function buildConfig(overrides: Partial<MdcmsConfig> = {}): MdcmsConfig {
  // Every call returns new objects and new inline functions, the way a host
  // that builds its Studio config during render does.
  return {
    project: "marketing",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    _schemaHash: "hash-1",
    types: [
      {
        name: "post",
        directory: "content/posts",
        fields: { title: titleSchema as never },
        resolvePreviewUrl: (document) => `/posts/${document.path}`,
        extend: (overlay) => overlay,
      },
    ],
    components: [
      {
        name: "Callout",
        importPath: "@/components/Callout",
        extractedProps: {
          tone: { type: "enum", required: false, values: ["info", "warn"] },
        },
        load: () => Promise.resolve(() => null),
      },
    ],
    ...overrides,
  };
}

test("createStudioConfigReloadKey matches for equal configs built as new objects", () => {
  const first = buildConfig();
  const second = buildConfig();

  assert.notEqual(first, second);
  assert.notEqual(first.components?.[0]?.load, second.components?.[0]?.load);
  assert.equal(
    createStudioConfigReloadKey(first),
    createStudioConfigReloadKey(second),
  );
});

test("createStudioConfigReloadKey ignores property order and undefined values", () => {
  const ordered: MdcmsConfig = {
    project: "marketing",
    environment: "staging",
    serverUrl: "http://localhost:4000",
  };
  const reordered: MdcmsConfig = {
    serverUrl: "http://localhost:4000",
    environment: "staging",
    project: "marketing",
    _schemaHash: undefined,
  };

  assert.equal(
    createStudioConfigReloadKey(ordered),
    createStudioConfigReloadKey(reordered),
  );
});

test("createStudioConfigReloadKey changes when a config value changes", () => {
  const base = createStudioConfigReloadKey(buildConfig());

  assert.notEqual(
    createStudioConfigReloadKey(buildConfig({ environment: "production" })),
    base,
  );
  assert.notEqual(
    createStudioConfigReloadKey(buildConfig({ _schemaHash: "hash-2" })),
    base,
  );
  assert.notEqual(
    createStudioConfigReloadKey(
      buildConfig({
        components: [
          {
            name: "Banner",
            importPath: "@/components/Banner",
            load: () => Promise.resolve(() => null),
          },
        ],
      }),
    ),
    base,
  );
  assert.notEqual(
    createStudioConfigReloadKey(
      buildConfig({
        components: [
          {
            name: "Callout",
            importPath: "@/components/callout/Callout",
            load: () => Promise.resolve(() => null),
          },
        ],
      }),
    ),
    base,
  );
});

test("createStudioConfigReloadKey compares non-plain objects such as field schemas by identity", () => {
  const withOtherSchema = buildConfig();
  withOtherSchema.types = [
    {
      ...withOtherSchema.types![0]!,
      fields: { title: new FieldSchema("string") as never },
    },
  ];

  assert.notEqual(
    createStudioConfigReloadKey(withOtherSchema),
    createStudioConfigReloadKey(buildConfig()),
  );
});

test("createStudioConfigReloadKey tracks whether a loader is present", () => {
  const withoutLoader = buildConfig({
    components: [
      {
        name: "Callout",
        importPath: "@/components/Callout",
        extractedProps: {
          tone: { type: "enum", required: false, values: ["info", "warn"] },
        },
      },
    ],
  });

  assert.notEqual(
    createStudioConfigReloadKey(withoutLoader),
    createStudioConfigReloadKey(buildConfig()),
  );
});

test("createStudioAuthReloadKey compares auth by value", () => {
  assert.equal(
    createStudioAuthReloadKey({ mode: "token", token: "abc" }),
    createStudioAuthReloadKey({ mode: "token", token: "abc" }),
  );
  assert.notEqual(
    createStudioAuthReloadKey({ mode: "token", token: "abc" }),
    createStudioAuthReloadKey({ mode: "token", token: "def" }),
  );
  assert.notEqual(
    createStudioAuthReloadKey(undefined),
    createStudioAuthReloadKey({ mode: "cookie" }),
  );
});
