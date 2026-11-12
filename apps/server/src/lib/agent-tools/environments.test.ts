import assert from "node:assert/strict";
import { test } from "bun:test";
import { mountEnvironmentApiRoutes } from "../environments-api.js";
import { createInternalServerRequestHandler } from "../server.js";
import { authorizedTestRequest, baseEnv } from "../content-api-test-support.js";
import { createAgentToolRegistry } from "./registry.js";
import { createInternalDispatcher } from "./dispatcher.js";

test("environment tools preserve typed route envelopes and dry-run input", async () => {
  const calls: unknown[] = [];
  const authorizer = async () => {};
  const handler = createInternalServerRequestHandler({
    env: baseEnv,
    configureApp: (app) =>
      mountEnvironmentApiRoutes(app, {
        authorizeSession: async () => {},
        authorizeAdmin: async () => {},
        authorizeList: async () => {},
        authorizeScoped: async () => ({
          ...authorizedTestRequest,
          authorizeEnvironmentResource: authorizer,
        }),
        requireCsrf: async () => {},
        store: {
          list: async (project) => ({
            data: [
              {
                id: "target",
                project,
                name: "production",
                extends: null,
                isDefault: true,
                createdAt: new Date().toISOString(),
              },
            ],
            meta: { definitionsStatus: "missing" },
          }),
          create: async () => {
            throw new Error("unused");
          },
          delete: async () => {
            throw new Error("unused");
          },
          clone: async (project, target, input, context) => {
            calls.push({ project, target, input });
            assert.equal(context.authorize, authorizer);
            assert.equal(context.attribution.origin.channel, "studio");
            return { targetEnvironmentId: target, documentsCloned: 1 };
          },
          promote: async (project, target, input) => {
            calls.push({ project, target, input });
            return { promoted: [] };
          },
        },
      }),
  });
  const context = {
    authorization: { ...authorizedTestRequest, globalAdmin: true },
    target: { project: "p", environment: "production" },
    dispatch: createInternalDispatcher(handler, "secret", {
      request: new Request("http://localhost"),
      project: "p",
      environment: "production",
      channel: "mcp",
    }),
  };
  const registry = createAgentToolRegistry();
  assert.equal(registry.list(context.authorization).length, 27);
  assert.equal(
    ((await registry.execute("list_environments", {}, context)) as any).meta
      .definitionsStatus,
    "missing",
  );
  const sourceEnvironmentId = "00000000-0000-4000-8000-000000000003";
  await registry.execute(
    "clone_environment",
    {
      targetEnvironmentId: "target",
      sourceEnvironmentId,
      include: { content: true, settings: false },
      includeDrafts: false,
      preservePaths: true,
    },
    context,
  );
  await registry.execute(
    "promote_documents",
    {
      targetEnvironmentId: "target",
      sourceEnvironmentId,
      documentIds: ["00000000-0000-4000-8000-000000000004"],
      includeUnpublished: false,
      dryRun: true,
    },
    context,
  );
  assert.equal(calls.length, 2);
  assert.equal((calls[1] as any).input.dryRun, true);
  await assert.rejects(
    registry.execute(
      "clone_environment",
      {
        targetEnvironmentId: "target",
        sourceEnvironmentId,
        include: { content: true, settings: false },
        includeDrafts: false,
        preservePaths: true,
        actor: "forged",
      },
      context,
    ),
  );
});
