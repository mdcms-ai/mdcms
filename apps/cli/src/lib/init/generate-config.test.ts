import assert from "node:assert/strict";
import { test } from "node:test";

import { generateConfigSource } from "./generate-config.js";
import type { InferredType } from "./infer-schema.js";
import type { LocaleConfig } from "./detect-locale.js";

test("generates minimal config without locales", () => {
  const types: InferredType[] = [
    {
      name: "post",
      directory: "content/posts",
      localized: false,
      fields: {
        title: { zodType: "z.string()", optional: false, samples: 5 },
        slug: { zodType: "z.string()", optional: false, samples: 5 },
      },
      fileCount: 5,
    },
  ];

  const source = generateConfigSource({
    project: "my-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    types,
    localeConfig: null,
  });

  assert.ok(
    source.includes('import { defineConfig, defineType } from "@mdcms/cli"'),
  );
  assert.ok(source.includes('import { z } from "zod"'));
  assert.ok(source.includes('project: "my-site"'));
  assert.ok(source.includes('serverUrl: "http://localhost:4000"'));
  assert.ok(source.includes('environment: "staging"'));
  assert.ok(source.includes('defineType("post"'));
  assert.ok(source.includes('directory: "content/posts"'));
  assert.ok(source.includes("title: z.string()"));
  assert.ok(source.includes("slug: z.string()"));
  assert.ok(!source.includes("locales"));
});

test("includes locale config when present", () => {
  const types: InferredType[] = [
    {
      name: "post",
      directory: "content/posts",
      localized: true,
      fields: {
        title: { zodType: "z.string()", optional: false, samples: 2 },
      },
      fileCount: 2,
    },
  ];

  const localeConfig: LocaleConfig = {
    defaultLocale: "en",
    supported: ["en", "fr"],
    aliases: { en_us: "en" },
  };

  const source = generateConfigSource({
    project: "my-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    types,
    localeConfig,
  });

  assert.ok(source.includes("locales:"));
  assert.ok(source.includes('default: "en"'));
  assert.ok(source.includes('supported: ["en","fr"]'));
  assert.ok(source.includes("aliases:"));
  assert.ok(source.includes('en_us: "en"'));
  assert.ok(source.includes("localized: true"));
});

test("includes reference import when reference fields exist", () => {
  const types: InferredType[] = [
    {
      name: "post",
      directory: "content/posts",
      localized: false,
      fields: {
        title: { zodType: "z.string()", optional: false, samples: 1 },
        author: {
          zodType: 'fieldTypes.reference("author")',
          optional: true,
          samples: 1,
        },
      },
      fileCount: 1,
    },
  ];

  const source = generateConfigSource({
    project: "my-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    types,
    localeConfig: null,
  });

  assert.ok(source.includes("fieldTypes.reference"));
  assert.ok(
    source.includes(
      'import { defineConfig, defineType, fieldTypes } from "@mdcms/cli"',
    ),
  );
  assert.ok(source.includes('fieldTypes.reference("author").optional()'));
});

test("appends .optional() for optional fields", () => {
  const types: InferredType[] = [
    {
      name: "post",
      directory: "content/posts",
      localized: false,
      fields: {
        title: { zodType: "z.string()", optional: false, samples: 2 },
        excerpt: { zodType: "z.string()", optional: true, samples: 1 },
      },
      fileCount: 2,
    },
  ];

  const source = generateConfigSource({
    project: "my-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    types,
    localeConfig: null,
  });

  assert.ok(source.includes("title: z.string()"));
  assert.ok(!source.includes("title: z.string().optional()"));
  assert.ok(source.includes("excerpt: z.string().optional()"));
});

test("generates valid TypeScript (export default)", () => {
  const types: InferredType[] = [];

  const source = generateConfigSource({
    project: "test",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    types,
    localeConfig: null,
  });

  assert.ok(source.includes("export default defineConfig("));
});
