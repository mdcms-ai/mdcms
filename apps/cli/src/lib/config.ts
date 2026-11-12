import { existsSync } from "node:fs";
import { createJiti } from "jiti";

import {
  RuntimeError,
  parseMdcmsConfig,
  type ParsedMdcmsConfig,
  type ParsedMdcmsTypeDefinition,
} from "@mdcms/shared";

import { resolveCliConfigPath } from "./config-path.js";

export type CliContentTypeConfig = Pick<
  ParsedMdcmsTypeDefinition,
  "name" | "directory" | "localized"
> &
  Partial<Pick<ParsedMdcmsTypeDefinition, "fields" | "referenceFields">>;

export type CliConfig = Pick<
  ParsedMdcmsConfig,
  "serverUrl" | "project" | "environment"
> & {
  contentDirectories?: ParsedMdcmsConfig["contentDirectories"];
  locales?: ParsedMdcmsConfig["locales"];
  types?: CliContentTypeConfig[];
  components?: ParsedMdcmsConfig["components"];
  environments?: ParsedMdcmsConfig["environments"];
  resolvedEnvironments?: ParsedMdcmsConfig["resolvedEnvironments"];
};

export type LoadedCliConfig = CliConfig &
  Pick<
    ParsedMdcmsConfig,
    | "contentDirectories"
    | "locales"
    | "components"
    | "environments"
    | "resolvedEnvironments"
  > & {
    types: CliContentTypeConfig[];
  };

export async function loadCliConfig(options: {
  cwd: string;
  configPath?: string;
}): Promise<{ config: LoadedCliConfig; configPath: string }> {
  const configPath = await resolveCliConfigPath(options);

  if (!existsSync(configPath)) {
    throw new RuntimeError({
      code: "CONFIG_NOT_FOUND",
      message: `Could not find config file at "${configPath}".`,
      statusCode: 404,
      details: {
        configPath,
      },
    });
  }

  let configModule: Record<string, unknown>;
  try {
    // Re-evaluate the config and its local imports on every schema sync.
    // Native import caches dependencies even when the entry URL changes.
    const loader = createJiti(configPath, {
      moduleCache: false,
      fsCache: false,
      tryNative: false,
      interopDefault: false,
    });
    configModule = await loader.import<Record<string, unknown>>(configPath);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "Unknown import error";

    throw new RuntimeError({
      code: "CONFIG_LOAD_FAILED",
      message: `Failed to load config from "${configPath}": ${message}`,
      statusCode: 400,
      details: { configPath, cause: error },
    });
  }

  return {
    config: parseMdcmsConfig(
      configModule.default ?? configModule,
    ) as LoadedCliConfig,
    configPath,
  };
}
