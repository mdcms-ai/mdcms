import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  createConfig,
  createStubStore,
  createTestRoutes,
  validSecret,
} from "../webhooks/test-support.js";
import { authorizedTestRequest } from "../content-api-test-support.js";
import { createInternalDispatcher } from "./dispatcher.js";
import { createAgentToolRegistry } from "./registry.js";

test("webhook tools dispatch mounted routes, reject private destinations and redact secrets", async () => {
  let row = createConfig();
  let mutations = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      create: async (_scope, input) => {
        mutations++;
        row = createConfig(input);
        return row;
      },
      update: async (_scope, _id, input) => {
        mutations++;
        row = { ...row, ...input };
        return row;
      },
      list: async () => [row],
      delete: async () => {
        mutations++;
        return { deleted: true, id: row.id };
      },
      listDeliveryHistory: async () => [],
    }),
  });
  const context = {
    authorization: authorizedTestRequest,
    target: { project: "marketing-site", environment: "production" },
    dispatch: createInternalDispatcher(handler, "secret", {
      request: new Request("http://localhost"),
      project: "marketing-site",
      environment: "production",
      channel: "mcp",
    }),
  };
  const registry = createAgentToolRegistry();
  await assert.rejects(
    registry.execute(
      "create_webhook",
      {
        url: "http://127.0.0.1/hook",
        events: ["content.created"],
        secret: validSecret,
      },
      context,
    ),
  );
  assert.equal(mutations, 0);
  const result = (await registry.execute(
    "create_webhook",
    {
      url: "https://example.com/hook",
      events: ["content.created"],
      secret: validSecret,
    },
    context,
  )) as any;
  assert.equal(result.data.secret, undefined);
  assert.equal(mutations, 1);
  assert.equal(
    ((await registry.execute("list_webhooks", {}, context)) as any).data.length,
    1,
  );
  await registry.execute(
    "update_webhook",
    { id: row.id, active: false },
    context,
  );
  assert.equal(row.active, false);
  assert.deepEqual(
    await registry.execute("list_webhook_deliveries", {}, context),
    { data: [] },
  );
  await registry.execute("delete_webhook", { id: row.id }, context);
  assert.equal(mutations, 3);
  await assert.rejects(
    registry.execute(
      "create_webhook",
      {
        url: "https://example.com",
        events: ["content.created"],
        secret: validSecret,
        actorId: "forged",
      },
      context,
    ),
  );
});
