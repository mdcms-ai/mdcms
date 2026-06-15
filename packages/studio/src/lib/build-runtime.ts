import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import tailwindcss from "@tailwindcss/postcss";
import {
  EXTENSIBILITY_API_VERSION,
  assertStudioBootstrapManifest,
  type StudioBootstrapManifest,
  type StudioExecutionMode,
} from "@mdcms/shared";
import postcss from "postcss";

import {
  createDeterministicPlaceholderKeyId,
  createDeterministicPlaceholderSignature,
} from "./runtime-placeholder.js";

type BunBuildResult = {
  success: boolean;
  outputs?: readonly BunBuildOutput[];
  logs?: readonly unknown[];
};

type BunBuildOutput = {
  kind: string;
  path: string;
  text: () => Promise<string>;
};

type BunBuildOnResolveArgs = {
  path: string;
};

type BunBuildOnResolveResult = {
  path: string;
};

type BunBuildPluginBuilder = {
  onResolve: (
    options: { filter: RegExp },
    callback: (
      args: BunBuildOnResolveArgs,
    ) => BunBuildOnResolveResult | undefined,
  ) => void;
};

type BunBuildPlugin = {
  name: string;
  setup: (build: BunBuildPluginBuilder) => void;
};

type BunBuildRuntime = {
  build: (options: {
    entrypoints: string[];
    format: "esm";
    target: "browser";
    splitting: boolean;
    sourcemap: "none";
    minify: boolean;
    write: false;
    define?: Record<string, string>;
    plugins?: BunBuildPlugin[];
  }) => Promise<BunBuildResult>;
};

declare const Bun: BunBuildRuntime;

export const STUDIO_RUNTIME_ASSETS_DIRNAME = "assets";
export const STUDIO_RUNTIME_BOOTSTRAP_DIRNAME = "bootstrap";
export const STUDIO_RUNTIME_LATEST_BOOTSTRAP_FILE = "latest.json";
export const STUDIO_RUNTIME_ENTRY_BASENAME = "studio-runtime";
export const STUDIO_RUNTIME_ENTRY_EXTENSION = ".mjs";
export const STUDIO_RUNTIME_STYLESHEET_EXTENSION = ".css";
export const STUDIO_RUNTIME_DEFAULT_ASSETS_BASE_PATH = "/api/v1/studio/assets";
export const STUDIO_RUNTIME_DEFAULT_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export type BuildStudioRuntimeArtifactsOptions = {
  projectRoot?: string;
  sourceFile?: string;
  outDir?: string;
  assetsBasePath?: string;
  mode?: StudioExecutionMode;
  studioVersion?: string;
  minStudioPackageVersion?: string;
  minHostBridgeVersion?: string;
  expiresAt?: string;
};

export type StudioRuntimeBuildResult = {
  buildId: string;
  entryFile: string;
  entryPath: string;
  cssFile: string;
  cssPath: string;
  entryUrl: string;
  integritySha256: string;
  manifest: StudioBootstrapManifest;
  bootstrapPath: string;
};

function normalizeMode(mode: string | undefined): StudioExecutionMode {
  return "module";
}

function normalizeAssetsBasePath(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return STUDIO_RUNTIME_DEFAULT_ASSETS_BASE_PATH;
  }

  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeAtomicUtf8File(
  path: string,
  content: string,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

export function createStudioRuntimeEntryUrl(input: {
  assetsBasePath: string;
  buildId: string;
  entryFile: string;
}): string {
  const normalizedBasePath = normalizeAssetsBasePath(input.assetsBasePath);
  return `${normalizedBasePath}/${input.buildId}/${input.entryFile}`;
}

function createRuntimeEntryFileName(buildId: string): string {
  return `${STUDIO_RUNTIME_ENTRY_BASENAME}.${buildId}${STUDIO_RUNTIME_ENTRY_EXTENSION}`;
}

function createRuntimeStylesheetFileName(buildId: string): string {
  return `${STUDIO_RUNTIME_ENTRY_BASENAME}.${buildId}${STUDIO_RUNTIME_STYLESHEET_EXTENSION}`;
}

function resolveDefaultStudioProjectRoot(): string {
  // Keep this lazy so importing `@mdcms/studio` in a host app does not
  // evaluate build-only path resolution during module initialization.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function formatBuildErrorDetails(logs: readonly unknown[] | undefined): string {
  if (!logs || logs.length === 0) {
    return "Unknown build error.";
  }

  return logs
    .map((log, index) => {
      if (typeof log === "string") {
        return log;
      }

      if (
        typeof log === "object" &&
        log !== null &&
        "message" in log &&
        typeof (log as { message: unknown }).message === "string"
      ) {
        return (log as { message: string }).message;
      }

      return `log[${index}]`;
    })
    .join("; ");
}

function createWorkspaceSourceAliasPlugin(input: {
  projectRoot: string;
}): BunBuildPlugin {
  const sharedPackageRoot = resolve(input.projectRoot, "../shared");
  const editorCorePackageRoot = resolve(input.projectRoot, "../editor-core");
  const firstPartySourceExports = new Map([
    ["@mdcms/shared", join(sharedPackageRoot, "src/index.ts")],
    ["@mdcms/shared/mdx", join(sharedPackageRoot, "src/lib/mdx/index.ts")],
    [
      "@mdcms/shared/mdx/auto-form",
      join(sharedPackageRoot, "src/lib/mdx/auto-form.ts"),
    ],
    [
      "@mdcms/shared/action-catalog-contract",
      join(sharedPackageRoot, "src/lib/contracts/action-catalog-contract.ts"),
    ],
    [
      "@mdcms/shared/server",
      join(sharedPackageRoot, "src/lib/contracts/schema-hash.ts"),
    ],
    ["@mdcms/editor-core", join(editorCorePackageRoot, "src/index.ts")],
  ]);

  return {
    name: "mdcms-workspace-source-aliases",
    setup(build) {
      build.onResolve(
        { filter: /^@mdcms\/(?:shared|editor-core)(?:\/.*)?$/ },
        (args) => {
          const sourcePath = firstPartySourceExports.get(args.path);

          if (!sourcePath || !existsSync(sourcePath)) {
            return undefined;
          }

          return { path: sourcePath };
        },
      );
    },
  };
}

async function bundleRuntimeEntry(input: {
  sourceFile: string;
  projectRoot: string;
}): Promise<string> {
  const buildResult = await Bun.build({
    entrypoints: [input.sourceFile],
    format: "esm",
    target: "browser",
    splitting: false,
    sourcemap: "none",
    minify: true,
    write: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    // Bun.build does not always resolve workspace packages from CI's
    // node_modules layout, so use local first-party sources when available.
    plugins: [
      createWorkspaceSourceAliasPlugin({
        projectRoot: input.projectRoot,
      }),
    ],
  });

  if (!buildResult.success) {
    throw new Error(
      `Studio runtime bundle failed for ${input.sourceFile}: ${formatBuildErrorDetails(buildResult.logs)}`,
    );
  }

  const entryOutput =
    buildResult.outputs?.find((output) => output.kind === "entry-point") ??
    buildResult.outputs?.[0];

  if (!entryOutput) {
    throw new Error(
      `Studio runtime bundle did not produce output for ${input.sourceFile}.`,
    );
  }

  return await entryOutput.text();
}

type StylesheetCompileResult = {
  css: string;
  /** Absolute source path → output filename for each font asset. */
  fontAssets: Map<string, string>;
};

async function compileRuntimeStylesheet(input: {
  projectRoot: string;
}): Promise<StylesheetCompileResult> {
  const stylesheetSourcePath = join(
    input.projectRoot,
    "src/lib/runtime-ui/styles.css",
  );
  const stylesheetSource = await readFile(stylesheetSourcePath, "utf8");
  const result = await postcss([tailwindcss()]).process(stylesheetSource, {
    from: stylesheetSourcePath,
  });

  const cssDir = dirname(stylesheetSourcePath);
  const fontAssets = new Map<string, string>();
  const seen = new Map<string, string>();

  const rewritten = result.css.replace(
    /url\(([^)]+\.woff2[^)]*)\)/g,
    (_match, rawUrl: string) => {
      const cleanUrl = rawUrl.replace(/['"]/g, "").split("?")[0]!.trim();
      const absPath = isAbsolute(cleanUrl)
        ? cleanUrl
        : resolve(cssDir, cleanUrl);

      if (seen.has(absPath)) {
        return `url(${seen.get(absPath)})`;
      }

      const base = basename(absPath);
      const prefix = sha256Hex(absPath).slice(0, 6);
      const outputName = `${prefix}-${base}`;
      fontAssets.set(absPath, outputName);
      seen.set(absPath, outputName);
      return `url(${outputName})`;
    },
  );

  return { css: rewritten, fontAssets };
}

export async function buildStudioRuntimeArtifacts(
  options: BuildStudioRuntimeArtifactsOptions = {},
): Promise<StudioRuntimeBuildResult> {
  const projectRoot = options.projectRoot ?? resolveDefaultStudioProjectRoot();
  const sourceFile = resolve(
    options.sourceFile ?? join(projectRoot, "src/lib/remote-module.ts"),
  );
  const outDir = options.outDir ?? join(projectRoot, "dist");
  const assetsBasePath = normalizeAssetsBasePath(
    options.assetsBasePath ?? STUDIO_RUNTIME_DEFAULT_ASSETS_BASE_PATH,
  );
  const mode = normalizeMode(options.mode ?? process.env.STUDIO_RUNTIME_MODE);
  const studioVersion =
    options.studioVersion ?? (process.env.APP_VERSION?.trim() || "0.0.0");

  const [bundledEntry, stylesheetResult] = await Promise.all([
    bundleRuntimeEntry({ projectRoot, sourceFile }),
    compileRuntimeStylesheet({ projectRoot }),
  ]);

  const entryBytes = new TextEncoder().encode(bundledEntry);
  const integritySha256 = sha256Hex(entryBytes);

  const buildIdHash = createHash("sha256");
  buildIdHash.update(entryBytes);
  buildIdHash.update(new TextEncoder().encode(stylesheetResult.css));
  const fontAssetBytes = await Promise.all(
    Array.from(stylesheetResult.fontAssets.keys(), (srcPath) =>
      readFile(srcPath),
    ),
  );
  for (const bytes of fontAssetBytes) {
    buildIdHash.update(bytes);
  }
  const buildId = buildIdHash.digest("hex").slice(0, 16);

  const entryFile = createRuntimeEntryFileName(buildId);
  const buildAssetDir = join(outDir, STUDIO_RUNTIME_ASSETS_DIRNAME, buildId);
  const entryPath = join(buildAssetDir, entryFile);
  await mkdir(buildAssetDir, { recursive: true });
  await writeFile(entryPath, bundledEntry, "utf8");

  const cssFile = createRuntimeStylesheetFileName(buildId);
  const cssPath = join(buildAssetDir, cssFile);
  await writeFile(cssPath, stylesheetResult.css, "utf8");

  for (const [srcPath, outputName] of stylesheetResult.fontAssets) {
    await copyFile(srcPath, join(buildAssetDir, outputName));
  }

  const entryUrl = createStudioRuntimeEntryUrl({
    assetsBasePath,
    buildId,
    entryFile,
  });

  const manifest: StudioBootstrapManifest = {
    apiVersion: EXTENSIBILITY_API_VERSION,
    studioVersion,
    mode,
    entryUrl,
    integritySha256,
    signature: createDeterministicPlaceholderSignature(buildId),
    keyId: createDeterministicPlaceholderKeyId(buildId),
    buildId,
    minStudioPackageVersion: options.minStudioPackageVersion ?? "0.0.1",
    minHostBridgeVersion: options.minHostBridgeVersion ?? "1.0.0",
    expiresAt: options.expiresAt ?? STUDIO_RUNTIME_DEFAULT_EXPIRES_AT,
  };

  assertStudioBootstrapManifest(manifest, "studioRuntime.manifest");

  const bootstrapPath = join(
    outDir,
    STUDIO_RUNTIME_BOOTSTRAP_DIRNAME,
    `${buildId}.json`,
  );
  const latestBootstrapPath = join(
    outDir,
    STUDIO_RUNTIME_BOOTSTRAP_DIRNAME,
    STUDIO_RUNTIME_LATEST_BOOTSTRAP_FILE,
  );
  await mkdir(dirname(bootstrapPath), { recursive: true });
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(bootstrapPath, manifestJson, "utf8");
  await writeAtomicUtf8File(latestBootstrapPath, manifestJson);

  return {
    buildId,
    entryFile,
    entryPath,
    cssFile,
    cssPath,
    entryUrl,
    integritySha256,
    manifest,
    bootstrapPath,
  };
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];

  if (!entryPoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}

if (isMainModule()) {
  buildStudioRuntimeArtifacts()
    .then((result) => {
      console.info(
        `[studio-runtime] built ${result.entryFile} (${result.buildId}) -> ${result.bootstrapPath}`,
      );
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`[studio-runtime] build failed: ${message}`);
      process.exitCode = 1;
    });
}
