import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { RuntimeError } from "@mdcms/shared";

import { loadCliConfig } from "./config.js";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PACKAGE_ROOT = resolve(TEST_FILE_DIR, "../..");
const WORKSPACE_ROOT = resolve(CLI_PACKAGE_ROOT, "../..");
const SHARED_SOURCE_IMPORT = pathToFileURL(
  join(WORKSPACE_ROOT, "packages/shared/src/index.ts"),
).href;

async function writeConfigFile(source: string): Promise<{
  cwd: string;
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const scratchRoot = join(WORKSPACE_ROOT, "packages/shared/.tmp");
  await mkdir(scratchRoot, { recursive: true });
  const cwd = await mkdtemp(join(scratchRoot, "mdcms-config-"));
  const configPath = join(cwd, "mdcms.config.ts");
  await writeFile(configPath, source, "utf8");
  return {
    cwd,
    configPath,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("loadCliConfig parses helper-based config files into the normalized CLI shape", async () => {
  const { cwd, cleanup } = await writeConfigFile(`
    import { defineConfig, defineType, fieldTypes } from "${SHARED_SOURCE_IMPORT}";

    const stringField = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "must be a string" }] };
        },
      },
    };

    export default defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      environment: "staging",
      contentDirectories: ["content"],
      locales: {
        default: "en_us",
        supported: ["en-US", "fr"],
        aliases: {
          en: "en_us",
        },
      },
      types: [
        defineType("Author", {
          directory: "content/authors",
          fields: {
            name: stringField,
          },
        }),
        defineType("BlogPost", {
          directory: "content/blog",
          localized: true,
          fields: {
            title: stringField,
            author: fieldTypes.reference("Author"),
          },
        }),
      ],
      components: [
        {
          name: "Chart",
          importPath: "@/components/mdx/Chart",
        },
      ],
    });
  `);

  try {
    const { config } = await loadCliConfig({ cwd });

    assert.equal(config.project, "marketing-site");
    assert.equal(config.serverUrl, "http://localhost:4000");
    assert.equal(config.environment, "staging");
    assert.deepEqual(config.contentDirectories, ["content"]);
    assert.equal(config.locales?.default, "en-US");
    const authorReference = config.types?.[1]?.referenceFields?.author;
    assert(authorReference);
    assert.equal(authorReference.targetType, "Author");
    assert.equal(config.components?.[0]?.name, "Chart");
  } finally {
    await cleanup();
  }
});

test("loadCliConfig returns resolved environment schemas from the shared parser", async () => {
  const { cwd, cleanup } = await writeConfigFile(`
    import { defineConfig, defineType } from "${SHARED_SOURCE_IMPORT}";
    import { z } from "zod";

    const post = defineType("Post", {
      directory: "content/posts",
      fields: {
        title: z.string(),
        featured: z.boolean().default(false).env("staging"),
      },
    });

    export default defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [post],
      environments: {
        production: {},
        staging: {},
      },
    });
  `);

  try {
    const { config } = await loadCliConfig({ cwd });

    assert.equal(
      config.resolvedEnvironments?.staging.types.Post.fields.featured !==
        undefined,
      true,
    );
  } finally {
    await cleanup();
  }
});

test("loadCliConfig rejects config files whose contentDirectories do not cover type directories", async () => {
  const { cwd, cleanup } = await writeConfigFile(`
    export default {
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content/pages"],
      types: [
        {
          name: "BlogPost",
          directory: "content/blog",
          fields: {
            title: {
              "~standard": {
                version: 1,
                vendor: "test",
                validate(value) {
                  return typeof value === "string"
                    ? { value }
                    : { issues: [{ message: "must be a string" }] };
                },
              },
            },
          },
        },
      ],
    };
  `);

  try {
    await assert.rejects(
      () => loadCliConfig({ cwd }),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "INVALID_CONFIG" &&
        error.message.includes("contentDirectories"),
    );
  } finally {
    await cleanup();
  }
});
