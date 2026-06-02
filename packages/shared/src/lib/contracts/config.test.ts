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
  parseMdcmsConfig,
  reference,
} from "./config.js";

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

test("defineConfig/defineType/reference produce a normalized shared config", () => {
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
      author: reference("Author"),
      relatedAuthor: reference("Author").optional(),
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
