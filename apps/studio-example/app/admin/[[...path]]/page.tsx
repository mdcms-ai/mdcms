import { resolve } from "node:path";

import { prepareStudioConfig } from "@mdcms/studio/runtime";

import config from "../../../mdcms.config";
import { AdminStudioClient } from "../admin-studio-client";
import { resolveStudioExampleAppRoot } from "../resolve-studio-example-app-root";
import { extractPreparedStudioComponentMetadata } from "../studio-config";

export default async function AdminCatchAllPage() {
  const appRoot = resolveStudioExampleAppRoot();
  const preparedConfig = await prepareStudioConfig(config, {
    cwd: appRoot,
    tsconfigPath: resolve(appRoot, "tsconfig.json"),
  });

  return (
    <AdminStudioClient
      preparedComponents={extractPreparedStudioComponentMetadata(
        preparedConfig,
      )}
      documentRouteMetadata={
        "_documentRouteMetadata" in preparedConfig
          ? preparedConfig._documentRouteMetadata
          : undefined
      }
      schemaHash={
        "_schemaHash" in preparedConfig ? preparedConfig._schemaHash : undefined
      }
    />
  );
}
