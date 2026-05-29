import type {
  SchemaRegistryFieldSnapshot,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

export type ValidationResult = {
  errors: string[];
  warnings: string[];
};

export type ValidateCandidate = {
  path: string;
  typeName: string;
  frontmatter: Record<string, unknown>;
};

export type DocumentValidationResult = {
  path: string;
  errors: string[];
  warnings: string[];
};

export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  typeSnapshot: SchemaRegistryTypeSnapshot,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(typeSnapshot.fields)) {
    const value = frontmatter[fieldName];
    const fieldErrors = validateField(value, fieldSchema, fieldName);
    errors.push(...fieldErrors);
  }

  for (const key of Object.keys(frontmatter)) {
    if (!(key in typeSnapshot.fields)) {
      warnings.push(
        `Unknown field "${key}" is not defined in schema for type "${typeSnapshot.type}".`,
      );
    }
  }

  return { errors, warnings };
}

export function validateCandidates(
  candidates: ValidateCandidate[],
  resolvedSchema: Record<string, SchemaRegistryTypeSnapshot>,
): DocumentValidationResult[] {
  return candidates.map((candidate) => {
    const typeSnapshot = resolvedSchema[candidate.typeName];

    if (!typeSnapshot) {
      return {
        path: candidate.path,
        errors: [
          `Content type "${candidate.typeName}" not found in resolved schema.`,
        ],
        warnings: [],
      };
    }

    const { errors, warnings } = validateFrontmatter(
      candidate.frontmatter,
      typeSnapshot,
    );

    return {
      path: candidate.path,
      errors,
      warnings,
    };
  });
}

function validateField(
  value: unknown,
  schema: SchemaRegistryFieldSnapshot,
  path: string,
): string[] {
  if (value === undefined || value === null) {
    if (value === null && !schema.nullable) {
      return [`Field "${path}" is null but schema does not allow nullable.`];
    }

    if (
      value === undefined &&
      schema.required &&
      schema.default === undefined
    ) {
      return [`Missing required field "${path}" (kind: ${schema.kind}).`];
    }

    return [];
  }

  return validateKind(value, schema, path);
}

function validateKind(
  value: unknown,
  schema: SchemaRegistryFieldSnapshot,
  path: string,
): string[] {
  switch (schema.kind) {
    case "string":
      return typeof value === "string"
        ? []
        : [`Field "${path}" expected kind "string", got ${typeof value}.`];

    case "number":
      return typeof value === "number"
        ? []
        : [`Field "${path}" expected kind "number", got ${typeof value}.`];

    case "boolean":
      return typeof value === "boolean"
        ? []
        : [`Field "${path}" expected kind "boolean", got ${typeof value}.`];

    case "date":
      if (value instanceof Date) {
        return isNaN(value.valueOf())
          ? [`Field "${path}" expected a valid date, got an invalid Date.`]
          : [];
      }
      if (typeof value === "string") {
        if (value.length === 0 || isNaN(Date.parse(value))) {
          return [
            `Field "${path}" expected a valid ISO date string, got ${JSON.stringify(value)}.`,
          ];
        }
        return [];
      }
      return [
        `Field "${path}" expected kind "date" (ISO string), got ${typeof value}.`,
      ];

    case "enum":
    case "literal": {
      const options = schema.options ?? [];
      return options.includes(value as string | number | boolean)
        ? []
        : [
            `Field "${path}" value ${JSON.stringify(value)} is not in allowed options: ${JSON.stringify(options)}.`,
          ];
    }

    case "array":
      return validateArrayField(value, schema, path);

    case "object":
      return validateObjectField(value, schema, path);

    default:
      return [];
  }
}

function validateArrayField(
  value: unknown,
  schema: SchemaRegistryFieldSnapshot,
  path: string,
): string[] {
  if (!Array.isArray(value)) {
    return [`Field "${path}" expected kind "array", got ${typeof value}.`];
  }

  if (!schema.item) {
    return [];
  }

  const errors: string[] = [];
  for (let i = 0; i < value.length; i++) {
    errors.push(...validateField(value[i], schema.item, `${path}[${i}]`));
  }
  return errors;
}

function validateObjectField(
  value: unknown,
  schema: SchemaRegistryFieldSnapshot,
  path: string,
): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [
      `Field "${path}" expected kind "object", got ${Array.isArray(value) ? "array" : typeof value}.`,
    ];
  }

  if (!schema.fields) {
    return [];
  }

  const errors: string[] = [];
  const record = value as Record<string, unknown>;

  for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
    errors.push(
      ...validateField(record[fieldName], fieldSchema, `${path}.${fieldName}`),
    );
  }

  return errors;
}
