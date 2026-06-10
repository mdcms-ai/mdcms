import {
  type MdcmsFileFieldMetadata,
  type MdcmsFieldSchema,
  type ParsedMdcmsConfig,
  type ParsedMdcmsTypeDefinition,
} from "./config.js";
import { RuntimeError } from "../runtime/error.js";

const FILE_METADATA_KEY = "mdcms:file";
const FILE_HELPER_DEFAULT_METADATA_KEY = "mdcms:file-helper-default";
const MIME_ACCEPT_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;

type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export type SchemaRegistryFieldSnapshot = {
  kind: string;
  required: boolean;
  nullable: boolean;
  default?: JsonValue;
  reference?: {
    targetType: string;
  };
  file?: MdcmsFileFieldMetadata;
  checks?: JsonObject[];
  item?: SchemaRegistryFieldSnapshot;
  fields?: Record<string, SchemaRegistryFieldSnapshot>;
  options?: JsonValue[];
};

export type SchemaRegistryTypeSnapshot = {
  type: string;
  directory: string;
  localized: boolean;
  fields: Record<string, SchemaRegistryFieldSnapshot>;
};

export type SchemaRegistryEntry = {
  type: string;
  directory: string;
  localized: boolean;
  schemaHash: string;
  syncedAt: string;
  resolvedSchema: SchemaRegistryTypeSnapshot;
};

export type SchemaRegistryListResponse = {
  types: SchemaRegistryEntry[];
  schemaHash: string | null;
  syncedAt: string | null;
  project?: string;
};

export function validateSchemaRegistryListResponse(
  context: string,
  payload: unknown,
): SchemaRegistryListResponse {
  if (!isRecord(payload)) {
    invalidInput(context, "must be an object.", { payload });
  }
  const types = payload.types;
  if (!Array.isArray(types)) {
    invalidInput(`${context}.types`, "must be an array.", { types });
  }
  const schemaHash = payload.schemaHash;
  if (schemaHash !== null && typeof schemaHash !== "string") {
    invalidInput(`${context}.schemaHash`, "must be string or null.", {
      schemaHash,
    });
  }
  const syncedAt = payload.syncedAt;
  if (syncedAt !== null && typeof syncedAt !== "string") {
    invalidInput(`${context}.syncedAt`, "must be string or null.", {
      syncedAt,
    });
  }
  const project = payload.project;
  if (
    project !== undefined &&
    (typeof project !== "string" || project.trim() === "")
  ) {
    invalidInput(
      `${context}.project`,
      "must be a non-empty string or undefined.",
      {
        project,
      },
    );
  }
  types.forEach((entry, index) => {
    assertSchemaRegistryEntry(entry, `${context}.types[${index}]`);
  });
  return payload as SchemaRegistryListResponse;
}

export type SchemaRegistrySyncPayload = {
  rawConfigSnapshot: JsonObject;
  resolvedSchema: Record<string, SchemaRegistryTypeSnapshot>;
  schemaHash: string;
};

export type SchemaRegistrySyncPayloadBase = Omit<
  SchemaRegistrySyncPayload,
  "schemaHash"
>;

export type SchemaRegistrySyncHashInput = SchemaRegistrySyncPayloadBase & {
  environment: string;
};

type SerializerContext = {
  required: boolean;
  nullable: boolean;
  defaultValue?: JsonValue;
};

const DEFAULT_SERIALIZER_CONTEXT: SerializerContext = {
  required: true,
  nullable: false,
};

function invalidInput(
  path: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: `${path} ${message}`,
    statusCode: 400,
    details: {
      path,
      ...(details ?? {}),
    },
  });
}

function invalidConfig(
  field: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new RuntimeError({
    code: "INVALID_CONFIG",
    message: `Config field "${field}" ${message}`,
    statusCode: 400,
    details: {
      field,
      ...(details ?? {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput(path, "must be a non-empty string.", { value });
  }
}

export function assertJsonValue(
  value: unknown,
  path = "value",
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidInput(path, "must be a finite JSON number.", { value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertJsonValue(entry, `${path}[${index}]`);
    });
    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`);
    }
    return;
  }

  invalidInput(path, "must be JSON-serializable.", {
    valueType: typeof value,
  });
}

export function assertJsonObject(
  value: unknown,
  path = "value",
): asserts value is JsonObject {
  if (!isRecord(value)) {
    invalidInput(path, "must be an object.", {
      valueType: Array.isArray(value) ? "array" : typeof value,
    });
  }

  assertJsonValue(value, path);
}

export function stableStringifyJson(value: JsonValue): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${stableStringifyJson(entry)}`,
    )
    .join(",")}}`;
}

function readSchemaMetadata(value: object): unknown {
  const candidate = value as { meta?: () => unknown };
  return typeof candidate.meta === "function" ? candidate.meta() : undefined;
}

function readDirectReferenceMetadata(
  schema: MdcmsFieldSchema,
): SchemaRegistryFieldSnapshot["reference"] | undefined {
  const meta = readSchemaMetadata(schema as object);
  const candidate = isRecord(meta) ? meta["mdcms:reference"] : undefined;

  if (!isRecord(candidate) || typeof candidate.targetType !== "string") {
    return undefined;
  }

  return {
    targetType: candidate.targetType,
  };
}

function readDirectFileMetadata(
  schema: MdcmsFieldSchema,
): MdcmsFileFieldMetadata | undefined {
  const meta = readSchemaMetadata(schema as object);
  const candidate = isRecord(meta) ? meta[FILE_METADATA_KEY] : undefined;

  if (!isRecord(candidate)) {
    return undefined;
  }

  const preset = candidate.preset;
  const accept = candidate.accept;
  const emptyStringAsUnset = candidate.emptyStringAsUnset;

  if (
    (preset !== "image" && preset !== "video" && preset !== "file") ||
    !Array.isArray(accept) ||
    !accept.every(
      (entry) => typeof entry === "string" && MIME_ACCEPT_PATTERN.test(entry),
    ) ||
    typeof emptyStringAsUnset !== "boolean"
  ) {
    return undefined;
  }

  return {
    preset,
    accept: [...accept],
    emptyStringAsUnset,
  };
}

function readHelperFileDefaultMetadata(schema: MdcmsFieldSchema): string | undefined {
  const meta = readSchemaMetadata(schema as object);
  const candidate = isRecord(meta)
    ? meta[FILE_HELPER_DEFAULT_METADATA_KEY]
    : undefined;

  return typeof candidate === "string" ? candidate : undefined;
}

function assertMediaAssetId(value: JsonValue, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidConfig(path, "must be a raw media asset id string.");
  }

  if (
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    invalidConfig(path, "must be a raw media asset id string.");
  }

  return value;
}

function assertSnapshotMediaAssetId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput(path, "must be a raw media asset id string.", { value });
  }

  if (
    value.includes("://") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    invalidInput(path, "must be a raw media asset id string.", { value });
  }

  return value;
}

function assertNormalizedFileAccept(
  value: unknown,
  path: string,
  preset: MdcmsFileFieldMetadata["preset"],
): asserts value is string[] {
  if (!Array.isArray(value)) {
    invalidInput(path, "must be an array.", { value });
  }

  const normalized = [...value]
    .map((entry, index) => {
      if (typeof entry !== "string" || !MIME_ACCEPT_PATTERN.test(entry)) {
        invalidInput(
          `${path}[${index}]`,
          "must be a valid MIME type or wildcard.",
          { value: entry },
        );
      }

      if (preset !== "file" && !entry.startsWith(`${preset}/`)) {
        invalidInput(
          path,
          `must stay within the ${preset}/* MIME family.`,
          { value },
        );
      }

      return entry;
    })
    .sort((left, right) => left.localeCompare(right));

  if (normalized.length !== value.length) {
    invalidInput(
      path,
      "must be normalized: lowercase, sorted, and deduplicated.",
      { value },
    );
  }

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const expected = normalized[index];

    if (
      typeof current !== "string" ||
      current !== current.toLowerCase() ||
      current !== expected ||
      (index > 0 && current === value[index - 1])
    ) {
      invalidInput(
        path,
        "must be normalized: lowercase, sorted, and deduplicated.",
        { value },
      );
    }
  }
}

function assertFieldSnapshot(
  value: unknown,
  path: string,
): asserts value is SchemaRegistryFieldSnapshot {
  if (!isRecord(value)) {
    invalidInput(path, "must be an object.");
  }

  assertNonEmptyString(value.kind, `${path}.kind`);

  if (typeof value.required !== "boolean") {
    invalidInput(`${path}.required`, "must be a boolean.", {
      value: value.required,
    });
  }

  if (typeof value.nullable !== "boolean") {
    invalidInput(`${path}.nullable`, "must be a boolean.", {
      value: value.nullable,
    });
  }

  if (value.default !== undefined) {
    assertJsonValue(value.default, `${path}.default`);
  }

  if (value.reference !== undefined) {
    if (!isRecord(value.reference)) {
      invalidInput(`${path}.reference`, "must be an object.");
    }
    assertNonEmptyString(
      value.reference.targetType,
      `${path}.reference.targetType`,
    );
  }

  if (value.file !== undefined) {
    if (!isRecord(value.file)) {
      invalidInput(`${path}.file`, "must be an object.");
    }

    if (
      value.file.preset !== "image" &&
      value.file.preset !== "video" &&
      value.file.preset !== "file"
    ) {
      invalidInput(
        `${path}.file.preset`,
        'must be "image", "video", or "file".',
        { value: value.file.preset },
      );
    }

    assertNormalizedFileAccept(
      value.file.accept,
      `${path}.file.accept`,
      value.file.preset,
    );

    if (typeof value.file.emptyStringAsUnset !== "boolean") {
      invalidInput(
        `${path}.file.emptyStringAsUnset`,
        "must be a boolean.",
        { value: value.file.emptyStringAsUnset },
      );
    }
  }

  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks)) {
      invalidInput(`${path}.checks`, "must be an array when provided.");
    }
    value.checks.forEach((entry, index) =>
      assertJsonObject(entry, `${path}.checks[${index}]`),
    );
  }

  if (value.item !== undefined) {
    assertFieldSnapshot(value.item, `${path}.item`);
  }

  if (value.fields !== undefined) {
    if (!isRecord(value.fields)) {
      invalidInput(`${path}.fields`, "must be an object when provided.");
    }
    for (const [fieldName, entry] of Object.entries(value.fields)) {
      assertFieldSnapshot(entry, `${path}.fields.${fieldName}`);
    }
  }

  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) {
      invalidInput(`${path}.options`, "must be an array when provided.");
    }
    value.options.forEach((entry, index) =>
      assertJsonValue(entry, `${path}.options[${index}]`),
    );
  }

  if (value.file !== undefined && value.kind !== "string") {
    invalidInput(
      `${path}.file`,
      'must not be provided when kind is not "string".',
    );
  }

  if (value.file !== undefined && value.default !== undefined) {
    assertSnapshotMediaAssetId(value.default, `${path}.default`);
  }

  switch (value.kind) {
    case "array":
      if (value.item === undefined) {
        invalidInput(`${path}.item`, 'must be defined when kind is "array".');
      }
      if (value.fields !== undefined) {
        invalidInput(
          `${path}.fields`,
          'must not be provided when kind is "array".',
        );
      }
      if (value.options !== undefined) {
        invalidInput(
          `${path}.options`,
          'must not be provided when kind is "array".',
        );
      }
      break;
    case "object":
      if (value.fields === undefined) {
        invalidInput(
          `${path}.fields`,
          'must be defined when kind is "object".',
        );
      }
      if (value.item !== undefined) {
        invalidInput(
          `${path}.item`,
          'must not be provided when kind is "object".',
        );
      }
      if (value.options !== undefined) {
        invalidInput(
          `${path}.options`,
          'must not be provided when kind is "object".',
        );
      }
      break;
    case "enum":
    case "literal":
      if (value.options === undefined) {
        invalidInput(
          `${path}.options`,
          `must be defined when kind is "${value.kind}".`,
        );
      }
      if (value.item !== undefined) {
        invalidInput(
          `${path}.item`,
          `must not be provided when kind is "${value.kind}".`,
        );
      }
      if (value.fields !== undefined) {
        invalidInput(
          `${path}.fields`,
          `must not be provided when kind is "${value.kind}".`,
        );
      }
      break;
    default:
      if (value.item !== undefined) {
        invalidInput(
          `${path}.item`,
          `must not be provided when kind is "${value.kind}".`,
        );
      }
      if (value.fields !== undefined) {
        invalidInput(
          `${path}.fields`,
          `must not be provided when kind is "${value.kind}".`,
        );
      }
      if (value.options !== undefined) {
        invalidInput(
          `${path}.options`,
          `must not be provided when kind is "${value.kind}".`,
        );
      }
      break;
  }
}

export function assertSchemaRegistryTypeSnapshot(
  value: unknown,
  path = "schema",
): asserts value is SchemaRegistryTypeSnapshot {
  if (!isRecord(value)) {
    invalidInput(path, "must be an object.");
  }

  assertNonEmptyString(value.type, `${path}.type`);

  assertNonEmptyString(value.directory, `${path}.directory`);

  if (typeof value.localized !== "boolean") {
    invalidInput(`${path}.localized`, "must be a boolean.", {
      value: value.localized,
    });
  }

  if (!isRecord(value.fields)) {
    invalidInput(`${path}.fields`, "must be an object.");
  }

  for (const [fieldName, entry] of Object.entries(value.fields)) {
    assertFieldSnapshot(entry, `${path}.fields.${fieldName}`);
  }
}

export function assertSchemaRegistryEntry(
  value: unknown,
  path = "entry",
): asserts value is SchemaRegistryEntry {
  if (!isRecord(value)) {
    invalidInput(path, "must be an object.");
  }

  assertNonEmptyString(value.type, `${path}.type`);

  assertNonEmptyString(value.directory, `${path}.directory`);

  if (typeof value.localized !== "boolean") {
    invalidInput(`${path}.localized`, "must be a boolean.", {
      value: value.localized,
    });
  }

  assertNonEmptyString(value.schemaHash, `${path}.schemaHash`);
  assertNonEmptyString(value.syncedAt, `${path}.syncedAt`);
  assertSchemaRegistryTypeSnapshot(
    value.resolvedSchema,
    `${path}.resolvedSchema`,
  );

  if (value.resolvedSchema.type !== value.type) {
    invalidInput(`${path}.resolvedSchema.type`, "must match entry.type.", {
      entryType: value.type,
      resolvedType: value.resolvedSchema.type,
    });
  }

  if (value.resolvedSchema.directory !== value.directory) {
    invalidInput(
      `${path}.resolvedSchema.directory`,
      "must match entry.directory.",
      {
        entryDirectory: value.directory,
        resolvedDirectory: value.resolvedSchema.directory,
      },
    );
  }

  if (value.resolvedSchema.localized !== value.localized) {
    invalidInput(
      `${path}.resolvedSchema.localized`,
      "must match entry.localized.",
      {
        entryLocalized: value.localized,
        resolvedLocalized: value.resolvedSchema.localized,
      },
    );
  }
}

export function assertSchemaRegistrySyncPayload(
  value: unknown,
  path = "payload",
): asserts value is SchemaRegistrySyncPayload {
  if (!isRecord(value)) {
    invalidInput(path, "must be an object.");
  }

  if ("extractedComponents" in value) {
    invalidInput(
      `${path}.extractedComponents`,
      "is no longer supported in schema sync payloads.",
    );
  }

  assertJsonObject(value.rawConfigSnapshot, `${path}.rawConfigSnapshot`);

  if (!isRecord(value.resolvedSchema)) {
    invalidInput(`${path}.resolvedSchema`, "must be an object.", {
      valueType: Array.isArray(value.resolvedSchema)
        ? "array"
        : typeof value.resolvedSchema,
    });
  }

  for (const [typeName, entry] of Object.entries(value.resolvedSchema)) {
    assertSchemaRegistryTypeSnapshot(
      entry,
      `${path}.resolvedSchema.${typeName}`,
    );

    if (entry.type !== typeName) {
      invalidInput(
        `${path}.resolvedSchema.${typeName}.type`,
        "must match the resolvedSchema map key.",
        {
          mapKey: typeName,
          resolvedType: entry.type,
        },
      );
    }
  }

  assertNonEmptyString(value.schemaHash, `${path}.schemaHash`);
}

function readZodDefinition(
  schema: MdcmsFieldSchema,
  path: string,
): Record<string, unknown> {
  const zodLike = schema as {
    _zod?: { def?: Record<string, unknown> };
    _def?: Record<string, unknown>;
  };

  const definition = zodLike._zod?.def ?? zodLike._def;
  if (!isRecord(definition) || typeof definition.type !== "string") {
    invalidInput(
      path,
      "must use a Zod-backed validator supported by schema registry serialization.",
    );
  }

  return definition;
}

function readDefaultValue(value: unknown, path: string): JsonValue {
  assertJsonValue(value, path);
  return value;
}

function sanitizeCheckDefinition(value: unknown, path: string): JsonObject {
  const zodDefinition = (value as { _zod?: { def?: unknown } } | undefined)
    ?._zod?.def;
  const legacyDefinition = (value as { _def?: unknown } | undefined)?._def;
  const definition = isRecord(zodDefinition)
    ? zodDefinition
    : isRecord(legacyDefinition)
      ? legacyDefinition
      : isRecord(value)
        ? value
        : undefined;

  if (!definition) {
    invalidInput(path, "contains an unsupported check definition.");
  }

  if (definition.check === "custom" || definition.type === "custom") {
    invalidInput(
      path,
      "uses an unsupported executable validator feature that cannot be serialized losslessly.",
    );
  }

  const sanitized: JsonObject = {};

  for (const [key, entry] of Object.entries(definition)) {
    if (typeof entry === "function") {
      continue;
    }

    if (entry instanceof RegExp) {
      if (key === "pattern") {
        sanitized.pattern = entry.source;
        if (entry.flags.length > 0) {
          sanitized.flags = entry.flags;
        }
        continue;
      }

      sanitized[key] = {
        pattern: entry.source,
        flags: entry.flags,
      };
      continue;
    }

    if (key === "check") {
      sanitized.kind = String(entry);
      continue;
    }

    assertJsonValue(entry, `${path}.${key}`);
    sanitized[key] = entry;
  }

  return sanitized;
}

function serializeChecks(
  checks: unknown,
  path: string,
): JsonObject[] | undefined {
  if (checks === undefined) {
    return undefined;
  }

  if (!Array.isArray(checks)) {
    invalidInput(path, "must be an array when present.");
  }

  const serialized = checks.map((entry, index) =>
    sanitizeCheckDefinition(entry, `${path}[${index}]`),
  );

  return serialized.length > 0 ? serialized : undefined;
}

function withFieldSnapshotBase(
  kind: string,
  context: SerializerContext,
  extra: Omit<
    SchemaRegistryFieldSnapshot,
    "kind" | "required" | "nullable"
  > = {},
): SchemaRegistryFieldSnapshot {
  const snapshot: SchemaRegistryFieldSnapshot = {
    kind,
    required: context.required,
    nullable: context.nullable,
  };

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      (snapshot as Record<string, unknown>)[key] = value;
    }
  }

  if (context.defaultValue !== undefined) {
    snapshot.default = context.defaultValue;
  }

  if (extra.reference !== undefined) {
    snapshot.reference = extra.reference;
  }

  return snapshot;
}

function serializeFieldSchema(
  schema: MdcmsFieldSchema,
  path: string,
  context: SerializerContext = DEFAULT_SERIALIZER_CONTEXT,
): SchemaRegistryFieldSnapshot {
  const definition = readZodDefinition(schema, path);
  const type = String(definition.type);

  if (type === "optional") {
    return serializeFieldSchema(
      definition.innerType as MdcmsFieldSchema,
      path,
      {
        ...context,
        required: false,
      },
    );
  }

  if (type === "nullable") {
    return serializeFieldSchema(
      definition.innerType as MdcmsFieldSchema,
      path,
      {
        ...context,
        nullable: true,
      },
    );
  }

  if (type === "default") {
    const helperDefaultValue = readHelperFileDefaultMetadata(schema);
    return serializeFieldSchema(
      definition.innerType as MdcmsFieldSchema,
      path,
      {
        ...context,
        required: false,
        defaultValue: (() => {
          const defaultValue = readDefaultValue(
            definition.defaultValue,
            `${path}.default`,
          );

          if (
            helperDefaultValue !== undefined &&
            defaultValue !== helperDefaultValue
          ) {
            invalidConfig(
              path,
              "helper and Zod defaults must agree on the same raw media asset id.",
            );
          }

          if (
            helperDefaultValue !== undefined &&
            context.defaultValue !== undefined &&
            context.defaultValue !== helperDefaultValue
          ) {
            invalidConfig(
              path,
              "helper and Zod defaults must agree on the same raw media asset id.",
            );
          }

          return context.defaultValue ?? defaultValue;
        })(),
      },
    );
  }

  if (type === "pipe") {
    invalidInput(
      path,
      "uses an unsupported executable validator feature that cannot be serialized losslessly.",
    );
  }

  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "date"
  ) {
    const fileMetadata = readDirectFileMetadata(schema);

    if (fileMetadata !== undefined) {
      if (type !== "string") {
        invalidConfig(path, 'must apply file helpers only to string fields.');
      }

      if (fileMetadata.emptyStringAsUnset && context.defaultValue !== undefined) {
        invalidConfig(
          path,
          'must not combine `required: false` file helpers with helper or Zod defaults.',
        );
      }

      if (context.defaultValue !== undefined) {
        context = {
          ...context,
          defaultValue: assertMediaAssetId(context.defaultValue, `${path}.default`),
        };
      }
    }

    return withFieldSnapshotBase(type, context, {
      checks: serializeChecks(definition.checks, `${path}.checks`),
      reference: readDirectReferenceMetadata(schema),
      file: fileMetadata,
    });
  }

  if (type === "array") {
    return withFieldSnapshotBase(type, context, {
      checks: serializeChecks(definition.checks, `${path}.checks`),
      reference: readDirectReferenceMetadata(schema),
      item: serializeFieldSchema(
        definition.element as MdcmsFieldSchema,
        `${path}.item`,
      ),
    });
  }

  if (type === "object") {
    const rawShape =
      typeof definition.shape === "function"
        ? definition.shape()
        : definition.shape;

    if (!isRecord(rawShape)) {
      invalidInput(path, "must have an object shape.");
    }

    return withFieldSnapshotBase(type, context, {
      reference: readDirectReferenceMetadata(schema),
      fields: Object.fromEntries(
        Object.entries(rawShape)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([fieldName, fieldSchema]) => [
            fieldName,
            serializeFieldSchema(
              fieldSchema as MdcmsFieldSchema,
              `${path}.fields.${fieldName}`,
            ),
          ]),
      ),
    });
  }

  if (type === "enum") {
    const entries = definition.entries;
    if (!isRecord(entries)) {
      invalidInput(path, "must define enum entries.");
    }

    const options = [...new Set(Object.values(entries))]
      .sort((left, right) => String(left).localeCompare(String(right)))
      .map((entry, index) => {
        assertJsonValue(entry, `${path}.options[${index}]`);
        return entry;
      });

    return withFieldSnapshotBase(type, context, {
      reference: readDirectReferenceMetadata(schema),
      options,
    });
  }

  if (type === "literal") {
    const values = Array.isArray(definition.values) ? definition.values : [];
    const options = values.map((entry, index) => {
      assertJsonValue(entry, `${path}.options[${index}]`);
      return entry;
    });

    return withFieldSnapshotBase(type, context, {
      reference: readDirectReferenceMetadata(schema),
      options,
    });
  }

  invalidInput(
    path,
    `uses unsupported schema type "${type}" for registry serialization.`,
  );
}

function serializeTypeDefinition(
  typeConfig: ParsedMdcmsTypeDefinition,
  path: string,
): SchemaRegistryTypeSnapshot {
  if (typeConfig.directory === undefined) {
    invalidInput(
      `${path}.directory`,
      "must be defined for schema registry serialization.",
    );
  }

  return {
    type: typeConfig.name,
    directory: typeConfig.directory,
    localized: typeConfig.localized,
    fields: Object.fromEntries(
      Object.entries(typeConfig.fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldName, schema]) => [
          fieldName,
          serializeFieldSchema(schema, `${path}.fields.${fieldName}`),
        ]),
    ),
  };
}

export function serializeResolvedEnvironmentSchema(
  config: ParsedMdcmsConfig,
  environmentName: string,
): Record<string, SchemaRegistryTypeSnapshot> {
  const environment = config.resolvedEnvironments[environmentName];

  if (!environment) {
    invalidInput(
      "environment",
      `must reference a resolved environment defined in config.environments (received "${environmentName}").`,
    );
  }

  return Object.fromEntries(
    Object.entries(environment.types)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([typeName, typeConfig]) => [
        typeName,
        serializeTypeDefinition(
          typeConfig,
          `resolvedEnvironments.${environmentName}.types.${typeName}`,
        ),
      ]),
  );
}

export type SchemaStateFile = {
  schemaHash: string;
  syncedAt: string;
  serverUrl: string;
};

export function buildSchemaRegistrySyncPayloadBase(
  config: ParsedMdcmsConfig,
  environmentName: string,
): SchemaRegistrySyncPayloadBase {
  return {
    rawConfigSnapshot: toRawConfigSnapshot(config),
    resolvedSchema: serializeResolvedEnvironmentSchema(config, environmentName),
  };
}

export function serializeSchemaRegistrySyncHashInput(
  input: SchemaRegistrySyncHashInput,
): string {
  return stableStringifyJson(input as JsonValue);
}

export function toRawConfigSnapshot(config: ParsedMdcmsConfig): JsonObject {
  const environments = Object.fromEntries(
    Object.entries(config.environments)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => [
        name,
        (definition.extends
          ? { extends: definition.extends }
          : {}) as JsonObject,
      ]),
  ) as JsonObject;

  // Deliberately exclude `serverUrl` and `config.environment` (the host's
  // currently-active environment): both are deployment-time wiring rather
  // than schema content. Including them made the same `mdcms.config.ts`
  // hash differently when the CLI synced from a shell with default env vars
  // vs. when the demo's Docker build computed the hash with the live
  // Railway URL and `NEXT_PUBLIC_MDCMS_ENVIRONMENT=production` set.
  // `buildSchemaRegistrySyncPayloadBase` already takes the *target* env as
  // its second argument; the snapshot stays a function of structural
  // schema/config only, so a hash for env X is identical regardless of who
  // is computing it or where they happen to be pointing at the time.
  return {
    project: config.project,
    environments,
    ...(config.contentDirectories.length > 0
      ? { contentDirectories: config.contentDirectories }
      : {}),
    ...(config.locales.implicit
      ? {}
      : {
          locales: {
            default: config.locales.default,
            supported: config.locales.supported,
            ...(Object.keys(config.locales.aliases).length > 0
              ? { aliases: config.locales.aliases }
              : {}),
          },
        }),
  };
}
