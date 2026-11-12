import assert from "node:assert/strict";
import { test } from "node:test";

import type { SchemaRegistryTypeSnapshot } from "@mdcms/shared";

import { validateFrontmatter } from "./frontmatter-validation.js";

test("reference metadata preserves string validation and unknown-field warnings", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "posts",
    localized: false,
    fields: {
      author: {
        kind: "string",
        required: true,
        nullable: false,
        reference: { targetType: "Author" },
      },
    },
  };
  assert.deepEqual(
    validateFrontmatter({ author: "author-id", extra: true }, schema),
    {
      errors: [],
      warnings: [
        'Unknown field "extra" is not defined in schema for type "Post".',
      ],
    },
  );
  assert.deepEqual(
    validateFrontmatter({ author: { id: "author-id" } }, schema).errors,
    ['Field "author" expected kind "string", got object.'],
  );
});

test("validateFrontmatter returns error for missing required field", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      title: { kind: "string", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({}, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("title"), true);
  assert.equal(result.errors[0]!.includes("required"), true);
  assert.equal(result.warnings.length, 0);
});

test("validateFrontmatter passes when required field is present", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      title: { kind: "string", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({ title: "Hello" }, schema);

  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("validateFrontmatter skips missing field when it has a default", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      status: {
        kind: "string",
        required: true,
        nullable: false,
        default: "draft",
      },
    },
  };

  const result = validateFrontmatter({}, schema);

  assert.equal(result.errors.length, 0);
});

test("validateFrontmatter returns error for kind mismatch", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      order: { kind: "number", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({ order: "not-a-number" }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("number"), true);
  assert.equal(result.errors[0]!.includes("string"), true);
});

test("validateFrontmatter accepts raw schema file field ids as strings", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      primaryImage: {
        kind: "string",
        required: true,
        nullable: false,
        file: { preset: "image", accept: [], emptyStringAsUnset: false },
      },
    },
  };

  const result = validateFrontmatter(
    { primaryImage: "07ebb057-eeab-4849-94e4-2162cb921c8e" },
    schema,
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("validateFrontmatter rejects expanded schema file field objects", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      primaryImage: {
        kind: "string",
        required: true,
        nullable: false,
        file: { preset: "image", accept: [], emptyStringAsUnset: false },
      },
    },
  };

  const result = validateFrontmatter(
    {
      primaryImage: {
        id: "07ebb057-eeab-4849-94e4-2162cb921c8e",
        mimeType: "image/png",
      },
    },
    schema,
  );

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("primaryImage"), true);
  assert.equal(result.errors[0]!.includes('expected kind "string"'), true);
  assert.equal(result.errors[0]!.includes("object"), true);
});

test("validateFrontmatter returns error for null on non-nullable field", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      title: { kind: "string", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({ title: null }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("null"), true);
});

test("validateFrontmatter allows null on nullable field", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      subtitle: { kind: "string", required: false, nullable: true },
    },
  };

  const result = validateFrontmatter({ subtitle: null }, schema);

  assert.equal(result.errors.length, 0);
});

test("validateFrontmatter returns error for enum value not in options", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      status: {
        kind: "enum",
        required: true,
        nullable: false,
        options: ["draft", "published"],
      },
    },
  };

  const result = validateFrontmatter({ status: "archived" }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("archived"), true);
  assert.equal(result.errors[0]!.includes("draft"), true);
});

test("validateFrontmatter returns warning for unknown frontmatter field", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      title: { kind: "string", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter(
    { title: "Hello", extra: "stuff" },
    schema,
  );

  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]!.includes("extra"), true);
});

test("validateFrontmatter validates nested object fields", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      meta: {
        kind: "object",
        required: true,
        nullable: false,
        fields: {
          description: { kind: "string", required: true, nullable: false },
        },
      },
    },
  };

  const result = validateFrontmatter({ meta: { description: 42 } }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("meta.description"), true);
});

test("validateFrontmatter validates array item types", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      tags: {
        kind: "array",
        required: true,
        nullable: false,
        item: { kind: "string", required: true, nullable: false },
      },
    },
  };

  const result = validateFrontmatter({ tags: ["valid", 123] }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("tags[1]"), true);
});

test("validateFrontmatter returns error when array expected but got string", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      tags: {
        kind: "array",
        required: true,
        nullable: false,
        item: { kind: "string", required: true, nullable: false },
      },
    },
  };

  const result = validateFrontmatter({ tags: "not-an-array" }, schema);

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.includes("array"), true);
});

test("validateFrontmatter skips optional missing field without error", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      subtitle: { kind: "string", required: false, nullable: false },
    },
  };

  const result = validateFrontmatter({}, schema);

  assert.equal(result.errors.length, 0);
});

test("validateFrontmatter accepts date as ISO string", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      publishedAt: { kind: "date", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({ publishedAt: "2026-03-31" }, schema);

  assert.equal(result.errors.length, 0);
});

test("validateFrontmatter collects multiple errors from one document", () => {
  const schema: SchemaRegistryTypeSnapshot = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    fields: {
      title: { kind: "string", required: true, nullable: false },
      order: { kind: "number", required: true, nullable: false },
    },
  };

  const result = validateFrontmatter({}, schema);

  assert.equal(result.errors.length, 2);
});
