import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseMdcmsConfig, type ParsedMdcmsConfig } from "@mdcms/shared";

export type LoadServerConfigOptions = {
  cwd?: string;
  configPath?: string;
};

export async function loadServerConfig(
  options: LoadServerConfigOptions = {},
): Promise<{ config: ParsedMdcmsConfig; configPath: string } | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, options.configPath ?? "mdcms.config.ts");

  if (!existsSync(configPath)) {
    return undefined;
  }

  const configModule = await import(
    `${pathToFileURL(configPath).href}?t=${Date.now()}`
  );

  return {
    config: parseMdcmsConfig(configModule.default ?? configModule),
    configPath,
  };
}
