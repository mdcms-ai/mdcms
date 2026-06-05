import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";

import { RuntimeError, createDefaultMediaSettings } from "@mdcms/shared";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";

import { createDatabaseConnection } from "../db.js";
import {
  environments,
  media,
  projectMediaSettings,
  projects,
  schemaRegistryEntries,
  schemaSyncs,
} from "../db/schema.js";
import { DEFAULT_PROVISION_ACTOR } from "../project-provisioning.js";

import { createDatabaseMediaStore } from "./database-store.js";
import { parseMediaId } from "./ids.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://mdcms:mdcms@localhost:5432/mdcms",
} as NodeJS.ProcessEnv;

const fixedNow = new Date("2026-06-05T12:00:00.000Z");

type DatabaseConnection = ReturnType<typeof createDatabaseConnection>;
type Database = DatabaseConnection["db"];
type Scope = {
  project: string;
  environment: string;
};

async function canConnectToDatabase(): Promise<boolean> {
  const client = postgres(env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
    connect_timeout: 1,
    max: 1,
  });

  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const dbAvailable = await canConnectToDatabase();
const testWithDatabase = dbAvailable ? test : test.skip;

function uniqueProject(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedScope(db: Database, scope: Scope) {
  await db
    .insert(projects)
    .values({
      name: scope.project,
      slug: scope.project,
      createdBy: DEFAULT_PROVISION_ACTOR,
    })
    .onConflictDoNothing();

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, scope.project),
  });
  assert.ok(project);

  await db
    .insert(environments)
    .values({
      projectId: project.id,
      name: scope.environment,
      description: null,
      createdBy: DEFAULT_PROVISION_ACTOR,
    })
    .onConflictDoNothing();

  const environment = await db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, project.id),
      eq(environments.name, scope.environment),
    ),
  });
  assert.ok(environment);

  return { project, environment };
}

async function cleanupProject(db: Database, projectId: string): Promise<void> {
  await db
    .delete(projectMediaSettings)
    .where(eq(projectMediaSettings.projectId, projectId));
  await db.delete(media).where(eq(media.projectId, projectId));
  await db
    .delete(schemaRegistryEntries)
    .where(eq(schemaRegistryEntries.projectId, projectId));
  await db.delete(schemaSyncs).where(eq(schemaSyncs.projectId, projectId));
  await db.delete(environments).where(eq(environments.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
}

async function countSchemaSyncRows(
  db: Database,
  projectId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schemaSyncs)
    .where(eq(schemaSyncs.projectId, projectId));

  return Number(row?.count ?? 0);
}

async function countSchemaRegistryRows(
  db: Database,
  projectId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schemaRegistryEntries)
    .where(eq(schemaRegistryEntries.projectId, projectId));

  return Number(row?.count ?? 0);
}

async function countMediaSettingsRows(
  db: Database,
  projectId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMediaSettings)
    .where(eq(projectMediaSettings.projectId, projectId));

  return Number(row?.count ?? 0);
}

function assertRuntimeNotFound(
  expectedDetails: Record<string, unknown>,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.statusCode, 404);
    assert.deepEqual(error.details, expectedDetails);
    return true;
  };
}

test("parseMediaId returns UUID media ids", () => {
  assert.equal(
    parseMediaId("8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7"),
    "8bc2d4d3-9e0a-43f4-b9c4-2d31aa0e93f7",
  );
});

test("parseMediaId rejects invalid media ids", () => {
  assert.throws(
    () => parseMediaId("not-a-uuid"),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.code, "INVALID_INPUT");
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, "Media id must be a UUID.");
      assert.deepEqual(error.details, { field: "id" });
      return true;
    },
  );
});

testWithDatabase(
  "getSettings returns default unlimited settings when unset",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-settings-default"),
      environment: "production",
    };
    let projectId: string | undefined;

    try {
      const seeded = await seedScope(connection.db, scope);
      projectId = seeded.project.id;

      assert.deepEqual(
        await store.getSettings(scope),
        createDefaultMediaSettings(),
      );
    } finally {
      if (projectId) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "updateSettings upserts project media settings without schema sync rows",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-settings-upsert"),
      environment: "production",
    };
    let projectId: string | undefined;

    try {
      const seeded = await seedScope(connection.db, scope);
      projectId = seeded.project.id;
      await connection.db.insert(schemaRegistryEntries).values({
        projectId,
        environmentId: seeded.environment.id,
        schemaType: "BlogPost",
        directory: "content/blog",
        localized: true,
        schemaHash: "schema-hash-before-media-settings",
        resolvedSchema: {
          type: "BlogPost",
          directory: "content/blog",
          localized: true,
        },
      });

      const firstUpdate = await store.updateSettings(
        scope,
        { media: { image: { maxUploadSizeBytes: 10485760 } } },
        { actorId: "user_123" },
      );
      const secondUpdate = await store.updateSettings(
        scope,
        { media: { image: { maxUploadSizeBytes: null } } },
        { actorId: "user_456" },
      );

      assert.deepEqual(firstUpdate, {
        media: { image: { maxUploadSizeBytes: 10485760 } },
      });
      assert.deepEqual(secondUpdate, createDefaultMediaSettings());
      assert.equal(await countMediaSettingsRows(connection.db, projectId), 1);
      assert.equal(await countSchemaSyncRows(connection.db, projectId), 0);
      assert.equal(await countSchemaRegistryRows(connection.db, projectId), 1);

      const settingsRow =
        await connection.db.query.projectMediaSettings.findFirst({
          where: eq(projectMediaSettings.projectId, projectId),
        });
      assert.ok(settingsRow);
      assert.equal(settingsRow.updatedBy, "user_456");
      assert.equal(settingsRow.imageMaxUploadSizeBytes, null);

      const schemaRegistryRow =
        await connection.db.query.schemaRegistryEntries.findFirst({
          where: eq(schemaRegistryEntries.projectId, projectId),
        });
      assert.equal(
        schemaRegistryRow?.schemaHash,
        "schema-hash-before-media-settings",
      );
    } finally {
      if (projectId) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "createAsset persists metadata and getAsset returns public shape",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-asset-create"),
      environment: "production",
    };
    let projectId: string | undefined;

    try {
      const seeded = await seedScope(connection.db, scope);
      projectId = seeded.project.id;
      const mediaId = randomUUID();
      const input = {
        id: mediaId,
        filename: "hero.png",
        mimeType: "image/png",
        sizeBytes: 204800,
        s3Key: `projects/${scope.project}/media/${mediaId}/hero.png`,
        url: `http://localhost:9000/mdcms-media/projects/${scope.project}/media/${mediaId}/hero.png`,
      };

      const created = await store.createAsset(scope, input, {
        actorId: "user_123",
      });

      assert.deepEqual(created, {
        id: input.id,
        project: scope.project,
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        url: input.url,
        uploadedBy: "user_123",
        uploadedAt: fixedNow.toISOString(),
      });
      assert.deepEqual(await store.getAsset(scope, input.id), created);
      assert.equal("s3Key" in created, false);
      assert.deepEqual(await store.getAssetRecord(scope, input.id), {
        ...created,
        s3Key: input.s3Key,
      });

      const metadata = await connection.db.query.media.findFirst({
        where: eq(media.id, input.id),
      });
      assert.ok(metadata);
      assert.equal(metadata.projectId, seeded.project.id);
      assert.equal(metadata.filename, input.filename);
      assert.equal(metadata.mimeType, input.mimeType);
      assert.equal(metadata.sizeBytes, input.sizeBytes);
      assert.equal(metadata.s3Key, input.s3Key);
      assert.equal(metadata.url, input.url);
      assert.equal(metadata.uploadedBy, "user_123");
      assert.equal(metadata.uploadedAt.toISOString(), fixedNow.toISOString());
    } finally {
      if (projectId) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "deleteAssetMetadata deletes only metadata for the routed project",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-asset-delete"),
      environment: "production",
    };
    const foreignScope = {
      project: uniqueProject("media-asset-delete-foreign"),
      environment: "production",
    };
    const projectIds: string[] = [];

    try {
      const seeded = await seedScope(connection.db, scope);
      const foreignSeeded = await seedScope(connection.db, foreignScope);
      projectIds.push(seeded.project.id, foreignSeeded.project.id);
      const primaryId = randomUUID();
      const foreignId = randomUUID();

      const primaryAsset = await store.createAsset(
        scope,
        {
          id: primaryId,
          filename: "hero.png",
          mimeType: "image/png",
          sizeBytes: 204800,
          s3Key: `projects/${scope.project}/media/${primaryId}/hero.png`,
          url: `http://localhost:9000/mdcms-media/projects/${scope.project}/media/${primaryId}/hero.png`,
        },
        { actorId: "user_123" },
      );
      const foreignAsset = await store.createAsset(
        foreignScope,
        {
          id: foreignId,
          filename: "other.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          s3Key: `projects/${foreignScope.project}/media/${foreignId}/other.png`,
          url: `http://localhost:9000/mdcms-media/projects/${foreignScope.project}/media/${foreignId}/other.png`,
        },
        { actorId: "user_456" },
      );

      assert.deepEqual(
        await store.deleteAssetMetadata(scope, primaryAsset.id),
        {
          deleted: true,
          id: primaryAsset.id,
        },
      );
      assert.equal(await store.getAsset(scope, primaryAsset.id), undefined);
      assert.deepEqual(
        await store.getAsset(foreignScope, foreignAsset.id),
        foreignAsset,
      );
    } finally {
      for (const projectId of projectIds) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "getAsset returns undefined for a media id in another project",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-asset-isolation"),
      environment: "production",
    };
    const foreignScope = {
      project: uniqueProject("media-asset-isolation-foreign"),
      environment: "production",
    };
    const projectIds: string[] = [];

    try {
      const seeded = await seedScope(connection.db, scope);
      const foreignSeeded = await seedScope(connection.db, foreignScope);
      projectIds.push(seeded.project.id, foreignSeeded.project.id);
      const foreignId = randomUUID();

      const foreignAsset = await store.createAsset(
        foreignScope,
        {
          id: foreignId,
          filename: "foreign.png",
          mimeType: "image/png",
          sizeBytes: 1024,
          s3Key: `projects/${foreignScope.project}/media/${foreignId}/foreign.png`,
          url: `http://localhost:9000/mdcms-media/projects/${foreignScope.project}/media/${foreignId}/foreign.png`,
        },
        { actorId: "user_456" },
      );

      assert.equal(await store.getAsset(scope, foreignAsset.id), undefined);
      assert.equal(
        await store.getAssetRecord(scope, foreignAsset.id),
        undefined,
      );
      assert.equal(await store.getAsset(scope, randomUUID()), undefined);
      assert.equal(await store.getAssetRecord(scope, randomUUID()), undefined);
    } finally {
      for (const projectId of projectIds) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "deleteAssetMetadata throws not found for missing media rows",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-asset-delete-missing"),
      environment: "production",
    };
    let projectId: string | undefined;

    try {
      const seeded = await seedScope(connection.db, scope);
      projectId = seeded.project.id;
      const missingMediaId = randomUUID();

      await assert.rejects(
        () => store.deleteAssetMetadata(scope, missingMediaId),
        assertRuntimeNotFound({
          id: missingMediaId,
        }),
      );
    } finally {
      if (projectId) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);

testWithDatabase(
  "missing project or environment throws RuntimeError not found",
  async () => {
    const connection = createDatabaseConnection({ env });
    const store = createDatabaseMediaStore({
      db: connection.db,
      now: () => fixedNow,
    });
    const scope = {
      project: uniqueProject("media-missing-scope"),
      environment: "production",
    };
    let projectId: string | undefined;

    try {
      const seeded = await seedScope(connection.db, scope);
      projectId = seeded.project.id;
      const missingProject = uniqueProject("media-missing-project");

      await assert.rejects(
        () =>
          store.getSettings({
            project: missingProject,
            environment: "production",
          }),
        assertRuntimeNotFound({
          project: missingProject,
          environment: "production",
        }),
      );
      await assert.rejects(
        () =>
          store.getSettings({
            project: scope.project,
            environment: "staging",
          }),
        assertRuntimeNotFound({
          project: scope.project,
          environment: "staging",
        }),
      );
    } finally {
      if (projectId) {
        await cleanupProject(connection.db, projectId);
      }
      await connection.close();
    }
  },
);
