import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";

import { createConsoleLogger } from "@mdcms/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import { createDatabaseConnection } from "./db.js";
import {
  documents,
  environments,
  projectEnvironmentTopologySnapshots,
  projects,
  rbacGrants,
  schemaRegistryEntries,
  schemaSyncs,
} from "./db/schema.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";
import {
  createDatabaseSchemaStore,
  mountSchemaApiRoutes,
  type SchemaRegistryStore,
} from "./schema-api.js";
import { createServerRequestHandler } from "./server.js";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

const dbEnv = {
  ...baseEnv,
  DATABASE_URL:
    process.env.MDCMS_TEST_DATABASE_URL ??
    "postgres://mdcms:mdcms@localhost:5432/mdcms",
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "error",
  sink: () => undefined,
});

const fixedNow = new Date("2026-03-11T12:00:00.000Z");
const DEFAULT_ACTOR = "00000000-0000-0000-0000-000000000001";

async function canConnectToDatabase(): Promise<boolean> {
  const client = postgres(dbEnv.DATABASE_URL ?? "", {
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

function createScope() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    project: `schema-${suffix}`,
    environment: `env-${suffix}`,
  };
}

function uniqueEmail(): string {
  return `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mdcms.local`;
}

function toScopeHeaders(scope: { project: string; environment: string }) {
  return {
    "x-mdcms-project": scope.project,
    "x-mdcms-environment": scope.environment,
  };
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
        name: input.name ?? "Schema Test User",
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

async function seedScope(
  connection: ReturnType<typeof createDatabaseConnection>,
  scope: { project: string; environment: string },
) {
  await connection.db
    .insert(projects)
    .values({
      name: scope.project,
      slug: scope.project,
      createdBy: DEFAULT_ACTOR,
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
      createdBy: DEFAULT_ACTOR,
    })
    .onConflictDoNothing();

  const environment = await connection.db.query.environments.findFirst({
    where: and(
      eq(environments.projectId, project.id),
      eq(environments.name, scope.environment),
    ),
  });
  assert.ok(environment);

  return {
    projectId: project.id,
    environmentId: environment.id,
  };
}

async function insertDocument(
  connection: ReturnType<typeof createDatabaseConnection>,
  scopeIds: { projectId: string; environmentId: string },
  input: {
    type: string;
    locale: string;
    path: string;
    isDeleted?: boolean;
  },
) {
  await connection.db.insert(documents).values({
    documentId: randomUUID(),
    translationGroupId: randomUUID(),
    projectId: scopeIds.projectId,
    environmentId: scopeIds.environmentId,
    path: input.path,
    schemaType: input.type,
    locale: input.locale,
    contentFormat: "md",
    body: "body",
    frontmatter: {},
    isDeleted: input.isDeleted ?? false,
    hasUnpublishedChanges: true,
    publishedVersion: null,
    draftRevision: 1,
    createdBy: DEFAULT_ACTOR,
    updatedBy: DEFAULT_ACTOR,
  });
}

function createSyncPayload(input: {
  project?: string;
  schemaHash: string;
  supportedLocales?: string[];
  resolvedSchema: Record<string, unknown>;
}) {
  return {
    rawConfigSnapshot: {
      project: input.project ?? "marketing-site",
      environments: {
        production: {},
      },
      ...(input.supportedLocales
        ? {
            locales: {
              supported: input.supportedLocales,
            },
          }
        : {}),
    },
    resolvedSchema: input.resolvedSchema,
    schemaHash: input.schemaHash,
  };
}

function createRegistryType(input: {
  type: string;
  directory: string;
  localized?: boolean;
  fields: Record<string, unknown>;
}) {
  return {
    type: input.type,
    directory: input.directory,
    localized: input.localized ?? false,
    fields: input.fields,
  };
}

function createField(input: {
  kind: string;
  required?: boolean;
  nullable?: boolean;
  item?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  options?: unknown[];
  reference?: { targetType: string };
}) {
  return {
    kind: input.kind,
    required: input.required ?? true,
    nullable: input.nullable ?? false,
    ...(input.item ? { item: input.item } : {}),
    ...(input.fields ? { fields: input.fields } : {}),
    ...(input.options ? { options: input.options } : {}),
    ...(input.reference ? { reference: input.reference } : {}),
  };
}

function createValidationHandler() {
  let syncCallCount = 0;
  const store: SchemaRegistryStore = {
    async list() {
      return [];
    },
    async getByType() {
      return undefined;
    },
    async getCurrentSync() {
      return undefined;
    },
    async sync() {
      syncCallCount += 1;

      return {
        schemaHash: "unused",
        syncedAt: fixedNow.toISOString(),
        affectedTypes: [],
      };
    },
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    logger,
    now: () => fixedNow,
    configureApp: (app) => {
      mountSchemaApiRoutes(app, {
        store,
        authorize: async () => undefined,
        requireCsrf: async () => undefined,
      });
    },
  });

  return {
    handler,
    getSyncCallCount: () => syncCallCount,
  };
}

function createHandler() {
  const dbConnection = createDatabaseConnection({ env: dbEnv });
  const authCalls: string[] = [];
  const store = createDatabaseSchemaStore({
    db: dbConnection.db,
    now: () => fixedNow,
  });
  const handler = createServerRequestHandler({
    env: baseEnv,
    logger,
    now: () => fixedNow,
    configureApp: (app) => {
      mountSchemaApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          authCalls.push(requirement.requiredScope);
        },
        requireCsrf: async () => undefined,
      });
    },
  });

  return {
    handler,
    dbConnection,
    authCalls,
  };
}

test("schema API requires explicit target routing", async () => {
  const { handler, dbConnection } = createHandler();

  try {
    const response = await handler(
      new Request("http://localhost/api/v1/schema"),
    );
    const body = (await response.json()) as { code: string };

    assert.equal(response.status, 400);
    assert.equal(body.code, "MISSING_TARGET_ROUTING");
  } finally {
    await dbConnection.close();
  }
});

test("schema list response includes the resolved project slug", async () => {
  const store: SchemaRegistryStore = {
    async list() {
      return [];
    },
    async getByType() {
      return undefined;
    },
    async getCurrentSync() {
      return undefined;
    },
    async sync() {
      return {
        schemaHash: "unused",
        syncedAt: fixedNow.toISOString(),
        affectedTypes: [],
      };
    },
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    logger,
    now: () => fixedNow,
    configureApp: (app) => {
      mountSchemaApiRoutes(app, {
        store,
        authorize: async () => undefined,
        requireCsrf: async () => undefined,
      });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/schema", {
      headers: {
        "x-mdcms-project": "my-project",
        "x-mdcms-environment": "production",
      },
    }),
  );
  const body = (await response.json()) as {
    data: {
      types: unknown[];
      schemaHash: string | null;
      syncedAt: string | null;
      project: string;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.project, "my-project");
});

test("schema API rejects localized schema sync payloads without explicit supported locales", async () => {
  const { handler, getSyncCallCount } = createValidationHandler();
  const response = await handler(
    new Request("http://localhost/api/v1/schema", {
      method: "PUT",
      headers: {
        "x-mdcms-project": "marketing-site",
        "x-mdcms-environment": "production",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        rawConfigSnapshot: {
          project: "marketing-site",
        },
        resolvedSchema: {
          Post: createRegistryType({
            type: "Post",
            directory: "content/posts",
            localized: true,
            fields: {
              title: createField({ kind: "string" }),
            },
          }),
        },
        schemaHash: "hash-1",
      }),
    }),
  );
  const body = (await response.json()) as {
    code: string;
    details?: Record<string, unknown>;
  };

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(
    body.details?.field,
    "payload.rawConfigSnapshot.locales.supported",
  );
  assert.equal(getSyncCallCount(), 0);
});

testWithDatabase(
  "schema API rejects session writes without CSRF and accepts matching tokens",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: dbEnv,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const scope = createScope();
    const scopeHeaders = toScopeHeaders(scope);
    const payload = createSyncPayload({
      project: scope.project,
      schemaHash: "csrf-hash-1",
      resolvedSchema: {
        Post: createRegistryType({
          type: "Post",
          directory: "content/posts",
          fields: {
            title: createField({ kind: "string" }),
          },
        }),
      },
    });

    try {
      await signUp(handler, {
        email,
        password,
        name: "Schema CSRF User",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:schema-csrf-owner",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection, scope);

      const missingHeaderResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            cookie: loginResult.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      const missingHeaderBody = (await missingHeaderResponse.json()) as {
        code: string;
      };

      assert.equal(missingHeaderResponse.status, 403);
      assert.equal(missingHeaderBody.code, "FORBIDDEN");

      const matchingResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: createCsrfHeaders(loginResult, {
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(payload),
        }),
      );

      assert.equal(matchingResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API persists one sync row, returns per-type entries, and exposes reads by type",
  async () => {
    const { handler, dbConnection, authCalls } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);
      const payload = createSyncPayload({
        project: scope.project,
        schemaHash: "hash-1",
        supportedLocales: ["en", "fr"],
        resolvedSchema: {
          Author: createRegistryType({
            type: "Author",
            directory: "content/authors",
            fields: {
              name: createField({ kind: "string" }),
            },
          }),
          Post: createRegistryType({
            type: "Post",
            directory: "content/posts",
            localized: true,
            fields: {
              title: createField({ kind: "string" }),
              author: createField({
                kind: "string",
                reference: { targetType: "Author" },
              }),
            },
          }),
        },
      });

      const putResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      const putBody = (await putResponse.json()) as {
        data: {
          schemaHash: string;
          syncedAt: string;
          affectedTypes: string[];
        };
      };

      assert.equal(putResponse.status, 200);
      assert.deepEqual(putBody.data, {
        schemaHash: "hash-1",
        syncedAt: fixedNow.toISOString(),
        affectedTypes: ["Author", "Post"],
      });

      const syncRows = await dbConnection.db
        .select()
        .from(schemaSyncs)
        .where(
          and(
            eq(schemaSyncs.projectId, scopeIds.projectId),
            eq(schemaSyncs.environmentId, scopeIds.environmentId),
          ),
        );

      assert.equal(syncRows.length, 1);
      assert.equal(syncRows[0]?.schemaHash, "hash-1");
      assert.deepEqual(
        syncRows[0]?.rawConfigSnapshot,
        payload.rawConfigSnapshot,
      );
      assert.equal(
        Reflect.has(syncRows[0] ?? {}, "extractedComponents"),
        false,
      );

      const topologyRows = await dbConnection.db
        .select()
        .from(projectEnvironmentTopologySnapshots)
        .where(eq(projectEnvironmentTopologySnapshots.project, scope.project));

      assert.equal(topologyRows.length, 1);
      assert.equal(
        topologyRows[0]?.configSnapshotHash.startsWith("sha256:"),
        true,
      );
      assert.deepEqual(topologyRows[0]?.definitions, [
        {
          name: "production",
          extends: null,
          isDefault: true,
        },
      ]);

      const entryRows = await dbConnection.db
        .select()
        .from(schemaRegistryEntries)
        .where(
          and(
            eq(schemaRegistryEntries.projectId, scopeIds.projectId),
            eq(schemaRegistryEntries.environmentId, scopeIds.environmentId),
          ),
        );

      assert.equal(entryRows.length, 2);

      const listResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: scopeHeaders,
        }),
      );
      const listBody = (await listResponse.json()) as {
        data: {
          types: Array<{
            type: string;
            directory: string;
            localized: boolean;
            schemaHash: string;
            syncedAt: string;
          }>;
          schemaHash: string | null;
          syncedAt: string | null;
        };
      };

      assert.equal(listResponse.status, 200);
      assert.deepEqual(
        listBody.data.types.map((entry) => ({
          type: entry.type,
          directory: entry.directory,
          localized: entry.localized,
          schemaHash: entry.schemaHash,
          syncedAt: entry.syncedAt,
        })),
        [
          {
            type: "Author",
            directory: "content/authors",
            localized: false,
            schemaHash: "hash-1",
            syncedAt: fixedNow.toISOString(),
          },
          {
            type: "Post",
            directory: "content/posts",
            localized: true,
            schemaHash: "hash-1",
            syncedAt: fixedNow.toISOString(),
          },
        ],
      );

      const getResponse = await handler(
        new Request("http://localhost/api/v1/schema/Post", {
          headers: scopeHeaders,
        }),
      );
      const getBody = (await getResponse.json()) as {
        data: {
          type: string;
          directory: string;
          localized: boolean;
          resolvedSchema: {
            fields: Record<string, unknown>;
          };
        };
      };

      assert.equal(getResponse.status, 200);
      assert.equal(getBody.data.type, "Post");
      assert.equal(getBody.data.directory, "content/posts");
      assert.equal(getBody.data.localized, true);
      assert.deepEqual(Object.keys(getBody.data.resolvedSchema.fields).sort(), [
        "author",
        "title",
      ]);
      assert.deepEqual(authCalls, [
        "schema:write",
        "schema:read",
        "schema:read",
      ]);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API keeps the project topology hash stable across environment-specific sync payloads",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const store = createDatabaseSchemaStore({
      db: dbConnection.db,
      now: () => fixedNow,
    });
    const project = `schema-topology-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const productionScope = { project, environment: "production" };
    const stagingScope = { project, environment: "staging" };
    const baseRawConfigSnapshot = {
      project,
      serverUrl: "http://localhost:4000",
      environments: {
        production: {},
        staging: {
          extends: "production",
        },
      },
    };

    try {
      await seedScope(dbConnection, productionScope);
      await seedScope(dbConnection, stagingScope);

      await store.sync(productionScope, {
        rawConfigSnapshot: {
          ...baseRawConfigSnapshot,
          environment: "production",
        },
        resolvedSchema: {},
        schemaHash: "hash-production",
      });

      const firstTopologyRow =
        await dbConnection.db.query.projectEnvironmentTopologySnapshots.findFirst(
          {
            where: eq(projectEnvironmentTopologySnapshots.project, project),
          },
        );
      assert.ok(firstTopologyRow);

      await store.sync(stagingScope, {
        rawConfigSnapshot: {
          ...baseRawConfigSnapshot,
          environment: "staging",
        },
        resolvedSchema: {},
        schemaHash: "hash-staging",
      });

      const secondTopologyRow =
        await dbConnection.db.query.projectEnvironmentTopologySnapshots.findFirst(
          {
            where: eq(projectEnvironmentTopologySnapshots.project, project),
          },
        );
      assert.ok(secondTopologyRow);
      assert.equal(
        firstTopologyRow.configSnapshotHash,
        secondTopologyRow.configSnapshotHash,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API rejects removing a type that still has active documents",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);
      const initialPayload = createSyncPayload({
        project: scope.project,
        schemaHash: "hash-1",
        resolvedSchema: {
          Post: createRegistryType({
            type: "Post",
            directory: "content/posts",
            fields: {
              title: createField({ kind: "string" }),
            },
          }),
        },
      });

      const initialResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(initialPayload),
        }),
      );
      assert.equal(initialResponse.status, 200);

      await insertDocument(dbConnection, scopeIds, {
        type: "Post",
        locale: "en",
        path: "blog/hello-world",
      });

      const incompatibleResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-2",
              resolvedSchema: {},
            }),
          ),
        }),
      );
      const incompatibleBody = (await incompatibleResponse.json()) as {
        code: string;
        details?: Record<string, unknown>;
      };

      assert.equal(incompatibleResponse.status, 409);
      assert.equal(incompatibleBody.code, "SCHEMA_INCOMPATIBLE");
      assert.equal(incompatibleBody.details?.type, "Post");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API rejects newly required fields for types that already have documents",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);

      const initialResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-1",
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  fields: {
                    title: createField({ kind: "string" }),
                    summary: createField({
                      kind: "string",
                      required: false,
                    }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      assert.equal(initialResponse.status, 200);

      await insertDocument(dbConnection, scopeIds, {
        type: "Post",
        locale: "en",
        path: "blog/required-field",
      });

      const incompatibleResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-2",
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  fields: {
                    title: createField({ kind: "string" }),
                    summary: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      const incompatibleBody = (await incompatibleResponse.json()) as {
        code: string;
        details?: Record<string, unknown>;
      };

      assert.equal(incompatibleResponse.status, 409);
      assert.equal(incompatibleBody.code, "SCHEMA_INCOMPATIBLE");
      assert.equal(incompatibleBody.details?.fieldPath, "summary");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API rejects supported-locale removals when documents still exist in that locale",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);

      const initialResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-1",
              supportedLocales: ["en", "fr"],
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  localized: true,
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      assert.equal(initialResponse.status, 200);

      await insertDocument(dbConnection, scopeIds, {
        type: "Post",
        locale: "fr",
        path: "blog/bonjour",
      });

      const incompatibleResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-2",
              supportedLocales: ["en"],
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  localized: true,
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      const incompatibleBody = (await incompatibleResponse.json()) as {
        code: string;
        details?: Record<string, unknown>;
      };

      assert.equal(incompatibleResponse.status, 409);
      assert.equal(incompatibleBody.code, "SCHEMA_INCOMPATIBLE");
      assert.equal(incompatibleBody.details?.locale, "fr");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API allows implicit default-locale documents in mixed localized projects",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);

      const initialResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-1",
              supportedLocales: ["en", "fr"],
              resolvedSchema: {
                Page: createRegistryType({
                  type: "Page",
                  directory: "content/pages",
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  localized: true,
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      assert.equal(initialResponse.status, 200);

      await insertDocument(dbConnection, scopeIds, {
        type: "Page",
        locale: "__mdcms_default__",
        path: "pages/about",
      });

      const syncResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-2",
              supportedLocales: ["en", "fr"],
              resolvedSchema: {
                Page: createRegistryType({
                  type: "Page",
                  directory: "content/pages",
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  localized: true,
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );

      assert.equal(syncResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API rejects removing a type when only soft-deleted documents remain",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      const scopeIds = await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);

      const initialResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-1",
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      assert.equal(initialResponse.status, 200);

      await insertDocument(dbConnection, scopeIds, {
        type: "Post",
        locale: "en",
        path: "blog/deleted",
        isDeleted: true,
      });

      const incompatibleResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: scope.project,
              schemaHash: "hash-2",
              resolvedSchema: {},
            }),
          ),
        }),
      );
      const incompatibleBody = (await incompatibleResponse.json()) as {
        code: string;
      };

      assert.equal(incompatibleResponse.status, 409);
      assert.equal(incompatibleBody.code, "SCHEMA_INCOMPATIBLE");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "getCurrentSync returns undefined when no sync exists for scope",
  async () => {
    const { dbConnection } = createHandler();
    const store = createDatabaseSchemaStore({
      db: dbConnection.db,
      now: () => fixedNow,
    });
    const scope = createScope();

    try {
      const result = await store.getCurrentSync(scope);
      assert.equal(result, undefined);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "getCurrentSync returns schemaHash and syncedAt after sync",
  async () => {
    const { dbConnection } = createHandler();
    const store = createDatabaseSchemaStore({
      db: dbConnection.db,
      now: () => fixedNow,
    });
    const scope = createScope();

    try {
      await seedScope(dbConnection, scope);
      const payload = createSyncPayload({
        project: scope.project,
        schemaHash:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        resolvedSchema: {
          Post: createRegistryType({
            type: "Post",
            directory: "content/posts",
            fields: {
              title: createField({ kind: "string" }),
            },
          }),
        },
      });
      await store.sync(
        scope,
        payload as unknown as Parameters<typeof store.sync>[1],
      );

      const result = await store.getCurrentSync(scope);
      assert.ok(result);
      assert.match(result!.schemaHash, /^[a-f0-9]{64}$/);
      assert.equal(result!.syncedAt, fixedNow.toISOString());
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "GET /api/v1/schema returns types, schemaHash, syncedAt",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);
      const payload = createSyncPayload({
        project: scope.project,
        schemaHash:
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        resolvedSchema: {
          Post: createRegistryType({
            type: "Post",
            directory: "content/posts",
            fields: {
              title: createField({ kind: "string" }),
            },
          }),
        },
      });

      const putResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      assert.equal(putResponse.status, 200);

      const response = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: scopeHeaders,
        }),
      );
      const body = (await response.json()) as {
        data: {
          types: unknown[];
          schemaHash: string | null;
          syncedAt: string | null;
        };
      };

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body.data.types));
      assert.match(body.data.schemaHash ?? "", /^[a-f0-9]{64}$/);
      assert.match(body.data.syncedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "GET /api/v1/schema returns null hash for never-synced scope",
  async () => {
    const { handler, dbConnection } = createHandler();
    const scope = createScope();

    try {
      await seedScope(dbConnection, scope);
      const scopeHeaders = toScopeHeaders(scope);

      const response = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: scopeHeaders,
        }),
      );
      const body = (await response.json()) as {
        data: {
          types: unknown[];
          schemaHash: string | null;
          syncedAt: string | null;
        };
      };

      assert.equal(response.status, 200);
      assert.deepEqual(body.data.types, []);
      assert.equal(body.data.schemaHash, null);
      assert.equal(body.data.syncedAt, null);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "schema API keeps registry state isolated across projects",
  async () => {
    const { handler, dbConnection } = createHandler();
    const marketingScope = createScope();
    const docsScope = createScope();

    try {
      await seedScope(dbConnection, marketingScope);
      await seedScope(dbConnection, docsScope);

      const marketingHeaders = toScopeHeaders(marketingScope);
      const docsHeaders = toScopeHeaders(docsScope);

      const syncResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...marketingHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSyncPayload({
              project: marketingScope.project,
              schemaHash: "hash-marketing",
              resolvedSchema: {
                Post: createRegistryType({
                  type: "Post",
                  directory: "content/posts",
                  fields: {
                    title: createField({ kind: "string" }),
                  },
                }),
              },
            }),
          ),
        }),
      );
      assert.equal(syncResponse.status, 200);

      const foreignListResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: docsHeaders,
        }),
      );
      const foreignListBody = (await foreignListResponse.json()) as {
        data: {
          types: unknown[];
          schemaHash: string | null;
          syncedAt: string | null;
        };
      };
      assert.equal(foreignListResponse.status, 200);
      assert.deepEqual(foreignListBody.data.types, []);

      const foreignGetResponse = await handler(
        new Request("http://localhost/api/v1/schema/Post", {
          headers: docsHeaders,
        }),
      );
      const foreignGetBody = (await foreignGetResponse.json()) as {
        code: string;
      };
      assert.equal(foreignGetResponse.status, 404);
      assert.equal(foreignGetBody.code, "NOT_FOUND");
    } finally {
      await dbConnection.close();
    }
  },
);
