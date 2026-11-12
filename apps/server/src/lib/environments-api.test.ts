import { integrationTestDatabaseUrl } from "./integration-test-database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";

import { createConsoleLogger, parseMdcmsConfig } from "@mdcms/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import {
  documents,
  environments,
  projectEnvironmentTopologySnapshots,
  rbacGrants,
  schemaSyncs,
} from "./db/schema.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: integrationTestDatabaseUrl(),
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "error",
  sink: () => undefined,
});

const DEFAULT_ACTOR = "00000000-0000-0000-0000-000000000001";
const testConfig = parseMdcmsConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",
  types: [],
  environments: {
    production: {},
    staging: {
      extends: "production",
    },
    preview: {
      extends: "staging",
    },
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
const testWithDatabase = dbAvailable ? test : test.skip;

function uniqueEmail(): string {
  return `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mdcms.local`;
}

function uniqueProject(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function signUp(
  handler: (request: Request) => Promise<Response>,
  input: {
    email: string;
    password: string;
    name?: string;
  },
): Promise<void> {
  const response = await handler(
    new Request("http://localhost/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        name: input.name ?? "Admin User",
      }),
    }),
  );

  assert.equal(response.status, 200);
}

async function login(
  handler: (request: Request) => Promise<Response>,
  input: {
    email: string;
    password: string;
  },
): Promise<{
  cookie: string;
  setCookie: string;
  session: {
    userId: string;
  };
}> {
  const response = await handler(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );

  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  const body = (await response.json()) as {
    data: {
      session: {
        userId: string;
      };
    };
  };

  return {
    cookie: toCookieHeader(setCookie),
    setCookie,
    session: body.data.session,
  };
}

function splitSetCookieHeader(header: string): string[] {
  return header
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function toCookieHeader(setCookie: string): string {
  return splitSetCookieHeader(setCookie)
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("; ");
}

function extractCookieValue(
  setCookie: string,
  name: string,
): string | undefined {
  return splitSetCookieHeader(setCookie)
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function createCsrfHeaders(
  loginResult: {
    cookie: string;
    setCookie: string;
  },
  headers: Record<string, string> = {},
): Record<string, string> {
  const csrfToken = extractCookieValue(loginResult.setCookie, "mdcms_csrf");
  assert.ok(csrfToken);

  return {
    cookie: loginResult.cookie,
    "x-mdcms-csrf-token": csrfToken,
    ...headers,
  };
}

async function grantGlobalOwner(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  userId: string,
  source: string,
  createdByUserId = userId,
) {
  await db
    .insert(rbacGrants)
    .values({
      userId,
      role: "owner",
      scopeKind: "global",
      source,
      createdByUserId,
    })
    .onConflictDoNothing();
}

async function insertTopologySnapshot(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  project: string,
) {
  await db
    .insert(projectEnvironmentTopologySnapshots)
    .values({
      project,
      configSnapshotHash: "sha256:test-topology",
      definitions: [
        {
          name: "preview",
          extends: "staging",
          isDefault: false,
        },
        {
          name: "production",
          extends: null,
          isDefault: true,
        },
        {
          name: "staging",
          extends: "production",
          isDefault: false,
        },
      ],
      syncedAt: new Date("2026-03-19T10:00:00.000Z"),
    })
    .onConflictDoUpdate({
      target: [projectEnvironmentTopologySnapshots.project],
      set: {
        configSnapshotHash: "sha256:test-topology",
        definitions: [
          {
            name: "preview",
            extends: "staging",
            isDefault: false,
          },
          {
            name: "production",
            extends: null,
            isDefault: true,
          },
          {
            name: "staging",
            extends: "production",
            isDefault: false,
          },
        ],
        syncedAt: new Date("2026-03-19T10:00:00.000Z"),
      },
    });
}

type EnvironmentSummary = {
  id: string;
  project: string;
  name: string;
  extends: string | null;
  isDefault: boolean;
  createdAt: string;
};

testWithDatabase(
  "environments API creates project-scoped environments and provisions default production",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-success");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-success-owner",
      );
      await insertTopologySnapshot(dbConnection.db, project);

      const createResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      const createBody = (await createResponse.json()) as {
        data: EnvironmentSummary;
      };

      assert.equal(createResponse.status, 200);
      assert.equal(createBody.data.project, project);
      assert.equal(createBody.data.name, "staging");
      assert.equal(createBody.data.extends, "production");
      assert.equal(createBody.data.isDefault, false);

      const listResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          headers: {
            cookie: loginResult.cookie,
          },
        }),
      );
      const listBody = (await listResponse.json()) as {
        data: EnvironmentSummary[];
        meta: {
          definitionsStatus: string;
          configSnapshotHash: string;
        };
      };

      assert.equal(listResponse.status, 200);
      assert.equal(listBody.meta.definitionsStatus, "ready");
      assert.equal(listBody.meta.configSnapshotHash, "sha256:test-topology");
      assert.deepEqual(
        listBody.data.map((entry) => ({
          project: entry.project,
          name: entry.name,
          extends: entry.extends,
          isDefault: entry.isDefault,
        })),
        [
          {
            project,
            name: "production",
            extends: null,
            isDefault: true,
          },
          {
            project,
            name: "staging",
            extends: "production",
            isDefault: false,
          },
        ],
      );

      const projectRow = await dbConnection.db.query.projects.findFirst({
        where: (table, operators) => operators.eq(table.slug, project),
      });
      assert.ok(projectRow);

      const environmentRows = await dbConnection.db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectRow.id));

      assert.deepEqual(environmentRows.map((entry) => entry.name).sort(), [
        "production",
        "staging",
      ]);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API requires a synced topology snapshot before create",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-missing-topology");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-missing-topology-owner",
      );

      const createResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      const createBody = (await createResponse.json()) as {
        code: string;
        message: string;
      };

      assert.equal(createResponse.status, 409);
      assert.equal(createBody.code, "CONFIG_SNAPSHOT_REQUIRED");
      assert.match(createBody.message, /cms schema sync/i);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API rejects session mutations without CSRF and accepts matching tokens",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-csrf");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-csrf-owner",
      );
      await insertTopologySnapshot(dbConnection.db, project);

      const missingHeaderResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: {
            cookie: loginResult.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      const missingHeaderBody = (await missingHeaderResponse.json()) as {
        code: string;
      };

      assert.equal(missingHeaderResponse.status, 403);
      assert.equal(missingHeaderBody.code, "FORBIDDEN");

      const matchingResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );

      assert.equal(matchingResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API rejects duplicate names, unknown config environments, and extends mismatches",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-invalid");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-invalid-owner",
      );
      await insertTopologySnapshot(dbConnection.db, project);

      const firstCreateResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      assert.equal(firstCreateResponse.status, 200);

      const duplicateResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      const duplicateBody = (await duplicateResponse.json()) as {
        code: string;
      };

      assert.equal(duplicateResponse.status, 409);
      assert.equal(duplicateBody.code, "CONFLICT");

      const unknownResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "qa",
          }),
        }),
      );
      const unknownBody = (await unknownResponse.json()) as { code: string };

      assert.equal(unknownResponse.status, 400);
      assert.equal(unknownBody.code, "INVALID_INPUT");

      const mismatchedExtendsResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "preview",
            extends: "production",
          }),
        }),
      );
      const mismatchedExtendsBody =
        (await mismatchedExtendsResponse.json()) as {
          code: string;
        };

      assert.equal(mismatchedExtendsResponse.status, 400);
      assert.equal(mismatchedExtendsBody.code, "INVALID_INPUT");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API protects production and non-empty environments from deletion",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-delete");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-delete-owner",
      );
      await insertTopologySnapshot(dbConnection.db, project);

      const createStagingResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "staging",
            extends: "production",
          }),
        }),
      );
      const createStagingBody = (await createStagingResponse.json()) as {
        data: EnvironmentSummary;
      };
      assert.equal(createStagingResponse.status, 200);

      const createPreviewResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            name: "preview",
            extends: "staging",
          }),
        }),
      );
      const createPreviewBody = (await createPreviewResponse.json()) as {
        data: EnvironmentSummary;
      };
      assert.equal(createPreviewResponse.status, 200);

      const productionListResponse = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          headers: {
            cookie: loginResult.cookie,
          },
        }),
      );
      const productionListBody = (await productionListResponse.json()) as {
        data: EnvironmentSummary[];
      };
      const productionEnvironment = productionListBody.data.find(
        (entry) => entry.name === "production",
      );
      assert.ok(productionEnvironment);

      const projectRow = await dbConnection.db.query.projects.findFirst({
        where: (table, operators) => operators.eq(table.slug, project),
      });
      assert.ok(projectRow);

      const stagingRow = await dbConnection.db.query.environments.findFirst({
        where: and(
          eq(environments.projectId, projectRow.id),
          eq(environments.name, "staging"),
        ),
      });
      assert.ok(stagingRow);

      await dbConnection.db.insert(documents).values({
        documentId: randomUUID(),
        translationGroupId: randomUUID(),
        projectId: projectRow.id,
        environmentId: stagingRow.id,
        path: `blog/${Date.now()}`,
        schemaType: "Post",
        locale: "en",
        contentFormat: "md",
        body: "body",
        frontmatter: {},
        isDeleted: false,
        hasUnpublishedChanges: true,
        publishedVersion: null,
        draftRevision: 1,
        createdBy: DEFAULT_ACTOR,
        updatedBy: DEFAULT_ACTOR,
      });

      await dbConnection.db.insert(schemaSyncs).values({
        projectId: projectRow.id,
        environmentId: stagingRow.id,
        schemaHash: "hash",
        rawConfigSnapshot: {
          project,
        },
      });

      const deleteProductionResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments/${productionEnvironment.id}?project=${project}`,
          {
            method: "DELETE",
            headers: createCsrfHeaders(loginResult),
          },
        ),
      );
      const deleteProductionBody = (await deleteProductionResponse.json()) as {
        code: string;
      };

      assert.equal(deleteProductionResponse.status, 409);
      assert.equal(deleteProductionBody.code, "CONFLICT");

      const deleteStagingResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments/${createStagingBody.data.id}?project=${project}`,
          {
            method: "DELETE",
            headers: createCsrfHeaders(loginResult),
          },
        ),
      );
      const deleteStagingBody = (await deleteStagingResponse.json()) as {
        code: string;
      };

      assert.equal(deleteStagingResponse.status, 409);
      assert.equal(deleteStagingBody.code, "CONFLICT");

      const deletePreviewResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments/${createPreviewBody.data.id}?project=${project}`,
          {
            method: "DELETE",
            headers: createCsrfHeaders(loginResult),
          },
        ),
      );
      const deletePreviewBody = (await deletePreviewResponse.json()) as {
        data: { deleted: boolean; id: string };
      };

      assert.equal(deletePreviewResponse.status, 200);
      assert.equal(deletePreviewBody.data.deleted, true);
      assert.equal(deletePreviewBody.data.id, createPreviewBody.data.id);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API requires an admin or owner session",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";
    const project = uniqueProject("env-auth");

    try {
      await signUp(handler, { email: ownerEmail, password });
      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Editor User",
      });

      const ownerLogin = await login(handler, { email: ownerEmail, password });
      await grantGlobalOwner(
        dbConnection.db,
        ownerLogin.session.userId,
        "test:environments-auth-owner",
      );
      const editorLogin = await login(handler, {
        email: editorEmail,
        password,
      });

      const response = await handler(
        new Request(`http://localhost/api/v1/environments?project=${project}`, {
          headers: {
            cookie: editorLogin.cookie,
          },
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 403);
      assert.equal(body.code, "FORBIDDEN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "environments API returns not found when deleting an environment from another project",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
      config: testConfig,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const primaryProject = uniqueProject("env-primary");
    const foreignProject = uniqueProject("env-foreign");

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      await grantGlobalOwner(
        dbConnection.db,
        loginResult.session.userId,
        "test:environments-project-owner",
      );
      await insertTopologySnapshot(dbConnection.db, primaryProject);
      await insertTopologySnapshot(dbConnection.db, foreignProject);

      const primaryCreateResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments?project=${primaryProject}`,
          {
            method: "POST",
            headers: createCsrfHeaders(loginResult, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              name: "staging",
              extends: "production",
            }),
          },
        ),
      );
      assert.equal(primaryCreateResponse.status, 200);

      const foreignCreateResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments?project=${foreignProject}`,
          {
            method: "POST",
            headers: createCsrfHeaders(loginResult, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              name: "preview",
              extends: "staging",
            }),
          },
        ),
      );
      const foreignCreateBody = (await foreignCreateResponse.json()) as {
        data: EnvironmentSummary;
      };
      assert.equal(foreignCreateResponse.status, 200);

      const deleteResponse = await handler(
        new Request(
          `http://localhost/api/v1/environments/${foreignCreateBody.data.id}?project=${primaryProject}`,
          {
            method: "DELETE",
            headers: createCsrfHeaders(loginResult),
          },
        ),
      );
      const deleteBody = (await deleteResponse.json()) as {
        code: string;
      };
      assert.equal(deleteResponse.status, 404);
      assert.equal(deleteBody.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);
