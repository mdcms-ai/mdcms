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
  createCollaborationDocumentName,
  createCollaborationRuntime,
  createCollaborationRuntimeHooks,
  encodeYDocState,
  markdownToYDoc,
  yDocToFrontmatter,
  yDocToMarkdown,
  yjsUpdateToYDoc,
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
  updateError: unknown;
  readonly updates: Array<{
    scope: ContentScope;
    documentId: string;
    payload: {
      body?: string;
      frontmatter?: Record<string, unknown>;
      updatedBy?: string;
    };
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
    payload: {
      body?: string;
      frontmatter?: Record<string, unknown>;
      updatedBy?: string;
    },
    options?: { expectedDraftRevision?: number },
  ): Promise<ContentDocument> {
    this.updates.push({ scope, documentId, payload, options });

    if (this.updateError) {
      throw this.updateError;
    }

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
      frontmatter: payload.frontmatter ?? this.document.frontmatter,
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
  heartbeatActiveLockResult = true;
  finalizeInactiveRoomResult = true;
  clearInactiveCacheTtlError: unknown;
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

    if (this.clearInactiveCacheTtlError) {
      throw this.clearInactiveCacheTtlError;
    }
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
    return this.heartbeatActiveLockResult;
  }

  async releaseActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    this.calls.push({ method: "releaseActiveLock", documentId, leaseValue });
    return true;
  }

  async finalizeInactiveRoom(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    this.calls.push({ method: "finalizeInactiveRoom", documentId, leaseValue });
    return this.finalizeInactiveRoomResult;
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

class FakeHeartbeatScheduler {
  private nextHandle = 1;
  readonly intervals: Array<{
    callback: () => Promise<void> | void;
    handle: number;
    intervalMs: number;
    cleared: boolean;
  }> = [];

  set = (callback: () => Promise<void> | void, intervalMs: number): number => {
    const handle = this.nextHandle++;
    this.intervals.push({
      callback,
      handle,
      intervalMs,
      cleared: false,
    });
    return handle;
  };

  clear = (handle: unknown): void => {
    const interval = this.intervals.find((entry) => entry.handle === handle);

    if (interval) {
      interval.cleared = true;
    }
  };

  async tick(index = 0): Promise<void> {
    const interval = this.intervals[index];
    assert.ok(interval);
    await interval.callback();
  }
}

class FakeTimeoutScheduler {
  private nextHandle = 1;
  readonly timeouts: Array<{
    callback: () => void;
    cleared: boolean;
    handle: number;
    timeoutMs: number;
  }> = [];

  set = (callback: () => void, timeoutMs: number): number => {
    const handle = this.nextHandle++;
    this.timeouts.push({
      callback,
      cleared: false,
      handle,
      timeoutMs,
    });
    return handle;
  };

  clear = (handle: unknown): void => {
    const timeout = this.timeouts.find((entry) => entry.handle === handle);

    if (timeout) {
      timeout.cleared = true;
    }
  };

  fire(index = 0): void {
    const timeout = this.timeouts[index];
    assert.ok(timeout);
    timeout.callback();
  }
}

function createHarness(
  document: ContentDocument = createDocument(),
  options: {
    closeRoom?: (documentName: string) => void | Promise<void>;
    finalizedRoomLeaseTtlMs?: number;
    heartbeatScheduler?: FakeHeartbeatScheduler;
    timeoutScheduler?: FakeTimeoutScheduler;
  } = {},
) {
  const contentStore = new FakeContentStore(document);
  const redisStore = new FakeRedisStore();
  const authGuard = new FakeAuthGuard();
  const lifecycleEvents = new FakeLifecycleEvents();
  const heartbeatScheduler =
    options.heartbeatScheduler ?? new FakeHeartbeatScheduler();
  const timeoutScheduler =
    options.timeoutScheduler ?? new FakeTimeoutScheduler();
  const closedRooms: string[] = [];
  const hooks = createCollaborationRuntimeHooks({
    contentStore,
    redisStore,
    authGuard,
    lifecycleEvents,
    createRoomLeaseValue: () => "lease-1",
    setActiveLockHeartbeat: heartbeatScheduler.set,
    clearActiveLockHeartbeat: heartbeatScheduler.clear,
    finalizedRoomLeaseTtlMs: options.finalizedRoomLeaseTtlMs,
    setFinalizedRoomLeaseTimeout: timeoutScheduler.set,
    clearFinalizedRoomLeaseTimeout: timeoutScheduler.clear,
    closeRoom: async (documentName) => {
      closedRooms.push(documentName);
      await options.closeRoom?.(documentName);
    },
  });

  return {
    authGuard,
    closedRooms,
    contentStore,
    heartbeatScheduler,
    hooks,
    lifecycleEvents,
    redisStore,
    timeoutScheduler,
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
  assert.equal(typeof runtime.config.onChange, "function");
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

test("markdownToYDoc stores frontmatter in the collaboration Y.Doc", () => {
  const frontmatter = {
    title: "Launch",
    featured: true,
    order: 3,
  };

  const ydoc = markdownToYDoc("# Launch\n\nBody.", frontmatter);

  assert.deepEqual(yDocToFrontmatter(ydoc), frontmatter);
  assert.equal(yDocToMarkdown(ydoc), "# Launch\n\nBody.");
});

test("frontmatter Y.Doc helpers snapshot nested values", () => {
  const frontmatter = { seo: { title: "Original" } };
  const ydoc = markdownToYDoc("# Launch", frontmatter);

  (frontmatter.seo as { title: string }).title = "Mutated after write";
  const firstRead = yDocToFrontmatter(ydoc) as { seo: { title: string } };
  firstRead.seo.title = "Mutated after read";

  assert.deepEqual(yDocToFrontmatter(ydoc), { seo: { title: "Original" } });
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

test("onLoadDocument releases active lock when post-acquire setup fails", async () => {
  const { hooks, heartbeatScheduler, redisStore } = createHarness();
  const context = createContext();
  const setupError = new Error("ttl cleanup failed");
  redisStore.clearInactiveCacheTtlError = setupError;

  await assert.rejects(
    hooks.onLoadDocument({ context, documentName: DOCUMENT_ID }),
    setupError,
  );

  assert.equal(heartbeatScheduler.intervals.length, 0);
  assert.equal(context.roomLeaseValue, undefined);
  assert.deepEqual(
    redisStore.calls
      .filter((call) =>
        ["acquireActiveLock", "releaseActiveLock"].includes(call.method),
      )
      .map((call) => [call.method, call.leaseValue]),
    [
      ["acquireActiveLock", "lease-1"],
      ["releaseActiveLock", "lease-1"],
    ],
  );
});

test("onLoadDocument schedules active-lock heartbeat for idle loaded rooms", async () => {
  const { hooks, heartbeatScheduler, redisStore } = createHarness();
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });

  assert.equal(heartbeatScheduler.intervals.length, 1);
  assert.equal(heartbeatScheduler.intervals[0]?.intervalMs, 10_000);

  await heartbeatScheduler.tick();

  assert.deepEqual(
    redisStore.calls
      .filter((call) => call.method === "heartbeatActiveLock")
      .map((call) => [call.documentId, call.leaseValue]),
    [[DOCUMENT_ID, "lease-1"]],
  );

  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc("# Launch\n\nDraft body."),
    documentName: DOCUMENT_ID,
  });

  assert.equal(heartbeatScheduler.intervals[0]?.cleared, true);
});

test("active-lock heartbeat loss closes the room and rejects continued collaboration", async () => {
  const { hooks, heartbeatScheduler, redisStore, closedRooms } =
    createHarness();
  const context = createContext();
  redisStore.heartbeatActiveLockResult = false;

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await heartbeatScheduler.tick();

  assert.deepEqual(closedRooms, [DOCUMENT_ID]);
  await assert.rejects(
    hooks.beforeHandleMessage({
      context,
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );
});

test("onLoadDocument rejects documentName mismatches without mutating authenticated context", async () => {
  const otherDocumentId = "1e747170-3fb2-4386-93da-d7211e57c77dd";
  const document = createDocument({
    documentId: otherDocumentId,
    project: "other-project",
    environment: "preview",
  });
  const { hooks } = createHarness(document);
  const context = createContext();

  await assert.rejects(
    hooks.onLoadDocument({
      context,
      documentName: `other-project:preview:${otherDocumentId}`,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ROOM_MISMATCH",
  );
  assert.equal(context.project, "marketing");
  assert.equal(context.environment, "draft");
  assert.equal(context.documentId, DOCUMENT_ID);
});

test("onLoadDocument accepts encoded documentName route segments", async () => {
  const document = createDocument({
    project: "marketing:site",
    environment: "preview/draft",
  });
  const { hooks, redisStore } = createHarness(document);
  const context = createContext({
    project: document.project,
    environment: document.environment,
  });
  const documentName = createCollaborationDocumentName({
    project: document.project,
    environment: document.environment,
    documentId: document.documentId,
  });

  await hooks.onLoadDocument({
    context,
    documentName,
  });

  assert.equal(documentName, `marketing%3Asite:preview%2Fdraft:${DOCUMENT_ID}`);
  assert.equal(context.project, "marketing:site");
  assert.equal(context.environment, "preview/draft");
  assert.equal(redisStore.calls[0]?.documentId, DOCUMENT_ID);
});

test("onLoadDocument returns Redis cached binary when metadata matches", async () => {
  const document = createDocument({
    body: "# Cached draft",
    draftRevision: 12,
  });
  const { hooks, redisStore } = createHarness(document);
  const cached = encodeYDocState(markdownToYDoc(document.body));
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

test("onLoadDocument reconciles cached Yjs frontmatter with PostgreSQL draft", async () => {
  const document = createDocument({
    body: "# Cached draft",
    draftRevision: 12,
    frontmatter: { title: "Current" },
  });
  const { hooks, contentStore, redisStore } = createHarness(document);
  redisStore.state = encodeYDocState(markdownToYDoc(document.body, {}));
  redisStore.metadata = {
    draftRevision: 12,
    bodyHash: computeCollaborationBodyHash(document.body),
  };
  const context = createContext();

  const loaded = await hooks.onLoadDocument({
    context,
    documentName: DOCUMENT_ID,
  });
  const loadedDocument = yjsUpdateToYDoc(loaded);

  await hooks.onStoreDocument({
    document: loadedDocument,
    documentName: DOCUMENT_ID,
    lastContext: context,
  });

  assert.equal(contentStore.updates.length, 0);
  assert.deepEqual(yDocToFrontmatter(loadedDocument), { title: "Current" });
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
  assert.equal(context.lastWriter, undefined);
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

test("onStoreDocument writes Redis state without PostgreSQL update when unchanged", async () => {
  const document = createDocument({
    body: "# Stored\n\nSame body.",
    draftRevision: 4,
    frontmatter: { title: "Stored" },
  });
  const { hooks, contentStore, redisStore } = createHarness(document);
  const context = createContext();
  const ydoc = markdownToYDoc(document.body, document.frontmatter);

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });

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

test("onStoreDocument autosaves changed body and frontmatter to PostgreSQL", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 4,
    frontmatter: { title: "Original", featured: false },
  });
  const { hooks, contentStore, lifecycleEvents, redisStore } =
    createHarness(document);
  const context = createContext();
  const ydoc = markdownToYDoc("# Changed\n\nBody.", {
    title: "Changed",
    featured: true,
  });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: ydoc,
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-1",
      userEmail: "writer-1@example.com",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      loadedFrontmatterHash: context.loadedFrontmatterHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.updates[0]?.options?.expectedDraftRevision, 4);
  assert.equal(contentStore.updates[0]?.payload.updatedBy, "writer-1");
  assert.match(contentStore.updates[0]?.payload.body ?? "", /# Changed/);
  assert.deepEqual(contentStore.updates[0]?.payload.frontmatter, {
    title: "Changed",
    featured: true,
  });
  assert.equal(contentStore.document.draftRevision, 5);
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 5,
    bodyHash: computeCollaborationBodyHash(contentStore.document.body),
  });
  assert.equal(lifecycleEvents.events.length, 1);
  assert.equal(lifecycleEvents.events[0]?.event, "content.updated");
  assert.equal(lifecycleEvents.events[0]?.actor.id, "writer-1");
});

test("active autosave failure does not publish unsaved Yjs state to Redis", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 4,
    frontmatter: { title: "Original" },
  });
  const { hooks, contentStore, redisStore } = createHarness(document);
  const context = createContext();
  const changed = markdownToYDoc("# Changed\n\nBody.", { title: "Changed" });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  const cachedState = redisStore.state;
  const cachedMetadata = redisStore.metadata;
  assert.ok(cachedState);
  assert.ok(cachedMetadata);
  const updateError = new Error("database unavailable");
  contentStore.updateError = updateError;

  await assert.rejects(
    hooks.onStoreDocument({
      document: changed,
      documentName: DOCUMENT_ID,
      lastContext: createContext({
        userId: "writer-failed",
        loadedDraftRevision: context.loadedDraftRevision,
        loadedBodyHash: context.loadedBodyHash,
        loadedFrontmatterHash: context.loadedFrontmatterHash,
        roomLeaseValue: context.roomLeaseValue,
      }),
    }),
    updateError,
  );

  assert.deepEqual(redisStore.state, cachedState);
  assert.deepEqual(redisStore.metadata, cachedMetadata);
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    false,
  );
});

test("active autosave stale draft revision fails closed without overwriting PostgreSQL", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 3,
  });
  const { hooks, contentStore, redisStore, closedRooms } =
    createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  contentStore.document = {
    ...contentStore.document,
    body: "# External change",
    draftRevision: 4,
  };

  await assert.rejects(
    hooks.onStoreDocument({
      document: markdownToYDoc("# Collaboration change"),
      documentName: DOCUMENT_ID,
      lastContext: createContext({
        loadedDraftRevision: context.loadedDraftRevision,
        loadedBodyHash: context.loadedBodyHash,
        loadedFrontmatterHash: context.loadedFrontmatterHash,
        roomLeaseValue: context.roomLeaseValue,
      }),
    }),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "STALE_DRAFT_REVISION",
  );

  assert.equal(contentStore.document.body, "# External change");
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    false,
  );
  assert.deepEqual(closedRooms, [DOCUMENT_ID]);

  await assert.rejects(
    hooks.beforeHandleMessage({
      context,
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );
});

test("onStoreDocument fails closed before cache writes when active lock is lost", async () => {
  const document = createDocument({ body: "# Stored", draftRevision: 4 });
  const { hooks, redisStore } = createHarness(document);
  const context = createContext();
  const ydoc = markdownToYDoc("# Stored\n\nChanged in Yjs.");

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  const callsBeforeStore = redisStore.calls.length;
  redisStore.heartbeatActiveLockResult = false;

  await assert.rejects(
    hooks.onStoreDocument({
      document: ydoc,
      documentName: DOCUMENT_ID,
      lastContext: createContext({
        loadedDraftRevision: context.loadedDraftRevision,
        loadedBodyHash: context.loadedBodyHash,
        roomLeaseValue: context.roomLeaseValue,
      }),
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );

  assert.deepEqual(
    redisStore.calls.slice(callsBeforeStore).map((call) => call.method),
    ["heartbeatActiveLock"],
  );
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

test("finalized room lease entries expire for rooms that are never reopened", async () => {
  const document = createDocument({
    body: "# No-op\n\nSame body.",
    draftRevision: 5,
  });
  const { hooks, redisStore, timeoutScheduler } = createHarness(document, {
    finalizedRoomLeaseTtlMs: 25,
  });
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc(document.body),
    documentName: DOCUMENT_ID,
  });

  assert.equal(timeoutScheduler.timeouts.length, 1);
  assert.equal(timeoutScheduler.timeouts[0]?.timeoutMs, 25);

  const callsBeforeLateStore = redisStore.calls.length;
  redisStore.heartbeatActiveLockResult = false;

  await hooks.onStoreDocument({
    document: markdownToYDoc(document.body),
    documentName: DOCUMENT_ID,
    lastContext: context,
  });

  assert.deepEqual(redisStore.calls.slice(callsBeforeLateStore), []);

  timeoutScheduler.fire();

  await assert.rejects(
    hooks.onStoreDocument({
      document: markdownToYDoc(document.body),
      documentName: DOCUMENT_ID,
      lastContext: context,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );
});

test("last disconnect fails closed when final cleanup no longer owns active lock", async () => {
  const document = createDocument({
    body: "# No-op\n\nSame body.",
    draftRevision: 5,
  });
  const { hooks, redisStore, closedRooms } = createHarness(document);
  const context = createContext();
  redisStore.finalizeInactiveRoomResult = false;

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });

  await assert.rejects(
    hooks.onDisconnect({
      clientsCount: 0,
      context,
      document: markdownToYDoc(document.body),
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );
  assert.deepEqual(closedRooms, [DOCUMENT_ID]);
});

test("changed-body final disconnect verifies active-lock ownership before persistence", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 6,
  });
  const { hooks, contentStore, heartbeatScheduler, redisStore, closedRooms } =
    createHarness(document);
  const context = createContext();
  redisStore.heartbeatActiveLockResult = false;

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  const callsBeforeDisconnect = redisStore.calls.length;

  await assert.rejects(
    hooks.onDisconnect({
      clientsCount: 0,
      context,
      document: markdownToYDoc("# Changed\n\nBody."),
      documentName: DOCUMENT_ID,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );

  assert.equal(contentStore.updates.length, 0);
  assert.deepEqual(
    redisStore.calls.slice(callsBeforeDisconnect).map((call) => call.method),
    ["heartbeatActiveLock"],
  );
  assert.equal(heartbeatScheduler.intervals[0]?.cleared, true);
  assert.deepEqual(closedRooms, [DOCUMENT_ID]);
});

test("final-save error clears heartbeat without finalizing the room", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 7,
  });
  const { hooks, contentStore, heartbeatScheduler, redisStore } =
    createHarness(document);
  const context = createContext();
  const updateError = new Error("database unavailable");
  contentStore.updateError = updateError;

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });

  await assert.rejects(
    hooks.onDisconnect({
      clientsCount: 0,
      context,
      document: markdownToYDoc("# Changed\n\nBody."),
      documentName: DOCUMENT_ID,
    }),
    updateError,
  );

  assert.equal(heartbeatScheduler.intervals[0]?.cleared, true);
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    false,
  );

  const callsAfterError = redisStore.calls.length;

  await assert.rejects(
    hooks.onStoreDocument({
      document: markdownToYDoc("# Changed\n\nBody."),
      documentName: DOCUMENT_ID,
      lastContext: context,
    }),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_ACTIVE_LOCK_LOST",
  );
  assert.deepEqual(
    redisStore.calls.slice(callsAfterError).map((call) => call.method),
    [],
  );
});

test("last disconnect skips no-op PostgreSQL save when serialization normalizes source markdown", async () => {
  const document = createDocument({
    body: "# H\nBody",
    draftRevision: 6,
  });
  const { hooks, contentStore, lifecycleEvents, redisStore } =
    createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc(document.body),
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 0);
  assert.equal(lifecycleEvents.events.length, 0);
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    true,
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
      userEmail: "writer-2@example.com",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });
  await hooks.beforeHandleMessage({
    context: createContext({ userId: "reader-after-store" }),
    documentName: DOCUMENT_ID,
  });

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
  assert.equal(lifecycleEvents.events[0]?.actor.email, "writer-2@example.com");
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 9,
    bodyHash: computeCollaborationBodyHash(contentStore.document.body),
  });
});

test("last disconnect after active autosave does not increment draft revision again", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 8,
    frontmatter: { title: "Original" },
  });
  const { hooks, contentStore, lifecycleEvents } = createHarness(document);
  const context = createContext();
  const changed = markdownToYDoc("# Changed\n\nBody.", { title: "Changed" });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: changed,
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-2",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      loadedFrontmatterHash: context.loadedFrontmatterHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: changed,
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.document.draftRevision, 9);
  assert.equal(lifecycleEvents.events.length, 1);
});

test("last disconnect persists frontmatter-only changes when autosave has not run", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 9,
    frontmatter: { title: "Original" },
  });
  const { hooks, contentStore, lifecycleEvents } = createHarness(document);
  const context = createContext();
  const changed = markdownToYDoc(document.body, { title: "Changed" });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: changed,
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.updates[0]?.options?.expectedDraftRevision, 9);
  assert.deepEqual(contentStore.updates[0]?.payload.frontmatter, {
    title: "Changed",
  });
  assert.equal(contentStore.document.draftRevision, 10);
  assert.equal(lifecycleEvents.events.length, 1);
});

test("last disconnect attributes a pending debounced edit to its writer", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 10,
  });
  const { hooks, contentStore } = createHarness(document);
  const context = createContext();
  const pendingDocument = markdownToYDoc("# Pending\n\nBody.");

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onChange({
    context: createContext({ userId: "writer-pending" }),
    document: pendingDocument,
    documentName: DOCUMENT_ID,
    update: encodeYDocState(pendingDocument),
  });

  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: pendingDocument,
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.updates[0]?.payload.updatedBy, "writer-pending");
});

test("last disconnect uses neutral lifecycle email when writer email is unavailable", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 11,
  });
  const { hooks, lifecycleEvents } = createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: markdownToYDoc("# Changed\n\nWithout email."),
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-without-email",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });

  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: markdownToYDoc("# Changed\n\nWithout email."),
    documentName: DOCUMENT_ID,
  });

  assert.equal(lifecycleEvents.events[0]?.actor.id, "writer-without-email");
  assert.equal(lifecycleEvents.events[0]?.actor.email, "");
});

test("late debounced store after finalization does not rewrite Redis state or metadata", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 12,
  });
  const { hooks, redisStore } = createHarness(document);
  const context = createContext();
  const writerContext = createContext({ userId: "late-store-writer" });
  const changedDocument = markdownToYDoc("# Late\n\nStore.");

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onChange({
    context: writerContext,
    document: changedDocument,
    documentName: DOCUMENT_ID,
    update: encodeYDocState(changedDocument),
  });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: changedDocument,
    documentName: DOCUMENT_ID,
  });

  const callsAfterFinalization = redisStore.calls.length;

  await hooks.onStoreDocument({
    document: changedDocument,
    documentName: DOCUMENT_ID,
    lastContext: writerContext,
  });

  assert.deepEqual(
    redisStore.calls.slice(callsAfterFinalization).map((call) => call.method),
    [],
  );
});

test("stale draft revision failure does not overwrite or release active lock", async () => {
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
    false,
  );
});
