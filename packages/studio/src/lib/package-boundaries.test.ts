import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const studioPackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const studioRootEntry = join(studioPackageRoot, "src/index.ts");
const studioLoaderEntry = join(studioPackageRoot, "src/lib/studio-loader.ts");
const studioClientConfigEntry = join(
  studioPackageRoot,
  "src/lib/client-config.ts",
);

type BunBuildResult = {
  success: boolean;
  logs?: readonly unknown[];
};

declare const Bun: {
  build(options: {
    entrypoints: string[];
    format: "esm";
    target: "browser";
    splitting: boolean;
    sourcemap: "none";
    minify: boolean;
    write: false;
    external: string[];
  }): Promise<BunBuildResult>;
};

const externalPackages = [
  "@elysiajs/eden",
  "@mdcms/shared",
  "@tiptap/core",
  "@tiptap/markdown",
  "@tiptap/starter-kit",
  "class-variance-authority",
  "clsx",
  "elysia",
  "react",
  "react-dom",
  "react-dom/client",
  "tailwind-merge",
  "zod",
];

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(process.cwd(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildBrowserEntry(
  importPath: string,
  exportedName: string,
): Promise<{
  success: boolean;
  logs: string[];
}> {
  return withTempDir("studio-browser-boundary-", async (directory) => {
    const entryPath = join(directory, "entry.ts");

    await writeFile(
      entryPath,
      [
        `import { ${exportedName} } from ${JSON.stringify(importPath)};`,
        `void ${exportedName};`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await Bun.build({
      entrypoints: [entryPath],
      format: "esm",
      target: "browser",
      splitting: false,
      sourcemap: "none",
      minify: false,
      write: false,
      external: externalPackages,
    });

    return {
      success: result.success,
      logs: (result.logs ?? []).map((log: unknown) =>
        typeof log === "string"
          ? log
          : log && typeof log === "object" && "message" in log
            ? String((log as { message: unknown }).message)
            : JSON.stringify(log),
      ),
    };
  });
}

test("studio package root is a client entry that does not export internal runtime modules", async () => {
  const source = await readFile(studioRootEntry, "utf8");

  assert.match(source, /^"use client";/);
  assert.match(source, /studio-component\.js/);
  assert.doesNotMatch(source, /export \*/);
  assert.doesNotMatch(source, /studio-loader\.js/);
  assert.doesNotMatch(source, /remote-module\.js/);
  assert.doesNotMatch(source, /build-runtime\.js/);
});

test("studio loader remains browser-bundle safe", async () => {
  const result = await buildBrowserEntry(
    studioLoaderEntry,
    "loadStudioRuntime",
  );

  assert.equal(
    result.success,
    true,
    `expected loader browser bundle to succeed, got:\n${result.logs.join("\n")}`,
  );
});

test("studio package root remains browser-bundle safe for host imports", async () => {
  const result = await buildBrowserEntry(studioRootEntry, "Studio");

  assert.equal(
    result.success,
    true,
    `expected studio root browser bundle to succeed, got:\n${result.logs.join("\n")}`,
  );
});

test("studio client config helpers stay free of Node.js and React imports", async () => {
  const result = await buildBrowserEntry(
    studioClientConfigEntry,
    "createStudioClientConfig",
  );
  const source = await readFile(studioClientConfigEntry, "utf8");

  assert.equal(
    result.success,
    true,
    `expected client config browser bundle to succeed, got:\n${result.logs.join("\n")}`,
  );
  assert.doesNotMatch(source, /from "react"/);
  assert.doesNotMatch(source, /from "node:/);
  assert.doesNotMatch(source, /built-in-mdx-components\.js/);
});
