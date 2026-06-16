import { and, eq, ne, sql } from "drizzle-orm";

import { publishedSearchIndex } from "../db/schema.js";
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

export function createPostgresContentSearchBackend(): ContentSearchBackend {
  return {
    async searchPublishedDocumentIds(_scopeIds, _filters) {
      return new Set<string>();
    },

    async searchDraftDocumentIds(_scopeIds, _filters) {
      return new Set<string>();
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
