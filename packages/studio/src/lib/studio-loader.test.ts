import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  RuntimeError,
  defineConfig,
  defineType,
  type MdxExtractedProps,
  type HostBridgeV1,
  type StudioBootstrapManifest,
  type StudioBootstrapReadyResponse,
} from "@mdcms/shared";

import { buildStudioRuntimeArtifacts } from "./build-runtime.js";
import { prepareStudioConfig } from "./studio.js";
import {
  isPreparedDocumentRouteMetadata,
  loadStudioRuntime,
  type MdcmsConfig,
} from "./studio-loader.js";

const validHostBridge: HostBridgeV1 = {
  version: "1",
  resolveComponent: () => null,
  renderMdxPreview: () => () => {},
};

const stringSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withLocationOrigin<T>(
  origin: string,
  run: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );

  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      origin,
    },
  });

  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "location", originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "location");
    }
  }
}

async function withGlobalFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "fetch",
  );

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  });

  try {
    return await run();
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "fetch", originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
  }
}

async function createRuntimeFixture(directory: string) {
  const sourceFile = join(directory, "remote.ts");
  const outDir = join(directory, "dist");

  await mkdir(directory, { recursive: true });

  await writeFile(
    sourceFile,
    [
      `export const fixtureMarker = ${JSON.stringify(directory)};`,
      "export const mount = (_container, _ctx) => {",
      "  void fixtureMarker;",
      "  return () => {};",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const build = await buildStudioRuntimeArtifacts({
    sourceFile,
    outDir,
    studioVersion: "1.2.3",
    minStudioPackageVersion: "0.0.1",
    minHostBridgeVersion: "1.0.0",
  });

  return {
    manifest: build.manifest,
    runtimeBytes: await readFile(build.entryPath),
  };
}

function createReadyBootstrapPayload(input: {
  manifest: StudioBootstrapManifest;
  source?: "active" | "lastKnownGood";
  recovery?: {
    rejectedBuildId: string;
    rejectionReason: "integrity" | "signature" | "compatibility";
  };
}): StudioBootstrapReadyResponse {
  if (input.source === "lastKnownGood") {
    return {
      data: {
        status: "ready",
        source: "lastKnownGood",
        manifest: input.manifest,
        recovery: input.recovery,
      },
    };
  }

  return {
    data: {
      status: "ready",
      source: "active",
      manifest: input.manifest,
    },
  };
}

test("loadStudioRuntime fetches bootstrap, verifies runtime, and mounts the remote module", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const fetchLog: string[] = [];
    const container = { textContent: "" };
    const contexts: unknown[] = [];

    const unmount = await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      container,
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);
        fetchLog.push(url);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async (entryUrl) => {
        assert.equal(
          entryUrl,
          "http://localhost:4000" + fixture.manifest.entryUrl,
        );

        return {
          mount: (target: unknown, context: unknown) => {
            assert.equal(target, container);
            contexts.push(context);
            return () => {
              contexts.push("unmounted");
            };
          },
        };
      },
    });

    assert.deepEqual(fetchLog, [
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000" + fixture.manifest.entryUrl,
    ]);
    assert.equal(contexts.length, 1);
    const mountedContext = contexts[0] as {
      apiBaseUrl: string;
      basePath: string;
      auth: { mode: string };
      hostBridge: HostBridgeV1;
      mdx?: {
        catalog: {
          components: Array<{ name: string; builtIn?: true }>;
        };
      };
      documentRoute?: {
        project: string;
        initialEnvironment: string;
        write:
          | {
              canWrite: true;
              schemaHash: string;
            }
          | {
              canWrite: false;
              message: string;
            };
      };
    };

    assert.equal(mountedContext.apiBaseUrl, "http://localhost:4000");
    assert.equal(mountedContext.basePath, "/admin");
    assert.deepEqual(mountedContext.auth, { mode: "cookie" });
    assert.notEqual(mountedContext.hostBridge, validHostBridge);
    assert.notEqual(mountedContext.hostBridge.resolveComponent("Box"), null);
    assert.deepEqual(
      mountedContext.mdx?.catalog.components
        .filter((component) => component.builtIn === true)
        .map((component) => component.name),
      ["Box", "Text", "Image", "Link"],
    );
    assert.deepEqual(mountedContext.documentRoute, {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: false,
        message:
          'Studio writes require a resolved schema for environment "staging".',
      },
    });

    unmount();

    assert.deepEqual(contexts[1], "unmounted");
  });
});

test("loadStudioRuntime forwards document route environment metadata to the remote runtime", async () => {
  await withTempDir("studio-loader-route-metadata-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];

    await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        _schemaHash: "staging-schema-hash",
        _documentRouteMetadata: {
          schemaHashesByEnvironment: {
            production: "production-schema-hash",
            staging: "staging-schema-hash",
          },
          environmentFieldTargets: {
            BlogPost: {
              featured: ["staging"],
            },
          },
        },
      } as MdcmsConfig,
      basePath: "/admin",
      container: {},
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const mountedContext = contexts[0] as {
      documentRoute?: {
        writeByEnvironment?: Record<
          string,
          { canWrite: boolean; schemaHash?: string; message?: string }
        >;
        environmentFieldTargets?: Record<string, Record<string, string[]>>;
      };
    };

    assert.deepEqual(mountedContext.documentRoute?.writeByEnvironment, {
      production: {
        canWrite: true,
        schemaHash: "production-schema-hash",
      },
      staging: {
        canWrite: true,
        schemaHash: "staging-schema-hash",
      },
    });
    assert.deepEqual(mountedContext.documentRoute?.environmentFieldTargets, {
      BlogPost: {
        featured: ["staging"],
      },
    });
  });
});

test("isPreparedDocumentRouteMetadata rejects malformed nested route metadata", () => {
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: "production-schema-hash",
        staging: "staging-schema-hash",
      },
      environmentFieldTargets: {
        BlogPost: {
          featured: ["staging"],
        },
      },
    }),
    true,
  );

  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: " production-schema-hash ",
      },
      environmentFieldTargets: {
        BlogPost: {
          featured: ["production"],
        },
      },
    }),
    false,
  );
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: "production-schema-hash",
      },
      environmentFieldTargets: {
        BlogPost: {
          featured: [],
        },
      },
    }),
    false,
  );
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: ["production-schema-hash"],
      environmentFieldTargets: {
        BlogPost: {
          featured: ["production"],
        },
      },
    }),
    false,
  );
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: "production-schema-hash",
      },
      environmentFieldTargets: [],
    }),
    false,
  );
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: "production-schema-hash",
      },
      environmentFieldTargets: {
        BlogPost: {
          featured: ["staging"],
        },
      },
    }),
    false,
  );
  assert.equal(
    isPreparedDocumentRouteMetadata({
      schemaHashesByEnvironment: {
        production: "production-schema-hash",
      },
      environmentFieldTargets: {
        " BlogPost ": {
          featured: ["production"],
        },
      },
    }),
    false,
  );
});

test("loadStudioRuntime preserves a path-prefixed studio serverUrl for bootstrap and runtime asset fetches", async () => {
  await withTempDir("studio-loader-prefixed-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const fetchLog: string[] = [];
    const container = { textContent: "" };
    const contexts: unknown[] = [];
    const prefixedEntryUrl = "/review-api/editor" + fixture.manifest.entryUrl;

    const unmount = await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000/review-api/editor",
      },
      basePath: "/review/editor/admin",
      container,
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);
        fetchLog.push(url);

        if (
          url ===
          "http://localhost:4000/review-api/editor/api/v1/studio/bootstrap"
        ) {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: {
                  ...fixture.manifest,
                  entryUrl: prefixedEntryUrl,
                },
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + prefixedEntryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async (entryUrl) => {
        assert.equal(entryUrl, "http://localhost:4000" + prefixedEntryUrl);

        return {
          mount: (_target: unknown, context: unknown) => {
            contexts.push(context);
            return () => {};
          },
        };
      },
    });

    assert.deepEqual(fetchLog, [
      "http://localhost:4000/review-api/editor/api/v1/studio/bootstrap",
      "http://localhost:4000" + prefixedEntryUrl,
    ]);
    assert.equal(
      (contexts[0] as { apiBaseUrl: string }).apiBaseUrl,
      "http://localhost:4000/review-api/editor",
    );

    unmount();
  });
});

test("loadStudioRuntime derives a local mdx catalog and editor resolver from config components", async () => {
  await withTempDir("studio-loader-mdx-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];
    const Chart = () => null;
    const ChartEditor = () => null;
    const config: MdcmsConfig = {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
      components: [
        {
          name: "Chart",
          importPath: "@/components/mdx/Chart",
          description: "Render a chart",
          propHints: {
            title: { widget: "textarea" },
          },
          propsEditor: "@/components/mdx/Chart.editor",
          load: async () => Chart,
          loadPropsEditor: async () => ChartEditor,
          extractedProps: {
            title: { type: "string", required: false },
          },
        },
      ],
    };

    await loadStudioRuntime({
      config,
      basePath: "/admin",
      container: {},
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const context = contexts[0] as {
      hostBridge: HostBridgeV1;
      mdx?: {
        catalog: {
          components: Array<{
            name: string;
            importPath: string;
            description?: string;
            propHints?: Record<string, unknown>;
            propsEditor?: string;
            extractedProps?: MdxExtractedProps;
            builtIn?: true;
          }>;
        };
        resolvePropsEditor: (name: string) => Promise<unknown | null>;
      };
    };

    assert.deepEqual(context.mdx?.catalog.components, [
      {
        name: "Box",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
        extractedProps: {
          style: { type: "style", required: false },
          children: { type: "rich-text", required: false },
        },
      },
      {
        name: "Text",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
        extractedProps: {
          style: { type: "style", required: false },
          children: { type: "rich-text", required: false },
        },
      },
      {
        name: "Image",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
        extractedProps: {
          src: { type: "string", required: true },
          alt: { type: "string", required: true },
          style: { type: "style", required: false },
        },
      },
      {
        name: "Link",
        importPath: "@mdcms/sdk/react-primitives",
        builtIn: true,
        extractedProps: {
          href: { type: "string", required: true },
          style: { type: "style", required: false },
          children: { type: "rich-text", required: false },
        },
      },
      {
        name: "Chart",
        importPath: "@/components/mdx/Chart",
        description: "Render a chart",
        propHints: {
          title: { widget: "textarea" },
        },
        propsEditor: "@/components/mdx/Chart.editor",
        extractedProps: {
          title: { type: "string", required: false },
        },
      },
    ]);
    assert.notEqual(context.hostBridge.resolveComponent("Box"), null);
    assert.equal(context.hostBridge.resolveComponent("Chart"), Chart);
    const chartEditorResult = context.mdx?.resolvePropsEditor("Chart");
    assert.ok(chartEditorResult instanceof Promise);
    assert.equal(await chartEditorResult, ChartEditor);
    assert.equal(await context.mdx?.resolvePropsEditor("Missing"), null);
  });
});

test("loadStudioRuntime does not duplicate built-ins from prepared config", async () => {
  await withTempDir("studio-loader-prepared-builtins-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];
    const preparedConfig = await prepareStudioConfig(
      {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      { cwd: directory },
    );

    await loadStudioRuntime({
      config: preparedConfig,
      basePath: "/admin",
      container: {},
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const context = contexts[0] as {
      mdx?: {
        catalog: {
          components: Array<{ name: string; builtIn?: true }>;
        };
      };
    };
    const builtInNames =
      context.mdx?.catalog.components
        .filter((component) => component.builtIn === true)
        .map((component) => component.name) ?? [];

    assert.deepEqual(builtInNames, ["Box", "Text", "Image", "Link"]);
    assert.equal(
      context.mdx?.catalog.components.filter(
        (component) => component.name === "Box",
      ).length,
      1,
    );
  });
});

test("loadStudioRuntime carries supported locales into the document route mount context", async () => {
  await withTempDir("studio-loader-locales-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];

    await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        contentDirectories: [],
        locales: {
          default: "en-US",
          supported: ["en-US", "fr", "de", "ja"],
        },
        environments: {
          production: {},
          staging: {
            extends: "production",
          },
        },
        types: [],
      },
      basePath: "/admin",
      container: {},
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const mountedContext = contexts[0] as {
      documentRoute?: {
        supportedLocales?: string[];
      };
    };

    assert.deepEqual(mountedContext.documentRoute?.supportedLocales, [
      "en-US",
      "fr",
      "de",
      "ja",
    ]);
  });
});

test("loadStudioRuntime swallows expected config validation failures when deriving supported locales", async () => {
  await withTempDir("studio-loader-invalid-locales-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];

    await loadStudioRuntime({
      config: defineConfig({
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        contentDirectories: ["content/blog"],
        types: [
          defineType("BlogPost", {
            directory: "content/blog",
            localized: true,
            fields: {
              title: stringSchema,
            },
          }),
        ],
      }),
      basePath: "/admin",
      container: {},
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const mountedContext = contexts[0] as {
      documentRoute?: {
        supportedLocales?: string[];
      };
    };

    assert.equal(mountedContext.documentRoute?.supportedLocales, undefined);
  });
});

test("loadStudioRuntime rethrows unexpected config parse failures when deriving supported locales", async () => {
  await withTempDir("studio-loader-unexpected-config-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const validTypes = [
      defineType("BlogPost", {
        directory: "content/blog",
        fields: {
          title: stringSchema,
        },
      }),
    ];
    let typeAccessCount = 0;
    const config = {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content/blog"],
      get types() {
        typeAccessCount += 1;

        if (typeAccessCount === 1) {
          return validTypes;
        }

        throw new Error("types getter exploded");
      },
    } as unknown as MdcmsConfig;

    await assert.rejects(
      () =>
        loadStudioRuntime({
          config,
          basePath: "/admin",
          container: {},
          fetcher: async (input) => {
            const url = String(input);

            if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
              return new Response(
                JSON.stringify(
                  createReadyBootstrapPayload({
                    manifest: fixture.manifest,
                  }),
                ),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              );
            }

            if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
              return new Response(new Uint8Array(fixture.runtimeBytes), {
                status: 200,
                headers: {
                  "content-type": "text/javascript; charset=utf-8",
                },
              });
            }

            throw new Error(`Unexpected fetch URL: ${url}`);
          },
          loadRemoteModule: async () => {
            throw new Error("loadRemoteModule should not be called");
          },
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("types getter exploded"),
    );
  });
});

test("loadStudioRuntime resolves props editors lazily and preserves loader rejections", async () => {
  await withTempDir("studio-loader-mdx-lazy-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];
    let propsEditorLoadCount = 0;
    const config: MdcmsConfig = {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
      components: [
        {
          name: "Chart",
          importPath: "@/components/mdx/Chart",
          propsEditor: "@/components/mdx/Chart.editor",
          loadPropsEditor: async () => {
            propsEditorLoadCount += 1;
            throw new Error("props editor import failed");
          },
        },
      ],
    };

    await loadStudioRuntime({
      config,
      basePath: "/admin",
      container: {},
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const context = contexts[0] as {
      mdx?: {
        resolvePropsEditor: (name: string) => Promise<unknown | null>;
      };
    };

    assert.equal(propsEditorLoadCount, 0);
    await assert.rejects(
      () => context.mdx?.resolvePropsEditor("Chart") ?? Promise.resolve(null),
      /props editor import failed/,
    );
    assert.equal(propsEditorLoadCount, 1);
    await assert.rejects(
      () => context.mdx?.resolvePropsEditor("Chart") ?? Promise.resolve(null),
      /props editor import failed/,
    );
    assert.equal(propsEditorLoadCount, 1);
  });
});

test("loadStudioRuntime composes a caller hostBridge with config-derived component resolution", async () => {
  await withTempDir("studio-loader-compose-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const contexts: unknown[] = [];
    const Chart = () => null;
    const Custom = () => null;
    const CustomBox = () => null;
    const customHostBridge: HostBridgeV1 = {
      version: "1",
      resolveComponent: (name) => {
        if (name === "Custom") return Custom;
        if (name === "Box") return CustomBox;
        return null;
      },
      renderMdxPreview: () => () => {},
    };

    await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        components: [
          {
            name: "Chart",
            importPath: "@/components/mdx/Chart",
            load: async () => Chart,
          },
        ],
      },
      basePath: "/admin",
      container: {},
      hostBridge: customHostBridge,
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: (_target: unknown, context: unknown) => {
          contexts.push(context);
          return () => {};
        },
      }),
    });

    const bridge = (contexts[0] as { hostBridge: HostBridgeV1 }).hostBridge;

    assert.equal(bridge.resolveComponent("Custom"), Custom);
    assert.equal(bridge.resolveComponent("Chart"), Chart);
    assert.notEqual(bridge.resolveComponent("Box"), CustomBox);
    assert.notEqual(bridge.resolveComponent("Box"), null);
  });
});

test("loadStudioRuntime fetches the remote runtime while local mdx loaders are still pending", async () => {
  await withTempDir("studio-loader-parallel-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const events: string[] = [];
    let resolveComponentLoad: ((value: unknown) => void) | undefined;
    let resolveRuntimeFetchStarted: (() => void) | undefined;
    const runtimeFetchStarted = new Promise<void>((resolve) => {
      resolveRuntimeFetchStarted = resolve;
    });

    const runtimeLoad = loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        components: [
          {
            name: "Chart",
            importPath: "@/components/mdx/Chart",
            load: async () => {
              events.push("component-load-start");

              return await new Promise<unknown>((resolve) => {
                resolveComponentLoad = resolve;
              });
            },
          },
        ],
      },
      basePath: "/admin",
      container: {},
      fetcher: async (input) => {
        const url = String(input);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          events.push("bootstrap-fetch");

          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          events.push("runtime-fetch");
          resolveRuntimeFetchStarted?.();

          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async () => ({
        mount: () => () => {},
      }),
    });

    await runtimeFetchStarted;
    assert.ok(events.includes("bootstrap-fetch"));
    assert.ok(events.includes("component-load-start"));
    assert.ok(events.includes("runtime-fetch"));

    resolveComponentLoad?.(() => null);
    await runtimeLoad;
  });
});

test("loadStudioRuntime rejects malformed bootstrap payloads", async () => {
  await assert.rejects(() =>
    loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      container: {},
      hostBridge: validHostBridge,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            data: {
              status: "ready",
              source: "active",
              manifest: {
                apiVersion: "1",
                studioVersion: "1.2.3",
                mode: "iframe",
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      loadRemoteModule: async () => {
        throw new Error("should not import remote module");
      },
    }),
  );
});

test("loadStudioRuntime preserves the global fetch binding when no custom fetcher is provided", async () => {
  await withTempDir("studio-loader-global-fetch-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const fetchLog: string[] = [];

    await withGlobalFetch(
      async function brandedFetch(
        this: unknown,
        input: string | URL | Request,
      ): Promise<Response> {
        if (this !== globalThis) {
          throw new TypeError(
            "Can only call Window.fetch on instances of Window",
          );
        }

        const url = String(input);
        fetchLog.push(url);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + fixture.manifest.entryUrl) {
          return new Response(new Uint8Array(fixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      } as typeof fetch,
      async () => {
        const unmount = await loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          loadRemoteModule: async () => ({
            mount: () => () => {},
          }),
        });

        assert.deepEqual(fetchLog, [
          "http://localhost:4000/api/v1/studio/bootstrap",
          "http://localhost:4000" + fixture.manifest.entryUrl,
        ]);

        unmount();
      },
    );
  });
});

test("loadStudioRuntime keeps generic cross-origin bootstrap fetch failures neutral", async () => {
  await withLocationOrigin("http://localhost:4173", async () => {
    await assert.rejects(
      () =>
        loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          fetcher: async () => {
            throw new TypeError("Load failed");
          },
          loadRemoteModule: async () => {
            throw new Error("should not import remote module");
          },
        }),
      (error) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.code, "STUDIO_BOOTSTRAP_FETCH_FAILED");
        assert.match(error.message, /Load failed/);
        assert.doesNotMatch(error.message, /cross-origin request/i);
        assert.doesNotMatch(error.message, /Check CORS or proxy/i);
        assert.equal(error.details?.isCrossOrigin, true);
        assert.equal(error.details?.isOriginPolicyFailure, false);
        return true;
      },
    );
  });
});

test("loadStudioRuntime classifies explicit origin-policy bootstrap fetch failures as CORS guidance", async () => {
  await withLocationOrigin("http://localhost:4173", async () => {
    await assert.rejects(
      () =>
        loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          fetcher: async () => {
            throw new TypeError("Blocked by CORS policy");
          },
          loadRemoteModule: async () => {
            throw new Error("should not import remote module");
          },
        }),
      (error) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.code, "STUDIO_BOOTSTRAP_FETCH_FAILED");
        assert.match(error.message, /cross-origin request/i);
        assert.match(error.message, /localhost:4173/);
        assert.match(error.message, /localhost:4000/);
        assert.match(error.message, /Check CORS or proxy/i);
        assert.equal(error.details?.isCrossOrigin, true);
        assert.equal(error.details?.isOriginPolicyFailure, true);
        return true;
      },
    );
  });
});

test("loadStudioRuntime retries transient bootstrap fetch failures before succeeding", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    const fetchLog: string[] = [];
    let bootstrapAttempts = 0;

    const unmount = await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      container: {},
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);
        fetchLog.push(url);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          bootstrapAttempts += 1;

          if (bootstrapAttempts < 3) {
            throw new TypeError("Load failed");
          }

          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(new Uint8Array(fixture.runtimeBytes), {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
          },
        });
      },
      loadRemoteModule: async () => ({
        mount: () => () => {},
      }),
    });

    assert.equal(bootstrapAttempts, 3);
    assert.deepEqual(fetchLog, [
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000" + fixture.manifest.entryUrl,
    ]);

    unmount();
  });
});

test("loadStudioRuntime rejects integrity mismatches before importing the remote module", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);
    let importCount = 0;

    await assert.rejects(() =>
      loadStudioRuntime({
        config: {
          project: "marketing-site",
          environment: "staging",
          serverUrl: "http://localhost:4000",
        },
        basePath: "/admin",
        container: {},
        hostBridge: validHostBridge,
        fetcher: async (input) => {
          const url = String(input);

          if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
            return new Response(
              JSON.stringify(
                createReadyBootstrapPayload({
                  manifest: fixture.manifest,
                }),
              ),
              {
                status: 200,
                headers: {
                  "content-type": "application/json",
                },
              },
            );
          }

          return new Response(new TextEncoder().encode("tampered-runtime"), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        },
        loadRemoteModule: async () => {
          importCount += 1;
          return {
            mount: () => () => {},
          };
        },
      }),
    );

    assert.equal(importCount, 0);
  });
});

test("loadStudioRuntime surfaces remote mount failures", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const fixture = await createRuntimeFixture(directory);

    await assert.rejects(
      () =>
        loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          fetcher: async (input) => {
            const url = String(input);

            if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
              return new Response(
                JSON.stringify(
                  createReadyBootstrapPayload({
                    manifest: fixture.manifest,
                  }),
                ),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              );
            }

            return new Response(new Uint8Array(fixture.runtimeBytes), {
              status: 200,
              headers: {
                "content-type": "text/javascript; charset=utf-8",
              },
            });
          },
          loadRemoteModule: async () => ({
            mount: () => {
              throw new Error("mount failed");
            },
          }),
        }),
      /mount failed/,
    );
  });
});

test("loadStudioRuntime retries bootstrap once on integrity rejection and mounts the fallback runtime", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const [activeFixture, fallbackFixture] = await Promise.all([
      createRuntimeFixture(join(directory, "active")),
      createRuntimeFixture(join(directory, "fallback")),
    ]);
    const fetchLog: string[] = [];
    const importedUrls: string[] = [];

    const unmount = await loadStudioRuntime({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      container: {},
      hostBridge: validHostBridge,
      fetcher: async (input) => {
        const url = String(input);
        fetchLog.push(url);

        if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: activeFixture.manifest,
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (
          url ===
          "http://localhost:4000/api/v1/studio/bootstrap?rejectedBuildId=" +
            activeFixture.manifest.buildId +
            "&rejectionReason=integrity"
        ) {
          return new Response(
            JSON.stringify(
              createReadyBootstrapPayload({
                manifest: fallbackFixture.manifest,
                source: "lastKnownGood",
                recovery: {
                  rejectedBuildId: activeFixture.manifest.buildId,
                  rejectionReason: "integrity",
                },
              }),
            ),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (url === "http://localhost:4000" + activeFixture.manifest.entryUrl) {
          return new Response(new TextEncoder().encode("tampered-runtime"), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        if (
          url ===
          "http://localhost:4000" + fallbackFixture.manifest.entryUrl
        ) {
          return new Response(new Uint8Array(fallbackFixture.runtimeBytes), {
            status: 200,
            headers: {
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      loadRemoteModule: async (entryUrl) => {
        importedUrls.push(entryUrl);

        return {
          mount: () => () => {},
        };
      },
    });

    assert.deepEqual(fetchLog, [
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000" + activeFixture.manifest.entryUrl,
      "http://localhost:4000/api/v1/studio/bootstrap?rejectedBuildId=" +
        activeFixture.manifest.buildId +
        "&rejectionReason=integrity",
      "http://localhost:4000" + fallbackFixture.manifest.entryUrl,
    ]);
    assert.deepEqual(importedUrls, [
      "http://localhost:4000" + fallbackFixture.manifest.entryUrl,
    ]);

    unmount();
  });
});

test("loadStudioRuntime stops after one retry when the fallback runtime is also rejected", async () => {
  await withTempDir("studio-loader-", async (directory) => {
    const [activeFixture, fallbackFixture] = await Promise.all([
      createRuntimeFixture(join(directory, "active")),
      createRuntimeFixture(join(directory, "fallback")),
    ]);
    const fetchLog: string[] = [];
    let importCount = 0;

    await assert.rejects(
      () =>
        loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          fetcher: async (input) => {
            const url = String(input);
            fetchLog.push(url);

            if (url === "http://localhost:4000/api/v1/studio/bootstrap") {
              return new Response(
                JSON.stringify(
                  createReadyBootstrapPayload({
                    manifest: activeFixture.manifest,
                  }),
                ),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              );
            }

            if (
              url ===
              "http://localhost:4000/api/v1/studio/bootstrap?rejectedBuildId=" +
                activeFixture.manifest.buildId +
                "&rejectionReason=integrity"
            ) {
              return new Response(
                JSON.stringify(
                  createReadyBootstrapPayload({
                    manifest: fallbackFixture.manifest,
                    source: "lastKnownGood",
                    recovery: {
                      rejectedBuildId: activeFixture.manifest.buildId,
                      rejectionReason: "integrity",
                    },
                  }),
                ),
                {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                  },
                },
              );
            }

            return new Response(new TextEncoder().encode("tampered-runtime"), {
              status: 200,
              headers: {
                "content-type": "text/javascript; charset=utf-8",
              },
            });
          },
          loadRemoteModule: async () => {
            importCount += 1;

            return {
              mount: () => () => {},
            };
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.code, "STUDIO_RUNTIME_INTEGRITY_MISMATCH");
        return true;
      },
    );

    assert.equal(importCount, 0);
    assert.deepEqual(fetchLog, [
      "http://localhost:4000/api/v1/studio/bootstrap",
      "http://localhost:4000" + activeFixture.manifest.entryUrl,
      "http://localhost:4000/api/v1/studio/bootstrap?rejectedBuildId=" +
        activeFixture.manifest.buildId +
        "&rejectionReason=integrity",
      "http://localhost:4000" + fallbackFixture.manifest.entryUrl,
    ]);
  });
});

test("loadStudioRuntime surfaces deterministic bootstrap disabled and unavailable errors", async () => {
  for (const code of [
    "STUDIO_RUNTIME_DISABLED",
    "STUDIO_RUNTIME_UNAVAILABLE",
  ] as const) {
    await assert.rejects(
      () =>
        loadStudioRuntime({
          config: {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
          },
          basePath: "/admin",
          container: {},
          hostBridge: validHostBridge,
          fetcher: async () =>
            new Response(
              JSON.stringify({
                status: "error",
                code,
                message: `${code} from bootstrap`,
                timestamp: "2026-03-23T00:00:00.000Z",
              }),
              {
                status: 503,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
          loadRemoteModule: async () => {
            throw new Error("should not import remote module");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.code, code);
        assert.equal(error.message, `${code} from bootstrap`);
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
  }
});
