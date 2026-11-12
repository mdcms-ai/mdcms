import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  filterReferenceOptions,
  toReferenceOption,
} from "./reference-field-picker.js";

test("reference options are labelled by name, title or label, then file name", () => {
  const base = { documentId: "d1", path: "content/authors/ada" };

  assert.deepEqual(
    toReferenceOption({ ...base, frontmatter: { name: "Ada", title: "T" } }),
    { documentId: "d1", label: "Ada", path: "content/authors/ada" },
  );
  assert.equal(
    toReferenceOption({ ...base, frontmatter: { title: "Hello" } }).label,
    "Hello",
  );
  assert.equal(
    toReferenceOption({ ...base, frontmatter: { name: "  ", label: "L" } })
      .label,
    "L",
  );
  assert.equal(toReferenceOption({ ...base, frontmatter: {} }).label, "ada");
});

test("typed text filters options by label or path, case-insensitively", () => {
  const options = [
    { documentId: "1", label: "Ada Lovelace", path: "content/authors/ada" },
    { documentId: "2", label: "Grace Hopper", path: "content/authors/grace" },
  ];

  assert.deepEqual(
    filterReferenceOptions(options, "gra").map((option) => option.documentId),
    ["2"],
  );
  assert.deepEqual(
    filterReferenceOptions(options, "AUTHORS/ADA").map(
      (option) => option.documentId,
    ),
    ["1"],
  );
  assert.equal(filterReferenceOptions(options, "  ").length, 2);
  assert.equal(filterReferenceOptions(options, "zzz").length, 0);
});
