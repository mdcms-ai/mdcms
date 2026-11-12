import { randomUUID } from "node:crypto";

import {
  RuntimeError,
  inferContentFormat,
  type DocumentPromotionResult,
  type ContentWriteAttribution,
  type EnvironmentCloneInput,
  type EnvironmentCloneResult,
  type EnvironmentPromoteInput,
  type EnvironmentPromoteResult,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { ContentActiveCollaborationChecker } from "./content-api.js";
import { createDocumentCollaborationActiveError } from "./collaboration/errors.js";
import type { ApiKeyOperationScope } from "./auth.js";
import type { DrizzleDatabase } from "./db.js";
import {
  documents,
  documentVersions,
  environments,
  schemaRegistryEntries,
  schemaSyncs,
} from "./db/schema.js";
import {
  remapFrontmatterReferences,
  type ReferenceLookupKey,
  type RemapInput,
  type ReferenceSourceLookup,
  type ReferenceTargetResolver,
} from "./environments-reference-remap.js";
import { findProjectBySlug } from "./project-provisioning.js";

// `clone` and `promote` are two related but distinct write paths:
//
//   - clone: copy *all* (or all-published) source docs into a target env that
//     has no overlapping rows. New `documentId` per row, preserved
//     `translationGroupId`. Optional published-version snapshot copy.
//
//   - promote: per-document overwrite (or create) into a target env, by
//     `(translationGroupId, locale)`. Always auto-publishes the target.
//
// Both share the reference-remap helper and run inside a single transaction
// so any failure rolls back atomically (SPEC-009 #Reference remapping).

export type EnvironmentPermission = {
  environment: string;
  scope: ApiKeyOperationScope;
  path?: string;
  credentialScope: boolean;
};
export type EnvironmentResourceAuthorizer = (
  db: DrizzleDatabase,
  requirements: readonly EnvironmentPermission[],
) => Promise<void>;

type ScopeRow = {
  sourceName: string;
  targetName: string;
  projectId: string;
  sourceEnvId: string;
  targetEnvId: string;
};

type SourceDocumentRow = typeof documents.$inferSelect;

// The published payload is what `documentVersions` holds for the row's
// current `publishedVersion`. It is intentionally distinct from the
// `documents` row, which always holds the most recent (possibly draft)
// state. Clone uses the published payload when `includeDrafts: false` and
// when copying the version-1 snapshot into the target.
type PublishedPayload = {
  body: string;
  frontmatter: Record<string, unknown>;
  path: string;
  contentFormat: SourceDocumentRow["contentFormat"];
  schemaType: string;
  locale: string;
  version: number;
};

type SourceContext = {
  scope: ScopeRow;
  rows: SourceDocumentRow[];
  sourceLookup: ReferenceSourceLookup;
  schemaByType: Map<string, SchemaRegistryTypeSnapshot>;
  publishedByDocumentId: Map<string, PublishedPayload>;
};

function buildScopeError(message: string, details: Record<string, unknown>) {
  return new RuntimeError({
    code: "NOT_FOUND",
    message,
    statusCode: 404,
    details,
  });
}

function buildInvalidInputError(field: string, message: string) {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    details: { field },
  });
}

function buildConflictError(message: string, details: Record<string, unknown>) {
  return new RuntimeError({
    code: "CONFLICT",
    message,
    statusCode: 409,
    details,
  });
}

async function loadProjectScope(
  db: DrizzleDatabase,
  input: { project: string; sourceEnvId: string; targetEnvId: string },
): Promise<ScopeRow> {
  if (input.sourceEnvId === input.targetEnvId) {
    throw buildInvalidInputError(
      "sourceEnvironmentId",
      "Source and target environments must differ.",
    );
  }

  const projectRow = await findProjectBySlug(db, input.project);
  if (!projectRow) {
    throw buildScopeError("Project not found.", { project: input.project });
  }

  const envRows = await db.query.environments.findMany({
    where: and(
      eq(environments.projectId, projectRow.id),
      inArray(environments.id, [input.sourceEnvId, input.targetEnvId]),
    ),
  });

  const envById = new Map(envRows.map((row) => [row.id, row]));
  const sourceEnv = envById.get(input.sourceEnvId);
  const targetEnv = envById.get(input.targetEnvId);

  if (!sourceEnv) {
    throw buildScopeError("Source environment not found in routed project.", {
      project: input.project,
      sourceEnvironmentId: input.sourceEnvId,
    });
  }
  if (!targetEnv) {
    throw buildScopeError("Target environment not found in routed project.", {
      project: input.project,
      targetEnvironmentId: input.targetEnvId,
    });
  }

  return {
    projectId: projectRow.id,
    sourceName: sourceEnv.name,
    targetName: targetEnv.name,
    sourceEnvId: sourceEnv.id,
    targetEnvId: targetEnv.id,
  };
}

async function loadSourceContext(
  db: DrizzleDatabase,
  scope: ScopeRow,
  options: { documentIds?: string[]; includeDrafts: boolean },
): Promise<SourceContext> {
  const baseConditions = [
    eq(documents.projectId, scope.projectId),
    eq(documents.environmentId, scope.sourceEnvId),
    eq(documents.isDeleted, false),
  ];

  if (options.documentIds && options.documentIds.length > 0) {
    baseConditions.push(inArray(documents.documentId, options.documentIds));
  }

  if (!options.includeDrafts) {
    baseConditions.push(sql`${documents.publishedVersion} is not null`);
  }

  const rows = await db
    .select()
    .from(documents)
    .where(and(...baseConditions));

  // The reference lookup needs *every* source document, not just the ones
  // we're about to copy/promote — promoted refs may point to source docs
  // outside the requested set, but their (translation_group_id, locale)
  // identity is enough to remap.
  const allSourceRows = options.documentIds
    ? await db
        .select({
          documentId: documents.documentId,
          translationGroupId: documents.translationGroupId,
          locale: documents.locale,
        })
        .from(documents)
        .where(
          and(
            eq(documents.projectId, scope.projectId),
            eq(documents.environmentId, scope.sourceEnvId),
            eq(documents.isDeleted, false),
          ),
        )
    : rows.map((row) => ({
        documentId: row.documentId,
        translationGroupId: row.translationGroupId,
        locale: row.locale,
      }));

  const sourceMap = new Map<string, ReferenceLookupKey>();
  for (const row of allSourceRows) {
    sourceMap.set(row.documentId, {
      translationGroupId: row.translationGroupId,
      locale: row.locale,
    });
  }

  const schemaRows = await db
    .select({
      schemaType: schemaRegistryEntries.schemaType,
      resolvedSchema: schemaRegistryEntries.resolvedSchema,
    })
    .from(schemaRegistryEntries)
    .where(
      and(
        eq(schemaRegistryEntries.projectId, scope.projectId),
        eq(schemaRegistryEntries.environmentId, scope.sourceEnvId),
      ),
    );

  const schemaByType = new Map<string, SchemaRegistryTypeSnapshot>();
  for (const row of schemaRows) {
    schemaByType.set(
      row.schemaType,
      row.resolvedSchema as SchemaRegistryTypeSnapshot,
    );
  }

  // Pull the published payload (body, frontmatter, path) for any source row
  // that has a non-null publishedVersion. The `documents` row by itself can
  // contain unsaved-draft content even when `publishedVersion` is set, so
  // clone with `includeDrafts: false` and the version-1 snapshot copy must
  // honor the version's payload to avoid leaking drafts into the target.
  const publishedByDocumentId = new Map<string, PublishedPayload>();
  const documentIdsWithPublished = rows
    .filter((row) => row.publishedVersion !== null)
    .map((row) => row.documentId);

  if (documentIdsWithPublished.length > 0) {
    const versionRows = await db
      .select({
        documentId: documentVersions.documentId,
        version: documentVersions.version,
        body: documentVersions.body,
        frontmatter: documentVersions.frontmatter,
        path: documentVersions.path,
        contentFormat: documentVersions.contentFormat,
        schemaType: documentVersions.schemaType,
        locale: documentVersions.locale,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.projectId, scope.projectId),
          eq(documentVersions.environmentId, scope.sourceEnvId),
          inArray(documentVersions.documentId, documentIdsWithPublished),
        ),
      );

    // Each documentId may have many versions in the table — keep only the
    // one matching the documents row's `publishedVersion`.
    const expectedVersion = new Map(
      rows
        .filter((row) => row.publishedVersion !== null)
        .map((row) => [row.documentId, row.publishedVersion as number]),
    );
    for (const versionRow of versionRows) {
      if (expectedVersion.get(versionRow.documentId) !== versionRow.version) {
        continue;
      }
      publishedByDocumentId.set(versionRow.documentId, {
        body: versionRow.body,
        frontmatter: versionRow.frontmatter as Record<string, unknown>,
        path: versionRow.path,
        contentFormat:
          versionRow.contentFormat as SourceDocumentRow["contentFormat"],
        schemaType: versionRow.schemaType,
        locale: versionRow.locale,
        version: versionRow.version,
      });
    }
  }

  return {
    scope,
    rows,
    sourceLookup: (id) => sourceMap.get(id),
    schemaByType,
    publishedByDocumentId,
  };
}

function targetMapKey(key: ReferenceLookupKey): string {
  return `${key.translationGroupId}::${key.locale}`;
}

async function loadTargetMap(
  db: DrizzleDatabase,
  scope: ScopeRow,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      documentId: documents.documentId,
      translationGroupId: documents.translationGroupId,
      locale: documents.locale,
    })
    .from(documents)
    .where(
      and(
        eq(documents.projectId, scope.projectId),
        eq(documents.environmentId, scope.targetEnvId),
        eq(documents.isDeleted, false),
      ),
    );

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(
      targetMapKey({
        translationGroupId: row.translationGroupId,
        locale: row.locale,
      }),
      row.documentId,
    );
  }
  return map;
}

export type CloneEnvironmentInput = EnvironmentCloneInput & {
  project: string;
  targetEnvironmentId: string;
  attribution: ContentWriteAttribution;
  authorize: EnvironmentResourceAuthorizer;
};

// Spec defaults applied here so the orchestrator can run with a partial
// `EnvironmentCloneInput` (e.g. internal callers, tests) without going
// through the route's Zod assertion.
function resolveCloneDefaults(input: CloneEnvironmentInput) {
  return {
    includeContent: input.include?.content ?? true,
    includeSettings: input.include?.settings ?? false,
    includeDrafts: input.includeDrafts ?? true,
    preservePaths: input.preservePaths ?? true,
  };
}

// `preservePaths: false` keeps the cloned document distinct from the source
// path so the new environment can hold both copies side by side. We append a
// short suffix derived from the new target documentId — deterministic per
// run and short enough to stay within `text` column limits, and uniquely
// salts the path so the (project, env, locale, path) unique index never
// collides with whatever else lives in the target.
function deriveTargetPath(input: {
  sourcePath: string;
  preservePaths: boolean;
  targetDocumentId: string;
}): string {
  if (input.preservePaths) {
    return input.sourcePath;
  }
  const suffix = input.targetDocumentId.slice(0, 8);
  return `${input.sourcePath}.cloned-${suffix}`;
}

export async function cloneEnvironment(
  db: DrizzleDatabase,
  input: CloneEnvironmentInput,
): Promise<EnvironmentCloneResult> {
  const defaults = resolveCloneDefaults(input);

  return db.transaction(
    async (tx) => {
      const txDb = tx as unknown as DrizzleDatabase;
      const scope = await loadProjectScope(txDb, {
        project: input.project,
        sourceEnvId: input.sourceEnvironmentId,
        targetEnvId: input.targetEnvironmentId,
      });

      const permissions: EnvironmentPermission[] = [
        {
          environment: scope.targetName,
          scope: "environments:clone",
          credentialScope: true,
        },
      ];
      if (defaults.includeContent) {
        permissions.push({
          environment: scope.sourceName,
          scope: "content:read",
          credentialScope: true,
        });
        if (defaults.includeDrafts)
          permissions.push({
            environment: scope.sourceName,
            scope: "content:read:draft",
            credentialScope: true,
          });
      }
      if (defaults.includeContent || defaults.includeSettings)
        permissions.push({
          environment: scope.sourceName,
          scope: "schema:read",
          credentialScope: true,
        });
      if (defaults.includeSettings)
        permissions.push({
          environment: scope.targetName,
          scope: "schema:write",
          credentialScope: true,
        });
      await input.authorize(txDb, permissions);
      if (defaults.includeSettings) {
        await copyEnvironmentSettings(txDb, scope);
      }

      if (!defaults.includeContent) {
        return {
          targetEnvironmentId: scope.targetEnvId,
          documentsCloned: 0,
        };
      }

      const sourceContext = await loadSourceContext(txDb, scope, {
        includeDrafts: defaults.includeDrafts,
      });

      if (sourceContext.rows.length === 0) {
        return {
          targetEnvironmentId: scope.targetEnvId,
          documentsCloned: 0,
        };
      }

      // Pre-allocate target document IDs so cross-document references inside
      // the cloned set resolve via the (translationGroupId, locale) key map.
      const targetIdByKey = new Map<string, string>();
      for (const row of sourceContext.rows) {
        const key = targetMapKey({
          translationGroupId: row.translationGroupId,
          locale: row.locale,
        });
        if (targetIdByKey.has(key)) {
          // Source data integrity: should never happen given the active unique
          // index `uniq_documents_active_translation_locale`. Surface clearly.
          throw new RuntimeError({
            code: "INTERNAL_ERROR",
            message:
              "Source environment has duplicate (translation_group_id, locale) tuples for active documents.",
            statusCode: 500,
            details: {
              translationGroupId: row.translationGroupId,
              locale: row.locale,
            },
          });
        }
        targetIdByKey.set(key, randomUUID());
      }

      // Existing target documents (if any) participate in remap so that
      // cross-environment refs to docs already present in target still resolve.
      const existingTargetMap = await loadTargetMap(txDb, scope);
      const targetResolver: ReferenceTargetResolver = (key) => {
        const composed = targetMapKey(key);
        return targetIdByKey.get(composed) ?? existingTargetMap.get(composed);
      };

      let documentsCloned = 0;

      for (const row of sourceContext.rows) {
        const targetDocumentId = targetIdByKey.get(
          targetMapKey({
            translationGroupId: row.translationGroupId,
            locale: row.locale,
          }),
        )!;
        const publishedPayload = sourceContext.publishedByDocumentId.get(
          row.documentId,
        );
        const hasPublishedSnapshot = publishedPayload !== undefined;

        // When `includeDrafts: false` the operator wants the published source
        // state in the target. When `includeDrafts: true` the operator wants
        // the live (possibly draft) state, which is what the documents row
        // holds. The published payload is still used for the version-1 row
        // snapshot below, so a published source row produces target content
        // whose draft and published states accurately mirror the source.
        const headPayload =
          !defaults.includeDrafts && publishedPayload
            ? publishedPayload
            : {
                body: row.body,
                frontmatter: row.frontmatter as Record<string, unknown>,
                path: row.path,
                contentFormat: inferContentFormat(row.body),
                schemaType: row.schemaType,
                locale: row.locale,
              };

        const targetPath = deriveTargetPath({
          sourcePath: headPayload.path,
          preservePaths: defaults.preservePaths,
          targetDocumentId,
        });

        await input.authorize(txDb, [
          {
            environment: scope.sourceName,
            scope: defaults.includeDrafts
              ? "content:read:draft"
              : "content:read",
            path: headPayload.path,
            credentialScope: true,
          },
          {
            environment: scope.targetName,
            scope: "content:write",
            path: targetPath,
            credentialScope: false,
          },
          ...(publishedPayload
            ? [
                {
                  environment: scope.sourceName,
                  scope: "content:read" as const,
                  path: publishedPayload.path,
                  credentialScope: true,
                },
                {
                  environment: scope.targetName,
                  scope: "content:publish" as const,
                  path: deriveTargetPath({
                    sourcePath: publishedPayload.path,
                    preservePaths: defaults.preservePaths,
                    targetDocumentId,
                  }),
                  credentialScope: false,
                },
              ]
            : []),
        ]);
        const headRemap = await authorizedRemap(
          txDb,
          scope,
          input.authorize,
          defaults.includeDrafts,
          {
            schema: sourceContext.schemaByType.get(headPayload.schemaType),
            frontmatter: headPayload.frontmatter,
            sourceLookup: sourceContext.sourceLookup,
            targetResolver,
            sourceDocumentId: row.documentId,
          },
        );

        try {
          await txDb.insert(documents).values({
            documentId: targetDocumentId,
            translationGroupId: row.translationGroupId,
            projectId: scope.projectId,
            environmentId: scope.targetEnvId,
            path: targetPath,
            schemaType: headPayload.schemaType,
            locale: headPayload.locale,
            contentFormat: inferContentFormat(headPayload.body),
            body: headPayload.body,
            frontmatter: headRemap.frontmatter,
            isDeleted: false,
            hasUnpublishedChanges: !hasPublishedSnapshot,
            publishedVersion: null,
            draftRevision: 1,
            createdBy: input.attribution.actorId,
            createdOrigin: input.attribution.origin,
            updatedBy: input.attribution.actorId,
            updatedOrigin: input.attribution.origin,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw buildConflictError(
              "Target environment already contains content that conflicts with the clone payload.",
              {
                targetEnvironmentId: scope.targetEnvId,
                path: targetPath,
                locale: row.locale,
                translationGroupId: row.translationGroupId,
                preservePaths: defaults.preservePaths,
              },
            );
          }
          throw error;
        }

        if (hasPublishedSnapshot && publishedPayload) {
          // Version-1 in the target carries the *published* source state, even
          // when `includeDrafts: true` and the head row reflects the draft,
          // so consumers querying the target as "published" see exactly what
          // was published on the source side. Full version history is
          // intentionally not copied (SPEC-009 #Cloning).
          const publishedRemap = await authorizedRemap(
            txDb,
            scope,
            input.authorize,
            false,
            {
              schema: sourceContext.schemaByType.get(
                publishedPayload.schemaType,
              ),
              frontmatter: publishedPayload.frontmatter,
              sourceLookup: sourceContext.sourceLookup,
              targetResolver,
              sourceDocumentId: row.documentId,
            },
          );
          const publishedPath = deriveTargetPath({
            sourcePath: publishedPayload.path,
            preservePaths: defaults.preservePaths,
            targetDocumentId,
          });
          await txDb.insert(documentVersions).values({
            documentId: targetDocumentId,
            translationGroupId: row.translationGroupId,
            projectId: scope.projectId,
            environmentId: scope.targetEnvId,
            schemaType: publishedPayload.schemaType,
            locale: publishedPayload.locale,
            contentFormat: inferContentFormat(publishedPayload.body),
            path: publishedPath,
            body: publishedPayload.body,
            frontmatter: publishedRemap.frontmatter,
            version: 1,
            publishedBy: input.attribution.actorId,
            publishedOrigin: input.attribution.origin,
            changeSummary: "Cloned from source environment.",
          });
          await txDb
            .update(documents)
            .set({
              publishedVersion: 1,
              hasUnpublishedChanges: !defaults.includeDrafts
                ? false
                : // If includeDrafts is true and the head and published payloads
                  // differ, the target row holds draft content distinct from its
                  // published v1, so `hasUnpublishedChanges` is true.
                  headPayload.body !== publishedPayload.body ||
                  JSON.stringify(headPayload.frontmatter) !==
                    JSON.stringify(publishedPayload.frontmatter) ||
                  headPayload.path !== publishedPayload.path,
            })
            .where(eq(documents.documentId, targetDocumentId));
        }

        documentsCloned += 1;
      }

      return {
        targetEnvironmentId: scope.targetEnvId,
        documentsCloned,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

async function copyEnvironmentSettings(
  db: DrizzleDatabase,
  scope: ScopeRow,
): Promise<void> {
  const sourceSync = await db.query.schemaSyncs.findFirst({
    where: and(
      eq(schemaSyncs.projectId, scope.projectId),
      eq(schemaSyncs.environmentId, scope.sourceEnvId),
    ),
  });

  if (!sourceSync) {
    return;
  }

  await db
    .insert(schemaSyncs)
    .values({
      projectId: scope.projectId,
      environmentId: scope.targetEnvId,
      schemaHash: sourceSync.schemaHash,
      rawConfigSnapshot: sourceSync.rawConfigSnapshot,
    })
    .onConflictDoUpdate({
      target: [schemaSyncs.projectId, schemaSyncs.environmentId],
      set: {
        schemaHash: sourceSync.schemaHash,
        rawConfigSnapshot: sourceSync.rawConfigSnapshot,
        syncedAt: new Date(),
      },
    });

  const sourceRegistry = await db
    .select()
    .from(schemaRegistryEntries)
    .where(
      and(
        eq(schemaRegistryEntries.projectId, scope.projectId),
        eq(schemaRegistryEntries.environmentId, scope.sourceEnvId),
      ),
    );

  for (const entry of sourceRegistry) {
    await db
      .insert(schemaRegistryEntries)
      .values({
        projectId: scope.projectId,
        environmentId: scope.targetEnvId,
        schemaType: entry.schemaType,
        directory: entry.directory,
        localized: entry.localized,
        schemaHash: entry.schemaHash,
        resolvedSchema: entry.resolvedSchema,
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
          schemaHash: entry.schemaHash,
          resolvedSchema: entry.resolvedSchema,
          syncedAt: new Date(),
        },
      });
  }
}

export type PromoteEnvironmentInput = EnvironmentPromoteInput & {
  activeCollaboration?: ContentActiveCollaborationChecker;
  project: string;
  targetEnvironmentId: string;
  attribution: ContentWriteAttribution;
  authorize: EnvironmentResourceAuthorizer;
};

export async function promoteDocuments(
  db: DrizzleDatabase,
  input: PromoteEnvironmentInput,
): Promise<EnvironmentPromoteResult> {
  // Apply spec defaults so internal callers (and tests) can pass a partial
  // input without round-tripping through the route validator.
  const includeUnpublished = input.includeUnpublished ?? false;
  const dryRun = input.dryRun ?? false;
  const callerPreallocations = input.preallocatedTargetIds ?? {};

  return db.transaction(
    async (tx) => {
      const txDb = tx as unknown as DrizzleDatabase;
      const scope = await loadProjectScope(txDb, {
        project: input.project,
        sourceEnvId: input.sourceEnvironmentId,
        targetEnvId: input.targetEnvironmentId,
      });

      await input.authorize(txDb, [
        {
          environment: scope.targetName,
          scope: "environments:promote",
          credentialScope: true,
        },
        {
          environment: scope.sourceName,
          scope: "content:read:draft",
          credentialScope: true,
        },
        {
          environment: scope.sourceName,
          scope: "schema:read",
          credentialScope: true,
        },
      ]);
      const sourceContext = await loadSourceContext(txDb, scope, {
        documentIds: input.documentIds,
        // Promote loads all matching rows regardless of publish state; the
        // include-unpublished gate is applied below per-row to drive the
        // `skipped_unpublished` status in the result.
        includeDrafts: true,
      });

      const requestedSet = new Set(input.documentIds);
      const foundIds = new Set(sourceContext.rows.map((row) => row.documentId));
      const missing = [...requestedSet].filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw buildScopeError(
          "One or more document IDs were not found in the source environment.",
          {
            missingDocumentIds: missing,
            sourceEnvironmentId: scope.sourceEnvId,
          },
        );
      }

      const targetMap = await loadTargetMap(txDb, scope);

      // Pre-populate the target map with "would-be-created" ids for rows that
      // don't yet have a target match. This lets the remap walker resolve
      // references between docs in the same promoted batch, both during
      // dry-run (no writes) and during the real run (in-progress creations).
      // The pre-allocated id matches the id used by `createTargetDraft` when
      // the row is actually written.
      //
      // When the caller supplied `preallocatedTargetIds` (typically the
      // dry-run result replayed back into a real run), we reuse those ids
      // for deterministic replay. Anything not in the caller map falls back
      // to a fresh UUID.
      const preallocatedTargetIds = new Map<string, string>();
      for (const row of sourceContext.rows) {
        await input.authorize(txDb, [
          {
            environment: scope.sourceName,
            scope: "content:read:draft",
            path: row.path,
            credentialScope: true,
          },
        ]);
        if (!includeUnpublished && row.publishedVersion === null) {
          continue;
        }
        const key = targetMapKey({
          translationGroupId: row.translationGroupId,
          locale: row.locale,
        });
        if (!targetMap.has(key)) {
          const allocated =
            callerPreallocations[row.documentId] ?? randomUUID();
          targetMap.set(key, allocated);
          preallocatedTargetIds.set(key, allocated);
        }
      }

      const targetResolver: ReferenceTargetResolver = (key) =>
        targetMap.get(targetMapKey(key));

      const promoted: DocumentPromotionResult[] = [];

      for (const row of sourceContext.rows) {
        await input.authorize(txDb, [
          {
            environment: scope.sourceName,
            scope: "content:read:draft",
            path: row.path,
            credentialScope: true,
          },
        ]);
        if (!includeUnpublished && row.publishedVersion === null) {
          promoted.push({
            sourceDocumentId: row.documentId,
            targetDocumentId:
              targetMap.get(
                targetMapKey({
                  translationGroupId: row.translationGroupId,
                  locale: row.locale,
                }),
              ) ?? null,
            status: "skipped_unpublished",
            path: row.path,
            locale: row.locale,
            type: row.schemaType,
            publishedVersion: null,
            remappedReferences: 0,
          });
          continue;
        }

        const key = targetMapKey({
          translationGroupId: row.translationGroupId,
          locale: row.locale,
        });
        const preallocatedId = preallocatedTargetIds.get(key);
        // `existingTargetId` is the *real* target id only if the row already
        // existed before this batch; preallocated ids represent rows we plan
        // to create within this same batch.
        const existingTargetId = preallocatedId
          ? undefined
          : targetMap.get(key);

        const targetRow = existingTargetId
          ? await txDb.query.documents.findFirst({
              where: eq(documents.documentId, existingTargetId),
            })
          : undefined;
        await input.authorize(
          txDb,
          [
            ...new Set([row.path, ...(targetRow ? [targetRow.path] : [])]),
          ].flatMap((path) => [
            {
              environment: scope.targetName,
              scope: "content:write" as const,
              path,
              credentialScope: false,
            },
            {
              environment: scope.targetName,
              scope: "content:publish" as const,
              path,
              credentialScope: false,
            },
          ]),
        );
        const schema = sourceContext.schemaByType.get(row.schemaType);
        const remap = await authorizedRemap(
          txDb,
          scope,
          input.authorize,
          true,
          {
            schema,
            frontmatter: row.frontmatter as Record<string, unknown>,
            sourceLookup: sourceContext.sourceLookup,
            targetResolver,
            sourceDocumentId: row.documentId,
          },
        );

        if (dryRun) {
          promoted.push({
            sourceDocumentId: row.documentId,
            targetDocumentId: existingTargetId ?? preallocatedId ?? null,
            status: existingTargetId ? "overwrote" : "created",
            path: row.path,
            locale: row.locale,
            type: row.schemaType,
            // We can't know the published version without doing the write; the
            // contract reports `null` for created and the *current* published
            // version for overwrote so consumers can show "v3 -> v4".
            publishedVersion: null,
            remappedReferences: remap.remappedReferences,
          });
          continue;
        }

        if (
          existingTargetId &&
          (await input.activeCollaboration?.isDocumentActive(existingTargetId))
        ) {
          throw createDocumentCollaborationActiveError(existingTargetId);
        }
        const targetDocumentId =
          existingTargetId ??
          (await createTargetDraft(txDb, {
            scope,
            source: row,
            remappedFrontmatter: remap.frontmatter,
            attribution: input.attribution,
            preallocatedId,
          }));

        if (existingTargetId) {
          await overwriteTargetDraft(txDb, {
            scope,
            targetDocumentId: existingTargetId,
            source: row,
            remappedFrontmatter: remap.frontmatter,
            attribution: input.attribution,
          });
        }

        const publishedVersion = await publishTargetDocument(txDb, {
          scope,
          targetDocumentId,
          source: row,
          remappedFrontmatter: remap.frontmatter,
          attribution: input.attribution,
        });

        // Record the new target id so subsequent promoted rows that reference
        // this one can resolve via the in-progress map.
        targetMap.set(key, targetDocumentId);

        promoted.push({
          sourceDocumentId: row.documentId,
          targetDocumentId,
          status: existingTargetId ? "overwrote" : "created",
          path: row.path,
          locale: row.locale,
          type: row.schemaType,
          publishedVersion,
          remappedReferences: remap.remappedReferences,
        });
      }

      return { promoted };
    },
    { isolationLevel: "repeatable read" },
  );
}

async function createTargetDraft(
  db: DrizzleDatabase,
  input: {
    scope: ScopeRow;
    source: SourceDocumentRow;
    remappedFrontmatter: Record<string, unknown>;
    attribution: ContentWriteAttribution;
    // When provided, used instead of generating a new UUID. The caller
    // pre-allocates these so cross-document references resolve via the
    // remap target map (and so dryRun reports the same id that the real
    // run would produce).
    preallocatedId?: string;
  },
): Promise<string> {
  const targetDocumentId = input.preallocatedId ?? randomUUID();
  try {
    await db.insert(documents).values({
      documentId: targetDocumentId,
      translationGroupId: input.source.translationGroupId,
      projectId: input.scope.projectId,
      environmentId: input.scope.targetEnvId,
      path: input.source.path,
      schemaType: input.source.schemaType,
      locale: input.source.locale,
      contentFormat: inferContentFormat(input.source.body),
      body: input.source.body,
      frontmatter: input.remappedFrontmatter,
      isDeleted: false,
      hasUnpublishedChanges: true,
      publishedVersion: null,
      draftRevision: 1,
      createdBy: input.attribution.actorId,
      createdOrigin: input.attribution.origin,
      updatedBy: input.attribution.actorId,
      updatedOrigin: input.attribution.origin,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw buildConflictError(
        "Promote target conflicts with existing content (path or translation pair).",
        {
          targetEnvironmentId: input.scope.targetEnvId,
          path: input.source.path,
          locale: input.source.locale,
          translationGroupId: input.source.translationGroupId,
        },
      );
    }
    throw error;
  }
  return targetDocumentId;
}

async function overwriteTargetDraft(
  db: DrizzleDatabase,
  input: {
    scope: ScopeRow;
    targetDocumentId: string;
    source: SourceDocumentRow;
    remappedFrontmatter: Record<string, unknown>;
    attribution: ContentWriteAttribution;
  },
): Promise<void> {
  // Updates can hit the same `(projectId, environmentId, locale, path)`
  // unique index that creates do — for example when the source row's path
  // already belongs to a different active target document. Surface this as
  // the same 409 conflict shape `createTargetDraft` produces so the caller
  // never sees a raw 23505 bubbled into a 500.
  try {
    await db
      .update(documents)
      .set({
        schemaType: input.source.schemaType,
        contentFormat: inferContentFormat(input.source.body),
        body: input.source.body,
        frontmatter: input.remappedFrontmatter,
        path: input.source.path,
        locale: input.source.locale,
        isDeleted: false,
        hasUnpublishedChanges: true,
        draftRevision: sql`${documents.draftRevision} + 1`,
        updatedBy: input.attribution.actorId,
        updatedOrigin: input.attribution.origin,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.projectId, input.scope.projectId),
          eq(documents.environmentId, input.scope.targetEnvId),
          eq(documents.documentId, input.targetDocumentId),
        ),
      );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw buildConflictError(
        "Promote target conflicts with existing content (path or translation pair).",
        {
          targetEnvironmentId: input.scope.targetEnvId,
          targetDocumentId: input.targetDocumentId,
          path: input.source.path,
          locale: input.source.locale,
          translationGroupId: input.source.translationGroupId,
        },
      );
    }
    throw error;
  }
}

async function publishTargetDocument(
  db: DrizzleDatabase,
  input: {
    scope: ScopeRow;
    targetDocumentId: string;
    source: SourceDocumentRow;
    remappedFrontmatter: Record<string, unknown>;
    attribution: ContentWriteAttribution;
  },
): Promise<number> {
  const [latest] = await db
    .select({
      value: sql<number>`coalesce(max(${documentVersions.version}), 0)`,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, input.targetDocumentId));

  const nextVersion = (latest?.value ?? 0) + 1;
  await db.insert(documentVersions).values({
    documentId: input.targetDocumentId,
    translationGroupId: input.source.translationGroupId,
    projectId: input.scope.projectId,
    environmentId: input.scope.targetEnvId,
    schemaType: input.source.schemaType,
    locale: input.source.locale,
    contentFormat: inferContentFormat(input.source.body),
    path: input.source.path,
    body: input.source.body,
    frontmatter: input.remappedFrontmatter,
    version: nextVersion,
    publishedBy: input.attribution.actorId,
    publishedOrigin: input.attribution.origin,
    changeSummary: "Promoted from source environment.",
  });

  await db
    .update(documents)
    .set({
      publishedVersion: nextVersion,
      hasUnpublishedChanges: false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documents.projectId, input.scope.projectId),
        eq(documents.environmentId, input.scope.targetEnvId),
        eq(documents.documentId, input.targetDocumentId),
      ),
    );

  return nextVersion;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

/** Authorize every referenced source before exposing either remap output or errors. */
async function authorizedRemap(
  db: DrizzleDatabase,
  scope: ScopeRow,
  authorize: EnvironmentResourceAuthorizer,
  draft: boolean,
  input: RemapInput,
) {
  const references = new Set<string>();
  let result: ReturnType<typeof remapFrontmatterReferences> | undefined;
  let failure: unknown;
  try {
    result = remapFrontmatterReferences({
      ...input,
      sourceLookup: (id) => {
        references.add(id);
        return input.sourceLookup(id);
      },
    });
  } catch (error) {
    failure = error;
  }
  for (const id of references) {
    const row = await db.query.documents.findFirst({
      where: and(
        eq(documents.projectId, scope.projectId),
        eq(documents.environmentId, scope.sourceEnvId),
        eq(documents.documentId, id),
      ),
    });
    if (!row) continue;
    let path = row.path;
    if (!draft) {
      const published =
        row.publishedVersion === null
          ? undefined
          : await db.query.documentVersions.findFirst({
              where: and(
                eq(documentVersions.documentId, id),
                eq(documentVersions.version, row.publishedVersion),
              ),
            });
      if (!published)
        throw new RuntimeError({
          code: "FORBIDDEN",
          message: "Referenced source is not readable.",
          statusCode: 403,
        });
      path = published.path;
    }
    await authorize(db, [
      {
        environment: scope.sourceName,
        scope: draft ? "content:read:draft" : "content:read",
        path,
        credentialScope: true,
      },
    ]);
  }
  if (failure) throw failure;
  return result!;
}
