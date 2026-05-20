import { createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  HOST_BRIDGE_VERSION,
  RuntimeError,
  assertRemoteStudioModule,
  assertStudioBootstrapReadyResponse,
  assertStudioMountContext,
  isRuntimeErrorLike,
  parseMdcmsConfig,
  type ErrorEnvelope,
  type HostBridgeV1,
  type MdxComponentCatalog,
  type StudioBootstrapReadyResponse,
  type StudioBootstrapRejectionReason,
  type StudioMountContext,
} from "@mdcms/shared";

import { assertStudioRuntimePublication } from "./bootstrap-verification.js";
import {
  isBuiltInMdxComponentName,
  withBuiltInMdxComponents,
} from "./built-in-mdx-components.js";
import {
  resolveStudioDocumentRouteSchemaCapability,
  resolveStudioDocumentRoutePreparedMetadata,
  type StudioDocumentRoutePreparedMetadata,
} from "./document-route-schema.js";
import type { MdcmsConfig } from "./studio.js";
import {
  normalizeStudioBaseUrl,
  resolveStudioRelativeUrl,
} from "./url-resolution.js";

export const STUDIO_PACKAGE_VERSION = "0.0.1";
export const STUDIO_HOST_BRIDGE_COMPATIBILITY_VERSION = "1.0.0";
export type { MdcmsConfig } from "./studio.js";

export type StudioLoaderOptions = {
  config: MdcmsConfig;
  basePath: string;
  container: unknown;
  auth?: StudioMountContext["auth"];
  hostBridge?: HostBridgeV1;
  fetcher?: typeof fetch;
  loadRemoteModule?: (entryUrl: string) => Promise<unknown>;
};

type StudioBootstrapRetryContext = {
  rejectedBuildId: string;
  rejectionReason: StudioBootstrapRejectionReason;
};

type LoadedLocalMdxRuntime = {
  hostBridge: HostBridgeV1;
  mdx: StudioMountContext["mdx"];
};

type LocalMdxPreviewMap = Map<string, unknown>;
type LocalMdxPropsEditorLoaderMap = Map<string, () => Promise<unknown>>;
type LocalMdxPropsEditorResultCache = Map<string, Promise<unknown | null>>;
const BOOTSTRAP_FETCH_RETRY_DELAYS_MS = [50, 150] as const;

function normalizeBaseUrl(serverUrl: string): string {
  return normalizeStudioBaseUrl(serverUrl);
}

function resolveUrl(pathOrUrl: string, apiBaseUrl: string): string {
  return new URL(pathOrUrl, `${apiBaseUrl}/`).href;
}

function resolveBootstrapUrl(
  apiBaseUrl: string,
  retry?: StudioBootstrapRetryContext,
): string {
  const url = resolveStudioRelativeUrl("api/v1/studio/bootstrap", apiBaseUrl);

  if (retry) {
    url.searchParams.set("rejectedBuildId", retry.rejectedBuildId);
    url.searchParams.set("rejectionReason", retry.rejectionReason);
  }

  return url.href;
}

function createDefaultHostBridge(): HostBridgeV1 {
  return {
    version: HOST_BRIDGE_VERSION,
    resolveComponent: () => null,
    renderMdxPreview: () => () => {},
  };
}

function createLoadedHostBridge(
  previewComponents: LocalMdxPreviewMap,
): HostBridgeV1 {
  return {
    version: HOST_BRIDGE_VERSION,
    resolveComponent: (name) => previewComponents.get(name) ?? null,
    renderMdxPreview: (input) => {
      if (!(input.container instanceof HTMLElement)) {
        return () => {};
      }

      const Component = previewComponents.get(input.componentName);

      if (!Component) {
        return () => {};
      }

      const root = createRoot(input.container);
      root.render(
        createElement(Component as never, { ...input.props, key: input.key }),
      );

      return () => {
        root.unmount();
      };
    },
  };
}

function hasResolvedComponent(bridge: HostBridgeV1, name: string): boolean {
  const resolved = bridge.resolveComponent(name);

  return resolved !== null && resolved !== undefined;
}

function composeHostBridges(input: {
  primary: HostBridgeV1;
  fallback: HostBridgeV1;
}): HostBridgeV1 {
  return {
    version: HOST_BRIDGE_VERSION,
    resolveComponent: (name) =>
      isBuiltInMdxComponentName(name)
        ? (input.fallback.resolveComponent(name) ??
          input.primary.resolveComponent(name))
        : (input.primary.resolveComponent(name) ??
          input.fallback.resolveComponent(name)),
    renderMdxPreview: (previewInput) => {
      if (
        isBuiltInMdxComponentName(previewInput.componentName) &&
        hasResolvedComponent(input.fallback, previewInput.componentName)
      ) {
        return input.fallback.renderMdxPreview(previewInput);
      }

      if (hasResolvedComponent(input.primary, previewInput.componentName)) {
        return input.primary.renderMdxPreview(previewInput);
      }

      if (hasResolvedComponent(input.fallback, previewInput.componentName)) {
        return input.fallback.renderMdxPreview(previewInput);
      }

      return input.primary.renderMdxPreview(previewInput);
    },
  };
}

async function createLoadedLocalMdxRuntime(
  config: MdcmsConfig,
): Promise<LoadedLocalMdxRuntime | undefined> {
  const components = withBuiltInMdxComponents(config.components ?? []);

  const previewComponents: LocalMdxPreviewMap = new Map();
  const propsEditorLoaders: LocalMdxPropsEditorLoaderMap = new Map();
  const propsEditorResults: LocalMdxPropsEditorResultCache = new Map();

  await Promise.all(
    components.map(async (component) => {
      const previewResult = await Promise.allSettled([component.load?.()]);

      if (previewResult[0]?.status === "fulfilled" && previewResult[0].value) {
        previewComponents.set(component.name, previewResult[0].value);
      }

      if (component.loadPropsEditor) {
        propsEditorLoaders.set(component.name, component.loadPropsEditor);
      }
    }),
  );

  const catalog: MdxComponentCatalog = {
    components: components.map((component) => {
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
        ...("builtIn" in component && component.builtIn === true
          ? { builtIn: true as const }
          : {}),
      };
    }),
  };

  return {
    hostBridge: createLoadedHostBridge(previewComponents),
    mdx: {
      catalog,
      resolvePropsEditor: async (name) => {
        const existingResult = propsEditorResults.get(name);

        if (existingResult) {
          return existingResult;
        }

        const loadPropsEditor = propsEditorLoaders.get(name);

        if (!loadPropsEditor) {
          return null;
        }

        const loadResult = (async () => {
          const resolvedEditor = await loadPropsEditor();

          return resolvedEditor ?? null;
        })();

        propsEditorResults.set(name, loadResult);

        return loadResult;
      },
    },
  };
}

function readTrimmedConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyTrimmedString);
}

/** Validates precomputed route metadata before it reaches the mount contract. */
export function isPreparedDocumentRouteMetadata(
  value: unknown,
): value is StudioDocumentRoutePreparedMetadata {
  if (!isRecord(value) || !isRecord(value.schemaHashesByEnvironment)) {
    return false;
  }

  const schemaEntries = Object.entries(value.schemaHashesByEnvironment);
  if (
    schemaEntries.length === 0 ||
    !schemaEntries.every(
      ([environment, schemaHash]) =>
        isNonEmptyTrimmedString(environment) &&
        isNonEmptyTrimmedString(schemaHash),
    )
  ) {
    return false;
  }

  if (value.environmentFieldTargets === undefined) {
    return false;
  }

  if (!isRecord(value.environmentFieldTargets)) {
    return false;
  }

  const validEnvironments = new Set(
    schemaEntries.map(([environment]) => environment),
  );

  return Object.entries(value.environmentFieldTargets).every(
    ([typeName, typeFields]) => {
      if (!isNonEmptyTrimmedString(typeName) || !isRecord(typeFields)) {
        return false;
      }

      const fieldEntries = Object.entries(typeFields);
      if (fieldEntries.length === 0) {
        return false;
      }

      return fieldEntries.every(([fieldName, targets]) => {
        if (!isNonEmptyTrimmedString(fieldName)) {
          return false;
        }

        return (
          isStringArray(targets) &&
          targets.length > 0 &&
          targets.every((target) => validEnvironments.has(target))
        );
      });
    },
  );
}

function toWriteByEnvironment(
  metadata: StudioDocumentRoutePreparedMetadata,
): Record<
  string,
  {
    canWrite: true;
    schemaHash: string;
  }
> {
  return Object.fromEntries(
    Object.entries(metadata.schemaHashesByEnvironment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([environment, schemaHash]) => [
        environment,
        {
          canWrite: true as const,
          schemaHash,
        },
      ]),
  );
}

async function readPreparedDocumentRouteMetadata(
  config: MdcmsConfig,
): Promise<StudioDocumentRoutePreparedMetadata | undefined> {
  const precomputed = (config as Record<string, unknown>)
    ._documentRouteMetadata;

  if (isPreparedDocumentRouteMetadata(precomputed)) {
    return precomputed;
  }

  try {
    return await resolveStudioDocumentRoutePreparedMetadata(config);
  } catch {
    return undefined;
  }
}

async function createDocumentRouteMountContext(
  config: MdcmsConfig,
): Promise<StudioMountContext["documentRoute"] | undefined> {
  const project = readTrimmedConfigString(config?.project);
  const environment = readTrimmedConfigString(config?.environment);

  if (!project || !environment) {
    return undefined;
  }

  // When the host app pre-computes the schema hash on the server (where
  // the full config with Zod types is available), skip the client-side
  // capability derivation that would fail without serializable types.
  const precomputedSchemaHash =
    typeof (config as Record<string, unknown>)._schemaHash === "string"
      ? ((config as Record<string, unknown>)._schemaHash as string)
      : undefined;
  const preparedDocumentRouteMetadata =
    await readPreparedDocumentRouteMetadata(config);
  const writeByEnvironment = preparedDocumentRouteMetadata
    ? toWriteByEnvironment(preparedDocumentRouteMetadata)
    : undefined;
  const currentEnvironmentWrite = writeByEnvironment?.[environment];

  const capability = currentEnvironmentWrite
    ? currentEnvironmentWrite
    : precomputedSchemaHash
      ? { canWrite: true as const, schemaHash: precomputedSchemaHash }
      : await resolveStudioDocumentRouteSchemaCapability(config);

  let supportedLocales: string[] | undefined;
  let defaultLocale: string | undefined;

  try {
    const parsedConfig = parseMdcmsConfig(config);
    if (!parsedConfig.locales.implicit) {
      supportedLocales = [...parsedConfig.locales.supported];
      defaultLocale = parsedConfig.locales.default;
    }
  } catch (error) {
    if (error instanceof RuntimeError && error.code === "INVALID_CONFIG") {
      supportedLocales = undefined;
      defaultLocale = undefined;
    } else {
      throw error;
    }
  }

  return {
    project,
    initialEnvironment: environment,
    ...(supportedLocales && supportedLocales.length > 0
      ? { supportedLocales, defaultLocale }
      : {}),
    ...(writeByEnvironment ? { writeByEnvironment } : {}),
    ...(preparedDocumentRouteMetadata &&
    Object.keys(preparedDocumentRouteMetadata.environmentFieldTargets).length >
      0
      ? {
          environmentFieldTargets:
            preparedDocumentRouteMetadata.environmentFieldTargets,
        }
      : {}),
    write: capability.canWrite
      ? {
          canWrite: true,
          schemaHash: capability.schemaHash,
        }
      : {
          canWrite: false,
          message: capability.message,
        },
  };
}

function readBrowserOrigin(): string | undefined {
  const origin = globalThis.location?.origin;

  return typeof origin === "string" && origin.trim().length > 0
    ? origin.trim()
    : undefined;
}

function isLikelyOriginPolicyFailure(causeMessage: string): boolean {
  const normalized = causeMessage.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return (
    normalized.includes("cors") ||
    normalized.includes("cross-origin") ||
    normalized.includes("cross origin") ||
    normalized.includes("same-origin") ||
    normalized.includes("origin policy")
  );
}

function waitForRetryDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function createStudioLoadFailure(input: {
  code: string;
  phase: "bootstrap fetch" | "runtime asset fetch" | "runtime module import";
  url: string;
  error: unknown;
}): RuntimeError {
  const browserOrigin = readBrowserOrigin();
  const requestedOrigin = new URL(input.url).origin;
  const causeMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const isCrossOrigin =
    browserOrigin !== undefined && browserOrigin !== requestedOrigin;
  const isOriginPolicyFailure =
    isCrossOrigin && isLikelyOriginPolicyFailure(causeMessage);
  const message = isOriginPolicyFailure
    ? [
        `Failed to load Studio ${input.phase} from ${input.url}.`,
        `The browser blocked a cross-origin request from ${browserOrigin} to ${requestedOrigin}.`,
        "Check CORS or proxy the Studio backend through the host app.",
      ].join("\n")
    : [`Failed to load Studio ${input.phase} from ${input.url}.`, causeMessage]
        .filter((part) => part.length > 0)
        .join("\n");

  return new RuntimeError({
    code: input.code,
    message,
    statusCode: 500,
    details: {
      url: input.url,
      phase: input.phase,
      browserOrigin: browserOrigin ?? null,
      requestedOrigin,
      causeMessage,
      isCrossOrigin,
      isOriginPolicyFailure,
    },
  });
}

async function defaultLoadRemoteModule(entryUrl: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ entryUrl);
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate.status === "error" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.timestamp === "string"
  );
}

async function fetchStudioBootstrapReadyResponse(input: {
  apiBaseUrl: string;
  fetcher: typeof fetch;
  retry?: StudioBootstrapRetryContext;
}): Promise<StudioBootstrapReadyResponse> {
  const bootstrapUrl = resolveBootstrapUrl(input.apiBaseUrl, input.retry);
  let bootstrapResponse: Response;

  for (let attempt = 0; ; attempt += 1) {
    try {
      bootstrapResponse = await input.fetcher(bootstrapUrl);
      break;
    } catch (error) {
      if (attempt >= BOOTSTRAP_FETCH_RETRY_DELAYS_MS.length) {
        throw createStudioLoadFailure({
          code: "STUDIO_BOOTSTRAP_FETCH_FAILED",
          phase: "bootstrap fetch",
          url: bootstrapUrl,
          error,
        });
      }

      await waitForRetryDelay(BOOTSTRAP_FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }

  if (!bootstrapResponse.ok) {
    let responseBody: unknown;

    try {
      responseBody = await bootstrapResponse.json();
    } catch {
      responseBody = undefined;
    }

    if (isErrorEnvelope(responseBody)) {
      throw new RuntimeError({
        code: responseBody.code,
        message: responseBody.message,
        statusCode: bootstrapResponse.status || 500,
        details: responseBody.details,
      });
    }

    throw new RuntimeError({
      code: "STUDIO_BOOTSTRAP_FETCH_FAILED",
      message: `Failed to fetch Studio bootstrap manifest from ${bootstrapUrl}.`,
      statusCode: bootstrapResponse.status || 500,
      details: {
        url: bootstrapUrl,
        status: bootstrapResponse.status,
      },
    });
  }

  const bootstrapPayload = (await bootstrapResponse.json()) as unknown;
  assertStudioBootstrapReadyResponse(bootstrapPayload);

  return bootstrapPayload;
}

function classifyStudioBootstrapRetry(
  error: unknown,
  buildId: string,
): StudioBootstrapRetryContext | undefined {
  if (!isRuntimeErrorLike(error)) {
    return undefined;
  }

  if (error.code === "STUDIO_RUNTIME_INTEGRITY_MISMATCH") {
    return {
      rejectedBuildId: buildId,
      rejectionReason: "integrity",
    };
  }

  if (
    error.code === "INVALID_STUDIO_RUNTIME_SIGNATURE" ||
    error.code === "INVALID_STUDIO_RUNTIME_KEY_ID"
  ) {
    return {
      rejectedBuildId: buildId,
      rejectionReason: "signature",
    };
  }

  if (error.code === "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST") {
    return {
      rejectedBuildId: buildId,
      rejectionReason: "compatibility",
    };
  }

  return undefined;
}

async function loadStudioRuntimeFromBootstrap(
  options: StudioLoaderOptions,
  input: {
    apiBaseUrl: string;
    fetcher: typeof fetch;
    bootstrapResponse: StudioBootstrapReadyResponse;
    localMdxRuntimePromise: Promise<LoadedLocalMdxRuntime | undefined>;
  },
): Promise<() => void> {
  const manifest = input.bootstrapResponse.data.manifest;
  const runtimeUrl = resolveUrl(manifest.entryUrl, input.apiBaseUrl);
  let runtimeResponse: Response;

  try {
    runtimeResponse = await input.fetcher(runtimeUrl);
  } catch (error) {
    throw createStudioLoadFailure({
      code: "STUDIO_RUNTIME_ASSET_LOAD_FAILED",
      phase: "runtime asset fetch",
      url: runtimeUrl,
      error,
    });
  }

  if (!runtimeResponse.ok) {
    throw new RuntimeError({
      code: "STUDIO_RUNTIME_ASSET_LOAD_FAILED",
      message: `Failed to fetch Studio runtime asset from ${runtimeUrl}.`,
      statusCode: runtimeResponse.status || 500,
      details: {
        url: runtimeUrl,
        status: runtimeResponse.status,
      },
    });
  }

  const runtimeBytes = new Uint8Array(await runtimeResponse.arrayBuffer());
  await assertStudioRuntimePublication({
    manifest,
    runtimeBytes,
    compatibility: {
      studioPackageVersion: STUDIO_PACKAGE_VERSION,
      hostBridgeVersion: STUDIO_HOST_BRIDGE_COMPATIBILITY_VERSION,
    },
  });

  const localMdxRuntime = await input.localMdxRuntimePromise;
  const configHostBridge = localMdxRuntime?.hostBridge;
  const hostBridge =
    options.hostBridge && configHostBridge
      ? composeHostBridges({
          primary: options.hostBridge,
          fallback: configHostBridge,
        })
      : (options.hostBridge ?? configHostBridge ?? createDefaultHostBridge());
  const documentRoute = await createDocumentRouteMountContext(options.config);

  const mountContext: StudioMountContext = {
    apiBaseUrl: input.apiBaseUrl,
    basePath: options.basePath,
    auth: options.auth ?? { mode: "cookie" },
    hostBridge,
    ...(documentRoute ? { documentRoute } : {}),
    ...(localMdxRuntime?.mdx !== undefined ? { mdx: localMdxRuntime.mdx } : {}),
  };
  assertStudioMountContext(mountContext);

  let remoteModule: unknown;

  try {
    remoteModule = await (options.loadRemoteModule ?? defaultLoadRemoteModule)(
      runtimeUrl,
    );
  } catch (error) {
    throw createStudioLoadFailure({
      code: "STUDIO_RUNTIME_ASSET_LOAD_FAILED",
      phase: "runtime module import",
      url: runtimeUrl,
      error,
    });
  }

  assertRemoteStudioModule(remoteModule);

  const unmount = remoteModule.mount(options.container, mountContext);

  if (typeof unmount !== "function") {
    throw new RuntimeError({
      code: "INVALID_STUDIO_RUNTIME_CONTRACT",
      message: "remoteStudioModule.mount must return an unmount function.",
      statusCode: 500,
    });
  }

  return unmount;
}

export async function loadStudioRuntime(
  options: StudioLoaderOptions,
): Promise<() => void> {
  const apiBaseUrl = normalizeBaseUrl(options.config.serverUrl);
  // Preserve the browser Window binding for the default global fetch path.
  const fetcher =
    options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const localMdxRuntimePromise = createLoadedLocalMdxRuntime(options.config);
  const bootstrapResponse = await fetchStudioBootstrapReadyResponse({
    apiBaseUrl,
    fetcher,
  });

  try {
    return await loadStudioRuntimeFromBootstrap(options, {
      apiBaseUrl,
      fetcher,
      bootstrapResponse,
      localMdxRuntimePromise,
    });
  } catch (error) {
    const retry = classifyStudioBootstrapRetry(
      error,
      bootstrapResponse.data.manifest.buildId,
    );

    if (!retry) {
      throw error;
    }

    const fallbackBootstrapResponse = await fetchStudioBootstrapReadyResponse({
      apiBaseUrl,
      fetcher,
      retry,
    });

    return loadStudioRuntimeFromBootstrap(options, {
      apiBaseUrl,
      fetcher,
      bootstrapResponse: fallbackBootstrapResponse,
      localMdxRuntimePromise,
    });
  }
}
