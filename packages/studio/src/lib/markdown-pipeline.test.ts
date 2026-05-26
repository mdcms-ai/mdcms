import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import {
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
  roundTripMarkdown,
  serializeDocumentToMarkdown,
} from "./markdown-pipeline.js";

test("markdown pipeline parses markdown into a TipTap document", () => {
  const document = parseMarkdownToDocument("# Launch Notes\n\nHello world.");

  assert.equal(document.type, "doc");
  assert.ok(Array.isArray(document.content));
});

test("markdown pipeline round-trip is stable after first serialization", () => {
  const input = [
    "# Launch Notes",
    "",
    "- Alpha",
    "- Beta",
    "",
    "```ts",
    "const value = 42;",
    "```",
    "",
    "Paragraph text.",
  ].join("\n");

  const first = roundTripMarkdown(input).markdown;
  const second = roundTripMarkdown(first).markdown;

  assert.equal(second, first);
});

test("markdown pipeline can serialize parsed document back to markdown", () => {
  const source = "## Heading\n\nBody copy";
  const parsed = parseMarkdownToDocument(source);
  const serialized = serializeDocumentToMarkdown(parsed);

  assert.equal(typeof serialized, "string");
  assert.equal(serialized.length > 0, true);
});

test("markdown pipeline preserves wrapper MDX blocks with nested markdown children", () => {
  const source = [
    '<Callout type="warning">',
    "This is **important** content.",
    "",
    "- One",
    "- Two",
    "</Callout>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);

  assert.equal(parsed.type, "doc");
  assert.ok(Array.isArray(parsed.content));
  assert.deepEqual(parsed.content?.[0], {
    type: "mdxComponent",
    attrs: {
      componentName: "Callout",
      isVoid: false,
      props: {
        type: "warning",
      },
    },
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "This is " },
          { type: "text", marks: [{ type: "bold" }], text: "important" },
          { type: "text", text: " content." },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "One" }] },
            ],
          },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Two" }] },
            ],
          },
        ],
      },
    ],
  });

  const serialized = serializeDocumentToMarkdown(parsed);

  assert.match(serialized, /<Callout type="warning">/);
  assert.match(serialized, /\*\*important\*\*/);
  assert.match(serialized, /- One/);
  assert.match(serialized, /<\/Callout>/);
});

test("markdown pipeline parses nested MDX components inside wrapper children", () => {
  const source = [
    '<Box style={{backgroundColor: "#101010", padding: "2rem"}}>',
    '<Text style={{fontSize: "2.5rem", fontWeight: "bold"}}>Welcome to Our Platform</Text>',
    '<Link href="/signup" style={{color: "#fff"}}>Get Started</Link>',
    "</Box>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);

  assert.deepEqual(parsed.content?.[0], {
    type: "mdxComponent",
    attrs: {
      componentName: "Box",
      isVoid: false,
      props: {
        style: {
          backgroundColor: "#101010",
          padding: "2rem",
        },
      },
    },
    content: [
      {
        type: "mdxComponent",
        attrs: {
          componentName: "Text",
          isVoid: false,
          props: {
            style: {
              fontSize: "2.5rem",
              fontWeight: "bold",
            },
          },
        },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Welcome to Our Platform" }],
          },
        ],
      },
      {
        type: "mdxComponent",
        attrs: {
          componentName: "Link",
          isVoid: false,
          props: {
            href: "/signup",
            style: {
              color: "#fff",
            },
          },
        },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Get Started" }],
          },
        ],
      },
    ],
  });
});

test("markdown pipeline keeps wrapper MDX serialization stable after first pass", () => {
  const source = [
    '<Callout type="warning">',
    "Paragraph",
    "",
    "1. First",
    "2. Second",
    "</Callout>",
  ].join("\n");

  const first = roundTripMarkdown(source).markdown;
  const second = roundTripMarkdown(first).markdown;

  assert.equal(second, first);
});

test("markdown pipeline preserves wrapper content when fenced code contains a literal closing tag", () => {
  const source = [
    "<Callout>",
    "```html",
    "</Callout>",
    "```",
    "</Callout>",
  ].join("\n");

  assert.equal(roundTripMarkdown(source).markdown, source);
});

test("markdown pipeline preserves raw JSX prop expressions instead of throwing", () => {
  const source = '<Callout config={{foo: "bar"}} />';

  assert.equal(roundTripMarkdown(source).markdown, source);
});

test("markdown pipeline keeps escaped quotes in string props stable", () => {
  const source = '<Callout title="He said \\"hi\\"" />';

  assert.equal(roundTripMarkdown(source).markdown, source);
});

test("markdown pipeline throws explicit error when serializer is unavailable", () => {
  assert.throws(
    () => extractMarkdownFromEditor({} as never),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.code, "MARKDOWN_SERIALIZATION_UNAVAILABLE");
      return true;
    },
  );
});

test("markdown pipeline throws explicit error when serializer returns non-string", () => {
  assert.throws(
    () =>
      extractMarkdownFromEditor({
        getMarkdown: () => 42,
      } as never),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.equal(error.code, "MARKDOWN_SERIALIZATION_FAILED");
      return true;
    },
  );
});

test("markdown pipeline preserves known language info strings on roundtrip", () => {
  const source = ["```ts", "const value = 42;", "```", ""].join("\n");
  const { markdown } = roundTripMarkdown(source);

  assert.match(markdown, /^```ts\n/m);
  assert.match(markdown, /const value = 42;/);
});

test("markdown pipeline preserves unknown language info strings on roundtrip", () => {
  const source = ["```brainfuck", "++[>++<-]", "```", ""].join("\n");
  const { markdown } = roundTripMarkdown(source);

  assert.match(markdown, /^```brainfuck\n/m);
  assert.match(markdown, /\+\+\[>\+\+<-\]/);
});

test("markdown pipeline preserves empty fence code blocks on roundtrip", () => {
  const source = ["```", "let x = 1;", "```", ""].join("\n");
  const { markdown } = roundTripMarkdown(source);

  assert.match(markdown, /^```\n/m);
  assert.match(markdown, /let x = 1;/);
});

test("markdown pipeline parses fenced code block with language attribute", () => {
  const document = parseMarkdownToDocument("```ts\nconst x = 1;\n```\n");
  const firstChild = document.content?.[0];

  assert.equal(firstChild?.type, "codeBlock");
  assert.equal(
    (firstChild?.attrs as { language?: string } | undefined)?.language,
    "ts",
  );
});
