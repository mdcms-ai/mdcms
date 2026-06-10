import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import ts from "typescript";
import { z } from "zod";

import { RuntimeError } from "../runtime/error.js";
import {
  IMPLICIT_DEFAULT_LOCALE,
  defineConfig,
  defineType,
  fieldTypes,
  type MdcmsFileFieldOptions,
  parseMdcmsConfig,
} from "./config.js";
import { serializeResolvedEnvironmentSchema } from "./schema.js";

const TYPECHECK_TEST_TIMEOUT_MS = 15_000;

function typecheckSource(source: string) {
  const tempDir = dirname(fileURLToPath(import.meta.url));
  const tempFile = join(
    tempDir,
    `.__component-loader-contract-${randomUUID()}.ts`,
  );

  writeFileSync(tempFile, source, "utf8");

  try {
    const program = ts.createProgram([tempFile], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      esModuleInterop: true,
      types: ["node"],
    });

    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
      [],
    );
  } finally {
    rmSync(tempFile, { force: true });
  }
}

const standardStringSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate(value: unknown) {
      if (typeof value === "string") {
        return { value };
      }

      return {
        issues: [{ message: "must be a string" }],
      };
    },
  },
};

function serializeFieldSnapshot(field: z.ZodType, fieldName = "asset") {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: {
            [fieldName]: field,
          },
        }),
      ],
      environments: {
        production: {},
      },
    }),
  );

  return serializeResolvedEnvironmentSchema(parsed, "production").Post?.fields[
    fieldName
  ];
}

const createRuntimeFileField = fieldTypes.file as unknown as (
  options: MdcmsFileFieldOptions,
) => z.ZodType;

function expectInvalidConfig(fn: () => unknown, message?: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "INVALID_CONFIG");

    if (message) {
      assert.match(error.message, message);
    }

    return true;
  });
}

test(
  "defineConfig accepts runtime-only component loader callbacks",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import type { MdcmsConfig } from "./config.ts";
    import { defineConfig } from "./config.ts";

    const config: MdcmsConfig = {
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      components: [
        {
          name: "Chart",
          importPath: "@/components/mdx/Chart",
          load: async () => ({}),
          loadPropsEditor: async () => ({}),
        },
      ],
    };

    defineConfig(config);
  `);
  },
);

test(
  "defineType accepts runtime-only preview URL resolvers",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import { defineConfig, defineType } from "./config.ts";

    const article = defineType("article", {
      directory: "content/articles",
      fields: {},
      resolvePreviewUrl: (document) => {
        const slug = document.frontmatter.slug;
        return typeof slug === "string" ? "/articles/" + slug : null;
      },
    });

    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [article],
    });
  `);
  },
);

test(
  "file helpers preserve string schema methods in TypeScript",
  { timeout: TYPECHECK_TEST_TIMEOUT_MS },
  () => {
    typecheckSource(`
    import { fieldTypes } from "./config.ts";

    fieldTypes.file().min(1);
    fieldTypes.image().uuid();
  `);
  },
);

test("parseMdcmsConfig accepts typed propHints and preserves them", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      components: [
        {
          name: "Hero",
          importPath: "@/components/mdx/Hero",
          propHints: {
            website: { format: "url" },
            accent: { widget: "color-picker" },
            body: { widget: "textarea" },
            rating: { widget: "slider", min: 0, max: 10, step: 2 },
            image: { widget: "image" },
            variant: {
              widget: "select",
              options: ["primary", { label: "Secondary", value: "secondary" }],
            },
            hiddenProp: { widget: "hidden" },
            data: { widget: "json" },
          },
        },
      ],
    }),
  );

  assert.deepEqual(parsed.components[0]?.propHints, {
    website: { format: "url" },
    accent: { widget: "color-picker" },
    body: { widget: "textarea" },
    rating: { widget: "slider", min: 0, max: 10, step: 2 },
    image: { widget: "image" },
    variant: {
      widget: "select",
      options: ["primary", { label: "Secondary", value: "secondary" }],
    },
    hiddenProp: { widget: "hidden" },
    data: { widget: "json" },
  });
});

test("parseMdcmsConfig rejects malformed propHint shapes", () => {
  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          components: [
            {
              name: "Hero",
              importPath: "@/components/mdx/Hero",
              propHints: {
                website: { format: "url", widget: "textarea" },
              },
            },
          ],
        }),
      ),
    /components\[0\]\.propHints/,
  );

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          components: [
            {
              name: "Hero",
              importPath: "@/components/mdx/Hero",
              propHints: {
                rating: { widget: "slider", min: 10, max: 10 },
              },
            },
          ],
        }),
      ),
    /components\[0\]\.propHints/,
  );

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          components: [
            {
              name: "Hero",
              importPath: "@/components/mdx/Hero",
              propHints: {
                variant: { widget: "select", options: [] },
              },
            },
          ],
        }),
      ),
    /components\[0\]\.propHints/,
  );
});

test("parseMdcmsConfig preserves content type preview URL resolvers", () => {
  const resolvePreviewUrl = () => "/preview/articles/launch-notes";
  const article = defineType("article", {
    directory: "content/articles",
    fields: {
      title: z.string().min(1),
    },
    resolvePreviewUrl,
  });

  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      environments: {
        production: {},
      },
      types: [article],
    }),
  );

  assert.equal(parsed.types[0]?.resolvePreviewUrl, resolvePreviewUrl);
  assert.equal(
    parsed.resolvedEnvironments.production?.types.article?.resolvePreviewUrl,
    resolvePreviewUrl,
  );
});

test("defineConfig/defineType/fieldTypes.reference produce a normalized shared config", () => {
  const author = defineType("Author", {
    directory: "content/authors",
    fields: {
      name: z.string().min(1),
    },
  });
  const blogPost = defineType("BlogPost", {
    directory: "content/blog",
    localized: true,
    fields: {
      title: z.string().min(1),
      author: fieldTypes.reference("Author"),
      relatedAuthor: fieldTypes.reference("Author").optional(),
      summary: standardStringSchema,
    },
  });
  const config = defineConfig({
    project: "  marketing-site  ",
    serverUrl: " http://localhost:4000 ",
    environment: " staging ",
    contentDirectories: [" ./content/ ", "content/shared/"],
    locales: {
      default: " en_us ",
      supported: [" en-US ", "fr"],
      aliases: {
        EN: "en_us",
        fr_FR: "fr",
      },
    },
    types: [blogPost, author],
    components: [
      {
        name: "Chart",
        importPath: "@/components/mdx/Chart",
        description: "Render a chart",
        propHints: {
          color: { widget: "color-picker" },
        },
        propsEditor: "@/components/mdx/Chart.editor",
        load: async () => ({ component: "Chart" }),
        loadPropsEditor: async () => ({ editor: "ChartPropsEditor" }),
      },
    ],
  });

  const parsed = parseMdcmsConfig(config);

  assert.equal(parsed.project, "marketing-site");
  assert.equal(parsed.serverUrl, "http://localhost:4000");
  assert.equal(parsed.environment, "staging");
  assert.deepEqual(parsed.contentDirectories, ["content", "content/shared"]);
  assert.deepEqual(parsed.locales, {
    default: "en-US",
    supported: ["en-US", "fr"],
    aliases: {
      en: "en-US",
      "fr-FR": "fr",
    },
    implicit: false,
  });
  assert.equal(parsed.types.length, 2);
  assert.equal(parsed.types[0]?.name, "BlogPost");
  assert.equal(parsed.types[0]?.localized, true);
  assert.equal(parsed.types[0]?.referenceFields.author?.targetType, "Author");
  assert.equal(
    parsed.types[0]?.referenceFields.relatedAuthor?.targetType,
    "Author",
  );
  assert.equal(parsed.types[0]?.fields.summary, standardStringSchema);
  assert.deepEqual(parsed.components, [
    {
      name: "Chart",
      importPath: "@/components/mdx/Chart",
      description: "Render a chart",
      propHints: {
        color: { widget: "color-picker" },
      },
      propsEditor: "@/components/mdx/Chart.editor",
    },
  ]);
});

test("fieldTypes.reference preserves current reference metadata behavior", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Article", {
          directory: "content/articles",
          fields: {
            author: fieldTypes.reference("Author"),
          },
        }),
      ],
      environments: {
        production: {},
      },
    }),
  );

  assert.equal(parsed.types[0]?.referenceFields.author?.targetType, "Author");
  assert.deepEqual(
    serializeResolvedEnvironmentSchema(parsed, "production").Article?.fields
      .author,
    {
      kind: "string",
      required: true,
      nullable: false,
      reference: {
        targetType: "Author",
      },
    },
  );
});

test("fieldTypes.image/video/file use string validators and normalized file metadata", () => {
  const imageField = fieldTypes.image();
  const videoField = fieldTypes.video({
    accept: [" video/webm ", "VIDEO/MP4", "video/webm"],
  });
  const fileField = fieldTypes.file({
    accept: [" application/pdf ", "audio/*", "APPLICATION/PDF"],
  });

  assert.equal((imageField as z.ZodType).safeParse("asset-id").success, true);
  assert.equal((videoField as z.ZodType).safeParse("asset-id").success, true);
  assert.equal((fileField as z.ZodType).safeParse("asset-id").success, true);

  assert.deepEqual(serializeFieldSnapshot(imageField, "image"), {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "image",
      accept: [],
      emptyStringAsUnset: false,
    },
  });
  assert.deepEqual(serializeFieldSnapshot(videoField, "video"), {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "video",
      accept: ["video/mp4", "video/webm"],
      emptyStringAsUnset: false,
    },
  });
  assert.deepEqual(serializeFieldSnapshot(fileField, "download"), {
    kind: "string",
    required: true,
    nullable: false,
    file: {
      preset: "file",
      accept: ["application/pdf", "audio/*"],
      emptyStringAsUnset: false,
    },
  });
});

test("fieldTypes.file rejects category-like accept entries", () => {
  expectInvalidConfig(
    () => fieldTypes.file({ accept: ["image"] }),
    /valid MIME type or wildcard/i,
  );
});

test("fieldTypes.image and video reject incompatible accept entries", () => {
  expectInvalidConfig(
    () => fieldTypes.image({ accept: ["application/pdf"] }),
    /image/i,
  );
  expectInvalidConfig(
    () => fieldTypes.video({ accept: ["image/png"] }),
    /video/i,
  );

  assert.doesNotThrow(() =>
    fieldTypes.image({ accept: ["image/png", " image/jpeg "] }),
  );
  assert.doesNotThrow(() => fieldTypes.video({ accept: ["video/mp4"] }));
});

test("fieldTypes.file required false resolves to optional nullable snapshot and empty-string unset semantics", () => {
  assert.deepEqual(
    serializeFieldSnapshot(fieldTypes.file({ required: false })),
    {
      kind: "string",
      required: false,
      nullable: true,
      file: {
        preset: "file",
        accept: [],
        emptyStringAsUnset: true,
      },
    },
  );
});

test("file helper wrappers preserve emptyStringAsUnset false without helper required false", () => {
  assert.deepEqual(serializeFieldSnapshot(fieldTypes.file().optional()), {
    kind: "string",
    required: false,
    nullable: false,
    file: {
      preset: "file",
      accept: [],
      emptyStringAsUnset: false,
    },
  });
  assert.deepEqual(serializeFieldSnapshot(fieldTypes.file().nullable()), {
    kind: "string",
    required: true,
    nullable: true,
    file: {
      preset: "file",
      accept: [],
      emptyStringAsUnset: false,
    },
  });
  assert.deepEqual(
    serializeFieldSnapshot(
      fieldTypes
        .file({ accept: ["application/pdf"] })
        .optional()
        .nullable(),
    ),
    {
      kind: "string",
      required: false,
      nullable: true,
      file: {
        preset: "file",
        accept: ["application/pdf"],
        emptyStringAsUnset: false,
      },
    },
  );
});

test("file helper defaults must be raw string ids and agree across helper and Zod default", () => {
  assert.deepEqual(
    serializeFieldSnapshot(
      fieldTypes.video({
        default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      }),
      "video",
    ),
    {
      kind: "string",
      required: false,
      nullable: false,
      default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      file: {
        preset: "video",
        accept: [],
        emptyStringAsUnset: false,
      },
    },
  );

  assert.deepEqual(
    serializeFieldSnapshot(
      fieldTypes
        .file({
          default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
        })
        .default("6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f"),
    ),
    {
      kind: "string",
      required: false,
      nullable: false,
      default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      file: {
        preset: "file",
        accept: [],
        emptyStringAsUnset: false,
      },
    },
  );

  expectInvalidConfig(
    () =>
      serializeFieldSnapshot(
        fieldTypes
          .file({
            default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
          })
          .default("76dffb7f-4bc6-4479-b6ec-b4b1e0b6f8b0"),
      ),
    /must agree/i,
  );
  expectInvalidConfig(
    () => fieldTypes.file({ default: "https://cdn.example.com/asset.png" }),
    /raw media asset id string/i,
  );
  expectInvalidConfig(
    () => fieldTypes.file({ default: "" }),
    /must not be empty|raw media asset id string/i,
  );
});

test("file helper required false cannot be combined with helper or Zod defaults", () => {
  expectInvalidConfig(
    () =>
      createRuntimeFileField({
        required: false,
        default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      }),
    /required:\s*false.*default/i,
  );
  expectInvalidConfig(
    () =>
      serializeFieldSnapshot(
        fieldTypes
          .file({ required: false })
          .default("6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f"),
      ),
    /required:\s*false.*default/i,
  );
});

test("parseMdcmsConfig resolves environment overlays and env sugar deterministically", () => {
  const blogPost = defineType("BlogPost", {
    directory: "content/blog",
    localized: true,
    fields: {
      title: z.string(),
      slug: z.string(),
      tags: z.array(z.string()).default([]),
      featured: z.boolean().default(false).env("staging", "preview"),
    },
  });

  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      locales: {
        default: "en-US",
        supported: ["en-US"],
      },
      types: [blogPost],
      environments: {
        production: {},
        staging: {
          extends: "production",
          types: {
            BlogPost: blogPost.extend({
              modify: {
                tags: z.array(z.string()).min(1),
              },
            }),
          },
        },
      },
    }),
  );

  assert.deepEqual(Object.keys(parsed.resolvedEnvironments), [
    "production",
    "staging",
  ]);
  assert.equal(parsed.types[0]?.fields.featured, undefined);
  assert.equal(
    parsed.resolvedEnvironments.production.types.BlogPost.fields.featured,
    undefined,
  );
  assert.equal(
    parsed.resolvedEnvironments.staging.types.BlogPost.fields.featured !==
      undefined,
    true,
  );

  const productionTags = parsed.resolvedEnvironments.production.types.BlogPost
    .fields.tags as z.ZodType;
  const stagingTags = parsed.resolvedEnvironments.staging.types.BlogPost.fields
    .tags as z.ZodType;

  assert.equal(productionTags.safeParse([]).success, true);
  assert.equal(stagingTags.safeParse([]).success, false);
  assert.equal(stagingTags.safeParse(["preview"]).success, true);
});

test("parseMdcmsConfig rejects environments that extend an unknown parent", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            preview: {
              extends: "staging",
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("environments.staging"),
  );
});

test("parseMdcmsConfig rejects self-referential extends chains", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              extends: "staging",
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("staging -> staging"),
  );
});

test("parseMdcmsConfig rejects circular extends chains", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              extends: "preview",
            },
            preview: {
              extends: "staging",
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("staging") &&
      error.message.includes("preview"),
  );
});

test("parseMdcmsConfig rejects env sugar that conflicts with explicit add overlays", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
      featured: z.boolean().env("staging"),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  add: {
                    featured: z.boolean(),
                  },
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("featured"),
  );
});

test("parseMdcmsConfig rejects env sugar inside overlay add blocks", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  add: {
                    featured: z.boolean().env("preview"),
                  },
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes(".add.featured"),
  );
});

test("parseMdcmsConfig rejects env sugar inside overlay modify blocks", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  modify: {
                    title: z.string().env("preview"),
                  },
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes(".modify.title"),
  );
});

test("parseMdcmsConfig rejects add overlays for fields that already exist", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  add: {
                    title: z.string().min(1),
                  },
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes(".add.title"),
  );
});

test("parseMdcmsConfig rejects modify overlays for missing fields", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  modify: {
                    subtitle: z.string(),
                  },
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes(".modify.subtitle"),
  );
});

test("parseMdcmsConfig rejects omit overlays for missing fields", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                Page: page.extend({
                  omit: ["subtitle"],
                }),
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes(".omit"),
  );
});

test("parseMdcmsConfig rejects overlays for unknown types", () => {
  const page = defineType("Page", {
    fields: {
      title: z.string(),
    },
  });

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          types: [page],
          environments: {
            staging: {
              types: {
                MissingType: {
                  add: {
                    title: z.string(),
                  },
                },
              },
            },
          },
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("MissingType"),
  );
});

test("parseMdcmsConfig resolves implicit single-locale mode when no type is localized", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content/pages"],
      types: [
        defineType("Page", {
          directory: "content/pages",
          fields: {
            title: z.string(),
          },
        }),
      ],
    }),
  );

  assert.deepEqual(parsed.locales, {
    default: IMPLICIT_DEFAULT_LOCALE,
    supported: [IMPLICIT_DEFAULT_LOCALE],
    aliases: {},
    implicit: true,
  });
});

test("parseMdcmsConfig rejects non-Standard-Schema field validators", () => {
  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          contentDirectories: ["content/pages"],
          types: [
            defineType("Page", {
              directory: "content/pages",
              fields: {
                title: "not-a-schema" as never,
              },
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("types[0].fields.title"),
  );
});

test("parseMdcmsConfig rejects localized types without explicit locales config", () => {
  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          contentDirectories: ["content/blog"],
          types: [
            defineType("BlogPost", {
              directory: "content/blog",
              localized: true,
              fields: {
                title: z.string(),
              },
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("locales"),
  );
});

test("parseMdcmsConfig rejects invalid locale tags and reserved token collisions", () => {
  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          contentDirectories: ["content/blog"],
          locales: {
            default: "en-US",
            supported: ["en-US", "__mdcms_default__"],
            aliases: {
              legacy: "en-US",
            },
          },
          types: [
            defineType("BlogPost", {
              directory: "content/blog",
              localized: true,
              fields: {
                title: z.string(),
              },
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("__mdcms_default__"),
  );

  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          contentDirectories: ["content/blog"],
          locales: {
            default: "en-US",
            supported: ["en-US"],
            aliases: {
              "not a locale": "en-US",
            },
          },
          types: [
            defineType("BlogPost", {
              directory: "content/blog",
              localized: true,
              fields: {
                title: z.string(),
              },
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("aliases"),
  );
});

test("parseMdcmsConfig rejects contentDirectories that do not cover type directories", () => {
  assert.throws(
    () =>
      parseMdcmsConfig(
        defineConfig({
          project: "marketing-site",
          serverUrl: "http://localhost:4000",
          contentDirectories: ["content/pages"],
          types: [
            defineType("BlogPost", {
              directory: "content/blog",
              fields: {
                title: z.string(),
              },
            }),
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("contentDirectories"),
  );
});
