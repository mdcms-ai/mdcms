import type { StudioMountContext } from "@mdcms/shared";

export type SchemaPageLoadInput = {
  config: {
    project: string;
    environment: string;
    serverUrl: string;
  };
  auth: StudioMountContext["auth"];
};

/** Maps a StudioMountContext to a schema load input. Exported for tests. */
export function createSchemaPageLoadInput(
  context: StudioMountContext,
): SchemaPageLoadInput | null {
  const route = context.documentRoute;

  if (!route) {
    return null;
  }

  return {
    config: {
      project: route.project,
      environment: route.initialEnvironment,
      serverUrl: context.apiBaseUrl,
    },
    auth: context.auth,
  };
}
