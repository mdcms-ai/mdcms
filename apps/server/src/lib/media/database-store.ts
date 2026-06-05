import {
  RuntimeError,
  createDefaultMediaSettings,
  type MediaAsset,
  type MediaSettings,
} from "@mdcms/shared";
import { and, eq } from "drizzle-orm";

import type { DrizzleDatabase } from "../db.js";
import { media, projectMediaSettings } from "../db/schema.js";
import { resolveProjectEnvironmentScope } from "../project-provisioning.js";

import { parseMediaId } from "./ids.js";
import type {
  MediaAssetRecord,
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
