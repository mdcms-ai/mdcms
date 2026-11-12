import type { MdcmsConfig } from "@mdcms/studio";
import {
  createStudioClientConfig,
  type SerializableStudioConfig,
  type StudioComponentLoaderEntry,
} from "@mdcms/studio/client-config";

import { getPreviewHrefForDocument } from "../../lib/preview-routing";
import {
  studioExampleMdxComponents,
  resolveStudioExampleServerUrl,
} from "../../lib/studio-example-studio-config";

export const studioExampleComponentLoaders: Record<
  string,
  StudioComponentLoaderEntry
> = Object.fromEntries(
  studioExampleMdxComponents.map((component) => [
    component.name,
    {
      load: component.load,
      ...("loadPropsEditor" in component
        ? { loadPropsEditor: component.loadPropsEditor }
        : {}),
    },
  ]),
);

export const studioExamplePreviewUrlResolvers = {
  post: getPreviewHrefForDocument,
  page: getPreviewHrefForDocument,
};

export function createAdminStudioClientConfig(
  serializable: SerializableStudioConfig,
): MdcmsConfig {
  return {
    ...createStudioClientConfig(serializable, {
      loaders: studioExampleComponentLoaders,
      previewUrlResolvers: studioExamplePreviewUrlResolvers,
    }),
    // The browser talks to the server on the hostname it was opened with, so
    // loopback access through 127.0.0.1 stays same-site with the API.
    serverUrl: resolveStudioExampleServerUrl(),
  };
}
