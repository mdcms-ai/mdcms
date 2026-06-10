import assert from "node:assert/strict";

import { test } from "bun:test";
import {
  createEmptyCurrentPrincipalCapabilities,
  defineConfig,
  defineType,
  fieldTypes,
} from "@mdcms/shared";

import { createStudioSchemaRouteApi } from "./schema-route-api.js";
import type { StudioCurrentPrincipalCapabilitiesApi } from "./current-principal-capabilities-api.js";
import { createStudioEmbedConfig } from "./studio.js";
import {
  createStudioSchemaLoadingState,
  loadStudioSchemaState,
} from "./schema-state.js";

function createConfig() {
  return defineConfig({
    project: "marketing-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content/blog"],
    types: [
      defineType("BlogPost", {
        directory: "content/blog",
        fields: {
          title: fieldTypes.reference("BlogPost"),
        },
      }),
    ],
    environments: {
      staging: {},
    },
  });
}

function createAuthoredConfig() {
  return defineConfig({
    project: "marketing-site",
    serverUrl: "http://localhost:4000",
    environment: "staging",
    contentDirectories: ["content/blog"],
    types: [
      defineType("BlogPost", {
        directory: "content/blog",
        fields: {
          title: fieldTypes.reference("BlogPost"),
        },
      }),
    ],
    environments: {
      staging: {},
    },
  });
}

function createSchemaRouteApi(fetcher: typeof fetch) {
  return createStudioSchemaRouteApi(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      fetcher,
    },
  );
}

function createCapabilitiesApi(
  overrides: Partial<
    ReturnType<typeof createEmptyCurrentPrincipalCapabilities>
  > = {},
): StudioCurrentPrincipalCapabilitiesApi {
  return {
    get: async () => ({
      project: "marketing-site",
      environment: "staging",
      capabilities: {
        ...createEmptyCurrentPrincipalCapabilities(),
        ...overrides,
      },
    }),
  };
}

test("createStudioSchemaLoadingState returns a deterministic loading state", () => {
  const state = createStudioSchemaLoadingState();

  assert.equal(state.status, "loading");
});

test("loadStudioSchemaState keeps local hash data but hides sync when schema.write is not allowed", async () => {
  const api = createSchemaRouteApi(async (input: RequestInfo | URL) => {
    assert.equal(String(input), "http://localhost:4000/api/v1/schema");

    return new Response(
      JSON.stringify({
        data: {
          types: [
            {
              type: "BlogPost",
              directory: "content/blog",
              localized: true,
              schemaHash: "server-hash",
              syncedAt: "2026-03-31T12:00:00.000Z",
              resolvedSchema: {
                type: "BlogPost",
                directory: "content/blog",
                localized: true,
                fields: {},
              },
            },
          ],
          schemaHash: "server-hash",
          syncedAt: "2026-03-31T12:00:00.000Z",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  });

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: {
        read: true,
        write: false,
      },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected a ready schema state.");
  }

  assert.ok(state.localSchemaHash);
  assert.equal(state.localSchemaHash.length, 64);
  assert.equal(state.serverSchemaHash, "server-hash");
  assert.equal(state.isMismatch, true);
  assert.equal(state.entries.length, 1);
  assert.equal(state.hasLocalSyncPayload, true);
  assert.equal(state.canSync, false);
  assert.equal(state.capabilities.schema.write, false);
});

test("loadStudioSchemaState handles empty types with top-level schemaHash", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: {
        read: true,
        write: true,
      },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected a ready schema state.");
  }

  assert.equal(state.entries.length, 0);
  assert.equal(state.serverSchemaHash, "server-hash");
  assert.equal(state.isMismatch, true);
});

test("loadStudioSchemaState enables sync only when schema.write is allowed and local schema data exists", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [
              {
                type: "BlogPost",
                directory: "content/blog",
                localized: true,
                schemaHash: "server-hash",
                syncedAt: "2026-03-31T12:00:00.000Z",
                resolvedSchema: {
                  type: "BlogPost",
                  directory: "content/blog",
                  localized: true,
                  fields: {},
                },
              },
            ],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: {
        read: true,
        write: true,
      },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected a ready schema state.");
  }

  assert.equal(state.hasLocalSyncPayload, true);
  assert.equal(state.canSync, true);
  assert.equal(state.capabilities.schema.write, true);
});

test("loadStudioSchemaState maps forbidden schema responses deterministically", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          code: "FORBIDDEN",
          message: "Forbidden.",
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
  });

  assert.equal(state.status, "forbidden");
  assert.equal(state.message, "Forbidden.");
});

test("loadStudioSchemaState maps invalid schema responses to error state", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: { unexpected: true },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
  });

  assert.equal(state.status, "error");
  assert.match(state.message, /invalid/i);
});

test("loadStudioSchemaState falls back to read-only ready state when local schema details are unavailable", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [
              {
                type: "BlogPost",
                directory: "content/blog",
                localized: true,
                schemaHash: "server-hash",
                syncedAt: "2026-03-31T12:00:00.000Z",
                resolvedSchema: {
                  type: "BlogPost",
                  directory: "content/blog",
                  localized: true,
                  fields: {},
                },
              },
            ],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createStudioEmbedConfig(createAuthoredConfig()),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: {
        read: true,
        write: true,
      },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected a ready schema state.");
  }

  assert.equal(state.hasLocalSyncPayload, false);
  assert.equal(state.canSync, false);
  assert.equal(state.localSchemaHash, undefined);
  assert.equal(state.syncPayload, undefined);
  assert.equal(state.entries.length, 1);
  assert.equal(state.serverSchemaHash, "server-hash");
});

test("loadStudioSchemaState keeps ready-state data when a sync attempt fails", async () => {
  const api = createStudioSchemaRouteApi(
    {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    {
      fetcher: async (input, init) => {
        if (
          String(input) === "http://localhost:4000/api/v1/schema" &&
          init?.method === "PUT"
        ) {
          return new Response(
            JSON.stringify({
              code: "FORBIDDEN",
              message: "Forbidden.",
            }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              types: [
                {
                  type: "BlogPost",
                  directory: "content/blog",
                  localized: true,
                  schemaHash: "server-hash",
                  syncedAt: "2026-03-31T12:00:00.000Z",
                  resolvedSchema: {
                    type: "BlogPost",
                    directory: "content/blog",
                    localized: true,
                    fields: {},
                  },
                },
              ],
              schemaHash: "server-hash",
              syncedAt: "2026-03-31T12:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    },
  );

  const state = await loadStudioSchemaState({
    config: createAuthoredConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: {
        read: true,
        write: true,
      },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected a ready schema state.");
  }

  const failedState = await state.sync();

  assert.equal(failedState.status, "ready");
  if (failedState.status !== "ready") {
    throw new Error("Expected the sync failure state to stay ready.");
  }

  assert.deepEqual(failedState.entries, state.entries);
  assert.equal(failedState.serverSchemaHash, state.serverSchemaHash);
  assert.equal(failedState.isMismatch, state.isMismatch);
  assert.equal(failedState.canSync, state.canSync);
  assert.equal(failedState.syncError, "Forbidden.");
});

test("loadStudioSchemaState returns project-mismatch when server project differs from config", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
            project: "other-project",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi(),
  });

  assert.equal(state.status, "project-mismatch");
  if (state.status !== "project-mismatch") {
    throw new Error("Expected project-mismatch state.");
  }
  assert.equal(state.configProject, "marketing-site");
  assert.equal(state.serverProject, "other-project");
  assert.equal(state.environment, "staging");
});

test("loadStudioSchemaState detects hash mismatch when server project matches config", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
            project: "marketing-site",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: { read: true, write: true },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected ready state.");
  }
  assert.equal(state.isMismatch, true);
});

test("loadStudioSchemaState uses precomputedLocalSchemaHash so mismatch is detected on first paint", async () => {
  // Browser-side derivation cannot run on a stripped config (no types), so
  // localSchemaHash would normally be undefined and the recovery banner
  // would only appear after an autosave failed server-side. Forwarding the
  // host-precomputed hash detects mismatch immediately.
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
            project: "marketing-site",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: { read: true, write: true },
    }),
    precomputedLocalSchemaHash: "host-precomputed-hash",
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected ready state.");
  }
  assert.equal(state.localSchemaHash, "host-precomputed-hash");
  assert.equal(state.serverSchemaHash, "server-hash");
  assert.equal(state.isMismatch, true);
  // No browser-side syncPayload available — sync must remain disabled even
  // when capabilities allow it, since the precomputed hash alone is not
  // enough to push a sync from the browser.
  assert.equal(state.canSync, false);
});

test("loadStudioSchemaState ignores whitespace-only precomputedLocalSchemaHash and falls back to browser-derived", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
            project: "marketing-site",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: { read: true, write: true },
    }),
    precomputedLocalSchemaHash: "   ",
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected ready state.");
  }
  // Whitespace-only host value must not override the valid browser-derived
  // hash, so the state still reports a real local hash and mismatch
  // detection works against the server hash.
  assert.notEqual(state.localSchemaHash, undefined);
  assert.notEqual(state.localSchemaHash, "   ");
  assert.equal(state.serverSchemaHash, "server-hash");
});

test("loadStudioSchemaState ignores precomputedLocalSchemaHash when it matches the server", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "matching-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
            project: "marketing-site",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: { read: true, write: true },
    }),
    precomputedLocalSchemaHash: "matching-hash",
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected ready state.");
  }
  assert.equal(state.isMismatch, false);
});

test("loadStudioSchemaState falls through to hash comparison when server omits project", async () => {
  const api = createSchemaRouteApi(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            types: [],
            schemaHash: "server-hash",
            syncedAt: "2026-03-31T12:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  const state = await loadStudioSchemaState({
    config: createConfig(),
    schemaApi: api,
    capabilitiesApi: createCapabilitiesApi({
      schema: { read: true, write: true },
    }),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("Expected ready state.");
  }
  assert.equal(state.isMismatch, true);
});
