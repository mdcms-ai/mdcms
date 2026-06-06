import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  getContentTypeTableColumns,
  TranslationCoverageSummary,
} from "./page.js";
import * as pageModule from "./page.js";

test("TranslationCoverageSummary renders nothing for the idle state", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "idle",
    }),
  );

  assert.equal(markup, "");
  assert.doesNotMatch(markup, /data-mdcms-translation-coverage-state/);
  assert.doesNotMatch(markup, /Loading/i);
  assert.doesNotMatch(markup, /Translation status unavailable/i);
});

test("TranslationCoverageSummary renders the loading state deterministically", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "loading",
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="loading"/);
  assert.match(markup, /Loading locale coverage/i);
});

test("TranslationCoverageSummary renders the translated locale count", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "ready",
      coverage: {
        translatedLocales: 2,
        totalLocales: 4,
      },
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="ready"/);
  assert.match(markup, /2\/4 locales translated/);
});

test("TranslationCoverageSummary renders an error fallback when coverage is unavailable", () => {
  const markup = renderToStaticMarkup(
    createElement(TranslationCoverageSummary, {
      status: "error",
    }),
  );

  assert.match(markup, /data-mdcms-translation-coverage-state="error"/);
  assert.match(markup, /Translation status unavailable/i);
});

test("content type table starts with selection and ends with actions for non-localized lists", () => {
  const columns = getContentTypeTableColumns(false);

  assert.equal(columns[0]?.key, "selection");
  assert.equal(columns.at(-1)?.key, "actions");
});

test("content type table includes selection, translations, and actions for localized lists", () => {
  const columns = getContentTypeTableColumns(true).map((column) => column.key);

  assert.equal(columns[0], "selection");
  assert.ok(columns.includes("translations"));
  assert.equal(columns.at(-1), "actions");
});

test("bulk delete confirmation mentions Trash and selected count", () => {
  const helper = pageModule.getBulkConfirmationText as (input: {
    action: "delete";
    selectedCount: number;
    targetCount: number;
  }) => { title: string; description: string; confirmLabel: string };

  assert.equal(typeof helper, "function");

  const text = helper({
    action: "delete",
    selectedCount: 3,
    targetCount: 3,
  });
  const copy = `${text.title} ${text.description} ${text.confirmLabel}`;

  assert.match(copy, /Trash/);
  assert.match(copy, /3/);
});

test("content type table adds a dedicated Translations column for localized lists", () => {
  assert.deepEqual(
    getContentTypeTableColumns(true).map((column) => column.label),
    ["", "Title / Path", "Translations", "Status", "Updated", "Author", ""],
  );
});

test("content type table keeps the original columns for non-localized lists", () => {
  assert.deepEqual(
    getContentTypeTableColumns(false).map((column) => column.label),
    ["", "Title / Path", "Status", "Updated", "Author", ""],
  );
});
