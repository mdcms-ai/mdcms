import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  STUDIO_RUNTIME_ASSETS_DIRNAME,
  STUDIO_RUNTIME_BOOTSTRAP_DIRNAME,
  buildStudioRuntimeArtifacts,
} from "./build-runtime.js";

const studioPackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const workspaceRoot = resolve(studioPackageRoot, "../..");
const buildRuntimeModuleUrl = pathToFileURL(
  join(studioPackageRoot, "src/lib/build-runtime.ts"),
).href;
const execFileAsync = promisify(execFile);

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

async function runBunJsonScript<T>(input: {
  scriptFile: string;
  cwd: string;
}): Promise<T> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--conditions", "@mdcms/source", input.scriptFile],
    { cwd: input.cwd },
  );
  const [lastLine] = stdout.trim().split(/\r?\n/).slice(-1);
  assert.ok(lastLine, `Expected JSON output from ${input.scriptFile}.`);
  return JSON.parse(lastLine) as T;
}

test("buildStudioRuntimeArtifacts is deterministic for identical source bytes", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDirA = join(directory, "dist-a");
    const outDirB = join(directory, "dist-b");

    await writeFile(sourceFile, "export const marker = 'stable';\n", "utf8");

    const [buildA, buildB] = await Promise.all([
      buildStudioRuntimeArtifacts({
        sourceFile,
        outDir: outDirA,
        studioVersion: "1.2.3",
        mode: "module",
      }),
      buildStudioRuntimeArtifacts({
        sourceFile,
        outDir: outDirB,
        studioVersion: "1.2.3",
        mode: "module",
      }),
    ]);

    assert.equal(buildA.buildId, buildB.buildId);
    assert.equal(buildA.entryFile, buildB.entryFile);
    assert.equal(buildA.integritySha256, buildB.integritySha256);
    assert.equal(buildA.manifest.entryUrl, buildB.manifest.entryUrl);

    const bootstrapA = JSON.parse(
      await readFile(buildA.bootstrapPath, "utf8"),
    ) as {
      buildId: string;
      entryUrl: string;
    };

    assert.equal(
      bootstrapA.entryUrl,
      `/api/v1/studio/assets/${buildA.buildId}/${buildA.entryFile}`,
    );
    assert.equal(bootstrapA.buildId, buildA.buildId);

    const expectedEntryPathA = join(
      outDirA,
      STUDIO_RUNTIME_ASSETS_DIRNAME,
      buildA.buildId,
      buildA.entryFile,
    );
    const expectedBootstrapPathA = join(
      outDirA,
      STUDIO_RUNTIME_BOOTSTRAP_DIRNAME,
      `${buildA.buildId}.json`,
    );

    assert.equal(buildA.entryPath, expectedEntryPathA);
    assert.equal(buildA.bootstrapPath, expectedBootstrapPathA);
  });
});

test("buildStudioRuntimeArtifacts changes buildId and integrity when source changes", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDirA = join(directory, "dist-a");
    const outDirB = join(directory, "dist-b");

    await writeFile(sourceFile, "export const marker = 'v1';\n", "utf8");
    const buildA = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir: outDirA,
      studioVersion: "1.2.3",
      mode: "module",
    });

    await writeFile(sourceFile, "export const marker = 'v2';\n", "utf8");
    const buildB = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir: outDirB,
      studioVersion: "1.2.3",
      mode: "module",
    });

    assert.notEqual(buildA.buildId, buildB.buildId);
    assert.notEqual(buildA.integritySha256, buildB.integritySha256);
  });
});

test("buildStudioRuntimeArtifacts resolves the default project root from the package location", async () => {
  await withTempDir("studio-runtime-cwd-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDir = join(directory, "dist");
    const scriptFile = join(directory, "build-runtime-cwd-check.ts");

    await writeFile(
      sourceFile,
      "export const mount = () => () => {};\n",
      "utf8",
    );
    await writeFile(
      scriptFile,
      [
        `import { readFile } from "node:fs/promises";`,
        `import { buildStudioRuntimeArtifacts } from ${JSON.stringify(
          buildRuntimeModuleUrl,
        )};`,
        "",
        `const outDir = ${JSON.stringify(outDir)};`,
        "const build = await buildStudioRuntimeArtifacts({",
        `  sourceFile: ${JSON.stringify(sourceFile)},`,
        "  outDir,",
        `  studioVersion: "1.2.3",`,
        `  mode: "module",`,
        "});",
        "",
        `const entrySource = await readFile(build.entryPath, "utf8");`,
        `const cssSource = await readFile(build.cssPath, "utf8");`,
        "console.log(JSON.stringify({",
        "  entryInOutDir: build.entryPath.startsWith(`${outDir}/`),",
        "  entryHasContent: entrySource.length > 0,",
        `  cssHasBackground: cssSource.includes(".bg-background"),`,
        "}));",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runBunJsonScript<{
      entryInOutDir?: boolean;
      entryHasContent?: boolean;
      cssHasBackground?: boolean;
    }>({ scriptFile, cwd: directory });

    assert.deepEqual(result, {
      entryInOutDir: true,
      entryHasContent: true,
      cssHasBackground: true,
    });
  });
});

test("buildStudioRuntimeArtifacts writes bundled JavaScript runtime entry", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const helperFile = join(directory, "helper.ts");
    const outDir = join(directory, "dist");

    await writeFile(
      helperFile,
      [
        "export function helperValue(): string {",
        "  return 'bundled-helper';",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      sourceFile,
      [
        "import { helperValue } from './helper.ts';",
        "",
        "export type RuntimeMountContext = { apiBaseUrl: string };",
        "",
        "export function mount(_: unknown, context: RuntimeMountContext): string {",
        "  return `${context.apiBaseUrl}-${helperValue()}`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const build = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir,
      studioVersion: "1.2.3",
      mode: "module",
    });

    const emittedSource = await readFile(build.entryPath, "utf8");
    assert.equal(emittedSource.includes("from './helper"), false);
    await rm(helperFile, { force: true });

    const runtimeModule = (await import(
      pathToFileURL(build.entryPath).href
    )) as {
      mount: (_: unknown, context: { apiBaseUrl: string }) => string;
    };
    assert.equal(
      runtimeModule.mount(null, { apiBaseUrl: "http://example.test" }),
      "http://example.test-bundled-helper",
    );
  });
});

test("buildStudioRuntimeArtifacts inlines production runtime environment", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDir = join(directory, "dist");

    await writeFile(
      sourceFile,
      [
        "export function mount(): string {",
        "  if (process.env.NODE_ENV !== 'production') {",
        "    return 'development-runtime';",
        "  }",
        "",
        "  return 'production-runtime';",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const build = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir,
      studioVersion: "1.2.3",
      mode: "module",
    });

    const emittedSource = await readFile(build.entryPath, "utf8");

    assert.equal(emittedSource.includes("process.env.NODE_ENV"), false);
    assert.equal(emittedSource.includes("development-runtime"), false);
    assert.equal(emittedSource.includes("production-runtime"), true);
  });
});

// Budget for the studio-runtime first-load bundle. Raised from 2.0 MB
// to 2.5 MB when the assistant chat picked up `streamdown` for proper
// markdown rendering (Sonia bullet — chat needs headings, lists, code
// blocks, GFM). Raised to 2.65 MB when real-time collaboration moved
// Yjs and y-protocols into the default document editor runtime. The
// build currently emits one browser module; future runtime splitting
// can move assistant/collaboration surfaces behind dynamic imports.
const STUDIO_RUNTIME_SIZE_BUDGET_BYTES = 2_650_000;

test("buildStudioRuntimeArtifacts keeps the default browser runtime below the first-load size target", async () => {
  await withTempDir("studio-runtime-real-", async (directory) => {
    const outDir = join(directory, "dist");
    const scriptFile = join(directory, "default-runtime-size-check.ts");

    await writeFile(
      scriptFile,
      [
        `import { readFile } from "node:fs/promises";`,
        `import { buildStudioRuntimeArtifacts } from ${JSON.stringify(
          buildRuntimeModuleUrl,
        )};`,
        "",
        "const build = await buildStudioRuntimeArtifacts({",
        `  outDir: ${JSON.stringify(outDir)},`,
        `  studioVersion: "1.2.3",`,
        `  mode: "module",`,
        "});",
        "",
        `const emittedSource = await readFile(build.entryPath, "utf8");`,
        "console.log(JSON.stringify({",
        `  hasTypeScriptRuntime: emittedSource.includes("typescript.js"),`,
        `  hasCreateProgram: emittedSource.includes("createProgram"),`,
        `  underSizeTarget: Buffer.byteLength(emittedSource, "utf8") < ${STUDIO_RUNTIME_SIZE_BUDGET_BYTES},`,
        "}));",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runBunJsonScript<{
      hasTypeScriptRuntime?: boolean;
      hasCreateProgram?: boolean;
      underSizeTarget?: boolean;
    }>({ scriptFile, cwd: workspaceRoot });

    assert.deepEqual(result, {
      hasTypeScriptRuntime: false,
      hasCreateProgram: false,
      underSizeTarget: true,
    });
  });
});

test("buildStudioRuntimeArtifacts forces the bootstrap manifest to module mode", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDir = join(directory, "dist");

    await writeFile(
      sourceFile,
      "export const mount = () => () => {};\n",
      "utf8",
    );

    const build = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir,
      studioVersion: "1.2.3",
      mode: "iframe" as unknown as "module",
    });

    assert.equal(build.manifest.mode, "module");
  });
});

test("buildStudioRuntimeArtifacts emits a stylesheet asset beside the runtime entry", async () => {
  await withTempDir("studio-runtime-", async (directory) => {
    const sourceFile = join(directory, "app.ts");
    const outDir = join(directory, "dist");

    await writeFile(
      sourceFile,
      "export const mount = () => () => {};\n",
      "utf8",
    );

    const build = await buildStudioRuntimeArtifacts({
      sourceFile,
      outDir,
      studioVersion: "1.2.3",
      mode: "module",
    });

    assert.match(build.cssFile, /^studio-runtime\.[a-f0-9]{16}\.css$/);
    assert.equal(
      build.cssPath,
      join(outDir, STUDIO_RUNTIME_ASSETS_DIRNAME, build.buildId, build.cssFile),
    );
    const emittedStylesheet = await readFile(build.cssPath, "utf8");

    assert.equal(emittedStylesheet.length > 0, true);
    assert.equal(emittedStylesheet.includes("@import 'tailwindcss'"), false);
    assert.equal(emittedStylesheet.includes(".bg-background"), true);
  });
});
