"use client";

import { useMemo } from "react";
import { Studio } from "@mdcms/studio";
import type { SerializableStudioConfig } from "@mdcms/studio/client-config";

import { createAdminStudioClientConfig } from "./studio-config";

export function AdminStudioClient(props: { config: SerializableStudioConfig }) {
  // The server sends a new props object on every navigation inside /admin.
  // Keying on the serialized value keeps the Studio config stable until the
  // prepared config really changes.
  const configKey = JSON.stringify(props.config);
  const config = useMemo(
    () =>
      createAdminStudioClientConfig(
        JSON.parse(configKey) as SerializableStudioConfig,
      ),
    [configKey],
  );

  return <Studio config={config} basePath="/admin" />;
}
