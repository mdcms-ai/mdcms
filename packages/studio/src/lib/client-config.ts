import type {
  MdcmsComponentRegistration,
  MdcmsLocaleConfig,
  MdcmsPreviewUrlResolver,
  MdxExtractedProps,
} from "@mdcms/shared";

import { isBuiltInMdxComponentName } from "./built-in-mdx-component-names.js";
import type { StudioDocumentRoutePreparedMetadata } from "./document-route-schema.js";
import type { MdcmsConfig, StudioComponentRegistration } from "./studio.js";

/**
 * Helpers for the usual server/client split when embedding Studio:
 *
 * 1. On the server, `prepareStudioConfig(config, { cwd })` (from
 *    `@mdcms/studio/runtime`) computes the schema hash and extracts component
 *    props. `toSerializableStudioConfig(prepared)` keeps only plain values,
 *    which a server component can pass to a client component.
 * 2. In the client component, `createStudioClientConfig(serializable,
 *    { loaders })` attaches the `load` functions (and other executable
 *    callbacks) and returns the config for `<Studio config={...} />`.
 *
 * This module has no Node.js or React dependencies, so both sides can import
 * it from `@mdcms/studio/client-config`.
 */

export type SerializableStudioComponent = {
  name: string;
  importPath: string;
  description?: string;
  propHints?: MdcmsComponentRegistration["propHints"];
  propsEditor?: string;
  extractedProps?: MdxExtractedProps;
};

export type SerializableStudioType = {
  name: string;
  directory?: string;
  localized?: boolean;
};

/**
 * The JSON-serializable part of a prepared Studio config. It holds no Zod
 * schemas and no functions.
 */
export type SerializableStudioConfig = {
  project: string;
  environment: string;
  serverUrl: string;
  contentDirectories?: string[];
  locales?: MdcmsLocaleConfig;
  types?: SerializableStudioType[];
  components: SerializableStudioComponent[];
  _schemaHash?: string;
  _documentRouteMetadata?: StudioDocumentRoutePreparedMetadata;
};

/**
 * Loads a component for Studio previews. It may resolve to the component
 * itself or to its module (for example `() => import("./callout")`); for a
 * module, Studio uses the default export, then the export named like the
 * component.
 */
export type StudioComponentLoader = () => Promise<unknown>;

export type StudioComponentLoaderEntry =
  | StudioComponentLoader
  | {
      load?: StudioComponentLoader;
      loadPropsEditor?: StudioComponentLoader;
    };

export type CreateStudioClientConfigOptions = {
  /**
   * Loaders keyed by component name. A value is either the `load` function
   * or an object with `load` and `loadPropsEditor`. Components without a
   * loader are still listed in Studio and show a placeholder instead of a
   * preview. Names that are not registered components are ignored.
   */
  loaders?: Record<string, StudioComponentLoaderEntry>;
  /**
   * Live preview URL resolvers keyed by content type name. Use the same
   * functions as `resolvePreviewUrl` in `mdcms.config.ts`.
   */
  previewUrlResolvers?: Record<string, MdcmsPreviewUrlResolver>;
};

/**
 * Returns the plain values of a prepared config that Studio needs in the
 * browser. Built-in components are left out because Studio always adds them
 * itself.
 */
export function toSerializableStudioConfig(
  prepared: MdcmsConfig,
): SerializableStudioConfig {
  const components = (prepared.components ?? [])
    .filter((component) => !isBuiltInMdxComponentName(component.name))
    .map(toSerializableComponent);
  const types = prepared.types?.map(
    (type): SerializableStudioType => ({
      name: type.name,
      ...(type.directory !== undefined ? { directory: type.directory } : {}),
      ...(type.localized !== undefined ? { localized: type.localized } : {}),
    }),
  );

  return {
    project: prepared.project,
    environment: prepared.environment,
    serverUrl: prepared.serverUrl,
    ...(prepared.contentDirectories !== undefined
      ? { contentDirectories: [...prepared.contentDirectories] }
      : {}),
    ...(prepared.locales !== undefined
      ? { locales: cloneLocales(prepared.locales) }
      : {}),
    ...(types !== undefined ? { types } : {}),
    components,
    ...(prepared._schemaHash !== undefined
      ? { _schemaHash: prepared._schemaHash }
      : {}),
    ...(prepared._documentRouteMetadata !== undefined
      ? { _documentRouteMetadata: prepared._documentRouteMetadata }
      : {}),
  };
}

/**
 * Builds the config for `<Studio />` from the serializable config and the
 * client-side loaders. The result is a new object on every call; build it
 * once (at module scope, or with `useMemo` keyed by the serializable value)
 * so Studio does not see a new config on every render.
 */
export function createStudioClientConfig(
  serializable: SerializableStudioConfig,
  options: CreateStudioClientConfigOptions = {},
): MdcmsConfig {
  const loaders = options.loaders ?? {};
  const previewUrlResolvers = options.previewUrlResolvers ?? {};

  const components = serializable.components
    .filter((component) => !isBuiltInMdxComponentName(component.name))
    .map((component): StudioComponentRegistration => {
      const entry = Object.hasOwn(loaders, component.name)
        ? loaders[component.name]
        : undefined;
      const load = typeof entry === "function" ? entry : entry?.load;
      const loadPropsEditor =
        typeof entry === "function" ? undefined : entry?.loadPropsEditor;

      return {
        ...toSerializableComponent(component),
        ...(load !== undefined ? { load } : {}),
        ...(loadPropsEditor !== undefined ? { loadPropsEditor } : {}),
      };
    });

  const types = serializable.types?.map((type) => {
    const resolvePreviewUrl = Object.hasOwn(previewUrlResolvers, type.name)
      ? previewUrlResolvers[type.name]
      : undefined;

    // Studio reads only the type name, directory, localization flag and
    // preview resolver in the browser. Field schemas stay on the server.
    return {
      name: type.name,
      ...(type.directory !== undefined ? { directory: type.directory } : {}),
      ...(type.localized !== undefined ? { localized: type.localized } : {}),
      ...(resolvePreviewUrl !== undefined ? { resolvePreviewUrl } : {}),
      fields: {},
      extend(overlay) {
        return overlay;
      },
    } satisfies NonNullable<MdcmsConfig["types"]>[number];
  });

  return {
    project: serializable.project,
    environment: serializable.environment,
    serverUrl: serializable.serverUrl,
    ...(serializable.contentDirectories !== undefined
      ? { contentDirectories: [...serializable.contentDirectories] }
      : {}),
    ...(serializable.locales !== undefined
      ? { locales: cloneLocales(serializable.locales) }
      : {}),
    ...(types !== undefined ? { types } : {}),
    components,
    ...(serializable._schemaHash !== undefined
      ? { _schemaHash: serializable._schemaHash }
      : {}),
    ...(serializable._documentRouteMetadata !== undefined
      ? { _documentRouteMetadata: serializable._documentRouteMetadata }
      : {}),
  };
}

function toSerializableComponent(
  component: SerializableStudioComponent | StudioComponentRegistration,
): SerializableStudioComponent {
  return {
    name: component.name,
    importPath: component.importPath,
    ...(component.description !== undefined
      ? { description: component.description }
      : {}),
    ...(component.propHints !== undefined
      ? { propHints: component.propHints }
      : {}),
    ...(component.propsEditor !== undefined
      ? { propsEditor: component.propsEditor }
      : {}),
    ...(component.extractedProps !== undefined
      ? { extractedProps: component.extractedProps }
      : {}),
  };
}

function cloneLocales(locales: MdcmsLocaleConfig): MdcmsLocaleConfig {
  return {
    default: locales.default,
    supported: [...locales.supported],
    ...(locales.aliases !== undefined
      ? { aliases: { ...locales.aliases } }
      : {}),
  };
}
