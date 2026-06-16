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
import { parseServerEnv, type ServerEnv } from "./env.js";
import { createDatabaseConnection, type DatabaseConnection } from "./db.js";
import { createContentDAL } from "./dal/index.js";
import type { ContentDAL } from "./dal/types.js";
import {
  createDatabaseContentStore,
  mountContentApiRoutes,
  type ContentActiveCollaborationChecker,
  type ContentInactiveCollaborationCacheInvalidator,
} from "./content-api.js";
import {
  parseFileFieldReadMode,
  shapeContentDocumentResponse,
} from "./content-api/routes.js";
import { createCachedMediaAssetLookup } from "./content-api/media-field-expansion.js";
import { toDocumentResponse } from "./content-api/responses.js";
import { createCollaborationRedisDependency } from "./collaboration/redis-client.js";
import { createDocumentCollaborationActiveError } from "./collaboration/errors.js";
import { createCollaborationRedisStore } from "./collaboration/redis-store.js";
import {
  createCollaborationRuntime,
  type CollaborationRuntimeRedisStore,
} from "./collaboration/runtime.js";
import {
  createCollaborationWebSocketTransport,
  isCollaborationWebSocketUpgradeRequest,
  type BunUpgradeServer,
  type CollaborationWebSocketHandler,
  type CollaborationPresenceStore,
  type CollaborationWebSocketTransport,
} from "./collaboration/transport.js";
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
import {
  createCollaborationAuthGuard,
  mountCollaborationRoutes,
  resolveCollaborationAllowedOrigins,
  type CollaborationDocumentLocator,
} from "./collaboration-auth.js";
import {
  createDatabaseEnvironmentStore,
  mountEnvironmentApiRoutes,
} from "./environments-api.js";
import {
  createDatabaseProjectStore,
  mountProjectApiRoutes,
} from "./projects-api.js";
import { mountMediaApiRoutes, type MediaObjectStore } from "./media-api.js";
import { createDatabaseMediaStore } from "./media/database-store.js";
import { createS3CompatibleMediaObjectStore } from "./media/object-store.js";
import { mountWebhookApiRoutes } from "./webhooks-api.js";
import { createRuntimeWebhookRuntime } from "./webhooks/runtime.js";
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
  type AiContentStore,
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
  activeCollaboration?: ContentActiveCollaborationChecker;
  collaborationRedisStore?: RuntimeCollaborationRedisStore;
  collaborationUnavailableDetails?: Record<string, unknown>;
  serverOptions?: Omit<
    CreateServerRequestHandlerOptions,
    "env" | "logger" | "actions" | "configureApp"
  >;
};

type RuntimeCollaborationRedisStore = CollaborationRuntimeRedisStore & {
  isActive: (documentId: string) => Promise<boolean>;
  invalidateInactiveCache: (documentId: string) => Promise<void>;
} & CollaborationPresenceStore;

export type PrepareServerRequestHandlerWithModulesOptions =
  CreateServerRequestHandlerWithModulesOptions & {
    studioRuntimeOptions?: CreateStudioRuntimePublicationOptions;
  };

export type ServerRequestHandlerWithModulesResult = {
  handler: ServerRequestHandler;
  handleRequest: (
    request: Request,
    server?: BunUpgradeServer,
  ) => Promise<Response | undefined>;
  collaborationWebSocket: CollaborationWebSocketHandler;
  collaborationWebSocketTransport: CollaborationWebSocketTransport;
  moduleLoadReport: ServerModuleLoadReport;
  dbConnection: DatabaseConnection;
  dal: ContentDAL;
  shutdown: () => Promise<void>;
};

type RuntimeMediaObjectStoreEnv = Partial<
  Pick<
    ServerEnv,
    | "S3_ENDPOINT"
    | "S3_ACCESS_KEY"
    | "S3_SECRET_KEY"
    | "S3_BUCKET"
    | "S3_PUBLIC_BASE_URL"
  >
>;

export function createRuntimeMediaObjectStore(
  env: RuntimeMediaObjectStoreEnv,
): MediaObjectStore | undefined {
  if (
    !env.S3_ENDPOINT ||
    !env.S3_ACCESS_KEY ||
    !env.S3_SECRET_KEY ||
    !env.S3_BUCKET
  ) {
    return undefined;
  }

  return createS3CompatibleMediaObjectStore({
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
  });
}

async function assertNoActiveCollaboration(
  activeCollaboration: ContentActiveCollaborationChecker | undefined,
  documentId: string,
): Promise<void> {
  if (!(await activeCollaboration?.isDocumentActive(documentId))) {
    return;
  }

  throw createDocumentCollaborationActiveError(documentId);
}

export function createCollaborationGuardedAiContentStore(
  store: AiContentStore,
  activeCollaboration: ContentActiveCollaborationChecker | undefined,
  inactiveCollaborationCache?: ContentInactiveCollaborationCacheInvalidator,
): AiContentStore {
  const restore = store.restore;
  const invalidateInactiveCache = async (documentId: string) => {
    if (!inactiveCollaborationCache) {
      return;
    }

    await inactiveCollaborationCache
      .invalidateDocument(documentId)
      .catch(() => {
        // The mutation is already committed. Inactive Redis cache deletion is
        // best-effort; future room loads still validate metadata against the DB.
      });
  };

  return {
    getById: (scope, documentId, opts) =>
      store.getById(scope, documentId, opts),
    create: (scope, payload, opts) => store.create(scope, payload, opts),
    update: async (scope, documentId, payload, opts) => {
      await assertNoActiveCollaboration(activeCollaboration, documentId);
      const document = await store.update(scope, documentId, payload, opts);
      await invalidateInactiveCache(documentId);
      return document;
    },
    softDelete: async (scope, documentId) => {
      await assertNoActiveCollaboration(activeCollaboration, documentId);
      const document = await store.softDelete(scope, documentId);
      await invalidateInactiveCache(documentId);
      return document;
    },
    restore: restore
      ? async (scope, documentId) => {
          await assertNoActiveCollaboration(activeCollaboration, documentId);
          const document = await restore(scope, documentId);
          await invalidateInactiveCache(documentId);
          return document;
        }
      : undefined,
  };
}

export async function shutdownServerRuntime({
  collaborationWebSocketTransport,
  dbConnection,
}: {
  collaborationWebSocketTransport: Pick<
    CollaborationWebSocketTransport,
    "shutdown"
  >;
  dbConnection: Pick<DatabaseConnection, "close">;
}): Promise<void> {
  let collaborationDrainError: unknown;

  try {
    await collaborationWebSocketTransport.shutdown();
  } catch (error) {
    collaborationDrainError = error;
  }

  await dbConnection.close();

  if (collaborationDrainError) {
    throw collaborationDrainError;
  }
}

function createServerRuntimeShutdown({
  collaborationWebSocketTransport,
  dbConnection,
}: {
  collaborationWebSocketTransport: Pick<
    CollaborationWebSocketTransport,
    "shutdown"
  >;
  dbConnection: Pick<DatabaseConnection, "close">;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= shutdownServerRuntime({
      collaborationWebSocketTransport,
      dbConnection,
    });

    return shutdownPromise;
  };
}

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
  const mediaStore = createDatabaseMediaStore({ db: dbConnection.db });
  const contentStore = createDatabaseContentStore({
    db: dbConnection.db,
    lookupMediaAsset: (scope, id) => mediaStore.getAsset(scope, id),
  });
  const schemaStore = createDatabaseSchemaStore({ db: dbConnection.db });
  const environmentStore = createDatabaseEnvironmentStore({
    db: dbConnection.db,
  });
  const projectStore = createDatabaseProjectStore({ db: dbConnection.db });
  const mediaObjectStore = createRuntimeMediaObjectStore(env);
  const webhookRuntime = createRuntimeWebhookRuntime({
    db: dbConnection.db,
    logger,
  });
  const actions = collectServerModuleActions(moduleLoadReport);
  const collaborationRedisStore = options.collaborationRedisStore;
  const activeCollaboration =
    options.activeCollaboration ??
    (collaborationRedisStore
      ? {
          isDocumentActive: (documentId: string) =>
            collaborationRedisStore.isActive(documentId),
        }
      : undefined);
  const inactiveCollaborationCache = collaborationRedisStore
    ? {
        invalidateDocument: (documentId: string) =>
          collaborationRedisStore.invalidateInactiveCache(documentId),
      }
    : undefined;
  const resolveCollaborationDocument: CollaborationDocumentLocator = async ({
    project,
    environment,
    documentId,
  }) => {
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
  };
  const collaborationAuthGuard = createCollaborationAuthGuard({
    authService,
    resolveDocument: resolveCollaborationDocument,
    allowedOrigins: resolveCollaborationAllowedOrigins(rawEnv),
  });
  const collaborationRuntime = collaborationRedisStore
    ? createCollaborationRuntime({
        contentStore,
        redisStore: collaborationRedisStore,
        authGuard: collaborationAuthGuard,
        lifecycleEvents: webhookRuntime.dispatcher,
        shapePublishedDocument: async ({ document, request, scope }) =>
          shapeContentDocumentResponse({
            authorize: (request, requirement) =>
              authService.authorizeRequest(request, requirement),
            request,
            requiredScope: "content:publish",
            scope,
            store: contentStore,
            draft: true,
            document: toDocumentResponse(document),
            schema: await contentStore.getSchema(scope, document.type),
            fileFieldMode: parseFileFieldReadMode(request),
            lookupMediaAsset: createCachedMediaAssetLookup((scope, id) =>
              mediaStore.getAsset(scope, id),
            ),
          }),
      })
    : undefined;
  const collaborationWebSocketTransport = createCollaborationWebSocketTransport(
    {
      authGuard: collaborationAuthGuard,
      runtime: collaborationRuntime,
      presenceStore: collaborationRedisStore,
      unavailableDetails: options.collaborationUnavailableDetails,
    },
  );

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
    contentStore: createCollaborationGuardedAiContentStore(
      {
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
      activeCollaboration,
      inactiveCollaborationCache,
    ),
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
      mountWebhookApiRoutes(app, {
        store: webhookRuntime.store,
        authorize: (request, requirement) =>
          authService.authorizeRequest(request, requirement),
        requireCsrf: (request) => authService.requireCsrfProtection(request),
      });
      mountContentApiRoutes(app, {
        store: contentStore,
        authorize: (request, requirement) =>
          authService.authorizeRequest(request, requirement),
        requireCsrf: (request) => authService.requireCsrfProtection(request),
        getWriteSchemaSyncState: async (scope) => {
          const schemaHash = await lookupSchemaHashForScope(scope);

          return schemaHash ? { schemaHash } : undefined;
        },
        lookupMediaAsset: (scope, id) => mediaStore.getAsset(scope, id),
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
        lifecycleEvents: webhookRuntime.dispatcher,
        activeCollaboration,
        inactiveCollaborationCache,
        previewTokenSecret: env.MDCMS_PREVIEW_TOKEN_SECRET,
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
        resolveDocument: resolveCollaborationDocument,
        authGuard: collaborationAuthGuard,
      });
      mountMediaApiRoutes(app, {
        store: mediaStore,
        objectStore: mediaObjectStore,
        authorize: (request, requirement) =>
          authService.authorizeRequest(request, requirement),
        authorizeSettings: async (request) => {
          const session = await authService.requireAdminSession(request);

          return { actorId: session.userId };
        },
        requireCsrf: (request) => authService.requireCsrfProtection(request),
        lifecycleEvents: webhookRuntime.dispatcher,
      });
      mountLoadedServerModules(app, moduleDeps, moduleLoadReport);
    },
  });
  const handleRequest = async (
    request: Request,
    server?: BunUpgradeServer,
  ): Promise<Response | undefined> => {
    if (server && isCollaborationWebSocketUpgradeRequest(request)) {
      return collaborationWebSocketTransport.handleFetchUpgrade(
        request,
        server,
      );
    }

    return handler(request);
  };

  return {
    handler,
    handleRequest,
    collaborationWebSocket: collaborationWebSocketTransport.websocket,
    collaborationWebSocketTransport,
    moduleLoadReport,
    dbConnection,
    dal,
    shutdown: createServerRuntimeShutdown({
      collaborationWebSocketTransport,
      dbConnection,
    }),
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
  const collaborationRedisDependency = options.activeCollaboration
    ? undefined
    : await createCollaborationRedisDependency({
        redisUrl: env.REDIS_URL,
      });
  const collaborationRedisStore =
    collaborationRedisDependency?.status === "available"
      ? createCollaborationRedisStore(collaborationRedisDependency)
      : undefined;
  const activeCollaboration =
    options.activeCollaboration ??
    (collaborationRedisStore
      ? {
          isDocumentActive: (documentId: string) =>
            collaborationRedisStore.isActive(documentId),
        }
      : undefined);
  const collaborationUnavailableDetails =
    collaborationRedisDependency?.status === "unavailable"
      ? {
          reason: collaborationRedisDependency.reason,
          ...(collaborationRedisDependency.error instanceof Error
            ? { errorMessage: collaborationRedisDependency.error.message }
            : {}),
        }
      : undefined;

  const runtime = createServerRequestHandlerWithModules({
    ...options,
    env: resolvedEnv,
    logger,
    moduleLoadReport,
    activeCollaboration,
    collaborationRedisStore,
    collaborationUnavailableDetails,
    serverOptions: {
      ...(options.serverOptions ?? {}),
      studioRuntimePublication,
    },
  });

  if (collaborationRedisDependency?.status !== "available") {
    return runtime;
  }

  const closeDatabaseConnection = runtime.dbConnection.close;
  const dbConnection = {
    ...runtime.dbConnection,
    close: async () => {
      try {
        await closeDatabaseConnection();
      } finally {
        await collaborationRedisDependency.close?.();
      }
    },
  };

  return {
    ...runtime,
    dbConnection,
    shutdown: createServerRuntimeShutdown({
      collaborationWebSocketTransport: runtime.collaborationWebSocketTransport,
      dbConnection,
    }),
  };
}
