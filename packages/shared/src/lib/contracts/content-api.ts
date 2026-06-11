import { z } from "zod";

export type ApiDataEnvelope<T> = {
  data: T;
};

export type PaginationMetadata = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type ApiPaginatedEnvelope<T> = {
  data: T[];
  pagination: PaginationMetadata;
};

export type ContentReferenceResolveError = {
  code:
    | "REFERENCE_NOT_FOUND"
    | "REFERENCE_DELETED"
    | "REFERENCE_TYPE_MISMATCH"
    | "REFERENCE_FORBIDDEN";
  message: string;
  ref: {
    documentId: string;
    type: string;
  };
};

export type ContentMediaResolveError = {
  code: "MEDIA_NOT_FOUND" | "MEDIA_TYPE_MISMATCH";
  message: string;
  media: {
    assetId: string;
    expectedMime?: string[];
    actualMimeType?: string;
  };
};

export type ContentResolveError =
  | ContentReferenceResolveError
  | ContentMediaResolveError;

export type ResolveErrorsMap = Record<string, ContentResolveError>;

export type ContentDocumentResponse = {
  documentId: string;
  translationGroupId: string;
  project: string;
  environment: string;
  path: string;
  type: string;
  locale: string;
  format: "md" | "mdx";
  isDeleted: boolean;
  hasUnpublishedChanges: boolean;
  version: number;
  publishedVersion: number | null;
  draftRevision: number;
  frontmatter: Record<string, unknown>;
  body: string;
  resolveErrors?: ResolveErrorsMap;
  localesPresent?: string[];
  publishedLocales?: string[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
};

export const ContentBulkActionSchema = z.enum([
  "publish",
  "unpublish",
  "delete",
  "move",
]);

export type ContentBulkAction = z.infer<typeof ContentBulkActionSchema>;

const ContentBulkDocumentIdsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(100)
  .refine((documentIds) => new Set(documentIds).size === documentIds.length, {
    message: "documentIds must be unique",
  });

const ContentBulkMoveTargetDirectorySchema = z
  .string()
  .trim()
  .refine(
    (targetDirectory) =>
      targetDirectory === "" ||
      (!targetDirectory.startsWith("/") &&
        !targetDirectory.endsWith("/") &&
        !targetDirectory.split("/").includes("..")),
    {
      message:
        "targetDirectory must be empty or a relative path without traversal segments",
    },
  );

const ContentBulkMoveInputSchema = z
  .object({
    targetDirectory: ContentBulkMoveTargetDirectorySchema,
  })
  .strict();

export const ContentBulkOperationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("publish"),
      documentIds: ContentBulkDocumentIdsSchema,
      changeSummary: z.string().optional(),
      actorId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("unpublish"),
      documentIds: ContentBulkDocumentIdsSchema,
      actorId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      documentIds: ContentBulkDocumentIdsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("move"),
      documentIds: ContentBulkDocumentIdsSchema,
      move: ContentBulkMoveInputSchema,
    })
    .strict(),
]);

export type ContentBulkOperationInput = z.infer<
  typeof ContentBulkOperationInputSchema
>;

export type ContentBulkOperationItemError = {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
};

export type ContentBulkOperationResult =
  | {
      documentId: string;
      status: "succeeded";
      document: ContentDocumentResponse;
    }
  | {
      documentId: string;
      status: "failed";
      error: ContentBulkOperationItemError;
    };

export type ContentBulkOperationResponse = {
  action: ContentBulkAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: ContentBulkOperationResult[];
};

export type ContentVersionSummaryResponse = {
  documentId: string;
  translationGroupId: string;
  project: string;
  environment: string;
  version: number;
  path: string;
  type: string;
  locale: string;
  format: "md" | "mdx";
  publishedAt: string;
  publishedBy: string;
  changeSummary?: string;
};

export type ContentVersionDocumentResponse = ContentVersionSummaryResponse & {
  frontmatter: Record<string, unknown>;
  body: string;
  resolveErrors?: ResolveErrorsMap;
};

export type ContentUserSummary = {
  name: string;
  email: string;
};

export type ContentOverviewCountsResponse = {
  type: string;
  total: number;
  published: number;
  drafts: number;
};

export type TranslationVariantSummary = {
  documentId: string;
  locale: string;
  path: string;
  publishedVersion: number | null;
  hasUnpublishedChanges: boolean;
};

export type TranslationVariantsResponse = ApiDataEnvelope<
  TranslationVariantSummary[]
>;
