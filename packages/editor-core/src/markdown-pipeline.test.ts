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

test("markdown pipeline ignores editor-only trailing empty paragraphs", () => {
  const serialized = serializeDocumentToMarkdown({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "About" }],
      },
      { type: "paragraph" },
    ],
  });

  assert.equal(serialized, "# About");
});

test("markdown pipeline preserves explicit non-breaking-space paragraphs", () => {
  const source = "# About\n\n&nbsp;";
  const parsed = parseMarkdownToDocument(source);

  assert.equal(serializeDocumentToMarkdown(parsed), "# About\n\n\u00a0");
});

test("markdown pipeline preserves native image nodes as markdown image syntax", () => {
  const source = "![Hero image](https://cdn.example.com/hero.png)";
  const parsed = parseMarkdownToDocument(source);

  assert.deepEqual(parsed.content?.[0], {
    type: "image",
    attrs: {
      src: "https://cdn.example.com/hero.png",
      alt: "Hero image",
      title: null,
    },
  });
  assert.equal(serializeDocumentToMarkdown(parsed), source);
});

test("markdown pipeline preserves images between blocks as selectable block nodes", () => {
  const source = [
    "Before",
    "",
    "![Hero image](https://cdn.example.com/hero.png)",
    "",
    "After",
  ].join("\n");
  const parsed = parseMarkdownToDocument(source);

  assert.deepEqual(parsed.content, [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Before" }],
    },
    {
      type: "image",
      attrs: {
        src: "https://cdn.example.com/hero.png",
        alt: "Hero image",
        title: null,
      },
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "After" }],
    },
  ]);
  assert.equal(serializeDocumentToMarkdown(parsed), source);
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

test("markdown pipeline parses indented nested MDX components inside wrapper children", () => {
  const source = [
    '<Box style={{display: "grid", gap: "1rem"}}>',
    '  <Box style={{backgroundColor: "#f3f4f6", padding: "1rem"}}>',
    '    <Text style={{fontWeight: "bold"}}>2020</Text>',
    "    Company founded.",
    "  </Box>",
    '  <Box style={{backgroundColor: "#f3f4f6", padding: "1rem"}}>',
    '    <Text style={{fontWeight: "bold"}}>2021</Text>',
    "    Launched first product.",
    "  </Box>",
    "</Box>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);
  const wrapperChildren = parsed.content?.[0]?.content ?? [];

  assert.equal(parsed.content?.[0]?.type, "mdxComponent");
  assert.equal(wrapperChildren.length, 2);
  assert.equal(wrapperChildren[0]?.type, "mdxComponent");
  assert.equal(wrapperChildren[1]?.type, "mdxComponent");
  assert.equal(wrapperChildren[0]?.attrs?.componentName, "Box");
  assert.equal(wrapperChildren[1]?.attrs?.componentName, "Box");
  assert.equal(
    wrapperChildren.some((child) => JSON.stringify(child).includes("<Text")),
    false,
  );
});

test("markdown pipeline parses lowercase intrinsic wrappers as structured blocks", () => {
  const source = [
    '<div style={{display: "flex", gap: "2rem"}}>',
    '  <Hero headlineLead="AI-native CMS for" />',
    '  <FeatureGrid headingLead="Built for teams that" />',
    "</div>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);
  const wrapper = parsed.content?.[0];
  const wrapperChildren = wrapper?.content ?? [];

  assert.equal(wrapper?.type, "mdxIntrinsicElement");
  assert.equal(wrapper?.attrs?.tagName, "div");
  assert.equal(wrapper?.attrs?.isVoid, false);
  assert.deepEqual(wrapper?.attrs?.props, {
    style: {
      display: "flex",
      gap: "2rem",
    },
  });
  assert.equal(wrapperChildren.length, 2);
  assert.equal(wrapperChildren[0]?.type, "mdxComponent");
  assert.equal(wrapperChildren[0]?.attrs?.componentName, "Hero");
  assert.equal(wrapperChildren[1]?.type, "mdxComponent");
  assert.equal(wrapperChildren[1]?.attrs?.componentName, "FeatureGrid");
});

test("markdown pipeline parses intrinsic text elements without leaking JSX source", () => {
  const source = [
    '<section style={{backgroundColor: "#f7f3f3"}}>',
    "<div>",
    '<p style={{textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 500, letterSpacing: "2px", color: "rgb(47, 73, 229)", textTransform: "uppercase", marginBottom: "16px"}}>WHAT PEOPLE SAY</p>',
    '<h2>Loved by teams that <span style={{color: "rgb(47, 73, 229)"}}>ship fast</span></h2>',
    "</div>",
    "</section>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);
  const section = parsed.content?.[0];
  const div = section?.content?.[0];
  const eyebrow = div?.content?.[0];
  const heading = div?.content?.[1];
  const spanText = heading?.content?.[0]?.content?.[1];

  assert.equal(section?.type, "mdxIntrinsicElement");
  assert.equal(section?.attrs?.tagName, "section");
  assert.equal(div?.type, "mdxIntrinsicElement");
  assert.equal(div?.attrs?.tagName, "div");
  assert.equal(eyebrow?.type, "mdxIntrinsicElement");
  assert.equal(eyebrow?.attrs?.tagName, "p");
  assert.deepEqual(eyebrow?.attrs?.props, {
    style: {
      textAlign: "center",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      fontWeight: 500,
      letterSpacing: "2px",
      color: "rgb(47, 73, 229)",
      textTransform: "uppercase",
      marginBottom: "16px",
    },
  });
  assert.equal(heading?.type, "mdxIntrinsicElement");
  assert.equal(heading?.attrs?.tagName, "h2");
  assert.equal(spanText?.type, "text");
  assert.equal(spanText?.text, "ship fast");
  assert.deepEqual(spanText?.marks, [
    {
      type: "mdxIntrinsicInline",
      attrs: {
        tagName: "span",
        props: {
          style: {
            color: "rgb(47, 73, 229)",
          },
        },
      },
    },
  ]);

  assert.doesNotMatch(JSON.stringify(parsed), /<span style=/);
  assert.doesNotMatch(JSON.stringify(parsed), /<p style=/);

  const serialized = serializeDocumentToMarkdown(parsed);

  assert.match(
    serialized,
    /<span style=\{\{"color":"rgb\(47, 73, 229\)"\}\}>ship fast<\/span>/,
  );
});

test("markdown pipeline round-trips native form elements as structured intrinsic blocks", () => {
  const source = [
    '<form name="contact">',
    "<label>",
    "Name",
    '<input type="text" name="name" required />',
    "</label>",
    '<button type="submit">Send</button>',
    "</form>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);
  const serialized = serializeDocumentToMarkdown(parsed);

  assert.equal(parsed.content?.[0]?.type, "mdxIntrinsicElement");
  assert.equal(parsed.content?.[0]?.attrs?.tagName, "form");
  assert.match(serialized, /<form name="contact">/);
  assert.match(serialized, /<label>/);
  assert.match(
    serialized,
    /<input type="text" name="name" required=\{true\} \/>/,
  );
  assert.match(serialized, /<button type="submit">/);
  assert.doesNotMatch(JSON.stringify(parsed), /mdxRawJsx/);
});

test("markdown pipeline preserves unsupported raw MDX islands inside wrapper children", () => {
  const source = [
    '<HomeSection eyebrow="Content layer" title="Contact Us">',
    "<div {...dynamicProps}>",
    "Unsupported dynamic attributes are preserved.",
    "</div>",
    "</HomeSection>",
  ].join("\n");

  const parsed = parseMarkdownToDocument(source);

  assert.deepEqual(parsed.content?.[0], {
    type: "mdxComponent",
    attrs: {
      componentName: "HomeSection",
      isVoid: false,
      props: {
        eyebrow: "Content layer",
        title: "Contact Us",
      },
    },
    content: [
      {
        type: "mdxRawJsx",
        attrs: {
          source: [
            "<div {...dynamicProps}>",
            "Unsupported dynamic attributes are preserved.",
            "</div>",
          ].join("\n"),
        },
      },
    ],
  });
  assert.equal(serializeDocumentToMarkdown(parsed), source);
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

test("markdown pipeline keeps quoted string props stable", () => {
  const source = '<Callout title="He said &quot;hi&quot;" />';

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
