import assert from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeError } from "@mdcms/shared";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { parseContentSearchQuery } from "./parsing.js";

import {
  buildContentSearchText,
  createPostgresContentSearchBackend,
  resolvePostgresSearchConfig,
} from "./search.js";

test("parseContentSearchQuery trims empty values and rejects too-long q", () => {
  assert.equal(parseContentSearchQuery(undefined), undefined);
  assert.equal(parseContentSearchQuery("   "), undefined);
  assert.equal(parseContentSearchQuery("  launch plan  "), "launch plan");

  const value = "x".repeat(201);

  assert.throws(
    () => parseContentSearchQuery(value),
    (error: unknown) => {
      const actual = error as RuntimeError;
      assert.equal(actual.code, "INVALID_QUERY_PARAM");
      assert.equal(actual.statusCode, 400);
      assert.match(actual.message, /q/);
      assert.deepEqual(actual.details, {
        field: "q",
        value,
      });
      return true;
    },
  );
});

test("resolvePostgresSearchConfig maps supported locale primary subtags and falls back to simple", () => {
  assert.equal(resolvePostgresSearchConfig("en-US"), "english");
  assert.equal(resolvePostgresSearchConfig("fr"), "french");
  assert.equal(resolvePostgresSearchConfig("de-AT"), "german");
  assert.equal(resolvePostgresSearchConfig("nb"), "norwegian");
  assert.equal(resolvePostgresSearchConfig(""), "simple");
  assert.equal(resolvePostgresSearchConfig("pl"), "simple");
});

test("buildContentSearchText includes searchable path segments body and serialized frontmatter", () => {
  assert.equal(
    buildContentSearchText({
      path: "blog/pathneedle-73b9b39b",
      body: "Body text",
      frontmatter: { title: "Search Title", nested: { label: "Value" } },
    }),
    'blog/pathneedle-73b9b39b\nblog pathneedle 73b9b39b\nBody text\n{"title":"Search Title","nested":{"label":"Value"}}',
  );
});

test("postgres draft search honors explicit deleted visibility filters", async () => {
  const renderDraftSearchWhere = async (
    filters: Parameters<
      ReturnType<
        typeof createPostgresContentSearchBackend
      >["searchDraftDocumentIds"]
    >[1],
  ) => {
    let capturedWhere: SQL | undefined;
    const db = {
      select: () => ({
        from: () => ({
          where: (condition: SQL) => {
            capturedWhere = condition;
            return [] as Array<{ documentId: string }>;
          },
        }),
      }),
    } as unknown as Parameters<typeof createPostgresContentSearchBackend>[0];
    const backend = createPostgresContentSearchBackend(db);

    await backend.searchDraftDocumentIds(
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        environmentId: "22222222-2222-4222-8222-222222222222",
      },
      filters,
    );

    assert.ok(capturedWhere);

    return new PgDialect().sqlToQuery(capturedWhere);
  };
  const readIsDeletedParam = (renderedQuery: {
    sql: string;
    params: unknown[];
  }) => {
    const placeholder =
      /"documents"\."(?:is_deleted|isDeleted)"\s*=\s*\$(\d+)/.exec(
        renderedQuery.sql,
      )?.[1];

    assert.ok(
      placeholder,
      `expected is_deleted predicate in SQL: ${renderedQuery.sql}`,
    );

    return renderedQuery.params[Number(placeholder) - 1];
  };

  const defaultVisibility = await renderDraftSearchWhere({
    query: "soft deleted",
  });
  assert.equal(readIsDeletedParam(defaultVisibility), false);
  assert.match(
    defaultVisibility.sql,
    /regexp_replace\("documents"\."(?:path|path)", \$\d+, \$\d+, \$\d+\)/,
    "expected draft full-text search to index separator-normalized path segments",
  );

  const deletedFilters = {
    query: "soft deleted",
    isDeleted: true,
  };
  const deletedVisibility = await renderDraftSearchWhere(deletedFilters);
  assert.equal(readIsDeletedParam(deletedVisibility), true);

  const activeFilters = {
    query: "soft deleted",
    isDeleted: false,
  };
  const activeVisibility = await renderDraftSearchWhere(activeFilters);
  assert.equal(readIsDeletedParam(activeVisibility), false);
});
