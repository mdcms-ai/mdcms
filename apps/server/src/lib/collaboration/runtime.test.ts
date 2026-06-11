import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import type { CollaborationSessionContext } from "../collaboration-auth.js";
import type {
  ContentDocument,
  ContentLifecycleEventSink,
  ContentScope,
} from "../content-api/types.js";

import { createUnavailableCollaborationRedisDependency } from "./redis-store.js";
import {
  computeCollaborationBodyHash,
  createCollaborationRuntime,
  createCollaborationRuntimeHooks,
  markdownToYDoc,
  yDocToMarkdown,
  type CollaborationRuntimeAuthGuard,
  type CollaborationRuntimeContentStore,
  type CollaborationRuntimeContext,
  type CollaborationRuntimeRedisStore,
} from "./runtime.js";

const DOCUMENT_ID = "5ad76d8b-4de0-48e7-9370-8f5d2df3b1d1";

function createDocument(
  overrides: Partial<ContentDocument> = {},
): ContentDocument {
  return {
    documentId: overrides.documentId ?? DOCUMENT_ID,
    translationGroupId:
      overrides.translationGroupId ?? "8a253d61-8691-4566-aa4d-821b82242b69",
    project: overrides.project ?? "marketing",
    environment: overrides.environment ?? "draft",
    path: overrides.path ?? "docs/launch",
    type: overrides.type ?? "Page",
    locale: overrides.locale ?? "__mdcms_default__",
    format: overrides.format ?? "mdx",
    isDeleted: overrides.isDeleted ?? false,
    hasUnpublishedChanges: overrides.hasUnpublishedChanges ?? true,
    version: overrides.version ?? 0,
    publishedVersion: overrides.publishedVersion ?? null,
    draftRevision: overrides.draftRevision ?? 3,
    frontmatter: overrides.frontmatter ?? {},
    body: overrides.body ?? "# Launch\n\nDraft body.",
    createdBy: overrides.createdBy ?? "user-created",
    createdAt: overrides.createdAt ?? "2026-06-11T10:00:00.000Z",
    updatedBy: overrides.updatedBy ?? "user-updated",
    updatedAt: overrides.updatedAt ?? "2026-06-11T10:00:00.000Z",
  };
}

function createContext(
  overrides: Partial<CollaborationRuntimeContext> = {},
): CollaborationRuntimeContext {
  return {
    userId: overrides.userId ?? "user-reader",
    sessionId: overrides.sessionId ?? "session-1",
    project: overrides.project ?? "marketing",
    environment: overrides.environment ?? "draft",
    documentId: overrides.documentId ?? DOCUMENT_ID,
    documentPath: overrides.documentPath ?? "docs/launch",
    role: overrides.role ?? "editor",
    ...overrides,
  };
}

class FakeContentStore implements CollaborationRuntimeContentStore {
  document: ContentDocument;
  readonly updates: Array<{
    scope: ContentScope;
    documentId: string;
    payload: { body?: string; updatedBy?: string };
    options?: { expectedDraftRevision?: number };
  }> = [];

  constructor(document: ContentDocument = createDocument()) {
    this.document = document;
  }

  async getById(
    scope: ContentScope,
    documentId: string,
    options?: { draft?: boolean },
  ): Promise<ContentDocument | undefined> {
    assert.deepEqual(scope, {
      project: this.document.project,
      environment: this.document.environment,
    });
    assert.equal(documentId, this.document.documentId);
    assert.equal(options?.draft, true);
    return this.document;
  }

  async update(
    scope: ContentScope,
    documentId: string,
    payload: { body?: string; updatedBy?: string },
    options?: { expectedDraftRevision?: number },
  ): Promise<ContentDocument> {
    this.updates.push({ scope, documentId, payload, options });

    if (
      options?.expectedDraftRevision !== undefined &&
      options.expectedDraftRevision !== this.document.draftRevision
    ) {
      throw new RuntimeError({
        code: "STALE_DRAFT_REVISION",
        message: "Draft has been modified since the room loaded.",
        statusCode: 409,
        details: {
          documentId,
          expectedDraftRevision: options.expectedDraftRevision,
          currentDraftRevision: this.document.draftRevision,
        },
      });
    }

    this.document = {
      ...this.document,
      body: payload.body ?? this.document.body,
      draftRevision: this.document.draftRevision + 1,
      updatedBy: payload.updatedBy ?? this.document.updatedBy,
      updatedAt: "2026-06-11T10:01:00.000Z",
    };

    return this.document;
  }
}

class FakeRedisStore implements CollaborationRuntimeRedisStore {
  state: Uint8Array | null = null;
  metadata: { draftRevision: number; bodyHash: string } | null = null;
  acquireActiveLockResult = true;
  readonly calls: Array<{
    method: string;
    documentId: string;
    leaseValue?: string;
    state?: Uint8Array;
    metadata?: { draftRevision: number; bodyHash: string };
    draftHead?: { draftRevision: number; bodyHash: string };
  }> = [];

  async getFreshYjsState(
    documentId: string,
    draftHead: { draftRevision: number; bodyHash: string },
  ) {
    this.calls.push({ method: "getFreshYjsState", documentId, draftHead });

    if (
      this.state &&
      this.metadata?.draftRevision === draftHead.draftRevision &&
      this.metadata.bodyHash === draftHead.bodyHash
    ) {
      return {
        state: this.state,
        metadata: this.metadata,
      };
    }

    return null;
  }

  async setYjsState(documentId: string, state: Uint8Array): Promise<void> {
    this.calls.push({ method: "setYjsState", documentId, state });
    this.state = new Uint8Array(state);
  }

  async setYjsMetadata(
    documentId: string,
    metadata: { draftRevision: number; bodyHash: string },
  ): Promise<void> {
    this.calls.push({ method: "setYjsMetadata", documentId, metadata });
    this.metadata = metadata;
  }

  async clearInactiveCacheTtl(documentId: string): Promise<void> {
    this.calls.push({ method: "clearInactiveCacheTtl", documentId });
  }

  async acquireActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    this.calls.push({ method: "acquireActiveLock", documentId, leaseValue });
    return this.acquireActiveLockResult;
  }

  async heartbeatActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    this.calls.push({ method: "heartbeatActiveLock", documentId, leaseValue });
    return true;
  }

  async finalizeInactiveRoom(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    this.calls.push({ method: "finalizeInactiveRoom", documentId, leaseValue });
    return true;
  }
}

class FakeAuthGuard implements CollaborationRuntimeAuthGuard {
  nextResult: { ok: true } | { ok: false; closeCode: 4401 | 4403 } = {
    ok: true,
  };
  readonly calls: Array<{
    request: Request;
    context: CollaborationSessionContext;
  }> = [];

  async revalidateWrite(
    request: Request,
    context: CollaborationSessionContext,
  ): Promise<{ ok: true } | { ok: false; closeCode: 4401 | 4403 }> {
    this.calls.push({ request, context });
    return this.nextResult;
  }
}

class FakeLifecycleEvents implements ContentLifecycleEventSink {
  readonly events: Parameters<
    ContentLifecycleEventSink["emitContentEvent"]
  >[0][] = [];

  async emitContentEvent(
    input: Parameters<ContentLifecycleEventSink["emitContentEvent"]>[0],
  ): Promise<void> {
    this.events.push(input);
  }
}

function createHarness(document: ContentDocument = createDocument()) {
  const contentStore = new FakeContentStore(document);
  const redisStore = new FakeRedisStore();
  const authGuard = new FakeAuthGuard();
  const lifecycleEvents = new FakeLifecycleEvents();
  const hooks = createCollaborationRuntimeHooks({
    contentStore,
    redisStore,
    authGuard,
    lifecycleEvents,
    createRoomLeaseValue: () => "lease-1",
  });

  return {
    authGuard,
    contentStore,
    hooks,
    lifecycleEvents,
    redisStore,
  };
}

test("createCollaborationRuntime returns explicit Hocuspocus debounce config", () => {
  const { contentStore, redisStore, authGuard } = createHarness();
  const runtime = createCollaborationRuntime({
    contentStore,
    redisStore,
    authGuard,
    createRoomLeaseValue: () => "lease-1",
  });

  assert.equal(runtime.config.debounce, 2000);
  assert.equal(runtime.config.maxDebounce, 10000);
  assert.equal(typeof runtime.config.onLoadDocument, "function");
  assert.ok(runtime.server);
});

test("createCollaborationRuntime fails with collaboration unavailable when Redis is unavailable", () => {
  const { contentStore, authGuard } = createHarness();

  assert.throws(
    () =>
      createCollaborationRuntime({
        contentStore,
        authGuard,
        redisDependency:
          createUnavailableCollaborationRedisDependency("missing_redis_url"),
      }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_UNAVAILABLE",
  );
});

test("onLoadDocument falls back to PostgreSQL and seeds Redis when cache is missing", async () => {
  const document = createDocument({
    body: "# Fresh draft\n\nSeed this body.",
    draftRevision: 7,
  });
  const { hooks, redisStore } = createHarness(document);
  const context = createContext();

  const loaded = await hooks.onLoadDocument({
    context,
    documentName: DOCUMENT_ID,
  });

  assert.ok(loaded instanceof Uint8Array);
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 7,
    bodyHash: computeCollaborationBodyHash(document.body),
  });
  assert.equal(
    yDocToMarkdown(markdownToYDoc(document.body)).trim().length > 0,
    true,
  );
  assert.deepEqual(
    redisStore.calls.map((call) => call.method),
    [
      "getFreshYjsState",
      "acquireActiveLock",
      "setYjsState",
      "setYjsMetadata",
      "clearInactiveCacheTtl",
    ],
  );
  assert.equal(context.loadedDraftRevision, 7);
  assert.equal(
    context.loadedBodyHash,
    computeCollaborationBodyHash(document.body),
  );
  assert.equal(context.roomLeaseValue, "lease-1");
});

test("onLoadDocument returns Redis cached binary when metadata matches", async () => {
  const document = createDocument({
    body: "# Cached draft",
    draftRevision: 12,
  });
  const { hooks, redisStore } = createHarness(document);
  const cached = new Uint8Array([1, 2, 3, 4]);
  redisStore.state = cached;
  redisStore.metadata = {
    draftRevision: 12,
    bodyHash: computeCollaborationBodyHash(document.body),
  };

  const loaded = await hooks.onLoadDocument({
    context: createContext(),
    documentName: DOCUMENT_ID,
  });

  assert.deepEqual(loaded, cached);
  assert.deepEqual(
    redisStore.calls.map((call) => call.method),
    ["getFreshYjsState", "acquireActiveLock", "clearInactiveCacheTtl"],
  );
});

test("onLoadDocument active lock conflict does not overwrite Redis cache", async () => {
  const { hooks, redisStore } = createHarness(
    createDocument({ body: "# Conflicting draft", draftRevision: 6 }),
  );
  redisStore.acquireActiveLockResult = false;

  await assert.rejects(
    hooks.onLoadDocument({
      context: createContext(),
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "DOCUMENT_COLLABORATION_ACTIVE",
  );
  assert.equal(redisStore.state, null);
  assert.equal(redisStore.metadata, null);
  assert.deepEqual(
    redisStore.calls.map((call) => call.method),
    ["getFreshYjsState", "acquireActiveLock"],
  );
});

test("onLoadDocument parse failure surfaces and does not mark the room active", async () => {
  const { contentStore, redisStore, authGuard } = createHarness(
    createDocument({ body: "<Broken" }),
  );
  const parseError = new Error("parse failed");
  const hooks = createCollaborationRuntimeHooks({
    contentStore,
    redisStore,
    authGuard,
    createRoomLeaseValue: () => "lease-1",
    convertMarkdownToYjsUpdate: () => {
      throw parseError;
    },
  });

  await assert.rejects(
    hooks.onLoadDocument({
      context: createContext(),
      documentName: DOCUMENT_ID,
    }),
    parseError,
  );
  assert.equal(
    redisStore.calls.some((call) => call.method === "acquireActiveLock"),
    false,
  );
});

test("beforeHandleMessage allows valid write revalidation", async () => {
  const { hooks, authGuard } = createHarness();
  const context = createContext();
  const request = new Request("http://server/api/v1/collaboration");

  await hooks.beforeHandleMessage({
    context,
    request,
    documentName: DOCUMENT_ID,
  });

  assert.equal(authGuard.calls.length, 1);
  assert.equal(context.lastWriter?.userId, context.userId);
});

test("beforeHandleMessage rejects revoked sessions and lost write permission with close codes", async () => {
  for (const closeCode of [4401, 4403] as const) {
    const { hooks, authGuard } = createHarness();
    authGuard.nextResult = { ok: false, closeCode };

    await assert.rejects(
      hooks.beforeHandleMessage({
        context: createContext(),
        request: new Request("http://server/api/v1/collaboration"),
        documentName: DOCUMENT_ID,
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: number }).code === closeCode,
    );
  }
});

test("onStoreDocument writes Redis state and metadata only", async () => {
  const document = createDocument({ body: "# Stored", draftRevision: 4 });
  const { hooks, contentStore, redisStore } = createHarness(document);
  const context = createContext({
    loadedDraftRevision: 4,
    loadedBodyHash: computeCollaborationBodyHash(document.body),
    roomLeaseValue: "lease-1",
  });
  const ydoc = markdownToYDoc("# Stored\n\nChanged in Yjs.");

  await hooks.onStoreDocument({
    document: ydoc,
    documentName: DOCUMENT_ID,
    lastContext: createContext({ ...context, userId: "writer-1" }),
  });

  assert.equal(contentStore.updates.length, 0);
  assert.ok(redisStore.state);
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 4,
    bodyHash: computeCollaborationBodyHash(document.body),
  });
  assert.equal(contentStore.document.body, document.body);
});

test("onDisconnect with clients still connected does not final-save", async () => {
  const { hooks, contentStore, redisStore } = createHarness();

  await hooks.onDisconnect({
    clientsCount: 1,
    context: createContext({
      loadedDraftRevision: 3,
      loadedBodyHash: computeCollaborationBodyHash(contentStore.document.body),
      roomLeaseValue: "lease-1",
    }),
    document: markdownToYDoc("# Changed"),
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 0);
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    false,
  );
});

test("last disconnect skips no-op PostgreSQL save but finalizes TTL and lock", async () => {
  const document = createDocument({
    body: "# No-op\n\nSame body.",
    draftRevision: 5,
  });
  const { hooks, contentStore, redisStore } = createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc(document.body),
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 0);
  assert.deepEqual(
    redisStore.calls
      .filter((call) =>
        ["setYjsState", "setYjsMetadata", "finalizeInactiveRoom"].includes(
          call.method,
        ),
      )
      .map((call) => [call.method, call.leaseValue]),
    [
      ["setYjsState", undefined],
      ["setYjsMetadata", undefined],
      ["setYjsState", undefined],
      ["setYjsMetadata", undefined],
      ["finalizeInactiveRoom", "lease-1"],
    ],
  );
});

test("last disconnect changed body saves once with expected revision, last writer, and lifecycle event", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 8,
  });
  const { hooks, contentStore, lifecycleEvents, redisStore } =
    createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: markdownToYDoc("# Changed\n\nBody."),
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-2",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });
  context.lastWriter = { userId: "writer-2" };

  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc("# Changed\n\nBody."),
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.updates[0]?.options?.expectedDraftRevision, 8);
  assert.equal(contentStore.updates[0]?.payload.updatedBy, "writer-2");
  assert.match(contentStore.updates[0]?.payload.body ?? "", /# Changed/);
  assert.equal(lifecycleEvents.events.length, 1);
  assert.equal(lifecycleEvents.events[0]?.event, "content.updated");
  assert.equal(lifecycleEvents.events[0]?.actor.id, "writer-2");
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 9,
    bodyHash: computeCollaborationBodyHash(contentStore.document.body),
  });
});

test("stale draft revision failure does not overwrite and still finalizes room cleanup", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 3,
  });
  const { hooks, contentStore, redisStore } = createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  contentStore.document = {
    ...contentStore.document,
    body: "# External change",
    draftRevision: 4,
  };

  await assert.rejects(
    hooks.onDisconnect({
      clientsCount: 0,
      context,
      document: markdownToYDoc("# Collaboration change"),
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "STALE_DRAFT_REVISION",
  );

  assert.equal(contentStore.document.body, "# External change");
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    true,
  );
});
