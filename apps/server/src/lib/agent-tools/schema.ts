import { z } from "zod";
import {
  ContentChangeOriginSchema,
  type SchemaRegistryFieldSnapshot,
} from "@mdcms/shared";

const object = z.record(z.string(), z.unknown());
const resolveError = z.union([
  z.object({
    code: z.enum([
      "REFERENCE_NOT_FOUND",
      "REFERENCE_DELETED",
      "REFERENCE_TYPE_MISMATCH",
      "REFERENCE_FORBIDDEN",
    ]),
    message: z.string(),
    ref: z.object({ documentId: z.string(), type: z.string() }),
  }),
  z.object({
    code: z.enum(["MEDIA_NOT_FOUND", "MEDIA_TYPE_MISMATCH"]),
    message: z.string(),
    media: z.object({
      assetId: z.string(),
      expectedMime: z.array(z.string()).optional(),
      actualMimeType: z.string().optional(),
    }),
  }),
]);
export const documentSchema = z
  .object({
    documentId: z.string(),
    translationGroupId: z.string(),
    project: z.string(),
    environment: z.string(),
    path: z.string(),
    type: z.string(),
    locale: z.string(),
    format: z.enum(["md", "mdx"]),
    isDeleted: z.boolean(),
    hasUnpublishedChanges: z.boolean(),
    version: z.number(),
    publishedVersion: z.number().nullable(),
    draftRevision: z.number(),
    frontmatter: object,
    body: z.string(),
    resolveErrors: z.record(z.string(), resolveError).optional(),
    localesPresent: z.array(z.string()).optional(),
    publishedLocales: z.array(z.string()).optional(),
    createdBy: z.string(),
    createdOrigin: ContentChangeOriginSchema.optional(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedOrigin: ContentChangeOriginSchema.optional(),
    updatedAt: z.string(),
  })
  .passthrough();
const users = z
  .record(z.string(), z.object({ name: z.string(), email: z.string() }))
  .optional();
export const documentEnvelopeSchema = z
  .object({ data: documentSchema, users })
  .passthrough();
export const documentListEnvelopeSchema = z
  .object({
    data: z.array(documentSchema),
    users,
    pagination: z.object({
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
    }),
  })
  .passthrough();
const field: z.ZodType<SchemaRegistryFieldSnapshot> = z.lazy(() =>
  z.object({
    kind: z.string(),
    required: z.boolean(),
    nullable: z.boolean(),
    default: z.json().optional(),
    reference: z.object({ targetType: z.string() }).optional(),
    file: z
      .object({
        preset: z.enum(["image", "video", "file"]),
        accept: z.array(z.string()),
        emptyStringAsUnset: z.boolean(),
      })
      .optional(),
    checks: z.array(z.record(z.string(), z.json())).optional(),
    item: field.optional(),
    fields: z.record(z.string(), field).optional(),
    options: z.array(z.json()).optional(),
  }),
);
export const typeSnapshotSchema = z.object({
  type: z.string(),
  directory: z.string(),
  localized: z.boolean(),
  fields: z.record(z.string(), field),
});
export const schemaDataSchema = z
  .object({
    types: z.array(
      typeSnapshotSchema.omit({ fields: true }).extend({
        schemaHash: z.string(),
        syncedAt: z.string(),
        resolvedSchema: typeSnapshotSchema,
      }),
    ),
    schemaHash: z.string().nullable(),
    syncedAt: z.string().nullable(),
    project: z.string().optional(),
  })
  .passthrough();

export const schemaEnvelopeSchema = z
  .object({ data: schemaDataSchema })
  .passthrough();
