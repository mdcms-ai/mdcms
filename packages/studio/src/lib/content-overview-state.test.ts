import assert from "node:assert/strict";

import { RuntimeError } from "@mdcms/shared";
import { test } from "bun:test";

import {
  loadStudioContentOverviewState,
  type LoadStudioContentOverviewStateInput,
} from "./content-overview-state.js";
import type { StudioContentListApi } from "./content-list-api.js";
import type { StudioContentOverviewApi } from "./content-overview-api.js";
import type { StudioCurrentPrincipalCapabilitiesApi } from "./current-principal-capabilities-api.js";
import type { StudioSchemaRouteApi } from "./schema-route-api.js";

const emptySyncResult = {
  schemaHash: "",
  syncedAt: "",
  affectedTypes: [] as string[],
};

function createSchemaApi(
  entries: Array<{
    type: string;
    directory: string;
    localized?: boolean;
  }>,
): StudioSchemaRouteApi {
  return {
    list: async () => ({
      types: entries.map((entry) => ({
        type: entry.type,
        directory: entry.directory,
        localized: entry.localized ?? false,
        schemaHash: "schema-hash",
        syncedAt: "2026-04-06T00:00:00.000Z",
        resolvedSchema: {
          type: entry.type,
          directory: entry.directory,
          localized: entry.localized ?? false,
          fields: {},
        },
      })),
      schemaHash: entries.length > 0 ? "schema-hash" : null,
      syncedAt: entries.length > 0 ? "2026-04-06T00:00:00.000Z" : null,
    }),
    sync: async () => emptySyncResult,
  };
}

function createCapabilitiesApi(overrides?: {
  schemaRead?: boolean;
  contentRead?: boolean;
  contentReadDraft?: boolean;
}) {
  return {
    get: async () => ({
      project: "marketing-site",
      environment: "staging",
      capabilities: {
        schema: {
          read: overrides?.schemaRead ?? true,
          write: false,
        },
        content: {
          read: overrides?.contentRead ?? true,
          readDraft: overrides?.contentReadDraft ?? true,
          write: false,
          publish: false,
          unpublish: false,
          delete: false,
        },
        users: {
          manage: false,
        },
        settings: {
          manage: false,
        },
        media: {
          read: false,
          upload: false,
          delete: false,
        },
        ai: {
          use: false,
        },
      },
    }),
  } satisfies StudioCurrentPrincipalCapabilitiesApi;
}

function createLoadInput(overrides?: {
  schemaApi?: StudioSchemaRouteApi;
  capabilitiesApi?: StudioCurrentPrincipalCapabilitiesApi;
  contentApi?: StudioContentListApi;
  contentOverviewApi?: StudioContentOverviewApi;
  supportedLocales?: string[];
}): LoadStudioContentOverviewStateInput {
  return {
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
      supportedLocales: overrides?.supportedLocales,
    },
    auth: { mode: "cookie" },
    schemaApi:
      overrides?.schemaApi ??
      createSchemaApi([
        { type: "BlogPost", directory: "content/blog", localized: true },
      ]),
    capabilitiesApi: overrides?.capabilitiesApi ?? createCapabilitiesApi(),
    contentOverviewApi:
      overrides?.contentOverviewApi ??
      ({
        get: async ({ types }) =>
          types.map((type) => ({
            type,
            total: 0,
            published: 0,
            drafts: 0,
          })),
      } satisfies StudioContentOverviewApi),
    contentApi:
      overrides?.contentApi ??
      ({
        list: async () => ({
          data: [],
          pagination: {
            total: 0,
            limit: 1,
            offset: 0,
            hasMore: false,
          },
        }),
      } satisfies StudioContentListApi),
  };
}

test("loadStudioContentOverviewState returns ready entries with truthful live metrics", async () => {
  const calls: Array<readonly string[]> = [];
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      supportedLocales: ["en-US", "fr", "de", "ja"],
      schemaApi: createSchemaApi([
        { type: "BlogPost", directory: "content/blog", localized: true },
        { type: "Author", directory: "content/authors" },
      ]),
      contentOverviewApi: {
        get: async ({ types }) => {
          calls.push(types);
          return [
            { type: "BlogPost", total: 7, published: 5, drafts: 2 },
            { type: "Author", total: 3, published: 3, drafts: 0 },
          ];
        },
      },
    }),
  );

  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0]?.type, "Author");
  assert.equal(state.entries[0]?.canNavigate, true);
  assert.equal(state.entries[0]?.locales, undefined);
  assert.deepEqual(state.entries[1]?.locales, ["en-US", "fr", "de", "ja"]);
  assert.deepEqual(
    state.entries[1]?.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["documents", 7],
      ["published", 5],
      ["withDrafts", 2],
    ],
  );
  assert.deepEqual(calls, [["Author", "BlogPost"]]);
});

test("loadStudioContentOverviewState uses overview counts for callers without draft-read access", async () => {
  let listCalls = 0;
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      capabilitiesApi: createCapabilitiesApi({
        schemaRead: true,
        contentRead: true,
        contentReadDraft: false,
      }),
      schemaApi: createSchemaApi([
        { type: "BlogPost", directory: "content/blog", localized: true },
      ]),
      contentOverviewApi: {
        get: async () => [
          { type: "BlogPost", total: 4, published: 1, drafts: 3 },
        ],
      },
      contentApi: {
        list: async () => {
          listCalls += 1;
          throw new Error("content list API should not be called");
        },
      },
    }),
  );

  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.deepEqual(
    state.entries[0]?.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["documents", 4],
      ["published", 1],
      ["withDrafts", 3],
    ],
  );
  assert.equal(listCalls, 0);
});

test("loadStudioContentOverviewState keeps the draft-only fallback in draft mode", async () => {
  const queries: Array<Parameters<StudioContentListApi["list"]>[0]> = [];
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      capabilitiesApi: createCapabilitiesApi({
        schemaRead: true,
        contentRead: false,
        contentReadDraft: true,
      }),
      schemaApi: createSchemaApi([
        { type: "BlogPost", directory: "content/blog", localized: true },
      ]),
      contentApi: {
        list: async (query = {}) => {
          queries.push(query);

          if (query.published === true && query.draft !== true) {
            throw new RuntimeError({
              code: "FORBIDDEN",
              message: "Published-only reads are not allowed for draft access.",
              statusCode: 403,
            });
          }

          const total =
            query.draft === true && query.published === true
              ? 2
              : query.draft === true && query.published === false
                ? 4
                : 6;

          return {
            data: [],
            pagination: {
              total,
              limit: 1,
              offset: 0,
              hasMore: false,
            },
          };
        },
      },
    }),
  );

  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.deepEqual(
    state.entries[0]?.metrics.map((metric) => [metric.id, metric.value]),
    [
      ["documents", 6],
      ["published", 2],
      ["withDrafts", 4],
    ],
  );
  assert.deepEqual(queries, [
    { type: "BlogPost", draft: true, limit: 1 },
    { type: "BlogPost", draft: true, published: true, limit: 1 },
    { type: "BlogPost", draft: true, published: false, limit: 1 },
  ]);
});

test("loadStudioContentOverviewState returns permission-constrained state when schema is readable but content is not", async () => {
  let contentCalls = 0;
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      supportedLocales: ["en-US", "fr"],
      schemaApi: createSchemaApi([
        { type: "BlogPost", directory: "content/blog", localized: true },
      ]),
      capabilitiesApi: createCapabilitiesApi({
        schemaRead: true,
        contentRead: false,
        contentReadDraft: false,
      }),
      contentApi: {
        list: async () => {
          contentCalls += 1;
          throw new Error("content API should not be called");
        },
      },
    }),
  );

  assert.equal(state.status, "permission-constrained");
  if (state.status !== "permission-constrained") return;

  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]?.canNavigate, false);
  assert.deepEqual(state.entries[0]?.locales, ["en-US", "fr"]);
  assert.equal(state.entries[0]?.metrics.length, 0);
  assert.equal(contentCalls, 0);
});

test("loadStudioContentOverviewState returns ready empty state when schema has no entries", async () => {
  let overviewCalls = 0;
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      schemaApi: createSchemaApi([]),
      contentOverviewApi: {
        get: async () => {
          overviewCalls += 1;
          throw new Error("overview API should not be called for empty schema");
        },
      },
    }),
  );

  assert.equal(state.status, "ready");
  if (state.status !== "ready") return;

  assert.deepEqual(state.entries, []);
  assert.equal(overviewCalls, 0);
});

test("loadStudioContentOverviewState maps forbidden schema access deterministically", async () => {
  const state = await loadStudioContentOverviewState(
    createLoadInput({
      schemaApi: {
        list: async () => {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: "Forbidden",
            statusCode: 403,
          });
        },
        sync: async () => emptySyncResult,
      },
    }),
  );

  assert.equal(state.status, "forbidden");
  if (state.status !== "forbidden") return;

  assert.equal(state.project, "marketing-site");
  assert.equal(state.environment, "staging");
});
