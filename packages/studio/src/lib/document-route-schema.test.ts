import assert from "node:assert/strict";

import { test } from "bun:test";

import { createStudioEmbedConfig } from "./studio.js";
import {
  resolveStudioDocumentRouteSchemaDetails,
  resolveStudioDocumentRouteSchemaCapability,
  resolveStudioDocumentRoutePreparedMetadata,
  type StudioDocumentRouteSchemaCapability,
} from "./document-route-schema.js";
import {
  defineConfig,
  defineType,
  fieldTypes,
  parseMdcmsConfig,
} from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";

const unsupportedExecutableFieldSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: () => ({ value: "title" }),
  },
  _def: {
    type: "pipe" as const,
  },
};

function createAuthoredConfig() {
  return defineConfig({
    project: "marketing-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content"],
    locales: {
      default: "en",
      supported: ["en", "fr"],
      aliases: {
        "fr-ca": "fr",
        "en-us": "en",
      },
    },
    types: [
      defineType("Author", {
        directory: "content/authors",
        fields: {
          name: fieldTypes.reference("Author"),
          bio: fieldTypes.reference("Author"),
        },
      }),
      defineType("Article", {
        directory: "content/articles",
        fields: {
          body: fieldTypes.reference("Article"),
          title: fieldTypes.reference("Article"),
        },
      }),
    ],
    environments: {
      production: {},
      staging: {
        extends: "production",
        types: {
          Article: {
            add: {
              summary: fieldTypes.reference("Article"),
            },
          },
          Author: {
            modify: {
              bio: fieldTypes.reference("Author"),
            },
          },
        },
      },
    },
  });
}

async function readCapability(): Promise<StudioDocumentRouteSchemaCapability> {
  return resolveStudioDocumentRouteSchemaCapability(createAuthoredConfig());
}

async function readCapabilityDetails() {
  return resolveStudioDocumentRouteSchemaDetails(createAuthoredConfig());
}

test("derived schema hash is deterministic for authored Studio configs", async () => {
  const capability = await readCapability();

  assert.equal(capability.canWrite, true);
  if (!capability.canWrite) {
    throw new Error("Expected a write-capable schema result.");
  }

  const repeatCapability = await readCapability();
  assert.equal(repeatCapability.canWrite, true);
  if (!repeatCapability.canWrite) {
    throw new Error("Expected a write-capable schema result.");
  }

  assert.match(capability.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal(capability.schemaHash, repeatCapability.schemaHash);
});

test("derived schema details expose the local sync payload pieces", async () => {
  const details = await readCapabilityDetails();

  assert.equal(details.canWrite, true);
  if (!details.canWrite) {
    throw new Error("Expected a write-capable schema result.");
  }

  assert.equal(details.environment, "staging");
  // `serverUrl` and the active `environment` are deliberately omitted — they
  // are deployment-time wiring rather than schema content. Including them
  // made the same `mdcms.config.ts` hash differently when the CLI synced
  // from a default shell vs. when the host computed the hash with live
  // env vars set, so the snapshot now stays a function of structural
  // schema/config only.
  assert.deepEqual(details.syncPayload.rawConfigSnapshot, {
    project: "marketing-site",
    environments: {
      production: {},
      staging: {
        extends: "production",
      },
    },
    contentDirectories: ["content"],
    locales: {
      default: "en",
      supported: ["en", "fr"],
      aliases: {
        "fr-CA": "fr",
        "en-US": "en",
      },
    },
  });
  assert.deepEqual(Object.keys(details.syncPayload.resolvedSchema).sort(), [
    "Article",
    "Author",
  ]);
  assert.match(details.syncPayload.schemaHash, /^[a-f0-9]{64}$/);
});

test("derived schema details use the shared schema-hash construction", async () => {
  const config = createAuthoredConfig();
  const details = await resolveStudioDocumentRouteSchemaDetails(config);

  assert.equal(details.canWrite, true);
  if (!details.canWrite) {
    throw new Error("Expected a write-capable schema result.");
  }

  const sharedPayload = buildSchemaSyncPayload(
    parseMdcmsConfig(config),
    "staging",
  );

  assert.equal(details.syncPayload.schemaHash, sharedPayload.schemaHash);
  assert.deepEqual(
    details.syncPayload.rawConfigSnapshot,
    sharedPayload.rawConfigSnapshot,
  );
  assert.deepEqual(
    details.syncPayload.resolvedSchema,
    sharedPayload.resolvedSchema,
  );
});

test("prepared document route metadata includes per-environment hashes and field targets", async () => {
  const metadata = await resolveStudioDocumentRoutePreparedMetadata(
    createAuthoredConfig(),
  );

  assert.deepEqual(Object.keys(metadata.schemaHashesByEnvironment).sort(), [
    "production",
    "staging",
  ]);
  assert.match(metadata.schemaHashesByEnvironment.production, /^[a-f0-9]{64}$/);
  assert.match(metadata.schemaHashesByEnvironment.staging, /^[a-f0-9]{64}$/);
  assert.deepEqual(metadata.environmentFieldTargets, {
    Article: {
      summary: ["staging"],
    },
  });
});

test("equivalent authored config data yields the same schema hash", async () => {
  const [left, right] = await Promise.all([
    resolveStudioDocumentRouteSchemaCapability(
      defineConfig({
        project: "marketing-site",
        serverUrl: "http://localhost:4000",
        environment: "staging",
        contentDirectories: ["content"],
        locales: {
          default: "en",
          supported: ["en", "fr"],
          aliases: {
            "en-us": "en",
            "fr-ca": "fr",
          },
        },
        types: [
          defineType("Article", {
            directory: "content/articles",
            fields: {
              title: fieldTypes.reference("Article"),
              body: fieldTypes.reference("Article"),
            },
          }),
          defineType("Author", {
            directory: "content/authors",
            fields: {
              bio: fieldTypes.reference("Author"),
              name: fieldTypes.reference("Author"),
            },
          }),
        ],
        environments: {
          staging: {
            extends: "production",
            types: {
              Author: {
                modify: {
                  bio: fieldTypes.reference("Author"),
                },
              },
              Article: {
                add: {
                  summary: fieldTypes.reference("Article"),
                },
              },
            },
          },
          production: {},
        },
      }),
    ),
    resolveStudioDocumentRouteSchemaCapability(createAuthoredConfig()),
  ]);

  assert.equal(left.canWrite, true);
  assert.equal(right.canWrite, true);
  if (!left.canWrite || !right.canWrite) {
    throw new Error("Expected write-capable schema results.");
  }

  assert.equal(left.schemaHash, right.schemaHash);
});

test("shell-only embed config does not produce a write-capable schema hash", async () => {
  const capability = await resolveStudioDocumentRouteSchemaCapability(
    createStudioEmbedConfig(createAuthoredConfig()),
  );

  assert.equal(capability.canWrite, false);
  assert.equal(capability.reason, "schema-unavailable");
  assert.match(capability.message, /resolved schema/i);
});

test("unsupported authored schema features fail closed to read-only capability", async () => {
  const capability = await resolveStudioDocumentRouteSchemaCapability(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      environment: "staging",
      contentDirectories: ["content"],
      types: [
        defineType("Post", {
          directory: "content/posts",
          fields: {
            title: unsupportedExecutableFieldSchema,
          },
        }),
      ],
      environments: {
        staging: {},
      },
    }),
  );

  assert.equal(capability.canWrite, false);
  assert.equal(capability.reason, "schema-unavailable");
  assert.match(capability.message, /could not derive a local schema hash/i);
});
