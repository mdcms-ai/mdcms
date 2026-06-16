import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";
import { createDatabaseContentStore } from "./content-api.js";

import {
  createCms26Author,
  createCms26BlogPost,
  createCms28BlogPostPayload,
  createCms28ReferenceWriteContext,
  createContentDocument,
  createDatabaseTestContext,
  dbEnv,
  deleteContentDocument,
  logger,
  overwriteDraftFrontmatter,
  publishContentDocument,
  resetDatabaseTestScope,
  seedCms26ReferenceSchema,
  seedSchemaRegistryScope,
  scopeHeaders,
  stableFixtureName,
  stableFixturePath,
  stableFixtureUuid,
  testWithDatabase,
} from "./content-api-test-support.js";
import {
  documentVersions,
  documents,
  rbacGrants,
  schemaSyncs,
} from "./db/schema.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";
import { resolveProjectEnvironmentScope } from "./project-provisioning.js";

testWithDatabase(
  "content API integration create rejects missing schema hash header",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-integration-schema-hash-required",
        undefined,
        { autoSchemaHashHeaders: false },
      );
    const project = "cms32-integration-schema-hash-required";
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        schemaHash: "schema-hash-required",
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });

      const response = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: "blog/schema-required",
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "schema-required" },
            body: "missing schema hash",
          }),
        }),
      );
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "SCHEMA_HASH_REQUIRED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB list uses published snapshots by default and hides deleted draft rows unless explicitly requested",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-list-visibility");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": stableFixtureName("content-db-list"),
      "x-mdcms-environment": "production",
    };

    try {
      const publishedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-list-visible-published"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-list-visible-published" },
            body: "published body",
          }),
        }),
      );
      const publishedCreated = (await publishedCreateResponse.json()) as {
        data: { documentId: string; path: string };
      };
      assert.equal(publishedCreateResponse.status, 200);

      const publishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${publishedCreated.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Publish visible baseline",
            }),
          },
        ),
      );
      assert.equal(publishResponse.status, 200);

      const publishedUpdateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${publishedCreated.data.documentId}`,
          {
            method: "PUT",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              path: `${publishedCreated.data.path}-draft`,
              body: "draft body",
            }),
          },
        ),
      );
      assert.equal(publishedUpdateResponse.status, 200);

      const unpublishedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-list-unpublished"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-list-unpublished" },
            body: "unpublished draft body",
          }),
        }),
      );
      const unpublishedCreated = (await unpublishedCreateResponse.json()) as {
        data: { documentId: string; path: string };
      };
      assert.equal(unpublishedCreateResponse.status, 200);

      const deletedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-list-deleted"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-list-deleted" },
            body: "deleted body",
          }),
        }),
      );
      const deletedCreated = (await deletedCreateResponse.json()) as {
        data: { documentId: string; path: string };
      };
      assert.equal(deletedCreateResponse.status, 200);

      const deletedPublishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${deletedCreated.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Publish before delete",
            }),
          },
        ),
      );
      assert.equal(deletedPublishResponse.status, 200);

      const deletedDeleteResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${deletedCreated.data.documentId}`,
          {
            method: "DELETE",
            headers: csrfHeaders(testScopeHeaders),
          },
        ),
      );
      assert.equal(deletedDeleteResponse.status, 200);

      const publishedListResponse = await handler(
        new Request("http://localhost/api/v1/content?sort=path&order=asc", {
          headers: {
            ...testScopeHeaders,
            cookie,
          },
        }),
      );
      const publishedListBody = (await publishedListResponse.json()) as {
        data: Array<{
          documentId: string;
          path: string;
          body: string;
          isDeleted: boolean;
        }>;
      };
      assert.equal(publishedListResponse.status, 200);
      assert.deepEqual(
        publishedListBody.data.map((document) => ({
          documentId: document.documentId,
          path: document.path,
          body: document.body,
          isDeleted: document.isDeleted,
        })),
        [
          {
            documentId: publishedCreated.data.documentId,
            path: publishedCreated.data.path,
            body: "published body",
            isDeleted: false,
          },
        ],
      );

      const draftListResponse = await handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&sort=path&order=asc",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const draftListBody = (await draftListResponse.json()) as {
        data: Array<{
          documentId: string;
          path: string;
          body: string;
          isDeleted: boolean;
        }>;
      };
      assert.equal(draftListResponse.status, 200);
      assert.deepEqual(
        draftListBody.data.map((document) => ({
          documentId: document.documentId,
          path: document.path,
          body: document.body,
          isDeleted: document.isDeleted,
        })),
        [
          {
            documentId: unpublishedCreated.data.documentId,
            path: unpublishedCreated.data.path,
            body: "unpublished draft body",
            isDeleted: false,
          },
          {
            documentId: publishedCreated.data.documentId,
            path: `${publishedCreated.data.path}-draft`,
            body: "draft body",
            isDeleted: false,
          },
        ],
      );

      const deletedDraftListResponse = await handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&isDeleted=true&sort=path&order=asc",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const deletedDraftListBody = (await deletedDraftListResponse.json()) as {
        data: Array<{
          documentId: string;
          path: string;
          body: string;
          isDeleted: boolean;
        }>;
      };
      assert.equal(deletedDraftListResponse.status, 200);
      assert.deepEqual(
        deletedDraftListBody.data.map((document) => ({
          documentId: document.documentId,
          path: document.path,
          body: document.body,
          isDeleted: document.isDeleted,
        })),
        [
          {
            documentId: deletedCreated.data.documentId,
            path: deletedCreated.data.path,
            body: "deleted body",
            isDeleted: true,
          },
        ],
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB search uses published index by default and draft rows only with draft access",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-search");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": stableFixtureName("content-db-search"),
      "x-mdcms-environment": "production",
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, {
        project: testScopeHeaders["x-mdcms-project"],
        environment: testScopeHeaders["x-mdcms-environment"],
      });

      const firstCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "pathneedle"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: {
              slug: "search-launch",
              title: "frontmatterneedle Launch Plan",
            },
            body: "published bodyneedle search marker",
          }),
        }),
      );
      const firstCreated = (await firstCreateResponse.json()) as {
        data: { documentId: string; path: string };
      };
      assert.equal(firstCreateResponse.status, 200);

      await publishContentDocument(
        handler,
        csrfHeaders,
        { ...testScopeHeaders, cookie },
        firstCreated.data.documentId,
      );

      const updateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${firstCreated.data.documentId}`,
          {
            method: "PUT",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              body: "draft-only search needle",
            }),
          },
        ),
      );
      assert.equal(updateResponse.status, 200);

      const secondCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "search-unmatched"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "search-unmatched", title: "Other" },
            body: "unmatched body",
          }),
        }),
      );
      const secondCreated = (await secondCreateResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(secondCreateResponse.status, 200);

      await publishContentDocument(
        handler,
        csrfHeaders,
        { ...testScopeHeaders, cookie },
        secondCreated.data.documentId,
      );

      async function assertPublishedSearchMatches(query: string) {
        const response = await handler(
          new Request(
            `http://localhost/api/v1/content?type=BlogPost&q=${query}&limit=1&offset=0&sort=path&order=asc`,
            {
              headers: {
                ...testScopeHeaders,
                cookie,
              },
            },
          ),
        );
        const body = (await response.json()) as {
          data: Array<{ documentId: string; body: string; path: string }>;
          pagination: { total: number; limit: number; offset: number };
        };

        assert.equal(response.status, 200);
        assert.deepEqual(
          body.data.map((document) => document.documentId),
          [firstCreated.data.documentId],
        );
        assert.equal(body.data[0]?.body, "published bodyneedle search marker");
        assert.equal(body.data[0]?.path, firstCreated.data.path);
        assert.equal(body.pagination.total, 1);
        assert.equal(body.pagination.limit, 1);
        assert.equal(body.pagination.offset, 0);
      }

      await assertPublishedSearchMatches("bodyneedle");
      await assertPublishedSearchMatches("frontmatterneedle");
      await assertPublishedSearchMatches("pathneedle");

      const publishedDraftNeedleResponse = await handler(
        new Request(
          "http://localhost/api/v1/content?q=draft-only&limit=1&offset=0&sort=path&order=asc",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const publishedDraftNeedleBody =
        (await publishedDraftNeedleResponse.json()) as {
          data: Array<{ documentId: string }>;
          pagination: { total: number; limit: number; offset: number };
        };

      assert.equal(publishedDraftNeedleResponse.status, 200);
      assert.deepEqual(publishedDraftNeedleBody.data, []);
      assert.equal(publishedDraftNeedleBody.pagination.total, 0);
      assert.equal(publishedDraftNeedleBody.pagination.limit, 1);
      assert.equal(publishedDraftNeedleBody.pagination.offset, 0);

      const draftSearchResponse = await handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&q=draft-only&limit=1&offset=0&sort=path&order=asc",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const draftSearchBody = (await draftSearchResponse.json()) as {
        data: Array<{ documentId: string; body: string }>;
        pagination: { total: number; limit: number; offset: number };
      };

      assert.equal(draftSearchResponse.status, 200);
      assert.deepEqual(
        draftSearchBody.data.map((document) => document.documentId),
        [firstCreated.data.documentId],
      );
      assert.equal(draftSearchBody.data[0]?.body, "draft-only search needle");
      assert.equal(draftSearchBody.pagination.total, 1);
      assert.equal(draftSearchBody.pagination.limit, 1);
      assert.equal(draftSearchBody.pagination.offset, 0);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB list can group localized variants into logical translation rows",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-grouped-list");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": stableFixtureName("content-db-grouped-list"),
      "x-mdcms-environment": "production",
    };
    const scope = {
      project: testScopeHeaders["x-mdcms-project"],
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        supportedLocales: ["fr", "en"],
        entries: [
          {
            type: "Campaign",
            directory: "content/campaigns",
            localized: true,
            fields: {
              slug: {
                kind: "string",
                required: true,
                nullable: false,
              },
              title: {
                kind: "string",
                required: false,
                nullable: true,
              },
            },
          },
        ],
      });

      const launchPath = stableFixturePath("content/campaigns", "launch");
      const summerPath = stableFixturePath("content/campaigns", "summer-sale");

      const launchFr = (await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        {
          path: launchPath,
          type: "Campaign",
          locale: "fr",
          format: "mdx",
          frontmatter: {
            slug: "launch",
            title: "Lancement de printemps",
          },
          body: "Bonjour depuis le lancement.",
        },
      )) as { documentId: string };
      await createContentDocument(handler, csrfHeaders, testScopeHeaders, {
        path: launchPath,
        type: "Campaign",
        locale: "en",
        format: "mdx",
        sourceDocumentId: launchFr.documentId,
        frontmatter: {
          slug: "launch",
          title: "Spring launch",
        },
        body: "Hello from launch.",
      });

      const publishLaunchFr = await handler(
        new Request(
          `http://localhost/api/v1/content/${launchFr.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Publish French launch",
            }),
          },
        ),
      );
      assert.equal(publishLaunchFr.status, 200);

      const summerFr = (await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        {
          path: summerPath,
          type: "Campaign",
          locale: "fr",
          format: "md",
          frontmatter: {
            slug: "summer-sale",
            title: "Vente d'été",
          },
          body: "Bonjour depuis la vente d'été.",
        },
      )) as { documentId: string };
      const summerEn = (await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        {
          path: summerPath,
          type: "Campaign",
          locale: "en",
          format: "md",
          sourceDocumentId: summerFr.documentId,
          frontmatter: {
            slug: "summer-sale",
            title: "Summer sale",
          },
          body: "Hello from the summer sale.",
        },
      )) as { documentId: string };

      const publishSummerFr = await handler(
        new Request(
          `http://localhost/api/v1/content/${summerFr.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Publish French summer sale",
            }),
          },
        ),
      );
      assert.equal(publishSummerFr.status, 200);

      const publishSummerEn = await handler(
        new Request(
          `http://localhost/api/v1/content/${summerEn.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Publish English summer sale",
            }),
          },
        ),
      );
      assert.equal(publishSummerEn.status, 200);

      const response = await handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&type=Campaign&groupBy=translationGroup&sort=path&order=asc",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Array<{
          documentId: string;
          translationGroupId: string;
          path: string;
          locale: string;
          frontmatter: { title?: string };
          publishedVersion: number | null;
          hasUnpublishedChanges: boolean;
          localesPresent?: string[];
          publishedLocales?: string[];
        }>;
        pagination: {
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.pagination.total, 2);
      assert.equal(body.data.length, 2);
      assert.deepEqual(
        body.data.map((row) => row.path),
        [launchPath, summerPath],
      );
      assert.deepEqual(
        body.data.map((row) => row.locale),
        ["fr", "fr"],
      );
      assert.deepEqual(
        body.data.map((row) => row.frontmatter.title),
        ["Lancement de printemps", "Vente d'été"],
      );
      assert.deepEqual(
        body.data.map((row) => [...(row.localesPresent ?? [])].sort()),
        [
          ["en", "fr"],
          ["en", "fr"],
        ],
      );
      assert.deepEqual(
        body.data.map((row) => [...(row.publishedLocales ?? [])].sort()),
        [["fr"], ["en", "fr"]],
      );
      assert.deepEqual(
        body.data.map((row) => ({
          translationGroupId: row.translationGroupId,
          documentId: row.documentId,
          publishedVersion: row.publishedVersion,
          hasUnpublishedChanges: row.hasUnpublishedChanges,
        })),
        [
          {
            translationGroupId: body.data[0]!.translationGroupId,
            documentId: launchFr.documentId,
            publishedVersion: 1,
            hasUnpublishedChanges: true,
          },
          {
            translationGroupId: body.data[1]!.translationGroupId,
            documentId: summerFr.documentId,
            publishedVersion: 1,
            hasUnpublishedChanges: false,
          },
        ],
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API overview returns metadata counts without exposing draft rows",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-overview-counts");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": stableFixtureName("content-overview-counts"),
      "x-mdcms-environment": "production",
    };

    try {
      const publishedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "overview-published"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "overview-published" },
            body: "published body",
          }),
        }),
      );
      const publishedCreated = (await publishedCreateResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(publishedCreateResponse.status, 200);

      const publishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${publishedCreated.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "publish overview baseline",
            }),
          },
        ),
      );
      assert.equal(publishResponse.status, 200);

      const publishedUpdateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${publishedCreated.data.documentId}`,
          {
            method: "PUT",
            headers: csrfHeaders({
              ...testScopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              body: "published document with newer draft changes",
            }),
          },
        ),
      );
      assert.equal(publishedUpdateResponse.status, 200);

      const draftOnlyCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "overview-draft-only"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "overview-draft-only" },
            body: "draft only body",
          }),
        }),
      );
      assert.equal(draftOnlyCreateResponse.status, 200);

      const deletedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "overview-deleted"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "overview-deleted" },
            body: "deleted body",
          }),
        }),
      );
      const deletedCreated = (await deletedCreateResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(deletedCreateResponse.status, 200);

      const deletedResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${deletedCreated.data.documentId}`,
          {
            method: "DELETE",
            headers: csrfHeaders(testScopeHeaders),
          },
        ),
      );
      assert.equal(deletedResponse.status, 200);

      const overviewResponse = await handler(
        new Request(
          "http://localhost/api/v1/content/overview?type=BlogPost&type=Page",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const overviewBody = (await overviewResponse.json()) as {
        data: Array<{
          type: string;
          total: number;
          published: number;
          drafts: number;
          documentId?: string;
          body?: string;
        }>;
      };

      assert.equal(overviewResponse.status, 200);
      assert.deepEqual(overviewBody.data, [
        {
          type: "BlogPost",
          total: 2,
          published: 1,
          drafts: 1,
        },
        {
          type: "Page",
          total: 0,
          published: 0,
          drafts: 0,
        },
      ]);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API publish persists change_summary to immutable document_versions row",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-change-summary");

    try {
      const createResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "change-summary"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "change-summary" },
            body: "body",
          }),
        }),
      );
      const created = (await createResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(createResponse.status, 200);

      const publishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              change_summary: "Ship release v1",
            }),
          },
        ),
      );
      assert.equal(publishResponse.status, 200);

      const versionRows = await dbConnection.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, created.data.documentId));

      assert.equal(versionRows.length, 1);
      assert.equal(versionRows[0]?.changeSummary, "Ship release v1");
      assert.equal(versionRows[0]?.version, 1);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB restore returns CONTENT_PATH_CONFLICT when undelete collides with an active path",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-restore-conflict");

    try {
      const trashedCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-restore-conflict"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-restore-conflict" },
            body: "trashed body",
          }),
        }),
      );
      const trashedDocument = (await trashedCreateResponse.json()) as {
        data: { documentId: string; path: string };
      };

      assert.equal(trashedCreateResponse.status, 200);

      const deleteResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${trashedDocument.data.documentId}`,
          {
            method: "DELETE",
            headers: csrfHeaders({
              ...scopeHeaders,
            }),
          },
        ),
      );

      assert.equal(deleteResponse.status, 200);

      const conflictingCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: trashedDocument.data.path,
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-restore-conflict-live" },
            body: "live body",
          }),
        }),
      );
      const conflictingDocument = (await conflictingCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(conflictingCreateResponse.status, 200);

      const restoreResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${trashedDocument.data.documentId}/restore`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...scopeHeaders,
            }),
          },
        ),
      );
      const restoreBody = (await restoreResponse.json()) as {
        code: string;
        details?: {
          conflictDocumentId?: string;
          path?: string;
          locale?: string;
        };
      };

      assert.equal(restoreResponse.status, 409);
      assert.equal(restoreBody.code, "CONTENT_PATH_CONFLICT");
      assert.equal(
        restoreBody.details?.conflictDocumentId,
        conflictingDocument.data.documentId,
      );
      assert.equal(restoreBody.details?.path, trashedDocument.data.path);
      assert.equal(restoreBody.details?.locale, "en");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB restore version with targetStatus=published appends a new immutable version",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-db-restore-version-published",
      );

    try {
      const createResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-restore-version"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-restore-version", title: "Version One" },
            body: "version one body",
          }),
        }),
      );
      const created = (await createResponse.json()) as {
        data: { documentId: string; path: string };
      };

      assert.equal(createResponse.status, 200);

      const firstPublishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              changeSummary: "Version one",
            }),
          },
        ),
      );

      assert.equal(firstPublishResponse.status, 200);

      const updateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}`,
          {
            method: "PUT",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              path: `${created.data.path}-updated`,
              frontmatter: {
                slug: "db-restore-version",
                title: "Version Two",
              },
              body: "version two body",
            }),
          },
        ),
      );

      assert.equal(updateResponse.status, 200);

      const secondPublishResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}/publish`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              changeSummary: "Version two",
            }),
          },
        ),
      );

      assert.equal(secondPublishResponse.status, 200);

      const restoreResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}/versions/1/restore`,
          {
            method: "POST",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              targetStatus: "published",
              change_summary: "Republish version one",
            }),
          },
        ),
      );
      const restoreBody = (await restoreResponse.json()) as {
        data: {
          publishedVersion: number | null;
          version: number;
          path: string;
          body: string;
          hasUnpublishedChanges: boolean;
        };
      };

      assert.equal(restoreResponse.status, 200);
      assert.equal(restoreBody.data.publishedVersion, 3);
      assert.equal(restoreBody.data.version, 3);
      assert.equal(restoreBody.data.path, created.data.path);
      assert.equal(restoreBody.data.body, "version one body");
      assert.equal(restoreBody.data.hasUnpublishedChanges, false);

      const versionsResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.data.documentId}/versions?limit=2&offset=1`,
          {
            headers: csrfHeaders({
              ...scopeHeaders,
            }),
          },
        ),
      );
      const versionsBody = (await versionsResponse.json()) as {
        data: Array<{ version: number }>;
        pagination: {
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
        };
      };

      assert.equal(versionsResponse.status, 200);
      assert.equal(versionsBody.data.length, 2);
      assert.equal(versionsBody.data[0]?.version, 2);
      assert.equal(versionsBody.data[1]?.version, 1);
      assert.deepEqual(versionsBody.pagination, {
        total: 3,
        limit: 2,
        offset: 1,
        hasMore: false,
      });

      const versionRows = await dbConnection.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, created.data.documentId));

      versionRows.sort((left, right) => left.version - right.version);

      assert.equal(versionRows.length, 3);
      assert.equal(versionRows[0]?.version, 1);
      assert.equal(versionRows[0]?.body, "version one body");
      assert.equal(versionRows[1]?.version, 2);
      assert.equal(versionRows[1]?.body, "version two body");
      assert.equal(versionRows[2]?.version, 3);
      assert.equal(versionRows[2]?.path, created.data.path);
      assert.equal(versionRows[2]?.body, "version one body");
      assert.equal(versionRows[2]?.changeSummary, "Republish version one");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API keeps documents isolated across routed projects",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-routed-project-scope");

    try {
      const marketingCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "scope-marketing"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "scope-marketing" },
            body: "marketing body",
          }),
        }),
      );
      const marketingDocument = (await marketingCreateResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(marketingCreateResponse.status, 200);

      const docsScopeHeaders = {
        "x-mdcms-project": "docs-site",
        "x-mdcms-environment": "production",
      };
      const docsCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...docsScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("docs", "scope"),
            type: "Page",
            locale: "en",
            format: "md",
            frontmatter: { slug: "scope-docs" },
            body: "docs body",
          }),
        }),
      );
      assert.equal(docsCreateResponse.status, 200);

      const wrongProjectGetResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${marketingDocument.data.documentId}?draft=true`,
          {
            headers: {
              ...docsScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const wrongProjectGetBody = (await wrongProjectGetResponse.json()) as {
        code: string;
      };
      assert.equal(wrongProjectGetResponse.status, 404);
      assert.equal(wrongProjectGetBody.code, "NOT_FOUND");

      const wrongProjectDeleteResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${marketingDocument.data.documentId}`,
          {
            method: "DELETE",
            headers: csrfHeaders({
              ...docsScopeHeaders,
            }),
          },
        ),
      );
      const wrongProjectDeleteBody =
        (await wrongProjectDeleteResponse.json()) as {
          code: string;
        };
      assert.equal(wrongProjectDeleteResponse.status, 404);
      assert.equal(wrongProjectDeleteBody.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);

// `createHandler` and the DB-backed helpers live in the support module; the
// tests keep their direct assertions and local fixtures here.

testWithDatabase(
  "content API rejects session mutations without CSRF, accepts matching CSRF, and exempts API key writes",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-csrf");

    try {
      const missingHeaderResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: {
            ...scopeHeaders,
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            path: stableFixturePath("blog", "csrf-missing"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "csrf-missing" },
            body: "missing header",
          }),
        }),
      );
      const missingHeaderBody = (await missingHeaderResponse.json()) as {
        code: string;
      };

      assert.equal(missingHeaderResponse.status, 403);
      assert.equal(missingHeaderBody.code, "FORBIDDEN");

      const allowedSessionResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "csrf-session"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "csrf-session" },
            body: "session allowed",
          }),
        }),
      );

      assert.equal(allowedSessionResponse.status, 200);
      const resolvedScope = await resolveProjectEnvironmentScope(
        dbConnection.db,
        {
          project: scopeHeaders["x-mdcms-project"],
          environment: scopeHeaders["x-mdcms-environment"],
        },
      );
      assert.ok(resolvedScope);
      const schemaSync = await dbConnection.db.query.schemaSyncs.findFirst({
        where: and(
          eq(schemaSyncs.projectId, resolvedScope.project.id),
          eq(schemaSyncs.environmentId, resolvedScope.environment.id),
        ),
      });
      assert.ok(schemaSync);

      const apiKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: csrfHeaders({
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "content-csrf-write",
            scopes: ["content:write"],
            contextAllowlist: [
              {
                project: scopeHeaders["x-mdcms-project"],
                environment: "production",
              },
            ],
          }),
        }),
      );
      const apiKeyBody = (await apiKeyResponse.json()) as {
        data: { key: string };
      };

      assert.equal(apiKeyResponse.status, 200);

      const apiKeyCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${apiKeyBody.data.key}`,
            "content-type": "application/json",
            "x-mdcms-schema-hash": schemaSync.schemaHash,
          },
          body: JSON.stringify({
            path: stableFixturePath("blog", "csrf-api-key"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "csrf-api-key" },
            body: "api key allowed",
          }),
        }),
      );

      assert.equal(apiKeyCreateResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API create rejects missing schema hash header",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-schema-hash-required",
        createServerRequestHandlerWithModules,
        { autoSchemaHashHeaders: false },
      );
    const project = stableFixtureName("cms29-required");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        schemaHash: "schema-hash-required",
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });

      const response = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "schema-required"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "schema-required" },
            body: "missing schema hash",
          }),
        }),
      );
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "SCHEMA_HASH_REQUIRED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "cms-28 reference write create rejects nested object and array violations",
  async () => {
    const { handler, dbConnection, csrfHeaders, testScopeHeaders } =
      await createCms28ReferenceWriteContext(
        "test:cms-28-reference-write-nested-array",
      );

    try {
      const validAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "cms28-array-valid",
      );

      const nestedResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createCms28BlogPostPayload({
              hero: {
                author: stableFixtureUuid(
                  "cms28-reference-write-nested-author",
                ),
              },
            }),
          ),
        }),
      );
      const nestedBody = (await nestedResponse.json()) as {
        code: string;
      };
      assert.equal(nestedResponse.status, 400);
      assert.equal(nestedBody.code, "INVALID_INPUT");

      const arrayResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createCms28BlogPostPayload({
              contributors: [validAuthor.documentId, "not-a-uuid"],
            }),
          ),
        }),
      );
      const arrayBody = (await arrayResponse.json()) as {
        code: string;
      };
      assert.equal(arrayResponse.status, 400);
      assert.equal(arrayBody.code, "INVALID_INPUT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "cms-28 reference write update rejects missing targets",
  async () => {
    const { handler, dbConnection, csrfHeaders, testScopeHeaders } =
      await createCms28ReferenceWriteContext(
        "test:cms-28-reference-write-update-invalid",
      );

    try {
      const basePayload = createCms28BlogPostPayload({
        title: "before",
      });
      const created = await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        basePayload,
      );

      const response = await handler(
        new Request(`http://localhost/api/v1/content/${created.documentId}`, {
          method: "PUT",
          headers: csrfHeaders({
            ...testScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            frontmatter: {
              ...(basePayload.frontmatter ?? {}),
              author: stableFixtureUuid("cms28-reference-write-update-author"),
            },
            body: "updated body",
          }),
        }),
      );
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_INPUT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "cms-28 database content store enforces reference identity when schema snapshots are present",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const scope = {
      project: stableFixtureName("cms28-db-store"),
      environment: "production",
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const store = createDatabaseContentStore({ db: dbConnection.db });
      const page = await store.create(scope, {
        path: stableFixturePath("pages", "cms28-db-page"),
        type: "Page",
        locale: "en",
        format: "md",
        frontmatter: {
          slug: stableFixtureName("cms28-db-page"),
        },
        body: "page body",
      });
      const blogPayload = createCms28BlogPostPayload({
        title: "db base",
      });
      const blog = await store.create(scope, blogPayload);

      await assert.rejects(
        () =>
          store.create(scope, {
            ...createCms28BlogPostPayload({
              author: page.documentId,
            }),
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "INVALID_INPUT");
          return true;
        },
      );

      await assert.rejects(
        () =>
          store.update(scope, blog.documentId, {
            frontmatter: {
              ...(blogPayload.frontmatter ?? {}),
              author: stableFixtureUuid(
                "cms28-reference-write-db-update-author",
              ),
            },
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "INVALID_INPUT");
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve list inline returns referenced authors",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-list");
    const project = stableFixtureName("cms26-resolve-list");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const mainAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "list-primary",
      );
      const heroAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "list-hero",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-list",
        {
          author: mainAuthor.documentId as string,
          hero: { author: heroAuthor.documentId as string },
        },
      );

      const response = await handler(
        new Request(
          "http://localhost/api/v1/content?type=BlogPost&draft=true&sort=path&order=asc&resolve=author&resolve=hero.author",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };

      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);

      const [document] = body.data;
      assert.equal(document.documentId, blog.documentId);
      const frontmatter = document.frontmatter as Record<string, unknown>;
      const resolvedAuthor = frontmatter.author as Record<string, unknown>;
      assert.equal(resolvedAuthor?.documentId, mainAuthor.documentId);
      const hero = frontmatter.hero as Record<string, unknown> | undefined;
      const resolvedHero = hero?.author as Record<string, unknown>;
      assert.equal(resolvedHero?.documentId, heroAuthor.documentId);
      assert.equal(document.resolveErrors, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve single document returns inline references",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-single");
    const project = stableFixtureName("cms26-resolve-single");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const mainAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "single-primary",
      );
      const heroAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "single-hero",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-single",
        {
          author: mainAuthor.documentId as string,
          hero: { author: heroAuthor.documentId as string },
        },
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=author&resolve=hero.author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const document = body.data;
      const frontmatter = document.frontmatter as Record<string, unknown>;
      const resolvedAuthor = frontmatter.author as Record<string, unknown>;
      assert.equal(resolvedAuthor?.documentId, mainAuthor.documentId);
      const hero = frontmatter.hero as Record<string, unknown> | undefined;
      const resolvedHero = hero?.author as Record<string, unknown>;
      assert.equal(resolvedHero?.documentId, heroAuthor.documentId);
      assert.equal(document.resolveErrors, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve version detail returns inline references",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-version");
    const project = stableFixtureName("cms26-resolve-version");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "version-primary",
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        author.documentId as string,
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-version",
        {
          author: author.documentId as string,
        },
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        blog.documentId as string,
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}/versions/1?resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      const resolvedAuthor = frontmatter.author as Record<string, unknown>;
      assert.equal(resolvedAuthor?.documentId, author.documentId);
      assert.equal(body.data.resolveErrors, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API version summary stays summary-only when resolve is requested",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-versions-summary-resolve",
      );
    const project = stableFixtureName("cms26-resolve-summary");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "summary-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-summary",
        {
          author: author.documentId as string,
        },
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        blog.documentId as string,
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}/versions?resolve=author&limit=1`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };

      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].frontmatter, undefined);
      assert.equal(body.data[0].resolveErrors, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve rejects invalid and non-reference paths",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-invalid-path");
    const project = stableFixtureName("cms26-resolve-invalid");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "invalid-path-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-invalid",
        {
          author: author.documentId as string,
          slugline: "not-a-reference",
        },
      );

      const invalidResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=missingField`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const invalidBody = (await invalidResponse.json()) as {
        code: string;
      };
      assert.equal(invalidResponse.status, 400);
      assert.equal(invalidBody.code, "INVALID_QUERY_PARAM");

      const nonRefResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=slugline`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const nonRefBody = (await nonRefResponse.json()) as {
        code: string;
      };
      assert.equal(nonRefResponse.status, 400);
      assert.equal(nonRefBody.code, "INVALID_QUERY_PARAM");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve list requires a type filter",
  async () => {
    const { handler, dbConnection, cookie } = await createDatabaseTestContext(
      "test:content-api-resolve-list-requires-type",
    );
    const project = stableFixtureName("cms26-resolve-list-type");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);

      const response = await handler(
        new Request(
          "http://localhost/api/v1/content?draft=true&resolve=author",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_QUERY_PARAM");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve missing reference records resolveErrors",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-missing");
    const project = stableFixtureName("cms26-resolve-missing");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const heroAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "missing-hero",
      );
      const missingId = stableFixtureUuid("cms26-resolve-missing-author");
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-missing",
        {
          author: heroAuthor.documentId as string,
          hero: { author: heroAuthor.documentId as string },
        },
      );
      await overwriteDraftFrontmatter(
        dbConnection.db,
        blog.documentId as string,
        {
          slug: "resolve-missing",
          author: missingId,
          hero: { author: heroAuthor.documentId as string },
        },
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=author&resolve=hero.author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const hero = frontmatter.hero as Record<string, unknown> | undefined;
      const resolvedHero = hero?.author as Record<string, unknown>;
      assert.equal(resolvedHero?.documentId, heroAuthor.documentId);

      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_NOT_FOUND",
      );
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.ref.documentId,
        missingId,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve malformed reference values become null with resolveErrors",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-malformed");
    const project = stableFixtureName("cms26-resolve-malformed");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "malformed-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-malformed",
        {
          author: author.documentId as string,
        },
      );
      await overwriteDraftFrontmatter(
        dbConnection.db,
        blog.documentId as string,
        {
          slug: "resolve-malformed",
          author: {
            bad: true,
          },
        },
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_NOT_FOUND",
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve deleted reference surfaces resolveErrors",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-deleted");
    const project = stableFixtureName("cms26-resolve-deleted");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const deletedAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "deleted-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-deleted",
        {
          hero: { author: deletedAuthor.documentId as string },
        },
      );
      await deleteContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        deletedAuthor.documentId as string,
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=hero.author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      const hero = frontmatter.hero as Record<string, unknown> | undefined;
      assert.equal(hero?.author, null);

      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.hero.author"]?.code,
        "REFERENCE_DELETED",
      );
      assert.equal(
        resolveErrors?.["frontmatter.hero.author"]?.ref.documentId,
        deletedAuthor.documentId,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve hidden deleted references surface forbidden",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders, userId } =
      await createDatabaseTestContext(
        "test:content-api-resolve-hidden-deleted",
      );
    const project = stableFixtureName("cms26-resolve-hidden-deleted");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "hidden-deleted-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "hidden-deleted-blog",
        {
          author: author.documentId as string,
        },
      );
      await deleteContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        author.documentId as string,
      );

      await dbConnection.db
        .delete(rbacGrants)
        .where(eq(rbacGrants.userId, userId));

      await dbConnection.db.insert(rbacGrants).values({
        userId,
        role: "editor",
        scopeKind: "folder_prefix",
        project,
        environment: "production",
        pathPrefix: "blog/",
        source: "test:content-api-resolve-hidden-deleted",
        createdByUserId: userId,
      });

      const response = await handler(
        new Request(
          "http://localhost/api/v1/content?type=BlogPost&draft=true&path=blog/&resolve=author",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };

      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0]?.documentId, blog.documentId);
      const frontmatter = body.data[0]?.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data[0]?.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_FORBIDDEN",
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve type mismatch surfaces resolveErrors",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-type-mismatch");
    const project = stableFixtureName("cms26-resolve-mismatch");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "mismatch-author",
      );
      const page = await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        {
          path: stableFixturePath("pages", "cms26"),
          type: "Page",
          locale: "en",
          format: "md",
          frontmatter: {
            slug: "resolve-page-type-mismatch",
          },
          body: "page body",
        },
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-mismatch",
        {
          author: author.documentId as string,
        },
      );
      await overwriteDraftFrontmatter(
        dbConnection.db,
        blog.documentId as string,
        {
          slug: "resolve-mismatch",
          author: page.documentId as string,
        },
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_TYPE_MISMATCH",
      );
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.ref.documentId,
        page.documentId,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve forbidden reference surfaces resolveErrors on list reads",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders, userId } =
      await createDatabaseTestContext("test:content-api-resolve-forbidden");
    const project = stableFixtureName("cms26-resolve-forbidden");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "forbidden-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-forbidden",
        {
          author: author.documentId as string,
        },
      );

      await dbConnection.db
        .delete(rbacGrants)
        .where(eq(rbacGrants.userId, userId));

      await dbConnection.db.insert(rbacGrants).values({
        userId,
        role: "editor",
        scopeKind: "folder_prefix",
        project,
        environment: "production",
        pathPrefix: "blog/",
        source: "test:content-api-resolve-forbidden",
        createdByUserId: userId,
      });

      const response = await handler(
        new Request(
          "http://localhost/api/v1/content?type=BlogPost&draft=true&path=blog/&resolve=author",
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Array<Record<string, unknown>>;
      };

      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0]?.documentId, blog.documentId);
      const frontmatter = body.data[0]?.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data[0]?.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_FORBIDDEN",
      );
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.ref.documentId,
        author.documentId,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve draft-only references publishes as not found but resolves in drafts",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-resolve-draft-only");
    const project = stableFixtureName("cms26-resolve-draft");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const draftOnlyAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "draft-only-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-draft",
        {
          author: draftOnlyAuthor.documentId as string,
        },
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        blog.documentId as string,
      );

      const publishedResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const publishedBody = (await publishedResponse.json()) as {
        data: Record<string, unknown>;
      };
      assert.equal(publishedResponse.status, 200);
      const publishedFrontmatter = publishedBody.data.frontmatter as Record<
        string,
        unknown
      >;
      assert.equal(publishedFrontmatter.author, null);
      const publishedErrors = publishedBody.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(publishedErrors);
      assert.equal(
        publishedErrors?.["frontmatter.author"]?.code,
        "REFERENCE_NOT_FOUND",
      );

      const draftResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?draft=true&resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const draftBody = (await draftResponse.json()) as {
        data: Record<string, unknown>;
      };
      assert.equal(draftResponse.status, 200);
      const draftFrontmatter = draftBody.data.frontmatter as Record<
        string,
        unknown
      >;
      const resolvedAuthor = draftFrontmatter.author as Record<
        string,
        unknown
      > | null;
      assert.equal(resolvedAuthor?.documentId, draftOnlyAuthor.documentId);
      assert.equal(draftBody.data.resolveErrors, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve published reads hide draft-only deleted references as not found",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-resolve-published-draft-deleted",
      );
    const project = stableFixtureName("cms26-resolve-published-deleted");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const deletedAuthor = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "draft-only-deleted-author",
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-published-deleted",
        {
          author: deletedAuthor.documentId as string,
        },
      );
      await deleteContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        deletedAuthor.documentId as string,
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        blog.documentId as string,
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_NOT_FOUND",
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API resolve published reads hide draft-only type mismatches as not found",
  async () => {
    const { handler, dbConnection, cookie, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-resolve-published-draft-mismatch",
      );
    const project = stableFixtureName("cms26-resolve-published-mismatch");
    const testScopeHeaders = {
      ...scopeHeaders,
      "x-mdcms-project": project,
      "x-mdcms-environment": "production",
    };
    const scope = {
      project,
      environment: testScopeHeaders["x-mdcms-environment"],
    };

    try {
      await seedCms26ReferenceSchema(dbConnection.db, scope);
      const author = await createCms26Author(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "published-mismatch-author",
      );
      const draftOnlyPage = await createContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        {
          path: stableFixturePath("pages", "cms26-published-mismatch"),
          type: "Page",
          locale: "en",
          format: "md",
          frontmatter: {
            slug: "draft-only-page",
          },
          body: "draft-only page body",
        },
      );
      const blog = await createCms26BlogPost(
        handler,
        csrfHeaders,
        testScopeHeaders,
        "resolve-published-mismatch",
        {
          author: author.documentId as string,
        },
      );
      await overwriteDraftFrontmatter(
        dbConnection.db,
        blog.documentId as string,
        {
          slug: "resolve-published-mismatch",
          author: draftOnlyPage.documentId as string,
        },
      );
      await publishContentDocument(
        handler,
        csrfHeaders,
        testScopeHeaders,
        blog.documentId as string,
      );

      const response = await handler(
        new Request(
          `http://localhost/api/v1/content/${blog.documentId}?resolve=author`,
          {
            headers: {
              ...testScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };

      assert.equal(response.status, 200);
      const frontmatter = body.data.frontmatter as Record<string, unknown>;
      assert.equal(frontmatter.author, null);
      const resolveErrors = body.data.resolveErrors as
        | Record<string, { code: string; ref: Record<string, unknown> }>
        | undefined;
      assert.ok(resolveErrors);
      assert.equal(
        resolveErrors?.["frontmatter.author"]?.code,
        "REFERENCE_NOT_FOUND",
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database content store prefers CONTENT_PATH_CONFLICT over translation conflict after a wrapped insert-time race",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const scope = {
      project: stableFixtureName("race-path-precedence"),
      environment: "production",
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });
      const sourceStore = createDatabaseContentStore({ db: dbConnection.db });
      const sourceDocument = await sourceStore.create(scope, {
        path: stableFixturePath("blog", "race-source"),
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "race-source" },
        body: "source body",
      });

      const wrappedDb = Object.assign(Object.create(dbConnection.db), {
        query: dbConnection.db.query,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          dbConnection.db.transaction(async (tx) => {
            const wrappedTx = Object.assign(Object.create(tx), {
              query: tx.query,
              insert: (table: unknown) => {
                if (table === documents) {
                  return {
                    values: (values: typeof documents.$inferInsert) => ({
                      returning: async () => {
                        await dbConnection.db
                          .insert(documents)
                          .values({
                            ...values,
                            documentId: stableFixtureUuid(
                              "race-path-precedence-tx-document",
                            ),
                          })
                          .returning();

                        const error = new Error("duplicate", {
                          cause: {
                            code: "23505",
                            constraint_name:
                              "uniq_documents_active_translation_locale",
                          },
                        });
                        throw error;
                      },
                    }),
                  };
                }

                return tx.insert(table as any);
              },
            });

            return callback(wrappedTx);
          }),
        insert: (table: unknown) => {
          if (table === documents) {
            return {
              values: (values: typeof documents.$inferInsert) => ({
                returning: async () => {
                  await dbConnection.db
                    .insert(documents)
                    .values({
                      ...values,
                      documentId: stableFixtureUuid(
                        "race-path-precedence-db-document",
                      ),
                    })
                    .returning();

                  const error = new Error("duplicate", {
                    cause: {
                      code: "23505",
                      constraint_name:
                        "uniq_documents_active_translation_locale",
                    },
                  });
                  throw error;
                },
              }),
            };
          }

          return dbConnection.db.insert(table as any);
        },
      });

      const store = createDatabaseContentStore({
        db: wrappedDb as typeof dbConnection.db,
      });

      await assert.rejects(
        () =>
          store.create(scope, {
            path: stableFixturePath("blog", "race-target"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "race-target" },
            body: "variant body",
            sourceDocumentId: sourceDocument.documentId,
          }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "CONTENT_PATH_CONFLICT",
          );
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database content store returns TRANSLATION_VARIANT_CONFLICT after a wrapped update-time locale race",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const scope = {
      project: stableFixtureName("race-update-precedence"),
      environment: "production",
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });
      const sourceStore = createDatabaseContentStore({ db: dbConnection.db });
      const sourceDocument = await sourceStore.create(scope, {
        path: stableFixturePath("blog", "race-update-source"),
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "race-update-source" },
        body: "source body",
      });
      const deVariant = await sourceStore.create(scope, {
        path: stableFixturePath("blog", "race-update-de"),
        type: "BlogPost",
        locale: "de",
        format: "md",
        frontmatter: { slug: "race-update-de" },
        body: "de body",
        sourceDocumentId: sourceDocument.documentId,
      });
      const sourceRow = await dbConnection.db.query.documents.findFirst({
        where: eq(documents.documentId, sourceDocument.documentId),
      });

      assert.ok(sourceRow);

      const wrappedDb = Object.assign(Object.create(dbConnection.db), {
        query: dbConnection.db.query,
        transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
          dbConnection.db.transaction(async (tx) => {
            const wrappedTx = Object.assign(Object.create(tx), {
              query: tx.query,
              insert: tx.insert.bind(tx),
              update: (table: unknown) => {
                if (table === documents) {
                  return {
                    set: (values: Partial<typeof documents.$inferInsert>) => ({
                      where: () => ({
                        returning: async () => {
                          await dbConnection.db
                            .insert(documents)
                            .values({
                              documentId: stableFixtureUuid(
                                "race-update-precedence-tx-document",
                              ),
                              translationGroupId: sourceRow.translationGroupId,
                              projectId: sourceRow.projectId,
                              environmentId: sourceRow.environmentId,
                              path: stableFixturePath(
                                "blog",
                                "race-update-fr-competitor",
                              ),
                              schemaType: sourceRow.schemaType,
                              locale:
                                typeof values.locale === "string"
                                  ? values.locale
                                  : "fr",
                              contentFormat: sourceRow.contentFormat,
                              body: "fr competitor body",
                              frontmatter: {
                                slug: "race-update-fr-competitor",
                              },
                              isDeleted: false,
                              hasUnpublishedChanges: true,
                              publishedVersion: null,
                              draftRevision: 1,
                              createdBy: sourceRow.createdBy,
                              updatedBy: sourceRow.updatedBy,
                            })
                            .returning();

                          const error = new Error("duplicate", {
                            cause: {
                              code: "23505",
                              constraint_name:
                                "uniq_documents_active_translation_locale",
                            },
                          });
                          throw error;
                        },
                      }),
                    }),
                  };
                }

                return tx.update(table as any);
              },
            });

            return callback(wrappedTx);
          }),
        insert: dbConnection.db.insert.bind(dbConnection.db),
        update: (table: unknown) => {
          if (table === documents) {
            return {
              set: (values: Partial<typeof documents.$inferInsert>) => ({
                where: () => ({
                  returning: async () => {
                    await dbConnection.db
                      .insert(documents)
                      .values({
                        documentId: stableFixtureUuid(
                          "race-update-precedence-db-document",
                        ),
                        translationGroupId: sourceRow.translationGroupId,
                        projectId: sourceRow.projectId,
                        environmentId: sourceRow.environmentId,
                        path: stableFixturePath(
                          "blog",
                          "race-update-fr-competitor",
                        ),
                        schemaType: sourceRow.schemaType,
                        locale:
                          typeof values.locale === "string"
                            ? values.locale
                            : "fr",
                        contentFormat: sourceRow.contentFormat,
                        body: "fr competitor body",
                        frontmatter: { slug: "race-update-fr-competitor" },
                        isDeleted: false,
                        hasUnpublishedChanges: true,
                        publishedVersion: null,
                        draftRevision: 1,
                        createdBy: sourceRow.createdBy,
                        updatedBy: sourceRow.updatedBy,
                      })
                      .returning();

                    const error = new Error("duplicate", {
                      cause: {
                        code: "23505",
                        constraint_name:
                          "uniq_documents_active_translation_locale",
                      },
                    });
                    throw error;
                  },
                }),
              }),
            };
          }

          return dbConnection.db.update(table as any);
        },
      });

      const store = createDatabaseContentStore({
        db: wrappedDb as typeof dbConnection.db,
      });

      await assert.rejects(
        () =>
          store.update(scope, deVariant.documentId, {
            locale: "fr",
          }),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "TRANSLATION_VARIANT_CONFLICT",
          );
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create reuses translationGroupId for sourceDocumentId variants",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-variant");

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string; translationGroupId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const variantCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-variant"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-variant" },
            body: "variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const variantCreated = (await variantCreateResponse.json()) as {
        data: { documentId: string; translationGroupId: string };
      };

      assert.equal(variantCreateResponse.status, 200);
      assert.notEqual(
        variantCreated.data.documentId,
        sourceCreated.data.documentId,
      );
      assert.equal(
        variantCreated.data.translationGroupId,
        sourceCreated.data.translationGroupId,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB update returns TRANSLATION_VARIANT_CONFLICT for variant locale collisions",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-db-update-translation-conflict",
      );

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-update-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-update-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(sourceCreateResponse.status, 200);

      const frVariantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-update-fr"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-update-fr" },
            body: "fr body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      assert.equal(frVariantResponse.status, 200);

      const deVariantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-update-de"),
            type: "BlogPost",
            locale: "de",
            format: "md",
            frontmatter: { slug: "db-update-de" },
            body: "de body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const deVariantCreated = (await deVariantResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(deVariantResponse.status, 200);

      const updateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${deVariantCreated.data.documentId}`,
          {
            method: "PUT",
            headers: csrfHeaders({
              ...scopeHeaders,
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              locale: "fr",
            }),
          },
        ),
      );
      const updateBody = (await updateResponse.json()) as {
        code: string;
      };

      assert.equal(updateResponse.status, 409);
      assert.equal(updateBody.code, "TRANSLATION_VARIANT_CONFLICT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create returns CONTENT_PATH_CONFLICT when a variant path and locale are already taken",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-path-conflict");

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-path-conflict-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-path-conflict-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const existingLocaleResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-path-conflict-target"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-path-conflict-target" },
            body: "existing body",
          }),
        }),
      );
      const existingLocaleCreated = (await existingLocaleResponse.json()) as {
        data: { path: string };
      };

      assert.equal(existingLocaleResponse.status, 200);

      const variantCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: existingLocaleCreated.data.path,
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-path-conflict-variant" },
            body: "variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const variantCreateBody = (await variantCreateResponse.json()) as {
        code: string;
      };

      assert.equal(variantCreateResponse.status, 409);
      assert.equal(variantCreateBody.code, "CONTENT_PATH_CONFLICT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create rejects duplicate locale variants in the same translation group",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-duplicate-locale");

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-duplicate-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-duplicate-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const firstVariantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-duplicate-first"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-duplicate-first" },
            body: "first variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );

      assert.equal(firstVariantResponse.status, 200);

      const duplicateVariantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-duplicate-second"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-duplicate-second" },
            body: "second variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const duplicateVariantBody = (await duplicateVariantResponse.json()) as {
        code: string;
      };

      assert.equal(duplicateVariantResponse.status, 409);
      assert.equal(duplicateVariantBody.code, "TRANSLATION_VARIANT_CONFLICT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create returns NOT_FOUND for missing or cross-scope sourceDocumentId",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-not-found");

    try {
      const missingSourceResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-missing-source"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-missing-source" },
            body: "missing source body",
            sourceDocumentId: "00000000-0000-0000-0000-000000000099",
          }),
        }),
      );
      const missingSourceBody = (await missingSourceResponse.json()) as {
        code: string;
      };

      assert.equal(missingSourceResponse.status, 404);
      assert.equal(missingSourceBody.code, "NOT_FOUND");

      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-cross-scope-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-cross-scope-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const docsScopeHeaders = {
        "x-mdcms-project": "docs-site",
        "x-mdcms-environment": "production",
      };
      const crossScopeVariantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...docsScopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("docs", "db-cross-scope"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-cross-scope" },
            body: "cross scope body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const crossScopeVariantBody =
        (await crossScopeVariantResponse.json()) as {
          code: string;
        };

      assert.equal(crossScopeVariantResponse.status, 404);
      assert.equal(crossScopeVariantBody.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create returns NOT_FOUND for soft-deleted sourceDocumentId",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-soft-delete");

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-soft-delete-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-soft-delete-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const deleteSourceResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${sourceCreated.data.documentId}`,
          {
            method: "DELETE",
            headers: csrfHeaders({
              ...scopeHeaders,
            }),
          },
        ),
      );

      assert.equal(deleteSourceResponse.status, 200);

      const variantCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-soft-delete-variant"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-soft-delete-variant" },
            body: "variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const variantCreateBody = (await variantCreateResponse.json()) as {
        code: string;
      };

      assert.equal(variantCreateResponse.status, 404);
      assert.equal(variantCreateBody.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB create returns INVALID_INPUT for source type mismatch",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-type-mismatch");

    try {
      const sourceCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "db-type-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "db-type-source" },
            body: "source body",
          }),
        }),
      );
      const sourceCreated = (await sourceCreateResponse.json()) as {
        data: { documentId: string };
      };

      assert.equal(sourceCreateResponse.status, 200);

      const variantCreateResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("page", "db-type-mismatch"),
            type: "Page",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "db-type-mismatch" },
            body: "variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      const variantCreateBody = (await variantCreateResponse.json()) as {
        code: string;
      };

      assert.equal(variantCreateResponse.status, 400);
      assert.equal(variantCreateBody.code, "INVALID_INPUT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database content store rejects sourceDocumentId for non-localized schema types",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const scope = {
      project: stableFixtureName("db-non-localized-variant"),
      environment: "production",
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "Author",
            directory: "content/authors",
            localized: false,
          },
        ],
      });

      const store = createDatabaseContentStore({ db: dbConnection.db });
      const sourceDocument = await store.create(scope, {
        path: stableFixturePath("authors", "non-localized-source"),
        type: "Author",
        locale: "__mdcms_default__",
        format: "md",
        frontmatter: { slug: "non-localized-source" },
        body: "author body",
      });

      await assert.rejects(
        () =>
          store.create(scope, {
            path: stableFixturePath("authors", "non-localized-variant"),
            type: "Author",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "non-localized-variant" },
            body: "variant body",
            sourceDocumentId: sourceDocument.documentId,
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "INVALID_INPUT");
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database content store rejects unsupported locales for translation variants when schema sync data is present",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const scope = {
      project: stableFixtureName("db-unsupported-locale"),
      environment: "production",
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        supportedLocales: ["en", "fr"],
        entries: [
          {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
          },
        ],
      });

      const store = createDatabaseContentStore({ db: dbConnection.db });
      const sourceDocument = await store.create(scope, {
        path: stableFixturePath("blog", "unsupported-locale-source"),
        type: "BlogPost",
        locale: "en",
        format: "md",
        frontmatter: { slug: "unsupported-locale-source" },
        body: "source body",
      });

      await assert.rejects(
        () =>
          store.create(scope, {
            path: stableFixturePath("blog", "unsupported-locale-variant"),
            type: "BlogPost",
            locale: "de",
            format: "md",
            frontmatter: { slug: "unsupported-locale-variant" },
            body: "variant body",
            sourceDocumentId: sourceDocument.documentId,
          }),
        (error: unknown) => {
          const runtimeError = error as {
            code?: string;
            details?: { supportedLocales?: string[] };
          };

          assert.equal(runtimeError.code, "INVALID_INPUT");
          assert.deepEqual(runtimeError.details?.supportedLocales, [
            "en",
            "fr",
          ]);
          return true;
        },
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "database PUT rejects update with stale expectedDraftRevision",
  async () => {
    const context = await createDatabaseTestContext("cms151-stale-revision");
    try {
      const created = await createContentDocument(
        context.handler,
        context.csrfHeaders,
        scopeHeaders,
        {
          path: stableFixturePath("blog", "cms151-stale"),
          type: "BlogPost",
          locale: "en",
          format: "md",
          frontmatter: { slug: stableFixtureName("cms151-stale") },
          body: "original",
        },
      );

      const documentId = created.documentId as string;

      const firstUpdate = await context.handler(
        new Request(`http://localhost/api/v1/content/${documentId}`, {
          method: "PUT",
          headers: context.csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({ body: "edit 1" }),
        }),
      );
      assert.equal(firstUpdate.status, 200);

      const staleUpdate = await context.handler(
        new Request(`http://localhost/api/v1/content/${documentId}`, {
          method: "PUT",
          headers: context.csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({ body: "stale edit", draftRevision: 1 }),
        }),
      );

      assert.equal(staleUpdate.status, 409);
      const body = (await staleUpdate.json()) as { code: string };
      assert.equal(body.code, "STALE_DRAFT_REVISION");
    } finally {
      await context.dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB listVariants returns sibling locale variants",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext("test:content-api-db-list-variants");

    try {
      const sourceResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "list-variants-source"),
            type: "BlogPost",
            locale: "en",
            format: "md",
            frontmatter: { slug: "list-variants-source" },
            body: "source body",
          }),
        }),
      );
      assert.equal(sourceResponse.status, 200);
      const sourceCreated = (await sourceResponse.json()) as {
        data: { documentId: string; translationGroupId: string };
      };

      const variantResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: csrfHeaders({
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: stableFixturePath("blog", "list-variants-variant"),
            type: "BlogPost",
            locale: "fr",
            format: "md",
            frontmatter: { slug: "list-variants-variant" },
            body: "variant body",
            sourceDocumentId: sourceCreated.data.documentId,
          }),
        }),
      );
      assert.equal(variantResponse.status, 200);
      const variantCreated = (await variantResponse.json()) as {
        data: { documentId: string };
      };

      const listResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${sourceCreated.data.documentId}/variants`,
          {
            method: "GET",
            headers: csrfHeaders(scopeHeaders),
          },
        ),
      );
      assert.equal(listResponse.status, 200);

      const listBody = (await listResponse.json()) as {
        data: Array<{ documentId: string; locale: string; path: string }>;
      };

      assert.equal(listBody.data.length, 2);
      const locales = listBody.data.map((v) => v.locale).sort();
      assert.deepEqual(locales, ["en", "fr"]);
      const documentIds = listBody.data.map((v) => v.documentId).sort();
      assert.deepEqual(
        documentIds,
        [sourceCreated.data.documentId, variantCreated.data.documentId].sort(),
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "content API DB listVariants returns 404 for missing document",
  async () => {
    const { handler, dbConnection, csrfHeaders } =
      await createDatabaseTestContext(
        "test:content-api-db-list-variants-missing",
      );

    try {
      const response = await handler(
        new Request(
          "http://localhost/api/v1/content/00000000-0000-4000-8000-000000000000/variants",
          {
            method: "GET",
            headers: csrfHeaders(scopeHeaders),
          },
        ),
      );
      assert.equal(response.status, 404);
      const body = (await response.json()) as { code: string };
      assert.equal(body.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);
