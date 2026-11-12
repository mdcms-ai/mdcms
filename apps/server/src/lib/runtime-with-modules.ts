import { mountOAuthRoutes } from "./oauth/routes.js";
import { mountMcpRoutes } from "./mcp/routes.js";
import { adaptAssistantReadTool } from "./agent-tools/assistant-reads.js";
import type { AgentReadToolDefinition } from "@mdcms/shared";
import {
  documentEnvelopeSchema,
  schemaEnvelopeSchema,
} from "./agent-tools/schema.js";
import { createAssistantContentExecutor } from "./agent-tools/assistant.js";
import { createAgentToolRegistry } from "./agent-tools/registry.js";
import { randomBytes } from "node:crypto";
import {
  createInternalDispatcher,
  stripInternalHeaders,
  trustedInternalChannel,
} from "./agent-tools/dispatcher.js";
import { actorFromAuthorizedRequest, authorizeSessionGrants } from "./auth.js";
import { findEnvironmentByProjectAndId } from "./project-provisioning.js";
import type { EnvironmentResourceAuthorizer } from "./environments-clone-promote.js";
import type { AuthorizationRequirement } from "./auth.js";
import { attributionFromAuthorizedRequest } from "./content-api/attribution.js";
import {
  createInternalServerRequestHandler,
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
    softDelete: async (scope, documentId, opts) => {
      await assertNoActiveCollaboration(activeCollaboration, documentId);
      const document = await store.softDelete(scope, documentId, opts);
      await invalidateInactiveCache(documentId);
      return document;
    },
    restore: restore
      ? async (scope, documentId, opts) => {
          await assertNoActiveCollaboration(activeCollaboration, documentId);
          const document = await restore(scope, documentId, opts);
          await invalidateInactiveCache(documentId);
          return document;
        }
      : undefined,
  };
}

export async function shutdownServerRuntime({
  collaborationWebSocketTransport,
  dbConnection,
  disposeAiProposals,
}: {
  collaborationWebSocketTransport: Pick<
    CollaborationWebSocketTransport,
    "shutdown"
  >;
  dbConnection: Pick<DatabaseConnection, "close">;
  disposeAiProposals?: () => void;
}): Promise<void> {
  let collaborationDrainError: unknown;

  try {
    await collaborationWebSocketTransport.shutdown();
  } catch (error) {
    collaborationDrainError = error;
  }

  disposeAiProposals?.();
  await dbConnection.close();

  if (collaborationDrainError) {
    throw collaborationDrainError;
  }
}

function createServerRuntimeShutdown({
  collaborationWebSocketTransport,
  dbConnection,
  disposeAiProposals,
}: {
  collaborationWebSocketTransport: Pick<
    CollaborationWebSocketTransport,
    "shutdown"
  >;
  dbConnection: Pick<DatabaseConnection, "close">;
  disposeAiProposals?: () => void;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= shutdownServerRuntime({
      collaborationWebSocketTransport,
      dbConnection,
      disposeAiProposals,
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
  const internalSecret = randomBytes(32).toString("hex");
  const authService = createAuthService({
    db: dbConnection.db,
    env: rawEnv,
    emailService,
    isTrustedAgentRequest: (request) =>
      trustedInternalChannel(request, internalSecret) !== undefined,
    isTrustedMcpRequest: (request) =>
      trustedInternalChannel(request, internalSecret) === "mcp",
  });
  const authorizeInternalRequest = async (
    request: Request,
    requirement: AuthorizationRequirement,
  ) => {
    const authorization = await authService.authorizeRequest(
      request,
      requirement,
    );
    const internalChannel = trustedInternalChannel(request, internalSecret);
    return internalChannel
      ? { ...authorization, internalChannel }
      : authorization;
  };
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
              authorizeInternalRequest(request, requirement),
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

  const agentRegistry = createAgentToolRegistry(undefined, {
    getMediaUploadLimit: async (target) =>
      (await mediaStore.getSettings(target)).media.image.maxUploadSizeBytes,
  });
  const executeAssistantTool = async (
    request: Request,
    name: string,
    input: unknown,
  ) => {
    const target = resolveRequestTargetRouting(request);
    const project = target.project!;
    const environment = target.environment!;
    const authorization = await authorizeInternalRequest(request, {
      requiredScope:
        name === "get_schema" ? "schema:read" : "content:read:draft",
      project,
      environment,
    });
    return agentRegistry.execute(name, input, {
      authorization,
      target: { project, environment },
      dispatch: createInternalDispatcher(internalHandler, internalSecret, {
        request,
        project,
        environment,
        channel: "studio_ai",
      }),
    });
  };
  const readToolsForRequest: NonNullable<
    CoreAiServerDeps["readToolsForRequest"]
  > = async (request, narrowing) => {
    const target = resolveRequestTargetRouting(request);
    const definitions: AgentReadToolDefinition[] = [];
    for (const name of [
      "list_documents",
      "get_document",
      "get_schema",
    ] as const) {
      let authorization;
      try {
        authorization = await authorizeInternalRequest(request, {
          requiredScope:
            name === "get_schema" ? "schema:read" : "content:read:draft",
          project: target.project,
          environment: target.environment,
        });
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "FORBIDDEN")
          continue;
        throw error;
      }
      const definition = agentRegistry
        .list(authorization)
        .find((tool) => tool.name === name);
      if (!definition) continue;
      definitions.push(
        adaptAssistantReadTool(
          definition,
          (input) => executeAssistantTool(request, name, input),
          narrowing,
        ),
      );
    }
    return definitions;
  };

  const aiModuleDeps: CoreAiServerDeps = {
    orchestrator: aiOrchestrator,
    proposalStore: aiProposalStore,
    contentStore: (request) => {
      const target = resolveRequestTargetRouting(request);
      return createAssistantContentExecutor(
        createInternalDispatcher(internalHandler, internalSecret, {
          request,
          project: target.project!,
          environment: target.environment!,
          channel: "studio_ai",
        }),
      );
    },
    contextResolver: {
      loadDraftContext: async ({ request, documentId }) => ({
        document: documentEnvelopeSchema.parse(
          await executeAssistantTool(request, "get_document", { documentId }),
        ).data,
      }),
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
          : authorized.principal.type === "oauth"
            ? authorized.principal.userId
            : authorized.principal.createdByUserId;
      return {
        actorId,
        attribution: attributionFromAuthorizedRequest({
          request,
          authorization: authorized,
          channel: "studio_ai",
        }),
      };
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
    contentTypesLookup: async ({ request }) => {
      try {
        return schemaEnvelopeSchema
          .parse(await executeAssistantTool(request, "get_schema", {}))
          .data.types.map((type) => type.resolvedSchema);
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "FORBIDDEN")
          return [];
        throw error;
      }
    },
    supportedLocalesLookup,
    userLookup,
    readToolsForRequest,
  };

  const moduleDeps: ServerModuleAppDeps = {
    ...(options.moduleDeps ?? {}),
    dal,
    ai: aiModuleDeps,
  };

  const internalHandler = createInternalServerRequestHandler({
    ...(options.serverOptions ?? {}),
    env: rawEnv,
    logger,
    actions,
    configureApp: (app) => {
      mountAuthRoutes(app, { authService });
      mountOAuthRoutes(app, { db: dbConnection.db, auth: authService, env });
      mountMcpRoutes(app, {
        origin: env.MDCMS_SERVER_URL,
        version: env.APP_VERSION,
        registry: agentRegistry,
        authenticate: (request) => authService.authenticateMcp(request),
        dispatch: (request, target, declared) =>
          createInternalDispatcher(internalHandler, internalSecret, {
            request,
            ...target,
            channel: "mcp",
            declared,
          }),
      });
      mountWebhookApiRoutes(app, {
        store: webhookRuntime.store,
        authorize: (request, requirement) =>
          authorizeInternalRequest(request, requirement),
        requireCsrf: (request) => authService.requireCsrfProtection(request),
      });
      mountContentApiRoutes(app, {
        store: contentStore,
        authorize: (request, requirement) =>
          authorizeInternalRequest(request, requirement),
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
          authorizeInternalRequest(request, requirement),
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
        authorizeList: (request, project) =>
          authService.authorizeEnvironmentList(request, project),
        authorizeScoped: async (request, requiredScope) => {
          const routing = resolveRequestTargetRouting(request);
          const project = routing.project!;
          const targetId = decodeURIComponent(
            new URL(request.url).pathname.split("/").at(-2)!,
          );
          const destination = await findEnvironmentByProjectAndId(
            dbConnection.db,
            { project, environmentId: targetId },
          );
          if (!destination)
            throw new RuntimeError({
              code: "NOT_FOUND",
              message: "Environment not found.",
              statusCode: 404,
            });
          if (routing.environment && routing.environment !== destination.name)
            throw new RuntimeError({
              code: "TARGET_ROUTING_MISMATCH",
              message: "Destination does not match routed environment.",
              statusCode: 400,
            });
          const authorization = await authorizeInternalRequest(request, {
            requiredScope,
            project,
            environment: destination.name,
          });
          const authorizeEnvironmentResource: EnvironmentResourceAuthorizer =
            async (tx, requirements) => {
              const grants = await authService.getOAuthUserGrants(
                actorFromAuthorizedRequest(authorization).id,
                tx,
              );
              if (
                !grants.some(
                  (grant) =>
                    grant.scope.kind === "global" &&
                    (grant.role === "owner" || grant.role === "admin"),
                )
              )
                throw new RuntimeError({
                  code: "FORBIDDEN",
                  message: "Global admin privileges required.",
                  statusCode: 403,
                });
              for (const requirement of requirements) {
                if (
                  (requirement.scope === "environments:clone" ||
                    requirement.scope === "environments:promote") &&
                  requirement.environment !== destination.name
                )
                  throw new RuntimeError({
                    code: "TARGET_ROUTING_MISMATCH",
                    message: "Destination changed during authorization.",
                    statusCode: 400,
                  });
                const principal = authorization.principal;
                if (
                  principal.type === "api_key" &&
                  !principal.contextAllowlist.some(
                    (tuple) =>
                      tuple.project === project &&
                      tuple.environment === requirement.environment,
                  )
                )
                  throw new RuntimeError({
                    code: "TARGET_ROUTING_MISMATCH",
                    message: "Environment is outside the credential allowlist.",
                    statusCode: 400,
                  });
                if (
                  principal.type !== "session" &&
                  requirement.credentialScope &&
                  !principal.scopes.includes(requirement.scope)
                )
                  throw new RuntimeError({
                    code: "FORBIDDEN",
                    message: "Required environment operation scope is missing.",
                    statusCode: 403,
                  });
                try {
                  authorizeSessionGrants(grants, {
                    requiredScope: requirement.scope,
                    project,
                    environment: requirement.environment,
                    documentPath: requirement.path,
                  });
                } catch (error) {
                  if (
                    error instanceof RuntimeError &&
                    error.code === "FORBIDDEN"
                  )
                    throw new RuntimeError({
                      code: "FORBIDDEN",
                      message: "Environment operation is not authorized.",
                      statusCode: 403,
                    });
                  throw error;
                }
              }
            };
          return { ...authorization, authorizeEnvironmentResource };
        },
        requireCsrf: (request) => authService.requireCsrfProtection(request),
      });
      mountProjectApiRoutes(app, {
        store: projectStore,
        authorize: (request, input) => {
          const routing = resolveRequestTargetRouting(request);
          return authService
            .authorizeRequest(request, {
              requiredScope: input.scope,
              project: input.project ?? routing.project,
              environment: routing.environment,
            })
            .then(() => undefined);
        },
        filterAccessibleProjects: (request, projectSlugs) =>
          authService.filterAccessibleProjects(request, projectSlugs),
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
          authorizeInternalRequest(request, requirement),
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
  const handler: ServerRequestHandler = (request) =>
    internalHandler(stripInternalHeaders(request));
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
      disposeAiProposals: () => aiProposalStore.dispose(),
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

  let shutdownPromise: Promise<void> | undefined;
  return {
    ...runtime,
    dbConnection,
    shutdown: () => {
      shutdownPromise ??= (async () => {
        try {
          await runtime.shutdown();
        } finally {
          await collaborationRedisDependency.close?.();
        }
      })();
      return shutdownPromise;
    },
  };
}
