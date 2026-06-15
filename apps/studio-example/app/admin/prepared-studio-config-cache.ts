import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { MdcmsConfig } from "@mdcms/studio";
import { prepareStudioConfig } from "@mdcms/studio/runtime";

import config from "../../mdcms.config";
import { resolveStudioExampleAppRoot } from "./resolve-studio-example-app-root";

type PreparedStudioConfig = Awaited<ReturnType<typeof prepareStudioConfig>>;

export type PreparedStudioConfigCacheState<TConfig> = {
  signature?: string;
  value?: Promise<TConfig>;
};

const adminStudioConfigCache: PreparedStudioConfigCacheState<PreparedStudioConfig> =
  {};

function readFileSignature(filePath: string): string {
  try {
    const stat = statSync(filePath);

    return `${filePath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function resolveComponentSourceFileForSignature(
  component: NonNullable<MdcmsConfig["components"]>[number],
  cwd: string,
): string {
  const normalizedImportPath = isAbsolute(component.importPath)
    ? component.importPath
    : resolve(cwd, component.importPath);
  const candidates = [
    normalizedImportPath,
    `${normalizedImportPath}.tsx`,
    `${normalizedImportPath}.ts`,
    `${normalizedImportPath}.jsx`,
    `${normalizedImportPath}.js`,
    resolve(normalizedImportPath, "index.tsx"),
    resolve(normalizedImportPath, "index.ts"),
    resolve(normalizedImportPath, "index.jsx"),
    resolve(normalizedImportPath, "index.js"),
  ];

  return (
    candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? normalizedImportPath
  );
}

export function createPreparedStudioConfigSignature(input: {
  config: MdcmsConfig;
  cwd: string;
  dependencyPaths?: string[];
  tsconfigPath?: string;
}): string {
  const sourceFiles = new Set<string>([
    resolve(input.cwd, "mdcms.config.ts"),
    ...(input.tsconfigPath ? [input.tsconfigPath] : []),
    ...(input.dependencyPaths ?? []).map((dependencyPath) =>
      isAbsolute(dependencyPath)
        ? dependencyPath
        : resolve(input.cwd, dependencyPath),
    ),
  ]);

  for (const component of input.config.components ?? []) {
    sourceFiles.add(
      resolveComponentSourceFileForSignature(component, input.cwd),
    );
  }

  return Array.from(sourceFiles)
    .sort((left, right) => left.localeCompare(right))
    .map(readFileSignature)
    .join("|");
}

export async function loadCachedPreparedStudioConfig<TConfig>(input: {
  cache: PreparedStudioConfigCacheState<TConfig>;
  signature: string;
  prepare: () => Promise<TConfig>;
}): Promise<TConfig> {
  if (input.cache.signature === input.signature && input.cache.value) {
    return input.cache.value;
  }

  const pending = input.prepare();
  input.cache.signature = input.signature;
  input.cache.value = pending;

  try {
    return await pending;
  } catch (error) {
    if (input.cache.value === pending) {
      input.cache.signature = undefined;
      input.cache.value = undefined;
    }

    throw error;
  }
}

export async function getPreparedAdminStudioConfig(): Promise<PreparedStudioConfig> {
  const appRoot = resolveStudioExampleAppRoot();
  const tsconfigPath = resolve(appRoot, "tsconfig.json");
  const signature = createPreparedStudioConfigSignature({
    config,
    cwd: appRoot,
    dependencyPaths: [
      "lib/preview-routing.ts",
      "lib/studio-example-studio-config.ts",
    ],
    tsconfigPath,
  });

  return loadCachedPreparedStudioConfig({
    cache: adminStudioConfigCache,
    signature,
    prepare: () =>
      prepareStudioConfig(config, {
        cwd: appRoot,
        tsconfigPath,
      }),
  });
}

export function resetPreparedAdminStudioConfigCacheForTests(): void {
  adminStudioConfigCache.signature = undefined;
  adminStudioConfigCache.value = undefined;
}
