import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  createNamedRuntimeContext,
  formatRuntimeErrorEnvelope,
  resolveNamedRuntimeEnv,
  type MdcmsConfig as SharedMdcmsConfig,
  type MdcmsComponentRegistration,
  type CoreEnv,
  type ErrorEnvelope,
  type MdxExtractedProps,
  type RuntimeContext,
} from "@mdcms/shared";
import { extractMdxComponentProps } from "@mdcms/shared/mdx";
import {
  assertNoBuiltInMdxComponentNames,
  withBuiltInMdxComponents,
} from "./built-in-mdx-components.js";
import {
  resolveStudioDocumentRoutePreparedMetadata,
  resolveStudioDocumentRouteSchemaCapability,
  type StudioDocumentRoutePreparedMetadata,
} from "./document-route-schema.js";

/**
 * Studio runtime helpers align env resolution, logger setup, and error
 * envelope formatting with the shared runtime contracts.
 */
export type StudioEnv = CoreEnv & {
  STUDIO_NAME: string;
};

export type StudioRuntimeContext = RuntimeContext<StudioEnv>;

export type StudioEmbedConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioComponentRegistration = MdcmsComponentRegistration & {
  extractedProps?: MdxExtractedProps;
};

type OptionalStudioClientConfig = Partial<
  Omit<
    SharedMdcmsConfig,
    "project" | "environment" | "serverUrl" | "components"
  >
>;

export type MdcmsConfig = StudioEmbedConfig &
  OptionalStudioClientConfig & {
    components?: StudioComponentRegistration[];
    _schemaHash?: string;
    _documentRouteMetadata?: StudioDocumentRoutePreparedMetadata;
  };

export { resolveStudioDocumentRouteSchemaCapability } from "./document-route-schema.js";
export type { StudioDocumentRouteSchemaCapability } from "./document-route-schema.js";

export type PrepareStudioConfigOptions = {
  cwd: string;
  resolveImportPath?: (
    value: string,
    component: MdcmsComponentRegistration,
  ) => string | Promise<string>;
  tsconfigPath?: string;
};

export function createStudioEmbedConfig(
  config: SharedMdcmsConfig,
): StudioEmbedConfig {
  const environment = readStudioEnvironment(config);

  return {
    project: config.project,
    environment,
    serverUrl: config.serverUrl,
  };
}

export async function prepareStudioConfig(
  config: SharedMdcmsConfig,
  options: PrepareStudioConfigOptions,
): Promise<MdcmsConfig> {
  const environment = readStudioEnvironment(config);
  assertNoBuiltInMdxComponentNames(config.components);
  const components = config.components
    ? await Promise.all(
        config.components.map(async (component) => {
          const filePath = await resolveComponentSourceFile(component, options);
          const extractedProps = extractMdxComponentProps({
            filePath,
            componentName: component.name,
            propHints: component.propHints,
            ...(options.tsconfigPath !== undefined
              ? { tsconfigPath: options.tsconfigPath }
              : {}),
          });

          return {
            ...component,
            ...(Object.keys(extractedProps).length > 0
              ? { extractedProps }
              : {}),
          };
        }),
      )
    : [];

  // Pre-compute the schema hash while the full config (with Zod types,
  // environments, etc.) is available. Client-side code may receive a
  // stripped config where these fields are absent, so embedding the hash
  // here ensures the Studio loader can enable writes without re-deriving.
  const schemaCapability =
    await resolveStudioDocumentRouteSchemaCapability(config);
  let documentRouteMetadata: StudioDocumentRoutePreparedMetadata | undefined;

  try {
    documentRouteMetadata =
      await resolveStudioDocumentRoutePreparedMetadata(config);
  } catch {
    documentRouteMetadata = undefined;
  }

  return {
    ...config,
    environment,
    components: withBuiltInMdxComponents(components),
    ...(schemaCapability.canWrite
      ? { _schemaHash: schemaCapability.schemaHash }
      : {}),
    ...(documentRouteMetadata !== undefined
      ? { _documentRouteMetadata: documentRouteMetadata }
      : {}),
  };
}

function readStudioEnvironment(config: SharedMdcmsConfig): string {
  if (!config.environment || config.environment.trim().length === 0) {
    throw new Error(
      "Studio embed config requires a non-empty environment string.",
    );
  }

  return config.environment.trim();
}

async function resolveComponentSourceFile(
  component: MdcmsComponentRegistration,
  options: PrepareStudioConfigOptions,
): Promise<string> {
  const resolvedImportPath = options.resolveImportPath
    ? await options.resolveImportPath(component.importPath, component)
    : component.importPath;
  const normalizedImportPath = normalizeImportPath(
    resolvedImportPath,
    options.cwd,
  );
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

  for (const candidate of candidates) {
    if (isFilePath(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    [
      `Could not resolve MDX component source for "${component.name}".`,
      `importPath: ${component.importPath}`,
      `cwd: ${options.cwd}`,
      "Pass prepareStudioConfig(..., { resolveImportPath }) when the authored importPath uses workspace aliases.",
    ].join("\n"),
  );
}

function normalizeImportPath(importPath: string, cwd: string): string {
  return isAbsolute(importPath) ? importPath : resolve(cwd, importPath);
}

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveStudioEnv(rawEnv: NodeJS.ProcessEnv): StudioEnv {
  return resolveNamedRuntimeEnv(rawEnv, ({ rawEnv: sourceEnv }) => ({
    STUDIO_NAME: sourceEnv.STUDIO_NAME?.trim() || "studio",
  }));
}

export function createStudioRuntimeContext(
  rawEnv: NodeJS.ProcessEnv = process.env,
): StudioRuntimeContext {
  return createNamedRuntimeContext({
    rawEnv,
    resolveEnv: resolveStudioEnv,
    loggerContext: (env) => ({
      runtime: "studio",
      studioName: env.STUDIO_NAME,
    }),
  });
}

export function formatStudioErrorEnvelope(
  error: unknown,
  requestId?: string,
): ErrorEnvelope {
  return formatRuntimeErrorEnvelope(error, requestId);
}
