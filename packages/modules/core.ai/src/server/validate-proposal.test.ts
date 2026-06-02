import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import type {
  MdxComponentCatalog,
  SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";

import type { AiProposalCandidate } from "./proposal-builder.js";
import {
  createMdxCatalogProposalValidator,
  createSchemaAwareProposalValidator,
  type SchemaLookup,
} from "./validate-proposal.js";

const BLOG_SCHEMA: SchemaRegistryTypeSnapshot = {
  type: "blog",
  directory: "blog",
  localized: true,
  fields: {
    title: { kind: "string", required: true, nullable: false },
    date: { kind: "date", required: true, nullable: false },
    description: { kind: "string", required: false, nullable: true },
    tags: { kind: "array", required: false, nullable: false },
    published: { kind: "boolean", required: false, nullable: false },
  },
};

const PAGE_SCHEMA: SchemaRegistryTypeSnapshot = {
  type: "page",
  directory: "pages",
  localized: false,
  fields: {
    title: { kind: "string", required: true, nullable: false },
  },
};

const SCHEMA_REGISTRY: Record<string, SchemaRegistryTypeSnapshot> = {
  blog: BLOG_SCHEMA,
  page: PAGE_SCHEMA,
};

const lookup: SchemaLookup = async ({ type }) => SCHEMA_REGISTRY[type];

function createCandidate(
  overrides: Partial<AiProposalCandidate> = {},
): AiProposalCandidate {
  return {
    proposalId: "prop_test",
    kind: "create_document",
    project: "demo",
    environment: "draft",
    type: "blog",
    locale: "en",
    summary: "Test proposal",
    operations: [
      {
        op: "create_document",
        path: "blog/test",
        format: "md",
        frontmatter: {
          title: "Hello",
          date: "2026-05-15",
        },
        body: "Body content",
      },
    ],
    expiresAt: "2026-05-15T00:05:00.000Z",
    provider: {
      providerId: "echo",
      model: "echo-1",
      promptTemplateId: "chat_tools.v1",
    },
    ...overrides,
  };
}

describe("createSchemaAwareProposalValidator — create_document", () => {
  test("accepts a proposal with all required fields", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(createCandidate());
    assert.equal(result.status, "valid");
  });

  test("flags an unknown content type", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(createCandidate({ type: "podcast" }));
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const codes = result.errors.map((e) => e.code);
      assert.ok(codes.includes("UNKNOWN_CONTENT_TYPE"));
    }
  });

  test("flags missing required frontmatter fields", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/test",
            format: "md",
            frontmatter: {},
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const requiredErrors = result.errors.filter(
        (e) => e.code === "MISSING_REQUIRED_FRONTMATTER",
      );
      // blog schema marks `title` and `date` as required
      assert.equal(requiredErrors.length, 2);
      const fields = requiredErrors.map((e) => e.path);
      assert.ok(fields.includes("frontmatter.title"));
      assert.ok(fields.includes("frontmatter.date"));
    }
  });

  test("flags unknown frontmatter fields", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/test",
            format: "md",
            frontmatter: {
              title: "Hi",
              date: "2026-05-15",
              madeUpField: "oops",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const unknownErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_FRONTMATTER_FIELD",
      );
      assert.equal(unknownErrors.length, 1);
      assert.equal(unknownErrors[0]?.path, "frontmatter.madeUpField");
    }
  });

  test("flags wrong runtime types for frontmatter values", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/test",
            format: "md",
            frontmatter: {
              title: 42, // schema expects string
              date: "2026-05-15",
              tags: "not-an-array", // schema expects array
              published: "yes", // schema expects boolean
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const typeErrors = result.errors.filter(
        (e) => e.code === "INVALID_FRONTMATTER_TYPE",
      );
      assert.equal(typeErrors.length, 3);
    }
  });

  test("accepts numeric values for numeric-option enum fields", async () => {
    const numericEnumSchema: SchemaRegistryTypeSnapshot = {
      type: "rating",
      directory: "ratings",
      localized: false,
      fields: {
        title: { kind: "string", required: true, nullable: false },
        score: {
          kind: "enum",
          required: true,
          nullable: false,
          options: [1, 2, 3, 4, 5],
        },
      },
    };
    const numericLookup: SchemaLookup = async ({ type }) =>
      type === "rating" ? numericEnumSchema : undefined;
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: numericLookup,
    });
    const result = await validator(
      createCandidate({
        type: "rating",
        operations: [
          {
            op: "create_document",
            path: "ratings/test",
            format: "md",
            frontmatter: { title: "Hello", score: 4 },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });

  test("aggregates multiple errors", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/test",
            format: "md",
            frontmatter: {
              title: 42,
              unknownField: "extra",
              // missing: date
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const codes = result.errors.map((e) => e.code).sort();
      assert.deepEqual(codes, [
        "INVALID_FRONTMATTER_TYPE",
        "MISSING_REQUIRED_FRONTMATTER",
        "UNKNOWN_FRONTMATTER_FIELD",
      ]);
    }
  });

  test("accepts nullable fields with null value", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/test",
            format: "md",
            frontmatter: {
              title: "Hi",
              date: "2026-05-15",
              description: null, // nullable: true
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });
});

describe("createSchemaAwareProposalValidator — update_frontmatter", () => {
  test("accepts a patch with known fields and correct types", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "update_frontmatter",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Update title",
      operations: [
        {
          op: "update_frontmatter",
          patch: { title: "New title", tags: ["a", "b"] },
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "valid");
  });

  test("flags unknown fields in patch", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "update_frontmatter",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Update",
      operations: [
        {
          op: "update_frontmatter",
          patch: { madeUp: "oops" },
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "UNKNOWN_FRONTMATTER_FIELD");
    }
  });

  test("does NOT enforce required fields on patch (update is a partial)", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    // patch only updates description (optional), even though blog requires title+date
    const result = await validator({
      proposalId: "p1",
      kind: "update_frontmatter",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Update description",
      operations: [
        {
          op: "update_frontmatter",
          patch: { description: "Just a description update" },
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "valid");
  });
});

describe("createSchemaAwareProposalValidator — other kinds", () => {
  test("replace_selection is shape-valid (no MDX catalog yet)", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "replace_selection",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Replace",
      operations: [
        {
          op: "replace_selection",
          selectionId: "sel_1",
          originalText: "old",
          replacementText: "new",
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "valid");
  });

  test("insert_block is shape-valid (no MDX catalog yet)", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Insert",
      operations: [
        {
          op: "insert_block",
          bodyMdx: "<Callout>hi</Callout>",
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "valid");
  });

  test("rejects insert_block MDX that the Studio parser cannot parse", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert feature grid",
      operations: [
        {
          op: "insert_block",
          bodyMdx:
            '<FeatureGrid features=\'[{"title":"Drop","description":"Once they\\\'re gone, they\\\'re gone."}]\' />',
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "MDX_PARSE_FAILED");
      assert.equal(result.errors[0]?.path, "operations[0].bodyMdx");
      assert.match(result.errors[0]?.message ?? "", /Studio MDX parser/);
    }
  });

  test("delete_document is shape-valid (chat-tools handles published-version check)", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "delete_document",
      project: "demo",
      environment: "draft",
      type: "blog",
      locale: "en",
      summary: "Delete",
      documentId: "doc_1",
      baseDraftRevision: 4,
      operations: [
        {
          op: "delete_document",
          path: "blog/old",
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "valid");
  });
});

describe("createMdxCatalogProposalValidator", () => {
  const catalog: MdxComponentCatalog = {
    components: [
      {
        name: "Callout",
        importPath: "@/components/mdx/Callout",
        extractedProps: {
          tone: {
            type: "enum",
            required: true,
            values: ["info", "warning"],
          },
        },
      },
    ],
  };

  test("flags create_document body that uses an unregistered MDX component", async () => {
    const baseValidator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const validator = createMdxCatalogProposalValidator({
      validator: baseValidator,
      catalog,
    });
    const result = await validator(
      createCandidate({
        type: "page",
        operations: [
          {
            op: "create_document",
            path: "pages/image-carousel",
            format: "mdx",
            frontmatter: { title: "Image Carousel" },
            body: [
              "<Carousel>",
              '  <img src="/images/slide1.jpg" alt="Slide 1" />',
              "</Carousel>",
            ].join("\n"),
          },
        ],
      }),
    );

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "MDX_UNKNOWN_COMPONENT");
      assert.equal(result.errors[0]?.path, "operations[0].body");
    }
  });

  test("flags presentation-only lowercase MDX blocks that bypass the component catalog", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert testimonials",
      operations: [
        {
          op: "insert_block",
          bodyMdx: [
            "<section>",
            "  <div>",
            "    <p>WHAT PEOPLE SAY</p>",
            "    <h2>Loved by teams that <span>ship fast</span></h2>",
            "  </div>",
            "</section>",
          ].join("\n"),
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "MDX_UNGROUNDED_INTRINSIC_ELEMENT");
      assert.equal(result.errors[0]?.path, "operations[0].bodyMdx");
      assert.match(result.errors[0]?.message ?? "", /<section>/);
    }
  });

  test("allows lowercase MDX when native form semantics are required", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert signup form",
      operations: [
        {
          op: "insert_block",
          bodyMdx: [
            "<form>",
            '  <label htmlFor="email">Email</label>',
            '  <input id="email" name="email" type="email" />',
            "  <button>Join waitlist</button>",
            "</form>",
          ].join("\n"),
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "valid");
  });

  test("flags missing required props on registered MDX components", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert callout",
      operations: [{ op: "insert_block", bodyMdx: "<Callout>Hi</Callout>" }],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "MDX_MISSING_REQUIRED_PROP");
      assert.equal(result.errors[0]?.path, "operations[0].bodyMdx");
    }
  });

  test("accepts registered MDX components with valid props", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert callout",
      operations: [
        { op: "insert_block", bodyMdx: '<Callout tone="info">Hi</Callout>' },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "valid");
  });

  test("accepts built-in MDX components registered in the catalog", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog: {
        components: [
          {
            name: "Box",
            importPath: "@mdcms/sdk/react-primitives",
            builtIn: true,
            extractedProps: {
              children: { type: "rich-text", required: false },
              style: { type: "style", required: false },
            },
          },
        ],
      },
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert built-in box",
      operations: [
        {
          op: "insert_block",
          bodyMdx:
            '<Box style={{ padding: "24px", backgroundColor: "#fff", marginTop: 8, opacity: .5, translate: -.5, zIndex: 1e3 }}>Hi</Box>',
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "valid");
  });

  test("rejects invalid style prop values", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog: {
        components: [
          {
            name: "Box",
            importPath: "@mdcms/sdk/react-primitives",
            builtIn: true,
            extractedProps: {
              style: { type: "style", required: false },
            },
          },
        ],
      },
    });

    const cases = [
      ['<Box style="color: red" />', "string"],
      ['<Box style={{"color":{"nested":"red"}}} />', "nested object"],
      ['<Box style={["color"]} />', "array"],
      ["<Box style={true} />", "boolean"],
      ["<Box style={null} />", "null"],
      ["<Box style={theme.hero} />", "unparseable expression"],
      ["<Box style={{ zIndex: 1e9999 }} />", "non-finite number"],
    ] as const;

    for (const [bodyMdx, label] of cases) {
      const result = await validator({
        proposalId: `p_${label.replaceAll(" ", "_")}`,
        kind: "insert_block",
        project: "demo",
        environment: "draft",
        type: "page",
        locale: "en",
        summary: `Insert invalid ${label} style`,
        operations: [{ op: "insert_block", bodyMdx }],
        expiresAt: "2026-05-15T00:05:00.000Z",
        provider: {
          providerId: "echo",
          model: "echo-1",
          promptTemplateId: "chat_tools.v1",
        },
      });

      assert.equal(result.status, "invalid", label);
      if (result.status === "invalid") {
        assert.equal(result.errors[0]?.code, "MDX_INVALID_PROP_TYPE");
        assert.equal(result.errors[0]?.path, "operations[0].bodyMdx");
      }
    }
  });

  test("rejects unknown props on built-in MDX components", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog: {
        components: [
          {
            name: "Box",
            importPath: "@mdcms/sdk/react-primitives",
            builtIn: true,
            extractedProps: {
              style: { type: "style", required: false },
            },
          },
        ],
      },
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert box",
      operations: [
        {
          op: "insert_block",
          bodyMdx: '<Box style={{"padding":12}} className="hero" />',
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      assert.equal(result.errors[0]?.code, "MDX_UNKNOWN_PROP");
      assert.equal(result.errors[0]?.path, "operations[0].bodyMdx");
    }
  });

  test("does not validate props when registered component props were not extracted", async () => {
    const validator = createMdxCatalogProposalValidator({
      validator: async () => ({ status: "valid" }),
      catalog: {
        components: [
          {
            name: "Hero",
            importPath: "@/components/mdx/Hero",
          },
        ],
      },
    });
    const result = await validator({
      proposalId: "p1",
      kind: "insert_block",
      project: "demo",
      environment: "draft",
      type: "page",
      locale: "en",
      summary: "Insert hero",
      operations: [
        {
          op: "insert_block",
          bodyMdx: '<Hero title="Launch" eyebrow="News">Hello</Hero>',
        },
      ],
      expiresAt: "2026-05-15T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });

    assert.equal(result.status, "valid");
  });
});

const POST_WITH_REF_SCHEMA: SchemaRegistryTypeSnapshot = {
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
    coauthors: {
      kind: "array",
      required: false,
      nullable: false,
      item: {
        kind: "reference",
        required: true,
        nullable: false,
        reference: { targetType: "author" },
      },
    },
  },
};

const REF_REGISTRY: Record<string, SchemaRegistryTypeSnapshot> = {
  post: POST_WITH_REF_SCHEMA,
};

const refLookup: SchemaLookup = async ({ type }) => REF_REGISTRY[type];

describe("createSchemaAwareProposalValidator — UNKNOWN_REFERENCE", () => {
  test("flags create_document with a missing author reference", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async ({ documentId }) =>
        documentId === "33333333-3333-4333-8333-333333333333",
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: "99999999-9999-4999-8999-999999999999",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 1);
      assert.equal(refErrors[0]?.path, "frontmatter.author");
    }
  });

  test("allows create_document with a real reference", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async ({ documentId }) =>
        documentId === "33333333-3333-4333-8333-333333333333",
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: "33333333-3333-4333-8333-333333333333",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });

  test("flags missing references inside array fields", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async ({ documentId }) =>
        documentId === "11111111-1111-4111-8111-111111111111" ||
        documentId === "22222222-2222-4222-8222-222222222222",
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              coauthors: [
                "11111111-1111-4111-8111-111111111111",
                "99999999-9999-4999-8999-999999999999",
                "22222222-2222-4222-8222-222222222222",
              ],
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 1);
      assert.equal(refErrors[0]?.path, "frontmatter.coauthors[1]");
    }
  });

  test("flags non-UUID reference values without calling the lookup", async () => {
    // Regression: the model sometimes writes a human-readable name
    // (e.g. "Demo User") into a reference field. The validator must
    // catch this up front rather than handing a malformed id to a
    // uuid-typed lookup whose driver-level behaviour can mask the
    // problem (silent zero rows look like "exists: true" on a happy
    // path that doesn't actually exist).
    let lookupCalls = 0;
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async () => {
        lookupCalls += 1;
        return true;
      },
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: "Demo User",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(lookupCalls, 0);
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 1);
      assert.match(
        refErrors[0]?.message ?? "",
        /must be a UUID string referencing "author"/,
      );
    }
  });

  test("treats a lookup failure as 'does not exist'", async () => {
    // If the underlying lookup throws (transient DB error, driver
    // coercion issue, etc.) the validator should still produce a
    // useful UNKNOWN_REFERENCE rather than crashing the whole turn.
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async () => {
        throw new Error("simulated DB outage");
      },
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: "33333333-3333-4333-8333-333333333333",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 1);
    }
  });

  test("null on nullable reference field passes", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async () => false,
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: null,
            },
            body: "Body",
          },
        ],
      }),
    );
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 0);
    }
  });

  test("flags UNKNOWN_REFERENCE on update_frontmatter patch", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
      documentExists: async () => false,
    });
    const result = await validator({
      proposalId: "p1",
      kind: "update_frontmatter",
      project: "demo",
      environment: "draft",
      type: "post",
      locale: "en",
      summary: "update author",
      operations: [
        {
          op: "update_frontmatter",
          patch: { author: "99999999-9999-4999-8999-999999999999" },
        },
      ],
      expiresAt: "2026-05-16T00:05:00.000Z",
      provider: {
        providerId: "echo",
        model: "echo-1",
        promptTemplateId: "chat_tools.v1",
      },
    });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const refErrors = result.errors.filter(
        (e) => e.code === "UNKNOWN_REFERENCE",
      );
      assert.equal(refErrors.length, 1);
    }
  });

  test("skips ref check when documentExists is not provided", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: refLookup,
    });
    const result = await validator(
      createCandidate({
        type: "post",
        operations: [
          {
            op: "create_document",
            path: "blog/x",
            format: "md",
            frontmatter: {
              title: "x",
              date: "2026-05-15",
              author: "doc_anything",
            },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });
});

describe("createSchemaAwareProposalValidator — PATH_ALREADY_IN_USE", () => {
  test("flags create_document with a taken path", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
      pathExists: async ({ path }) => path === "blog/existing",
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/existing",
            format: "md",
            frontmatter: { title: "Hi", date: "2026-05-15" },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") {
      const codes = result.errors.map((e) => e.code);
      assert.ok(codes.includes("PATH_ALREADY_IN_USE"));
    }
  });

  test("allows create_document at a fresh path", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
      pathExists: async () => false,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/fresh",
            format: "md",
            frontmatter: { title: "Hi", date: "2026-05-15" },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });

  test("skips path check when pathExists is not provided", async () => {
    const validator = createSchemaAwareProposalValidator({
      schemaLookup: lookup,
    });
    const result = await validator(
      createCandidate({
        operations: [
          {
            op: "create_document",
            path: "blog/anything",
            format: "md",
            frontmatter: { title: "Hi", date: "2026-05-15" },
            body: "Body",
          },
        ],
      }),
    );
    assert.equal(result.status, "valid");
  });
});
