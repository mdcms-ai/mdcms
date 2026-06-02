import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import type {
  MdxComponentCatalog,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import { renderProjectKnowledgeBlock } from "./project-knowledge.js";

describe("renderProjectKnowledgeBlock", () => {
  test("renders the header even when types and locales are empty", () => {
    const block = renderProjectKnowledgeBlock({
      project: "marketing-site",
      environment: "staging",
      registeredTypes: [],
      supportedLocales: [],
    });
    assert.ok(block.includes("## Project knowledge"));
    assert.ok(block.includes("Project: marketing-site"));
    assert.ok(block.includes("Environment: staging"));
    assert.ok(
      block.includes(
        "No content types are registered yet — propose_create_document will fail until at least one is synced.",
      ),
    );
  });

  test("renders sanitized currentUser block", () => {
    const block = renderProjectKnowledgeBlock({
      project: "p",
      environment: "e",
      registeredTypes: [],
      supportedLocales: [],
      currentUser: { id: "user_1", displayName: "John `Doe`" },
    });
    // backticks are replaced with spaces; trailing space is trimmed so the
    // result is "John  Doe" (the backtick before D becomes a space)
    assert.ok(block.includes("Current user: John  Doe (id: user_1)"));
    assert.ok(!block.includes("`Doe`"));
  });

  test("strips newlines from sanitized fields", () => {
    const block = renderProjectKnowledgeBlock({
      project: "okay\n## Injected",
      environment: "draft",
      registeredTypes: [],
      supportedLocales: [],
    });
    // The newline must not produce a standalone "## Injected" heading line.
    assert.ok(!block.split("\n").some((l) => l.startsWith("## Injected")));
    assert.ok(block.includes("Project: okay ## Injected"));
  });

  test("neutralizes markdown structure characters in display name", () => {
    const block = renderProjectKnowledgeBlock({
      project: "p",
      environment: "e",
      registeredTypes: [],
      supportedLocales: [],
      currentUser: {
        id: "user_1",
        displayName: "*Eve* <admin> [root] ~strike~ | x",
      },
    });
    // Markdown/HTML structural punctuation must not survive in the
    // sanitized name — otherwise a hostile name could open a code span
    // or close out of the surrounding prompt context.
    for (const ch of ["*", "~", "<", ">", "[", "]", "|"]) {
      assert.ok(
        !block.includes(ch),
        `expected sanitizer to strip "${ch}" but it was present in: ${block}`,
      );
    }
    // The id keeps its `_` so opaque tokens stay intact.
    assert.ok(block.includes("(id: user_1)"));
  });

  test("renders an empty MDX catalog as a no-JSX instruction", () => {
    const block = renderProjectKnowledgeBlock({
      project: "p",
      environment: "e",
      registeredTypes: [],
      supportedLocales: [],
      mdxCatalog: { components: [] },
    });
    assert.ok(block.includes("### Registered MDX components"));
    assert.ok(
      block.includes(
        "No MDX components are registered. Do not generate JSX component tags in Markdown or MDX bodies.",
      ),
    );
  });

  test("renders registered MDX component names and props", () => {
    const mdxCatalog: MdxComponentCatalog = {
      components: [
        {
          name: "Callout",
          importPath: "./components/Callout",
          description: "Inline notice",
          extractedProps: {
            tone: {
              type: "enum",
              required: true,
              values: ["info", "warning"],
            },
            title: {
              type: "string",
              required: false,
            },
          },
        },
      ],
    };
    const block = renderProjectKnowledgeBlock({
      project: "p",
      environment: "e",
      registeredTypes: [],
      supportedLocales: [],
      mdxCatalog,
    });
    assert.ok(block.includes("### Registered MDX components"));
    assert.ok(
      block.includes(
        "Use only these component names when generating MDX. Any other component name fails validation.",
      ),
    );
    assert.ok(
      block.includes(
        "For visual composition, use registered components or built-ins instead of raw lowercase HTML containers.",
      ),
    );
    assert.ok(block.includes("- **Callout** — Inline notice"));
    assert.ok(block.includes('tone (enum "info" | "warning", required)'));
    assert.ok(block.includes("title (string, optional)"));
  });

  test("marks built-in MDX components and renders style props", () => {
    const mdxCatalog: MdxComponentCatalog = {
      components: [
        {
          name: "Box",
          importPath: "@mdcms/sdk/react-primitives",
          description: "Layout wrapper",
          builtIn: true,
          extractedProps: {
            style: {
              type: "style",
              required: false,
            },
          },
        },
      ],
    };
    const block = renderProjectKnowledgeBlock({
      project: "p",
      environment: "e",
      registeredTypes: [],
      supportedLocales: [],
      mdxCatalog,
    });

    assert.ok(block.includes("- **Box** (built-in) — Layout wrapper"));
    assert.ok(block.includes("style (style, optional)"));
  });
});

const POST_SCHEMA: SchemaRegistryTypeSnapshot = {
  type: "post",
  directory: "blog",
  localized: true,
  fields: {
    title: { kind: "string", required: true, nullable: false },
    date: { kind: "date", required: true, nullable: false },
    published: { kind: "boolean", required: false, nullable: false },
    excerpt: { kind: "string", required: false, nullable: true },
  },
};

test("renders a content type with simple kinds", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [POST_SCHEMA],
    supportedLocales: ["en"],
  });
  assert.ok(block.includes("- **post** (directory: blog, localized: yes)"));
  assert.ok(block.includes("- title (string, required)"));
  assert.ok(block.includes("- date (date, required)"));
  assert.ok(block.includes("- published (boolean, optional)"));
  assert.ok(block.includes("- excerpt (string, optional, nullable)"));
});

test("sorts types alphabetically for determinism", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      { ...POST_SCHEMA, type: "post" },
      {
        ...POST_SCHEMA,
        type: "author",
        localized: false,
        directory: "authors",
      },
    ],
    supportedLocales: [],
  });
  const authorIdx = block.indexOf("- **author**");
  const postIdx = block.indexOf("- **post**");
  assert.ok(authorIdx > 0);
  assert.ok(postIdx > authorIdx);
});

test("renders enum field with options", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      {
        type: "campaign",
        directory: "campaigns",
        localized: false,
        fields: {
          status: {
            kind: "enum",
            required: true,
            nullable: false,
            options: ["planned", "live", "archived"],
          },
        },
      },
    ],
    supportedLocales: [],
  });
  assert.ok(
    block.includes('status (enum: "planned" | "live" | "archived", required)'),
  );
});

test("renders reference field with target type", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      {
        type: "post",
        directory: "blog",
        localized: true,
        fields: {
          author: {
            kind: "reference",
            required: false,
            nullable: true,
            reference: { targetType: "author" },
          },
        },
      },
    ],
    supportedLocales: [],
  });
  assert.ok(block.includes("author (reference → author, optional, nullable)"));
  // Reference fields trigger the "use real UUIDs" guidance section so
  // the model doesn't paste a display name into a reference field.
  assert.ok(block.includes("### Reference fields require real entry ids"));
  assert.ok(block.includes("find_entries"));
});

test("omits the reference-guidance section when no schema has a reference", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      {
        type: "page",
        directory: "pages",
        localized: false,
        fields: {
          title: { kind: "string", required: true, nullable: false },
        },
      },
    ],
    supportedLocales: [],
  });
  assert.ok(!block.includes("Reference fields require real entry ids"));
});

test("renders array field with item kind", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      {
        type: "post",
        directory: "blog",
        localized: true,
        fields: {
          tags: {
            kind: "array",
            required: false,
            nullable: false,
            item: { kind: "string", required: true, nullable: false },
          },
        },
      },
    ],
    supportedLocales: [],
  });
  assert.ok(block.includes("tags (array of string, optional)"));
});

test("renders nested object up to depth 2; deeper collapses", () => {
  const block = renderProjectKnowledgeBlock({
    project: "p",
    environment: "e",
    registeredTypes: [
      {
        type: "page",
        directory: "pages",
        localized: false,
        fields: {
          seo: {
            kind: "object",
            required: false,
            nullable: false,
            fields: {
              title: { kind: "string", required: false, nullable: false },
              og: {
                kind: "object",
                required: false,
                nullable: false,
                fields: {
                  image: {
                    kind: "object",
                    required: false,
                    nullable: false,
                    fields: {
                      url: {
                        kind: "string",
                        required: false,
                        nullable: false,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
    supportedLocales: [],
  });
  // Depth-1 nested object renders its sub-bullets:
  assert.ok(block.includes("seo (object, optional)"));
  assert.ok(block.includes("    - title (string, optional)"));
  // Depth-2 collapses to <nested object> hint:
  assert.ok(block.includes("og (<nested object>"));
});

test("snapshot: marketing-site fixture", () => {
  const block = renderProjectKnowledgeBlock({
    project: "marketing-site",
    environment: "staging",
    currentUser: { id: "user_1", displayName: "Karol Chudzik" },
    supportedLocales: ["en", "pl"],
    registeredTypes: [
      {
        type: "author",
        directory: "authors",
        localized: false,
        fields: {
          name: { kind: "string", required: true, nullable: false },
          bio: { kind: "string", required: false, nullable: true },
        },
      },
      {
        type: "post",
        directory: "blog",
        localized: true,
        fields: {
          title: { kind: "string", required: true, nullable: false },
          date: { kind: "date", required: true, nullable: false },
          author: {
            kind: "reference",
            required: false,
            nullable: true,
            reference: { targetType: "author" },
          },
          tags: {
            kind: "array",
            required: false,
            nullable: false,
            item: { kind: "string", required: true, nullable: false },
          },
        },
      },
    ],
  });
  assert.ok(block.startsWith("## Project knowledge"));
  assert.ok(block.includes("Project: marketing-site"));
  assert.ok(block.includes("Current user: Karol Chudzik (id: user_1)"));
  assert.ok(block.includes("- **author**"));
  assert.ok(block.includes("- **post**"));
  assert.ok(block.includes("author (reference → author"));
  assert.ok(block.includes("tags (array of string"));
  assert.ok(block.includes("### Supported locales"));
  assert.ok(block.includes("en, pl"));
  assert.ok(block.indexOf("- **author**") < block.indexOf("- **post**"));
});
