import { and, eq } from "drizzle-orm";
import { documentVersions } from "../db/schema.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type {
  ContentWriteAttribution,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import { createDatabaseConnection } from "../db.js";
import { createDatabaseMediaStore } from "../media/database-store.js";
import {
  dbEnv,
  seedSchemaRegistryScope,
  stableFixtureName,
  testWithDatabase,
  testAttribution,
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
        { attribution: testAttribution, expectedSchemaHash: schemaHash },
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
            { attribution: testAttribution, expectedSchemaHash: schemaHash },
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
        { attribution: testAttribution, expectedSchemaHash: schemaHash },
      );

      await store.publish(scope, created.documentId, {
        attribution: testAttribution,
        changeSummary: "Publish for search",
      });
      await store.update(
        scope,
        created.documentId,
        { body: "latest published body" },
        { attribution: testAttribution, expectedSchemaHash: schemaHash },
      );
      await store.publish(scope, created.documentId, {
        attribution: testAttribution,
        changeSummary: "Republish for search",
      });
      await store.update(
        scope,
        created.documentId,
        { body: "draft-only body" },
        { attribution: testAttribution, expectedSchemaHash: schemaHash },
      );
      await store.softDelete(scope, created.documentId, {
        attribution: testAttribution,
      });
      await store.restore(scope, created.documentId, {
        attribution: testAttribution,
      });
      await store.unpublish(scope, created.documentId, {
        attribution: testAttribution,
      });
      await store.restoreVersion(scope, created.documentId, 1, {
        attribution: testAttribution,
        targetStatus: "published",
        changeSummary: "Restore version for search",
      });

      assert.deepEqual(
        calls.map((call) => call.type),
        ["upsert", "upsert", "remove", "remove", "remove", "upsert"],
      );
      assert.deepEqual(
        calls.map((call) => call.body),
        [
          "published body",
          "latest published body",
          undefined,
          undefined,
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
        { attribution: testAttribution, expectedSchemaHash: schemaHash },
      );
      await store.publish(scope, created.documentId, {
        attribution: testAttribution,
      });

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

testWithDatabase(
  "database content store records actor and origin on writes and publishes",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `db-attribution-${stableFixtureName(randomUUID())}`,
      environment: "production",
    };
    const creator = {
      actorId: "user-creator",
      origin: { channel: "studio", credential: "session" },
    } satisfies ContentWriteAttribution;
    const agent = {
      actorId: "user-agent-owner",
      origin: {
        channel: "api",
        credential: "api_key",
        apiKeyId: "key-1",
        declared: "cli/0.4.0",
      },
    } satisfies ContentWriteAttribution;

    try {
      const { schemaHash } = await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "Note",
            directory: "content/notes",
            localized: false,
            fields: {},
          },
        ],
      });
      const store = createDatabaseContentStore({ db: dbConnection.db });

      const created = await store.create(
        scope,
        {
          type: "Note",
          path: "content/notes/attribution",
          locale: "en",
          format: "md",
          frontmatter: {},
          body: "first",
        },
        { expectedSchemaHash: schemaHash, attribution: creator },
      );
      assert.equal(created.createdBy, "user-creator");
      assert.deepEqual(created.createdOrigin, creator.origin);

      const updated = await store.update(
        scope,
        created.documentId,
        { body: "second" },
        { expectedSchemaHash: schemaHash, attribution: agent },
      );
      assert.equal(updated.createdBy, "user-creator");
      assert.equal(updated.updatedBy, "user-agent-owner");
      assert.deepEqual(updated.updatedOrigin, agent.origin);

      await store.publish(scope, created.documentId, {
        changeSummary: "First publish",
        attribution: agent,
      });
      const versions = await store.listVersions(scope, created.documentId, {});
      assert.equal(versions.rows[0]?.publishedBy, "user-agent-owner");
      assert.deepEqual(versions.rows[0]?.publishedOrigin, agent.origin);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "attribution migration preserves legacy UUID actors and leaves origins null",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(
      new URL("../../../drizzle/0017_flashy_yellow_claw.sql", import.meta.url),
      "utf8",
    );
    const connection = createDatabaseConnection({ env: dbEnv });
    try {
      await connection.client.begin(async (sql) => {
        await sql.unsafe(
          "create temporary table documents (created_by uuid not null, updated_by uuid not null) on commit drop",
        );
        await sql.unsafe(
          "create temporary table document_versions (published_by uuid not null) on commit drop",
        );
        const actor = "018f0c6d-98da-4f25-89fe-7c7ef5e8597d";
        await sql.unsafe("insert into documents values ($1, $2)", [
          actor,
          actor,
        ]);
        await sql.unsafe("insert into document_versions values ($1)", [actor]);
        for (const statement of migration.split("--> statement-breakpoint"))
          await sql.unsafe(statement);
        const [document] = await sql.unsafe(
          "select created_by, updated_by, created_origin, updated_origin, pg_typeof(created_by)::text as actor_type from documents",
        );
        const [version] = await sql.unsafe(
          "select published_by, published_origin from document_versions",
        );
        assert.equal(document?.created_by, actor);
        assert.equal(document?.updated_by, actor);
        assert.equal(document?.actor_type, "text");
        assert.equal(document?.created_origin, null);
        assert.equal(document?.updated_origin, null);
        assert.equal(version?.published_by, actor);
        assert.equal(version?.published_origin, null);
        await sql.unsafe(
          "insert into documents (created_by, updated_by) values ('user_non_uuid', 'user_non_uuid')",
        );
      });
    } finally {
      await connection.close();
    }
  },
);

for (const legacy of [false, true]) {
  testWithDatabase(
    `published database reads preserve ${legacy ? "legacy" : "current"} publication attribution after draft edits`,
    async () => {
      const connection = createDatabaseConnection({ env: dbEnv });
      const scope = {
        project: `published-attribution-${randomUUID()}`,
        environment: "production",
      };
      const publisher: ContentWriteAttribution = {
        actorId: "publisher",
        origin: { channel: "studio", credential: "session" },
      };
      const editor: ContentWriteAttribution = {
        actorId: "draft-editor",
        origin: {
          channel: "api",
          credential: "api_key",
          apiKeyId: "key-editor",
        },
      };
      try {
        const { schemaHash } = await seedSchemaRegistryScope(connection.db, {
          scope,
          entries: [
            { type: "Note", directory: "notes", localized: false, fields: {} },
          ],
        });
        const store = createDatabaseContentStore({ db: connection.db });
        const created = await store.create(
          scope,
          {
            type: "Note",
            path: "notes/attribution",
            locale: "en",
            format: "md",
            body: "Published body",
            frontmatter: {},
          },
          { expectedSchemaHash: schemaHash, attribution: publisher },
        );
        await store.publish(scope, created.documentId, {
          attribution: publisher,
        });
        if (legacy)
          await connection.db
            .update(documentVersions)
            .set({ publishedOrigin: null })
            .where(
              and(
                eq(documentVersions.documentId, created.documentId),
                eq(documentVersions.version, 1),
              ),
            );
        await store.update(
          scope,
          created.documentId,
          { body: "Draft body" },
          { expectedSchemaHash: schemaHash, attribution: editor },
        );
        const published = await store.getById(scope, created.documentId);
        const listed = (await store.list(scope, {})).rows[0];
        for (const visible of [published, listed]) {
          assert.equal(visible?.body, "Published body");
          assert.equal(visible?.updatedBy, publisher.actorId);
          if (legacy) assert.equal("updatedOrigin" in visible!, false);
          else assert.deepEqual(visible?.updatedOrigin, publisher.origin);
        }
        const draft = await store.getById(scope, created.documentId, {
          draft: true,
        });
        assert.equal(draft?.updatedBy, editor.actorId);
        assert.deepEqual(draft?.updatedOrigin, editor.origin);
      } finally {
        await connection.close();
      }
    },
  );
}
