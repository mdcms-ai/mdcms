import {
  MEDIA_ARCHIVE_MIME_TYPES,
  MEDIA_DOCUMENT_APPLICATION_MIME_TYPES,
  RuntimeError,
  createDefaultMediaSettings,
  type MediaAssetCategory,
  type MediaAsset,
  type MediaSettings,
} from "@mdcms/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { DrizzleDatabase } from "../db.js";
import { media, projectMediaSettings } from "../db/schema.js";
import { resolveProjectEnvironmentScope } from "../project-provisioning.js";

import { parseMediaId } from "./ids.js";
import type {
  MediaAssetRecord,
  MediaAssetListQuery,
  MediaMetadataStore,
  MediaScope,
} from "./types.js";

export type CreateDatabaseMediaStoreOptions = {
  db: DrizzleDatabase;
  now?: () => Date;
};

type MediaScopeIds = {
  projectId: string;
  projectSlug: string;
};

function toIsoString(value: Date): string {
  return value.toISOString();
}

function createTargetNotFoundError(scope: MediaScope): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Target project or environment not found.",
    statusCode: 404,
    details: {
      project: scope.project,
      environment: scope.environment,
    },
  });
}

function createMediaNotFoundError(id: string): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Media asset not found.",
    statusCode: 404,
    details: { id },
  });
}

async function requireMediaScopeIds(
  db: DrizzleDatabase,
  scope: MediaScope,
): Promise<MediaScopeIds> {
  const resolvedScope = await resolveProjectEnvironmentScope(db, {
    project: scope.project,
    environment: scope.environment,
  });

  if (!resolvedScope) {
    throw createTargetNotFoundError(scope);
  }

  return {
    projectId: resolvedScope.project.id,
    projectSlug: resolvedScope.project.slug,
  };
}

function toMediaSettings(
  row: typeof projectMediaSettings.$inferSelect,
): MediaSettings {
  return {
    media: {
      image: {
        maxUploadSizeBytes: row.imageMaxUploadSizeBytes,
      },
    },
  };
}

function toMediaAsset(
  projectSlug: string,
  row: typeof media.$inferSelect,
): MediaAsset {
  return {
    id: row.id,
    project: projectSlug,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    url: row.url,
    uploadedBy: row.uploadedBy,
    uploadedAt: toIsoString(row.uploadedAt),
  };
}

function toMediaAssetRecord(
  projectSlug: string,
  row: typeof media.$inferSelect,
): MediaAssetRecord {
  return {
    ...toMediaAsset(projectSlug, row),
    s3Key: row.s3Key,
  };
}

function normalizedMimeType(): SQL<string> {
  return sql`lower(trim(split_part(${media.mimeType}, ';', 1)))`;
}

function mimeTypeStartsWith(prefix: string): SQL {
  return sql`${normalizedMimeType()} like ${`${prefix}%`}`;
}

function documentCategoryPredicate(): SQL {
  const mimeType = normalizedMimeType();

  return or(
    mimeTypeStartsWith("text/"),
    inArray(mimeType, [...MEDIA_DOCUMENT_APPLICATION_MIME_TYPES]),
    sql`${mimeType} like ${"application/%+json"}`,
    sql`${mimeType} like ${"application/%+xml"}`,
    mimeTypeStartsWith("application/vnd.openxmlformats-officedocument."),
    mimeTypeStartsWith("application/vnd.oasis.opendocument."),
  ) as SQL;
}

function archiveCategoryPredicate(): SQL {
  return inArray(normalizedMimeType(), [...MEDIA_ARCHIVE_MIME_TYPES]);
}

function nonOtherCategoryPredicate(
  category: Exclude<MediaAssetCategory, "other">,
): SQL {
  switch (category) {
    case "image":
      return mimeTypeStartsWith("image/");
    case "video":
      return mimeTypeStartsWith("video/");
    case "audio":
      return mimeTypeStartsWith("audio/");
    case "document":
      return documentCategoryPredicate();
    case "archive":
      return archiveCategoryPredicate();
  }
}

function categoryPredicate(category: MediaAssetCategory): SQL {
  if (category !== "other") {
    return nonOtherCategoryPredicate(category);
  }

  return and(
    not(nonOtherCategoryPredicate("image")),
    not(nonOtherCategoryPredicate("video")),
    not(nonOtherCategoryPredicate("audio")),
    not(nonOtherCategoryPredicate("document")),
    not(nonOtherCategoryPredicate("archive")),
  ) as SQL;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function listWhereConditions(
  scopeIds: MediaScopeIds,
  query: MediaAssetListQuery,
): SQL {
  const conditions: SQL[] = [eq(media.projectId, scopeIds.projectId)];

  if (query.q !== undefined) {
    conditions.push(
      sql`${media.filename} ilike ${`%${escapeLikePattern(query.q)}%`} escape '\\'`,
    );
  }

  if (query.category !== undefined) {
    conditions.push(categoryPredicate(query.category));
  }

  if (query.uploadedBy !== undefined) {
    conditions.push(eq(media.uploadedBy, query.uploadedBy));
  }

  if (query.uploadedFrom !== undefined) {
    conditions.push(gte(media.uploadedAt, query.uploadedFrom));
  }

  if (query.uploadedTo !== undefined) {
    conditions.push(lt(media.uploadedAt, addUtcDays(query.uploadedTo, 1)));
  }

  return and(...conditions) as SQL;
}

function listOrderBy(query: MediaAssetListQuery): SQL[] {
  const direction = query.order === "asc" ? asc : desc;

  switch (query.sort) {
    case "uploadedAt":
      return [direction(media.uploadedAt), direction(media.id)];
    case "filename":
      return [direction(media.filename), direction(media.id)];
    case "sizeBytes":
      return [direction(media.sizeBytes), direction(media.id)];
  }
}

export function createDatabaseMediaStore(
  options: CreateDatabaseMediaStoreOptions,
): MediaMetadataStore {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  return {
    async getSettings(scope) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const row = await db.query.projectMediaSettings.findFirst({
        where: eq(projectMediaSettings.projectId, scopeIds.projectId),
      });

      if (!row) {
        return createDefaultMediaSettings();
      }

      return toMediaSettings(row);
    },

    async updateSettings(scope, input, context) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const timestamp = now();
      const [updated] = await db
        .insert(projectMediaSettings)
        .values({
          projectId: scopeIds.projectId,
          imageMaxUploadSizeBytes: input.media.image.maxUploadSizeBytes ?? null,
          updatedBy: context.actorId,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: projectMediaSettings.projectId,
          set: {
            imageMaxUploadSizeBytes:
              input.media.image.maxUploadSizeBytes ?? null,
            updatedBy: context.actorId,
            updatedAt: timestamp,
          },
        })
        .returning();

      if (!updated) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Failed to update media settings.",
          statusCode: 500,
        });
      }

      return toMediaSettings(updated);
    },

    async createAsset(scope, input, context) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const mediaId = parseMediaId(input.id);
      const [created] = await db
        .insert(media)
        .values({
          id: mediaId,
          projectId: scopeIds.projectId,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          s3Key: input.s3Key,
          url: input.url,
          uploadedBy: context.actorId,
          uploadedAt: now(),
        })
        .returning();

      if (!created) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Failed to create media asset.",
          statusCode: 500,
        });
      }

      return toMediaAsset(scopeIds.projectSlug, created);
    },

    async listAssets(scope, query) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const where = listWhereConditions(scopeIds, query);
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(media)
        .where(where);
      const total = Number(countRow?.count ?? 0);
      const rows = await db
        .select()
        .from(media)
        .where(where)
        .orderBy(...listOrderBy(query))
        .limit(query.limit)
        .offset(query.offset);

      return {
        assets: rows.map((row) => toMediaAsset(scopeIds.projectSlug, row)),
        pagination: {
          total,
          limit: query.limit,
          offset: query.offset,
          hasMore: query.offset + query.limit < total,
        },
      };
    },

    async getAsset(scope, id) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const mediaId = parseMediaId(id);
      const row = await db.query.media.findFirst({
        where: and(
          eq(media.id, mediaId),
          eq(media.projectId, scopeIds.projectId),
        ),
      });

      if (!row) {
        return undefined;
      }

      return toMediaAsset(scopeIds.projectSlug, row);
    },

    async getAssetRecord(scope, id) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const mediaId = parseMediaId(id);
      const row = await db.query.media.findFirst({
        where: and(
          eq(media.id, mediaId),
          eq(media.projectId, scopeIds.projectId),
        ),
      });

      if (!row) {
        return undefined;
      }

      return toMediaAssetRecord(scopeIds.projectSlug, row);
    },

    async deleteAssetMetadata(scope, id) {
      const scopeIds = await requireMediaScopeIds(db, scope);
      const mediaId = parseMediaId(id);
      const [deleted] = await db
        .delete(media)
        .where(
          and(eq(media.id, mediaId), eq(media.projectId, scopeIds.projectId)),
        )
        .returning({ id: media.id });

      if (!deleted) {
        throw createMediaNotFoundError(mediaId);
      }

      return {
        deleted: true,
        id: deleted.id,
      };
    },
  };
}
