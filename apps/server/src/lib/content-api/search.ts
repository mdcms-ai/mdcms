import { and, eq, ne, sql, type SQL } from "drizzle-orm";

import type { DrizzleDatabase } from "../db.js";
import { documents, publishedSearchIndex } from "../db/schema.js";
import type { ContentSearchBackend } from "./types.js";

const SEARCH_CONFIG_BY_PRIMARY_LOCALE: Record<string, string> = {
  da: "danish",
  de: "german",
  en: "english",
  es: "spanish",
  fi: "finnish",
  fr: "french",
  hu: "hungarian",
  it: "italian",
  nl: "dutch",
  no: "norwegian",
  nb: "norwegian",
  nn: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sv: "swedish",
  tr: "turkish",
};

export function resolvePostgresSearchConfig(locale: string): string {
  const primarySubtag = locale.trim().toLowerCase().split("-")[0] ?? "";

  return SEARCH_CONFIG_BY_PRIMARY_LOCALE[primarySubtag] ?? "simple";
}

export function buildContentSearchText(input: {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
}): string {
  return `${input.path}\n${input.body}\n${JSON.stringify(input.frontmatter)}`;
}

function postgresSearchConfigForLocaleColumn(): SQL {
  return sql`CASE lower(split_part(${documents.locale}, '-', 1))
    WHEN 'da' THEN 'danish'::regconfig
    WHEN 'de' THEN 'german'::regconfig
    WHEN 'en' THEN 'english'::regconfig
    WHEN 'es' THEN 'spanish'::regconfig
    WHEN 'fi' THEN 'finnish'::regconfig
    WHEN 'fr' THEN 'french'::regconfig
    WHEN 'hu' THEN 'hungarian'::regconfig
    WHEN 'it' THEN 'italian'::regconfig
    WHEN 'nl' THEN 'dutch'::regconfig
    WHEN 'no' THEN 'norwegian'::regconfig
    WHEN 'nb' THEN 'norwegian'::regconfig
    WHEN 'nn' THEN 'norwegian'::regconfig
    WHEN 'pt' THEN 'portuguese'::regconfig
    WHEN 'ro' THEN 'romanian'::regconfig
    WHEN 'ru' THEN 'russian'::regconfig
    WHEN 'sv' THEN 'swedish'::regconfig
    WHEN 'tr' THEN 'turkish'::regconfig
    ELSE 'simple'::regconfig
  END`;
}

export function createPostgresContentSearchBackend(
  db: DrizzleDatabase,
): ContentSearchBackend {
  return {
    async searchPublishedDocumentIds(scopeIds, filters) {
      const query = filters.query?.trim();

      if (!query) {
        return new Set<string>();
      }

      const conditions: SQL[] = [
        eq(publishedSearchIndex.projectId, scopeIds.projectId),
        eq(publishedSearchIndex.environmentId, scopeIds.environmentId),
        sql`${publishedSearchIndex.searchVector} @@ websearch_to_tsquery(${publishedSearchIndex.searchConfig}, ${query})`,
      ];
      const type = filters.type?.trim();
      const locale = filters.locale?.trim();

      if (type) {
        conditions.push(eq(publishedSearchIndex.schemaType, type));
      }

      if (locale) {
        conditions.push(eq(publishedSearchIndex.locale, locale));
      }

      const rows = await db
        .select({ documentId: publishedSearchIndex.documentId })
        .from(publishedSearchIndex)
        .where(and(...conditions));

      return new Set(rows.map((row) => row.documentId));
    },

    async searchDraftDocumentIds(scopeIds, filters) {
      const query = filters.query?.trim();

      if (!query) {
        return new Set<string>();
      }

      const searchConfig = postgresSearchConfigForLocaleColumn();
      const conditions: SQL[] = [
        eq(documents.projectId, scopeIds.projectId),
        eq(documents.environmentId, scopeIds.environmentId),
        eq(documents.isDeleted, filters.isDeleted ?? false),
        sql`to_tsvector(
          ${searchConfig},
          concat_ws(E'\n', ${documents.path}, ${documents.body}, ${documents.frontmatter}::text)
        ) @@ websearch_to_tsquery(${searchConfig}, ${query})`,
      ];
      const type = filters.type?.trim();
      const locale = filters.locale?.trim();

      if (type) {
        conditions.push(eq(documents.schemaType, type));
      }

      if (locale) {
        conditions.push(eq(documents.locale, locale));
      }

      const rows = await db
        .select({ documentId: documents.documentId })
        .from(documents)
        .where(and(...conditions));

      return new Set(rows.map((row) => row.documentId));
    },

    async upsertPublishedDocument(tx, document) {
      const searchConfig = resolvePostgresSearchConfig(document.locale);
      const searchText = buildContentSearchText(document);

      await tx
        .delete(publishedSearchIndex)
        .where(
          and(
            eq(publishedSearchIndex.projectId, document.projectId),
            eq(publishedSearchIndex.environmentId, document.environmentId),
            eq(publishedSearchIndex.documentId, document.documentId),
            ne(publishedSearchIndex.locale, document.locale),
          ),
        );
      await tx
        .insert(publishedSearchIndex)
        .values({
          projectId: document.projectId,
          environmentId: document.environmentId,
          documentId: document.documentId,
          locale: document.locale,
          schemaType: document.type,
          searchConfig: sql`${searchConfig}::regconfig`,
          searchVector: sql`to_tsvector(${searchConfig}::regconfig, ${searchText})`,
        })
        .onConflictDoUpdate({
          target: [
            publishedSearchIndex.projectId,
            publishedSearchIndex.environmentId,
            publishedSearchIndex.documentId,
            publishedSearchIndex.locale,
          ],
          set: {
            schemaType: document.type,
            searchConfig: sql`${searchConfig}::regconfig`,
            searchVector: sql`to_tsvector(${searchConfig}::regconfig, ${searchText})`,
          },
        });
    },

    async removePublishedDocument(tx, input) {
      await tx
        .delete(publishedSearchIndex)
        .where(
          and(
            eq(publishedSearchIndex.projectId, input.projectId),
            eq(publishedSearchIndex.environmentId, input.environmentId),
            eq(publishedSearchIndex.documentId, input.documentId),
            eq(publishedSearchIndex.locale, input.locale),
          ),
        );
    },
  };
}
