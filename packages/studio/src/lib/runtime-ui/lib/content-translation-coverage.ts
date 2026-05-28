import type { ContentDocumentResponse } from "@mdcms/shared";

import type { StudioContentListApi } from "../../content-list-api.js";

const CONTENT_TRANSLATION_COVERAGE_QUERY_KEY = "content-translation-coverage";
const CONTENT_TRANSLATION_COVERAGE_PAGE_SIZE = 100;
const MAX_CONTENT_TRANSLATION_COVERAGE_PAGES = 1000;

export type ContentTranslationCoverage = {
  translatedLocales: number;
  totalLocales: number;
};

export type ContentTranslationCoverageMap = Record<
  string,
  ContentTranslationCoverage
>;

type TranslationCoverageDocument = Pick<
  ContentDocumentResponse,
  "translationGroupId" | "locale" | "localesPresent"
>;

export function getContentTranslationCoverageQueryKey(
  project: string | null | undefined,
  environment: string | null | undefined,
  type?: string,
) {
  return [
    CONTENT_TRANSLATION_COVERAGE_QUERY_KEY,
    project,
    environment,
    ...(type ? [type] : []),
  ] as const;
}

export function buildContentTranslationCoverageMap(
  documents: TranslationCoverageDocument[],
  totalLocales: number,
): ContentTranslationCoverageMap {
  if (totalLocales <= 0) {
    return {};
  }

  const localesByGroup = new Map<string, Set<string>>();

  for (const document of documents) {
    const locales =
      localesByGroup.get(document.translationGroupId) ?? new Set();
    if (
      Array.isArray(document.localesPresent) &&
      document.localesPresent.length > 0
    ) {
      for (const locale of document.localesPresent) {
        locales.add(locale);
      }
    } else {
      locales.add(document.locale);
    }
    localesByGroup.set(document.translationGroupId, locales);
  }

  return Object.fromEntries(
    [...localesByGroup.entries()].map(([translationGroupId, locales]) => [
      translationGroupId,
      {
        translatedLocales: locales.size,
        totalLocales,
      },
    ]),
  );
}

export function formatContentTranslationCoverageLabel(
  coverage: ContentTranslationCoverage,
): string {
  return `${coverage.translatedLocales}/${coverage.totalLocales} locales translated`;
}

export async function loadContentTranslationCoverageMap(
  api: StudioContentListApi,
  input: {
    type: string;
    totalLocales: number;
    maxPages?: number;
  },
): Promise<ContentTranslationCoverageMap> {
  if (input.totalLocales <= 0) {
    return {};
  }

  const documents: TranslationCoverageDocument[] = [];
  let offset = 0;
  let pageCount = 0;
  const maxPages = Math.max(
    1,
    input.maxPages ?? MAX_CONTENT_TRANSLATION_COVERAGE_PAGES,
  );

  while (pageCount < maxPages) {
    const response = await api.list({
      type: input.type,
      groupBy: "translationGroup",
      draft: true,
      isDeleted: false,
      limit: CONTENT_TRANSLATION_COVERAGE_PAGE_SIZE,
      offset,
    });
    pageCount += 1;

    documents.push(
      ...response.data.map((document) => ({
        translationGroupId: document.translationGroupId,
        locale: document.locale,
        localesPresent: document.localesPresent,
      })),
    );

    if (!response.pagination.hasMore || response.data.length === 0) {
      break;
    }

    const nextOffset =
      offset + Math.max(response.pagination.limit, response.data.length, 1);

    if (nextOffset <= offset) {
      break;
    }

    offset = nextOffset;
  }

  return buildContentTranslationCoverageMap(documents, input.totalLocales);
}
