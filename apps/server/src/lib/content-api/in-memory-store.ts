import { randomUUID } from "node:crypto";

import { RuntimeError, type SchemaRegistryTypeSnapshot } from "@mdcms/shared";

import {
  DEFAULT_ACTOR,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type ContentDocument,
  type ContentPublishedSnapshot,
  type ContentScope,
  type ContentStore,
  type ContentVariantSummary,
  type ContentVersionDocument,
  type ContentVersionSummary,
  type ContentWriteOperationOptions,
  type CreateInMemoryContentStoreOptions,
  sortVariantSummaries,
} from "./types.js";
import {
  assertJsonObject,
  assertRequiredString,
  parseBoolean,
  parseContentListGroupBy,
  parseContentFormat,
  parseOptionalString,
  parsePositiveInt,
  parseSortField,
  validateContentPath,
  parseSortOrder,
} from "./parsing.js";
import { groupDocumentsByTranslationGroup } from "./grouped-list.js";
import { validateReferenceFieldIdentities } from "./reference-validation.js";
import { matchesDeletedListVisibility } from "./visibility.js";

function toScopeKey(project: string, environment: string): string {
  return `${project}::${environment}`;
}

export function createInMemoryContentStore(
  options: CreateInMemoryContentStoreOptions = {},
): ContentStore {
  const scopedDocs = new Map<string, Map<string, ContentDocument>>();
  const scopedPublishedSnapshots = new Map<
    string,
    Map<string, Map<number, ContentPublishedSnapshot>>
  >();
  const scopedSchemas = new Map<
    string,
    Map<string, SchemaRegistryTypeSnapshot>
  >();
  const scopedLocales = new Map<
    string,
    {
      defaultLocale?: string;
      supportedLocales?: string[];
    }
  >();

  for (const scope of options.schemaScopes ?? []) {
    if (scope.locales) {
      scopedLocales.set(toScopeKey(scope.project, scope.environment), {
        defaultLocale: scope.locales.default?.trim() || undefined,
        supportedLocales:
          scope.locales.supported
            ?.map((locale) => locale.trim())
            .filter((locale) => locale.length > 0) ?? undefined,
      });
    }
    scopedSchemas.set(
      toScopeKey(scope.project, scope.environment),
      new Map(Object.entries(scope.schemas)),
    );
  }

  function getScopeStore(scope: ContentScope): Map<string, ContentDocument> {
    const key = toScopeKey(scope.project, scope.environment);
    let store = scopedDocs.get(key);

    if (!store) {
      store = new Map<string, ContentDocument>();
      scopedDocs.set(key, store);
    }

    return store;
  }

  function getScopePublishedSnapshots(
    scope: ContentScope,
  ): Map<string, Map<number, ContentPublishedSnapshot>> {
    const key = toScopeKey(scope.project, scope.environment);
    let store = scopedPublishedSnapshots.get(key);

    if (!store) {
      store = new Map();
      scopedPublishedSnapshots.set(key, store);
    }

    return store;
  }

  function getScopeSchemas(
    scope: ContentScope,
  ): Map<string, SchemaRegistryTypeSnapshot> | undefined {
    return scopedSchemas.get(toScopeKey(scope.project, scope.environment));
  }

  function getScopeLocales(scope: ContentScope):
    | {
        defaultLocale?: string;
        supportedLocales?: string[];
      }
    | undefined {
    return scopedLocales.get(toScopeKey(scope.project, scope.environment));
  }

  function findPathConflict(
    store: Map<string, ContentDocument>,
    input: {
      path: string;
      locale: string;
      documentId?: string;
    },
  ): ContentDocument | undefined {
    for (const candidate of store.values()) {
      if (
        candidate.documentId !== input.documentId &&
        candidate.path === input.path &&
        candidate.locale === input.locale &&
        candidate.isDeleted === false
      ) {
        return candidate;
      }
    }

    return undefined;
  }

  function findTranslationLocaleConflict(
    store: Map<string, ContentDocument>,
    input: {
      translationGroupId: string;
      locale: string;
      documentId?: string;
    },
  ): ContentDocument | undefined {
    for (const candidate of store.values()) {
      if (
        candidate.documentId !== input.documentId &&
        candidate.translationGroupId === input.translationGroupId &&
        candidate.locale === input.locale &&
        candidate.isDeleted === false
      ) {
        return candidate;
      }
    }

    return undefined;
  }

  function resolveReadDocument(input: {
    document: ContentDocument;
    draft: boolean;
    publishedSnapshots: Map<string, Map<number, ContentPublishedSnapshot>>;
  }): ContentDocument | undefined {
    if (input.draft) {
      return input.document;
    }

    if (input.document.isDeleted || input.document.publishedVersion === null) {
      return undefined;
    }

    const snapshot = input.publishedSnapshots
      .get(input.document.documentId)
      ?.get(input.document.publishedVersion);

    if (!snapshot) {
      return undefined;
    }

    return {
      ...input.document,
      path: snapshot.path,
      type: snapshot.type,
      locale: snapshot.locale,
      format: snapshot.format,
      frontmatter: snapshot.frontmatter,
      body: snapshot.body,
      version: snapshot.version,
      updatedAt: snapshot.publishedAt,
      updatedBy: snapshot.publishedBy,
    };
  }

  function toVersionSummary(
    scope: ContentScope,
    document: ContentDocument,
    snapshot: ContentPublishedSnapshot,
  ): ContentVersionSummary {
    return {
      documentId: document.documentId,
      translationGroupId: document.translationGroupId,
      project: scope.project,
      environment: scope.environment,
      version: snapshot.version,
      path: snapshot.path,
      type: snapshot.type,
      locale: snapshot.locale,
      format: snapshot.format,
      publishedAt: snapshot.publishedAt,
      publishedBy: snapshot.publishedBy,
      changeSummary: snapshot.changeSummary,
    };
  }

  function toVersionDocument(
    scope: ContentScope,
    document: ContentDocument,
    snapshot: ContentPublishedSnapshot,
  ): ContentVersionDocument {
    return {
      ...toVersionSummary(scope, document, snapshot),
      frontmatter: snapshot.frontmatter,
      body: snapshot.body,
    };
  }

  function getNextVersionNumber(
    snapshots: Map<number, ContentPublishedSnapshot>,
  ): number {
    return (
      [...snapshots.keys()].reduce(
        (maxVersion, candidateVersion) =>
          candidateVersion > maxVersion ? candidateVersion : maxVersion,
        0,
      ) + 1
    );
  }

  return {
    async getSchema(scope, type) {
      const normalizedType = assertRequiredString(type, "type");
      return scopedSchemas
        .get(toScopeKey(scope.project, scope.environment))
        ?.get(normalizedType);
    },

    async create(scope, payload, _options?: ContentWriteOperationOptions) {
      const store = getScopeStore(scope);
      const scopeSchemas = getScopeSchemas(scope);
      const path = validateContentPath(
        assertRequiredString(payload.path, "path"),
      );
      const type = assertRequiredString(payload.type, "type");
      const locale = assertRequiredString(payload.locale, "locale");
      const sourceDocumentId = parseOptionalString(
        payload.sourceDocumentId,
        "sourceDocumentId",
      );
      const body = assertRequiredString(payload.body, "body", {
        allowEmpty: true,
      });
      const frontmatter = assertJsonObject(payload.frontmatter, "frontmatter");
      const format = parseContentFormat(payload.format);
      const sourceDocument = sourceDocumentId
        ? store.get(sourceDocumentId)
        : undefined;

      if (sourceDocumentId && (!sourceDocument || sourceDocument.isDeleted)) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: sourceDocumentId,
          },
        });
      }

      if (sourceDocument && sourceDocument.type !== type) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            'Field "type" must match the source document type when creating a translation variant.',
          statusCode: 400,
          details: {
            field: "type",
            sourceDocumentId,
          },
        });
      }

      const schema = scopeSchemas?.get(type);

      if (!schema) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: 'Field "type" must reference a synced schema type.',
          statusCode: 400,
          details: {
            field: "type",
            type,
          },
        });
      }

      await validateReferenceFieldIdentities({
        schema,
        frontmatter,
        lookupTarget: async (documentId) => {
          const target = store.get(documentId);

          if (!target) {
            return undefined;
          }

          return {
            documentId: target.documentId,
            type: target.type,
            isDeleted: target.isDeleted,
          };
        },
      });

      const conflict = findPathConflict(store, { path, locale });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path,
            locale,
          },
        });
      }

      const translationGroupId =
        sourceDocument?.translationGroupId ?? randomUUID();
      const translationConflict = findTranslationLocaleConflict(store, {
        translationGroupId,
        locale,
      });

      if (translationConflict) {
        throw new RuntimeError({
          code: "TRANSLATION_VARIANT_CONFLICT",
          message:
            "A non-deleted document with the same translation group and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: translationConflict.documentId,
            translationGroupId,
            locale,
          },
        });
      }

      const now = new Date().toISOString();
      const actor = payload.createdBy?.trim() || DEFAULT_ACTOR;
      const document: ContentDocument = {
        documentId: randomUUID(),
        translationGroupId,
        project: scope.project,
        environment: scope.environment,
        path,
        type,
        locale,
        format,
        isDeleted: false,
        hasUnpublishedChanges: true,
        version: 0,
        publishedVersion: null,
        draftRevision: 1,
        frontmatter,
        body,
        createdBy: actor,
        createdAt: now,
        updatedBy: actor,
        updatedAt: now,
      };

      store.set(document.documentId, document);
      return document;
    },

    async list(scope, query) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const limit = parsePositiveInt(query.limit, "limit", {
        defaultValue: DEFAULT_LIMIT,
        min: 1,
        max: MAX_LIMIT,
      });
      const offset = parsePositiveInt(query.offset, "offset", {
        defaultValue: 0,
        min: 0,
      });
      const published = parseBoolean(query.published, "published");
      const isDeleted = parseBoolean(query.isDeleted, "isDeleted");
      const hasUnpublishedChanges = parseBoolean(
        query.hasUnpublishedChanges,
        "hasUnpublishedChanges",
      );
      const sort = parseSortField(query.sort);
      const order = parseSortOrder(query.order);
      const draft = parseBoolean(query.draft, "draft") === true;

      const normalizedType = query.type?.trim();
      const normalizedPath = query.path?.trim();
      const normalizedLocale = query.locale?.trim();
      const normalizedSlug = query.slug?.trim();
      const normalizedQ = query.q?.trim().toLowerCase();
      const groupBy = parseContentListGroupBy(query.groupBy);

      const rows = [...store.values()]
        .map((document) =>
          resolveReadDocument({
            document,
            draft,
            publishedSnapshots,
          }),
        )
        .filter((doc): doc is ContentDocument => Boolean(doc))
        .filter((doc) => {
          if (normalizedType && doc.type !== normalizedType) {
            return false;
          }

          if (normalizedPath && !doc.path.startsWith(normalizedPath)) {
            return false;
          }

          if (normalizedLocale && doc.locale !== normalizedLocale) {
            return false;
          }

          if (
            normalizedSlug &&
            String(doc.frontmatter.slug ?? "").trim() !== normalizedSlug
          ) {
            return false;
          }

          if (published !== undefined) {
            const isPublished = doc.publishedVersion !== null;

            if (isPublished !== published) {
              return false;
            }
          }

          if (!matchesDeletedListVisibility(doc, { draft, isDeleted })) {
            return false;
          }

          if (
            hasUnpublishedChanges !== undefined &&
            doc.hasUnpublishedChanges !== hasUnpublishedChanges
          ) {
            return false;
          }

          if (normalizedQ) {
            const haystack =
              `${doc.path}\n${doc.body}\n${JSON.stringify(doc.frontmatter)}`.toLowerCase();

            if (!haystack.includes(normalizedQ)) {
              return false;
            }
          }

          return true;
        });

      const scopeLocales = getScopeLocales(scope);
      const sortedRows =
        groupBy === "translationGroup" && normalizedType
          ? groupDocumentsByTranslationGroup({
              matchedRows: rows,
              allRows: [...store.values()]
                .map((document) =>
                  resolveReadDocument({
                    document,
                    draft,
                    publishedSnapshots,
                  }),
                )
                .filter((doc): doc is ContentDocument => Boolean(doc))
                .filter(
                  (doc) =>
                    doc.type === normalizedType && doc.isDeleted === false,
                ),
              sort,
              order,
              defaultLocale: scopeLocales?.defaultLocale,
              supportedLocales: scopeLocales?.supportedLocales,
            })
          : rows.sort((left, right) => {
              let compared = 0;

              if (sort === "path") {
                compared = left.path.localeCompare(right.path);
              } else if (sort === "createdAt") {
                compared = left.createdAt.localeCompare(right.createdAt);
              } else {
                compared = left.updatedAt.localeCompare(right.updatedAt);
              }

              return order === "asc" ? compared : compared * -1;
            });

      const total = sortedRows.length;
      const pagedRows = sortedRows.slice(offset, offset + limit);

      return {
        rows: pagedRows,
        total,
        limit,
        offset,
      };
    },

    async getOverviewCounts(scope, input) {
      const requestedTypes = [
        ...new Set(input.types.map((type) => type.trim())),
      ];
      const countsByType = new Map(
        requestedTypes.map((type) => [
          type,
          {
            type,
            total: 0,
            published: 0,
            drafts: 0,
          },
        ]),
      );

      for (const document of getScopeStore(scope).values()) {
        if (document.isDeleted) {
          continue;
        }

        const counts = countsByType.get(document.type);

        if (!counts) {
          continue;
        }

        counts.total += 1;

        if (document.publishedVersion === null) {
          counts.drafts += 1;
        } else {
          counts.published += 1;
        }
      }

      return requestedTypes.map((type) => countsByType.get(type)!);
    },

    async getById(scope, documentId, options) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        return undefined;
      }

      return resolveReadDocument({
        document: existing,
        draft: options?.draft === true,
        publishedSnapshots,
      });
    },

    async update(
      scope,
      documentId,
      payload,
      options?: ContentWriteOperationOptions,
    ) {
      const store = getScopeStore(scope);
      const scopeSchemas = getScopeSchemas(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing || existing.isDeleted) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      if (
        options?.expectedDraftRevision !== undefined &&
        existing.draftRevision !== options.expectedDraftRevision
      ) {
        throw new RuntimeError({
          code: "STALE_DRAFT_REVISION",
          message:
            "Draft has been modified since your last pull. Run 'cms pull' to get the latest version.",
          statusCode: 409,
          details: {
            documentId: normalizedDocumentId,
            expectedDraftRevision: options.expectedDraftRevision,
            currentDraftRevision: existing.draftRevision,
          },
        });
      }

      const nextType =
        payload.type !== undefined
          ? assertRequiredString(payload.type, "type")
          : existing.type;
      const nextFrontmatter =
        payload.frontmatter !== undefined
          ? assertJsonObject(payload.frontmatter, "frontmatter")
          : existing.frontmatter;
      const schema = scopeSchemas?.get(nextType);

      if (!schema) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: 'Field "type" must reference a synced schema type.',
          statusCode: 400,
          details: {
            field: "type",
            type: nextType,
          },
        });
      }

      await validateReferenceFieldIdentities({
        schema,
        frontmatter: nextFrontmatter,
        lookupTarget: async (candidateDocumentId) => {
          const target = store.get(candidateDocumentId);

          if (!target) {
            return undefined;
          }

          return {
            documentId: target.documentId,
            type: target.type,
            isDeleted: target.isDeleted,
          };
        },
      });

      const nextPath =
        payload.path !== undefined
          ? validateContentPath(assertRequiredString(payload.path, "path"))
          : existing.path;
      const nextLocale =
        payload.locale !== undefined
          ? assertRequiredString(payload.locale, "locale")
          : existing.locale;
      const conflict = findPathConflict(store, {
        path: nextPath,
        locale: nextLocale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path: nextPath,
            locale: nextLocale,
          },
        });
      }

      const translationConflict = findTranslationLocaleConflict(store, {
        translationGroupId: existing.translationGroupId,
        locale: nextLocale,
        documentId: normalizedDocumentId,
      });

      if (translationConflict) {
        throw new RuntimeError({
          code: "TRANSLATION_VARIANT_CONFLICT",
          message:
            "A non-deleted document with the same translation group and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: translationConflict.documentId,
            translationGroupId: existing.translationGroupId,
            locale: nextLocale,
          },
        });
      }

      const now = new Date().toISOString();
      const updated: ContentDocument = {
        ...existing,
        path: nextPath,
        type: nextType,
        locale: nextLocale,
        format:
          payload.format !== undefined
            ? parseContentFormat(payload.format)
            : existing.format,
        frontmatter: nextFrontmatter,
        body:
          payload.body !== undefined
            ? assertRequiredString(payload.body, "body", { allowEmpty: true })
            : existing.body,
        hasUnpublishedChanges: true,
        draftRevision: existing.draftRevision + 1,
        updatedBy: payload.updatedBy?.trim() || DEFAULT_ACTOR,
        updatedAt: now,
      };

      store.set(normalizedDocumentId, updated);
      return updated;
    },

    async softDelete(scope, documentId) {
      const store = getScopeStore(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const now = new Date().toISOString();
      const deleted: ContentDocument = {
        ...existing,
        isDeleted: true,
        hasUnpublishedChanges: true,
        draftRevision: existing.draftRevision + 1,
        updatedBy: DEFAULT_ACTOR,
        updatedAt: now,
      };
      store.set(normalizedDocumentId, deleted);

      return deleted;
    },

    async restore(scope, documentId) {
      const store = getScopeStore(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const conflict = findPathConflict(store, {
        path: existing.path,
        locale: existing.locale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path: existing.path,
            locale: existing.locale,
          },
        });
      }

      const restored: ContentDocument = {
        ...existing,
        isDeleted: false,
        updatedBy: DEFAULT_ACTOR,
        updatedAt: new Date().toISOString(),
      };
      store.set(normalizedDocumentId, restored);

      return restored;
    },

    async listVersions(scope, documentId, query = {}) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const limit = parsePositiveInt(query.limit, "limit", {
        defaultValue: DEFAULT_LIMIT,
        min: 1,
        max: MAX_LIMIT,
      });
      const offset = parsePositiveInt(query.offset, "offset", {
        defaultValue: 0,
        min: 0,
      });
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const snapshots = [
        ...(publishedSnapshots.get(normalizedDocumentId)?.values() ?? []),
      ].sort((left, right) => right.version - left.version);

      return {
        rows: snapshots
          .slice(offset, offset + limit)
          .map((snapshot) => toVersionSummary(scope, existing, snapshot)),
        total: snapshots.length,
        limit,
        offset,
      };
    },

    async getVersion(scope, documentId, version) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const snapshot = publishedSnapshots
        .get(normalizedDocumentId)
        ?.get(version);

      if (!snapshot) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Version not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
            version,
          },
        });
      }

      return toVersionDocument(scope, existing, snapshot);
    },

    async restoreVersion(scope, documentId, version, input) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const documentSnapshots =
        publishedSnapshots.get(normalizedDocumentId) ?? new Map();
      if (!publishedSnapshots.has(normalizedDocumentId)) {
        publishedSnapshots.set(normalizedDocumentId, documentSnapshots);
      }

      const snapshot = documentSnapshots.get(version);

      if (!snapshot) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Version not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
            version,
          },
        });
      }

      const conflict = findPathConflict(store, {
        path: snapshot.path,
        locale: snapshot.locale,
        documentId: normalizedDocumentId,
      });

      if (conflict) {
        throw new RuntimeError({
          code: "CONTENT_PATH_CONFLICT",
          message:
            "A non-deleted document with the same path and locale already exists.",
          statusCode: 409,
          details: {
            conflictDocumentId: conflict.documentId,
            path: snapshot.path,
            locale: snapshot.locale,
          },
        });
      }

      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const now = new Date().toISOString();

      if (input.targetStatus === "published") {
        const nextVersion = getNextVersionNumber(documentSnapshots);

        documentSnapshots.set(nextVersion, {
          ...snapshot,
          version: nextVersion,
          publishedAt: now,
          publishedBy: actorId,
          changeSummary: input.changeSummary,
        });

        const restored: ContentDocument = {
          ...existing,
          path: snapshot.path,
          type: snapshot.type,
          locale: snapshot.locale,
          format: snapshot.format,
          frontmatter: snapshot.frontmatter,
          body: snapshot.body,
          isDeleted: false,
          hasUnpublishedChanges: false,
          version: nextVersion,
          publishedVersion: nextVersion,
          draftRevision: existing.draftRevision + 1,
          updatedBy: actorId,
          updatedAt: now,
        };
        store.set(normalizedDocumentId, restored);
        return restored;
      }

      const restored: ContentDocument = {
        ...existing,
        path: snapshot.path,
        type: snapshot.type,
        locale: snapshot.locale,
        format: snapshot.format,
        frontmatter: snapshot.frontmatter,
        body: snapshot.body,
        isDeleted: false,
        hasUnpublishedChanges: true,
        draftRevision: existing.draftRevision + 1,
        updatedBy: actorId,
        updatedAt: now,
      };
      store.set(normalizedDocumentId, restored);

      return restored;
    },

    async publish(scope, documentId, input) {
      const store = getScopeStore(scope);
      const publishedSnapshots = getScopePublishedSnapshots(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing || existing.isDeleted) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const documentSnapshots =
        publishedSnapshots.get(normalizedDocumentId) ?? new Map();
      if (!publishedSnapshots.has(normalizedDocumentId)) {
        publishedSnapshots.set(normalizedDocumentId, documentSnapshots);
      }

      const nextVersion = getNextVersionNumber(documentSnapshots);
      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const now = new Date().toISOString();

      documentSnapshots.set(nextVersion, {
        version: nextVersion,
        path: existing.path,
        type: existing.type,
        locale: existing.locale,
        format: existing.format,
        frontmatter: existing.frontmatter,
        body: existing.body,
        publishedAt: now,
        publishedBy: actorId,
        changeSummary: input.changeSummary,
      });

      const updated: ContentDocument = {
        ...existing,
        version: nextVersion,
        publishedVersion: nextVersion,
        hasUnpublishedChanges: false,
        updatedBy: actorId,
        updatedAt: now,
      };

      store.set(normalizedDocumentId, updated);
      return updated;
    },

    async unpublish(scope, documentId, input) {
      const store = getScopeStore(scope);
      const normalizedDocumentId = assertRequiredString(
        documentId,
        "documentId",
      );
      const existing = store.get(normalizedDocumentId);

      if (!existing || existing.isDeleted) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Document not found.",
          statusCode: 404,
          details: {
            documentId: normalizedDocumentId,
          },
        });
      }

      const actorId = input.actorId?.trim() || DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const updated: ContentDocument = {
        ...existing,
        version: 0,
        publishedVersion: null,
        hasUnpublishedChanges: true,
        updatedBy: actorId,
        updatedAt: now,
      };

      store.set(normalizedDocumentId, updated);
      return updated;
    },

    async listVariants(scope, documentId) {
      const store = getScopeStore(scope);
      const doc = store.get(documentId);

      if (!doc || doc.isDeleted) {
        return undefined;
      }

      const variants: ContentVariantSummary[] = [];

      for (const candidate of store.values()) {
        if (
          candidate.translationGroupId === doc.translationGroupId &&
          !candidate.isDeleted
        ) {
          variants.push({
            documentId: candidate.documentId,
            locale: candidate.locale,
            path: candidate.path,
            publishedVersion: candidate.publishedVersion,
            hasUnpublishedChanges: candidate.hasUnpublishedChanges,
          });
        }
      }

      sortVariantSummaries(variants);

      return variants;
    },
  };
}
