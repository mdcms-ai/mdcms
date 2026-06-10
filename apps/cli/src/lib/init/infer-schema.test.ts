import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscoveredFile } from "./scan.js";
import { inferSchema } from "./infer-schema.js";

function makeFile(
  relativePath: string,
  frontmatter: Record<string, unknown> = {},
): DiscoveredFile {
  return {
    relativePath,
    format: relativePath.endsWith(".mdx") ? "mdx" : "md",
    frontmatter,
    frontmatterKeys: Object.keys(frontmatter),
    localeHint: null,
  };
}

test("infers a single type from one directory", () => {
  const files = [
    makeFile("content/posts/hello.md", { title: "Hello", draft: false }),
    makeFile("content/posts/world.md", { title: "World", draft: true }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "post");
  assert.equal(result[0]!.directory, "content/posts");
  assert.equal(result[0]!.fileCount, 2);
  assert.equal(result[0]!.localized, false);
  assert.equal(result[0]!.fields["title"]!.zodType, "z.string()");
  assert.equal(result[0]!.fields["title"]!.optional, false);
  assert.equal(result[0]!.fields["title"]!.samples, 2);
  assert.equal(result[0]!.fields["draft"]!.zodType, "z.boolean()");
  assert.equal(result[0]!.fields["draft"]!.optional, false);
});

test("marks fields optional when not present in all files", () => {
  const files = [
    makeFile("content/posts/a.md", { title: "A", tags: ["x"] }),
    makeFile("content/posts/b.md", { title: "B" }),
    makeFile("content/posts/c.md", { title: "C" }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result[0]!.fields["title"]!.optional, false);
  assert.equal(result[0]!.fields["title"]!.samples, 3);
  assert.equal(result[0]!.fields["tags"]!.optional, true);
  assert.equal(result[0]!.fields["tags"]!.samples, 1);
});

test("infers numeric fields as z.number()", () => {
  const files = [
    makeFile("content/posts/a.md", { title: "A", order: 1 }),
    makeFile("content/posts/b.md", { title: "B", order: 2 }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result[0]!.fields["order"]!.zodType, "z.number()");
  assert.equal(result[0]!.fields["order"]!.optional, false);
});

test("infers boolean fields as z.boolean()", () => {
  const files = [
    makeFile("content/posts/a.md", { draft: true }),
    makeFile("content/posts/b.md", { draft: false }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result[0]!.fields["draft"]!.zodType, "z.boolean()");
});

test("infers array of strings fields as z.array(z.string())", () => {
  const files = [
    makeFile("content/posts/a.md", { tags: ["js", "ts"] }),
    makeFile("content/posts/b.md", { tags: ["go"] }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result[0]!.fields["tags"]!.zodType, "z.array(z.string())");
});

test("infers multiple types from multiple directories", () => {
  const files = [
    makeFile("content/posts/a.md", { title: "Post A" }),
    makeFile("content/pages/home.md", { title: "Home", slug: "/" }),
    makeFile("content/pages/about.md", { title: "About", slug: "/about" }),
  ];

  const result = inferSchema(files, ["content/posts", "content/pages"]);

  assert.equal(result.length, 2);
  assert.equal(result[0]!.name, "post");
  assert.equal(result[0]!.fileCount, 1);
  assert.equal(result[1]!.name, "page");
  assert.equal(result[1]!.fileCount, 2);
});

test("singularizes common directory names", () => {
  const dirs = [
    "content/posts",
    "content/pages",
    "content/authors",
    "content/categories",
    "content/tags",
    "content/articles",
    "content/products",
    "content/users",
    "content/images",
    "content/comments",
    "content/reviews",
    "content/events",
  ];

  // Create one file per directory so the type is produced
  const files = dirs.map((dir) => makeFile(`${dir}/a.md`, { title: "x" }));

  const result = inferSchema(files, dirs);

  const names = result.map((t) => t.name);
  assert.deepEqual(names, [
    "post",
    "page",
    "author",
    "category",
    "tag",
    "article",
    "product",
    "user",
    "image",
    "comment",
    "review",
    "event",
  ]);
});

test("detects reference fields when field name matches another type", () => {
  const files = [
    makeFile("content/posts/a.md", { title: "Post A", author: "john-doe" }),
    makeFile("content/posts/b.md", { title: "Post B", author: "jane-doe" }),
    makeFile("content/authors/john.md", { name: "John" }),
    makeFile("content/authors/jane.md", { name: "Jane" }),
  ];

  const result = inferSchema(files, ["content/posts", "content/authors"]);

  const postType = result.find((t) => t.name === "post")!;
  assert.equal(
    postType.fields["author"]!.zodType,
    'fieldTypes.reference("author")',
  );
});

test("ignores files outside selected directories", () => {
  const files = [
    makeFile("content/posts/a.md", { title: "Post A" }),
    makeFile("content/drafts/b.md", { title: "Draft B" }),
    makeFile("other/random.md", { title: "Random" }),
  ];

  const result = inferSchema(files, ["content/posts"]);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "post");
  assert.equal(result[0]!.fileCount, 1);
});
