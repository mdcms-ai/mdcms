import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { RuntimeError, type ActionCatalogItem } from "@mdcms/shared";

import {
  createStudioEmbedConfig,
  createStudioRuntimeContext,
  formatStudioErrorEnvelope,
  prepareStudioConfig,
  resolveStudioEnv,
} from "./studio.js";
import { createStudioActionCatalogAdapter } from "./action-catalog-adapter.js";
import {
  StudioShellFrame,
  describeStudioStartupError,
  resolveShellAppliedTheme,
} from "./studio-component.js";
import { loadStudioDocumentShell } from "./document-shell.js";

const TYPECHECK_TEST_TIMEOUT_MS = 20_000;

function readFetchHeader(
  input: string | URL | Request,
  init: RequestInit | undefined,
  name: string,
): string | null {
  const initHeaders = init?.headers;

  if (initHeaders instanceof Headers) {
    return initHeaders.get(name);
  }

  if (initHeaders && !Array.isArray(initHeaders)) {
    const value = (initHeaders as Record<string, string>)[name];
    if (typeof value === "string") {
      return value;
    }
  }

  if (input instanceof Request) {
    return input.headers.get(name);
  }

  return null;
}

function typecheckSource(source: string) {
  const tempDir = dirname(fileURLToPath(import.meta.url));
  const tempFile = join(
    tempDir,
    `.__studio-config-contract-${randomUUID()}.ts`,
  );

  writeFileSync(tempFile, source, "utf8");

  try {
    const program = ts.createProgram([tempFile], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      customConditions: ["@mdcms/source"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      types: ["node"],
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
      [],
    );
  } finally {
    rmSync(tempFile, { force: true });
  }
}

test("resolveStudioEnv parses core env and applies Studio defaults", () => {
  const env = resolveStudioEnv({
    NODE_ENV: "production",
    LOG_LEVEL: "warn",
    APP_VERSION: "2.0.0",
  } as NodeJS.ProcessEnv);

  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.LOG_LEVEL, "warn");
  assert.equal(env.APP_VERSION, "2.0.0");
  assert.equal(env.STUDIO_NAME, "studio");
});

test("createStudioRuntimeContext wires env and logger", () => {
  const context = createStudioRuntimeContext({
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    APP_VERSION: "2.0.0",
    STUDIO_NAME: "authoring-ui",
  } as NodeJS.ProcessEnv);

  assert.equal(context.env.STUDIO_NAME, "authoring-ui");
  assert.ok(context.logger);
});

test(
  "Studio accepts the authored shared config shape for mdx-aware embedding",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import type { StudioProps } from "../index.ts";

    const props: StudioProps = {
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        contentDirectories: ["content"],
        locales: {
          default: "en",
          supported: ["en"],
        },
        environments: {
          production: {},
          staging: {
            extends: "production",
          },
        },
        types: [],
        components: [
          {
            name: "Chart",
            importPath: "@/components/mdx/Chart",
            load: async () => ({}),
            loadPropsEditor: async () => ({}),
          },
        ],
      },
      basePath: "/admin",
    };

    void props;
  `);
  },
);

test(
  "Studio accepts the minimal server-safe embed config shape",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import type { StudioProps } from "../index.ts";

    const props: StudioProps = {
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
    };

    void props;
  `);
  },
);

test(
  "Studio exports generic custom props editor authoring types",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import type { PropsEditorComponent } from "../index.ts";

    type PricingTableProps = {
      tiers: Array<{ name: string; price: number }>;
    };

    const PricingTableEditor: PropsEditorComponent<PricingTableProps> = ({
      value,
      onChange,
      readOnly,
    }) => {
      // @ts-expect-error value may be partial during initial insertion
      const unsafeTierName: string = value.tiers[0]!.name;
      const tierName: string = value.tiers?.[0]?.name ?? "Starter";
      onChange({
        tiers: [{ name: tierName, price: 10 }],
      });

      if (readOnly) {
        return null;
      }

      void unsafeTierName;
      return null;
    };

    void PricingTableEditor;
  `);
  },
);

test("prepareStudioConfig enriches mdx component metadata from source files", async () => {
  const tempDir = join(
    dirname(fileURLToPath(import.meta.url)),
    `.__studio-prepare-config-${randomUUID()}`,
  );
  const componentFile = join(tempDir, "Chart.tsx");
  const Chart = () => null;
  const loadChart = async () => Chart;

  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    componentFile,
    `
      export interface ChartProps {
        title?: string;
        kind: "bar" | "line";
      }

      export function Chart(_props: ChartProps) {
        return null;
      }
    `,
    "utf8",
  );

  try {
    const preparedConfig = await prepareStudioConfig(
      {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        components: [
          {
            name: "Chart",
            importPath: "@/components/mdx/Chart",
            load: loadChart,
          },
        ],
      },
      {
        cwd: tempDir,
        resolveImportPath: (value) =>
          value === "@/components/mdx/Chart" ? componentFile : value,
      },
    );

    const preparedChart = preparedConfig.components?.find(
      (component) => component.name === "Chart",
    );

    assert.equal(preparedChart?.load, loadChart);
    assert.deepEqual(preparedChart?.extractedProps, {
      title: { type: "string", required: false },
      kind: { type: "enum", required: true, values: ["bar", "line"] },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepareStudioConfig injects built-in mdx components without host registration", async () => {
  const preparedConfig = await prepareStudioConfig(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      cwd: dirname(fileURLToPath(import.meta.url)),
    },
  );

  assert.deepEqual(
    preparedConfig.components
      ?.filter(
        (component) => "builtIn" in component && component.builtIn === true,
      )
      .map((component) => component.name),
    ["Box", "Text", "Image", "Link"],
  );
  assert.deepEqual(preparedConfig.components?.[0], {
    name: "Box",
    importPath: "@mdcms/sdk/react-primitives",
    builtIn: true,
    extractedProps: {
      style: { type: "style", required: false },
      children: { type: "rich-text", required: false },
    },
    load: preparedConfig.components?.[0]?.load,
  });
});

test("prepareStudioConfig rejects host components that use reserved built-in names", async () => {
  await assert.rejects(
    () =>
      prepareStudioConfig(
        {
          project: "marketing-site",
          environment: "staging",
          serverUrl: "http://localhost:4000",
          components: [
            {
              name: "Box",
              importPath: "@/components/mdx/Box",
              builtIn: true,
            },
          ] as never,
        },
        {
          cwd: dirname(fileURLToPath(import.meta.url)),
        },
      ),
    /reserved for an MDCMS built-in component/,
  );
});

test("prepareStudioConfig preserves valid propHints alongside extracted props", async () => {
  const tempDir = join(
    dirname(fileURLToPath(import.meta.url)),
    `.__studio-prepare-config-hints-${randomUUID()}`,
  );
  const componentFile = join(tempDir, "Chart.tsx");

  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    componentFile,
    `
      export interface ChartProps {
        title?: string;
        website?: string;
        kind: "bar" | "line";
      }

      export function Chart(_props: ChartProps) {
        return null;
      }
    `,
    "utf8",
  );

  try {
    const preparedConfig = await prepareStudioConfig(
      {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        components: [
          {
            name: "Chart",
            importPath: "@/components/mdx/Chart",
            propHints: {
              title: { widget: "textarea" },
              website: { format: "url" },
            },
          },
        ],
      },
      {
        cwd: tempDir,
        resolveImportPath: (value) =>
          value === "@/components/mdx/Chart" ? componentFile : value,
      },
    );

    const preparedChart = preparedConfig.components?.find(
      (component) => component.name === "Chart",
    );

    assert.deepEqual(preparedChart?.propHints, {
      title: { widget: "textarea" },
      website: { format: "url" },
    });
    assert.deepEqual(preparedChart?.extractedProps, {
      title: { type: "string", required: false },
      website: { type: "string", required: false, format: "url" },
      kind: { type: "enum", required: true, values: ["bar", "line"] },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepareStudioConfig rejects invalid propHints during local mdx preparation", async () => {
  const tempDir = join(
    dirname(fileURLToPath(import.meta.url)),
    `.__studio-prepare-config-invalid-hints-${randomUUID()}`,
  );
  const componentFile = join(tempDir, "Chart.tsx");

  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    componentFile,
    `
      export interface ChartProps {
        title?: string;
      }

      export function Chart(_props: ChartProps) {
        return null;
      }
    `,
    "utf8",
  );

  try {
    await assert.rejects(
      () =>
        prepareStudioConfig(
          {
            project: "marketing-site",
            environment: "staging",
            serverUrl: "http://localhost:4000",
            components: [
              {
                name: "Chart",
                importPath: "@/components/mdx/Chart",
                propHints: {
                  title: { widget: "slider", min: 0, max: 10 },
                },
              },
            ],
          },
          {
            cwd: tempDir,
            resolveImportPath: (value) =>
              value === "@/components/mdx/Chart" ? componentFile : value,
          },
        ),
      (error) =>
        error instanceof RuntimeError &&
        error.code === "INVALID_CONFIG" &&
        /propHints\.title/.test(error.message),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prepareStudioConfig resolves directory imports through index files", async () => {
  const tempDir = join(
    dirname(fileURLToPath(import.meta.url)),
    `.__studio-prepare-config-index-${randomUUID()}`,
  );
  const componentDir = join(tempDir, "Chart");
  const componentFile = join(componentDir, "index.tsx");

  mkdirSync(componentDir, { recursive: true });
  writeFileSync(
    componentFile,
    `
      export interface ChartProps {
        title: string;
      }

      export function Chart(_props: ChartProps) {
        return null;
      }
    `,
    "utf8",
  );

  try {
    const preparedConfig = await prepareStudioConfig(
      {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
        components: [
          {
            name: "Chart",
            importPath: "./Chart",
          },
        ],
      },
      {
        cwd: tempDir,
      },
    );

    const preparedChart = preparedConfig.components?.find(
      (component) => component.name === "Chart",
    );

    assert.deepEqual(preparedChart?.extractedProps, {
      title: { type: "string", required: true },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("createStudioEmbedConfig strips client-only mdx loader fields", () => {
  const config = createStudioEmbedConfig({
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    components: [
      {
        name: "Chart",
        importPath: "@/components/mdx/Chart",
        load: async () => ({}),
        loadPropsEditor: async () => ({}),
      },
    ],
    types: [
      {
        name: "post",
        directory: "content/posts",
        fields: {
          title: {
            "~standard": {
              version: 1,
              vendor: "test",
              validate: () => ({ value: "title" }),
            },
          },
        },
        extend(overlay) {
          return overlay;
        },
      },
    ],
  });

  assert.deepEqual(config, {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
  });
});

test("createStudioEmbedConfig rejects missing environment values", () => {
  assert.throws(
    () =>
      createStudioEmbedConfig({
        project: "marketing-site",
        serverUrl: "http://localhost:4000",
      }),
    /environment/,
  );
});

test("formatStudioErrorEnvelope keeps RuntimeError code", () => {
  const envelope = formatStudioErrorEnvelope(
    new RuntimeError({
      code: "STUDIO_RUNTIME_ERROR",
      message: "Cannot load studio runtime.",
      statusCode: 500,
    }),
  );

  assert.equal(envelope.status, "error");
  assert.equal(envelope.code, "STUDIO_RUNTIME_ERROR");
  assert.equal(envelope.message, "Cannot load studio runtime.");
});

test("createStudioActionCatalogAdapter lists actions from /api/v1/actions", async () => {
  const adapter = createStudioActionCatalogAdapter("http://localhost", {
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://localhost/api/v1/actions");
      assert.equal(init?.method, "GET");

      const payload: ActionCatalogItem[] = [
        {
          id: "content.list",
          kind: "query",
          method: "GET",
          path: "/api/v1/content",
          permissions: ["content:read"],
        },
      ];

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await adapter.list();

  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "content.list");
});

test("createStudioActionCatalogAdapter resolves detail and validates shape", async () => {
  const adapter = createStudioActionCatalogAdapter("http://localhost", {
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(input),
        "http://localhost/api/v1/actions/content.publish",
      );
      assert.equal(init?.method, "GET");

      return new Response(
        JSON.stringify({
          id: "content.publish",
          kind: "command",
          method: "POST",
          path: "/api/v1/content/:id/publish",
          permissions: ["content:publish"],
        } satisfies ActionCatalogItem),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await adapter.getById("content.publish");
  assert.equal(result.id, "content.publish");
});

test("createStudioActionCatalogAdapter uses credentials for cookie auth", async () => {
  const adapter = createStudioActionCatalogAdapter("http://localhost", {
    auth: { mode: "cookie" },
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://localhost/api/v1/actions");
      assert.equal(init?.credentials, "include");

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await adapter.list();
});

test("createStudioActionCatalogAdapter adds bearer token for token auth", async () => {
  const adapter = createStudioActionCatalogAdapter("http://localhost", {
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), "http://localhost/api/v1/actions");
      assert.equal(
        readFetchHeader(input, init, "authorization"),
        "Bearer mdcms_key_test",
      );

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await adapter.list();
});

test("StudioShellFrame renders deterministic startup metadata", () => {
  const node = StudioShellFrame({
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    basePath: "/admin",
    startupState: "loading",
  });

  assert.equal(typeof node, "object");
  assert.equal(node.props["data-testid"], "mdcms-studio-root");
  assert.equal(node.props["data-mdcms-project"], "marketing-site");
  assert.equal(node.props["data-mdcms-server-url"], "http://localhost:4000");
  assert.equal(node.props["data-mdcms-base-path"], "/admin");
  assert.equal(node.props["data-mdcms-brand"], "MDCMS");
  assert.equal(node.props["data-mdcms-state"], "loading");
});

test("StudioShellFrame renders loading startup message", () => {
  const markup = renderToStaticMarkup(
    StudioShellFrame({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      startupState: "loading",
    }),
  );

  assert.match(markup, /Loading Studio/);
  assert.match(markup, /Fetching and validating the runtime bundle\./);
  assert.match(markup, /mdcms-studio-shell__/);
  assert.match(markup, /<style>/);
  assert.match(markup, /overflow-y:\s*auto/);
  assert.match(markup, /overflow-x:\s*hidden/);
});

test("StudioShellFrame defaults shell theme to light when no theme is provided", () => {
  const node = StudioShellFrame({
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    basePath: "/admin",
    startupState: "loading",
  });

  assert.equal(node.props["data-mdcms-theme"], "light");
});

test("StudioShellFrame applies the caller-provided shell theme", () => {
  const node = StudioShellFrame({
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    basePath: "/admin",
    startupState: "loading",
    shellTheme: "dark",
  });

  assert.equal(node.props["data-mdcms-theme"], "dark");
});

test("StudioShellFrame loading markup embeds a dark-mode palette override", () => {
  const markup = renderToStaticMarkup(
    StudioShellFrame({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      startupState: "loading",
      shellTheme: "dark",
    }),
  );

  assert.match(markup, /\[data-mdcms-theme="dark"\]/);
  assert.match(markup, /data-mdcms-theme="dark"/);
});

test("StudioShellFrame emits a pre-hydration theme script that targets the shell root", () => {
  const markup = renderToStaticMarkup(
    StudioShellFrame({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      startupState: "loading",
    }),
  );

  assert.match(markup, /<script>\(function\(\)\{/);
  assert.match(markup, /mdcms-studio-theme/);
  assert.match(markup, /prefers-color-scheme: dark/);
  assert.match(markup, /setAttribute\("data-mdcms-theme"/);
});

test("resolveShellAppliedTheme returns dark when system prefers dark and no theme is stored", () => {
  assert.equal(
    resolveShellAppliedTheme({
      storedThemeRaw: null,
      systemPrefersDark: true,
    }),
    "dark",
  );
});

test("resolveShellAppliedTheme honours a stored light preference even when system prefers dark", () => {
  assert.equal(
    resolveShellAppliedTheme({
      storedThemeRaw: "light",
      systemPrefersDark: true,
    }),
    "light",
  );
});

test("resolveShellAppliedTheme honours a stored dark preference when system prefers light", () => {
  assert.equal(
    resolveShellAppliedTheme({
      storedThemeRaw: "dark",
      systemPrefersDark: false,
    }),
    "dark",
  );
});

test("resolveShellAppliedTheme treats unknown stored values as system default", () => {
  assert.equal(
    resolveShellAppliedTheme({
      storedThemeRaw: "garbage",
      systemPrefersDark: true,
    }),
    "dark",
  );
});

test("describeStudioStartupError keeps generic cross-origin load failures neutral", () => {
  const viewModel = describeStudioStartupError(
    new RuntimeError({
      code: "STUDIO_BOOTSTRAP_FETCH_FAILED",
      message:
        "Failed to load Studio bootstrap fetch from http://localhost:4000/api/v1/studio/bootstrap.\nLoad failed",
      statusCode: 500,
      details: {
        url: "http://localhost:4000/api/v1/studio/bootstrap",
        browserOrigin: "http://localhost:4173",
        requestedOrigin: "http://localhost:4000",
        isCrossOrigin: true,
        isOriginPolicyFailure: false,
      },
    }),
  );

  assert.equal(viewModel.title, "Studio bundle could not be loaded");
  assert.equal(
    viewModel.summary,
    "The shell could not retrieve the Studio runtime from the configured backend.",
  );
  assert.equal(
    viewModel.note,
    "Studio could not reach the configured backend before startup completed.",
  );
  assert.deepEqual(viewModel.metadata, [
    { label: "Error code", value: "STUDIO_BOOTSTRAP_FETCH_FAILED" },
    { label: "Host origin", value: "http://localhost:4173" },
    { label: "Target origin", value: "http://localhost:4000" },
    {
      label: "Request URL",
      value: "http://localhost:4000/api/v1/studio/bootstrap",
    },
  ]);
});

test("describeStudioStartupError keeps explicit origin-policy failures classified as CORS guidance", () => {
  const viewModel = describeStudioStartupError(
    new RuntimeError({
      code: "STUDIO_BOOTSTRAP_FETCH_FAILED",
      message:
        "Failed to load Studio bootstrap fetch from http://localhost:4000/api/v1/studio/bootstrap.\nThe browser blocked a cross-origin request from http://localhost:4173 to http://localhost:4000.\nCheck CORS or proxy the Studio backend through the host app.",
      statusCode: 500,
      details: {
        url: "http://localhost:4000/api/v1/studio/bootstrap",
        browserOrigin: "http://localhost:4173",
        requestedOrigin: "http://localhost:4000",
        isCrossOrigin: true,
        isOriginPolicyFailure: true,
      },
    }),
  );

  assert.equal(
    viewModel.note,
    "The browser blocked the request before Studio could start.",
  );
});

test("describeStudioStartupError classifies rejected and crashed failures", () => {
  const rejected = describeStudioStartupError(
    new RuntimeError({
      code: "STUDIO_RUNTIME_INTEGRITY_MISMATCH",
      message: "Integrity mismatch.",
      statusCode: 500,
    }),
  );
  const crashed = describeStudioStartupError(
    new RuntimeError({
      code: "INVALID_STUDIO_RUNTIME_CONTRACT",
      message: "remoteStudioModule.mount must return an unmount function.",
      statusCode: 500,
    }),
  );

  assert.equal(rejected.title, "Studio bundle was rejected");
  assert.equal(crashed.title, "Studio bundle crashed during startup");
});

test("describeStudioStartupError classifies disabled and unavailable startup blocks", () => {
  const disabled = describeStudioStartupError(
    new RuntimeError({
      code: "STUDIO_RUNTIME_DISABLED",
      message: "Studio runtime publication is disabled by configuration.",
      statusCode: 503,
    }),
  );
  const unavailable = describeStudioStartupError(
    new RuntimeError({
      code: "STUDIO_RUNTIME_UNAVAILABLE",
      message: "No safe Studio runtime publication is available.",
      statusCode: 503,
    }),
  );

  assert.equal(disabled.title, "Studio startup is disabled");
  assert.match(disabled.summary, /disabled/i);
  assert.equal(unavailable.title, "No safe Studio runtime is available");
  assert.match(unavailable.summary, /safe runtime/i);
});

test("StudioShellFrame renders operator-facing copy for disabled startup", () => {
  const markup = renderToStaticMarkup(
    StudioShellFrame({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      startupState: "error",
      startupError: new RuntimeError({
        code: "STUDIO_RUNTIME_DISABLED",
        message: "Studio runtime publication is disabled by configuration.",
        statusCode: 503,
      }),
    }),
  );

  assert.match(markup, /Studio startup is disabled/);
  assert.match(markup, /operator/i);
});

test("StudioShellFrame renders categorized startup errors with technical details", () => {
  const markup = renderToStaticMarkup(
    StudioShellFrame({
      config: {
        project: "marketing-site",
        environment: "staging",
        serverUrl: "http://localhost:4000",
      },
      basePath: "/admin",
      startupState: "error",
      startupError: new RuntimeError({
        code: "STUDIO_BOOTSTRAP_FETCH_FAILED",
        message:
          "Failed to load Studio bootstrap fetch from http://localhost:4000/api/v1/studio/bootstrap.",
        statusCode: 500,
        details: {
          url: "http://localhost:4000/api/v1/studio/bootstrap",
          browserOrigin: "http://localhost:4173",
          requestedOrigin: "http://localhost:4000",
          isCrossOrigin: true,
        },
      }),
    }),
  );

  assert.match(markup, /Studio bundle could not be loaded/);
  assert.match(
    markup,
    /The shell could not retrieve the Studio runtime from the configured backend\./,
  );
  assert.match(markup, /Technical details/);
  assert.doesNotMatch(markup, /mdcms-studio-shell__content--error/);
  assert.doesNotMatch(markup, /<aside class="mdcms-studio-shell__aside"/);
  assert.match(
    markup,
    /Failed to load Studio bootstrap fetch[\s\S]*Failure metadata[\s\S]*Host origin/,
  );
  assert.match(markup, /Host origin/);
  assert.match(markup, /http:\/\/localhost:4173/);
});

test("loadStudioDocumentShell fetches draft content with scoped headers", async () => {
  const result = await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
    },
    {
      fetcher: async (input, init) => {
        assert.equal(
          String(input),
          "http://localhost:4000/api/v1/content/11111111-1111-4111-8111-111111111111?draft=true",
        );
        assert.equal(
          readFetchHeader(input, init, "x-mdcms-project"),
          "marketing-site",
        );
        assert.equal(
          readFetchHeader(input, init, "x-mdcms-environment"),
          "staging",
        );
        assert.equal(readFetchHeader(input, init, "x-mdcms-locale"), "en");

        return new Response(
          JSON.stringify({
            data: {
              documentId: "11111111-1111-4111-8111-111111111111",
              translationGroupId: "22222222-2222-4222-8222-222222222222",
              project: "marketing-site",
              environment: "staging",
              type: "BlogPost",
              locale: "en",
              path: "blog/launch-notes",
              format: "md",
              isDeleted: false,
              hasUnpublishedChanges: true,
              version: 5,
              publishedVersion: 5,
              draftRevision: 12,
              frontmatter: {},
              body: "# Launch Notes",
              createdBy: "44444444-4444-4444-8444-444444444444",
              createdAt: "2026-03-04T09:00:00.000Z",
              updatedBy: "44444444-4444-4444-8444-444444444444",
              updatedAt: "2026-03-04T10:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    },
  );

  assert.equal(result.state, "ready");
  assert.equal(result.data?.path, "blog/launch-notes");
});

test("loadStudioDocumentShell exposes typed error code for failed responses", async () => {
  const result = await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
    },
    {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            code: "FORBIDDEN",
            message: "Document is outside of allowed scope.",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    },
  );

  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "FORBIDDEN");
  assert.equal(result.errorMessage, "Document is outside of allowed scope.");
});

test("loadStudioDocumentShell maps malformed draft payloads to document load failure", async () => {
  const result = await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
    },
    {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            data: {
              documentId: "11111111-1111-4111-8111-111111111111",
              path: "blog/launch-notes",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    },
  );

  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "DOCUMENT_LOAD_FAILED");
  assert.equal(result.errorMessage, "Failed to load document draft.");
});

test("loadStudioDocumentShell maps code-less draft failures to document load failure", async () => {
  const result = await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
    },
    {
      fetcher: async () =>
        new Response(undefined, {
          status: 500,
        }),
    },
  );

  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "DOCUMENT_LOAD_FAILED");
  assert.equal(result.errorMessage, "Failed to load document draft.");
});

test("loadStudioDocumentShell uses credentials for cookie auth", async () => {
  await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
    },
    {
      auth: { mode: "cookie" },
      fetcher: async (_input, init) =>
        new Response(
          (() => {
            assert.equal(init?.credentials, "include");
            return JSON.stringify({
              data: {
                documentId: "11111111-1111-4111-8111-111111111111",
                translationGroupId: "22222222-2222-4222-8222-222222222222",
                project: "marketing-site",
                environment: "staging",
                type: "BlogPost",
                locale: "en",
                path: "blog/example",
                format: "md",
                isDeleted: false,
                hasUnpublishedChanges: true,
                version: 5,
                publishedVersion: 5,
                draftRevision: 12,
                frontmatter: {},
                body: "# Example",
                createdBy: "44444444-4444-4444-8444-444444444444",
                createdAt: "2026-03-04T09:00:00.000Z",
                updatedAt: "2026-03-04T10:00:00.000Z",
              },
            });
          })(),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    },
  );
});

test("loadStudioDocumentShell adds bearer token for token auth", async () => {
  await loadStudioDocumentShell(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
    },
    {
      auth: { mode: "token", token: "mdcms_key_test" },
      fetcher: async (_input, init) =>
        new Response(
          (() => {
            assert.equal(
              readFetchHeader(_input, init, "authorization"),
              "Bearer mdcms_key_test",
            );
            return JSON.stringify({
              data: {
                documentId: "11111111-1111-4111-8111-111111111111",
                translationGroupId: "22222222-2222-4222-8222-222222222222",
                project: "marketing-site",
                environment: "staging",
                type: "BlogPost",
                locale: "en",
                path: "blog/example",
                format: "md",
                isDeleted: false,
                hasUnpublishedChanges: true,
                version: 5,
                publishedVersion: 5,
                draftRevision: 12,
                frontmatter: {},
                body: "# Example",
                createdBy: "44444444-4444-4444-8444-444444444444",
                createdAt: "2026-03-04T09:00:00.000Z",
                updatedAt: "2026-03-04T10:00:00.000Z",
              },
            });
          })(),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    },
  );
});
