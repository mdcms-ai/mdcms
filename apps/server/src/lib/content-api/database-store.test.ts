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

testWithDatabase(
  "database content store syncs the published search backend during lifecycle changes",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `db-search-sync-${stableFixtureName(randomUUID())}`,
      environment: "production",
    };
    const calls: Array<{
      type: string;
      documentId: string;
      locale: string;
      body?: string;
    }> = [];

    try {
      const { schemaHash } = await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });
      const store = createDatabaseContentStore({
        db: dbConnection.db,
        searchBackend: {
          searchPublishedDocumentIds: async () => new Set<string>(),
          searchDraftDocumentIds: async () => new Set<string>(),
          upsertPublishedDocument: async (_tx, document) => {
            calls.push({
              type: "upsert",
              documentId: document.documentId,
              locale: document.locale,
              body: document.body,
            });
          },
          removePublishedDocument: async (_tx, input) => {
            calls.push({
              type: "remove",
              documentId: input.documentId,
              locale: input.locale,
            });
          },
        },
      });

      const created = await store.create(
        scope,
        {
          path: "content/blog/search-sync",
          type: "BlogPost",
          locale: "en",
          format: "md",
          frontmatter: { slug: "search-sync", title: "Search Sync" },
          body: "published body",
        },
        { expectedSchemaHash: schemaHash },
      );

      await store.publish(scope, created.documentId, {
        changeSummary: "Publish for search",
      });
      await store.update(
        scope,
        created.documentId,
        { body: "latest published body" },
        { expectedSchemaHash: schemaHash },
      );
      await store.publish(scope, created.documentId, {
        changeSummary: "Republish for search",
      });
      await store.update(
        scope,
        created.documentId,
        { body: "draft-only body" },
        { expectedSchemaHash: schemaHash },
      );
      await store.softDelete(scope, created.documentId);
      await store.restore(scope, created.documentId);
      await store.unpublish(scope, created.documentId, {});
      await store.restoreVersion(scope, created.documentId, 1, {
        targetStatus: "published",
        changeSummary: "Restore version for search",
      });

      assert.deepEqual(
        calls.map((call) => call.type),
        ["upsert", "upsert", "remove", "upsert", "remove", "upsert"],
      );
      assert.deepEqual(
        calls.map((call) => call.body),
        [
          "published body",
          "latest published body",
          undefined,
          "latest published body",
          undefined,
          "published body",
        ],
      );
      assert.deepEqual(
        calls.map((call) => call.locale),
        ["en", "en", "en", "en", "en", "en"],
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database content store returns an empty list when search has no matches",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `db-search-empty-${stableFixtureName(randomUUID())}`,
      environment: "production",
    };
    let publishedSearchCalls = 0;

    try {
      const { schemaHash } = await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "Page",
            directory: "content/pages",
            localized: true,
          },
        ],
      });
      const store = createDatabaseContentStore({
        db: dbConnection.db,
        searchBackend: {
          searchPublishedDocumentIds: async () => {
            publishedSearchCalls += 1;
            return new Set<string>();
          },
          searchDraftDocumentIds: async () => new Set<string>(),
          upsertPublishedDocument: async () => {},
          removePublishedDocument: async () => {},
        },
      });

      const created = await store.create(
        scope,
        {
          path: "content/pages/about",
          type: "Page",
          locale: "en",
          format: "md",
          frontmatter: { slug: "about", title: "About" },
          body: "About body",
        },
        { expectedSchemaHash: schemaHash },
      );
      await store.publish(scope, created.documentId, {});

      const listed = await store.list(scope, {
        q: "no hits",
      });

      assert.equal(publishedSearchCalls, 1);
      assert.equal(listed.total, 0);
      assert.deepEqual(listed.rows, []);
    } finally {
      await dbConnection.close();
    }
  },
);
