import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import { createDatabaseConnection } from "./db.js";
import {
  documents,
  environments,
  projects,
  schemaRegistryEntries,
  schemaSyncs,
} from "./db/schema.js";
import {
  ensureDemoScopeProvisioned,
  ensureDemoSchemaSynced,
} from "./demo-seed.js";

const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const studioExampleConfigPath = join(
  workspaceRoot,
  "apps/studio-example/mdcms.config.ts",
);
const serverWorkspacePath = join(workspaceRoot, "apps/server");

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://mdcms:mdcms@localhost:5432/mdcms",
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

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runDemoSeed(overrides: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bun", ["run", "demo:seed"], {
      cwd: serverWorkspacePath,
      env: {
        ...process.env,
        ...env,
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolveResult({
        code,
        stdout,
        stderr,
      });
    });
  });
}

testWithDatabase(
  "ensureDemoScopeProvisioned creates the configured non-production demo environment",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const project = uniqueProject("demo-seed-staging");

      await withTempDir("demo-seed-config-", async (directory) => {
        const configPath = join(directory, "mdcms.config.ts");
        await writeFile(
          configPath,
          [
            "export default {",
            `  project: ${JSON.stringify(project)},`,
            '  serverUrl: "http://localhost:4000",',
            "  types: [],",
            "  environments: {",
            "    production: {},",
            "    staging: { extends: 'production' },",
            "  },",
            "};",
            "",
          ].join("\n"),
          "utf8",
        );

        await ensureDemoScopeProvisioned({
          db: connection.db,
          project,
          environment: "staging",
          cwd: directory,
          configPath: "mdcms.config.ts",
        });
      });

      const projectRow = await connection.db.query.projects.findFirst({
        where: eq(projects.slug, project),
      });
      assert.ok(projectRow);

      const productionRow = await connection.db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectRow.id),
          eq(environments.name, "production"),
        ),
      });
      const stagingRow = await connection.db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectRow.id),
          eq(environments.name, "staging"),
        ),
      });

      assert.ok(productionRow);
      assert.ok(stagingRow);
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "ensureDemoScopeProvisioned rejects non-production demo environments when config is missing",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      await assert.rejects(
        () =>
          ensureDemoScopeProvisioned({
            db: connection.db,
            project: uniqueProject("demo-seed-missing-config"),
            environment: "staging",
            cwd: "/tmp/does-not-exist",
            configPath: "missing.config.ts",
          }),
        /mdcms\.config\.ts/i,
      );
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "ensureDemoSchemaSynced creates a schema sync head for the configured demo environment",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const project = uniqueProject("demo-seed-schema");

      await withTempDir("demo-seed-schema-config-", async (directory) => {
        const configPath = join(directory, "mdcms.config.ts");
        await writeFile(
          configPath,
          [
            `import baseConfig from ${JSON.stringify(studioExampleConfigPath)};`,
            "export default {",
            "  ...baseConfig,",
            `  project: ${JSON.stringify(project)},`,
            '  environment: "staging",',
            "};",
            "",
          ].join("\n"),
          "utf8",
        );

        await ensureDemoScopeProvisioned({
          db: connection.db,
          project,
          environment: "staging",
          cwd: directory,
          configPath: "mdcms.config.ts",
        });

        await ensureDemoSchemaSynced({
          db: connection.db,
          project,
          environment: "staging",
          cwd: directory,
          configPath: "mdcms.config.ts",
        });
      });

      const projectRow = await connection.db.query.projects.findFirst({
        where: eq(projects.slug, project),
      });
      assert.ok(projectRow);

      const environmentRow = await connection.db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectRow.id),
          eq(environments.name, "staging"),
        ),
      });
      assert.ok(environmentRow);

      const schemaSyncRow = await connection.db.query.schemaSyncs.findFirst({
        where: and(
          eq(schemaSyncs.projectId, projectRow.id),
          eq(schemaSyncs.environmentId, environmentRow.id),
        ),
      });
      assert.ok(schemaSyncRow);

      const schemaRows = await connection.db
        .select()
        .from(schemaRegistryEntries)
        .where(
          and(
            eq(schemaRegistryEntries.projectId, projectRow.id),
            eq(schemaRegistryEntries.environmentId, environmentRow.id),
          ),
        );

      assert.deepEqual(schemaRows.map((row) => row.schemaType).sort(), [
        "author",
        "campaign",
        "page",
        "post",
      ]);
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "ensureDemoScopeProvisioned rejects config whose project does not match seed target",
  async () => {
    const connection = createDatabaseConnection({ env });

    try {
      const target = uniqueProject("demo-seed-mismatch");

      await withTempDir("demo-seed-mismatch-", async (directory) => {
        const configPath = join(directory, "mdcms.config.ts");
        await writeFile(
          configPath,
          [
            "export default {",
            '  project: "wrong-project",',
            '  serverUrl: "http://localhost:4000",',
            "  types: [],",
            "  environments: {",
            "    production: {},",
            "    staging: { extends: 'production' },",
            "  },",
            "};",
            "",
          ].join("\n"),
          "utf8",
        );

        await assert.rejects(
          () =>
            ensureDemoScopeProvisioned({
              db: connection.db,
              project: target,
              environment: "staging",
              cwd: directory,
              configPath: "mdcms.config.ts",
            }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /wrong-project/);
            assert.match(error.message, /demo-seed-mismatch/);
            assert.match(error.message, /To fix:/);
            return true;
          },
        );
      });
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "demo:seed completes successfully for a fresh staging scope",
  async () => {
    const project = "marketing-site";
    const runId = uniqueProject("demo-seed-script");
    const result = await runDemoSeed({
      MDCMS_DEMO_PROJECT: project,
      MDCMS_DEMO_ENVIRONMENT: "staging",
      MDCMS_DEMO_API_KEY: `mdcms_key_${runId.replace(/[^a-z0-9]/gi, "").slice(0, 24)}_demo`,
      MDCMS_DEMO_SEED_USER_EMAIL: `${runId}@mdcms.local`,
      MDCMS_DEMO_SEED_USER_NAME: "Demo Seed Test",
      MDCMS_DEMO_SEED_USER_PASSWORD: "Demo12345!",
    });

    assert.equal(
      result.code,
      0,
      `demo:seed failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const connection = createDatabaseConnection({ env });

    try {
      const projectRow = await connection.db.query.projects.findFirst({
        where: eq(projects.slug, project),
      });
      assert.ok(projectRow);

      const environmentRow = await connection.db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectRow.id),
          eq(environments.name, "staging"),
        ),
      });
      assert.ok(environmentRow);

      const campaignRows = await connection.db
        .select({
          documentId: documents.documentId,
          translationGroupId: documents.translationGroupId,
          locale: documents.locale,
          path: documents.path,
          schemaType: documents.schemaType,
          publishedVersion: documents.publishedVersion,
        })
        .from(documents)
        .where(
          and(
            eq(documents.projectId, projectRow.id),
            eq(documents.environmentId, environmentRow.id),
            eq(documents.schemaType, "campaign"),
            eq(documents.path, "content/campaigns/global-launch"),
          ),
        );

      assert.equal(campaignRows.length, 2);
      assert.deepEqual(campaignRows.map((row) => row.locale).sort(), [
        "en",
        "fr",
      ]);
      assert.equal(
        new Set(campaignRows.map((row) => row.translationGroupId)).size,
        1,
      );
      assert.ok(campaignRows.every((row) => row.publishedVersion !== null));
    } finally {
      await connection.close();
    }
  },
);
