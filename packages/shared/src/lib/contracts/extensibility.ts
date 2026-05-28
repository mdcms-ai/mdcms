import { z } from "zod";

import { RuntimeError } from "../runtime/error.js";
import {
  assertActionCatalogList,
  type ActionCatalogItem,
} from "./action-catalog.js";
import type { MdcmsComponentRegistration } from "./config.js";

export const EXTENSIBILITY_API_VERSION = "1" as const;
export const HOST_BRIDGE_VERSION = "1" as const;

export type ModuleKind = "domain" | "core";

export type ModuleManifest = {
  id: string;
  version: string;
  apiVersion: typeof EXTENSIBILITY_API_VERSION;
  kind?: ModuleKind;
  dependsOn?: string[];
  minCoreVersion?: string;
  maxCoreVersion?: string;
};
export type ServerSurface<App = unknown, AppDeps = unknown> = {
  mount: (app: App, deps: AppDeps) => void;
  actions?: ActionCatalogItem[];
};

export type CliActionAlias = {
  alias: string;
  actionId: string;
};

export type CliOutputFormatter = {
  actionId?: string;
  format: (output: unknown) => string;
};

export type CliPreflightHook = {
  id: string;
  run: (context: { actionId: string; input: unknown }) => void | Promise<void>;
};

export type CliSurface = {
  actionAliases?: CliActionAlias[];
  outputFormatters?: CliOutputFormatter[];
  preflightHooks?: CliPreflightHook[];
};

export type MdcmsModulePackage<App = unknown, AppDeps = unknown> = {
  manifest: ModuleManifest;
  server?: ServerSurface<App, AppDeps>;
  cli?: CliSurface;
};

export type StudioExecutionMode = "module";

export type StudioBootstrapManifest = {
  apiVersion: typeof EXTENSIBILITY_API_VERSION;
  studioVersion: string;
  mode: StudioExecutionMode;
  entryUrl: string;
  integritySha256: string;
  signature: string;
  keyId: string;
  buildId: string;
  minStudioPackageVersion: string;
  minHostBridgeVersion: string;
  expiresAt: string;
};

export type StudioBootstrapRejectionReason =
  | "integrity"
  | "signature"
  | "compatibility";

export type StudioBootstrapReadyResponse = {
  data:
    | {
        status: "ready";
        source: "active";
        manifest: StudioBootstrapManifest;
      }
    | {
        status: "ready";
        source: "lastKnownGood";
        manifest: StudioBootstrapManifest;
        recovery?: {
          rejectedBuildId: string;
          rejectionReason: StudioBootstrapRejectionReason;
        };
      };
};

export type MdxComponentCatalogEntry = Pick<
  MdcmsComponentRegistration,
  "name" | "importPath" | "description" | "propHints" | "propsEditor"
> & {
  builtIn?: true;
  extractedProps?: MdxExtractedProps;
};

export type MdxComponentCatalog = {
  components: MdxComponentCatalogEntry[];
};

export type MdcmsInlineStyle = Record<string, string | number>;

export type MdxExtractedProp =
  | { type: "string"; required: boolean; format?: "url" }
  | { type: "number"; required: boolean }
  | { type: "boolean"; required: boolean }
  | { type: "date"; required: boolean }
  | { type: "enum"; required: boolean; values: string[] }
  | { type: "array"; required: boolean; items: "string" | "number" }
  | { type: "style"; required: boolean }
  | { type: "json"; required: boolean }
  | { type: "rich-text"; required: boolean };

export type MdxExtractedProps = Record<string, MdxExtractedProp>;

export type MdxComponentHostCapabilities = {
  resolvePropsEditor: (name: string) => Promise<unknown | null>;
};

export type HostBridgeV1 = {
  version: typeof HOST_BRIDGE_VERSION;
  resolveComponent: (name: string) => unknown | null;
  renderMdxPreview: (input: {
    container: unknown;
    componentName: string;
    props: Record<string, unknown>;
    key: string;
  }) => () => void;
};

export type StudioDocumentRouteWriteContext =
  | {
      canWrite: true;
      schemaHash: string;
    }
  | {
      canWrite: false;
      message: string;
    };

export type StudioDocumentRouteMountContext = {
  project: string;
  /** Initial environment provided by the host app. Studio owns the active
   *  environment after mount — use `useStudioMountInfo().environment` for the
   *  current value at runtime. */
  initialEnvironment: string;
  supportedLocales?: string[];
  defaultLocale?: string;
  writeByEnvironment?: Record<string, StudioDocumentRouteWriteContext>;
  environmentFieldTargets?: Record<string, Record<string, string[]>>;
  write: StudioDocumentRouteWriteContext;
};

export type StudioMountContext = {
  apiBaseUrl: string;
  basePath: string;
  auth: {
    mode: "cookie" | "token";
    token?: string;
  };
  hostBridge: HostBridgeV1;
  documentRoute?: StudioDocumentRouteMountContext;
  mdx?: {
    catalog: MdxComponentCatalog;
    resolvePropsEditor: MdxComponentHostCapabilities["resolvePropsEditor"];
  };
};

export type RemoteStudioModule = {
  mount: (container: unknown, ctx: StudioMountContext) => () => void;
};

export type ModuleManifestCompatibilityOptions = {
  coreVersion: string;
  supportedApiVersion?: string;
};

export type StudioBootstrapCompatibilityOptions = {
  studioPackageVersion: string;
  hostBridgeVersion: string;
  supportedApiVersion?: string;
};

type StrictSemver = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

const MODULE_KIND_VALUES = ["domain", "core"] as const;
const STUDIO_MODE_VALUES = ["module"] as const;
const STUDIO_BOOTSTRAP_REJECTION_REASON_VALUES = [
  "integrity",
  "signature",
  "compatibility",
] as const satisfies readonly StudioBootstrapRejectionReason[];
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const nonEmptyStringSchema = z.string().trim().min(1, {
  message: "must be a non-empty string.",
});

const strictSemverSchema = nonEmptyStringSchema.refine(
  (value) => SEMVER_PATTERN.test(value),
  {
    message:
      "must use strict x.y.z version format (no pre-release/build metadata).",
  },
);

const functionSchema = z.custom<(...args: unknown[]) => unknown>(
  (value) => typeof value === "function",
  {
    message: "must be a function.",
  },
);

const moduleManifestSchema = z
  .object({
    id: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    apiVersion: nonEmptyStringSchema.refine(
      (value) => value === EXTENSIBILITY_API_VERSION,
      {
        message: `must be "${EXTENSIBILITY_API_VERSION}".`,
      },
    ),
    kind: z.enum(MODULE_KIND_VALUES).optional(),
    dependsOn: z.array(nonEmptyStringSchema).optional(),
    minCoreVersion: strictSemverSchema.optional(),
    maxCoreVersion: strictSemverSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.dependsOn !== undefined) {
      const seen = new Set<string>();

      manifest.dependsOn.forEach((dependency, index) => {
        if (seen.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["dependsOn", index],
            message: `contains duplicate dependency id \"${dependency}\".`,
          });
        }

        seen.add(dependency);
      });
    }

    if (
      manifest.minCoreVersion !== undefined &&
      manifest.maxCoreVersion !== undefined
    ) {
      const minVersion = toStrictSemver(manifest.minCoreVersion);
      const maxVersion = toStrictSemver(manifest.maxCoreVersion);

      if (compareStrictSemver(minVersion, maxVersion) > 0) {
        context.addIssue({
          code: "custom",
          path: ["minCoreVersion"],
          message: "must be less than or equal to maxCoreVersion.",
        });
      }
    }
  });

const cliActionAliasSchema = z
  .object({
    alias: nonEmptyStringSchema,
    actionId: nonEmptyStringSchema,
  })
  .strict();

const cliOutputFormatterSchema = z
  .object({
    actionId: nonEmptyStringSchema.optional(),
    format: functionSchema,
  })
  .strict();

const cliPreflightHookSchema = z
  .object({
    id: nonEmptyStringSchema,
    run: functionSchema,
  })
  .strict();

const cliSurfaceSchema = z
  .object({
    actionAliases: z.array(cliActionAliasSchema).optional(),
    outputFormatters: z.array(cliOutputFormatterSchema).optional(),
    preflightHooks: z.array(cliPreflightHookSchema).optional(),
  })
  .strict();

const serverSurfaceSchema = z
  .object({
    mount: functionSchema,
    actions: z.array(z.unknown()).optional(),
  })
  .strict();

const modulePackageSchema = z
  .object({
    manifest: moduleManifestSchema,
    server: serverSurfaceSchema.optional(),
    cli: cliSurfaceSchema.optional(),
  })
  .strict();

const studioBootstrapManifestSchema = z
  .object({
    apiVersion: nonEmptyStringSchema.refine(
      (value) => value === EXTENSIBILITY_API_VERSION,
      {
        message: `must be "${EXTENSIBILITY_API_VERSION}".`,
      },
    ),
    studioVersion: nonEmptyStringSchema,
    mode: z.enum(STUDIO_MODE_VALUES),
    entryUrl: nonEmptyStringSchema,
    integritySha256: nonEmptyStringSchema,
    signature: nonEmptyStringSchema,
    keyId: nonEmptyStringSchema,
    buildId: nonEmptyStringSchema,
    minStudioPackageVersion: strictSemverSchema,
    minHostBridgeVersion: strictSemverSchema,
    expiresAt: nonEmptyStringSchema.refine(
      (value) => !Number.isNaN(Date.parse(value)),
      {
        message: "must be an ISO-8601 date string.",
      },
    ),
  })
  .strict();

const studioBootstrapRecoverySchema = z
  .object({
    rejectedBuildId: nonEmptyStringSchema,
    rejectionReason: z.enum(STUDIO_BOOTSTRAP_REJECTION_REASON_VALUES),
  })
  .strict();

const studioBootstrapReadyResponseSchema = z
  .object({
    data: z.discriminatedUnion("source", [
      z
        .object({
          status: z.literal("ready"),
          source: z.literal("active"),
          manifest: studioBootstrapManifestSchema,
        })
        .strict(),
      z
        .object({
          status: z.literal("ready"),
          source: z.literal("lastKnownGood"),
          manifest: studioBootstrapManifestSchema,
          recovery: studioBootstrapRecoverySchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();

const hostBridgeV1Schema = z
  .object({
    version: nonEmptyStringSchema.refine(
      (value) => value === HOST_BRIDGE_VERSION,
      {
        message: `must be "${HOST_BRIDGE_VERSION}".`,
      },
    ),
    resolveComponent: functionSchema,
    renderMdxPreview: functionSchema,
  })
  .strict();

const mdxExtractedPropRequiredSchema = z
  .object({
    required: z.boolean(),
  })
  .strict();

const mdxExtractedPropSchema = z.discriminatedUnion("type", [
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("string"),
    format: z.literal("url").optional(),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("number"),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("boolean"),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("date"),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("enum"),
    values: z.array(nonEmptyStringSchema).min(1, {
      message: "must contain at least one value.",
    }),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("array"),
    items: z.enum(["string", "number"]),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("style"),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("json"),
  }),
  mdxExtractedPropRequiredSchema.extend({
    type: z.literal("rich-text"),
  }),
]);

export const mdcmsInlineStyleSchema = z
  .record(z.string(), z.union([z.string(), z.number().finite()]))
  .refine((value) => !Array.isArray(value), {
    message: "must be a flat object with string or number values.",
  });

const mdxSelectOptionValueSchema = z.union([
  nonEmptyStringSchema,
  z.number(),
  z.boolean(),
]);

const mdxSelectOptionSchema = z.union([
  mdxSelectOptionValueSchema,
  z
    .object({
      label: nonEmptyStringSchema,
      value: mdxSelectOptionValueSchema,
    })
    .strict(),
]);

const mdxPropHintSchema = z.union([
  z
    .object({
      format: z.literal("url"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("color-picker"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("textarea"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("image"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("hidden"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("json"),
    })
    .strict(),
  z
    .object({
      widget: z.literal("slider"),
      min: z.number().finite(),
      max: z.number().finite(),
      step: z.number().finite().positive().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.min >= value.max) {
        context.addIssue({
          code: "custom",
          path: ["min"],
          message: 'must satisfy "min < max" for the slider widget.',
        });
      }
    }),
  z
    .object({
      widget: z.literal("select"),
      options: z.array(mdxSelectOptionSchema).min(1, {
        message: 'must include a non-empty "options" array.',
      }),
    })
    .strict(),
]);

export const mdxComponentCatalogEntrySchema = z
  .object({
    name: nonEmptyStringSchema,
    importPath: nonEmptyStringSchema,
    description: nonEmptyStringSchema.optional(),
    builtIn: z.literal(true).optional(),
    propHints: z.record(z.string(), mdxPropHintSchema).optional(),
    propsEditor: nonEmptyStringSchema.optional(),
    extractedProps: z.record(z.string(), mdxExtractedPropSchema).optional(),
  })
  .strict();

export const mdxComponentCatalogSchema = z
  .object({
    components: z.array(mdxComponentCatalogEntrySchema),
  })
  .strict();

const mdxComponentHostCapabilitiesSchema = z
  .object({
    resolvePropsEditor: functionSchema,
  })
  .strict();

const studioMountAuthSchema = z
  .object({
    mode: z.enum(["cookie", "token"]),
    token: nonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((auth, context) => {
    if (auth.mode === "token" && auth.token === undefined) {
      context.addIssue({
        code: "custom",
        path: ["token"],
        message: "must be a non-empty string.",
      });
    }
  });

const studioDocumentRouteWriteSchema = z.discriminatedUnion("canWrite", [
  z
    .object({
      canWrite: z.literal(true),
      schemaHash: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      canWrite: z.literal(false),
      message: nonEmptyStringSchema,
    })
    .strict(),
]);

const studioDocumentRouteContextSchema = z
  .object({
    project: nonEmptyStringSchema,
    initialEnvironment: nonEmptyStringSchema,
    supportedLocales: z.array(nonEmptyStringSchema).optional(),
    defaultLocale: nonEmptyStringSchema.optional(),
    writeByEnvironment: z
      .record(nonEmptyStringSchema, studioDocumentRouteWriteSchema)
      .optional(),
    environmentFieldTargets: z
      .record(
        nonEmptyStringSchema,
        z.record(nonEmptyStringSchema, z.array(nonEmptyStringSchema)),
      )
      .optional(),
    write: studioDocumentRouteWriteSchema,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.defaultLocale &&
      data.supportedLocales &&
      !data.supportedLocales.includes(data.defaultLocale)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `defaultLocale "${data.defaultLocale}" must be included in supportedLocales`,
        path: ["defaultLocale"],
      });
    }
  });

const studioMountContextSchema = z
  .object({
    apiBaseUrl: nonEmptyStringSchema,
    basePath: nonEmptyStringSchema,
    auth: studioMountAuthSchema,
    hostBridge: hostBridgeV1Schema,
    documentRoute: studioDocumentRouteContextSchema.optional(),
    mdx: z
      .object({
        catalog: mdxComponentCatalogSchema,
        resolvePropsEditor:
          mdxComponentHostCapabilitiesSchema.shape.resolvePropsEditor,
      })
      .strict()
      .optional(),
  })
  .strict();

const remoteStudioModuleSchema = z
  .object({
    mount: functionSchema,
  })
  .strict();

const moduleCompatibilityOptionsSchema = z
  .object({
    coreVersion: strictSemverSchema,
    supportedApiVersion: nonEmptyStringSchema.optional(),
  })
  .strict();

const studioCompatibilityOptionsSchema = z
  .object({
    studioPackageVersion: strictSemverSchema,
    hostBridgeVersion: strictSemverSchema,
    supportedApiVersion: nonEmptyStringSchema.optional(),
  })
  .strict();

function toStrictSemver(value: string): StrictSemver {
  const [major, minor, patch] = value.split(".").map(Number);

  return {
    major,
    minor,
    patch,
    raw: value,
  };
}

function compareStrictSemver(
  left: StrictSemver,
  right: StrictSemver,
): -1 | 0 | 1 {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }

  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }

  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }

  return 0;
}

function formatIssuePath(
  path: string,
  issuePath: readonly PropertyKey[],
): string {
  if (issuePath.length === 0) {
    return path;
  }

  return issuePath.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }

    if (typeof segment === "symbol") {
      return `${acc}.[${String(segment)}]`;
    }

    return `${acc}.${segment}`;
  }, path);
}

function toValidationMessage(
  path: string,
  issue: z.core.$ZodIssue,
  fallback: string,
): string {
  const issuePath = formatIssuePath(path, issue.path ?? []);

  if (
    issue.code === "unrecognized_keys" &&
    "keys" in issue &&
    Array.isArray(issue.keys)
  ) {
    return `${issuePath} contains unknown field(s): ${issue.keys.join(", ")}.`;
  }

  if (issue.code === "custom") {
    return `${issuePath} ${issue.message}`;
  }

  if (issue.message) {
    return `${issuePath} ${issue.message}`;
  }

  return fallback;
}

function throwValidationRuntimeError(
  code: string,
  path: string,
  error: z.ZodError,
  fallbackMessage: string,
): never {
  const [firstIssue] = error.issues;
  const message = firstIssue
    ? toValidationMessage(path, firstIssue, fallbackMessage)
    : fallbackMessage;

  throw new RuntimeError({
    code,
    message,
    statusCode: 500,
    details: {
      path: firstIssue ? formatIssuePath(path, firstIssue.path ?? []) : path,
      issues: error.issues,
    },
  });
}

function assertWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: string,
  code: string,
  fallbackMessage: string,
): asserts value is T {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return;
  }

  throwValidationRuntimeError(code, path, parsed.error, fallbackMessage);
}

export function assertModuleManifest(
  value: unknown,
  path = "manifest",
): asserts value is ModuleManifest {
  assertWithSchema(
    moduleManifestSchema,
    value,
    path,
    "INVALID_MODULE_MANIFEST",
    `${path} is invalid.`,
  );
}

export function assertMdcmsModulePackage(
  value: unknown,
  path = "module",
): asserts value is MdcmsModulePackage {
  assertWithSchema(
    modulePackageSchema,
    value,
    path,
    "INVALID_MDCMS_MODULE_PACKAGE",
    `${path} is invalid.`,
  );

  const parsed = modulePackageSchema.parse(value);

  if (parsed.server?.actions !== undefined) {
    try {
      assertActionCatalogList(parsed.server.actions, `${path}.server.actions`);
    } catch (error) {
      if (error instanceof RuntimeError) {
        throw new RuntimeError({
          code: "INVALID_MDCMS_MODULE_PACKAGE",
          message: error.message,
          statusCode: 500,
          details: {
            path: `${path}.server.actions`,
            cause: error.details,
          },
        });
      }

      throw error;
    }
  }
}

export function assertStudioBootstrapManifest(
  value: unknown,
  path = "studioBootstrapManifest",
): asserts value is StudioBootstrapManifest {
  assertWithSchema(
    studioBootstrapManifestSchema,
    value,
    path,
    "INVALID_STUDIO_BOOTSTRAP_MANIFEST",
    `${path} is invalid.`,
  );
}

export function assertStudioBootstrapReadyResponse(
  value: unknown,
  path = "studioBootstrapReadyResponse",
): asserts value is StudioBootstrapReadyResponse {
  assertWithSchema(
    studioBootstrapReadyResponseSchema,
    value,
    path,
    "INVALID_STUDIO_BOOTSTRAP_RESPONSE",
    `${path} is invalid.`,
  );
}

export function assertHostBridgeV1(
  value: unknown,
  path = "hostBridge",
): asserts value is HostBridgeV1 {
  assertWithSchema(
    hostBridgeV1Schema,
    value,
    path,
    "INVALID_STUDIO_RUNTIME_CONTRACT",
    `${path} is invalid.`,
  );
}

export function assertMdcmsInlineStyle(
  value: unknown,
  path = "inlineStyle",
): asserts value is MdcmsInlineStyle {
  assertWithSchema(
    mdcmsInlineStyleSchema,
    value,
    path,
    "INVALID_MDCMS_INLINE_STYLE",
    `${path} is invalid.`,
  );
}

export function assertStudioMountContext(
  value: unknown,
  path = "studioMountContext",
): asserts value is StudioMountContext {
  assertWithSchema(
    studioMountContextSchema,
    value,
    path,
    "INVALID_STUDIO_RUNTIME_CONTRACT",
    `${path} is invalid.`,
  );
}

export function assertRemoteStudioModule(
  value: unknown,
  path = "remoteStudioModule",
): asserts value is RemoteStudioModule {
  assertWithSchema(
    remoteStudioModuleSchema,
    value,
    path,
    "INVALID_STUDIO_RUNTIME_CONTRACT",
    `${path} is invalid.`,
  );
}

export function assertModuleManifestCompatibility(
  manifest: ModuleManifest,
  options: ModuleManifestCompatibilityOptions,
): void {
  assertModuleManifest(manifest, "manifest");
  assertWithSchema(
    moduleCompatibilityOptionsSchema,
    options,
    "options",
    "INCOMPATIBLE_MODULE_MANIFEST",
    "options is invalid.",
  );

  const parsedOptions = moduleCompatibilityOptionsSchema.parse(options);
  const supportedApiVersion =
    parsedOptions.supportedApiVersion ?? EXTENSIBILITY_API_VERSION;

  if (manifest.apiVersion !== supportedApiVersion) {
    throw new RuntimeError({
      code: "INCOMPATIBLE_MODULE_MANIFEST",
      message: `manifest.apiVersion ${manifest.apiVersion} is not supported (expected ${supportedApiVersion}).`,
      statusCode: 500,
      details: {
        path: "manifest.apiVersion",
        manifestApiVersion: manifest.apiVersion,
        supportedApiVersion,
      },
    });
  }

  const coreVersion = toStrictSemver(parsedOptions.coreVersion);

  if (manifest.minCoreVersion !== undefined) {
    const minVersion = toStrictSemver(manifest.minCoreVersion);

    if (compareStrictSemver(coreVersion, minVersion) < 0) {
      throw new RuntimeError({
        code: "INCOMPATIBLE_MODULE_MANIFEST",
        message: `Core version ${parsedOptions.coreVersion} is below manifest.minCoreVersion ${manifest.minCoreVersion}.`,
        statusCode: 500,
        details: {
          path: "manifest.minCoreVersion",
          coreVersion: parsedOptions.coreVersion,
          minCoreVersion: manifest.minCoreVersion,
        },
      });
    }
  }

  if (manifest.maxCoreVersion !== undefined) {
    const maxVersion = toStrictSemver(manifest.maxCoreVersion);

    if (compareStrictSemver(coreVersion, maxVersion) > 0) {
      throw new RuntimeError({
        code: "INCOMPATIBLE_MODULE_MANIFEST",
        message: `Core version ${parsedOptions.coreVersion} is above manifest.maxCoreVersion ${manifest.maxCoreVersion}.`,
        statusCode: 500,
        details: {
          path: "manifest.maxCoreVersion",
          coreVersion: parsedOptions.coreVersion,
          maxCoreVersion: manifest.maxCoreVersion,
        },
      });
    }
  }
}

export function assertStudioBootstrapCompatibility(
  manifest: StudioBootstrapManifest,
  options: StudioBootstrapCompatibilityOptions,
): void {
  assertStudioBootstrapManifest(manifest, "manifest");
  assertWithSchema(
    studioCompatibilityOptionsSchema,
    options,
    "options",
    "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST",
    "options is invalid.",
  );

  const parsedOptions = studioCompatibilityOptionsSchema.parse(options);
  const supportedApiVersion =
    parsedOptions.supportedApiVersion ?? EXTENSIBILITY_API_VERSION;

  if (manifest.apiVersion !== supportedApiVersion) {
    throw new RuntimeError({
      code: "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST",
      message: `manifest.apiVersion ${manifest.apiVersion} is not supported (expected ${supportedApiVersion}).`,
      statusCode: 500,
      details: {
        path: "manifest.apiVersion",
        manifestApiVersion: manifest.apiVersion,
        supportedApiVersion,
      },
    });
  }

  const studioPackageVersion = toStrictSemver(
    parsedOptions.studioPackageVersion,
  );
  const hostBridgeVersion = toStrictSemver(parsedOptions.hostBridgeVersion);
  const minStudioPackageVersion = toStrictSemver(
    manifest.minStudioPackageVersion,
  );
  const minHostBridgeVersion = toStrictSemver(manifest.minHostBridgeVersion);

  if (compareStrictSemver(studioPackageVersion, minStudioPackageVersion) < 0) {
    throw new RuntimeError({
      code: "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST",
      message: `Studio package version ${parsedOptions.studioPackageVersion} is below manifest.minStudioPackageVersion ${manifest.minStudioPackageVersion}.`,
      statusCode: 500,
      details: {
        path: "manifest.minStudioPackageVersion",
        studioPackageVersion: parsedOptions.studioPackageVersion,
        minStudioPackageVersion: manifest.minStudioPackageVersion,
      },
    });
  }

  if (compareStrictSemver(hostBridgeVersion, minHostBridgeVersion) < 0) {
    throw new RuntimeError({
      code: "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST",
      message: `Host bridge version ${parsedOptions.hostBridgeVersion} is below manifest.minHostBridgeVersion ${manifest.minHostBridgeVersion}.`,
      statusCode: 500,
      details: {
        path: "manifest.minHostBridgeVersion",
        hostBridgeVersion: parsedOptions.hostBridgeVersion,
        minHostBridgeVersion: manifest.minHostBridgeVersion,
      },
    });
  }
}

export function isModuleManifest(value: unknown): value is ModuleManifest {
  return moduleManifestSchema.safeParse(value).success;
}

export function isStudioBootstrapManifest(
  value: unknown,
): value is StudioBootstrapManifest {
  return studioBootstrapManifestSchema.safeParse(value).success;
}

export function isStudioBootstrapReadyResponse(
  value: unknown,
): value is StudioBootstrapReadyResponse {
  return studioBootstrapReadyResponseSchema.safeParse(value).success;
}
