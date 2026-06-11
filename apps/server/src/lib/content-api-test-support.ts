import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";

import { createConsoleLogger } from "@mdcms/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import type {
  ContentMediaAssetLookup,
  ContentWritePayload,
  MountContentApiRoutesOptions,
} from "./content-api/types.js";
import type { DrizzleDatabase } from "./db.js";
import {
  documentVersions,
  documents,
  rbacGrants,
  schemaRegistryEntries,
  schemaSyncs,
  webhookDeliveryAttempts,
  webhooks,
} from "./db/schema.js";
import { createServerRequestHandler } from "./server.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";
import {
  createInMemoryContentStore,
  mountContentApiRoutes,
} from "./content-api.js";
import type { AuthorizedRequest } from "./auth.js";
import { CONTENT_SCHEMA_HASH_HEADER } from "./content-api/schema-hash.js";
import { resolveProjectEnvironmentScope } from "./project-provisioning.js";

export const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

export const dbEnv = {
  ...baseEnv,
  DATABASE_URL: "postgres://mdcms:mdcms@localhost:5432/mdcms",
} as NodeJS.ProcessEnv;

export const logger = createConsoleLogger({
  level: "error",
  sink: () => undefined,
});

function stableLabelText(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fixture"
  );
}

function stableLabelDigest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

export function stableFixtureName(label: string): string {
  const digest = stableLabelDigest(label);

  return `${stableLabelText(label)}-${digest.slice(0, 8)}`;
}

export function stableFixturePath(directory: string, label: string): string {
  return `${directory}/${stableFixtureName(label)}`;
}

export function stableFixtureUuid(label: string): string {
  const digest = stableLabelDigest(label);
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8)
    .toString(16)
    .slice(0, 1);

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

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
export const testWithDatabase = dbAvailable ? test : test.skip;

export const scopeHeaders = {
  "x-mdcms-project": "_test-marketing-site",
  "x-mdcms-environment": "production",
};

export const authorizedTestRequest = {
  mode: "session",
  principal: {
    type: "session",
    session: {
      id: "session-1",
      userId: "user-1",
      email: "editor@example.com",
      issuedAt: "2026-06-03T00:00:00.000Z",
      expiresAt: "2026-06-03T01:00:00.000Z",
    },
  },
} satisfies AuthorizedRequest;

export async function authorizeTestRequest(): Promise<AuthorizedRequest> {
  return authorizedTestRequest;
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

export function createCsrfHeaders(
  session: {
    cookie: string;
    setCookie: string;
  },
  headers: Record<string, string> = {},
): Record<string, string> {
  const csrfToken = extractCookieValue(session.setCookie, "mdcms_csrf");
  assert.ok(csrfToken);

  return {
    cookie: session.cookie,
    "x-mdcms-csrf-token": csrfToken,
    ...headers,
  };
}

export const inMemorySchemaHash = "cms29-in-memory-schema-hash";

async function isContentWriteRoute(request: Request): Promise<boolean> {
  const url = new URL(request.url);

  if (
    (request.method === "POST" && url.pathname === "/api/v1/content") ||
    (request.method === "PUT" &&
      /^\/api\/v1\/content\/[^/]+$/.test(url.pathname))
  ) {
    return true;
  }

  if (request.method !== "POST" || url.pathname !== "/api/v1/content/bulk") {
    return false;
  }

  try {
    const body = (await request.clone().json()) as { action?: unknown };
    return body.action === "move";
  } catch {
    return false;
  }
}

async function withSchemaHashHeader(
  request: Request,
  schemaHash: string,
): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.set(CONTENT_SCHEMA_HASH_HEADER, schemaHash);
  const bodyText = await request.clone().text();

  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyText.length > 0 ? bodyText : undefined,
  });
}

function wrapHandlerWithAutoSchemaHash(
  rawHandler: ReturnType<typeof createServerRequestHandler>,
  resolveSchemaHash: (
    request: Request,
  ) => Promise<string | undefined> | string | undefined,
): ReturnType<typeof createServerRequestHandler> {
  return async (request: Request): Promise<Response> => {
    if (
      !(await isContentWriteRoute(request)) ||
      request.headers.has(CONTENT_SCHEMA_HASH_HEADER)
    ) {
      return rawHandler(request);
    }

    const schemaHash = await resolveSchemaHash(request);

    if (!schemaHash) {
      return rawHandler(request);
    }

    return rawHandler(await withSchemaHashHeader(request, schemaHash));
  };
}

export { wrapHandlerWithAutoSchemaHash };

export function createHandler(
  options: {
    lookupMediaAsset?: ContentMediaAssetLookup;
    activeCollaboration?: MountContentApiRoutesOptions["activeCollaboration"];
  } = {},
) {
  const store = createInMemoryContentStore({
    lookupMediaAsset: options.lookupMediaAsset,
    schemaScopes: [
      {
        project: scopeHeaders["x-mdcms-project"],
        environment: scopeHeaders["x-mdcms-environment"],
        schemas: createCms26ResolvedSchemas(),
      },
    ],
  });
  const rawHandler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: authorizeTestRequest,
        requireCsrf: async () => undefined,
        getWriteSchemaSyncState: async () => ({
          schemaHash: inMemorySchemaHash,
        }),
        lookupMediaAsset: options.lookupMediaAsset,
        activeCollaboration: options.activeCollaboration,
      });
    },
    now: () => new Date("2026-03-02T10:00:00.000Z"),
  });

  return wrapHandlerWithAutoSchemaHash(rawHandler, () => inMemorySchemaHash);
}

export type TestServerHandlerFactory = (
  options?: Parameters<typeof createServerRequestHandlerWithModules>[0],
) => {
  handler: ReturnType<typeof createServerRequestHandler>;
  dbConnection: {
    db: DrizzleDatabase;
    close: () => Promise<void>;
  };
};

export type DatabaseTestContextOptions = {
  autoSchemaHashHeaders?: boolean;
  autoSeedWriteSchemas?: boolean;
};

export async function resetDatabaseTestScope(
  db: DrizzleDatabase,
  scope: { project: string; environment: string },
) {
  const resolvedScope = await resolveProjectEnvironmentScope(db, {
    project: scope.project,
    environment: scope.environment,
    createIfMissing: false,
  });

  if (!resolvedScope) {
    return;
  }

  await db
    .delete(webhookDeliveryAttempts)
    .where(
      and(
        eq(webhookDeliveryAttempts.projectId, resolvedScope.project.id),
        eq(webhookDeliveryAttempts.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .delete(webhooks)
    .where(
      and(
        eq(webhooks.projectId, resolvedScope.project.id),
        eq(webhooks.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .update(documents)
    .set({ publishedVersion: null })
    .where(
      and(
        eq(documents.projectId, resolvedScope.project.id),
        eq(documents.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .delete(documentVersions)
    .where(
      and(
        eq(documentVersions.projectId, resolvedScope.project.id),
        eq(documentVersions.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .delete(documents)
    .where(
      and(
        eq(documents.projectId, resolvedScope.project.id),
        eq(documents.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .delete(schemaRegistryEntries)
    .where(
      and(
        eq(schemaRegistryEntries.projectId, resolvedScope.project.id),
        eq(schemaRegistryEntries.environmentId, resolvedScope.environment.id),
      ),
    );

  await db
    .delete(schemaSyncs)
    .where(
      and(
        eq(schemaSyncs.projectId, resolvedScope.project.id),
        eq(schemaSyncs.environmentId, resolvedScope.environment.id),
      ),
    );
}

const defaultWriteSchemaSeedEntries = [
  {
    type: "Author",
    directory: "content/authors",
    localized: true,
  },
  {
    type: "BlogPost",
    directory: "content/blog",
    localized: true,
  },
  {
    type: "Page",
    directory: "content/pages",
    localized: true,
  },
] as const;

export async function createDatabaseTestContext(
  source: string,
  createHandlerWithModules: TestServerHandlerFactory = createServerRequestHandlerWithModules,
  contextOptions: DatabaseTestContextOptions = {},
) {
  const preparedScopes = new Set<string>();
  const { handler: baseHandler, dbConnection } = createHandlerWithModules({
    env: dbEnv,
    logger,
  });
  const prepareScope = async (scope: {
    project: string;
    environment: string;
  }) => {
    const scopeKey = `${scope.project}:${scope.environment}`;

    if (preparedScopes.has(scopeKey)) {
      return;
    }

    const resolvedScope = await resolveProjectEnvironmentScope(
      dbConnection.db,
      {
        project: scope.project,
        environment: scope.environment,
        createIfMissing: false,
      },
    );

    if (resolvedScope) {
      const existingDocument = await dbConnection.db.query.documents.findFirst({
        where: and(
          eq(documents.projectId, resolvedScope.project.id),
          eq(documents.environmentId, resolvedScope.environment.id),
        ),
      });

      if (existingDocument) {
        await resetDatabaseTestScope(dbConnection.db, scope);
      }
    }

    preparedScopes.add(scopeKey);
  };
  const handler =
    contextOptions.autoSchemaHashHeaders === false
      ? baseHandler
      : wrapHandlerWithAutoSchemaHash(baseHandler, async (request) => {
          // Most legacy write tests are asserting lifecycle and scope behavior,
          // not the CMS-29 transport contract. Dedicated schema-hash tests opt
          // out of this helper and assert the public header behavior directly.
          const project = request.headers.get("x-mdcms-project")?.trim();
          const environment = request.headers
            .get("x-mdcms-environment")
            ?.trim();

          if (!project || !environment) {
            return undefined;
          }

          const scope = { project, environment };
          await prepareScope(scope);

          const resolvedScope = await resolveProjectEnvironmentScope(
            dbConnection.db,
            {
              project,
              environment,
              createIfMissing: false,
            },
          );
          let schemaHash = resolvedScope
            ? (
                await dbConnection.db.query.schemaSyncs.findFirst({
                  where: and(
                    eq(schemaSyncs.projectId, resolvedScope.project.id),
                    eq(schemaSyncs.environmentId, resolvedScope.environment.id),
                  ),
                })
              )?.schemaHash
            : undefined;

          if (!schemaHash && contextOptions.autoSeedWriteSchemas !== false) {
            schemaHash = (
              await seedSchemaRegistryScope(dbConnection.db, {
                scope,
                supportedLocales: ["en", "fr", "de"],
                entries: defaultWriteSchemaSeedEntries.map((entry) => ({
                  ...entry,
                })),
              })
            ).schemaHash;
          }

          return schemaHash;
        });
  const email = `content-${stableFixtureName(source)}@mdcms.local`;
  const password = "Admin12345!";

  try {
    const signUpResponse = await handler(
      new Request("http://localhost/api/v1/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          name: "Content User",
        }),
      }),
    );
    assert.ok(
      signUpResponse.status === 200 || signUpResponse.status === 422,
      `unexpected sign-up status ${signUpResponse.status} for ${email}`,
    );

    const loginResponse = await handler(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      }),
    );
    const loginBody = (await loginResponse.json()) as {
      data: {
        session: {
          userId: string;
        };
      };
    };

    assert.equal(loginResponse.status, 200);

    const setCookie = loginResponse.headers.get("set-cookie");
    assert.ok(setCookie);
    const cookie = toCookieHeader(setCookie);

    await dbConnection.db
      .insert(rbacGrants)
      .values({
        userId: loginBody.data.session.userId,
        role: "owner",
        scopeKind: "global",
        source,
        createdByUserId: loginBody.data.session.userId,
      })
      .onConflictDoNothing();

    return {
      handler,
      dbConnection,
      cookie,
      setCookie,
      userId: loginBody.data.session.userId,
      prepareScope,
      csrfHeaders: (headers: Record<string, string> = {}) =>
        createCsrfHeaders({ cookie, setCookie }, headers),
    };
  } catch (error) {
    await dbConnection.close();
    throw error;
  }
}

export async function seedSchemaRegistryScope(
  db: DrizzleDatabase,
  input: {
    scope: { project: string; environment: string };
    schemaHash?: string;
    supportedLocales?: string[];
    entries: Array<{
      type: string;
      directory: string;
      localized: boolean;
      fields?: Record<string, unknown>;
    }>;
  },
) {
  const resolvedScope = await resolveProjectEnvironmentScope(db, {
    project: input.scope.project,
    environment: input.scope.environment,
    createIfMissing: true,
  });

  assert.ok(resolvedScope);

  const schemaHash =
    input.schemaHash ??
    `cms20-${stableFixtureName(
      JSON.stringify({
        scope: input.scope,
        supportedLocales: input.supportedLocales ?? null,
        entries: input.entries,
      }),
    )}`;
  const syncedAt = new Date();
  const rawConfigSnapshot = {
    project: input.scope.project,
    ...(input.supportedLocales
      ? {
          locales: {
            default: input.supportedLocales[0],
            supported: input.supportedLocales,
          },
        }
      : {}),
  };

  await db
    .insert(schemaSyncs)
    .values({
      projectId: resolvedScope.project.id,
      environmentId: resolvedScope.environment.id,
      schemaHash,
      rawConfigSnapshot,
      syncedAt,
    })
    .onConflictDoUpdate({
      target: [schemaSyncs.projectId, schemaSyncs.environmentId],
      set: {
        schemaHash,
        rawConfigSnapshot,
        syncedAt,
      },
    });

  for (const entry of input.entries) {
    const resolvedSchema = {
      type: entry.type,
      directory: entry.directory,
      localized: entry.localized,
      fields: entry.fields ?? {},
    };

    await db
      .insert(schemaRegistryEntries)
      .values({
        projectId: resolvedScope.project.id,
        environmentId: resolvedScope.environment.id,
        schemaType: entry.type,
        directory: entry.directory,
        localized: entry.localized,
        schemaHash,
        resolvedSchema,
        syncedAt,
      })
      .onConflictDoUpdate({
        target: [
          schemaRegistryEntries.projectId,
          schemaRegistryEntries.environmentId,
          schemaRegistryEntries.schemaType,
        ],
        set: {
          directory: entry.directory,
          localized: entry.localized,
          schemaHash,
          resolvedSchema,
          syncedAt,
        },
      });
  }

  return { schemaHash };
}

export const cms26BlogPostSchemaFields = {
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
  author: {
    kind: "string",
    required: false,
    nullable: true,
    reference: {
      targetType: "Author",
    },
  },
  hero: {
    kind: "object",
    required: false,
    nullable: true,
    fields: {
      author: {
        kind: "string",
        required: false,
        nullable: true,
        reference: {
          targetType: "Author",
        },
      },
    },
  },
  contributors: {
    kind: "array",
    required: false,
    nullable: false,
    default: [],
    item: {
      kind: "string",
      required: true,
      nullable: false,
      reference: {
        targetType: "Author",
      },
    },
  },
  slugline: {
    kind: "string",
    required: false,
    nullable: true,
  },
};

export const cms26AuthorSchemaFields = {
  name: {
    kind: "string",
    required: true,
    nullable: false,
  },
};

export const cms26PageSchemaFields = {
  slug: {
    kind: "string",
    required: true,
    nullable: false,
  },
};

export function createCms26ResolvedSchemas() {
  return {
    BlogPost: {
      type: "BlogPost",
      directory: "content/blog",
      localized: true,
      fields: cms26BlogPostSchemaFields,
    },
    Author: {
      type: "Author",
      directory: "content/authors",
      localized: true,
      fields: cms26AuthorSchemaFields,
    },
    Page: {
      type: "Page",
      directory: "content/pages",
      localized: true,
      fields: cms26PageSchemaFields,
    },
  };
}

export async function seedCms26ReferenceSchema(
  db: DrizzleDatabase,
  scope: { project: string; environment: string },
) {
  await resetDatabaseTestScope(db, scope);

  await seedSchemaRegistryScope(db, {
    scope,
    entries: [
      {
        type: "BlogPost",
        directory: "content/blog",
        localized: true,
        fields: cms26BlogPostSchemaFields,
      },
      {
        type: "Author",
        directory: "content/authors",
        localized: true,
        fields: cms26AuthorSchemaFields,
      },
      {
        type: "Page",
        directory: "content/pages",
        localized: true,
        fields: cms26PageSchemaFields,
      },
    ],
  });
}

export async function createContentDocument(
  handler: ReturnType<typeof createServerRequestHandler>,
  csrfHeaders: (headers?: Record<string, string>) => Record<string, string>,
  scopeHeaders: Record<string, string>,
  payload: ContentWritePayload,
) {
  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: csrfHeaders({
        ...scopeHeaders,
        "content-type": "application/json",
      }),
      body: JSON.stringify(payload),
    }),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Record<string, unknown> };
  return body.data;
}

export async function overwriteDraftFrontmatter(
  db: DrizzleDatabase,
  documentId: string,
  frontmatter: Record<string, unknown>,
) {
  await db
    .update(documents)
    .set({ frontmatter })
    .where(eq(documents.documentId, documentId));
}

export async function createCms26Author(
  handler: ReturnType<typeof createServerRequestHandler>,
  csrfHeaders: (headers?: Record<string, string>) => Record<string, string>,
  scopeHeaders: Record<string, string>,
  slug: string,
) {
  return createContentDocument(handler, csrfHeaders, scopeHeaders, {
    path: `authors/cms26-${stableFixtureName(slug)}`,
    type: "Author",
    locale: "en",
    format: "md",
    frontmatter: {
      slug,
      name: `${slug} author`,
    },
    body: `${slug} bio`,
  });
}

export async function createCms26BlogPost(
  handler: ReturnType<typeof createServerRequestHandler>,
  csrfHeaders: (headers?: Record<string, string>) => Record<string, string>,
  scopeHeaders: Record<string, string>,
  slug: string,
  frontmatter: Record<string, unknown>,
) {
  return createContentDocument(handler, csrfHeaders, scopeHeaders, {
    path: `blog/cms26-${stableFixtureName(slug)}`,
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: {
      slug,
      ...frontmatter,
    },
    body: `${slug} body`,
  });
}

export async function createCms28ReferenceWriteContext(source: string) {
  const context = await createDatabaseTestContext(source);
  const project = `cms28-${stableFixtureName(source)}`;
  const testScopeHeaders = {
    ...scopeHeaders,
    "x-mdcms-project": project,
    "x-mdcms-environment": "production",
  };
  const scope = {
    project,
    environment: testScopeHeaders["x-mdcms-environment"],
  };

  await context.prepareScope(scope);
  await seedCms26ReferenceSchema(context.dbConnection.db, scope);

  return {
    ...context,
    scope,
    testScopeHeaders,
  };
}

export function createCms28BlogPostPayload(
  frontmatter: Record<string, unknown>,
): ContentWritePayload {
  const label = JSON.stringify(frontmatter);

  return {
    path: `blog/cms28-${stableFixtureName(label)}`,
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: {
      slug: `cms28-${stableFixtureName(label)}`,
      ...frontmatter,
    },
    body: "cms28 body",
  };
}

export async function publishContentDocument(
  handler: ReturnType<typeof createServerRequestHandler>,
  csrfHeaders: (headers?: Record<string, string>) => Record<string, string>,
  scopeHeaders: Record<string, string>,
  documentId: string,
) {
  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}/publish`, {
      method: "POST",
      headers: csrfHeaders({
        ...scopeHeaders,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        change_summary: "cms26 publish",
      }),
    }),
  );

  assert.equal(response.status, 200);
  return (await response.json()) as {
    data: {
      version: number;
      publishedVersion: number | null;
    };
  };
}

export async function deleteContentDocument(
  handler: ReturnType<typeof createServerRequestHandler>,
  csrfHeaders: (headers?: Record<string, string>) => Record<string, string>,
  scopeHeaders: Record<string, string>,
  documentId: string,
) {
  const response = await handler(
    new Request(`http://localhost/api/v1/content/${documentId}`, {
      method: "DELETE",
      headers: csrfHeaders({
        ...scopeHeaders,
      }),
    }),
  );

  assert.equal(response.status, 200);
}
