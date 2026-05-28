"use client";

import { useMemo, useCallback, useEffect, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ContentDocumentResponse,
  ContentUserSummary,
  PaginationMetadata,
} from "@mdcms/shared";
import { RuntimeError } from "@mdcms/shared";

import {
  createStudioContentListApi,
  type StudioContentListQuery,
} from "../../content-list-api.js";
import { extractDocumentTitle } from "./use-content-type-list.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";

export type MappedTrashDocument = {
  documentId: string;
  title: string;
  path: string;
  locale: string;
  type: string;
  deletedAt: string;
  deletedBy: string;
};

export type TrashListSort = "updated" | "created" | "path-asc" | "path-desc";

export type TrashListFilters = {
  q?: string;
  type?: string;
  sort?: TrashListSort;
};

export type TrashListStatus =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "forbidden";

export const TRASH_PAGE_SIZE = 20;

export function mapTrashDocument(
  doc: ContentDocumentResponse,
): MappedTrashDocument {
  return {
    documentId: doc.documentId,
    title: extractDocumentTitle(doc.frontmatter, doc.path),
    path: doc.path,
    locale: doc.locale,
    type: doc.type,
    deletedAt: doc.updatedAt,
    deletedBy: doc.updatedBy,
  };
}

type TrashFilterQuery = Omit<
  StudioContentListQuery,
  | "isDeleted"
  | "limit"
  | "offset"
  | "draft"
  | "published"
  | "hasUnpublishedChanges"
>;

export function mapTrashFiltersToQuery(
  filters: TrashListFilters,
): TrashFilterQuery {
  const query: TrashFilterQuery = {};

  if (filters.type) {
    query.type = filters.type;
  }

  const q = filters.q?.trim();
  if (q) {
    query.q = q;
  }

  switch (filters.sort) {
    case "updated":
      query.sort = "updatedAt";
      query.order = "desc";
      break;
    case "created":
      query.sort = "createdAt";
      query.order = "desc";
      break;
    case "path-asc":
      query.sort = "path";
      query.order = "asc";
      break;
    case "path-desc":
      query.sort = "path";
      query.order = "desc";
      break;
  }

  return query;
}

function hasActiveFilters(filters: TrashListFilters): boolean {
  return Boolean(filters.q || filters.type);
}

type TrashListState = {
  filters: TrashListFilters;
  offset: number;
};

type TrashListAction =
  | { type: "filters-change"; filters: Partial<TrashListFilters> }
  | { type: "page-change"; offset: number }
  | { type: "offset-clamp"; offset: number };

function trashListReducer(
  state: TrashListState,
  action: TrashListAction,
): TrashListState {
  switch (action.type) {
    case "filters-change":
      return {
        filters: { ...state.filters, ...action.filters },
        offset: 0,
      };
    case "page-change":
    case "offset-clamp":
      return { ...state, offset: action.offset };
  }
}

const initialTrashListState: TrashListState = {
  filters: { sort: "updated" },
  offset: 0,
};

export function useTrashList() {
  const mountInfo = useStudioMountInfo();
  const [{ filters, offset }, dispatch] = useReducer(
    trashListReducer,
    initialTrashListState,
  );

  const api = useMemo(() => {
    if (!mountInfo.project || !mountInfo.environment || !mountInfo.apiBaseUrl) {
      return null;
    }
    return createStudioContentListApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      { auth: mountInfo.auth },
    );
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
  ]);

  const queryParams = useMemo(() => mapTrashFiltersToQuery(filters), [filters]);

  const query = useQuery({
    queryKey: [
      "trash-list",
      mountInfo.project,
      mountInfo.environment,
      queryParams,
      offset,
    ],
    queryFn: async () => {
      const result = await api!.list({
        ...queryParams,
        isDeleted: true,
        draft: true,
        limit: TRASH_PAGE_SIZE,
        offset,
      });
      return result;
    },
    enabled: api !== null,
  });

  const documents = useMemo(
    () => (query.data?.data ?? []).map(mapTrashDocument),
    [query.data?.data],
  );

  const pagination: PaginationMetadata | null = query.data?.pagination ?? null;
  const users: Record<string, ContentUserSummary> = query.data?.users ?? {};

  // Clamp offset when total shrinks (e.g. after restoring items)
  useEffect(() => {
    if (pagination && offset > 0 && offset >= pagination.total) {
      const lastPageStart =
        Math.max(0, Math.floor((pagination.total - 1) / TRASH_PAGE_SIZE)) *
        TRASH_PAGE_SIZE;
      dispatch({ type: "offset-clamp", offset: lastPageStart });
    }
  }, [pagination, offset]);

  const status: TrashListStatus = useMemo(() => {
    if (query.isLoading) return "loading";
    if (query.error) {
      if (
        query.error instanceof RuntimeError &&
        (query.error.statusCode === 401 || query.error.statusCode === 403)
      ) {
        return "forbidden";
      }
      return "error";
    }
    if (documents.length === 0 && !hasActiveFilters(filters)) return "empty";
    return "ready";
  }, [query.isLoading, query.error, documents.length, filters]);

  const errorMessage = useMemo(() => {
    if (!query.error) return undefined;
    return query.error instanceof Error
      ? query.error.message
      : "Failed to load trash list.";
  }, [query.error]);

  const setFilters = useCallback((next: Partial<TrashListFilters>) => {
    dispatch({ type: "filters-change", filters: next });
  }, []);

  const setPage = useCallback((nextOffset: number) => {
    dispatch({ type: "page-change", offset: nextOffset });
  }, []);

  const refresh = useCallback(() => {
    query.refetch();
  }, [query.refetch]);

  return {
    status,
    documents,
    pagination,
    users,
    filters,
    errorMessage,
    setFilters,
    setPage,
    refresh,
  };
}
