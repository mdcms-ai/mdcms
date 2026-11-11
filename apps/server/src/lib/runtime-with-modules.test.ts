import { installedModules, type CoreAiServerDeps } from "@mdcms/modules";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  RuntimeError,
  assertStudioBootstrapManifest,
  createConsoleLogger,
  type ContentDocumentResponse,
  type MdcmsModulePackage,
  type StudioBootstrapReadyResponse,
} from "@mdcms/shared";

import { buildServerModuleLoadReport } from "./module-loader.js";
import {
  createCollaborationGuardedAiContentStore,
  createRuntimeMediaObjectStore,
  createServerRequestHandlerWithModules,
  prepareServerRequestHandlerWithModules,
  shutdownServerRuntime,
} from "./runtime-with-modules.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "1.0.0",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://test:test@localhost:5432/mdcms_test",
} as NodeJS.ProcessEnv;

const envWithoutAppVersion = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://test:test@localhost:5432/mdcms_test",
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "trace",
  sink: () => undefined,
});

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createServerModule(
  id: string,
  options: {
    dependsOn?: string[];
    actions?: Array<{ id: string; path: string }>;
    onMount?: (deps: Record<string, unknown>) => void;
  } = {},
): MdcmsModulePackage<unknown, Record<string, unknown>> {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: "1",
      minCoreVersion: "0.0.1",
      dependsOn: options.dependsOn,
    },
    server: {
      mount: (_app, deps) => {
        options.onMount?.(deps);
      },
      actions: (options.actions ?? []).map((action) => ({
        id: action.id,
        kind: "query",
        method: "GET",
        path: action.path,
        permissions: ["content:read"],
      })),
    },
  };
}

function createAiStoreDocument(
  documentId: string,
  overrides: Partial<ContentDocumentResponse> = {},
): ContentDocumentResponse {
  return {
    documentId,
    translationGroupId: `${documentId}-translation-group`,
    project: "marketing",
    environment: "draft",
    path: `content/${documentId}`,
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: {},
    body: "body",
    version: 0,
    publishedVersion: null,
    hasUnpublishedChanges: true,
    isDeleted: false,
    createdAt: "2026-06-11T00:00:00.000Z",
    createdBy: "user-1",
    updatedAt: "2026-06-11T00:00:00.000Z",
    updatedBy: "user-1",
    draftRevision: 1,
    ...overrides,
  };
}

test("createServerRequestHandlerWithModules surfaces module actions in /api/v1/actions", async () => {
  const { handler, moduleLoadReport, dbConnection } =
    createServerRequestHandlerWithModules({
      env,
      logger,
    });

  try {
    const response = await handler(
      new Request("http://localhost/api/v1/actions"),
    );
    const body = (await response.json()) as Array<{ id: string }>;

    assert.equal(response.status, 200);
    assert.equal(moduleLoadReport.loadedModuleIds.length > 0, true);
    assert.deepEqual(
      body.map((entry) => entry.id),
      ["core.system.ping", "domain.content.preview"],
    );
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules mounts server module routes", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });

  try {
    const coreResponse = await handler(
      new Request("http://localhost/api/v1/modules/core-system/ping"),
    );
    const coreBody = (await coreResponse.json()) as Record<string, unknown>;

    assert.equal(coreResponse.status, 200);
    assert.equal(coreBody.moduleId, "core.system");

    const contentResponse = await handler(
      new Request("http://localhost/api/v1/modules/domain-content/preview"),
    );
    const contentBody = (await contentResponse.json()) as Record<
      string,
      unknown
    >;

    assert.equal(contentResponse.status, 200);
    assert.equal(contentBody.moduleId, "domain.content");
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules mounts media routes before auth and DB work", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });

  try {
    const response = await handler(
      new Request("http://localhost/api/v1/media/settings"),
    );
    const body = (await response.json()) as { code: string };

    assert.equal(response.status, 400);
    assert.equal(body.code, "MISSING_TARGET_ROUTING");
  } finally {
    await dbConnection.close();
  }
});

test("createRuntimeMediaObjectStore uses endpoint-derived public URLs when public base URL is omitted", () => {
  assert.equal(createRuntimeMediaObjectStore({}), undefined);
  assert.equal(
    createRuntimeMediaObjectStore({
      S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
    }),
    undefined,
  );

  const store = createRuntimeMediaObjectStore({
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    S3_BUCKET: "mdcms-media",
  });

  assert.equal(
    store?.publicUrlForKey("projects/marketing-site/media/id/hero.png"),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/hero.png",
  );
});

test("createCollaborationGuardedAiContentStore blocks existing-document writes while active", async () => {
  const calls: string[] = [];
  const scope = { project: "marketing-site", environment: "staging" };
  const document: ContentDocumentResponse = {
    documentId: "active-document",
    translationGroupId: "translation-group-1",
    project: "marketing-site",
    environment: "staging",
    path: "content/blog/active",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: {},
    body: "body",
    version: 0,
    publishedVersion: null,
    hasUnpublishedChanges: true,
    isDeleted: false,
    createdAt: "2026-06-11T00:00:00.000Z",
    createdBy: "user-1",
    updatedAt: "2026-06-11T00:00:00.000Z",
    updatedBy: "user-1",
    draftRevision: 1,
  };
  const store = createCollaborationGuardedAiContentStore(
    {
      async getById() {
        calls.push("getById");
        return document;
      },
      async update() {
        calls.push("update");
        return document;
      },
      async create() {
        calls.push("create");
        return document;
      },
      async softDelete() {
        calls.push("softDelete");
        return { ...document, isDeleted: true };
      },
      async restore() {
        calls.push("restore");
        return document;
      },
    },
    {
      isDocumentActive: async (documentId) => documentId === "active-document",
    },
    {
      invalidateDocument: async () => {
        calls.push("invalidate");
      },
    },
  );

  await assert.rejects(
    () =>
      store.update(
        scope,
        "active-document",
        { body: "next" },
        {
          attribution: {
            actorId: "user-1",
            origin: { channel: "studio", credential: "session" },
          },
          expectedSchemaHash: "schema-hash",
        },
      ),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_COLLABORATION_ACTIVE" &&
      error.statusCode === 409 &&
      error.details?.documentId === "active-document",
  );
  await assert.rejects(
    () =>
      store.softDelete(scope, "active-document", {
        attribution: {
          actorId: "user-1",
          origin: { channel: "studio", credential: "session" },
        },
      }),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_COLLABORATION_ACTIVE",
  );
  const restore = store.restore;
  assert.ok(restore);
  await assert.rejects(
    () =>
      restore(scope, "active-document", {
        attribution: {
          actorId: "user-1",
          origin: { channel: "studio", credential: "session" },
        },
      }),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_COLLABORATION_ACTIVE",
  );

  assert.deepEqual(calls, []);

  await store.getById(scope, "active-document", { draft: true });
  await store.create(
    scope,
    {
      type: "BlogPost",
      path: "content/blog/new",
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "new",
    },
    {
      attribution: {
        actorId: "user-1",
        origin: { channel: "studio", credential: "session" },
      },
      expectedSchemaHash: "schema-hash",
    },
  );

  assert.deepEqual(calls, ["getById", "create"]);
});

test("createCollaborationGuardedAiContentStore invalidates inactive cache after update and delete", async () => {
  const invalidated: string[] = [];
  const store = createCollaborationGuardedAiContentStore(
    {
      async getById() {
        return undefined;
      },
      async update(_scope, documentId) {
        return createAiStoreDocument(documentId, { path: "content/updated" });
      },
      async create(_scope, payload) {
        return createAiStoreDocument("created", { path: payload.path });
      },
      async softDelete(_scope, documentId) {
        return createAiStoreDocument(documentId, {
          path: "content/deleted",
          isDeleted: true,
        });
      },
    },
    undefined,
    {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  );

  await store.update(
    { project: "marketing", environment: "draft" },
    "doc-update",
    { body: "updated" },
    {
      attribution: {
        actorId: "user-1",
        origin: { channel: "studio", credential: "session" },
      },
      expectedSchemaHash: "schema-hash",
    },
  );
  await store.softDelete(
    { project: "marketing", environment: "draft" },
    "doc-delete",
    {
      attribution: {
        actorId: "user-1",
        origin: { channel: "studio", credential: "session" },
      },
    },
  );

  assert.deepEqual(invalidated, ["doc-update", "doc-delete"]);
});

test("createCollaborationGuardedAiContentStore invalidates inactive cache after restore", async () => {
  const invalidated: string[] = [];
  const store = createCollaborationGuardedAiContentStore(
    {
      async getById() {
        return undefined;
      },
      async update(_scope, documentId) {
        return createAiStoreDocument(documentId);
      },
      async create(_scope, payload) {
        return createAiStoreDocument("created", { path: payload.path });
      },
      async softDelete(_scope, documentId) {
        return createAiStoreDocument(documentId, { isDeleted: true });
      },
      async restore(_scope, documentId) {
        return createAiStoreDocument(documentId);
      },
    },
    undefined,
    {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  );

  const restore = store.restore;
  assert.ok(restore);

  await restore({ project: "marketing", environment: "draft" }, "doc-restore", {
    attribution: {
      actorId: "user-1",
      origin: { channel: "studio", credential: "session" },
    },
  });

  assert.deepEqual(invalidated, ["doc-restore"]);
});

test("createCollaborationGuardedAiContentStore ignores inactive cache invalidation failure after update", async () => {
  const store = createCollaborationGuardedAiContentStore(
    {
      async getById() {
        return undefined;
      },
      async update(_scope, documentId) {
        return createAiStoreDocument(documentId, { path: "content/updated" });
      },
      async create(_scope, payload) {
        return createAiStoreDocument("created", { path: payload.path });
      },
      async softDelete(_scope, documentId) {
        return createAiStoreDocument(documentId, { isDeleted: true });
      },
    },
    undefined,
    {
      invalidateDocument: async () => {
        throw new Error("redis unavailable");
      },
    },
  );

  const updated = await store.update(
    { project: "marketing", environment: "draft" },
    "doc-update",
    { body: "updated" },
    {
      attribution: {
        actorId: "user-1",
        origin: { channel: "studio", credential: "session" },
      },
      expectedSchemaHash: "schema-hash",
    },
  );

  assert.equal(updated.documentId, "doc-update");
});

test("createServerRequestHandlerWithModules loads bundled modules when APP_VERSION is unset", async () => {
  const { moduleLoadReport, dbConnection } =
    createServerRequestHandlerWithModules({
      env: envWithoutAppVersion,
      logger,
    });

  try {
    assert.deepEqual(moduleLoadReport.loadedModuleIds, [
      "core.ai",
      "core.system",
      "domain.content",
    ]);
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules fails before module mount on invalid bootstrap", () => {
  let mounted = false;

  const invalidModule = createServerModule("broken", {
    dependsOn: ["missing.core"],
    onMount: () => {
      mounted = true;
    },
  });

  assert.throws(
    () =>
      createServerRequestHandlerWithModules({
        env,
        logger,
        moduleLoadReport: buildServerModuleLoadReport([invalidModule], {
          coreVersion: "1.0.0",
          logger,
        }),
      }),
    (error) => {
      assert.equal(error instanceof RuntimeError, true);

      if (!(error instanceof RuntimeError)) {
        return false;
      }

      assert.equal(error.code, "INVALID_MODULE_BOOTSTRAP");
      const details = error.details as
        | { violations?: Array<{ code: string }> }
        | undefined;
      const violationCodes = (details?.violations ?? []).map(
        (entry) => entry.code,
      );
      assert.deepEqual(violationCodes, ["MISSING_DEPENDENCY"]);

      return true;
    },
  );

  assert.equal(mounted, false);
});

test("createServerRequestHandlerWithModules passes explicit composition-root deps to module mount", async () => {
  let capturedDeps: Record<string, unknown> | undefined;

  const dependencyProbe = createServerModule("dep.probe", {
    onMount: (deps) => {
      capturedDeps = deps;
    },
  });

  const moduleLoadReport = buildServerModuleLoadReport([dependencyProbe], {
    coreVersion: "1.0.0",
    logger,
  });

  const moduleDeps = {
    customService: "probe",
  };

  const { dbConnection, dal } = createServerRequestHandlerWithModules({
    env,
    logger,
    moduleLoadReport,
    moduleDeps,
  });

  try {
    assert.equal(capturedDeps !== undefined, true);

    if (!capturedDeps) {
      return;
    }

    assert.equal(capturedDeps.customService, "probe");
    assert.equal(capturedDeps.dal, dal);
  } finally {
    await dbConnection.close();
  }
});

test("prepareServerRequestHandlerWithModules publishes module actions and studio runtime endpoints together", async () => {
  await withTempDir("runtime-with-modules-", async (directory) => {
    const sourceFile = join(directory, "remote.ts");
    const outDir = join(directory, "studio-dist");
    await writeFile(
      sourceFile,
      "export const mount = (_container: unknown, _ctx: unknown) => () => {};\n",
      "utf8",
    );

    const { handler, dbConnection } =
      await prepareServerRequestHandlerWithModules({
        env,
        logger,
        studioRuntimeOptions: {
          sourceFile,
          outDir,
          studioVersion: "1.0.0",
        },
      });

    try {
      const actionsResponse = await handler(
        new Request("http://localhost/api/v1/actions"),
      );
      const actionsBody = (await actionsResponse.json()) as Array<{
        id: string;
      }>;

      assert.equal(actionsResponse.status, 200);
      assert.deepEqual(
        actionsBody.map((entry) => entry.id),
        ["core.system.ping", "domain.content.preview"],
      );

      const probeResponse = await handler(
        new Request("http://localhost/api/v1/modules/core-system/ping"),
      );

      assert.equal(probeResponse.status, 200);

      const bootstrapResponse = await handler(
        new Request("http://localhost/api/v1/studio/bootstrap"),
      );
      const bootstrapBody =
        (await bootstrapResponse.json()) as StudioBootstrapReadyResponse;

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.data.status, "ready");
      assert.equal(bootstrapBody.data.source, "active");
      assertStudioBootstrapManifest(
        bootstrapBody.data.manifest,
        "bootstrap.data.manifest",
      );
      assert.equal(bootstrapBody.data.manifest.mode, "module");

      const retryBootstrapResponse = await handler(
        new Request(
          "http://localhost/api/v1/studio/bootstrap?rejectedBuildId=" +
            bootstrapBody.data.manifest.buildId +
            "&rejectionReason=integrity",
        ),
      );
      const retryBootstrapBody =
        (await retryBootstrapResponse.json()) as Record<string, unknown>;

      assert.equal(retryBootstrapResponse.status, 503);
      assert.equal(retryBootstrapBody.code, "STUDIO_RUNTIME_UNAVAILABLE");

      const assetResponse = await handler(
        new Request(`http://localhost${bootstrapBody.data.manifest.entryUrl}`),
      );
      const assetBody = await assetResponse.text();

      assert.equal(assetResponse.status, 200);
      assert.equal(
        assetResponse.headers.get("content-type"),
        "text/javascript; charset=utf-8",
      );
      assert.equal(assetBody.length > 0, true);
    } finally {
      await dbConnection.close();
    }
  });
});

test("prepared server handleRequest preserves HTTP handler calls and maps unavailable collaboration upgrades to 503", async () => {
  await withTempDir(
    "runtime-with-modules-collaboration-",
    async (directory) => {
      const sourceFile = join(directory, "remote.ts");
      const outDir = join(directory, "studio-dist");
      await writeFile(
        sourceFile,
        "export const mount = (_container: unknown, _ctx: unknown) => () => {};\n",
        "utf8",
      );

      const { handler, handleRequest, dbConnection } =
        await prepareServerRequestHandlerWithModules({
          env: {
            ...env,
            REDIS_URL: "",
          },
          logger,
          studioRuntimeOptions: {
            sourceFile,
            outDir,
            studioVersion: "1.0.0",
          },
        });

      try {
        const healthResponse = await handler(
          new Request("http://localhost/healthz"),
        );
        assert.equal(healthResponse.status, 200);

        const calls: Array<{ request: Request; options: unknown }> = [];
        const upgradeResponse = await handleRequest(
          new Request(
            "http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=11111111-1111-4111-8111-111111111111",
            {
              headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                origin: "http://localhost:4173",
              },
            },
          ),
          {
            upgrade(request: Request, options: unknown) {
              calls.push({ request, options });
              return true;
            },
          } as never,
        );
        const body = (await upgradeResponse?.json()) as { code: string };

        assert.equal(upgradeResponse?.status, 503);
        assert.equal(body.code, "COLLABORATION_UNAVAILABLE");
        assert.deepEqual(calls, []);
      } finally {
        await dbConnection.close();
      }
    },
  );
});

test("shutdownServerRuntime drains collaboration before closing database", async () => {
  const calls: string[] = [];

  await shutdownServerRuntime({
    disposeAiProposals: () => {
      calls.push("ai:dispose");
    },
    collaborationWebSocketTransport: {
      async shutdown() {
        calls.push("collaboration:shutdown");
      },
    },
    dbConnection: {
      async close() {
        calls.push("db:close");
      },
    },
  });

  assert.deepEqual(calls, ["collaboration:shutdown", "ai:dispose", "db:close"]);
});

(process.env.MDCMS_TEST_DATABASE_URL ? test : test.skip)(
  "Assistant host applies proposals with the authenticated session user's origin",
  async () => {
    const { createDatabaseTestContext, seedSchemaRegistryScope } = await import(
      "./content-api-test-support.js"
    );
    const { createDatabaseContentStore } = await import(
      "./content-api/database-store.js"
    );
    // This integration check is opt-in so the regular runtime unit suite does not
    // require a database or write to a developer's default database.
    let ai: CoreAiServerDeps | undefined;
    const context = await createDatabaseTestContext(
      "attribution-host",
      (options) =>
        createServerRequestHandlerWithModules({
          ...options,
          moduleLoadReport: buildServerModuleLoadReport(
            [
              ...installedModules,
              createServerModule("test.capture", {
                onMount: (deps) => {
                  ai = deps.ai as CoreAiServerDeps;
                },
              }),
            ],
            { coreVersion: "9.9.9", logger },
          ),
        }),
    );
    const scope = {
      project: "_test-attribution-host",
      environment: "production",
    };
    try {
      await context.prepareScope(scope);
      const { schemaHash } = await seedSchemaRegistryScope(
        context.dbConnection.db,
        {
          scope,
          entries: [
            {
              type: "Note",
              directory: "notes",
              localized: false,
              fields: {
                title: { kind: "string", required: false, nullable: false },
              },
            },
          ],
        },
      );
      const headers = context.csrfHeaders({
        "content-type": "application/json",
        "x-mdcms-project": scope.project,
        "x-mdcms-environment": scope.environment,
      });
      const missingCsrf = new Headers(headers);
      missingCsrf.delete("x-mdcms-csrf-token");
      const factory = ai!.contentStore;
      assert.equal(typeof factory, "function");
      if (typeof factory !== "function")
        throw new Error("Expected request-bound executor.");
      const executor = factory(
        new Request("http://localhost/api/v1/ai", { headers: missingCsrf }),
      );
      await assert.rejects(
        executor.create(
          scope,
          {
            type: "Note",
            path: `notes/${crypto.randomUUID()}`,
            locale: "en",
            format: "md",
            frontmatter: { title: "CSRF denied" },
            body: "text",
          },
          {
            expectedSchemaHash: schemaHash,
            attribution: {
              actorId: context.userId,
              origin: { channel: "studio_ai", credential: "session" },
            },
          },
        ),
        (error) => error instanceof RuntimeError && error.statusCode === 403,
      );
      const createdResponse = await context.handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "Note",
            path: `notes/${crypto.randomUUID()}`,
            locale: "en",
            format: "md",
            frontmatter: { title: "First" },
            body: "text",
          }),
        }),
      );
      assert.equal(
        createdResponse.status,
        200,
        await createdResponse.clone().text(),
      );
      const { data: created } = (await createdResponse.json()) as {
        data: ContentDocumentResponse;
      };
      const proposalId = crypto.randomUUID();
      const proposal = {
        proposalId,
        kind: "update_frontmatter",
        ...scope,
        documentId: created.documentId,
        baseDraftRevision: created.draftRevision,
        type: "Note",
        locale: "en",
        summary: "Update title",
        operations: [{ op: "update_frontmatter", patch: { title: "Updated" } }],
        validation: { status: "valid" },
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        provider: {
          providerId: "echo",
          model: "echo-1",
          promptTemplateId: "copy_improvement.v1",
        },
      } as const;
      ai!.proposalStore.insert({
        proposal: { ...proposal, operations: [...proposal.operations] },
        actorId: context.userId,
      });
      const response = await context.handler(
        new Request(
          `http://localhost/api/v1/ai/proposals/${proposalId}/apply`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              schemaHash,
              draftRevision: created.draftRevision,
              proposal,
            }),
          },
        ),
      );
      assert.equal(response.status, 200, await response.clone().text());
      const accepted = (await response.json()) as {
        data: { document: ContentDocumentResponse };
      };
      const stored = await createDatabaseContentStore({
        db: context.dbConnection.db,
      }).getById(scope, created.documentId, { draft: true });
      assert.equal(stored?.updatedBy, context.userId);
      assert.deepEqual(stored?.updatedOrigin, {
        channel: "studio_ai",
        credential: "session",
      });
      assert.equal(stored?.frontmatter.title, "Updated");
      const undo = (revision: number) =>
        context.handler(
          new Request(
            `http://localhost/api/v1/ai/proposals/${proposalId}/undo`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                proposal,
                documentId: created.documentId,
                schemaHash,
                postApplyDraftRevision: revision,
                priorDraft: {
                  body: "forged",
                  frontmatter: { title: "forged" },
                },
              }),
            },
          ),
        );
      assert.equal(
        (await undo(accepted.data.document.draftRevision + 1)).status,
        409,
      );
      const reverted = await undo(accepted.data.document.draftRevision);
      assert.equal(reverted.status, 200, await reverted.clone().text());
      const revertedDocument = (await reverted.json()) as {
        data: { document: ContentDocumentResponse };
      };
      assert.equal(revertedDocument.data.document.frontmatter.title, "First");
      assert.equal(revertedDocument.data.document.body, "text");
      assert.equal(
        (await undo(accepted.data.document.draftRevision)).status,
        409,
      );

      const invalidId = crypto.randomUUID();
      const invalid = {
        ...proposal,
        proposalId: invalidId,
        baseDraftRevision: revertedDocument.data.document.draftRevision,
        operations: [
          { op: "update_frontmatter" as const, patch: { title: 42 } },
        ],
      };
      ai!.proposalStore.insert({ proposal: invalid, actorId: context.userId });
      const invalidResponse = await context.handler(
        new Request(`http://localhost/api/v1/ai/proposals/${invalidId}/apply`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaHash,
            proposal: { ...invalid, validation: { status: "valid" } },
          }),
        }),
      );
      assert.equal(
        invalidResponse.status,
        422,
        await invalidResponse.clone().text(),
      );
      assert.equal(
        ((await invalidResponse.json()) as { code: string }).code,
        "AI_OUTPUT_INVALID",
      );
      assert.equal(ai!.proposalStore.peek(invalidId)?.status, "pending");

      const mdxId = crypto.randomUUID();
      const invalidMdx = {
        ...proposal,
        proposalId: mdxId,
        kind: "create_document" as const,
        documentId: undefined,
        baseDraftRevision: undefined,
        operations: [
          {
            op: "create_document" as const,
            path: `notes/${mdxId}`,
            format: "mdx" as const,
            frontmatter: { title: "Invalid" },
            body: "<Broken>",
          },
        ],
      };
      ai!.proposalStore.insert({
        proposal: invalidMdx,
        actorId: context.userId,
      });
      const mdxResponse = await context.handler(
        new Request(`http://localhost/api/v1/ai/proposals/${mdxId}/apply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ schemaHash, proposal: invalidMdx }),
        }),
      );
      assert.equal(mdxResponse.status, 422, await mdxResponse.clone().text());
      assert.equal(
        ((await mdxResponse.json()) as { code: string }).code,
        "AI_OUTPUT_INVALID",
      );
      const nextId = crypto.randomUUID();
      const next = {
        ...proposal,
        proposalId: nextId,
        baseDraftRevision: revertedDocument.data.document.draftRevision,
        operations: [...proposal.operations],
      };
      ai!.proposalStore.insert({ proposal: next, actorId: context.userId });
      const nextResponse = await context.handler(
        new Request(`http://localhost/api/v1/ai/proposals/${nextId}/apply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ schemaHash, proposal: next }),
        }),
      );
      assert.equal(nextResponse.status, 200, await nextResponse.clone().text());
      const nextDocument = (await nextResponse.json()) as {
        data: { document: ContentDocumentResponse };
      };
      const competing = await context.handler(
        new Request(`http://localhost/api/v1/content/${created.documentId}`, {
          method: "PUT",
          headers: { ...headers, "x-mdcms-schema-hash": schemaHash },
          body: JSON.stringify({
            body: "competing edit",
            draftRevision: nextDocument.data.document.draftRevision,
          }),
        }),
      );
      assert.equal(competing.status, 200);
      const staleUndo = await context.handler(
        new Request(`http://localhost/api/v1/ai/proposals/${nextId}/undo`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            schemaHash,
            proposal: next,
            documentId: created.documentId,
            postApplyDraftRevision: nextDocument.data.document.draftRevision,
          }),
        }),
      );
      assert.equal(staleUndo.status, 409, await staleUndo.clone().text());
      assert.equal(
        ((await staleUndo.json()) as { code: string }).code,
        "AI_PROPOSAL_CONFLICT",
      );
      assert.equal(
        (
          await createDatabaseContentStore({
            db: context.dbConnection.db,
          }).getById(scope, created.documentId, { draft: true })
        )?.body,
        "competing edit",
      );
    } finally {
      await context.dbConnection.close();
    }
  },
);
