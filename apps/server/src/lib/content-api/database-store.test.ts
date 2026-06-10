import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { SchemaRegistryTypeSnapshot } from "@mdcms/shared";

import { createDatabaseConnection } from "../db.js";
import { createDatabaseMediaStore } from "../media/database-store.js";
import {
  dbEnv,
  seedSchemaRegistryScope,
  stableFixtureName,
  testWithDatabase,
} from "../content-api-test-support.js";

import { createDatabaseContentStore } from "./database-store.js";

function imageField(): SchemaRegistryTypeSnapshot["fields"][string] {
  return {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    },
  };
}

testWithDatabase(
  "database content store validates media file field writes",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `db-media-field-${stableFixtureName(randomUUID())}`,
      environment: "production",
    };
    const imageAssetId = randomUUID();
    const pdfAssetId = randomUUID();

    try {
      const { schemaHash } = await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "MediaPage",
            directory: "content/media-pages",
            localized: true,
            fields: {
              primaryImage: imageField(),
              defaultImage: {
                ...imageField(),
                required: false,
                default: imageAssetId,
              },
            },
          },
        ],
      });
      const mediaStore = createDatabaseMediaStore({ db: dbConnection.db });
      await mediaStore.createAsset(
        scope,
        {
          id: imageAssetId,
          filename: "hero.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 100,
          s3Key: `tests/${imageAssetId}/hero.jpg`,
          url: "https://cdn.example.test/hero.jpg",
        },
        { actorId: "user_1" },
      );
      await mediaStore.createAsset(
        scope,
        {
          id: pdfAssetId,
          filename: "terms.pdf",
          mimeType: "application/pdf",
          sizeBytes: 100,
          s3Key: `tests/${pdfAssetId}/terms.pdf`,
          url: "https://cdn.example.test/terms.pdf",
        },
        { actorId: "user_1" },
      );
      const contentStore = createDatabaseContentStore({
        db: dbConnection.db,
        lookupMediaAsset: (lookupScope, id) =>
          mediaStore.getAsset(lookupScope, id),
      });

      const created = await contentStore.create(
        scope,
        {
          path: "content/media-pages/valid",
          type: "MediaPage",
          locale: "en",
          format: "md",
          frontmatter: {
            primaryImage: imageAssetId,
          },
          body: "body",
        },
        { expectedSchemaHash: schemaHash },
      );

      assert.equal(created.frontmatter.primaryImage, imageAssetId);
      assert.equal(created.frontmatter.defaultImage, imageAssetId);

      await assert.rejects(
        () =>
          contentStore.create(
            scope,
            {
              path: "content/media-pages/non-image",
              type: "MediaPage",
              locale: "en",
              format: "md",
              frontmatter: {
                primaryImage: pdfAssetId,
              },
              body: "body",
            },
            { expectedSchemaHash: schemaHash },
          ),
        (error: unknown) => {
          const actual = error as {
            code?: string;
            statusCode?: number;
            details?: Record<string, unknown>;
          };
          assert.equal(actual.code, "INVALID_INPUT");
          assert.equal(actual.statusCode, 400);
          assert.deepEqual(actual.details, {
            field: "frontmatter.primaryImage",
            mediaAssetId: pdfAssetId,
            reason: "MEDIA_TYPE_MISMATCH",
            expectedMime: "image/*",
            actualMimeType: "application/pdf",
          });
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);
