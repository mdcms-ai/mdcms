import assert from "node:assert/strict";
import { test } from "bun:test";

import { z } from "zod";

import {
  defineConfig,
  defineType,
  fieldTypes,
  parseMdcmsConfig,
} from "./config.js";
import { RuntimeError } from "../runtime/error.js";
import {
  assertSchemaRegistryEntry,
  assertSchemaRegistrySyncPayload,
  serializeResolvedEnvironmentSchema,
  stableStringifyJson,
  toRawConfigSnapshot,
  validateSchemaRegistryListResponse,
  type SchemaRegistryEntry,
} from "./schema.js";
import { buildSchemaSyncPayload } from "./schema-hash.js";

function expectInvalidInput(fn: () => unknown, path: string, message?: RegExp) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.statusCode, 400);
    assert.equal(error.details?.path, path);

    if (message) {
      assert.match(error.message, message);
    }

    return true;
  });
}

test("assertSchemaRegistryEntry accepts a valid type-centric registry entry", () => {
  const entry: SchemaRegistryEntry = {
    type: "Post",
    directory: "content/posts",
    localized: false,
    schemaHash: "abc123",
    syncedAt: "2026-03-11T12:00:00.000Z",
    resolvedSchema: {
      type: "Post",
      directory: "content/posts",
      localized: false,
      fields: {
        title: {
          kind: "string",
          required: true,
          nullable: false,
        },
      },
    },
  };

  assert.doesNotThrow(() => assertSchemaRegistryEntry(entry));
});

test("assertSchemaRegistryEntry rejects contradictory entry metadata", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistryEntry({
        type: "Post",
        directory: "content/posts",
        localized: true,
        schemaHash: "abc123",
        syncedAt: "2026-03-11T12:00:00.000Z",
        resolvedSchema: {
          type: "Post",
          directory: "content/posts",
          localized: false,
          fields: {
            title: {
              kind: "string",
              required: true,
              nullable: false,
            },
          },
        },
      }),
    "entry.resolvedSchema.localized",
  );
});

test("validateSchemaRegistryListResponse accepts valid payload with hash", () => {
  const payload = {
    types: [],
    schemaHash: "a".repeat(64),
    syncedAt: "2026-04-14T12:00:00.000Z",
  };
  assert.doesNotThrow(() =>
    validateSchemaRegistryListResponse("test", payload),
  );
});

test("validateSchemaRegistryListResponse accepts null hash and syncedAt", () => {
  const payload = { types: [], schemaHash: null, syncedAt: null };
  assert.doesNotThrow(() =>
    validateSchemaRegistryListResponse("test", payload),
  );
});

test("validateSchemaRegistryListResponse accepts payload with project field", () => {
  const payload = {
    types: [],
    schemaHash: "a".repeat(64),
    syncedAt: "2026-04-14T12:00:00.000Z",
    project: "my-project",
  };
  const result = validateSchemaRegistryListResponse("test", payload);
  assert.equal(result.project, "my-project");
});

test("validateSchemaRegistryListResponse accepts payload without project field", () => {
  const payload = { types: [], schemaHash: null, syncedAt: null };
  const result = validateSchemaRegistryListResponse("test", payload);
  assert.equal(result.project, undefined);
});

test("validateSchemaRegistryListResponse rejects empty project string", () => {
  const payload = {
    types: [],
    schemaHash: null,
    syncedAt: null,
    project: "",
  };
  expectInvalidInput(
    () => validateSchemaRegistryListResponse("test", payload),
    "test.project",
  );
});

test("validateSchemaRegistryListResponse rejects blank project string", () => {
  const payload = {
    types: [],
    schemaHash: null,
    syncedAt: null,
    project: "   ",
  };
  expectInvalidInput(
    () => validateSchemaRegistryListResponse("test", payload),
    "test.project",
  );
});

test("validateSchemaRegistryListResponse rejects non-null non-string hash", () => {
  const payload = { types: [], schemaHash: 123, syncedAt: null };
  expectInvalidInput(
    () => validateSchemaRegistryListResponse("test", payload),
    "test.schemaHash",
  );
});

test("assertSchemaRegistrySyncPayload rejects malformed resolved schema maps with INVALID_INPUT details", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: [],
        schemaHash: "hash",
      }),
    "payload.resolvedSchema",
  );
});

test("assertSchemaRegistrySyncPayload rejects obsolete extractedComponents input", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {},
        schemaHash: "hash",
        extractedComponents: [],
      } as never),
    "payload.extractedComponents",
  );
});

test("assertSchemaRegistrySyncPayload rejects impossible field snapshot shapes", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              tags: {
                kind: "array",
                required: true,
                nullable: false,
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.tags.item",
  );
});

test("assertSchemaRegistrySyncPayload rejects resolved schema key/type mismatches", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Author",
            directory: "content/posts",
            localized: false,
            fields: {},
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.type",
  );
});

test("assertSchemaRegistrySyncPayload rejects unserializable JSON-ish payload members", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {
          invalid: () => "nope",
        },
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {},
          },
        },
        schemaHash: "hash",
      }),
    "payload.rawConfigSnapshot.invalid",
  );
});

test("serializeResolvedEnvironmentSchema produces stable descriptive snapshots for supported fields", () => {
  const post = defineType("Post", {
    directory: "content/posts",
    fields: {
      title: z.string().min(1),
      author: fieldTypes.reference("Author"),
      metadata: z.object({
        nestedAuthor: fieldTypes.reference("Author"),
        reviewers: z.array(fieldTypes.reference("Author")),
      }),
      primaryImage: fieldTypes.image({ required: false }),
      heroVideo: fieldTypes.video({ accept: ["video/mp4", "video/webm"] }),
      attachment: fieldTypes.file({ accept: ["application/pdf"] }),
      optionalAttachment: fieldTypes.file({
        accept: ["application/pdf"],
        required: false,
      }),
      optionalNullableAttachment: fieldTypes.file({
        accept: ["application/pdf"],
      })
        .optional()
        .nullable(),
      defaultVideo: fieldTypes.video({
        default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      }),
      tags: z.array(z.string()).default([]),
      featured: z.boolean().env("staging"),
    },
  });

  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [post],
      environments: {
        production: {},
        staging: {},
      },
    }),
  );

  assert.deepEqual(serializeResolvedEnvironmentSchema(parsed, "production"), {
    Post: {
      type: "Post",
      directory: "content/posts",
      localized: false,
      fields: {
        attachment: {
          kind: "string",
          required: true,
          nullable: false,
          file: {
            preset: "file",
            accept: ["application/pdf"],
            emptyStringAsUnset: false,
          },
        },
        author: {
          kind: "string",
          required: true,
          nullable: false,
          reference: {
            targetType: "Author",
          },
        },
        defaultVideo: {
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
        heroVideo: {
          kind: "string",
          required: true,
          nullable: false,
          file: {
            preset: "video",
            accept: ["video/mp4", "video/webm"],
            emptyStringAsUnset: false,
          },
        },
        metadata: {
          kind: "object",
          required: true,
          nullable: false,
          fields: {
            nestedAuthor: {
              kind: "string",
              required: true,
              nullable: false,
              reference: {
                targetType: "Author",
              },
            },
            reviewers: {
              kind: "array",
              required: true,
              nullable: false,
              item: {
                kind: "string",
                required: true,
                nullable: false,
                reference: {
                  targetType: "Author",
                },
              },
            },
          },
        },
        optionalAttachment: {
          kind: "string",
          required: false,
          nullable: true,
          file: {
            preset: "file",
            accept: ["application/pdf"],
            emptyStringAsUnset: true,
          },
        },
        optionalNullableAttachment: {
          kind: "string",
          required: false,
          nullable: true,
          file: {
            preset: "file",
            accept: ["application/pdf"],
            emptyStringAsUnset: false,
          },
        },
        primaryImage: {
          kind: "string",
          required: false,
          nullable: true,
          file: {
            preset: "image",
            accept: [],
            emptyStringAsUnset: true,
          },
        },
        tags: {
          kind: "array",
          required: false,
          nullable: false,
          default: [],
          item: {
            kind: "string",
            required: true,
            nullable: false,
          },
        },
        title: {
          kind: "string",
          required: true,
          nullable: false,
          checks: [
            {
              kind: "min_length",
              minimum: 1,
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(
    serializeResolvedEnvironmentSchema(parsed, "staging").Post?.fields.featured,
    {
      kind: "boolean",
      required: true,
      nullable: false,
    },
  );
});

test("serializeResolvedEnvironmentSchema rejects unsupported executable validator features", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: {
            title: z.string().refine((value) => value.length > 0),
          },
        }),
      ],
      environments: {
        staging: {},
      },
    }),
  );

  expectInvalidInput(
    () => serializeResolvedEnvironmentSchema(parsed, "staging"),
    "resolvedEnvironments.staging.types.Post.fields.title.checks[0]",
    /unsupported executable validator feature/i,
  );
});

test("assertSchemaRegistrySyncPayload rejects malformed file metadata", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "image",
                  accept: ["image/png"],
                },
              },
            },
          },
        },
        schemaHash: "hash",
      } as never),
    "payload.resolvedSchema.Post.fields.asset.file.emptyStringAsUnset",
  );
});

test("assertSchemaRegistrySyncPayload rejects file metadata on non-string fields", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "boolean",
                required: true,
                nullable: false,
                file: {
                  preset: "file",
                  accept: [],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      } as never),
    "payload.resolvedSchema.Post.fields.asset.file",
  );
});

test("assertSchemaRegistrySyncPayload rejects invalid file snapshot defaults", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: false,
                nullable: false,
                default: "https://cdn.example.com/a.png",
                file: {
                  preset: "image",
                  accept: [],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.default",
  );

  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: false,
                nullable: false,
                default: {
                  id: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
                },
                file: {
                  preset: "file",
                  accept: [],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      } as never),
    "payload.resolvedSchema.Post.fields.asset.default",
  );
});

test("assertSchemaRegistrySyncPayload rejects non-normalized file accept arrays", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "video",
                  accept: ["VIDEO/MP4", "video/mp4"],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.file.accept",
  );

  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "video",
                  accept: ["video/webm", "video/mp4"],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.file.accept",
  );

  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "video",
                  accept: ["video/mp4", "video/mp4"],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.file.accept",
  );
});

test("assertSchemaRegistrySyncPayload rejects preset-incompatible file accept arrays", () => {
  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "image",
                  accept: ["application/pdf"],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.file.accept",
  );

  expectInvalidInput(
    () =>
      assertSchemaRegistrySyncPayload({
        rawConfigSnapshot: {},
        resolvedSchema: {
          Post: {
            type: "Post",
            directory: "content/posts",
            localized: false,
            fields: {
              asset: {
                kind: "string",
                required: true,
                nullable: false,
                file: {
                  preset: "video",
                  accept: ["image/png"],
                  emptyStringAsUnset: false,
                },
              },
            },
          },
        },
        schemaHash: "hash",
      }),
    "payload.resolvedSchema.Post.fields.asset.file.accept",
  );
});

test("toRawConfigSnapshot includes project, omits deployment context, and omits implicit locales", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "my-site",
      serverUrl: "http://localhost:4000",
      environment: "production",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: { title: z.string() },
        }),
      ],
      environments: { production: {} },
    }),
  );

  const snapshot = toRawConfigSnapshot(parsed);

  assert.equal(snapshot.project, "my-site");
  // `serverUrl` and the active `environment` are deployment-time wiring,
  // not schema content; they must not appear in the snapshot or the schema
  // hash starts depending on whoever happens to be computing it.
  assert.equal(snapshot.serverUrl, undefined);
  assert.equal(snapshot.environment, undefined);
  assert.deepEqual(snapshot.contentDirectories, ["content"]);
  assert.deepEqual(snapshot.environments, {
    production: {},
  });
  assert.equal(snapshot.locales, undefined);
});

test("toRawConfigSnapshot is identical for configs differing only in serverUrl", () => {
  const buildParsed = (serverUrl: string) =>
    parseMdcmsConfig(
      defineConfig({
        project: "my-site",
        serverUrl,
        environment: "production",
        contentDirectories: ["content"],
        types: [
          defineType("Post", {
            directory: "content/posts",
            fields: { title: z.string() },
          }),
        ],
        environments: { production: {} },
      }),
    );

  const local = toRawConfigSnapshot(buildParsed("http://localhost:4000"));
  const railway = toRawConfigSnapshot(buildParsed("https://api.example.com"));

  assert.deepEqual(local, railway);
});

test("toRawConfigSnapshot is identical for configs differing only in active environment", () => {
  const buildParsed = (environment: string) =>
    parseMdcmsConfig(
      defineConfig({
        project: "my-site",
        serverUrl: "http://localhost:4000",
        environment,
        contentDirectories: ["content"],
        types: [
          defineType("Post", {
            directory: "content/posts",
            fields: { title: z.string() },
          }),
        ],
        environments: {
          production: {},
          staging: { extends: "production" },
        },
      }),
    );

  const fromStagingShell = toRawConfigSnapshot(buildParsed("staging"));
  const fromProductionShell = toRawConfigSnapshot(buildParsed("production"));

  assert.deepEqual(fromStagingShell, fromProductionShell);
});

test("toRawConfigSnapshot includes environment topology definitions", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      types: [
        defineType("Post", {
          fields: { title: z.string() },
        }),
      ],
      environments: {
        production: {},
        staging: { extends: "production" },
        preview: { extends: "staging" },
      },
    }),
  );

  const snapshot = toRawConfigSnapshot(parsed);

  assert.deepEqual(snapshot.environments, {
    preview: { extends: "staging" },
    production: {},
    staging: { extends: "production" },
  });
});

test("toRawConfigSnapshot includes explicit locales with aliases when configured", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "i18n-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Page", {
          directory: "content/pages",
          localized: true,
          fields: { title: z.string() },
        }),
      ],
      locales: {
        default: "en",
        supported: ["en", "de"],
        aliases: { deutsch: "de" },
      },
      environments: { production: {} },
    }),
  );

  const snapshot = toRawConfigSnapshot(parsed);

  assert.deepEqual(snapshot.locales, {
    default: "en",
    supported: ["en", "de"],
    aliases: { deutsch: "de" },
  });
});

test("toRawConfigSnapshot omits locale aliases when none are configured", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "i18n-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Page", {
          directory: "content/pages",
          localized: true,
          fields: { title: z.string() },
        }),
      ],
      locales: {
        default: "en",
        supported: ["en", "fr"],
      },
      environments: { production: {} },
    }),
  );

  const snapshot = toRawConfigSnapshot(parsed);

  assert.ok(snapshot.locales != null);
  const locales = snapshot.locales as Record<string, unknown>;
  assert.equal(locales.aliases, undefined);
});

test("toRawConfigSnapshot omits contentDirectories when empty", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "my-site",
      serverUrl: "http://localhost:4000",
      types: [
        defineType("Post", {
          fields: { title: z.string() },
        }),
      ],
      environments: { production: {} },
    }),
  );

  const snapshot = toRawConfigSnapshot(parsed);

  assert.equal(snapshot.contentDirectories, undefined);
});

test("stableStringifyJson sorts object keys recursively and preserves array order", () => {
  const left = stableStringifyJson({
    z: [
      {
        beta: 2,
        alpha: 1,
      },
      "tail",
    ],
    a: {
      delta: 4,
      gamma: 3,
    },
  });
  const right = stableStringifyJson({
    a: {
      gamma: 3,
      delta: 4,
    },
    z: [
      {
        alpha: 1,
        beta: 2,
      },
      "tail",
    ],
  });

  assert.equal(
    left,
    '{"a":{"delta":4,"gamma":3},"z":[{"alpha":1,"beta":2},"tail"]}',
  );
  assert.equal(left, right);
});

test("buildSchemaSyncPayload returns rawConfigSnapshot, resolvedSchema and a deterministic hash", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: { title: z.string() },
        }),
      ],
      environments: { production: {} },
    }),
  );

  const payload = buildSchemaSyncPayload(parsed, "production");

  assert.equal(payload.rawConfigSnapshot.project, "marketing-site");
  assert.ok(payload.resolvedSchema.Post != null);
  assert.equal(typeof payload.schemaHash, "string");
  assert.equal(payload.schemaHash.length, 64);
});

test("buildSchemaSyncPayload produces the same hash for the same inputs", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: { title: z.string() },
        }),
      ],
      environments: { production: {} },
    }),
  );

  const first = buildSchemaSyncPayload(parsed, "production");
  const second = buildSchemaSyncPayload(parsed, "production");

  assert.equal(first.schemaHash, second.schemaHash);
});

test("buildSchemaSyncPayload hash for env X is independent of serverUrl and active environment", () => {
  // Regression for CMS-218: same target environment + same schema content
  // must hash identically regardless of which server the local config
  // happens to point at, or which environment the host process happens to
  // have selected as the "active" one. Otherwise the CLI sync (often run
  // from a default shell with localhost / staging defaults) and a deployed
  // host (production-tuned env vars baked at build time) compute different
  // hashes for the same target env and the editor goes read-only forever.
  const buildParsed = (input: { serverUrl: string; environment: string }) =>
    parseMdcmsConfig(
      defineConfig({
        project: "marketing-site",
        serverUrl: input.serverUrl,
        environment: input.environment,
        contentDirectories: ["content"],
        types: [
          defineType("Post", {
            directory: "content/posts",
            fields: { title: z.string() },
          }),
        ],
        environments: {
          production: {},
          staging: { extends: "production" },
        },
      }),
    );

  const cliShell = buildSchemaSyncPayload(
    buildParsed({
      serverUrl: "http://localhost:4000",
      environment: "staging",
    }),
    "production",
  );
  const buildShell = buildSchemaSyncPayload(
    buildParsed({
      serverUrl: "https://api.example.com",
      environment: "production",
    }),
    "production",
  );

  assert.equal(cliShell.schemaHash, buildShell.schemaHash);
});

test("buildSchemaSyncPayload produces different hashes for different environments", () => {
  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: {
            title: z.string(),
            featured: z.boolean().env("staging"),
          },
        }),
      ],
      environments: { production: {}, staging: {} },
    }),
  );

  const production = buildSchemaSyncPayload(parsed, "production");
  const staging = buildSchemaSyncPayload(parsed, "staging");

  assert.notEqual(production.schemaHash, staging.schemaHash);
});
