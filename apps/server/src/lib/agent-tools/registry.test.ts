import { mountSchemaApiRoutes } from "../schema-api.js";
import { adaptAssistantReadTool } from "./assistant-reads.js";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeError } from "@mdcms/shared";
import { createCollaborationUnavailableError } from "../collaboration/errors.js";
import { createAgentToolRegistry } from "./registry.js";
import { createInternalDispatcher } from "./dispatcher.js";
import { createInternalServerRequestHandler } from "../server.js";
import {
  createInMemoryContentStore,
  mountContentApiRoutes,
} from "../content-api.js";
import { baseEnv, authorizedTestRequest } from "../content-api-test-support.js";

test("registry rejects duplicate names and rechecks scopes during execution", async () => {
  const registry = createAgentToolRegistry();
  assert.throws(
    () => registry.register(registry.list(authorizedTestRequest)[0]!),
    /Duplicate agent tool/,
  );
  const authorization = {
    mode: "api_key" as const,
    principal: {
      type: "api_key" as const,
      keyId: "key",
      createdByUserId: "owner",
      createdByUserEmail: "owner@example.test",
      keyPrefix: "prefix",
      label: "test",
      scopes: ["content:read:draft" as const],
      contextAllowlist: [{ project: "p", environment: "e" }],
    },
  };
  assert.deepEqual(
    registry.list(authorization).map((tool) => tool.name),
    ["get_document", "list_documents"],
  );
  let calls = 0;
  const result = await registry.call(
    "create_document",
    {},
    {
      authorization,
      target: { project: "p", environment: "e" },
      dispatch: async () => {
        calls++;
        return new Response();
      },
    },
  );
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0]!.text).code, "FORBIDDEN");
  assert.equal(calls, 0);
});

test("registry uses mounted routes, preserves exact revision and hash, and rejects writes without current grants", async () => {
  const scope = { project: "registry", environment: "production" };
  const schema = {
    type: "Note",
    directory: "notes",
    localized: true,
    fields: { title: { kind: "string", required: true, nullable: false } },
  };
  const store = createInMemoryContentStore({
    schemaScopes: [{ ...scope, schemas: { Note: schema } }],
  });
  let allowed = true;
  let active = false;
  let collaborationFailure: Error | undefined;
  let race = false;
  const events: string[] = [];
  const handler = createInternalServerRequestHandler({
    env: baseEnv,
    configureApp: (app) => {
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (!allowed || requirement.documentPath?.startsWith("denied"))
            throw new RuntimeError({
              code: "FORBIDDEN",
              message: "Denied.",
              statusCode: 403,
            });
          return authorizedTestRequest;
        },
        requireCsrf: async () => {},
        getWriteSchemaSyncState: async () => ({ schemaHash: "hash" }),
        activeCollaboration: {
          isDocumentActive: async () => {
            if (collaborationFailure) throw collaborationFailure;
            return active;
          },
        },
        lifecycleEvents: {
          emitContentEvent: async (value) => {
            events.push(value.event);
          },
        },
      });
      mountSchemaApiRoutes(app, {
        authorize: async () => authorizedTestRequest,
        requireCsrf: async () => {},
        store: {
          list: async () => [
            {
              ...schema,
              schemaHash: "hash",
              syncedAt: "now",
              resolvedSchema: schema,
            },
          ],
          getCurrentSync: async () => ({ schemaHash: "hash", syncedAt: "now" }),
          getByType: async () => undefined,
          sync: async () => {
            throw new Error("Not used");
          },
        },
      });
    },
  });
  const dispatch = createInternalDispatcher(
    async (request) => {
      if (race && request.method === "PUT") {
        race = false;
        await store.update(
          scope,
          new URL(request.url).pathname.split("/").at(-1)!,
          { body: "competitor" },
          {
            attribution: {
              actorId: "other",
              origin: { channel: "api", credential: "api_key" },
            },
          },
        );
      }
      return handler(request);
    },
    "secret",
    {
      request: new Request("http://localhost", {
        headers: { authorization: "Bearer caller" },
      }),
      ...scope,
      channel: "mcp",
    },
  );
  const registry = createAgentToolRegistry();
  const context = {
    dispatch,
    target: scope,
    authorization: authorizedTestRequest,
  };
  const created = (await registry.execute(
    "create_document",
    {
      type: "Note",
      path: "notes/one",
      locale: "en",
      format: "mdx",
      frontmatter: { title: "One" },
      body: "hello",
      schemaHash: "hash",
    },
    context,
  )) as any;
  const documentId = created.data.documentId;
  assert.deepEqual(events, ["content.created"]);
  assert.equal(
    ((await registry.execute("get_document", { documentId }, context)) as any)
      .data.body,
    "hello",
  );
  for (const name of [
    "list_documents",
    "get_document",
    "get_schema",
  ] as const) {
    const definition = registry
      .list(context.authorization)
      .find((tool) => tool.name === name)!;
    const adapted = adaptAssistantReadTool(
      definition,
      (input) => registry.execute(name, input, context),
      { registeredTypes: ["Note"], supportedLocales: ["en"] },
    );
    const output = await adapted.execute(
      name === "list_documents"
        ? { type: "Note", q: "hello" }
        : name === "get_document"
          ? { documentId }
          : {},
    );
    assert.equal(adapted.outputSchema.safeParse(output).success, true);
    if (name === "list_documents") {
      assert.equal(JSON.stringify(output).includes('"body"'), false);
      assert.equal(
        adapted.inputSchema.safeParse({ type: "Other" }).success,
        false,
      );
      assert.equal(
        adapted.inputSchema.safeParse({ type: "Note", query: "hello" }).success,
        false,
      );
    }
  }
  for (const input of [
    { frontmatter: { title: 1 }, schemaHash: "hash" },
    { body: "<Broken>", schemaHash: "hash" },
    { body: "changed", schemaHash: "wrong" },
    { path: "denied/move", schemaHash: "hash" },
  ])
    await assert.rejects(
      registry.execute("update_document", { documentId, ...input }, context),
    );
  assert.deepEqual(events, ["content.created"]);
  active = true;
  await assert.rejects(
    registry.execute(
      "update_document",
      { documentId, body: "changed", schemaHash: "hash" },
      context,
    ),
    (error: any) => error.code === "DOCUMENT_COLLABORATION_ACTIVE",
  );
  active = false;
  for (const failure of [
    createCollaborationUnavailableError({ connection: "private-connection" }),
    new Error("private-stack-and-credentials"),
    new RuntimeError({
      code: "INTERNAL_ERROR",
      statusCode: 500,
      message: "private-internal-message",
      details: { secret: "private" },
    }),
  ]) {
    collaborationFailure = failure;
    const result = await registry.call(
      "update_document",
      { documentId, body: "changed", schemaHash: "hash" },
      context,
    );
    assert.equal(result.isError, true);
    assert.deepEqual(
      JSON.parse(result.content[0]!.text),
      failure instanceof RuntimeError &&
        failure.code === "COLLABORATION_UNAVAILABLE"
        ? {
            code: "COLLABORATION_UNAVAILABLE",
            status: 503,
            message: "Collaboration Redis is unavailable.",
          }
        : {
            code: "INTERNAL_ERROR",
            status: 500,
            message: "Internal server error.",
          },
    );
    assert.equal(
      (await store.getById(scope, documentId, { draft: true }))?.body,
      "hello",
    );
    assert.deepEqual(events, ["content.created"]);
  }
  collaborationFailure = undefined;
  allowed = false;
  await assert.rejects(
    registry.execute("publish_document", { documentId }, context),
    (error: any) => error.code === "FORBIDDEN",
  );
  allowed = true;
  race = true;
  await assert.rejects(
    registry.execute(
      "update_document",
      { documentId, body: "changed", schemaHash: "hash" },
      context,
    ),
    (error: any) => error.code === "STALE_DRAFT_REVISION",
  );
  assert.equal(
    (await store.getById(scope, documentId, { draft: true }))?.body,
    "competitor",
  );
  assert.deepEqual(events, ["content.created"]);
  await registry.execute("publish_document", { documentId }, context);
  const versions = (await registry.execute(
    "list_versions",
    { documentId },
    context,
  )) as any;
  assert.equal(versions.data.length, 1);
  assert.equal(
    (
      (await registry.execute(
        "get_version",
        { documentId, version: 1 },
        context,
      )) as any
    ).data.body,
    "competitor",
  );
  active = true;
  await assert.rejects(
    registry.execute("restore_version", { documentId, version: 1 }, context),
    (error: any) => error.code === "DOCUMENT_COLLABORATION_ACTIVE",
  );
  active = false;
  await registry.execute(
    "restore_version",
    { documentId, version: 1 },
    context,
  );
  const duplicate = (await registry.execute(
    "duplicate_document",
    { documentId, schemaHash: "hash" },
    context,
  )) as any;
  assert.notEqual(duplicate.data.documentId, documentId);
  await registry.execute("unpublish_document", { documentId }, context);
  assert.equal(
    (
      (await registry.execute(
        "delete_document",
        { documentId },
        context,
      )) as any
    ).data.isDeleted,
    true,
  );
  assert.equal(
    (
      (await registry.execute(
        "restore_document",
        { documentId },
        context,
      )) as any
    ).data.isDeleted,
    false,
  );
  const translated = (await registry.execute(
    "create_translation",
    {
      sourceDocumentId: documentId,
      type: "Note",
      path: "notes/fr",
      locale: "fr",
      frontmatter: { title: "French" },
      body: "bonjour",
      schemaHash: "hash",
    },
    context,
  )) as any;
  const variants = (await registry.execute(
    "list_translations",
    { documentId },
    context,
  )) as any;
  assert.ok(
    variants.data.some(
      (row: any) => row.documentId === translated.data.documentId,
    ),
  );
  await assert.rejects(
    registry.execute(
      "create_translation",
      {
        sourceDocumentId: documentId,
        type: "Note",
        path: "notes/fr2",
        locale: "fr",
        frontmatter: { title: "French" },
        body: "bonjour",
        schemaHash: "hash",
      },
      context,
    ),
  );
  const names = registry.list(context.authorization).map((tool) => tool.name);
  assert.deepEqual(names, [...names].sort());
  await assert.rejects(
    registry.execute("get_document", { documentId, project: "other" }, context),
  );
});

test("restore discovery accepts either action scope but execution requires the selected action", async () => {
  const registry = createAgentToolRegistry();
  for (const scope of ["content:write", "content:publish"] as const) {
    const authorization = {
      mode: "api_key" as const,
      principal: {
        type: "api_key" as const,
        keyId: "key",
        createdByUserId: "owner",
        createdByUserEmail: "owner@example.test",
        keyPrefix: "prefix",
        label: "test",
        scopes: [scope],
        contextAllowlist: [{ project: "p", environment: "e" }],
      },
    };
    assert.ok(
      registry
        .list(authorization)
        .some((tool) => tool.name === "restore_document"),
    );
    assert.ok(
      registry
        .list(authorization)
        .some((tool) => tool.name === "restore_version"),
    );
    let calls = 0;
    for (const name of ["restore_document", "restore_version"]) {
      await assert.rejects(
        registry.execute(
          name,
          {
            documentId: "id",
            ...(name === "restore_version" ? { version: 1 } : {}),
            targetStatus: scope === "content:write" ? "published" : "draft",
          },
          {
            authorization,
            target: { project: "p", environment: "e" },
            dispatch: async () => {
              calls++;
              return Response.json({});
            },
          },
        ),
        (error: any) => error.code === "FORBIDDEN",
      );
    }
    assert.equal(calls, 0);
  }
});

test("environment metadata discovery needs scope and current global administrator status", () => {
  const registry = createAgentToolRegistry();
  const authorization = {
    mode: "api_key" as const,
    principal: {
      type: "api_key" as const,
      keyId: "key",
      createdByUserId: "owner",
      createdByUserEmail: "owner@example.test",
      keyPrefix: "prefix",
      label: "test",
      scopes: ["environments:read" as const],
      contextAllowlist: [{ project: "p", environment: "e" }],
    },
  };
  assert.equal(
    registry
      .list(authorization)
      .some((tool) => tool.name === "list_environments"),
    false,
  );
  assert.equal(
    registry
      .list({ ...authorization, globalAdmin: true })
      .some((tool) => tool.name === "list_environments"),
    true,
  );
  assert.equal(
    registry
      .list({
        ...authorization,
        globalAdmin: true,
        principal: { ...authorization.principal, scopes: [] },
      })
      .some((tool) => tool.name === "list_environments"),
    false,
  );
});
