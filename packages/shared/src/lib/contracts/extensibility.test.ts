import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import {
  assertHostBridgeV1,
  assertMdcmsInlineStyle,
  assertMdcmsModulePackage,
  assertModuleManifest,
  assertModuleManifestCompatibility,
  assertRemoteStudioModule,
  assertStudioBootstrapCompatibility,
  assertStudioBootstrapManifest,
  assertStudioBootstrapReadyResponse,
  assertStudioMountContext,
  isModuleManifest,
  isStudioBootstrapManifest,
  isStudioBootstrapReadyResponse,
  type MdcmsModulePackage,
  type ModuleManifest,
  type StudioBootstrapManifest,
  type StudioBootstrapReadyResponse,
} from "./extensibility.js";

const validAction = {
  id: "content.publish",
  kind: "command" as const,
  method: "POST" as const,
  path: "/api/v1/content/publish",
  permissions: ["content:publish"],
};

const validModuleManifest: ModuleManifest = {
  id: "core.content",
  version: "1.0.0",
  apiVersion: "1",
  kind: "core",
  dependsOn: ["core.auth"],
  minCoreVersion: "1.2.0",
  maxCoreVersion: "2.0.0",
};

const validModulePackage: MdcmsModulePackage = {
  manifest: validModuleManifest,
  server: {
    mount: () => {},
    actions: [validAction],
  },
  cli: {
    actionAliases: [{ alias: "publish", actionId: "content.publish" }],
    outputFormatters: [{ actionId: "content.publish", format: () => "ok" }],
    preflightHooks: [{ id: "ensure-auth", run: async () => {} }],
  },
};

const validStudioBootstrapManifest: StudioBootstrapManifest = {
  apiVersion: "1",
  studioVersion: "0.2.0",
  mode: "module",
  entryUrl: "/api/v1/studio/assets/build-1/main.js",
  integritySha256: "sha256-value",
  signature: "signature-value",
  keyId: "key-1",
  buildId: "build-1",
  minStudioPackageVersion: "0.1.0",
  minHostBridgeVersion: "1.0.0",
  expiresAt: "2026-02-24T00:00:00.000Z",
};

const validHostBridge = {
  version: "1" as const,
  resolveComponent: () => null,
  renderMdxPreview: () => () => {},
};

const validStudioBootstrapReadyResponse: StudioBootstrapReadyResponse = {
  data: {
    status: "ready",
    source: "active",
    manifest: validStudioBootstrapManifest,
  },
};

test("assertModuleManifest and assertMdcmsModulePackage accept valid values", () => {
  assert.doesNotThrow(() => assertModuleManifest(validModuleManifest));
  assert.doesNotThrow(() => assertMdcmsModulePackage(validModulePackage));
});

test("assertModuleManifest rejects unknown fields", () => {
  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        unexpected: true,
      }),
    /unknown field\(s\): unexpected/,
  );
});

test("assertMdcmsModulePackage rejects unknown fields", () => {
  assert.throws(
    () =>
      assertMdcmsModulePackage({
        ...validModulePackage,
        extra: true,
      }),
    /unknown field\(s\): extra/,
  );
});

test("assertModuleManifest rejects invalid dependsOn shapes and duplicates", () => {
  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        dependsOn: "core.auth",
      }),
    /dependsOn.*array/,
  );

  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        dependsOn: ["core.auth", "core.auth"],
      }),
    /contains duplicate dependency id/,
  );
});

test("assertModuleManifest rejects blank ids and unsupported apiVersion", () => {
  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        id: "   ",
      }),
    /manifest\.id must be a non-empty string/,
  );

  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        apiVersion: "2",
      }),
    /manifest\.apiVersion must be "1"/,
  );
});

test("assertModuleManifestCompatibility rejects when core version is below minCoreVersion", () => {
  assert.throws(
    () =>
      assertModuleManifestCompatibility(validModuleManifest, {
        coreVersion: "1.1.9",
      }),
    /below manifest\.minCoreVersion/,
  );
});

test("assertModuleManifestCompatibility rejects when core version is above maxCoreVersion", () => {
  assert.throws(
    () =>
      assertModuleManifestCompatibility(validModuleManifest, {
        coreVersion: "2.0.1",
      }),
    /above manifest\.maxCoreVersion/,
  );
});

test("assertModuleManifestCompatibility accepts equal boundary versions", () => {
  const manifest: ModuleManifest = {
    ...validModuleManifest,
    minCoreVersion: "1.5.0",
    maxCoreVersion: "1.5.0",
  };

  assert.doesNotThrow(() =>
    assertModuleManifestCompatibility(manifest, {
      coreVersion: "1.5.0",
    }),
  );
});

test("assertModuleManifestCompatibility rejects apiVersion mismatch", () => {
  assert.throws(
    () =>
      assertModuleManifestCompatibility(validModuleManifest, {
        coreVersion: "1.5.0",
        supportedApiVersion: "2",
      }),
    /is not supported/,
  );
});

test("assertModuleManifest rejects inverted minCoreVersion/maxCoreVersion bounds", () => {
  assert.throws(
    () =>
      assertModuleManifest({
        ...validModuleManifest,
        minCoreVersion: "2.0.0",
        maxCoreVersion: "1.0.0",
      }),
    /minCoreVersion must be less than or equal to/,
  );
});

test("assertStudioBootstrapManifest accepts valid payload", () => {
  assert.doesNotThrow(() =>
    assertStudioBootstrapManifest(validStudioBootstrapManifest),
  );
});

test("assertStudioBootstrapManifest rejects unknown and invalid fields", () => {
  assert.throws(
    () =>
      assertStudioBootstrapManifest({
        ...validStudioBootstrapManifest,
        invalidField: true,
      }),
    /unknown field\(s\): invalidField/,
  );

  assert.throws(
    () =>
      assertStudioBootstrapManifest({
        ...validStudioBootstrapManifest,
        minStudioPackageVersion: "0.1.0-beta.1",
      }),
    /strict x\.y\.z version format/,
  );
});

test("assertStudioBootstrapCompatibility rejects when package and bridge are below minimums", () => {
  assert.throws(
    () =>
      assertStudioBootstrapCompatibility(validStudioBootstrapManifest, {
        studioPackageVersion: "0.0.9",
        hostBridgeVersion: "1.0.0",
      }),
    /below manifest\.minStudioPackageVersion/,
  );

  assert.throws(
    () =>
      assertStudioBootstrapCompatibility(validStudioBootstrapManifest, {
        studioPackageVersion: "0.1.0",
        hostBridgeVersion: "0.9.9",
      }),
    /below manifest\.minHostBridgeVersion/,
  );
});

test("assertStudioBootstrapCompatibility accepts exact minimum versions", () => {
  assert.doesNotThrow(() =>
    assertStudioBootstrapCompatibility(validStudioBootstrapManifest, {
      studioPackageVersion: "0.1.0",
      hostBridgeVersion: "1.0.0",
    }),
  );
});

test("assertStudioBootstrapManifest rejects blank signature and invalid mode", () => {
  assert.throws(
    () =>
      assertStudioBootstrapManifest({
        ...validStudioBootstrapManifest,
        signature: "   ",
      }),
    /studioBootstrapManifest\.signature must be a non-empty string/,
  );

  assert.throws(
    () =>
      assertStudioBootstrapManifest({
        ...validStudioBootstrapManifest,
        mode: "worker",
      }),
    /studioBootstrapManifest\.mode.*module/,
  );
});

test("assertStudioBootstrapReadyResponse accepts valid active and fallback payloads", () => {
  assert.doesNotThrow(() =>
    assertStudioBootstrapReadyResponse(validStudioBootstrapReadyResponse),
  );

  assert.doesNotThrow(() =>
    assertStudioBootstrapReadyResponse({
      data: {
        status: "ready",
        source: "lastKnownGood",
        manifest: validStudioBootstrapManifest,
        recovery: {
          rejectedBuildId: "build-bad",
          rejectionReason: "integrity",
        },
      },
    }),
  );
});

test("assertStudioBootstrapReadyResponse rejects malformed source and recovery reason", () => {
  assert.throws(
    () =>
      assertStudioBootstrapReadyResponse({
        data: {
          status: "ready",
          source: "active",
          manifest: validStudioBootstrapManifest,
          recovery: {
            rejectedBuildId: "build-bad",
            rejectionReason: "integrity",
          },
        },
      } as unknown as StudioBootstrapReadyResponse),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_STUDIO_BOOTSTRAP_RESPONSE" &&
      /recovery/.test(error.message),
  );

  assert.throws(
    () =>
      assertStudioBootstrapReadyResponse({
        data: {
          status: "ready",
          source: "fallback",
          manifest: validStudioBootstrapManifest,
        },
      } as unknown as StudioBootstrapReadyResponse),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_STUDIO_BOOTSTRAP_RESPONSE" &&
      /source/.test(error.message),
  );

  assert.throws(
    () =>
      assertStudioBootstrapReadyResponse({
        data: {
          status: "ready",
          source: "lastKnownGood",
          manifest: validStudioBootstrapManifest,
          recovery: {
            rejectedBuildId: "build-bad",
            rejectionReason: "hash",
          },
        },
      } as unknown as StudioBootstrapReadyResponse),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_STUDIO_BOOTSTRAP_RESPONSE" &&
      /rejectionReason/.test(error.message),
  );
});

test("runtime contract validators cover positive and negative shapes", () => {
  assert.doesNotThrow(() => assertHostBridgeV1(validHostBridge));

  assert.throws(
    () =>
      assertHostBridgeV1({
        ...validHostBridge,
        version: "2",
      }),
    /version must be "1"/,
  );

  assert.doesNotThrow(() =>
    assertStudioMountContext({
      apiBaseUrl: "http://localhost:4000",
      basePath: "/admin",
      auth: { mode: "cookie" },
      hostBridge: validHostBridge,
      documentRoute: {
        project: "marketing-site",
        initialEnvironment: "staging",
        supportedLocales: ["en-US", "fr"],
        writeByEnvironment: {
          production: {
            canWrite: true,
            schemaHash: "production-schema-hash",
          },
          staging: {
            canWrite: true,
            schemaHash: "staging-schema-hash",
          },
        },
        environmentFieldTargets: {
          BlogPost: {
            featured: ["staging"],
          },
        },
        write: {
          canWrite: true,
          schemaHash: "schema-hash",
        },
      },
      mdx: {
        catalog: {
          components: [
            {
              name: "Chart",
              importPath: "@/components/mdx/Chart",
              propHints: {
                website: { format: "url" },
                accent: { widget: "color-picker" },
                body: { widget: "textarea" },
                rating: { widget: "slider", min: 0, max: 10, step: 2 },
                image: { widget: "image" },
                variant: {
                  widget: "select",
                  options: [
                    "primary",
                    { label: "Secondary", value: "secondary" },
                  ],
                },
                hiddenProp: { widget: "hidden" },
                data: { widget: "json" },
              },
            },
          ],
        },
        resolvePropsEditor: async () => null,
      },
    }),
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
      }),
    /basePath/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "token" },
        hostBridge: validHostBridge,
      }),
    /auth\.token must be a non-empty string/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        documentRoute: {
          project: "marketing-site",
          initialEnvironment: "staging",
          write: {
            canWrite: true,
          },
        },
      }),
    /documentRoute\.write\.schemaHash/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
              },
            ],
          },
          resolvePropsEditor: "not-a-function",
        },
      }),
    /mdx\.resolvePropsEditor/,
  );

  assert.doesNotThrow(() =>
    assertRemoteStudioModule({
      mount: () => () => {},
    }),
  );

  assert.throws(
    () =>
      assertRemoteStudioModule({
        mount: "not-a-function",
      }),
    /mount must be a function/,
  );
});

test("assertStudioMountContext accepts supported extracted mdx prop shapes", () => {
  assert.doesNotThrow(() =>
    assertStudioMountContext({
      apiBaseUrl: "http://localhost:4000",
      basePath: "/admin",
      auth: { mode: "cookie" },
      hostBridge: validHostBridge,
      mdx: {
        catalog: {
          components: [
            {
              name: "Chart",
              importPath: "@/components/mdx/Chart",
              extractedProps: {
                title: {
                  type: "string",
                  required: false,
                },
                website: {
                  type: "string",
                  required: false,
                  format: "url",
                },
                count: {
                  type: "number",
                  required: true,
                },
                published: {
                  type: "boolean",
                  required: false,
                },
                kind: {
                  type: "enum",
                  required: true,
                  values: ["bar", "line"],
                },
                data: {
                  type: "array",
                  required: true,
                  items: "number",
                },
                tags: {
                  type: "array",
                  required: false,
                  items: "string",
                },
                options: {
                  type: "json",
                  required: false,
                },
                style: {
                  type: "style",
                  required: false,
                },
                children: {
                  type: "rich-text",
                  required: false,
                },
              },
            },
          ],
        },
        resolvePropsEditor: async () => null,
      },
    }),
  );
});

test("assertStudioMountContext accepts built-in mdx catalog entries", () => {
  assert.doesNotThrow(() =>
    assertStudioMountContext({
      apiBaseUrl: "http://localhost:4000",
      basePath: "/admin",
      auth: { mode: "cookie" },
      hostBridge: validHostBridge,
      mdx: {
        catalog: {
          components: [
            {
              name: "Box",
              importPath: "@mdcms/sdk/react-primitives",
              builtIn: true,
              extractedProps: {
                style: {
                  type: "style",
                  required: false,
                },
              },
            },
          ],
        },
        resolvePropsEditor: async () => null,
      },
    }),
  );
});

test("assertMdcmsInlineStyle accepts flat string and number values", () => {
  assert.doesNotThrow(() =>
    assertMdcmsInlineStyle({
      padding: "24px",
      opacity: 0.8,
      zIndex: 2,
    }),
  );
});

test("assertMdcmsInlineStyle rejects non-flat style values", () => {
  assert.throws(
    () =>
      assertMdcmsInlineStyle({
        padding: "24px",
        hover: { color: "red" },
      }),
    /hover/,
  );

  assert.throws(
    () =>
      assertMdcmsInlineStyle({
        margin: ["1rem"],
      }),
    /margin/,
  );

  assert.throws(
    () =>
      assertMdcmsInlineStyle({
        transform: () => "scale(1)",
      }),
    /transform/,
  );

  assert.throws(() => assertMdcmsInlineStyle("padding: 24px;"), /inlineStyle/);
});

test("assertStudioMountContext rejects invalid extracted mdx prop shapes", () => {
  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  title: {
                    type: "object",
                    required: false,
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /extractedProps/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  data: {
                    type: "array",
                    required: true,
                    items: "boolean",
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /items/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  kind: {
                    type: "enum",
                    required: true,
                    values: [],
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /values/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  publishedAt: {
                    type: "date",
                    required: false,
                    format: "url",
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /format/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  title: {
                    type: "string",
                    required: false,
                    format: "email",
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /format/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                extractedProps: {
                  title: {
                    type: "string",
                    required: false,
                    extra: true,
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /unknown field\(s\): extra/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Box",
                importPath: "@mdcms/sdk/react-primitives",
                builtIn: false,
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /builtIn/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Box",
                importPath: "@mdcms/sdk/react-primitives",
                extractedProps: {
                  style: {
                    type: "style",
                    required: false,
                    values: {},
                  },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /unknown field\(s\): values/,
  );

  assert.throws(
    () =>
      assertStudioMountContext({
        apiBaseUrl: "http://localhost:4000",
        basePath: "/admin",
        auth: { mode: "cookie" },
        hostBridge: validHostBridge,
        mdx: {
          catalog: {
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                propHints: {
                  rating: { widget: "slider", min: 10, max: 10 },
                },
              },
            ],
          },
          resolvePropsEditor: async () => null,
        },
      }),
    /propHints/,
  );
});

test("assertHostBridgeV1 rejects a bridge with unknown extra keys", () => {
  assert.throws(() =>
    assertHostBridgeV1({
      ...validHostBridge,
      onNavigate: () => {},
    }),
  );
});

test("isModuleManifest and isStudioBootstrapManifest return booleans without throwing", () => {
  assert.equal(isModuleManifest(validModuleManifest), true);
  assert.equal(isModuleManifest({}), false);

  assert.equal(isStudioBootstrapManifest(validStudioBootstrapManifest), true);
  assert.equal(isStudioBootstrapManifest({}), false);
  assert.equal(
    isStudioBootstrapReadyResponse(validStudioBootstrapReadyResponse),
    true,
  );
  assert.equal(isStudioBootstrapReadyResponse({}), false);
});
