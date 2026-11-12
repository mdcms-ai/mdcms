import { integrationTestDatabaseUrl } from "./integration-test-database.js";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "bun:test";

import {
  createConsoleLogger,
  parseMdcmsConfig,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import {
  oauthClients,
  oauthGrants,
  oauthCodes,
  apiKeys,
  authUsers,
  documents,
  documentVersions,
  environments,
  projects,
  rbacGrants,
  schemaRegistryEntries,
  schemaSyncs,
} from "./db/schema.js";
import {
  cloneEnvironment,
  promoteDocuments,
} from "./environments-clone-promote.js";
import { createOAuthStore, hashCredential } from "./oauth/database-store.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: integrationTestDatabaseUrl(),
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "error",
  sink: () => undefined,
});

const attribution = {
  actorId: "00000000-0000-4000-8000-000000000099",
  origin: {
    channel: "mcp" as const,
    credential: "api_key" as const,
    apiKeyId: "fixture-key",
  },
};
const ACTOR = "00000000-0000-0000-0000-000000000001";
const cloneTestConfig = parseMdcmsConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",
  types: [],
  environments: {
    production: {},
    staging: { extends: "production" },
  },
});

async function canConnectToDatabase(): Promise<boolean> {
  if (!integrationTestDatabaseUrl()) return false;
  const client = postgres(env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
    connect_timeout: 1,
    max: 1,
  });
  try {
    await client`select 1`;
    return true;
  } catch {
    throw new Error("Explicit integration database is unavailable");
  } finally {
    await client.end({ timeout: 1 });
  }
}

const dbAvailable = await canConnectToDatabase();
const integrationTest = dbAvailable ? test : test.skip;

function uniqueProjectSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const blogPostSchema: SchemaRegistryTypeSnapshot = {
  type: "BlogPost",
  directory: "blog",
  localized: true,
  fields: {
    title: { kind: "string", required: true, nullable: false },
    author: {
      kind: "string",
      required: false,
      nullable: true,
      reference: { targetType: "Author" },
    },
  },
};

const authorSchema: SchemaRegistryTypeSnapshot = {
  type: "Author",
  directory: "authors",
  localized: false,
  fields: {
    name: { kind: "string", required: true, nullable: false },
  },
};

type ProvisionedFixture = {
  projectId: string;
  productionEnvId: string;
  stagingEnvId: string;
  authorDocumentId: string;
  blogDocumentId: string;
};

async function provisionTwoEnvironments(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  slug: string,
): Promise<ProvisionedFixture> {
  const [project] = await db
    .insert(projects)
    .values({ name: slug, slug, createdBy: ACTOR })
    .returning();
  if (!project) {
    throw new Error("Failed to insert project");
  }
  const [production] = await db
    .insert(environments)
    .values({
      projectId: project.id,
      name: "production",
      description: null,
      createdBy: ACTOR,
    })
    .returning();
  const [staging] = await db
    .insert(environments)
    .values({
      projectId: project.id,
      name: "staging",
      description: null,
      createdBy: ACTOR,
    })
    .returning();
  if (!production || !staging) {
    throw new Error("Failed to insert environments");
  }

  // Source env (staging) gets a synced schema sync + registry entries so the
  // remap walker can see the BlogPost.author reference field.
  await db.insert(schemaSyncs).values({
    projectId: project.id,
    environmentId: staging.id,
    schemaHash: "sha256:test",
    rawConfigSnapshot: { types: ["BlogPost", "Author"] },
  });
  await db.insert(schemaRegistryEntries).values({
    projectId: project.id,
    environmentId: staging.id,
    schemaType: "BlogPost",
    directory: "blog",
    localized: true,
    schemaHash: "sha256:test",
    resolvedSchema: blogPostSchema,
  });
  await db.insert(schemaRegistryEntries).values({
    projectId: project.id,
    environmentId: staging.id,
    schemaType: "Author",
    directory: "authors",
    localized: false,
    schemaHash: "sha256:test",
    resolvedSchema: authorSchema,
  });

  const authorDocumentId = randomUUID();
  const authorTranslationGroup = randomUUID();
  await db.insert(documents).values({
    documentId: authorDocumentId,
    translationGroupId: authorTranslationGroup,
    projectId: project.id,
    environmentId: staging.id,
    path: "authors/jane",
    schemaType: "Author",
    locale: "__mdcms_default__",
    contentFormat: "md",
    body: "Author bio",
    frontmatter: { name: "Jane" },
    isDeleted: false,
    hasUnpublishedChanges: true,
    publishedVersion: null,
    draftRevision: 1,
    createdBy: ACTOR,
    updatedBy: ACTOR,
  });
  await db.insert(documentVersions).values({
    documentId: authorDocumentId,
    translationGroupId: authorTranslationGroup,
    projectId: project.id,
    environmentId: staging.id,
    schemaType: "Author",
    locale: "__mdcms_default__",
    contentFormat: "md",
    path: "authors/jane",
    body: "Author bio",
    frontmatter: { name: "Jane" },
    version: 1,
    publishedBy: ACTOR,
    changeSummary: null,
  });
  await db
    .update(documents)
    .set({ publishedVersion: 1, hasUnpublishedChanges: false })
    .where(eq(documents.documentId, authorDocumentId));

  const blogDocumentId = randomUUID();
  const blogTranslationGroup = randomUUID();
  await db.insert(documents).values({
    documentId: blogDocumentId,
    translationGroupId: blogTranslationGroup,
    projectId: project.id,
    environmentId: staging.id,
    path: "blog/hello-world",
    schemaType: "BlogPost",
    locale: "en-US",
    contentFormat: "md",
    body: "Hello body",
    frontmatter: { title: "Hello", author: authorDocumentId },
    isDeleted: false,
    hasUnpublishedChanges: true,
    publishedVersion: null,
    draftRevision: 1,
    createdBy: ACTOR,
    updatedBy: ACTOR,
  });
  await db.insert(documentVersions).values({
    documentId: blogDocumentId,
    translationGroupId: blogTranslationGroup,
    projectId: project.id,
    environmentId: staging.id,
    schemaType: "BlogPost",
    locale: "en-US",
    contentFormat: "md",
    path: "blog/hello-world",
    body: "Hello body",
    frontmatter: { title: "Hello", author: authorDocumentId },
    version: 1,
    publishedBy: ACTOR,
    changeSummary: null,
  });
  await db
    .update(documents)
    .set({ publishedVersion: 1, hasUnpublishedChanges: false })
    .where(eq(documents.documentId, blogDocumentId));

  return {
    projectId: project.id,
    productionEnvId: production.id,
    stagingEnvId: staging.id,
    authorDocumentId,
    blogDocumentId,
  };
}

async function teardownProject(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  projectId: string,
): Promise<void> {
  // documents.publishedVersion is a `ON DELETE RESTRICT` FK into
  // document_versions, so we have to clear it before deleting the version
  // rows. Otherwise the version delete fails the referential integrity check.
  await db
    .update(documents)
    .set({ publishedVersion: null })
    .where(eq(documents.projectId, projectId));
  await db
    .delete(documentVersions)
    .where(eq(documentVersions.projectId, projectId));
  await db.delete(documents).where(eq(documents.projectId, projectId));
  await db
    .delete(schemaRegistryEntries)
    .where(eq(schemaRegistryEntries.projectId, projectId));
  await db.delete(schemaSyncs).where(eq(schemaSyncs.projectId, projectId));
  await db.delete(environments).where(eq(environments.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
}

integrationTest(
  "clone copies content with new document_ids and remaps frontmatter references",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-content");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      const result = await cloneEnvironment(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: true, settings: false },
        includeDrafts: true,
        preservePaths: true,
      });

      assert.equal(result.targetEnvironmentId, fixture.productionEnvId);
      assert.equal(result.documentsCloned, 2);

      const targetRows = await dbConnection.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      assert.equal(targetRows.length, 2);
      for (const row of targetRows) {
        assert.equal(row.createdBy, attribution.actorId);
        assert.equal(row.updatedBy, attribution.actorId);
        assert.deepEqual(row.createdOrigin, attribution.origin);
        assert.deepEqual(row.updatedOrigin, attribution.origin);
        const history = await dbConnection.db
          .select()
          .from(documentVersions)
          .where(eq(documentVersions.documentId, row.documentId));
        for (const version of history) {
          assert.equal(version.publishedBy, attribution.actorId);
          assert.deepEqual(version.publishedOrigin, attribution.origin);
        }
      }

      const targetByType = new Map(
        targetRows.map((row) => [row.schemaType, row]),
      );
      const targetAuthor = targetByType.get("Author");
      const targetBlog = targetByType.get("BlogPost");
      assert.ok(targetAuthor);
      assert.ok(targetBlog);
      // documentId must be new in the target env, but translation_group_id is
      // preserved across environments per SPEC-009.
      assert.notEqual(targetAuthor.documentId, fixture.authorDocumentId);
      assert.notEqual(targetBlog.documentId, fixture.blogDocumentId);

      const sourceAuthor = await dbConnection.db.query.documents.findFirst({
        where: eq(documents.documentId, fixture.authorDocumentId),
      });
      const sourceBlog = await dbConnection.db.query.documents.findFirst({
        where: eq(documents.documentId, fixture.blogDocumentId),
      });
      assert.ok(sourceAuthor);
      assert.ok(sourceBlog);
      assert.equal(
        targetAuthor.translationGroupId,
        sourceAuthor.translationGroupId,
      );
      assert.equal(
        targetBlog.translationGroupId,
        sourceBlog.translationGroupId,
      );
      // The reference in BlogPost.frontmatter.author should be remapped to
      // the *new* target author documentId.
      const remapped = targetBlog.frontmatter as { author: string };
      assert.equal(remapped.author, targetAuthor.documentId);

      // Published snapshot is copied as version 1 in the target.
      const targetVersions = await dbConnection.db
        .select()
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.projectId, fixture.projectId),
            eq(documentVersions.environmentId, fixture.productionEnvId),
          ),
        );
      assert.equal(targetVersions.length, 2);
      assert.ok(targetVersions.every((row) => row.version === 1));
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone with include.settings copies schema sync and registry entries",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-settings");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      const result = await cloneEnvironment(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: false, settings: true },
        includeDrafts: true,
        preservePaths: true,
      });
      assert.equal(result.documentsCloned, 0);

      const targetSync = await dbConnection.db.query.schemaSyncs.findFirst({
        where: and(
          eq(schemaSyncs.projectId, fixture.projectId),
          eq(schemaSyncs.environmentId, fixture.productionEnvId),
        ),
      });
      assert.ok(targetSync);
      assert.equal(targetSync.schemaHash, "sha256:test");

      const targetRegistry = await dbConnection.db
        .select()
        .from(schemaRegistryEntries)
        .where(
          and(
            eq(schemaRegistryEntries.projectId, fixture.projectId),
            eq(schemaRegistryEntries.environmentId, fixture.productionEnvId),
          ),
        );
      const types = targetRegistry.map((row) => row.schemaType).sort();
      assert.deepEqual(types, ["Author", "BlogPost"]);
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone with includeDrafts:false skips unpublished docs",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-no-drafts");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // Demote BlogPost to draft (no published version) so it should be skipped
      // when `includeDrafts: false`.
      await dbConnection.db
        .update(documents)
        .set({ publishedVersion: null, hasUnpublishedChanges: true })
        .where(eq(documents.documentId, fixture.blogDocumentId));
      await dbConnection.db
        .delete(documentVersions)
        .where(eq(documentVersions.documentId, fixture.blogDocumentId));

      const result = await cloneEnvironment(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: true, settings: false },
        includeDrafts: false,
        preservePaths: true,
      });
      assert.equal(result.documentsCloned, 1);

      const targetRows = await dbConnection.db
        .select({ schemaType: documents.schemaType })
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      assert.deepEqual(
        targetRows.map((row) => row.schemaType),
        ["Author"],
      );
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone fails atomically when reference target is missing",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-broken-ref");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // Point BlogPost.author at a non-existent source documentId. The clone
      // walks the schema, fails to look up the source, and aborts.
      const ghostId = randomUUID();
      await dbConnection.db
        .update(documents)
        .set({ frontmatter: { title: "Hello", author: ghostId } })
        .where(eq(documents.documentId, fixture.blogDocumentId));

      let thrown: unknown;
      try {
        await cloneEnvironment(dbConnection.db, {
          attribution,
          authorize: async () => {},
          project: slug,
          targetEnvironmentId: fixture.productionEnvId,
          sourceEnvironmentId: fixture.stagingEnvId,
          include: { content: true, settings: false },
          includeDrafts: true,
          preservePaths: true,
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown);
      const error = thrown as { code: string; statusCode: number };
      assert.equal(error.code, "REFERENCE_REMAP_FAILED");
      assert.equal(error.statusCode, 409);

      const targetCount = await dbConnection.db
        .select({ count: documents.documentId })
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      // No partial clone — atomic abort means zero target rows.
      assert.equal(targetCount.length, 0);
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest("promote dryRun returns plan without writing", async () => {
  const { dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
    config: cloneTestConfig,
  });
  const slug = uniqueProjectSlug("promote-dryrun");
  let projectId: string | undefined;
  try {
    const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
    projectId = fixture.projectId;

    const result = await promoteDocuments(dbConnection.db, {
      attribution,
      authorize: async () => {},
      project: slug,
      targetEnvironmentId: fixture.productionEnvId,
      sourceEnvironmentId: fixture.stagingEnvId,
      documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
      includeUnpublished: false,
      dryRun: true,
    });

    assert.equal(result.promoted.length, 2);
    for (const entry of result.promoted) {
      assert.equal(entry.status, "created");
      // dryRun reports the would-be target id (pre-allocated UUID) so the
      // operator preview can correlate planned creates to upcoming target
      // documents — but no row exists yet.
      assert.ok(
        entry.targetDocumentId &&
          /^[0-9a-f-]{36}$/i.test(entry.targetDocumentId),
      );
    }

    const targetCount = await dbConnection.db
      .select({ count: documents.documentId })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, fixture.projectId),
          eq(documents.environmentId, fixture.productionEnvId),
        ),
      );
    assert.equal(targetCount.length, 0);
  } finally {
    if (projectId) {
      await teardownProject(dbConnection.db, projectId);
    }
    await dbConnection.close();
  }
});

integrationTest(
  "promote creates and overwrites target docs and auto-publishes",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("promote-real");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // First promote creates target rows.
      const first = await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: false,
      });
      assert.equal(first.promoted.length, 2);
      for (const entry of first.promoted) {
        assert.equal(entry.status, "created");
        assert.equal(entry.publishedVersion, 1);
      }

      // Reference remap should rewrite BlogPost.author to the target author id.
      const targetBlog = await dbConnection.db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, fixture.projectId),
          eq(documents.environmentId, fixture.productionEnvId),
          eq(documents.schemaType, "BlogPost"),
        ),
      });
      const targetAuthor = await dbConnection.db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, fixture.projectId),
          eq(documents.environmentId, fixture.productionEnvId),
          eq(documents.schemaType, "Author"),
        ),
      });
      assert.ok(targetBlog);
      assert.ok(targetAuthor);
      const remapped = targetBlog.frontmatter as { author: string };
      assert.equal(remapped.author, targetAuthor.documentId);

      // Mutate source BlogPost body and re-promote — should overwrite + publish v2.
      await dbConnection.db
        .update(documents)
        .set({ body: "Updated body" })
        .where(eq(documents.documentId, fixture.blogDocumentId));

      assert.equal(targetBlog.createdBy, attribution.actorId);
      assert.deepEqual(targetBlog.createdOrigin, attribution.origin);
      await dbConnection.db
        .update(documents)
        .set({ createdBy: ACTOR, createdOrigin: null })
        .where(eq(documents.documentId, targetBlog.documentId));
      const overwriteAttribution = {
        actorId: "00000000-0000-4000-8000-000000000098",
        origin: {
          channel: "mcp" as const,
          credential: "oauth" as const,
          oauthClientId: "fixture-client",
        },
      };
      const oldHistory = await dbConnection.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, targetBlog.documentId));
      const second = await promoteDocuments(dbConnection.db, {
        attribution: overwriteAttribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: false,
      });
      assert.equal(second.promoted.length, 1);
      const overwroteEntry = second.promoted[0];
      assert.ok(overwroteEntry);
      assert.equal(overwroteEntry.status, "overwrote");
      assert.equal(overwroteEntry.publishedVersion, 2);

      const reread = await dbConnection.db.query.documents.findFirst({
        where: eq(documents.documentId, targetBlog.documentId),
      });
      assert.ok(reread);
      assert.equal(reread.body, "Updated body");
      assert.equal(reread.publishedVersion, 2);
      assert.equal(reread.createdBy, ACTOR);
      assert.equal(reread.createdOrigin, null);
      assert.equal(reread.updatedBy, overwriteAttribution.actorId);
      assert.deepEqual(reread.updatedOrigin, overwriteAttribution.origin);

      const versions = await dbConnection.db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, targetBlog.documentId));
      assert.equal(versions.length, 2);
      assert.deepEqual(
        versions.find((row) => row.version === 1),
        oldHistory[0],
      );
      assert.equal(
        versions.find((row) => row.version === 2)!.publishedBy,
        overwriteAttribution.actorId,
      );
      assert.deepEqual(
        versions.find((row) => row.version === 2)!.publishedOrigin,
        overwriteAttribution.origin,
      );
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "promote skips unpublished docs unless includeUnpublished is true",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("promote-unpublished");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // Demote BlogPost to draft.
      await dbConnection.db
        .update(documents)
        .set({ publishedVersion: null, hasUnpublishedChanges: true })
        .where(eq(documents.documentId, fixture.blogDocumentId));
      await dbConnection.db
        .delete(documentVersions)
        .where(eq(documentVersions.documentId, fixture.blogDocumentId));

      const skippedRun = await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: false,
      });
      assert.equal(skippedRun.promoted.length, 1);
      const skipped = skippedRun.promoted[0];
      assert.ok(skipped);
      assert.equal(skipped.status, "skipped_unpublished");

      const targetRows = await dbConnection.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      // Skipping never writes, so the target stays empty.
      assert.equal(targetRows.length, 0);

      // Need an Author target for the reference to remap when we do include
      // unpublished — promote the author first.
      await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.authorDocumentId],
        includeUnpublished: false,
        dryRun: false,
      });

      const includedRun = await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.blogDocumentId],
        includeUnpublished: true,
        dryRun: false,
      });
      assert.equal(includedRun.promoted.length, 1);
      assert.equal(includedRun.promoted[0]?.status, "created");
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "promote fails atomically when a reference cannot be remapped",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("promote-broken-ref");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // Promote only the BlogPost (without its Author) — target has no
      // author row to match `(authorTranslationGroupId, __mdcms_default__)`,
      // so the remap must fail atomically.
      let thrown: unknown;
      try {
        await promoteDocuments(dbConnection.db, {
          attribution,
          authorize: async () => {},
          project: slug,
          targetEnvironmentId: fixture.productionEnvId,
          sourceEnvironmentId: fixture.stagingEnvId,
          documentIds: [fixture.blogDocumentId],
          includeUnpublished: false,
          dryRun: false,
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown);
      assert.equal((thrown as { code: string }).code, "REFERENCE_REMAP_FAILED");

      const targetRows = await dbConnection.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      assert.equal(targetRows.length, 0);
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone rejects same source and target environment",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-same-env");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      let thrown: unknown;
      try {
        await cloneEnvironment(dbConnection.db, {
          attribution,
          authorize: async () => {},
          project: slug,
          targetEnvironmentId: fixture.stagingEnvId,
          sourceEnvironmentId: fixture.stagingEnvId,
          include: { content: true, settings: false },
          includeDrafts: true,
          preservePaths: true,
        });
      } catch (error) {
        thrown = error;
      }
      assert.equal(
        (thrown as { code: string } | undefined)?.code,
        "INVALID_INPUT",
      );
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone with includeDrafts:false copies the published payload, not the draft state",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-published-payload");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      // The fixture leaves source docs published at v1 with body "Hello body".
      // Mutate the documents head row to simulate post-publish draft edits.
      await dbConnection.db
        .update(documents)
        .set({
          body: "DRAFT body — should not leak into published clone",
          frontmatter: {
            title: "DRAFT title",
            author: fixture.authorDocumentId,
          },
          hasUnpublishedChanges: true,
        })
        .where(eq(documents.documentId, fixture.blogDocumentId));

      const result = await cloneEnvironment(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: true, settings: false },
        includeDrafts: false,
        preservePaths: true,
      });
      assert.equal(result.documentsCloned, 2);

      const targetBlog = await dbConnection.db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, fixture.projectId),
          eq(documents.environmentId, fixture.productionEnvId),
          eq(documents.schemaType, "BlogPost"),
        ),
      });
      assert.ok(targetBlog);
      // Head and version-1 must both reflect the *published* payload, not
      // the draft body that was mutated above.
      assert.equal(targetBlog.body, "Hello body");
      assert.equal(
        (targetBlog.frontmatter as { title: string }).title,
        "Hello",
      );
      assert.equal(targetBlog.publishedVersion, 1);
      assert.equal(targetBlog.hasUnpublishedChanges, false);

      const targetVersionRow =
        await dbConnection.db.query.documentVersions.findFirst({
          where: and(
            eq(documentVersions.documentId, targetBlog.documentId),
            eq(documentVersions.version, 1),
          ),
        });
      assert.ok(targetVersionRow);
      assert.equal(targetVersionRow.body, "Hello body");
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "clone with preservePaths:false places target rows on suffix-derived paths",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("clone-preserve-paths-false");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      const result = await cloneEnvironment(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: true, settings: false },
        includeDrafts: true,
        preservePaths: false,
      });
      assert.equal(result.documentsCloned, 2);

      const targetRows = await dbConnection.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.projectId, fixture.projectId),
            eq(documents.environmentId, fixture.productionEnvId),
          ),
        );
      // Every target row's path should differ from its source path because
      // preservePaths is false; a deterministic suffix is appended.
      for (const row of targetRows) {
        assert.ok(
          row.path.includes(".cloned-"),
          `target path should be suffixed when preservePaths:false (got ${row.path})`,
        );
      }
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

integrationTest(
  "promote dryRun → real run replays preallocatedTargetIds deterministically",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const slug = uniqueProjectSlug("promote-replay");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(dbConnection.db, slug);
      projectId = fixture.projectId;

      const dryRun = await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: true,
      });

      const preallocatedTargetIds: Record<string, string> = {};
      for (const entry of dryRun.promoted) {
        if (entry.status === "created" && entry.targetDocumentId) {
          preallocatedTargetIds[entry.sourceDocumentId] =
            entry.targetDocumentId;
        }
      }

      const real = await promoteDocuments(dbConnection.db, {
        attribution,
        authorize: async () => {},
        project: slug,
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: false,
        preallocatedTargetIds,
      });

      // The real run must use the exact target ids the dryRun returned, so
      // the operator's confirmation dialog (built from dryRun) doesn't lie.
      const dryRunIds = new Map(
        dryRun.promoted.map((entry) => [
          entry.sourceDocumentId,
          entry.targetDocumentId,
        ]),
      );
      for (const entry of real.promoted) {
        assert.equal(
          entry.targetDocumentId,
          dryRunIds.get(entry.sourceDocumentId),
        );
      }
    } finally {
      if (projectId) {
        await teardownProject(dbConnection.db, projectId);
      }
      await dbConnection.close();
    }
  },
);

// Suppress unused warning on rbacGrants (only imported for future tests).
void rbacGrants;

integrationTest(
  "clone denies source authorization inside the transaction before copying content",
  async () => {
    const { dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(
        dbConnection.db,
        uniqueProjectSlug("clone-denied"),
      );
      projectId = fixture.projectId;
      const project = await dbConnection.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      await assert.rejects(
        cloneEnvironment(dbConnection.db, {
          project: project!.slug,
          sourceEnvironmentId: fixture.stagingEnvId,
          targetEnvironmentId: fixture.productionEnvId,
          attribution,
          authorize: async () => {
            throw new Error("source denied");
          },
        }),
        /source denied/,
      );
      const rows = await dbConnection.db
        .select()
        .from(documents)
        .where(eq(documents.environmentId, fixture.productionEnvId));
      assert.equal(rows.length, 0);
    } finally {
      if (projectId) await teardownProject(dbConnection.db, projectId);
      await dbConnection.close();
    }
  },
);

integrationTest(
  "mounted bearer environment operations bind destination, both tuples, source scopes and current global role",
  async () => {
    let collaborationState: "inactive" | "active" | "unavailable" = "inactive";
    const runtime = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
      activeCollaboration: {
        isDocumentActive: async () => {
          if (collaborationState === "unavailable")
            throw (
              await import("./collaboration/errors.js")
            ).createCollaborationUnavailableError();
          return collaborationState === "active";
        },
      },
    });
    const db = runtime.dbConnection.db;
    const userId = randomUUID();
    const clientId = randomUUID();
    const slug = uniqueProjectSlug("environment-auth");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(db, slug);
      projectId = fixture.projectId;
      await db.insert(authUsers).values({
        id: userId,
        name: "Environment fixture",
        email: `${userId}@example.invalid`,
        emailVerified: true,
      });
      const [grant] = await db
        .insert(rbacGrants)
        .values({
          userId,
          role: "admin",
          scopeKind: "global",
          createdByUserId: userId,
        })
        .returning();
      const makeKey = async (scopes: string[], source = true) => {
        const key = `mdcms_key_${randomUUID()}`;
        await db.insert(apiKeys).values({
          label: "Environment fixture",
          keyPrefix: key.slice(0, 16),
          keyHash: createHash("sha256").update(key).digest("hex"),
          scopes,
          contextAllowlist: [
            { project: slug, environment: "production" },
            ...(source ? [{ project: slug, environment: "staging" }] : []),
          ],
          createdByUserId: userId,
        });
        return key;
      };
      const request = (
        key: string,
        path: string,
        body?: unknown,
        routed = "production",
        method = body ? "POST" : "GET",
      ) =>
        runtime.handler(
          new Request(`http://localhost/api/v1/environments${path}`, {
            method,
            headers: {
              authorization: `Bearer ${key}`,
              "x-mdcms-project": slug,
              "x-mdcms-environment": routed,
              ...(body ? { "content-type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      const scopes = [
        "environments:read",
        "environments:clone",
        "environments:promote",
        "content:read",
        "content:read:draft",
        "schema:read",
        "schema:write",
      ];
      const fullKey = await makeKey(scopes);
      const clone = {
        sourceEnvironmentId: fixture.stagingEnvId,
        include: { content: true, settings: false },
        includeDrafts: true,
        preservePaths: true,
      };
      assert.equal(
        (
          await request(
            fullKey,
            `/${fixture.productionEnvId}/clone`,
            clone,
            "staging",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            await makeKey(scopes, false),
            `/${fixture.productionEnvId}/clone`,
            clone,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            await makeKey(scopes.filter((s) => s !== "content:read:draft")),
            `/${fixture.productionEnvId}/clone`,
            clone,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            await makeKey(scopes.filter((s) => s !== "schema:write")),
            `/${fixture.productionEnvId}/clone`,
            { ...clone, include: { content: false, settings: true } },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await request(
            await makeKey(scopes.filter((s) => s !== "content:read:draft")),
            `/${fixture.productionEnvId}/promote`,
            {
              sourceEnvironmentId: fixture.stagingEnvId,
              documentIds: [fixture.blogDocumentId],
              includeUnpublished: false,
              dryRun: true,
            },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await db
            .select()
            .from(documents)
            .where(eq(documents.environmentId, fixture.productionEnvId))
        ).length,
        0,
      );
      const listed = await request(fullKey, "");
      assert.equal(listed.status, 200);
      const metadata = await listed.json();
      assert.equal(metadata.data.length, 2);
      assert.ok(metadata.data.every((row: any) => row.project === slug));
      assert.deepEqual(metadata.meta, { definitionsStatus: "missing" });
      assert.equal(
        (await request(await makeKey(["content:read"]), "")).status,
        403,
      );
      assert.equal((await request(fullKey, "", { name: "other" })).status, 401);
      assert.equal(
        (
          await request(
            fullKey,
            `/${fixture.stagingEnvId}`,
            undefined,
            "production",
            "DELETE",
          )
        ).status,
        401,
      );
      await db
        .update(rbacGrants)
        .set({ role: "admin", scopeKind: "project", project: slug })
        .where(eq(rbacGrants.id, grant!.id));
      assert.equal((await request(fullKey, "")).status, 403);
      assert.equal(
        (await request(fullKey, `/${fixture.productionEnvId}/clone`, clone))
          .status,
        403,
      );
      await db
        .update(rbacGrants)
        .set({ role: "admin", scopeKind: "global", project: null })
        .where(eq(rbacGrants.id, grant!.id));
      const copied = await request(
        fullKey,
        `/${fixture.productionEnvId}/clone`,
        clone,
      );
      assert.equal(copied.status, 200);
      const target = await db
        .select()
        .from(documents)
        .where(eq(documents.environmentId, fixture.productionEnvId));
      assert.equal(target.length, 2);
      for (const row of target) {
        assert.equal(row.createdBy, userId);
        assert.equal((row.createdOrigin as any).channel, "api");
      }
      const historyBeforeGuard = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.environmentId, fixture.productionEnvId));
      for (const state of ["active", "unavailable"] as const) {
        collaborationState = state;
        const blocked = await request(
          fullKey,
          `/${fixture.productionEnvId}/promote`,
          {
            sourceEnvironmentId: fixture.stagingEnvId,
            documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
            includeUnpublished: false,
            dryRun: false,
          },
        );
        assert.equal(blocked.status, state === "active" ? 409 : 503);
        assert.equal(
          (await blocked.json()).code,
          state === "active"
            ? "DOCUMENT_COLLABORATION_ACTIVE"
            : "COLLABORATION_UNAVAILABLE",
        );
        assert.deepEqual(
          await db
            .select()
            .from(documents)
            .where(eq(documents.environmentId, fixture.productionEnvId)),
          target,
        );
        assert.deepEqual(
          await db
            .select()
            .from(documentVersions)
            .where(eq(documentVersions.environmentId, fixture.productionEnvId)),
          historyBeforeGuard,
        );
      }
      collaborationState = "inactive";
      const promotedThroughMcp = await runtime.handler(
        new Request("http://localhost/api/v1/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${fullKey}`,
            "x-mdcms-project": slug,
            "x-mdcms-environment": "production",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "promote_documents",
              arguments: {
                targetEnvironmentId: fixture.productionEnvId,
                sourceEnvironmentId: fixture.stagingEnvId,
                documentIds: [fixture.blogDocumentId],
                includeUnpublished: false,
                dryRun: false,
              },
            },
          }),
        }),
      );
      assert.equal(promotedThroughMcp.status, 200);
      assert.equal((await promotedThroughMcp.json()).result.isError, false);
      const promotedRow = await db.query.documents.findFirst({
        where: and(
          eq(documents.environmentId, fixture.productionEnvId),
          eq(documents.schemaType, "BlogPost"),
        ),
      });
      assert.equal(promotedRow!.updatedBy, userId);
      assert.equal((promotedRow!.updatedOrigin as any).channel, "mcp");
      assert.equal((promotedRow!.createdOrigin as any).channel, "api");
      await db.insert(oauthClients).values({
        id: clientId,
        createdAt: new Date(),
        name: "Environment fixture",
        redirectUris: ["http://127.0.0.1:23456/callback"],
      });
      const grantId = randomUUID();
      const resource = "http://localhost:4000/api/v1/mcp";
      await db.insert(oauthGrants).values({
        id: grantId,
        createdAt: new Date(),
        clientId,
        userId,
        project: slug,
        environment: "production",
        resource,
        scopes,
      });
      const code = randomUUID();
      const verifier = "a".repeat(43);
      await db.insert(oauthCodes).values({
        hash: hashCredential(code),
        grantId,
        redirectUri: "http://127.0.0.1:23456/callback",
        challenge: createHash("sha256").update(verifier).digest("base64url"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const tokens = await createOAuthStore(db).exchangeCode(
        {
          clientId,
          code,
          verifier,
          redirectUri: "http://127.0.0.1:23456/callback",
          resource,
        },
        async () => true,
      );
      const oauthCall = (
        name: string,
        args: Record<string, unknown>,
        environment?: string,
      ) =>
        runtime.handler(
          new Request(resource, {
            method: "POST",
            headers: {
              authorization: `Bearer ${tokens.access_token}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(environment ? { "x-mdcms-environment": environment } : {}),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          }),
        );
      const oauthList = await oauthCall("list_environments", {});
      assert.equal(oauthList.status, 200);
      const oauthListed = await oauthList.json();
      assert.equal(oauthListed.result.isError, false);
      assert.equal(oauthListed.result.structuredContent.data.length, 2);
      assert.equal(
        (
          await oauthCall(
            "get_document",
            { documentId: fixture.blogDocumentId },
            "staging",
          )
        ).status,
        400,
      );
      const wrongTarget = await oauthCall("clone_environment", {
        ...clone,
        targetEnvironmentId: fixture.stagingEnvId,
      });
      assert.equal((await wrongTarget.json()).result.isError, true);
      const oauthPromote = await oauthCall("promote_documents", {
        targetEnvironmentId: fixture.productionEnvId,
        sourceEnvironmentId: fixture.stagingEnvId,
        documentIds: [fixture.blogDocumentId],
        includeUnpublished: false,
        dryRun: false,
      });
      assert.equal((await oauthPromote.json()).result.isError, false);
      const oauthRow = await db.query.documents.findFirst({
        where: eq(documents.documentId, promotedRow!.documentId),
      });
      assert.equal(oauthRow!.updatedBy, userId);
      assert.deepEqual(oauthRow!.updatedOrigin, {
        channel: "mcp",
        credential: "oauth",
        oauthClientId: clientId,
      });
      await db
        .update(rbacGrants)
        .set({ role: "admin", scopeKind: "project", project: slug })
        .where(eq(rbacGrants.id, grant!.id));
      assert.equal(
        (await (await oauthCall("list_environments", {})).json()).result
          .isError,
        true,
      );
    } finally {
      if (projectId) await teardownProject(db, projectId);
      await db.delete(apiKeys).where(eq(apiKeys.createdByUserId, userId));
      await db.delete(rbacGrants).where(eq(rbacGrants.userId, userId));
      await db.delete(oauthGrants).where(eq(oauthGrants.userId, userId));
      await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
      await db.delete(authUsers).where(eq(authUsers.id, userId));
      await runtime.dbConnection.close();
    }
  },
);

integrationTest(
  "transaction path denials roll back clone and suppress promotion dry-run plans",
  async () => {
    const runtime = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const db = runtime.dbConnection.db;
    const slug = uniqueProjectSlug("path-denial");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(db, slug);
      projectId = fixture.projectId;
      const before = await db
        .select()
        .from(documents)
        .where(eq(documents.projectId, projectId));
      const history = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.projectId, projectId));
      for (const side of ["source", "destination"]) {
        let checked = false;
        await assert.rejects(
          cloneEnvironment(db, {
            project: slug,
            sourceEnvironmentId: fixture.stagingEnvId,
            targetEnvironmentId: fixture.productionEnvId,
            attribution,
            authorize: async (_tx, permissions) => {
              if (
                permissions.some(
                  (permission) =>
                    permission.path &&
                    permission.environment ===
                      (side === "source" ? "staging" : "production"),
                )
              ) {
                checked = true;
                throw new Error("path denied");
              }
            },
          }),
          /path denied/,
        );
        assert.equal(checked, true);
        assert.deepEqual(
          await db
            .select()
            .from(documents)
            .where(eq(documents.projectId, projectId)),
          before,
        );
        assert.deepEqual(
          await db
            .select()
            .from(documentVersions)
            .where(eq(documentVersions.projectId, projectId)),
          history,
        );
      }
      await assert.rejects(
        promoteDocuments(db, {
          project: slug,
          sourceEnvironmentId: fixture.stagingEnvId,
          targetEnvironmentId: fixture.productionEnvId,
          documentIds: [fixture.blogDocumentId],
          dryRun: true,
          attribution,
          authorize: async (_tx, permissions) => {
            if (
              permissions.some(
                (permission) =>
                  permission.path && permission.environment === "production",
              )
            )
              throw new Error("path denied");
          },
        }),
        /path denied/,
      );
      assert.deepEqual(
        await db
          .select()
          .from(documents)
          .where(eq(documents.projectId, projectId)),
        before,
      );
      assert.deepEqual(
        await db
          .select()
          .from(documentVersions)
          .where(eq(documentVersions.projectId, projectId)),
        history,
      );
      let mutated = false;
      await assert.rejects(
        cloneEnvironment(db, {
          project: slug,
          sourceEnvironmentId: fixture.stagingEnvId,
          targetEnvironmentId: fixture.productionEnvId,
          attribution,
          authorize: async (tx, permissions) => {
            if (!mutated) {
              mutated = true;
              await tx
                .update(documents)
                .set({ path: "denied/new" })
                .where(eq(documents.documentId, fixture.blogDocumentId));
            }
            if (
              permissions.some((permission) => permission.path === "denied/new")
            )
              throw new Error("changed path denied");
          },
        }),
        /changed path denied/,
      );
      assert.deepEqual(
        await db
          .select()
          .from(documents)
          .where(eq(documents.projectId, projectId)),
        before,
      );
    } finally {
      if (projectId) await teardownProject(db, projectId);
      await runtime.dbConnection.close();
    }
  },
);

integrationTest(
  "promotion checks source reference paths outside the selected document set",
  async () => {
    const runtime = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const db = runtime.dbConnection.db;
    const slug = uniqueProjectSlug("reference-permission");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(db, slug);
      projectId = fixture.projectId;
      await cloneEnvironment(db, {
        project: slug,
        sourceEnvironmentId: fixture.stagingEnvId,
        targetEnvironmentId: fixture.productionEnvId,
        attribution,
        authorize: async () => {},
      });
      await assert.rejects(
        promoteDocuments(db, {
          project: slug,
          sourceEnvironmentId: fixture.stagingEnvId,
          targetEnvironmentId: fixture.productionEnvId,
          attribution,
          documentIds: [fixture.blogDocumentId],
          dryRun: true,
          authorize: async (_tx, requirements) => {
            if (
              requirements.some(
                (item) =>
                  item.environment === "staging" &&
                  item.path === "authors/jane",
              )
            )
              throw new Error("reference denied");
          },
        }),
        /reference denied/,
      );
    } finally {
      if (projectId) await teardownProject(db, projectId);
      await runtime.dbConnection.close();
    }
  },
);

integrationTest(
  "promotion rejects active or unavailable collaboration atomically for existing target batches",
  async () => {
    const { createCollaborationUnavailableError } = await import(
      "./collaboration/errors.js"
    );
    const runtime = createServerRequestHandlerWithModules({
      env,
      logger,
      config: cloneTestConfig,
    });
    const db = runtime.dbConnection.db;
    const slug = uniqueProjectSlug("promote-collaboration");
    let projectId: string | undefined;
    try {
      const fixture = await provisionTwoEnvironments(db, slug);
      projectId = fixture.projectId;
      await cloneEnvironment(db, {
        project: slug,
        sourceEnvironmentId: fixture.stagingEnvId,
        targetEnvironmentId: fixture.productionEnvId,
        attribution,
        authorize: async () => {},
      });
      const snapshot = async () => ({
        heads: (
          await db
            .select()
            .from(documents)
            .where(eq(documents.projectId, fixture.projectId))
        ).sort((a, b) => a.documentId.localeCompare(b.documentId)),
        versions: (
          await db
            .select()
            .from(documentVersions)
            .where(eq(documentVersions.projectId, fixture.projectId))
        ).sort(
          (a, b) =>
            a.documentId.localeCompare(b.documentId) || a.version - b.version,
        ),
      });
      const before = await snapshot();
      for (const unavailable of [false, true]) {
        let checks = 0;
        await assert.rejects(
          promoteDocuments(db, {
            project: slug,
            sourceEnvironmentId: fixture.stagingEnvId,
            targetEnvironmentId: fixture.productionEnvId,
            attribution,
            authorize: async () => {},
            documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
            activeCollaboration: {
              isDocumentActive: async () => {
                checks++;
                if (checks === 1) return false;
                if (unavailable) throw createCollaborationUnavailableError();
                return true;
              },
            },
          }),
          (error: any) =>
            error.code ===
            (unavailable
              ? "COLLABORATION_UNAVAILABLE"
              : "DOCUMENT_COLLABORATION_ACTIVE"),
        );
        assert.equal(checks, 2);
        assert.deepEqual(await snapshot(), before);
      }
      let dryRunChecks = 0;
      await promoteDocuments(db, {
        project: slug,
        sourceEnvironmentId: fixture.stagingEnvId,
        targetEnvironmentId: fixture.productionEnvId,
        attribution,
        authorize: async () => {},
        documentIds: [fixture.authorDocumentId, fixture.blogDocumentId],
        dryRun: true,
        activeCollaboration: {
          isDocumentActive: async () => {
            dryRunChecks++;
            return true;
          },
        },
      });
      assert.equal(dryRunChecks, 0);
      assert.deepEqual(await snapshot(), before);
    } finally {
      if (projectId) await teardownProject(db, projectId);
      await runtime.dbConnection.close();
    }
  },
);
