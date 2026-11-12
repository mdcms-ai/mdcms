import assert from "node:assert/strict";
import { test } from "bun:test";

import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import { createDatabaseConnection } from "./db.js";
import { environments, projects } from "./db/schema.js";
import {
  DEFAULT_PROVISION_ACTOR,
  findEnvironmentByProjectAndId,
  resolveProjectEnvironmentScope,
} from "./project-provisioning.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL:
    process.env.MDCMS_TEST_DATABASE_URL ??
    "postgres://mdcms:mdcms@localhost:5432/mdcms",
} as NodeJS.ProcessEnv;

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

async function seedScope(
  connection: ReturnType<typeof createDatabaseConnection>,
  scope: { project: string; environment: string },
) {
  await connection.db
    .insert(projects)
    .values({
      name: scope.project,
      slug: scope.project,
      createdBy: DEFAULT_PROVISION_ACTOR,
    })
    .onConflictDoNothing();

  const project = await connection.db.query.projects.findFirst({
    where: eq(projects.slug, scope.project),
  });
  assert.ok(project);

  await connection.db
    .insert(environments)
    .values({
      projectId: project.id,
      name: scope.environment,
      description: null,
      createdBy: DEFAULT_PROVISION_ACTOR,
    })
    .onConflictDoNothing();

  const environment = await connection.db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, project.id),
      eq(environments.name, scope.environment),
    ),
  });
  assert.ok(environment);

  return { project, environment };
}

testWithDatabase(
  "resolveProjectEnvironmentScope returns existing project-scoped environment rows",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const scope = {
        project: uniqueProject("project-scope-existing"),
        environment: "staging",
      };
      const seeded = await seedScope(connection, scope);

      const resolved = await resolveProjectEnvironmentScope(connection.db, {
        ...scope,
        createIfMissing: false,
      });

      assert.ok(resolved);
      assert.equal(resolved.project.id, seeded.project.id);
      assert.equal(resolved.project.slug, scope.project);
      assert.equal(resolved.environment.id, seeded.environment.id);
      assert.equal(resolved.environment.name, scope.environment);
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "resolveProjectEnvironmentScope provisions missing project production scope when requested",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const scope = {
        project: uniqueProject("project-scope-provision"),
        environment: "production",
      };

      const resolved = await resolveProjectEnvironmentScope(connection.db, {
        ...scope,
        createIfMissing: true,
      });

      assert.ok(resolved);
      assert.equal(resolved.project.slug, scope.project);
      assert.equal(resolved.environment.name, scope.environment);
      assert.equal(resolved.project.organizationId, null);
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "findEnvironmentByProjectAndId ignores environments from another project",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const primary = await seedScope(connection, {
        project: uniqueProject("project-scope-primary"),
        environment: "production",
      });
      const foreign = await seedScope(connection, {
        project: uniqueProject("project-scope-foreign"),
        environment: "preview",
      });

      const found = await findEnvironmentByProjectAndId(connection.db, {
        project: primary.project.slug,
        environmentId: foreign.environment.id,
      });

      assert.equal(found, undefined);
    } finally {
      await connection.close();
    }
  },
);
