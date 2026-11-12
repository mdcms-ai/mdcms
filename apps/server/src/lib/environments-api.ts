import {
  RuntimeError,
  assertEnvironmentCloneInput,
  assertEnvironmentCreateInput,
  assertEnvironmentPromoteInput,
  type EnvironmentCloneInput,
  type EnvironmentCloneResult,
  type ContentWriteAttribution,
  type EnvironmentCreateInput,
  type EnvironmentDefinitionsMeta,
  type EnvironmentListResponse,
  type EnvironmentPromoteInput,
  type EnvironmentPromoteResult,
  type EnvironmentSummary,
  resolveRequestTargetRouting,
} from "@mdcms/shared";
import { and, eq, sql } from "drizzle-orm";

import type { ContentActiveCollaborationChecker } from "./content-api.js";
import { attributionFromAuthorizedRequest } from "./content-api/attribution.js";
import type { AuthorizedRequest, StudioSession } from "./auth.js";
import type { DrizzleDatabase } from "./db.js";
import {
  documents,
  documentVersions,
  environments,
  schemaRegistryEntries,
  schemaSyncs,
} from "./db/schema.js";
import {
  type EnvironmentResourceAuthorizer,
  cloneEnvironment as cloneEnvironmentImpl,
  promoteDocuments as promoteDocumentsImpl,
} from "./environments-clone-promote.js";
import {
  loadProjectEnvironmentTopologySnapshot,
  type PersistedEnvironmentDefinition,
} from "./environment-topology.js";
import { executeWithRuntimeErrorsHandled } from "./http-utils.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  DEFAULT_PROVISION_ACTOR,
  ensureProjectProvisioned,
  findEnvironmentByProjectAndId,
  findProjectBySlug,
} from "./project-provisioning.js";

type EnvironmentRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => EnvironmentRouteApp;
  post?: (path: string, handler: (ctx: any) => unknown) => EnvironmentRouteApp;
  delete?: (
    path: string,
    handler: (ctx: any) => unknown,
  ) => EnvironmentRouteApp;
};

export type EnvironmentStore = {
  list: (project: string) => Promise<EnvironmentListResponse>;
  create: (
    project: string,
    input: EnvironmentCreateInput,
  ) => Promise<EnvironmentSummary>;
  delete: (
    project: string,
    environmentId: string,
  ) => Promise<{ deleted: true; id: string }>;
  clone: (
    project: string,
    targetEnvironmentId: string,
    input: EnvironmentCloneInput,
    context: {
      attribution: ContentWriteAttribution;
      authorize: EnvironmentResourceAuthorizer;
    },
  ) => Promise<EnvironmentCloneResult>;
  promote: (
    project: string,
    targetEnvironmentId: string,
    input: EnvironmentPromoteInput,
    context: {
      attribution: ContentWriteAttribution;
      authorize: EnvironmentResourceAuthorizer;
    },
  ) => Promise<EnvironmentPromoteResult>;
};

export type EnvironmentAdminAuthorizer = (
  request: Request,
) => Promise<StudioSession | void>;

export type EnvironmentRequestCsrfProtector = (
  request: Request,
) => Promise<void>;

export type EnvironmentSessionAuthorizer = (
  request: Request,
) => Promise<StudioSession | void>;

// Clone and promote use `session_or_api_key` auth (SPEC-009 §Environment
// Management Endpoints) and require a specific operation scope. The runtime
// wires this to `authService.authorizeRequest({ requiredScope, project })`
// so the same gate applies to API-key callers (CLI, agents) and Studio
// session users.
export type EnvironmentScopedAuthorizer = (
  request: Request,
  scope: "environments:clone" | "environments:promote",
) => Promise<
  AuthorizedRequest & {
    authorizeEnvironmentResource: EnvironmentResourceAuthorizer;
  }
>;

export type MountEnvironmentApiRoutesOptions = {
  store: EnvironmentStore;
  authorizeSession: EnvironmentSessionAuthorizer;
  authorizeAdmin: EnvironmentAdminAuthorizer;
  authorizeList?: (request: Request, project: string) => Promise<void>;
  authorizeScoped: EnvironmentScopedAuthorizer;
  requireCsrf: EnvironmentRequestCsrfProtector;
};

export type CreateDatabaseEnvironmentStoreOptions = {
  db: DrizzleDatabase;
  activeCollaboration?: ContentActiveCollaborationChecker;
};

function createInvalidInputError(
  field: string,
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    details: {
      field,
      ...details,
    },
  });
}

function createConflictError(
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "CONFLICT",
    message,
    statusCode: 409,
    details,
  });
}

function createConfigSnapshotRequiredError(project: string): RuntimeError {
  return new RuntimeError({
    code: "CONFIG_SNAPSHOT_REQUIRED",
    message:
      "Environment management is unavailable until this project's config has been synced to the backend. Run cms schema sync from the host app repo.",
    statusCode: 409,
    details: {
      project,
    },
  });
}

function assertRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createInvalidInputError(field, `Field "${field}" is required.`);
  }

  return value.trim();
}

function pickProject(request: Request): string {
  const scope = resolveRequestTargetRouting(request);

  if (!scope.project) {
    throw new RuntimeError({
      code: "MISSING_TARGET_ROUTING",
      message: "Project routing is required for environment endpoints.",
      statusCode: 400,
      details: {
        project: scope.project ?? null,
      },
    });
  }

  return scope.project;
}

function toIsoString(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value as any).toISOString();
}

function toEnvironmentSummary(input: {
  project: string;
  row: typeof environments.$inferSelect;
  definition?: PersistedEnvironmentDefinition;
}): EnvironmentSummary {
  return {
    id: input.row.id,
    project: input.project,
    name: input.row.name,
    extends: input.definition?.extends ?? null,
    isDefault:
      input.definition?.isDefault ??
      input.row.name === DEFAULT_ENVIRONMENT_NAME,
    createdAt: toIsoString(input.row.createdAt),
  };
}

function toDefinitionsMeta(
  snapshot: Awaited<ReturnType<typeof loadProjectEnvironmentTopologySnapshot>>,
): EnvironmentDefinitionsMeta {
  if (!snapshot) {
    return {
      definitionsStatus: "missing",
    };
  }

  return {
    definitionsStatus: "ready",
    configSnapshotHash: snapshot.configSnapshotHash,
    syncedAt: snapshot.syncedAt,
  };
}

function toDefinitionMap(
  definitions: readonly PersistedEnvironmentDefinition[],
): Map<string, PersistedEnvironmentDefinition> {
  return new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
}

function assertEnvironmentAllowedByDefinitions(
  definitions: Map<string, PersistedEnvironmentDefinition>,
  input: EnvironmentCreateInput,
): void {
  const definition = definitions.get(input.name);

  if (!definition) {
    throw createInvalidInputError(
      "name",
      `Environment "${input.name}" is not defined in the latest synced project config snapshot.`,
      {
        environment: input.name,
      },
    );
  }

  const expectedExtends = definition.extends ?? null;
  const providedExtends = input.extends?.trim() || null;

  if (providedExtends !== null && providedExtends !== expectedExtends) {
    throw createInvalidInputError(
      "extends",
      `Environment "${input.name}" must extend "${expectedExtends ?? "null"}" according to the latest synced project config snapshot.`,
      {
        environment: input.name,
        expectedExtends,
        providedExtends,
      },
    );
  }
}

export function createDatabaseEnvironmentStore(
  options: CreateDatabaseEnvironmentStoreOptions,
): EnvironmentStore {
  const { db } = options;

  return {
    async list(project) {
      const normalizedProject = assertRequiredString(project, "project");
      const [projectRow, snapshot] = await Promise.all([
        findProjectBySlug(db, normalizedProject),
        loadProjectEnvironmentTopologySnapshot(db, normalizedProject),
      ]);

      if (!projectRow) {
        return {
          data: [],
          meta: toDefinitionsMeta(snapshot),
        };
      }

      const rows = await db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectRow.id));
      const definitions = toDefinitionMap(snapshot?.definitions ?? []);

      return {
        data: rows
          .map((row) =>
            toEnvironmentSummary({
              project: normalizedProject,
              row,
              definition: definitions.get(row.name),
            }),
          )
          .sort((left, right) => left.name.localeCompare(right.name)),
        meta: toDefinitionsMeta(snapshot),
      };
    },

    async create(project, input) {
      const normalizedProject = assertRequiredString(project, "project");
      const payload = {
        name: assertRequiredString(input.name, "name"),
        ...(input.extends !== undefined
          ? {
              extends: assertRequiredString(input.extends, "extends"),
            }
          : {}),
      } satisfies EnvironmentCreateInput;
      const snapshot = await loadProjectEnvironmentTopologySnapshot(
        db,
        normalizedProject,
      );

      if (!snapshot) {
        throw createConfigSnapshotRequiredError(normalizedProject);
      }

      const definitions = toDefinitionMap(snapshot.definitions);

      assertEnvironmentAllowedByDefinitions(definitions, payload);

      return db.transaction(async (tx) => {
        const existingProject = await findProjectBySlug(
          tx as unknown as DrizzleDatabase,
          normalizedProject,
        );
        const provisioned = await ensureProjectProvisioned(
          tx as unknown as DrizzleDatabase,
          {
            project: normalizedProject,
          },
        );

        const existingEnvironment = await tx.query.environments.findFirst({
          where: and(
            eq(environments.projectId, provisioned.projectId),
            eq(environments.name, payload.name),
          ),
        });

        if (payload.name === DEFAULT_ENVIRONMENT_NAME) {
          if (
            existingProject &&
            existingEnvironment &&
            !provisioned.createdProductionEnvironment
          ) {
            throw createConflictError(
              `Environment "${payload.name}" already exists in project "${normalizedProject}".`,
              {
                project: normalizedProject,
                environment: payload.name,
              },
            );
          }

          const productionRow =
            existingEnvironment ??
            (await tx.query.environments.findFirst({
              where: and(
                eq(environments.projectId, provisioned.projectId),
                eq(environments.name, DEFAULT_ENVIRONMENT_NAME),
              ),
            }));

          if (!productionRow) {
            throw new RuntimeError({
              code: "INTERNAL_ERROR",
              message: "Default production environment could not be loaded.",
              statusCode: 500,
            });
          }

          return toEnvironmentSummary({
            project: normalizedProject,
            row: productionRow,
            definition: definitions.get(productionRow.name),
          });
        }

        if (existingEnvironment) {
          throw createConflictError(
            `Environment "${payload.name}" already exists in project "${normalizedProject}".`,
            {
              project: normalizedProject,
              environment: payload.name,
            },
          );
        }

        const [created] = await tx
          .insert(environments)
          .values({
            projectId: provisioned.projectId,
            name: payload.name,
            description: null,
            createdBy: DEFAULT_PROVISION_ACTOR,
          })
          .returning();

        if (!created) {
          throw new RuntimeError({
            code: "INTERNAL_ERROR",
            message: "Environment creation did not return a row.",
            statusCode: 500,
          });
        }

        return toEnvironmentSummary({
          project: normalizedProject,
          row: created,
          definition: definitions.get(created.name),
        });
      });
    },

    async delete(project, environmentId) {
      const normalizedProject = assertRequiredString(project, "project");
      const normalizedEnvironmentId = assertRequiredString(
        environmentId,
        "environmentId",
      );
      const projectRow = await findProjectBySlug(db, normalizedProject);

      if (!projectRow) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Environment not found.",
          statusCode: 404,
          details: {
            project: normalizedProject,
            environmentId: normalizedEnvironmentId,
          },
        });
      }

      const environmentRow = await findEnvironmentByProjectAndId(db, {
        project: normalizedProject,
        environmentId: normalizedEnvironmentId,
      });

      if (!environmentRow) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Environment not found.",
          statusCode: 404,
          details: {
            project: normalizedProject,
            environmentId: normalizedEnvironmentId,
          },
        });
      }

      if (environmentRow.name === DEFAULT_ENVIRONMENT_NAME) {
        throw createConflictError(
          'The default "production" environment cannot be deleted.',
          {
            project: normalizedProject,
            environmentId: environmentRow.id,
            environment: environmentRow.name,
          },
        );
      }

      const [documentsRow, versionsRow, syncsRow, registryRow] =
        await Promise.all([
          db
            .select({
              count: sql<number>`count(*)::int`,
            })
            .from(documents)
            .where(
              and(
                eq(documents.projectId, projectRow.id),
                eq(documents.environmentId, environmentRow.id),
              ),
            ),
          db
            .select({
              count: sql<number>`count(*)::int`,
            })
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.projectId, projectRow.id),
                eq(documentVersions.environmentId, environmentRow.id),
              ),
            ),
          db
            .select({
              count: sql<number>`count(*)::int`,
            })
            .from(schemaSyncs)
            .where(
              and(
                eq(schemaSyncs.projectId, projectRow.id),
                eq(schemaSyncs.environmentId, environmentRow.id),
              ),
            ),
          db
            .select({
              count: sql<number>`count(*)::int`,
            })
            .from(schemaRegistryEntries)
            .where(
              and(
                eq(schemaRegistryEntries.projectId, projectRow.id),
                eq(schemaRegistryEntries.environmentId, environmentRow.id),
              ),
            ),
        ]);

      const dependencyCount =
        (documentsRow[0]?.count ?? 0) +
        (versionsRow[0]?.count ?? 0) +
        (syncsRow[0]?.count ?? 0) +
        (registryRow[0]?.count ?? 0);

      if (dependencyCount > 0) {
        throw createConflictError(
          `Environment "${environmentRow.name}" cannot be deleted while content or schema state still exists.`,
          {
            project: normalizedProject,
            environmentId: environmentRow.id,
            environment: environmentRow.name,
          },
        );
      }

      await db
        .delete(environments)
        .where(
          and(
            eq(environments.projectId, projectRow.id),
            eq(environments.id, environmentRow.id),
          ),
        );

      return {
        deleted: true as const,
        id: environmentRow.id,
      };
    },

    async clone(project, targetEnvironmentId, input, context) {
      const normalizedProject = assertRequiredString(project, "project");
      const normalizedTargetId = assertRequiredString(
        targetEnvironmentId,
        "targetEnvironmentId",
      );

      return cloneEnvironmentImpl(db, {
        ...input,
        project: normalizedProject,
        targetEnvironmentId: normalizedTargetId,
        attribution: context.attribution,
        authorize: context.authorize,
      });
    },

    async promote(project, targetEnvironmentId, input, context) {
      const normalizedProject = assertRequiredString(project, "project");
      const normalizedTargetId = assertRequiredString(
        targetEnvironmentId,
        "targetEnvironmentId",
      );

      return promoteDocumentsImpl(db, {
        ...input,
        activeCollaboration: options.activeCollaboration,
        project: normalizedProject,
        targetEnvironmentId: normalizedTargetId,
        attribution: context.attribution,
        authorize: context.authorize,
      });
    },
  };
}

export function mountEnvironmentApiRoutes(
  app: unknown,
  options: MountEnvironmentApiRoutesOptions,
): void {
  const environmentApp = app as EnvironmentRouteApp;

  environmentApp.get?.("/api/v1/environments", ({ request }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const project = pickProject(request);
      if (options.authorizeList) await options.authorizeList(request, project);
      else await options.authorizeAdmin(request);

      return options.store.list(project);
    });
  });

  environmentApp.post?.("/api/v1/environments", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const project = pickProject(request);
      await options.requireCsrf(request);
      await options.authorizeAdmin(request);

      const payload = (body ?? {}) as unknown;
      assertEnvironmentCreateInput(payload);

      return {
        data: await options.store.create(project, payload),
      };
    });
  });

  environmentApp.delete?.(
    "/api/v1/environments/:id",
    ({ request, params }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const project = pickProject(request);
        await options.requireCsrf(request);
        await options.authorizeAdmin(request);
        const environmentId = assertRequiredString(params.id, "id");

        return {
          data: await options.store.delete(project, environmentId),
        };
      });
    },
  );

  environmentApp.post?.(
    "/api/v1/environments/:id/clone",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const project = pickProject(request);
        await options.requireCsrf(request);
        const authorization = await options.authorizeScoped(
          request,
          "environments:clone",
        );
        const targetEnvironmentId = assertRequiredString(params.id, "id");
        const payload = (body ?? {}) as unknown;
        assertEnvironmentCloneInput(payload);

        return {
          data: await options.store.clone(
            project,
            targetEnvironmentId,
            payload,
            {
              authorize: authorization.authorizeEnvironmentResource,
              attribution: attributionFromAuthorizedRequest({
                request,
                authorization,
              }),
            },
          ),
        };
      });
    },
  );

  // SPEC-009 documents the path parameter as `:targetId` for clarity, but
  // the underlying router cannot have two different parameter names at the
  // same path slot (clone uses `:id` already). The path parameter still
  // identifies the target environment id; the spec documentation name is
  // for readability only.
  environmentApp.post?.(
    "/api/v1/environments/:id/promote",
    ({ request, params, body }: any) => {
      return executeWithRuntimeErrorsHandled(request, async () => {
        const project = pickProject(request);
        await options.requireCsrf(request);
        const authorization = await options.authorizeScoped(
          request,
          "environments:promote",
        );
        const targetEnvironmentId = assertRequiredString(params.id, "id");
        const payload = (body ?? {}) as unknown;
        assertEnvironmentPromoteInput(payload);

        return {
          data: await options.store.promote(
            project,
            targetEnvironmentId,
            payload,
            {
              authorize: authorization.authorizeEnvironmentResource,
              attribution: attributionFromAuthorizedRequest({
                request,
                authorization,
              }),
            },
          ),
        };
      });
    },
  );
}
