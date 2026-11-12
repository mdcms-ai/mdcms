import { authorizedTestRequest as fixtureAuthorization } from "./content-api-test-support.js";
import assert from "node:assert/strict";
import { test } from "bun:test";

import { createServerRequestHandler } from "./server.js";
import {
  mountEnvironmentApiRoutes,
  type EnvironmentStore,
  type MountEnvironmentApiRoutesOptions,
} from "./environments-api.js";

const authorizedTestRequest = {
  ...fixtureAuthorization,
  authorizeEnvironmentResource: async () => {},
};
const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

function createStubStore(
  overrides: Partial<EnvironmentStore> = {},
): EnvironmentStore {
  const fail = (label: string) => async (): Promise<never> => {
    throw new Error(`stub ${label} not configured for this test`);
  };
  return {
    list: overrides.list ?? (fail("list") as EnvironmentStore["list"]),
    create: overrides.create ?? (fail("create") as EnvironmentStore["create"]),
    delete: overrides.delete ?? (fail("delete") as EnvironmentStore["delete"]),
    clone: overrides.clone ?? (fail("clone") as EnvironmentStore["clone"]),
    promote:
      overrides.promote ?? (fail("promote") as EnvironmentStore["promote"]),
  };
}

function createTestRoutes(options: Partial<MountEnvironmentApiRoutesOptions>) {
  return createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountEnvironmentApiRoutes(app, {
        store: options.store ?? createStubStore(),
        authorizeSession: options.authorizeSession ?? (async () => undefined),
        authorizeAdmin: options.authorizeAdmin ?? (async () => undefined),
        authorizeScoped:
          options.authorizeScoped ?? (async () => authorizedTestRequest),
        requireCsrf: options.requireCsrf ?? (async () => undefined),
      });
    },
  });
}

test("environment routes list project-scoped environments for admin sessions", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountEnvironmentApiRoutes(app, {
        store: {
          async list(project) {
            assert.equal(project, "marketing-site");
            return {
              data: [
                {
                  id: "env-production",
                  project: "marketing-site",
                  name: "production",
                  extends: null,
                  isDefault: true,
                  createdAt: "2026-03-11T12:00:00.000Z",
                },
              ],
              meta: {
                definitionsStatus: "ready",
                configSnapshotHash: "sha256:abc123",
                syncedAt: "2026-03-11T12:00:00.000Z",
              },
            };
          },
          async create() {
            throw new Error("not used");
          },
          async delete() {
            throw new Error("not used");
          },
          async clone() {
            throw new Error("not used");
          },
          async promote() {
            throw new Error("not used");
          },
        },
        authorizeSession: async () => undefined,
        authorizeAdmin: async () => undefined,
        authorizeScoped: async () => authorizedTestRequest,
        requireCsrf: async () => undefined,
      });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/environments?project=marketing-site"),
  );
  const body = (await response.json()) as {
    data: Array<{ name: string }>;
    meta: { definitionsStatus: string };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.data.map((entry) => entry.name),
    ["production"],
  );
  assert.equal(body.meta.definitionsStatus, "ready");
});

test("environment routes reject create requests without admin privileges", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountEnvironmentApiRoutes(app, {
        store: {
          async list() {
            return {
              data: [],
              meta: {
                definitionsStatus: "missing",
              },
            };
          },
          async create() {
            throw new Error("not used");
          },
          async delete() {
            throw new Error("not used");
          },
          async clone() {
            throw new Error("not used");
          },
          async promote() {
            throw new Error("not used");
          },
        },
        authorizeSession: async () => undefined,
        authorizeAdmin: async () => {
          throw Object.assign(new Error("forbidden"), {
            code: "FORBIDDEN",
            statusCode: 403,
            message: "Admin privileges are required to manage environments.",
          });
        },
        authorizeScoped: async () => authorizedTestRequest,
        requireCsrf: async () => undefined,
      });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/environments?project=marketing-site", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "staging",
        extends: "production",
      }),
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
});

test("clone route validates payload and rejects unknown include keys", async () => {
  let cloneCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async clone() {
        cloneCalls += 1;
        return { targetEnvironmentId: "target", documentsCloned: 0 };
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/environments/target-id/clone?project=marketing-site",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceEnvironmentId: "0bdf6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a",
          include: { content: true, settings: false, media: true },
        }),
      },
    ),
  );
  const body = (await response.json()) as { code: string };
  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(cloneCalls, 0);
});

test("clone route requires environments:clone scope", async () => {
  let scopedAttempts: string[] = [];
  const handler = createTestRoutes({
    store: createStubStore({
      async clone() {
        return { targetEnvironmentId: "target", documentsCloned: 0 };
      },
    }),
    authorizeScoped: async (_request, scope) => {
      scopedAttempts.push(scope);
      throw Object.assign(new Error("forbidden"), {
        code: "FORBIDDEN",
        statusCode: 403,
        message: `Missing scope ${scope}`,
      });
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/environments/target-id/clone?project=marketing-site",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceEnvironmentId: "0bdf6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a",
        }),
      },
    ),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(scopedAttempts, ["environments:clone"]);
});

test("promote route requires environments:promote scope and CSRF", async () => {
  let scopedAttempts: string[] = [];
  let csrfCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async promote() {
        return { promoted: [] };
      },
    }),
    authorizeScoped: async (_request, scope) => {
      scopedAttempts.push(scope);
      return authorizedTestRequest;
    },
    requireCsrf: async () => {
      csrfCalls += 1;
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/environments/target-id/promote?project=marketing-site",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceEnvironmentId: "0bdf6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a",
          documentIds: ["1f3b6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a"],
        }),
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(scopedAttempts, ["environments:promote"]);
  assert.equal(csrfCalls, 1);
});

test("promote route requires non-empty documentIds", async () => {
  const handler = createTestRoutes({
    store: createStubStore({
      async promote() {
        return { promoted: [] };
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/environments/target-id/promote?project=marketing-site",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceEnvironmentId: "0bdf6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a",
          documentIds: [],
        }),
      },
    ),
  );
  const body = (await response.json()) as {
    code: string;
    details?: Record<string, unknown>;
  };
  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
});

test("clone and promote routes require target routing project", async () => {
  const handler = createTestRoutes({
    store: createStubStore(),
  });

  for (const path of [
    "/api/v1/environments/target-id/clone",
    "/api/v1/environments/target-id/promote",
  ]) {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceEnvironmentId: "0bdf6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a",
          documentIds: ["1f3b6f3a-f3a0-4a8f-9fef-8d8ec0c64a1a"],
        }),
      }),
    );
    const body = (await response.json()) as { code: string };
    assert.equal(response.status, 400, `${path} should require routing`);
    assert.equal(body.code, "MISSING_TARGET_ROUTING");
  }
});

test("clone and promote pass trusted attribution from authorization to the store", async () => {
  const seen: unknown[] = [];
  const handler = createTestRoutes({
    authorizeScoped: async () => authorizedTestRequest,
    store: createStubStore({
      clone: async (_project, id, _input, context) => {
        seen.push(context);
        return { targetEnvironmentId: id, documentsCloned: 0 };
      },
      promote: async (_project, _id, _input, context) => {
        seen.push(context);
        return { promoted: [] };
      },
    }),
  });
  for (const action of ["clone", "promote"]) {
    const response = await handler(
      new Request(
        `http://localhost/api/v1/environments/00000000-0000-4000-8000-000000000002/${action}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mdcms-project": "p",
            "x-mdcms-internal-channel": "mcp",
          },
          body: JSON.stringify({
            sourceEnvironmentId: "00000000-0000-4000-8000-000000000003",
            ...(action === "promote"
              ? { documentIds: ["00000000-0000-4000-8000-000000000004"] }
              : {}),
          }),
        },
      ),
    );
    assert.equal(response.status, 200);
  }
  assert.equal(seen.length, 2);
  for (const context of seen)
    assert.deepEqual(context, {
      authorize: authorizedTestRequest.authorizeEnvironmentResource,
      attribution: {
        actorId:
          authorizedTestRequest.principal.type === "session"
            ? authorizedTestRequest.principal.session.userId
            : "",
        origin: { channel: "studio", credential: "session" },
      },
    });
});
