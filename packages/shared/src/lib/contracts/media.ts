import { z } from "zod";

import { RuntimeError } from "../runtime/error.js";

export type MediaSettings = {
  media: {
    image: {
      maxUploadSizeBytes: number | null;
    };
  };
};

export type MediaAsset = {
  id: string;
  project: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
};

export type MediaAssetCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";

export type MediaSettingsResponse = {
  data: MediaSettings;
};

export type MediaAssetResponse = {
  data: MediaAsset;
};

export type MediaStorageStatus = {
  objectStorageConfigured: boolean;
};

export type MediaAssetListResponse = {
  data: MediaAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  storage: MediaStorageStatus;
};

export type MediaDeleteResponse = {
  data: {
    deleted: true;
    id: string;
  };
};

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const NonEmptyStringSchema = z.string().trim().min(1);
const SizeBytesSchema = PositiveSafeIntegerSchema.or(z.literal(0));

const MediaSettingsSchema = z
  .object({
    media: z
      .object({
        image: z
          .object({
            maxUploadSizeBytes: PositiveSafeIntegerSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const MediaSettingsInputSchema = z
  .object({
    media: z
      .object({
        image: z
          .object({
            maxUploadSizeBytes: PositiveSafeIntegerSchema.nullable()
              .optional()
              .transform((value) => value ?? null),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const MediaAssetSchema = z
  .object({
    id: NonEmptyStringSchema,
    project: NonEmptyStringSchema,
    filename: NonEmptyStringSchema,
    mimeType: NonEmptyStringSchema,
    sizeBytes: SizeBytesSchema,
    url: NonEmptyStringSchema,
    uploadedBy: NonEmptyStringSchema,
    uploadedAt: NonEmptyStringSchema,
  })
  .strict();

const MediaSettingsResponseSchema = z
  .object({
    data: MediaSettingsSchema,
  })
  .strict();

const MediaAssetResponseSchema = z
  .object({
    data: MediaAssetSchema,
  })
  .strict();

const MediaStorageStatusSchema = z
  .object({
    objectStorageConfigured: z.boolean(),
  })
  .strict();

const MediaAssetListResponseSchema = z
  .object({
    data: z.array(MediaAssetSchema),
    pagination: z
      .object({
        total: NonNegativeSafeIntegerSchema,
        limit: PositiveSafeIntegerSchema,
        offset: NonNegativeSafeIntegerSchema,
        hasMore: z.boolean(),
      })
      .strict(),
    storage: MediaStorageStatusSchema,
  })
  .strict();

const MediaDeleteResponseSchema = z
  .object({
    data: z
      .object({
        deleted: z.literal(true),
        id: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();

function runtimeError(
  message: string,
  details?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    ...(details ? { details } : {}),
  });
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw runtimeError("Media settings payload must be an object.", {
      field: "body",
    });
  }

  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknownField = Object.keys(record).find(
    (field) => !allowedSet.has(field),
  );

  if (unknownField) {
    throw runtimeError(`Field "${unknownField}" is not allowed.`, {
      field: unknownField,
    });
  }
}

function assertWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
  details?: Record<string, unknown>,
): asserts value is T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw runtimeError(message, details);
  }
}

export function createDefaultMediaSettings(): MediaSettings {
  return {
    media: {
      image: {
        maxUploadSizeBytes: null,
      },
    },
  };
}

export function deriveMediaAssetCategory(mimeType: string): MediaAssetCategory {
  const normalizedMimeType = (mimeType.split(";")[0] ?? "")
    .trim()
    .toLowerCase();
  const isApplicationMimeType = normalizedMimeType.startsWith("application/");

  if (normalizedMimeType.startsWith("image/")) {
    return "image";
  }

  if (normalizedMimeType.startsWith("video/")) {
    return "video";
  }

  if (normalizedMimeType.startsWith("audio/")) {
    return "audio";
  }

  if (
    normalizedMimeType.startsWith("text/") ||
    DOCUMENT_APPLICATION_MIME_TYPES.has(normalizedMimeType) ||
    (isApplicationMimeType && normalizedMimeType.endsWith("+json")) ||
    (isApplicationMimeType && normalizedMimeType.endsWith("+xml")) ||
    normalizedMimeType.startsWith(
      "application/vnd.openxmlformats-officedocument.",
    ) ||
    normalizedMimeType.startsWith("application/vnd.oasis.opendocument.")
  ) {
    return "document";
  }

  if (ARCHIVE_MIME_TYPES.has(normalizedMimeType)) {
    return "archive";
  }

  return "other";
}

export function parseMediaSettingsInput(value: unknown): MediaSettings {
  const record = assertRecord(value);
  rejectUnknownFields(record, ["media"]);

  const parsed = MediaSettingsInputSchema.safeParse(record);

  if (!parsed.success) {
    throw runtimeError(
      'Field "media.image.maxUploadSizeBytes" must be null or a positive safe integer.',
      {
        field: "media.image.maxUploadSizeBytes",
      },
    );
  }

  return parsed.data;
}

export function assertMediaSettingsResponse(
  value: unknown,
  path = "value",
): asserts value is MediaSettingsResponse {
  assertWithSchema(
    MediaSettingsResponseSchema,
    value,
    `${path} must be a media settings response.`,
    { path },
  );
}

export function assertMediaAssetResponse(
  value: unknown,
  path = "value",
): asserts value is MediaAssetResponse {
  assertWithSchema(
    MediaAssetResponseSchema,
    value,
    `${path} must be a media asset response.`,
    { path },
  );
}

export function assertMediaAssetListResponse(
  value: unknown,
  path = "value",
): asserts value is MediaAssetListResponse {
  assertWithSchema(
    MediaAssetListResponseSchema,
    value,
    `${path} must be a media asset list response.`,
    { path },
  );
}

export function assertMediaDeleteResponse(
  value: unknown,
  path = "value",
): asserts value is MediaDeleteResponse {
  assertWithSchema(
    MediaDeleteResponseSchema,
    value,
    `${path} must be a media delete response.`,
    { path },
  );
}

export const MEDIA_DOCUMENT_APPLICATION_MIME_TYPES = [
  "application/json",
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
] as const;

export const MEDIA_ARCHIVE_MIME_TYPES = [
  "application/gzip",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-gtar",
  "application/x-gzip",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/x-zip-compressed",
  "application/zip",
] as const;

const DOCUMENT_APPLICATION_MIME_TYPES = new Set<string>(
  MEDIA_DOCUMENT_APPLICATION_MIME_TYPES,
);

const ARCHIVE_MIME_TYPES = new Set<string>(MEDIA_ARCHIVE_MIME_TYPES);
