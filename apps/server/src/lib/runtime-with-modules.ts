import {
  createServerRequestHandler,
  type CreateServerRequestHandlerOptions,
  type ServerRequestHandler,
} from "./server.js";
import {
  createConsoleLogger,
  readSupportedLocales,
  resolveRequestTargetRouting,
  RuntimeError,
  type Logger,
} from "@mdcms/shared";
import { and, eq, inArray } from "drizzle-orm";
import { parseServerEnv } from "./env.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db.js";
import { createContentDAL } from "./dal/index.js";
import type { ContentDAL } from "./dal/types.js";
import {
  createDatabaseContentStore,
  mountContentApiRoutes,
} from "./content-api.js";
import {
  createDatabaseSchemaStore,
  mountSchemaApiRoutes,
} from "./schema-api.js";
import {
  createAuthService,
  mountAuthRoutes,
  resolveStartupOidcProviders,
} from "./auth.js";
import { createEmailService } from "./email.js";
import { mountCollaborationRoutes } from "./collaboration-auth.js";
import {
  createDatabaseEnvironmentStore,
  mountEnvironmentApiRoutes,
} from "./environments-api.js";
import {
  createDatabaseProjectStore,
  mountProjectApiRoutes,
} from "./projects-api.js";
import type { ParsedMdcmsConfig } from "@mdcms/shared";
import {
  createRefreshingStudioRuntimePublicationSelection,
  createStudioRuntimePublication,
  type CreateStudioRuntimePublicationOptions,
} from "./studio-bootstrap.js";
import { authUsers, schemaRegistryEntries, schemaSyncs } from "./db/schema.js";
import { resolveProjectEnvironmentScope } from "./project-provisioning.js";

import {
  collectServerModuleActions,
  loadServerModules,
  mountLoadedServerModules,
  type ServerModuleAppDeps,
  type ServerModuleLoadReport,
} from "./module-loader.js";
import {
  createAiOrchestratorFromEnv,
  createInMemoryAiProposalStore,
  createSchemaAwareProposalValidator,
  type CoreAiServerDeps,
} from "@mdcms/modules";

export type CreateServerRequestHandlerWithModulesOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  config?: ParsedMdcmsConfig;
  configPath?: string;
  cwd?: string;
  moduleDeps?: ServerModuleAppDeps;
  moduleLoadReport?: ServerModuleLoadReport;
  serverOptions?: Omit<
    CreateServerRequestHandlerOptions,
    "env" | "logger" | "actions" | "configureApp"
  >;
};

export type PrepareServerRequestHandlerWithModulesOptions =
  CreateServerRequestHandlerWithModulesOptions & {
    studioRuntimeOptions?: CreateStudioRuntimePublicationOptions;
  };

export type ServerRequestHandlerWithModulesResult = {
  handler: ServerRequestHandler;
  moduleLoadReport: ServerModuleLoadReport;
  dbConnection: DatabaseConnection;
  dal: ContentDAL;
};

/**
 * createServerRequestHandlerWithModules composes the server runtime with
 * compile-time local module loading from @mdcms/modules.
 */
export function createServerRequestHandlerWithModules(
  options: CreateServerRequestHandlerWithModulesOptions = {},
): ServerRequestHandlerWithModulesResult {
  const rawEnv = options.env ?? process.env;
  const env = parseServerEnv(rawEnv);
  const logger =
    options.logger ??
    createConsoleLogger({
      level: env.LOG_LEVEL,
      context: {
        runtime: "server",
        service: env.SERVICE_NAME,
      },
    });
  const moduleLoadReport =
    options.moduleLoadReport ??
    loadServerModules({
      coreVersion: env.APP_VERSION,
      logger,
    });

  const dbConnection = createDatabaseConnection({ env: rawEnv });
  const dal = createContentDAL({ db: dbConnection.db });
  const emailService = env.SMTP_HOST ? createEmailService(env) : undefined;
  const authService = createAuthService({
    db: dbConnection.db,
    env: rawEnv,
    emailService,
  });
  const contentStore = createDatabaseContentStore({ db: dbConnection.db });
  const schemaStore = createDatabaseSchemaStore({ db: dbConnection.db });
  const environmentStore = createDatabaseEnvironmentStore({
    db: dbConnection.db,
  });
  const projectStore = createDatabaseProjectStore({ db: dbConnection.db });
  const actions = collectServerModuleActions(moduleLoadReport);

  const lookupSchemaHashForScope = async (scope: {
    project: string;
    environment: string;
  }): Promise<string | undefined> => {
    const resolvedScope = await resolveProjectEnvironmentScope(
      dbConnection.db,
      { project: scope.project, environment: scope.environment },
    );

    if (!resolvedScope) {
      return undefined;
    }

    const row = await dbConnection.db.query.schemaSyncs.findFirst({
      where: and(
        eq(schemaSyncs.projectId, resolvedScope.project.id),
        eq(schemaSyncs.environmentId, resolvedScope.environment.id),
      ),
    });

    return row?.schemaHash;
  };

  const aiPathExists = async ({
    project,
    environment,
    path,
  }: {
    project: string;
    environment: string;
    path: string;
  }) => {
    const list = await contentStore.list(
      { project, environment },
      { path, limit: "1", draft: "true" },
    );
    return list.rows.length > 0 && list.rows[0]?.isDeleted === false;
  };

  const aiDocumentExists = async ({
    project,
    environment,
    documentId,
  }: {
    project: string;
    environment: string;
    documentId: string;
  }) => {
    const doc = await contentStore.getById(
      { project, environment },
      documentId,
      { draft: true },
    );
    return doc !== undefined && !doc.isDeleted;
  };

  // Schema-aware proposal validator. The AI orchestrator's chat tools
  // and the inline-transform task path both run validator checks on
  // every proposal at build time; this is the place where we hand it
  // the project's actual schema registry so it can catch missing
  // required frontmatter, unknown fields, and bad type ids. Without
  // this, all proposals default to `{ status: "valid" }`.
  const aiProposalValidator = createSchemaAwareProposalValidator({
    schemaLookup: async ({ project, environment, type }) => {
      const resolvedScope = await resolveProjectEnvironmentScope(
        dbConnection.db,
        { project, environment },
      );
      if (!resolvedScope) return undefined;
      const row = await dbConnection.db.query.schemaRegistryEntries.findFirst({
        where: and(
          eq(schemaRegistryEntries.projectId, resolvedScope.project.id),
          eq(schemaRegistryEntries.environmentId, resolvedScope.environment.id),
          eq(schemaRegistryEntries.schemaType, type),
        ),
      });
      // The `resolvedSchema` column is stored as JSON in the DB; the
      // shape matches `SchemaRegistryTypeSnapshot` from @mdcms/shared.
      // We cast rather than re-validate at every chat turn — the value
      // was validated at schema-sync time.
      return row?.resolvedSchema as
        | import("@mdcms/shared").SchemaRegistryTypeSnapshot
        | undefined;
    },
    pathExists: aiPathExists,
    documentExists: aiDocumentExists,
  });

  const aiOrchestrator = createAiOrchestratorFromEnv({
    env: rawEnv as Record<string, string | undefined>,
    proposalValidator: aiProposalValidator,
  });
  const aiProposalStore = createInMemoryAiProposalStore();

  const contentTypesLookup = async ({
    project,
    environment,
  }: {
    project: string;
    environment: string;
  }) => {
    const resolvedScope = await resolveProjectEnvironmentScope(
      dbConnection.db,
      { project, environment },
    );
    if (!resolvedScope) return [];
    const rows = await dbConnection.db.query.schemaRegistryEntries.findMany({
      where: and(
        eq(schemaRegistryEntries.projectId, resolvedScope.project.id),
        eq(schemaRegistryEntries.environmentId, resolvedScope.environment.id),
      ),
    });
    return rows.map(
      (r) =>
        r.resolvedSchema as import("@mdcms/shared").SchemaRegistryTypeSnapshot,
    );
  };

  const supportedLocalesLookup = async ({
    project,
    environment,
  }: {
    project: string;
    environment: string;
  }) => {
    const resolvedScope = await resolveProjectEnvironmentScope(
      dbConnection.db,
      { project, environment },
    );
    if (!resolvedScope) return [];
    const row = await dbConnection.db.query.schemaSyncs.findFirst({
      where: and(
        eq(schemaSyncs.projectId, resolvedScope.project.id),
        eq(schemaSyncs.environmentId, resolvedScope.environment.id),
      ),
    });
    if (!row?.rawConfigSnapshot) return [];
    const locales = readSupportedLocales(row.rawConfigSnapshot);
    return locales ? Array.from(locales).sort() : [];
  };

  const userLookup = async ({ userId }: { userId: string }) => {
    const row = await dbConnection.db.query.authUsers.findFirst({
      where: eq(authUsers.id, userId),
      columns: { id: true, name: true, email: true },
    });
    return row
      ? { id: row.id, displayName: row.name || row.email }
      : { id: userId, displayName: userId };
  };

  const listEntries = async ({
    project,
    environment,
    type,
    query,
    locale,
    limit,
  }: {
    project: string;
    environment: string;
    type: string;
    query?: string;
    locale?: string;
    limit?: number;
  }) => {
    const listResponse = await contentStore.list(
      { project, environment },
      {
        type,
        ...(query ? { q: query } : {}),
        ...(locale ? { locale } : {}),
        limit: String(limit ?? 10),
        draft: "true",
      },
    );
    return {
      matches: listResponse.rows.map((row) => ({
        documentId: row.documentId,
        path: row.path,
        type: row.type,
        locale: row.locale,
        ...(typeof row.frontmatter.title === "string"
          ? { title: row.frontmatter.title }
          : {}),
        ...(typeof row.frontmatter.excerpt === "string"
          ? { summary: row.frontmatter.excerpt.slice(0, 200) }
          : {}),
        updatedAt: row.updatedAt,
        hasUnpublishedChanges: row.hasUnpublishedChanges,
      })),
      total: listResponse.total,
    };
  };

  const getEntryBackend = async ({
    project,
    environment,
    documentId,
  }: {
    project: string;
    environment: string;
    documentId: string;
  }) => {
    const doc = await contentStore.getById(
      { project, environment },
      documentId,
      { draft: true },
    );
    if (!doc || doc.isDeleted) return undefined;
    return {
      documentId: doc.documentId,
      path: doc.path,
      type: doc.type,
      locale: doc.locale,
      draftRevision: doc.draftRevision,
      hasUnpublishedChanges: doc.hasUnpublishedChanges,
      publishedVersion: doc.publishedVersion,
      frontmatter: doc.frontmatter,
      body: doc.body,
    };
  };

  const aiModuleDeps: CoreAiServerDeps = {
    orchestrator: aiOrchestrator,
    proposalStore: aiProposalStore,
    contentStore: {
      getById: (scope, documentId, opts) =>
        contentStore.getById(scope, documentId, opts),
      update: (scope, documentId, payload, opts) =>
        contentStore.update(scope, documentId, payload, opts),
      create: (scope, payload, opts) =>
        contentStore.create(scope, payload, opts),
      softDelete: (scope, documentId) =>
        contentStore.softDelete(scope, documentId),
      restore: (scope, documentId) => contentStore.restore(scope, documentId),
    },
    contextResolver: {
      loadDraftContext: async ({
        request,
        project,
        environment,
        documentId,
      }) => {
        await authService.authorizeRequest(request, {
          requiredScope: "content:read:draft",
          project,
          environment,
        });
        const document = await contentStore.getById(
          { project, environment },
          documentId,
          { draft: true },
        );

        if (!document || document.isDeleted) {
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
            details: { documentId },
          });
        }

        await authService.authorizeRequest(request, {
          requiredScope: "content:read:draft",
          project,
          environment,
          documentPath: document.path,
        });

        return { document };
      },
    },
    schemaHashLookup: ({ project, environment }) =>
      lookupSchemaHashForScope({ project, environment }),
    authorize: async (request, requirement) => {
      const authorized = await authService.authorizeRequest(
        request,
        requirement,
      );
      const actorId =
        authorized.principal.type === "session"
          ? authorized.principal.session.userId
          : authorized.principal.keyId;
      return { actorId };
    },
    requireCsrf: (request) => authService.requireCsrfProtection(request),
    emitAudit: (record) => {
      const isFailure =
        record.outcome === "apply_failed" ||
        record.outcome === "validation_failed" ||
        record.outcome === "invalid_output" ||
        record.outcome === "provider_error";
      const payload = {
        outcome: record.outcome,
        taskKind: record.taskKind,
        provider: record.providerId,
        model: record.model,
        proposalIds: record.proposalIds,
        actorId: record.actorId,
        project: record.project,
        environment: record.environment,
        documentId: record.documentId,
        errorCode: record.errorCode,
        ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
      };
      // Lift failure audits to `error` level so they surface alongside
      // request_failed logs — otherwise an apply that 500s leaves no
      // breadcrumb at the default log level.
      if (isFailure) {
        logger.error("ai.audit", payload);
      } else {
        logger.info("ai.audit", payload);
      }
    },
    contentTypesLookup,
    supportedLocalesLookup,
    userLookup,
    listEntries,
    getEntry: getEntryBackend,
  };

  const moduleDeps: ServerModuleAppDeps = {
    ...(options.moduleDeps ?? {}),
    dal,
    ai: aiModuleDeps,
  };

  const handler = createServerRequestHandler({
    ...(options.serverOptions ?? {}),
    env: rawEnv,
    logger,
    actions,
    configureApp: (app) => {
      mountAuthRoutes(app, { authService });
      mountContentApiRoutes(app, {
        store: contentStore,
        authorize: (request, requirement) =>
          authService.authorizeRequest(request, requirement),
        requireCsrf: (request) => authService.requireCsrfProtection(request),
        getWriteSchemaSyncState: async (scope) => {
          const schemaHash = await lookupSchemaHashForScope(scope);

          return schemaHash ? { schemaHash } : undefined;
        },
        resolveUsers: async (userIds) => {
          if (userIds.length === 0) return {};
          const rows = await dbConnection.db
            .select({
              id: authUsers.id,
              name: authUsers.name,
              email: authUsers.email,
            })
            .from(authUsers)
            .where(inArray(authUsers.id, userIds));
          const map: Record<string, { name: string; email: string }> = {};
          for (const row of rows) {
            map[row.id] = { name: row.name, email: row.email };
          }
          return map;
        },
      });
      mountSchemaApiRoutes(app, {
        store: schemaStore,
        authorize: (request, requirement) =>
          authService.authorizeRequest(request, requirement),
        requireCsrf: (request) => authService.requireCsrfProtection(request),
      });
      mountEnvironmentApiRoutes(app, {
        store: environmentStore,
        authorizeSession: async (request) => {
          const session = await authService.getSession(request);
          if (!session) {
            throw new RuntimeError({
              code: "UNAUTHORIZED",
              message: "Authentication required.",
              statusCode: 401,
            });
          }
          return session;
        },
        authorizeAdmin: (request) => authService.requireAdminSession(request),
        authorizeScoped: async (request, requiredScope) => {
          const routing = resolveRequestTargetRouting(request);
          await authService.authorizeRequest(request, {
            requiredScope,
            project: routing.project,
            environment: routing.environment,
          });
        },
        requireCsrf: (request) => authService.requireCsrfProtection(request),
      });
      mountProjectApiRoutes(app, {
        store: projectStore,
        authorizeRead: (request) => {
          const routing = resolveRequestTargetRouting(request);
          return authService
            .authorizeRequest(request, {
              requiredScope: "projects:read",
              project: routing.project,
              environment: routing.environment,
            })
            .then(() => undefined);
        },
        authorizeWrite: (request) => {
          const routing = resolveRequestTargetRouting(request);
          return authService
            .authorizeRequest(request, {
              requiredScope: "projects:write",
              project: routing.project,
              environment: routing.environment,
            })
            .then(() => undefined);
        },
      });
      mountCollaborationRoutes(app, {
        authService,
        env: rawEnv,
        resolveDocument: async ({ project, environment, documentId }) => {
          const document = await contentStore.getById(
            { project, environment },
            documentId,
            { draft: true },
          );

          if (!document || document.isDeleted) {
            return undefined;
          }

          return {
            path: document.path,
          };
        },
      });
      mountLoadedServerModules(app, moduleDeps, moduleLoadReport);
    },
  });

  return {
    handler,
    moduleLoadReport,
    dbConnection,
    dal,
  };
}

/**
 * prepareServerRequestHandlerWithModules builds the startup-owned Studio
 * runtime publication once, then composes it into the shared server handler.
 */
export async function prepareServerRequestHandlerWithModules(
  options: PrepareServerRequestHandlerWithModulesOptions = {},
): Promise<ServerRequestHandlerWithModulesResult> {
  const rawEnv = options.env ?? process.env;
  const env = parseServerEnv(rawEnv);
  const resolvedOidcProviders = await resolveStartupOidcProviders(
    env.MDCMS_AUTH_OIDC_PROVIDERS,
  );
  const resolvedEnv: NodeJS.ProcessEnv = {
    ...rawEnv,
    MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify(resolvedOidcProviders),
  };
  const logger =
    options.logger ??
    createConsoleLogger({
      level: env.LOG_LEVEL,
      context: {
        runtime: "server",
        service: env.SERVICE_NAME,
      },
    });
  const moduleLoadReport =
    options.moduleLoadReport ??
    loadServerModules({
      coreVersion: env.APP_VERSION,
      logger,
    });
  const studioRuntimePublication =
    options.serverOptions?.studioRuntimePublication ??
    (env.NODE_ENV === "development"
      ? await createRefreshingStudioRuntimePublicationSelection({
          ...options.studioRuntimeOptions,
          studioVersion:
            options.studioRuntimeOptions?.studioVersion ??
            (rawEnv.APP_VERSION?.trim() || "0.0.0"),
        })
      : ({
          active: await createStudioRuntimePublication({
            ...options.studioRuntimeOptions,
            studioVersion:
              options.studioRuntimeOptions?.studioVersion ??
              (rawEnv.APP_VERSION?.trim() || "0.0.0"),
          }),
        } as const));

  return createServerRequestHandlerWithModules({
    ...options,
    env: resolvedEnv,
    logger,
    moduleLoadReport,
    serverOptions: {
      ...(options.serverOptions ?? {}),
      studioRuntimePublication,
    },
  });
}
