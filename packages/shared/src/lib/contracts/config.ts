import { z } from "zod";
import type * as zodCore from "zod/v4/core";

import type { MdxPropHint } from "../mdx/prop-hints.js";
import { parseMdxPropHints } from "../mdx/prop-hints.js";
import { RuntimeError } from "../runtime/error.js";

export const IMPLICIT_DEFAULT_LOCALE = "__mdcms_default__" as const;

const REFERENCE_METADATA_KEY = "mdcms:reference";
const FILE_METADATA_KEY = "mdcms:file";
const FILE_HELPER_DEFAULT_METADATA_KEY = "mdcms:file-helper-default";
const ENVIRONMENT_TARGETS_METADATA_KEY = "mdcms:environmentTargets";
const MIME_ACCEPT_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;

declare module "zod" {
  interface ZodType<
    out Output = unknown,
    out Input = unknown,
    out Internals extends zodCore.$ZodTypeInternals<
      Output,
      Input
    > = zodCore.$ZodTypeInternals<Output, Input>,
  > {
    env(...targets: string[]): this;
  }
}

let envMethodInstalled = false;
installEnvMethod();

export type StandardSchemaLike<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> },
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
};

export type MdcmsReferenceMetadata = {
  targetType: string;
};

export type MdcmsFileFieldPreset = "image" | "video" | "file";

export type MdcmsFileFieldMetadata = {
  preset: MdcmsFileFieldPreset;
  accept: string[];
  emptyStringAsUnset: boolean;
};

export type MdcmsFileFieldOptions = {
  accept?: string[];
  required?: boolean;
  default?: string;
};

type MdcmsPlainFileFieldSchema = z.ZodString;
type MdcmsOptionalFileFieldSchema = z.ZodNullable<z.ZodOptional<z.ZodString>>;
type MdcmsDefaultFileFieldSchema = z.ZodDefault<z.ZodString>;
type MdcmsConcreteFileFieldSchema =
  | MdcmsPlainFileFieldSchema
  | MdcmsOptionalFileFieldSchema
  | MdcmsDefaultFileFieldSchema;

export type MdcmsFieldSchema = StandardSchemaLike;

export type MdcmsTypeOverlay = {
  add?: Record<string, MdcmsFieldSchema>;
  modify?: Record<string, MdcmsFieldSchema>;
  omit?: string[];
};

export type MdcmsEnvironmentDefinition = {
  extends?: string;
  types?: Record<string, MdcmsTypeOverlay>;
};

export type MdcmsPreviewDocument = {
  documentId: string;
  type: string;
  path: string;
  locale: string;
  frontmatter: Record<string, unknown>;
  draftRevision: number;
};

export type MdcmsPreviewUrlResolver = (
  document: MdcmsPreviewDocument,
) => string | URL | null | undefined;

export type MdcmsTypeDefinition<
  TName extends string = string,
  TFields extends Record<string, MdcmsFieldSchema> = Record<
    string,
    MdcmsFieldSchema
  >,
> = {
  name: TName;
  directory?: string;
  localized?: boolean;
  fields: TFields;
  resolvePreviewUrl?: MdcmsPreviewUrlResolver;
  extend(overlay: MdcmsTypeOverlay): MdcmsTypeOverlay;
};

export type MdcmsLocaleConfig = {
  default: string;
  supported: readonly string[];
  aliases?: Record<string, string>;
};

export type MdcmsComponentRegistration = {
  name: string;
  importPath: string;
  description?: string;
  propHints?: Record<string, MdxPropHint>;
  propsEditor?: string;
  load?: () => Promise<unknown>;
  loadPropsEditor?: () => Promise<unknown>;
};

export type MdcmsConfig = {
  project: string;
  serverUrl: string;
  environment?: string;
  contentDirectories?: string[];
  locales?: MdcmsLocaleConfig;
  types?: MdcmsTypeDefinition[];
  environments?: Record<string, MdcmsEnvironmentDefinition>;
  components?: MdcmsComponentRegistration[];
};

export type ParsedMdcmsLocaleConfig = {
  default: string;
  supported: string[];
  aliases: Record<string, string>;
  implicit: boolean;
};

export type ParsedMdcmsTypeDefinition = {
  name: string;
  directory?: string;
  localized: boolean;
  fields: Record<string, MdcmsFieldSchema>;
  resolvePreviewUrl?: MdcmsPreviewUrlResolver;
  referenceFields: Record<string, MdcmsReferenceMetadata>;
  environmentFields: Record<
    string,
    { schema: MdcmsFieldSchema; targets: string[] }
  >;
};

export type ParsedMdcmsTypeOverlay = {
  add: Record<string, MdcmsFieldSchema>;
  modify: Record<string, MdcmsFieldSchema>;
  omit: string[];
};

export type ParsedMdcmsEnvironmentDefinition = {
  extends?: string;
  types: Record<string, ParsedMdcmsTypeOverlay>;
};

export type ParsedMdcmsResolvedEnvironment = {
  extends?: string;
  types: Record<string, ParsedMdcmsTypeDefinition>;
};

export type ParsedMdcmsComponentRegistration = {
  name: string;
  importPath: string;
  description?: string;
  propHints?: Record<string, MdxPropHint>;
  propsEditor?: string;
};

export type ParsedMdcmsConfig = {
  project: string;
  serverUrl: string;
  environment?: string;
  contentDirectories: string[];
  locales: ParsedMdcmsLocaleConfig;
  types: ParsedMdcmsTypeDefinition[];
  environments: Record<string, ParsedMdcmsEnvironmentDefinition>;
  resolvedEnvironments: Record<string, ParsedMdcmsResolvedEnvironment>;
  components: ParsedMdcmsComponentRegistration[];
};

export function defineConfig<TConfig extends MdcmsConfig>(
  config: TConfig,
): TConfig {
  return config;
}

export function defineType<
  TName extends string,
  TFields extends Record<string, MdcmsFieldSchema>,
>(
  name: TName,
  definition: {
    directory?: string;
    localized?: boolean;
    fields: TFields;
    resolvePreviewUrl?: MdcmsPreviewUrlResolver;
  },
): MdcmsTypeDefinition<TName, TFields> {
  return {
    name,
    ...definition,
    extend(overlay) {
      return overlay;
    },
  };
}

function createReferenceField(targetType: string) {
  const normalizedTargetType = parseRequiredString(targetType, "targetType");

  return z.string().meta({
    [REFERENCE_METADATA_KEY]: {
      targetType: normalizedTargetType,
    },
  });
}

function createFileField(
  preset: MdcmsFileFieldPreset,
  options: MdcmsFileFieldOptions = {},
): MdcmsConcreteFileFieldSchema {
  const accept = normalizeAccept(
    options.accept,
    `fieldTypes.${preset}.accept`,
    preset,
  );
  const required = options.required ?? true;
  const helperDefault =
    options.default === undefined
      ? undefined
      : parseMediaAssetId(
          options.default,
          `fieldTypes.${preset}.default`,
        );

  if (!required && helperDefault !== undefined) {
    throw invalidConfig(
      `fieldTypes.${preset}`,
      'must not combine `required: false` with a helper default.',
    );
  }

  const schema = z.string().meta({
    [FILE_METADATA_KEY]: {
      preset,
      accept,
      emptyStringAsUnset: !required,
    } satisfies MdcmsFileFieldMetadata,
  });

  if (!required) {
    return schema.optional().nullable();
  }

  if (helperDefault !== undefined) {
    return withSchemaMetadata(schema.default(helperDefault), {
      [FILE_HELPER_DEFAULT_METADATA_KEY]: helperDefault,
    });
  }

  return schema;
}

type FileFieldFactory = {
  (): MdcmsPlainFileFieldSchema;
  (
    options: Omit<MdcmsFileFieldOptions, "required" | "default"> & {
      required?: true | undefined;
      default?: undefined;
    },
  ): MdcmsPlainFileFieldSchema;
  (
    options: Omit<MdcmsFileFieldOptions, "default"> & {
      required: false;
      default?: undefined;
    },
  ): MdcmsOptionalFileFieldSchema;
  (
    options: Omit<MdcmsFileFieldOptions, "required"> & {
      required?: true | undefined;
      default: string;
    },
  ): MdcmsDefaultFileFieldSchema;
};

function createImageField(): MdcmsPlainFileFieldSchema;
function createImageField(
  options: Omit<MdcmsFileFieldOptions, "required" | "default"> & {
    required?: true | undefined;
    default?: undefined;
  },
): MdcmsPlainFileFieldSchema;
function createImageField(
  options: Omit<MdcmsFileFieldOptions, "default"> & {
    required: false;
    default?: undefined;
  },
): MdcmsOptionalFileFieldSchema;
function createImageField(
  options: Omit<MdcmsFileFieldOptions, "required"> & {
    required?: true | undefined;
    default: string;
  },
): MdcmsDefaultFileFieldSchema;
function createImageField(options: MdcmsFileFieldOptions = {}) {
  return createFileField("image", options);
}

function createVideoField(): MdcmsPlainFileFieldSchema;
function createVideoField(
  options: Omit<MdcmsFileFieldOptions, "required" | "default"> & {
    required?: true | undefined;
    default?: undefined;
  },
): MdcmsPlainFileFieldSchema;
function createVideoField(
  options: Omit<MdcmsFileFieldOptions, "default"> & {
    required: false;
    default?: undefined;
  },
): MdcmsOptionalFileFieldSchema;
function createVideoField(
  options: Omit<MdcmsFileFieldOptions, "required"> & {
    required?: true | undefined;
    default: string;
  },
): MdcmsDefaultFileFieldSchema;
function createVideoField(options: MdcmsFileFieldOptions = {}) {
  return createFileField("video", options);
}

function createGenericFileField(): MdcmsPlainFileFieldSchema;
function createGenericFileField(
  options: Omit<MdcmsFileFieldOptions, "required" | "default"> & {
    required?: true | undefined;
    default?: undefined;
  },
): MdcmsPlainFileFieldSchema;
function createGenericFileField(
  options: Omit<MdcmsFileFieldOptions, "default"> & {
    required: false;
    default?: undefined;
  },
): MdcmsOptionalFileFieldSchema;
function createGenericFileField(
  options: Omit<MdcmsFileFieldOptions, "required"> & {
    required?: true | undefined;
    default: string;
  },
): MdcmsDefaultFileFieldSchema;
function createGenericFileField(options: MdcmsFileFieldOptions = {}) {
  return createFileField("file", options);
}

export const fieldTypes = {
  reference: createReferenceField,
  image: createImageField as FileFieldFactory,
  video: createVideoField as FileFieldFactory,
  file: createGenericFileField as FileFieldFactory,
} as const;

/**
 * readSupportedLocales safely extracts the set of supported locale codes
 * from a raw config snapshot (as stored in schemaSyncs.rawConfigSnapshot).
 * Returns a Set of locale strings, or undefined if parsing fails or the
 * config uses an implicit (no locales defined) configuration.
 */
export function readSupportedLocales(
  rawConfigSnapshot: unknown,
): Set<string> | undefined {
  try {
    const parsed = parseMdcmsConfig(rawConfigSnapshot);
    if (parsed.locales.implicit) {
      return undefined;
    }
    return new Set(parsed.locales.supported);
  } catch {
    return undefined;
  }
}

export function parseMdcmsConfig(raw: unknown): ParsedMdcmsConfig {
  const config = expectRecord(raw, "config");
  const types = parseTypes(config.types);
  const environments = parseEnvironments(config.environments);
  const contentDirectories = parseContentDirectories(
    config.contentDirectories,
    types,
  );

  return {
    project: parseRequiredString(config.project, "project"),
    serverUrl: parseRequiredString(config.serverUrl, "serverUrl"),
    environment: parseOptionalString(config.environment, "environment"),
    contentDirectories,
    locales: parseLocales(config.locales, types),
    types,
    environments,
    resolvedEnvironments: resolveEnvironments(types, environments),
    components: parseComponents(config.components),
  };
}

function parseTypes(value: unknown): ParsedMdcmsTypeDefinition[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw invalidConfig("types", "must be an array of type definitions.");
  }

  return value.map((entry, index) => {
    const typeConfig = expectRecord(entry, `types[${index}]`);
    const parsedFields = parseFields(
      typeConfig.fields,
      `types[${index}].fields`,
    );

    return {
      name: parseRequiredString(typeConfig.name, `types[${index}].name`),
      directory: normalizeDirectory(
        typeConfig.directory,
        `types[${index}].directory`,
      ),
      localized:
        parseOptionalBoolean(
          typeConfig.localized,
          `types[${index}].localized`,
        ) ?? false,
      fields: parsedFields.fields,
      resolvePreviewUrl: parseOptionalFunction<MdcmsPreviewUrlResolver>(
        typeConfig.resolvePreviewUrl,
        `types[${index}].resolvePreviewUrl`,
      ),
      referenceFields: extractReferenceFields(parsedFields.fields),
      environmentFields: parsedFields.environmentFields,
    };
  });
}

function parseFields(
  value: unknown,
  field: string,
): {
  fields: Record<string, MdcmsFieldSchema>;
  environmentFields: Record<
    string,
    { schema: MdcmsFieldSchema; targets: string[] }
  >;
} {
  const fields = expectRecord(value, field);
  const parsedEntries: [string, MdcmsFieldSchema][] = [];
  const environmentEntries: [
    string,
    { schema: MdcmsFieldSchema; targets: string[] },
  ][] = [];

  for (const [key, schema] of Object.entries(fields).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const schemaField = `${field}.${key}`;

    if (!isStandardSchemaLike(schema)) {
      throw invalidConfig(
        schemaField,
        "must be a Standard Schema-compatible validator.",
      );
    }

    const environmentTargets = findEnvironmentTargets(schema);
    if (environmentTargets) {
      environmentEntries.push([
        key,
        {
          schema,
          targets: environmentTargets,
        },
      ]);
      continue;
    }

    parsedEntries.push([key, schema]);
  }

  return {
    fields: Object.fromEntries(parsedEntries),
    environmentFields: Object.fromEntries(environmentEntries),
  };
}

function parseOverlayFields(
  value: unknown,
  field: string,
): Record<string, MdcmsFieldSchema> {
  if (value === undefined) {
    return {};
  }

  const parsedFields = parseFields(value, field);

  for (const fieldName of Object.keys(parsedFields.environmentFields)) {
    throw invalidConfig(
      `${field}.${fieldName}`,
      "must not use .env() inside overlay field maps; define environment targeting on the base type instead.",
    );
  }

  return parsedFields.fields;
}

function parseEnvironments(
  value: unknown,
): Record<string, ParsedMdcmsEnvironmentDefinition> {
  if (value === undefined) {
    return {};
  }

  const environments = expectRecord(value, "environments");
  const parsedEntries: [string, ParsedMdcmsEnvironmentDefinition][] = [];

  for (const [name, definition] of Object.entries(environments).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalizedName = parseRequiredString(name, `environments.${name}`);
    const environment = expectRecord(
      definition,
      `environments.${normalizedName}`,
    );
    const parsedTypes: [string, ParsedMdcmsTypeOverlay][] = [];
    const typeDefinitions =
      environment.types === undefined
        ? {}
        : expectRecord(
            environment.types,
            `environments.${normalizedName}.types`,
          );

    for (const [typeName, overlay] of Object.entries(typeDefinitions).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const normalizedTypeName = parseRequiredString(
        typeName,
        `environments.${normalizedName}.types.${typeName}`,
      );
      const overlayConfig = expectRecord(
        overlay,
        `environments.${normalizedName}.types.${normalizedTypeName}`,
      );

      parsedTypes.push([
        normalizedTypeName,
        {
          add: parseOverlayFields(
            overlayConfig.add,
            `environments.${normalizedName}.types.${normalizedTypeName}.add`,
          ),
          modify: parseOverlayFields(
            overlayConfig.modify,
            `environments.${normalizedName}.types.${normalizedTypeName}.modify`,
          ),
          omit: parseStringArray(
            overlayConfig.omit,
            `environments.${normalizedName}.types.${normalizedTypeName}.omit`,
          ),
        },
      ]);
    }

    parsedEntries.push([
      normalizedName,
      {
        extends: parseOptionalString(
          environment.extends,
          `environments.${normalizedName}.extends`,
        ),
        types: Object.fromEntries(parsedTypes),
      },
    ]);
  }

  return Object.fromEntries(parsedEntries);
}

function resolveEnvironments(
  types: readonly ParsedMdcmsTypeDefinition[],
  environments: Record<string, ParsedMdcmsEnvironmentDefinition>,
): Record<string, ParsedMdcmsResolvedEnvironment> {
  if (Object.keys(environments).length === 0) {
    return {};
  }

  const baseTypeMap = Object.fromEntries(
    [...types]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((typeConfig) => [
        typeConfig.name,
        toResolvedTypeDefinition(typeConfig),
      ]),
  ) as Record<string, ParsedMdcmsTypeDefinition>;
  const sugarOverlays = expandEnvironmentFieldSugar(types, environments);
  const cache = new Map<string, ParsedMdcmsResolvedEnvironment>();

  function resolveEnvironment(
    name: string,
    chain: string[] = [],
  ): ParsedMdcmsResolvedEnvironment {
    const cached = cache.get(name);
    if (cached) {
      return cached;
    }

    if (chain.includes(name)) {
      throw invalidConfig(
        `environments.${name}.extends`,
        `contains a circular extends chain (${[...chain, name].join(" -> ")}).`,
      );
    }

    const environment = environments[name];
    if (!environment) {
      throw invalidConfig(`environments.${name}`, "must be defined.");
    }

    const inheritedTypes = environment.extends
      ? cloneTypeMap(
          resolveEnvironment(environment.extends, [...chain, name]).types,
        )
      : cloneTypeMap(baseTypeMap);
    const overlays = mergeOverlayMaps(
      name,
      sugarOverlays[name],
      environment.types,
    );

    for (const [typeName, overlay] of Object.entries(overlays).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const currentType = inheritedTypes[typeName] ?? baseTypeMap[typeName];

      if (!currentType) {
        throw invalidConfig(
          `environments.${name}.types.${typeName}`,
          "references a type that is not defined in config.types.",
        );
      }

      inheritedTypes[typeName] = applyTypeOverlay(currentType, overlay, {
        environment: name,
        typeName,
      });
    }

    const resolved: ParsedMdcmsResolvedEnvironment = {
      extends: environment.extends,
      types: Object.fromEntries(
        Object.entries(inheritedTypes).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };

    cache.set(name, resolved);
    return resolved;
  }

  return Object.fromEntries(
    Object.keys(environments)
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [name, resolveEnvironment(name)]),
  );
}

function expandEnvironmentFieldSugar(
  types: readonly ParsedMdcmsTypeDefinition[],
  environments: Record<string, ParsedMdcmsEnvironmentDefinition>,
): Record<string, Record<string, ParsedMdcmsTypeOverlay>> {
  const environmentNames = new Set(Object.keys(environments));
  const expanded: Record<string, Record<string, ParsedMdcmsTypeOverlay>> = {};

  for (const typeConfig of types) {
    for (const [fieldName, fieldDefinition] of Object.entries(
      typeConfig.environmentFields,
    )) {
      for (const target of fieldDefinition.targets) {
        if (!environmentNames.has(target)) {
          continue;
        }

        expanded[target] ??= {};
        expanded[target][typeConfig.name] ??= {
          add: {},
          modify: {},
          omit: [],
        };
        expanded[target][typeConfig.name].add[fieldName] =
          fieldDefinition.schema;
      }
    }
  }

  return expanded;
}

function mergeOverlayMaps(
  environmentName: string,
  left: Record<string, ParsedMdcmsTypeOverlay> | undefined,
  right: Record<string, ParsedMdcmsTypeOverlay>,
): Record<string, ParsedMdcmsTypeOverlay> {
  const merged: Record<string, ParsedMdcmsTypeOverlay> = {};
  const typeNames = new Set([
    ...Object.keys(left ?? {}),
    ...Object.keys(right),
  ]);

  for (const typeName of [...typeNames].sort((a, b) => a.localeCompare(b))) {
    const leftAdd = left?.[typeName]?.add ?? {};
    const rightAdd = right[typeName]?.add ?? {};

    for (const fieldName of Object.keys(leftAdd)) {
      if (fieldName in rightAdd) {
        throw invalidConfig(
          `environments.${environmentName}.types.${typeName}.add.${fieldName}`,
          "conflicts with field-level .env() sugar; keep one source of truth for this added field.",
        );
      }
    }

    merged[typeName] = {
      add: {
        ...leftAdd,
        ...rightAdd,
      },
      modify: {
        ...(left?.[typeName]?.modify ?? {}),
        ...(right[typeName]?.modify ?? {}),
      },
      omit: uniqueStrings([
        ...(left?.[typeName]?.omit ?? []),
        ...(right[typeName]?.omit ?? []),
      ]).sort((a, b) => a.localeCompare(b)),
    };
  }

  return merged;
}

function toResolvedTypeDefinition(
  typeConfig: ParsedMdcmsTypeDefinition,
): ParsedMdcmsTypeDefinition {
  const fields = Object.fromEntries(
    Object.entries(typeConfig.fields).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

  return {
    name: typeConfig.name,
    directory: typeConfig.directory,
    localized: typeConfig.localized,
    fields,
    ...(typeConfig.resolvePreviewUrl
      ? { resolvePreviewUrl: typeConfig.resolvePreviewUrl }
      : {}),
    referenceFields: extractReferenceFields(fields),
    environmentFields: {},
  };
}

function cloneTypeMap(
  typeMap: Record<string, ParsedMdcmsTypeDefinition>,
): Record<string, ParsedMdcmsTypeDefinition> {
  return Object.fromEntries(
    Object.entries(typeMap).map(([typeName, typeConfig]) => [
      typeName,
      toResolvedTypeDefinition(typeConfig),
    ]),
  );
}

function applyTypeOverlay(
  typeConfig: ParsedMdcmsTypeDefinition,
  overlay: ParsedMdcmsTypeOverlay,
  context?: { environment: string; typeName: string },
): ParsedMdcmsTypeDefinition {
  const fields = {
    ...typeConfig.fields,
  };

  for (const [fieldName, schema] of Object.entries(overlay.add)) {
    if (fieldName in fields) {
      throw invalidConfig(
        `environments.${context?.environment}.types.${context?.typeName}.add.${fieldName}`,
        "cannot add a field that already exists in the inherited schema.",
      );
    }

    fields[fieldName] = schema;
  }

  for (const [fieldName, schema] of Object.entries(overlay.modify)) {
    if (!(fieldName in fields)) {
      throw invalidConfig(
        `environments.${context?.environment}.types.${context?.typeName}.modify.${fieldName}`,
        "cannot modify a field that does not exist in the inherited schema.",
      );
    }

    fields[fieldName] = schema;
  }

  for (const fieldName of overlay.omit) {
    if (!(fieldName in fields)) {
      throw invalidConfig(
        `environments.${context?.environment}.types.${context?.typeName}.omit`,
        `cannot omit unknown field "${fieldName}".`,
      );
    }

    delete fields[fieldName];
  }

  return {
    ...typeConfig,
    fields: Object.fromEntries(
      Object.entries(fields).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    referenceFields: extractReferenceFields(fields),
    environmentFields: {},
  };
}

function parseComponents(value: unknown): ParsedMdcmsComponentRegistration[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw invalidConfig("components", "must be an array.");
  }

  return value.map((entry, index) => {
    const component = expectRecord(entry, `components[${index}]`);
    const propHints = parseMdxPropHints(
      component.propHints,
      `components[${index}].propHints`,
    );

    // Runtime loader callbacks are host-local Studio concerns, so the shared parser
    // intentionally strips them and keeps only serializable component metadata.
    const parsedComponent: ParsedMdcmsComponentRegistration = {
      name: parseRequiredString(component.name, `components[${index}].name`),
      importPath: parseRequiredString(
        component.importPath,
        `components[${index}].importPath`,
      ),
    };

    const description = parseOptionalString(
      component.description,
      `components[${index}].description`,
    );
    const propsEditor = parseOptionalString(
      component.propsEditor,
      `components[${index}].propsEditor`,
    );

    if (description !== undefined) {
      parsedComponent.description = description;
    }

    if (propHints !== undefined) {
      parsedComponent.propHints = propHints;
    }

    if (propsEditor !== undefined) {
      parsedComponent.propsEditor = propsEditor;
    }

    return parsedComponent;
  });
}

function parseContentDirectories(
  value: unknown,
  types: readonly ParsedMdcmsTypeDefinition[],
): string[] {
  if (value === undefined) {
    if (types.some((typeConfig) => typeConfig.directory !== undefined)) {
      throw invalidConfig(
        "contentDirectories",
        "is required when type directories are configured.",
      );
    }

    return [];
  }

  if (!Array.isArray(value)) {
    throw invalidConfig("contentDirectories", "must be an array.");
  }

  const normalizedDirectories = uniqueStrings(
    value.map((entry, index) => {
      const directory = normalizeDirectory(
        entry,
        `contentDirectories[${index}]`,
        true,
      );

      if (directory === undefined) {
        throw invalidConfig(
          `contentDirectories[${index}]`,
          "must resolve to a non-empty path.",
        );
      }

      return directory;
    }),
    "contentDirectories",
  );

  for (const typeConfig of types) {
    const typeDirectory = typeConfig.directory;

    if (!typeDirectory) {
      continue;
    }

    const covered = normalizedDirectories.some(
      (directory) =>
        directory === typeDirectory ||
        typeDirectory.startsWith(`${directory}/`),
    );

    if (!covered) {
      throw invalidConfig(
        "contentDirectories",
        `must include a directory that covers type "${typeConfig.name}" at "${typeDirectory}".`,
      );
    }
  }

  return normalizedDirectories;
}

function parseLocales(
  value: unknown,
  types: readonly ParsedMdcmsTypeDefinition[],
): ParsedMdcmsLocaleConfig {
  const localizedTypes = types.filter((typeConfig) => typeConfig.localized);

  if (value === undefined) {
    if (localizedTypes.length > 0) {
      throw invalidConfig(
        "locales",
        `is required when localized types are configured (${localizedTypes
          .map((typeConfig) => typeConfig.name)
          .join(", ")}).`,
      );
    }

    return {
      default: IMPLICIT_DEFAULT_LOCALE,
      supported: [IMPLICIT_DEFAULT_LOCALE],
      aliases: {},
      implicit: true,
    };
  }

  const locales = expectRecord(value, "locales");
  const supported = parseSupportedLocales(locales.supported);

  if (supported.length === 0) {
    throw invalidConfig(
      "locales.supported",
      "must contain at least one locale.",
    );
  }

  const defaultLocale = normalizeLocale(
    locales.default,
    "locales.default",
    false,
  );

  if (!supported.includes(defaultLocale)) {
    throw invalidConfig(
      "locales.default",
      "must resolve to an entry in locales.supported.",
    );
  }

  const aliases = parseLocaleAliases(locales.aliases, supported);

  return {
    default: defaultLocale,
    supported,
    aliases,
    implicit: false,
  };
}

function parseSupportedLocales(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw invalidConfig("locales.supported", "must be an array.");
  }

  return uniqueStrings(
    value.map((entry, index) =>
      normalizeLocale(entry, `locales.supported[${index}]`, false),
    ),
    "locales.supported",
  );
}

function parseLocaleAliases(
  value: unknown,
  supported: readonly string[],
): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const aliases = expectRecord(value, "locales.aliases");
  const normalizedEntries: [string, string][] = [];

  for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
    const normalizedAlias = normalizeLocale(
      rawAlias,
      `locales.aliases.${rawAlias}`,
      false,
    );
    const normalizedTarget = normalizeLocale(
      rawTarget,
      `locales.aliases.${rawAlias}`,
      false,
    );

    if (!supported.includes(normalizedTarget)) {
      throw invalidConfig(
        `locales.aliases.${rawAlias}`,
        `must resolve to one of locales.supported (${supported.join(", ")}).`,
      );
    }

    normalizedEntries.push([normalizedAlias, normalizedTarget]);
  }

  normalizedEntries.sort(([left], [right]) => left.localeCompare(right));
  const result: Record<string, string> = {};

  for (const [alias, target] of normalizedEntries) {
    if (alias in result) {
      throw invalidConfig(
        "locales.aliases",
        `contains duplicate alias key after normalization ("${alias}").`,
      );
    }

    result[alias] = target;
  }

  return result;
}

function extractReferenceFields(
  fields: Record<string, MdcmsFieldSchema>,
): Record<string, MdcmsReferenceMetadata> {
  const referenceEntries = Object.entries(fields).flatMap(([name, schema]) => {
    const metadata = findReferenceMetadata(schema);
    return metadata ? ([[name, metadata]] as const) : [];
  });

  return Object.fromEntries(referenceEntries);
}

function findEnvironmentTargets(
  schema: MdcmsFieldSchema,
): string[] | undefined {
  const stack: unknown[] = [schema];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    const meta = readSchemaMetadata(current);
    const candidate = isPlainObject(meta)
      ? meta[ENVIRONMENT_TARGETS_METADATA_KEY]
      : undefined;

    if (
      Array.isArray(candidate) &&
      candidate.every((entry) => typeof entry === "string")
    ) {
      return [...candidate].sort((left, right) => left.localeCompare(right));
    }

    const definition = (current as { _def?: unknown })._def;

    if (isPlainObject(definition)) {
      for (const value of Object.values(definition)) {
        stack.push(value);
      }
    }
  }

  return undefined;
}

function findReferenceMetadata(
  schema: MdcmsFieldSchema,
): MdcmsReferenceMetadata | undefined {
  const stack: unknown[] = [schema];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }

    seen.add(current);

    const meta = readSchemaMetadata(current);
    const candidate = isPlainObject(meta)
      ? meta[REFERENCE_METADATA_KEY]
      : undefined;

    if (isPlainObject(candidate) && typeof candidate.targetType === "string") {
      return {
        targetType: candidate.targetType,
      };
    }

    const definition = (current as { _def?: unknown })._def;

    if (isPlainObject(definition)) {
      for (const value of Object.values(definition)) {
        stack.push(value);
      }
    }
  }

  return undefined;
}

function withSchemaMetadata<TSchema extends z.ZodType>(
  schema: TSchema,
  metadata: Record<string, unknown>,
): TSchema {
  const existingMetadata = readSchemaMetadata(schema as object);

  return schema.meta({
    ...(isPlainObject(existingMetadata) ? existingMetadata : {}),
    ...metadata,
  }) as TSchema;
}

function readSchemaMetadata(value: object): unknown {
  const candidate = value as { meta?: () => unknown };
  return typeof candidate.meta === "function" ? candidate.meta() : undefined;
}

function normalizeAccept(
  value: unknown,
  field: string,
  preset: MdcmsFileFieldPreset,
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw invalidConfig(field, "must be an array of MIME type strings.");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const acceptValue = parseRequiredString(entry, `${field}[${index}]`)
      .toLowerCase();

    if (!MIME_ACCEPT_PATTERN.test(acceptValue)) {
      throw invalidConfig(
        `${field}[${index}]`,
        "must be a valid MIME type or wildcard.",
      );
    }

    if (preset !== "file" && !acceptValue.startsWith(`${preset}/`)) {
      throw invalidConfig(
        `${field}[${index}]`,
        `must stay within the ${preset}/* MIME family.`,
      );
    }

    if (seen.has(acceptValue)) {
      return;
    }

    seen.add(acceptValue);
    normalized.push(acceptValue);
  });

  return normalized.sort((left, right) => left.localeCompare(right));
}

function parseMediaAssetId(value: unknown, field: string): string {
  const mediaAssetId = parseRequiredString(value, field);

  if (
    mediaAssetId.includes("://") ||
    mediaAssetId.startsWith("/") ||
    mediaAssetId.startsWith("./") ||
    mediaAssetId.startsWith("../")
  ) {
    throw invalidConfig(field, "must be a raw media asset id string.");
  }

  return mediaAssetId;
}

function isStandardSchemaLike(value: unknown): value is MdcmsFieldSchema {
  if (!isPlainObject(value)) {
    return false;
  }

  const standard = value["~standard"];

  return (
    isPlainObject(standard) &&
    standard.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

function normalizeLocale(
  value: unknown,
  field: string,
  allowImplicitToken: boolean,
): string {
  const rawValue = parseRequiredString(value, field);

  if (rawValue === IMPLICIT_DEFAULT_LOCALE) {
    if (allowImplicitToken) {
      return rawValue;
    }

    throw invalidConfig(
      field,
      `must not use the reserved token "${IMPLICIT_DEFAULT_LOCALE}".`,
    );
  }

  const raw = rawValue.replaceAll("_", "-");

  try {
    return new Intl.Locale(raw).toString();
  } catch {
    throw invalidConfig(field, "must be a valid BCP 47 locale tag.");
  }
}

function normalizeDirectory(
  value: unknown,
  field: string,
  required = false,
): string | undefined {
  const normalized = required
    ? parseRequiredString(value, field)
    : parseOptionalString(value, field);

  if (normalized === undefined) {
    return undefined;
  }

  const sanitized = normalized
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

  if (sanitized.length === 0) {
    throw invalidConfig(field, "must resolve to a non-empty path.");
  }

  return sanitized;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalidConfig(field, "must be a string.");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw invalidConfig(field, "must not be empty.");
  }

  return trimmed;
}

function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseRequiredString(value, field);
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw invalidConfig(field, "must be a boolean.");
  }

  return value;
}

function parseOptionalFunction<TFunction extends (...args: never[]) => unknown>(
  value: unknown,
  field: string,
): TFunction | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "function") {
    throw invalidConfig(field, "must be a function.");
  }

  return value as TFunction;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw invalidConfig(field, "must be an array.");
  }

  return uniqueStrings(
    value.map((entry, index) =>
      parseRequiredString(entry, `${field}[${index}]`),
    ),
    field,
  ).sort((left, right) => left.localeCompare(right));
}

function uniqueStrings(values: readonly string[], field?: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      if (field) {
        throw invalidConfig(
          field,
          `contains duplicate value after normalization ("${value}").`,
        );
      }

      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value) || Array.isArray(value)) {
    throw invalidConfig(field, "must be an object.");
  }

  return value as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidConfig(field: string, message: string): RuntimeError {
  return new RuntimeError({
    code: "INVALID_CONFIG",
    message: `Config field "${field}" ${message}`,
    statusCode: 400,
    details: { field },
  });
}

function installEnvMethod(): void {
  if (envMethodInstalled) {
    return;
  }

  for (const [key, value] of Object.entries(z)) {
    if (
      !/^_?Zod/.test(key) ||
      typeof value !== "function" ||
      typeof value.prototype !== "object" ||
      value.prototype === null ||
      "env" in value.prototype
    ) {
      continue;
    }

    Object.defineProperty(value.prototype, "env", {
      configurable: true,
      enumerable: false,
      writable: true,
      value(this: z.ZodType, ...targets: string[]) {
        const existingMetadata = readSchemaMetadata(this);
        const mergedMetadata = {
          ...(isPlainObject(existingMetadata) ? existingMetadata : {}),
          [ENVIRONMENT_TARGETS_METADATA_KEY]: uniqueStrings(
            targets.map((target, index) =>
              parseRequiredString(target, `env[${index}]`),
            ),
            "env",
          ).sort((left, right) => left.localeCompare(right)),
        };

        return this.meta(mergedMetadata);
      },
    });
  }

  envMethodInstalled = true;
}
