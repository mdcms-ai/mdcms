import { toSerializableStudioConfig } from "@mdcms/studio/client-config";

import { AdminStudioClient } from "../admin-studio-client";
import { getPreparedAdminStudioConfig } from "../prepared-studio-config-cache";

export default async function AdminCatchAllPage() {
  const preparedConfig = await getPreparedAdminStudioConfig();

  return (
    <AdminStudioClient config={toSerializableStudioConfig(preparedConfig)} />
  );
}
