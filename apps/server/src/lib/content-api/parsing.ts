import { RuntimeError, resolveRequestTargetRouting } from "@mdcms/shared";
import { z } from "zod";

import {
  ContentListGroupBySchema,
  ContentFormatSchema,
  JsonObjectSchema,
  RestoreTargetStatusSchema,
  SortFieldSchema,
  SortOrderSchema,
  type ContentListGroupBy,
  type ContentFormat,
  type ContentScope,
  type RestoreTargetStatus,
  type SortField,
  type SortOrder,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseQueryParam<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
  errorCode = "INVALID_QUERY_PARAM",
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  throw new RuntimeError({
    code: errorCode,
    message: `Query parameter "${field}" ${result.error.issues[0]?.message ?? "is invalid"}.`,
    statusCode: 400,
    details: { field, value },
  });
}

export const MAX_CONTENT_SEARCH_QUERY_LENGTH = 200;

export function parseContentSearchQuery(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const result = z
    .string()
    .max(MAX_CONTENT_SEARCH_QUERY_LENGTH, {
      message: `must be <= ${MAX_CONTENT_SEARCH_QUERY_LENGTH} characters`,
    })
    .safeParse(trimmed);

  if (result.success) {
    return result.data;
  }

  throw new RuntimeError({
    code: "INVALID_QUERY_PARAM",
    message: `Query parameter "q" must be <= ${MAX_CONTENT_SEARCH_QUERY_LENGTH} characters.`,
    statusCode: 400,
    details: { field: "q", value },
  });
}

export function parseInputField<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const isTypeError = issue?.code === "invalid_type";

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: isTypeError
      ? `Field "${field}" must be a ${issue.expected === "object" ? "object" : "string"}.`
      : `Field "${field}" ${issue?.message ?? "is invalid"}.`,
    statusCode: 400,
    details: { field },
  });
}

export function parseBoolean(
  value: string | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const schema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["true", "false"]))
    .transform((v) => v === "true");

  return parseQueryParam(schema, value, field);
}

export function parsePositiveInt(
  value: string | undefined,
  field: string,
  options: { defaultValue: number; min?: number; max?: number },
): number {
  if (value === undefined) {
    return options.defaultValue;
  }

  const schema = z
    .string()
    .trim()
    .regex(/^\d+$/, { message: "must be an integer" })
    .transform((v) => Number(v))
    .pipe(
      z
        .number()
        .int()
        .min(options.min ?? -Infinity)
        .max(options.max ?? Infinity),
    );

  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  let message: string;

  if (issue?.code === "too_small") {
    message = `Query parameter "${field}" must be >= ${options.min}.`;
  } else if (issue?.code === "too_big") {
    message = `Query parameter "${field}" must be <= ${options.max}.`;
  } else {
    message = `Query parameter "${field}" must be an integer.`;
  }

  throw new RuntimeError({
    code: "INVALID_QUERY_PARAM",
    message,
    statusCode: 400,
    details: { field, value },
  });
}

export function parsePathInt(value: unknown, field: string): number {
  const result = z
    .string()
    .trim()
    .regex(/^\d+$/, { message: "must be an integer" })
    .transform((candidate) => Number(candidate))
    .pipe(z.number().int().min(1))
    .safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: `Field "${field}" must be a positive integer.`,
    statusCode: 400,
    details: { field, value },
  });
}

export function parseSortField(value: string | undefined): SortField {
  if (value === undefined || value.trim().length === 0) {
    return "updatedAt";
  }

  return parseQueryParam(
    z.string().trim().pipe(SortFieldSchema),
    value,
    "sort",
  );
}

export function parseSortOrder(value: string | undefined): SortOrder {
  if (value === undefined || value.trim().length === 0) {
    return "desc";
  }

  return parseQueryParam(
    z.string().trim().toLowerCase().pipe(SortOrderSchema),
    value,
    "order",
  );
}

export function parseContentListGroupBy(
  value: string | undefined,
): ContentListGroupBy | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return parseQueryParam(
    z.string().trim().pipe(ContentListGroupBySchema),
    value,
    "groupBy",
  );
}

export function parseContentFormat(value: string | undefined): ContentFormat {
  if (value === undefined) {
    return "md";
  }

  const result = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(ContentFormatSchema)
    .safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: `Content format must be "md" or "mdx".`,
    statusCode: 400,
    details: { field: "format", value },
  });
}

export function assertRequiredString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const schema = options.allowEmpty
    ? z.string().trim()
    : z.string().trim().min(1);
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const isTypeError = issue?.code === "invalid_type";

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: isTypeError
      ? `Field "${field}" must be a string.`
      : `Field "${field}" is required.`,
    statusCode: 400,
    details: { field },
  });
}

export function assertJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  return parseInputField(JsonObjectSchema, value, field);
}

export function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Field "${field}" must be a string.`,
      statusCode: 400,
      details: { field },
    });
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseRestoreTargetStatus(
  value: unknown,
  field = "targetStatus",
): RestoreTargetStatus {
  if (value === undefined || value === null) {
    return "draft";
  }

  const result = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(RestoreTargetStatusSchema)
    .safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new RuntimeError({
    code: "INVALID_INPUT",
    message: 'Field "targetStatus" must be "draft" or "published".',
    statusCode: 400,
    details: { field, value },
  });
}

export function validateContentPath(path: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "path" is required.',
      statusCode: 400,
      details: { field: "path" },
    });
  }

  if (trimmed.endsWith("/")) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message:
        'Field "path" must not end with a trailing slash. A document slug is required.',
      statusCode: 400,
      details: { field: "path", value: trimmed },
    });
  }

  if (trimmed.startsWith("/")) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "path" must not start with a leading slash.',
      statusCode: 400,
      details: { field: "path", value: trimmed },
    });
  }

  if (/(^|\/)\.\.(\/|$)/.test(trimmed)) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "path" must not contain path traversal segments ("..").',
      statusCode: 400,
      details: { field: "path", value: trimmed },
    });
  }

  return trimmed;
}

export function pickScope(request: Request): ContentScope {
  const scope = resolveRequestTargetRouting(request);

  if (!scope.project || !scope.environment) {
    throw new RuntimeError({
      code: "MISSING_TARGET_ROUTING",
      message:
        "Both project and environment are required for content endpoints.",
      statusCode: 400,
      details: {
        project: scope.project ?? null,
        environment: scope.environment ?? null,
      },
    });
  }

  return {
    project: scope.project,
    environment: scope.environment,
  };
}
