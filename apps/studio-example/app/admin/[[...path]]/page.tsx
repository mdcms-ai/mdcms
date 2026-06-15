import { AdminStudioClient } from "../admin-studio-client";
import { getPreparedAdminStudioConfig } from "../prepared-studio-config-cache";
import { extractPreparedStudioComponentMetadata } from "../studio-config";

export default async function AdminCatchAllPage() {
  const preparedConfig = await getPreparedAdminStudioConfig();

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
