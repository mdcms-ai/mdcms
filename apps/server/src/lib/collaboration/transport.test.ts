import assert from "node:assert/strict";
import { test } from "bun:test";
import type { WebSocketLike } from "@hocuspocus/server";
import type { CollaborationPresenceUser } from "@mdcms/shared";

import type {
  CollaborationPresenceContext,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import {
  createCollaborationWebSocketTransport,
  isCollaborationWebSocketUpgradeRequest,
  type CollaborationAuthHandshakeGuard,
} from "./transport.js";
import type { CollaborationRuntimeContext } from "./runtime.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function createContext(
  overrides: Partial<CollaborationSessionContext> = {},
): CollaborationSessionContext {
  return {
    userId: "user-1",
    sessionId: "session-1",
    project: "marketing",
    environment: "staging",
    documentId: DOCUMENT_ID,
    documentPath: "blog/post-1",
    role: "editor",
    ...overrides,
  };
}

function createPresenceContext(
  overrides: Partial<CollaborationPresenceContext> = {},
): CollaborationPresenceContext {
  return {
    userId: "user-1",
    sessionId: "session-1",
    project: "marketing",
    environment: "staging",
    role: "editor",
    label: "Ada",
    color: "#2563eb",
    ...overrides,
  };
}

function createUpgradeRequest(headers: HeadersInit = {}): Request {
  return new Request(
    `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
    {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        origin: "http://localhost:4173",
        ...headers,
      },
    },
  );
}

function createPresenceUpgradeRequest(
  overrides: {
    sessionId?: string;
    userId?: string;
    headers?: HeadersInit;
  } = {},
): Request {
  const url = new URL("http://localhost/api/v1/collaboration/presence");
  url.searchParams.set("project", "marketing");
  url.searchParams.set("environment", "staging");

  if (overrides.sessionId) {
    url.searchParams.set("sessionId", overrides.sessionId);
  }

  if (overrides.userId) {
    url.searchParams.set("userId", overrides.userId);
  }

  return new Request(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      origin: "http://localhost:4173",
      ...overrides.headers,
    },
  });
}

function createAuthGuard(
  result:
    | { ok: true; context: CollaborationSessionContext }
    | { ok: false; closeCode: 4401 | 4403; message: string },
): CollaborationAuthHandshakeGuard {
  return {
    async authorizeHandshake() {
      return result;
    },
    async authorizePresenceHandshake() {
      return { ok: true, context: createPresenceContext() };
    },
    async authorizePresenceUpdate() {
      return { ok: true };
    },
    async filterPresenceSnapshot(_request, _context, users) {
      return users;
    },
  };
}

function createPresenceAuthGuard(overrides: {
  authorizePresenceHandshake?: CollaborationAuthHandshakeGuard["authorizePresenceHandshake"];
  authorizePresenceUpdate?: CollaborationAuthHandshakeGuard["authorizePresenceUpdate"];
  filterPresenceSnapshot?: CollaborationAuthHandshakeGuard["filterPresenceSnapshot"];
}): CollaborationAuthHandshakeGuard {
  return {
    async authorizeHandshake() {
      return { ok: true, context: createContext() };
    },
    authorizePresenceHandshake:
      overrides.authorizePresenceHandshake ??
      (async (request) => {
        const url = new URL(request.url);
        const sessionId = url.searchParams.get("sessionId") ?? "session-1";
        const userId = url.searchParams.get("userId") ?? sessionId;

        return {
          ok: true,
          context: createPresenceContext({
            userId,
            sessionId,
            label: userId,
          }),
        };
      }),
    authorizePresenceUpdate:
      overrides.authorizePresenceUpdate ?? (async () => ({ ok: true })),
    filterPresenceSnapshot:
      overrides.filterPresenceSnapshot ??
      (async (_request, _context, users) => users),
  };
}

function createPresenceStore(initialUsers: CollaborationPresenceUser[] = []) {
  type PresenceRecord = CollaborationPresenceUser & {
    project: string;
    environment: string;
  };
  const records = new Map<string, PresenceRecord>();
  const setCalls: PresenceRecord[] = [];
  const deleteCalls: Array<{
    project: string;
    environment: string;
    sessionId: string;
  }> = [];

  for (const user of initialUsers) {
    records.set(`${user.sessionId}`, {
      ...user,
      project: "marketing",
      environment: "staging",
    });
  }

  return {
    records,
    setCalls,
    deleteCalls,
    async setPresence(record: PresenceRecord) {
      setCalls.push(record);
      records.set(record.sessionId, record);
    },
    async deletePresence(input: {
      project: string;
      environment: string;
      sessionId: string;
    }) {
      deleteCalls.push(input);
      records.delete(input.sessionId);
    },
    async listPresence(input: {
      project: string;
      environment: string;
    }): Promise<CollaborationPresenceUser[]> {
      return Array.from(records.values())
        .filter(
          (record) =>
            record.project === input.project &&
            record.environment === input.environment,
        )
        .map(
          ({ project: _project, environment: _environment, ...user }) => user,
        );
    },
  };
}

function createBunServerStub() {
  const calls: Array<{ request: Request; options: any }> = [];

  return {
    calls,
    server: {
      upgrade(request: Request, options: any) {
        calls.push({ request, options });
        return true;
      },
    },
  };
}

function createBunSocketStub(data: Record<string, unknown>) {
  const events: string[] = [];
  const sent: unknown[] = [];

  return {
    events,
    sent,
    socket: {
      data,
      remoteAddress: "127.0.0.1",
      send(payload: unknown) {
        sent.push(payload);
        events.push(`send:${payload instanceof Uint8Array ? "bytes" : "text"}`);
        return 1;
      },
      publish() {
        return 1;
      },
      subscribe(topic: string) {
        events.push(`subscribe:${topic}`);
      },
      unsubscribe(topic: string) {
        events.push(`unsubscribe:${topic}`);
      },
      close(code?: number, reason?: string) {
        events.push(`close:${code ?? ""}:${reason ?? ""}`);
      },
      terminate() {
        events.push("terminate");
      },
    },
  };
}

function parseSnapshotMessages(sent: unknown[]) {
  return sent
    .filter((payload): payload is string => typeof payload === "string")
    .map((payload) => JSON.parse(payload) as unknown)
    .filter(
      (
        payload,
      ): payload is {
        type: "presence.snapshot";
        project: string;
        environment: string;
        users: CollaborationPresenceUser[];
      } =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === "presence.snapshot",
    );
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(message);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("collaboration transport detects only websocket upgrades for the collaboration endpoint", () => {
  assert.equal(
    isCollaborationWebSocketUpgradeRequest(createUpgradeRequest()),
    true,
  );
  assert.equal(
    isCollaborationWebSocketUpgradeRequest(
      new Request("http://localhost/api/v1/collaboration", {
        headers: { upgrade: "websocket" },
      }),
    ),
    true,
  );
  assert.equal(
    isCollaborationWebSocketUpgradeRequest(createPresenceUpgradeRequest()),
    true,
  );
  assert.equal(
    isCollaborationWebSocketUpgradeRequest(
      new Request("http://localhost/api/v1/content", {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      }),
    ),
    false,
  );
});

test("collaboration transport returns 503 before upgrade when runtime is unavailable", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createAuthGuard({ ok: true, context: createContext() }),
    unavailableDetails: { reason: "missing_redis_url" },
  });

  const response = await transport.handleFetchUpgrade(
    createUpgradeRequest(),
    server as never,
  );
  const body = (await response?.json()) as { code: string; details?: unknown };

  assert.equal(response?.status, 503);
  assert.equal(body.code, "COLLABORATION_UNAVAILABLE");
  assert.deepEqual(calls, []);
});

test("presence transport returns 503 before upgrade when presence storage is unavailable", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    runtime: {
      server: {
        handleConnection() {
          throw new Error("presence should not start hocuspocus connection");
        },
      },
    },
    unavailableDetails: { reason: "missing_redis_url" },
  });

  const response = await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest(),
    server as never,
  );
  const body = (await response?.json()) as { code: string; details?: unknown };

  assert.equal(response?.status, 503);
  assert.equal(body.code, "COLLABORATION_UNAVAILABLE");
  assert.deepEqual(calls, []);
});

test("collaboration transport falls through for non-collaboration requests", async () => {
  const { calls, server } = createBunServerStub();
  let authorized = false;
  const transport = createCollaborationWebSocketTransport({
    authGuard: {
      async authorizeHandshake() {
        authorized = true;
        return { ok: true, context: createContext() };
      },
      async authorizePresenceHandshake() {
        throw new Error("should not authorize presence request");
      },
      async authorizePresenceUpdate() {
        throw new Error("should not authorize presence update");
      },
      async filterPresenceSnapshot() {
        throw new Error("should not filter presence snapshot");
      },
    },
    runtime: {
      server: {
        handleConnection() {
          throw new Error("should not start hocuspocus connection");
        },
      },
    },
  });

  const response = await transport.handleFetchUpgrade(
    new Request("http://localhost/api/v1/content", {
      headers: { connection: "Upgrade", upgrade: "websocket" },
    }),
    server as never,
  );

  assert.equal(response, undefined);
  assert.equal(authorized, false);
  assert.deepEqual(calls, []);
});

test("presence transport maps handshake failures to collaboration HTTP errors", async () => {
  const { calls: unauthorizedCalls, server: unauthorizedServer } =
    createBunServerStub();
  const unauthorizedTransport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      authorizePresenceHandshake: async () => ({
        ok: false,
        closeCode: 4401,
        message: "No session",
      }),
    }),
    presenceStore: createPresenceStore(),
  });

  const unauthorizedResponse = await unauthorizedTransport.handleFetchUpgrade(
    createPresenceUpgradeRequest(),
    unauthorizedServer as never,
  );
  const unauthorizedBody = (await unauthorizedResponse?.json()) as {
    code: string;
    details?: { closeCode?: number };
  };

  assert.equal(unauthorizedResponse?.status, 401);
  assert.equal(unauthorizedBody.code, "UNAUTHORIZED");
  assert.equal(unauthorizedBody.details?.closeCode, 4401);
  assert.deepEqual(unauthorizedCalls, []);

  const { calls: forbiddenCalls, server: forbiddenServer } =
    createBunServerStub();
  const forbiddenTransport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      authorizePresenceHandshake: async () => ({
        ok: false,
        closeCode: 4403,
        message: "Forbidden",
      }),
    }),
    presenceStore: createPresenceStore(),
  });

  const forbiddenResponse = await forbiddenTransport.handleFetchUpgrade(
    createPresenceUpgradeRequest(),
    forbiddenServer as never,
  );
  const forbiddenBody = (await forbiddenResponse?.json()) as {
    code: string;
    details?: { closeCode?: number };
  };

  assert.equal(forbiddenResponse?.status, 403);
  assert.equal(forbiddenBody.code, "COLLABORATION_FORBIDDEN");
  assert.equal(forbiddenBody.details?.closeCode, 4403);
  assert.deepEqual(forbiddenCalls, []);
});

test("collaboration transport maps unauthorized handshakes to 401 with close details", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createAuthGuard({
      ok: false,
      closeCode: 4401,
      message: "No session",
    }),
    runtime: {
      server: {
        handleConnection() {
          throw new Error("should not start hocuspocus connection");
        },
      },
    },
  });

  const response = await transport.handleFetchUpgrade(
    createUpgradeRequest(),
    server as never,
  );
  const body = (await response?.json()) as {
    code: string;
    details?: { closeCode?: number };
  };

  assert.equal(response?.status, 401);
  assert.equal(body.code, "UNAUTHORIZED");
  assert.equal(body.details?.closeCode, 4401);
  assert.deepEqual(calls, []);
});

test("collaboration transport maps forbidden handshakes to 403 with close details", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createAuthGuard({
      ok: false,
      closeCode: 4403,
      message: "Forbidden",
    }),
    runtime: {
      server: {
        handleConnection() {
          throw new Error("should not start hocuspocus connection");
        },
      },
    },
  });

  const response = await transport.handleFetchUpgrade(
    createUpgradeRequest(),
    server as never,
  );
  const body = (await response?.json()) as {
    code: string;
    details?: { closeCode?: number };
  };

  assert.equal(response?.status, 403);
  assert.equal(body.code, "COLLABORATION_FORBIDDEN");
  assert.equal(body.details?.closeCode, 4403);
  assert.deepEqual(calls, []);
});

test("collaboration transport upgrades and delegates open, message, and close to Hocuspocus", async () => {
  const context = createContext({ userId: "editor-1" });
  const { calls, server } = createBunServerStub();
  const delegated: string[] = [];
  const transport = createCollaborationWebSocketTransport({
    authGuard: createAuthGuard({ ok: true, context }),
    runtime: {
      server: {
        handleConnection(
          websocket: WebSocketLike,
          request: Request,
          defaultContext: CollaborationRuntimeContext,
        ) {
          delegated.push(`open:${defaultContext.userId}:${request.url}`);
          assert.equal(typeof websocket.send, "function");
          assert.equal(typeof websocket.close, "function");
          assert.equal(defaultContext.documentId, DOCUMENT_ID);

          return {
            handleMessage(message: Uint8Array) {
              delegated.push(`message:${Array.from(message).join(",")}`);
            },
            handleClose(event?: { code?: number; reason?: string }) {
              delegated.push(`close:${event?.code}:${event?.reason}`);
            },
          };
        },
      },
    },
  });

  const response = await transport.handleFetchUpgrade(
    createUpgradeRequest(),
    server as never,
  );

  assert.equal(response, undefined);
  assert.equal(calls.length, 1);

  const { socket } = createBunSocketStub(calls[0]!.options.data);

  transport.websocket.open(socket as never);
  transport.websocket.message(socket as never, new Uint8Array([1, 2, 3]));
  transport.websocket.close(socket as never, 1000, "done");

  assert.deepEqual(delegated, [
    `open:editor-1:${calls[0]!.request.url}`,
    "message:1,2,3",
    "close:1000:done",
  ]);
});

test("presence transport stores online record and sends initial filtered snapshot on open", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  const response = await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );

  assert.equal(response, undefined);
  assert.equal(calls.length, 1);

  const { socket, sent } = createBunSocketStub(calls[0]!.options.data);

  transport.websocket.open(socket as never);

  await waitFor(
    () => parseSnapshotMessages(sent).length === 1,
    "Timed out waiting for initial presence snapshot.",
  );

  assert.deepEqual(presenceStore.setCalls, [
    {
      project: "marketing",
      environment: "staging",
      userId: "ada",
      sessionId: "session-1",
      label: "ada",
      color: "#2563eb",
      documentId: null,
      mode: "view",
      updatedAt: "2026-06-14T10:00:00.000Z",
    },
  ]);
  assert.deepEqual(parseSnapshotMessages(sent), [
    {
      type: "presence.snapshot",
      project: "marketing",
      environment: "staging",
      users: [
        {
          userId: "ada",
          sessionId: "session-1",
          label: "ada",
          color: "#2563eb",
          documentId: null,
          mode: "view",
          updatedAt: "2026-06-14T10:00:00.000Z",
        },
      ],
    },
  ]);
});

test("presence transport rolls back peer lifecycle when open storage fails", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore: {
      ...presenceStore,
      async setPresence() {
        throw new Error("redis unavailable");
      },
    },
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );

  const peer = createBunSocketStub(calls[0]!.options.data);

  transport.websocket.open(peer.socket as never);

  await waitFor(
    () =>
      peer.events.some(
        (event) => event === "close:1011:Presence storage failed.",
      ),
    "Timed out waiting for failed presence open cleanup.",
  );

  peer.events.length = 0;
  transport.websocket.close(peer.socket as never, 1000, "after failed open");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(presenceStore.deleteCalls, []);
  assert.deepEqual(peer.events, []);
});

test("presence transport stores authorized updates and broadcasts filtered snapshots", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const filterCalls: string[] = [];
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      filterPresenceSnapshot: async (_request, context, users) => {
        filterCalls.push(context.sessionId);
        return context.sessionId === "session-2"
          ? users.filter((user) => user.sessionId === "session-2")
          : users;
      },
    }),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const peerA = createBunSocketStub(calls[0]!.options.data);
  const peerB = createBunSocketStub(calls[1]!.options.data);

  transport.websocket.open(peerA.socket as never);
  transport.websocket.open(peerB.socket as never);
  await waitFor(
    () =>
      parseSnapshotMessages(peerA.sent).length > 0 &&
      parseSnapshotMessages(peerB.sent).length > 0,
    "Timed out waiting for initial presence snapshots.",
  );
  peerA.sent.length = 0;
  peerB.sent.length = 0;
  filterCalls.length = 0;

  transport.websocket.message(
    peerA.socket as never,
    JSON.stringify({
      type: "presence.update",
      documentId: DOCUMENT_ID,
      mode: "edit",
      cursor: { anchor: 2, head: 7 },
    }) as never,
  );

  await waitFor(
    () =>
      filterCalls.length === 2 &&
      parseSnapshotMessages(peerA.sent).length > 0 &&
      parseSnapshotMessages(peerB.sent).length > 0,
    "Timed out waiting for update broadcast.",
  );

  assert.deepEqual(presenceStore.records.get("session-1"), {
    project: "marketing",
    environment: "staging",
    userId: "ada",
    sessionId: "session-1",
    label: "ada",
    color: "#2563eb",
    documentId: DOCUMENT_ID,
    mode: "edit",
    cursor: { anchor: 2, head: 7 },
    updatedAt: "2026-06-14T10:00:00.000Z",
  });
  assert.deepEqual(filterCalls, ["session-1", "session-2"]);
  assert.deepEqual(
    parseSnapshotMessages(peerA.sent)
      .at(-1)
      ?.users.map((user) => user.sessionId),
    ["session-1", "session-2"],
  );
  assert.deepEqual(parseSnapshotMessages(peerB.sent).at(-1)?.users, [
    {
      userId: "grace",
      sessionId: "session-2",
      label: "grace",
      color: "#2563eb",
      documentId: null,
      mode: "view",
      updatedAt: "2026-06-14T10:00:00.000Z",
    },
  ]);
});

test("presence transport fails closed and cleans up when update storage fails", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  let failNextSet = false;
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore: {
      ...presenceStore,
      async setPresence(record) {
        if (failNextSet) {
          throw new Error("redis unavailable");
        }

        await presenceStore.setPresence(record);
      },
    },
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const peerA = createBunSocketStub(calls[0]!.options.data);
  const observer = createBunSocketStub(calls[1]!.options.data);

  transport.websocket.open(peerA.socket as never);
  transport.websocket.open(observer.socket as never);
  await waitFor(
    () =>
      presenceStore.records.has("session-1") &&
      presenceStore.records.has("session-2") &&
      parseSnapshotMessages(observer.sent).length > 0,
    "Timed out waiting for initial presence records.",
  );

  failNextSet = true;
  observer.sent.length = 0;
  peerA.events.length = 0;
  transport.websocket.message(
    peerA.socket as never,
    JSON.stringify({
      type: "presence.update",
      documentId: DOCUMENT_ID,
      mode: "edit",
    }) as never,
  );

  await waitFor(
    () =>
      peerA.events.some(
        (event) => event === "close:1011:Presence update failed.",
      ) &&
      presenceStore.deleteCalls.length === 1 &&
      parseSnapshotMessages(observer.sent).at(-1)?.users.length === 1,
    "Timed out waiting for failed update cleanup.",
  );

  assert.deepEqual(presenceStore.deleteCalls, [
    {
      project: "marketing",
      environment: "staging",
      sessionId: "session-1",
    },
  ]);
  assert.equal(presenceStore.records.has("session-1"), false);
  assert.deepEqual(
    parseSnapshotMessages(observer.sent)
      .at(-1)
      ?.users.map((user) => user.sessionId),
    ["session-2"],
  );
});

test("presence transport fails closed and cleans up when update authorization throws", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      authorizePresenceUpdate: async () => {
        throw new Error("auth backend unavailable");
      },
    }),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const peerA = createBunSocketStub(calls[0]!.options.data);
  const observer = createBunSocketStub(calls[1]!.options.data);

  transport.websocket.open(peerA.socket as never);
  transport.websocket.open(observer.socket as never);
  await waitFor(
    () =>
      presenceStore.records.has("session-1") &&
      presenceStore.records.has("session-2") &&
      parseSnapshotMessages(observer.sent).length > 0,
    "Timed out waiting for initial presence records.",
  );

  observer.sent.length = 0;
  peerA.events.length = 0;
  transport.websocket.message(
    peerA.socket as never,
    JSON.stringify({
      type: "presence.update",
      documentId: DOCUMENT_ID,
      mode: "edit",
    }) as never,
  );

  await waitFor(
    () =>
      peerA.events.some(
        (event) => event === "close:1011:Presence update failed.",
      ) &&
      presenceStore.deleteCalls.length === 1 &&
      parseSnapshotMessages(observer.sent).at(-1)?.users.length === 1,
    "Timed out waiting for thrown update authorization cleanup.",
  );

  assert.deepEqual(presenceStore.deleteCalls, [
    {
      project: "marketing",
      environment: "staging",
      sessionId: "session-1",
    },
  ]);
  assert.equal(presenceStore.records.has("session-1"), false);
});

test("presence transport cleans up peers when snapshot filtering fails", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      filterPresenceSnapshot: async (_request, context, users) => {
        if (context.sessionId === "session-1") {
          throw new Error("authorization backend unavailable");
        }

        return users;
      },
    }),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const peerA = createBunSocketStub(calls[0]!.options.data);
  const observer = createBunSocketStub(calls[1]!.options.data);

  transport.websocket.open(peerA.socket as never);
  transport.websocket.open(observer.socket as never);

  await waitFor(
    () =>
      peerA.events.some(
        (event) => event === "close:1011:Presence snapshot failed.",
      ) &&
      presenceStore.deleteCalls.length === 1 &&
      parseSnapshotMessages(observer.sent).at(-1)?.users.length === 1,
    "Timed out waiting for failed snapshot cleanup.",
  );

  assert.deepEqual(presenceStore.deleteCalls, [
    {
      project: "marketing",
      environment: "staging",
      sessionId: "session-1",
    },
  ]);
  assert.equal(presenceStore.records.has("session-1"), false);
  assert.deepEqual(
    parseSnapshotMessages(observer.sent)
      .at(-1)
      ?.users.map((user) => user.sessionId),
    ["session-2"],
  );
});

test("presence transport omits cursor from target-level updates", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );

  const peer = createBunSocketStub(calls[0]!.options.data);
  transport.websocket.open(peer.socket as never);
  await waitFor(
    () => parseSnapshotMessages(peer.sent).length > 0,
    "Timed out waiting for initial presence snapshot.",
  );
  transport.websocket.message(
    peer.socket as never,
    JSON.stringify({
      type: "presence.update",
      documentId: null,
      mode: "view",
      cursor: { anchor: 2, head: 7 },
    }) as never,
  );
  await waitFor(
    () => presenceStore.setCalls.length === 2,
    "Timed out waiting for target-level presence update.",
  );

  assert.equal(presenceStore.records.get("session-1")?.documentId, null);
  assert.equal(presenceStore.records.get("session-1")?.cursor, undefined);
});

test("presence transport closes with 4403 for invalid JSON and invalid update payloads", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore: createPresenceStore(),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const invalidJsonPeer = createBunSocketStub(calls[0]!.options.data);
  const invalidSchemaPeer = createBunSocketStub(calls[1]!.options.data);

  transport.websocket.open(invalidJsonPeer.socket as never);
  transport.websocket.open(invalidSchemaPeer.socket as never);
  await waitFor(
    () =>
      parseSnapshotMessages(invalidJsonPeer.sent).length > 0 &&
      parseSnapshotMessages(invalidSchemaPeer.sent).length > 0,
    "Timed out waiting for initial presence snapshots.",
  );
  invalidJsonPeer.events.length = 0;
  invalidSchemaPeer.events.length = 0;

  transport.websocket.message(
    invalidJsonPeer.socket as never,
    "not-json" as never,
  );
  transport.websocket.message(
    invalidSchemaPeer.socket as never,
    JSON.stringify({ type: "presence.update", mode: "publish" }) as never,
  );

  await waitFor(
    () =>
      invalidJsonPeer.events.some((event) =>
        event.startsWith("close:4403:Invalid presence update"),
      ) &&
      invalidSchemaPeer.events.some((event) =>
        event.startsWith("close:4403:Invalid presence update"),
      ),
    "Timed out waiting for invalid presence update closes.",
  );

  assert.match(
    invalidJsonPeer.events.find((event) => event.startsWith("close:4403")) ??
      "",
    /^close:4403:Invalid presence update/,
  );
  assert.match(
    invalidSchemaPeer.events.find((event) => event.startsWith("close:4403")) ??
      "",
    /^close:4403:Invalid presence update/,
  );
});

test("presence transport closes with update authorization close codes", async () => {
  const { calls, server } = createBunServerStub();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({
      authorizePresenceUpdate: async () => ({ ok: false, closeCode: 4401 }),
    }),
    presenceStore: createPresenceStore(),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest(),
    server as never,
  );

  const peer = createBunSocketStub(calls[0]!.options.data);

  transport.websocket.open(peer.socket as never);
  await waitFor(
    () => parseSnapshotMessages(peer.sent).length > 0,
    "Timed out waiting for initial presence snapshot.",
  );
  peer.events.length = 0;
  transport.websocket.message(
    peer.socket as never,
    JSON.stringify({
      type: "presence.update",
      documentId: DOCUMENT_ID,
      mode: "view",
    }) as never,
  );
  await waitFor(
    () =>
      peer.events.some(
        (event) =>
          event === "close:4401:Presence update is no longer authorized.",
      ),
    "Timed out waiting for unauthorized presence update close.",
  );

  assert.deepEqual(
    peer.events.at(-1),
    "close:4401:Presence update is no longer authorized.",
  );
});

test("presence transport deletes presence only after the last local socket for a session closes", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );
  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "grace", sessionId: "session-2" }),
    server as never,
  );

  const firstTab = createBunSocketStub(calls[0]!.options.data);
  const secondTab = createBunSocketStub(calls[1]!.options.data);
  const observer = createBunSocketStub(calls[2]!.options.data);

  transport.websocket.open(firstTab.socket as never);
  transport.websocket.open(secondTab.socket as never);
  transport.websocket.open(observer.socket as never);
  await waitFor(
    () => parseSnapshotMessages(observer.sent).length > 0,
    "Timed out waiting for observer presence snapshot.",
  );
  observer.sent.length = 0;

  transport.websocket.close(firstTab.socket as never, 1000, "tab closed");
  await waitFor(
    () => parseSnapshotMessages(observer.sent).length > 0,
    "Timed out waiting for first close broadcast.",
  );

  assert.deepEqual(presenceStore.deleteCalls, []);
  assert.equal(presenceStore.records.has("session-1"), true);

  transport.websocket.close(secondTab.socket as never, 1000, "tab closed");
  await waitFor(
    () =>
      presenceStore.deleteCalls.length === 1 &&
      parseSnapshotMessages(observer.sent).at(-1)?.users.length === 1,
    "Timed out waiting for last close cleanup.",
  );

  assert.deepEqual(presenceStore.deleteCalls, [
    {
      project: "marketing",
      environment: "staging",
      sessionId: "session-1",
    },
  ]);
  assert.equal(presenceStore.records.has("session-1"), false);
  assert.deepEqual(
    parseSnapshotMessages(observer.sent)
      .at(-1)
      ?.users.map((user) => user.sessionId),
    ["session-2"],
  );
});

test("collaboration transport shutdown closes peers and waits for documents to unload", async () => {
  const context = createContext({ userId: "editor-1" });
  const { calls, server } = createBunServerStub();
  const events: string[] = [];
  let documentCount = 1;
  const transport = createCollaborationWebSocketTransport({
    authGuard: createAuthGuard({ ok: true, context }),
    runtime: {
      server: {
        handleConnection() {
          events.push("handleConnection");

          return {
            handleMessage() {
              events.push("handleMessage");
            },
            handleClose() {
              events.push("handleClose");
            },
          };
        },
        closeConnections() {
          events.push("closeConnections");
        },
        flushPendingStores() {
          events.push("flushPendingStores");
          queueMicrotask(() => {
            events.push("unloaded");
            documentCount = 0;
          });
        },
        getDocumentsCount() {
          events.push(`getDocumentsCount:${documentCount}`);
          return documentCount;
        },
      },
    },
  });

  await transport.handleFetchUpgrade(createUpgradeRequest(), server as never);

  assert.equal(calls.length, 1);

  const { socket, events: socketEvents } = createBunSocketStub(
    calls[0]!.options.data,
  );

  transport.websocket.open(socket as never);
  await transport.shutdown();

  assert.deepEqual(events, [
    "handleConnection",
    "closeConnections",
    "flushPendingStores",
    "getDocumentsCount:1",
    "unloaded",
    "getDocumentsCount:0",
  ]);
  assert.deepEqual(socketEvents, ["close:1001:Server shutting down."]);
});

test("collaboration transport shutdown awaits deterministic presence cleanup", async () => {
  const { calls, server } = createBunServerStub();
  const presenceStore = createPresenceStore();
  let releasePresenceCleanup: (() => void) | undefined;
  let cleanupCompleted = false;
  const transport = createCollaborationWebSocketTransport({
    authGuard: createPresenceAuthGuard({}),
    presenceStore: {
      ...presenceStore,
      async deletePresence(input) {
        await new Promise<void>((resolve) => {
          releasePresenceCleanup = resolve;
        });
        cleanupCompleted = true;
        await presenceStore.deletePresence(input);
      },
    },
  });

  await transport.handleFetchUpgrade(
    createPresenceUpgradeRequest({ userId: "ada", sessionId: "session-1" }),
    server as never,
  );

  const { socket, events: socketEvents } = createBunSocketStub(
    calls[0]!.options.data,
  );

  transport.websocket.open(socket as never);
  await waitFor(
    () => presenceStore.records.has("session-1"),
    "Timed out waiting for initial presence record.",
  );

  let shutdownFinished = false;
  const shutdown = transport.shutdown().then(() => {
    shutdownFinished = true;
  });

  await waitFor(
    () => releasePresenceCleanup !== undefined,
    "Timed out waiting for shutdown presence cleanup to start.",
  );

  assert.equal(shutdownFinished, false);
  assert.equal(cleanupCompleted, false);
  releasePresenceCleanup?.();
  await shutdown;

  assert.equal(cleanupCompleted, true);
  assert.equal(shutdownFinished, true);
  assert.deepEqual(presenceStore.deleteCalls, [
    {
      project: "marketing",
      environment: "staging",
      sessionId: "session-1",
    },
  ]);
  assert.deepEqual(socketEvents, ["close:1001:Server shutting down."]);
});
