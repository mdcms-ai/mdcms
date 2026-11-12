import assert from "node:assert/strict";
import { test } from "bun:test";

import { inferContentFormat } from "./content-format.js";

test("plain Markdown is md", () => {
  assert.equal(inferContentFormat(""), "md");
  assert.equal(
    inferContentFormat("# Title\n\nSome *text* and a [link](https://x.y)."),
    "md",
  );
});

test("component elements make a body mdx", () => {
  assert.equal(inferContentFormat("Intro\n\n<Cta />\n"), "mdx");
  assert.equal(inferContentFormat("<Callout>\n\nHi\n\n</Callout>"), "mdx");
  assert.equal(inferContentFormat('Text <Badge label="x" /> inline'), "mdx");
  assert.equal(inferContentFormat("<Docs.Note>\nx\n</Docs.Note>"), "mdx");
  assert.equal(inferContentFormat("(<Tooltip>hi</Tooltip>)"), "mdx");
});

test("ESM import and export lines make a body mdx", () => {
  assert.equal(
    inferContentFormat('import { Chart } from "./chart"\n\n# Hi'),
    "mdx",
  );
  assert.equal(inferContentFormat("export const meta = {}\n\nText"), "mdx");
});

test("HTML, braces, generics and autolinks stay md", () => {
  assert.equal(inferContentFormat('<div class="x">hi</div>'), "md");
  assert.equal(inferContentFormat("Use {braces} and {props.year}."), "md");
  assert.equal(inferContentFormat("A list of Array<T> values."), "md");
  assert.equal(inferContentFormat("See <https://example.com>."), "md");
  assert.equal(inferContentFormat("Imports matter. import is a word."), "md");
});

test("components inside code do not count", () => {
  assert.equal(inferContentFormat("```tsx\n<Cta />\n```\n"), "md");
  assert.equal(inferContentFormat("~~~\nimport x from 'y'\n~~~"), "md");
  assert.equal(inferContentFormat("Write `<Cta />` to add one."), "md");
  assert.equal(inferContentFormat("Write ``<Cta />`` to add one."), "md");
  assert.equal(inferContentFormat("```\n<Cta />\n```\n\n<Cta />"), "mdx");
  // An unclosed fence runs to the end of the body.
  assert.equal(inferContentFormat("```\n<Cta />\n"), "md");
});

test("a closing fence may be indented differently from its opener", () => {
  assert.equal(inferContentFormat(" ~~~\nexample\n~~~\n\n<Cta />"), "mdx");
  assert.equal(inferContentFormat("```\nexample\n   ```\n\n<Cta />"), "mdx");
  assert.equal(inferContentFormat("  ```\n<Cta />\n```\n"), "md");
});

test("components next to inline Markdown markers and punctuation count", () => {
  assert.equal(inferContentFormat("**<Cta />**"), "mdx");
  assert.equal(inferContentFormat("_<Badge label='x' />_"), "mdx");
  assert.equal(inferContentFormat("Hello,<Cta />"), "mdx");
  assert.equal(inferContentFormat("List<String> and Map<K, V>"), "md");
});

test("components inside indented code blocks do not count", () => {
  assert.equal(inferContentFormat("# Example\n\n    <Cta />\n"), "md");
  assert.equal(inferContentFormat("Text\n\n\t<Cta />\n\nMore text."), "md");
  // Indented lines continuing a paragraph or a list item are not code.
  assert.equal(inferContentFormat("Text\n    <Cta />\n"), "mdx");
  assert.equal(inferContentFormat("- item\n\n    <Cta />\n"), "mdx");
  // A non-indented component after an indented code block still counts.
  assert.equal(inferContentFormat("Intro\n\n    code\n\n<Cta />"), "mdx");
});
