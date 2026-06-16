import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildContentSearchText,
  resolvePostgresSearchConfig,
} from "./search.js";

test("resolvePostgresSearchConfig maps supported locale primary subtags and falls back to simple", () => {
  assert.equal(resolvePostgresSearchConfig("en-US"), "english");
  assert.equal(resolvePostgresSearchConfig("fr"), "french");
  assert.equal(resolvePostgresSearchConfig("de-AT"), "german");
  assert.equal(resolvePostgresSearchConfig("nb"), "norwegian");
  assert.equal(resolvePostgresSearchConfig(""), "simple");
  assert.equal(resolvePostgresSearchConfig("pl"), "simple");
});

test("buildContentSearchText includes path body and serialized frontmatter", () => {
  assert.equal(
    buildContentSearchText({
      path: "blog/search",
      body: "Body text",
      frontmatter: { title: "Search Title", nested: { label: "Value" } },
    }),
    'blog/search\nBody text\n{"title":"Search Title","nested":{"label":"Value"}}',
  );
});
