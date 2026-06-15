import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "bun:test";

import {
  Document as HocuspocusDocument,
  IncomingMessage,
  MessageReceiver,
  MessageType,
  OutgoingMessage,
} from "@hocuspocus/server";
import type { CollaborationPresenceUser } from "@mdcms/shared";
import * as Y from "yjs";

import type {
  CollaborationPresenceContext,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import {
  DEFAULT_ACTOR,
  type ContentDocument,
  type ContentScope,
} from "../content-api/types.js";

import {
  COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
  type CollaborationYjsMetadata,
} from "./redis-store.js";
import {
  computeCollaborationBodyHash,
  createCollaborationDocumentName,
  createCollaborationRuntime,
  markdownToYDoc,
  yDocToMarkdown,
  type CollaborationRuntimeAuthGuard,
  type CollaborationRuntimeContentStore,
  type CollaborationRuntimeRedisStore,
} from "./runtime.js";
import { createCollaborationWebSocketTransport } from "./transport.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_NAME = createCollaborationDocumentName({
  project: "marketing",
  environment: "draft",
  documentId: DOCUMENT_ID,
});

type TestBunServer = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
};

type TestBunRuntime = {
  serve: (options: {
    port: number;
    websocket: unknown;
    fetch: (
      request: Request,
      server: unknown,
    ) => Response | undefined | Promise<Response | undefined>;
  }) => TestBunServer;
};

type TestWebSocket = {
  binaryType: string;
  readyState: number;
  addEventListener: (
    event: "open" | "message" | "close" | "error",
    listener: (event: any) => void,
  ) => void;
  send: (data: string | Uint8Array) => void;
  close: () => void;
};

type TestWebSocketConstructor = {
  new (url: string): TestWebSocket;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
};

const BunRuntime = (globalThis as unknown as { Bun: TestBunRuntime }).Bun;
const WebSocketRuntime = (
  globalThis as unknown as { WebSocket: TestWebSocketConstructor }
).WebSocket;

function createDocument(
  overrides: Partial<ContentDocument> = {},
): ContentDocument {
  return {
    documentId: overrides.documentId ?? DOCUMENT_ID,
    translationGroupId:
      overrides.translationGroupId ?? "22222222-2222-4222-8222-222222222222",
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
    body: overrides.body ?? "# Shared\n\nInitial body.",
    createdBy: overrides.createdBy ?? "user-created",
    createdAt: overrides.createdAt ?? "2026-06-11T10:00:00.000Z",
    updatedBy: overrides.updatedBy ?? "user-updated",
    updatedAt: overrides.updatedAt ?? "2026-06-11T10:00:00.000Z",
  };
}

function createSessionContext(
  overrides: Partial<CollaborationSessionContext> = {},
): CollaborationSessionContext {
  return {
    userId: overrides.userId ?? "user-1",
    sessionId: overrides.sessionId ?? "session-1",
    project: overrides.project ?? "marketing",
    environment: overrides.environment ?? "draft",
    documentId: overrides.documentId ?? DOCUMENT_ID,
    documentPath: overrides.documentPath ?? "docs/launch",
    role: overrides.role ?? "editor",
  };
}

function createPresenceContext(
  overrides: Partial<CollaborationPresenceContext> = {},
): CollaborationPresenceContext {
  return {
    userId: overrides.userId ?? "user-1",
    sessionId: overrides.sessionId ?? "session-1",
    project: overrides.project ?? "marketing",
    environment: overrides.environment ?? "draft",
    role: overrides.role ?? "editor",
    label: overrides.label ?? overrides.userId ?? "user-1",
    color: overrides.color ?? "#2563eb",
  };
}

class IntegrationContentStore implements CollaborationRuntimeContentStore {
  document: ContentDocument;
  readonly updates: Array<{
    scope: ContentScope;
    documentId: string;
    payload: { body: string; updatedBy: string };
    options?: { expectedDraftRevision?: number };
  }> = [];

  constructor(document: ContentDocument) {
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
    payload: { body: string; updatedBy: string },
    options?: { expectedDraftRevision?: number },
  ): Promise<ContentDocument> {
    this.updates.push({ scope, documentId, payload, options });
    this.document = {
      ...this.document,
      body: payload.body,
      updatedBy: payload.updatedBy,
      updatedAt: "2026-06-11T10:01:00.000Z",
      draftRevision: this.document.draftRevision + 1,
    };
    return this.document;
  }
}

class IntegrationRedisStore implements CollaborationRuntimeRedisStore {
  state: Uint8Array | null = null;
  metadata: CollaborationYjsMetadata | null = null;
  activeLeaseValue: string | null = null;
  readonly expirations = new Map<string, number>();
  readonly presenceRecords = new Map<
    string,
    CollaborationPresenceUser & { project: string; environment: string }
  >();

  async getFreshYjsState(
    _documentId: string,
    draftHead: { draftRevision: number; bodyHash: string },
  ) {
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

  async setYjsState(_documentId: string, state: Uint8Array): Promise<void> {
    this.state = new Uint8Array(state);
  }

  async setYjsMetadata(
    _documentId: string,
    metadata: CollaborationYjsMetadata,
  ): Promise<void> {
    this.metadata = metadata;
  }

  async clearInactiveCacheTtl(documentId: string): Promise<void> {
    this.expirations.delete(documentId);
  }

  async acquireActiveLock(
    _documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLeaseValue) {
      return false;
    }

    this.activeLeaseValue = leaseValue;
    return true;
  }

  async heartbeatActiveLock(
    _documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    return this.activeLeaseValue === leaseValue;
  }

  async releaseActiveLock(
    _documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLeaseValue !== leaseValue) {
      return false;
    }

    this.activeLeaseValue = null;
    return true;
  }

  async finalizeInactiveRoom(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLeaseValue !== leaseValue) {
      return false;
    }

    this.expirations.set(documentId, COLLABORATION_INACTIVE_CACHE_TTL_SECONDS);
    this.activeLeaseValue = null;
    return true;
  }

  async setPresence(
    record: CollaborationPresenceUser & {
      project: string;
      environment: string;
    },
  ): Promise<void> {
    this.presenceRecords.set(record.sessionId, record);
  }

  async deletePresence(input: {
    project: string;
    environment: string;
    sessionId: string;
  }): Promise<void> {
    const record = this.presenceRecords.get(input.sessionId);

    if (
      record?.project === input.project &&
      record.environment === input.environment
    ) {
      this.presenceRecords.delete(input.sessionId);
    }
  }

  async listPresence(input: {
    project: string;
    environment: string;
  }): Promise<CollaborationPresenceUser[]> {
    return Array.from(this.presenceRecords.values())
      .filter(
        (record) =>
          record.project === input.project &&
          record.environment === input.environment,
      )
      .map(({ project: _project, environment: _environment, ...user }) => user);
  }
}

function createAuthMessage(documentName: string): Uint8Array {
  const message = new IncomingMessage(new Uint8Array());
  message.writeVarString(documentName);
  message.writeVarUint(MessageType.Auth);
  message.writeVarUint(0 as MessageType);
  message.writeVarString("");
  return message.toUint8Array();
}

async function waitFor(
  predicate: () => boolean,
  message: string | (() => string),
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(typeof message === "function" ? message() : message);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
          return;
        }

        reject(new Error("Could not reserve an ephemeral test port."));
      });
    });
  });
}

class RawHocuspocusSocket {
  readonly document: HocuspocusDocument;
  readonly socket: TestWebSocket;
  authenticated = false;
  closeEvent: { code: number; reason: string } | undefined;
  serverCloseReason: string | undefined;

  constructor(
    url: string,
    readonly documentName: string,
  ) {
    this.document = new HocuspocusDocument(documentName);
    this.socket = new WebSocketRuntime(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      this.closeEvent = {
        code: event.code,
        reason: event.reason,
      };
    });
  }

  async open(): Promise<void> {
    await waitFor(
      () => this.socket.readyState === WebSocketRuntime.OPEN,
      "Timed out opening test WebSocket.",
      8_000,
    );

    this.socket.send(createAuthMessage(this.documentName));
    this.socket.send(
      new OutgoingMessage(this.documentName)
        .createSyncMessage()
        .writeFirstSyncStepFor(this.document)
        .toUint8Array(),
    );

    await waitFor(
      () => this.authenticated,
      "Timed out waiting for Hocuspocus authentication.",
    );
  }

  async sendMarkdown(markdown: string): Promise<void> {
    const updatedDocument = markdownToYDoc(markdown);
    const update = Y.encodeStateAsUpdate(updatedDocument);
    Y.applyUpdate(this.document, update);
    this.socket.send(
      new OutgoingMessage(this.documentName)
        .createSyncMessage()
        .writeUpdate(update)
        .toUint8Array(),
    );
  }

  markdown(): string {
    return yDocToMarkdown(this.document);
  }

  close(): void {
    if (
      this.socket.readyState !== WebSocketRuntime.CLOSED &&
      this.socket.readyState !== WebSocketRuntime.CLOSING
    ) {
      this.socket.close();
    }
  }

  private async handleMessage(rawData: unknown): Promise<void> {
    const bytes =
      rawData instanceof ArrayBuffer
        ? new Uint8Array(rawData)
        : rawData instanceof Uint8Array
          ? rawData
          : new Uint8Array(await (rawData as Blob).arrayBuffer());
    const inspection = new IncomingMessage(bytes);
    inspection.readVarString();
    const type = inspection.readVarUint();

    if (type === MessageType.Auth) {
      const authType = inspection.readVarUint();
      this.authenticated = authType === 2;
      return;
    }

    if (type === MessageType.SyncStatus) {
      return;
    }

    if (type === MessageType.CLOSE) {
      this.serverCloseReason = inspection.readVarString();
      this.close();
      return;
    }

    const message = new IncomingMessage(bytes);
    message.readVarString();
    await new MessageReceiver(message).apply(
      this.document,
      undefined,
      (reply) => {
        this.socket.send(reply);
      },
    );
  }
}

class PresenceSocket {
  readonly socket: TestWebSocket;
  readonly snapshots: Array<{
    type: "presence.snapshot";
    project: string;
    environment: string;
    users: CollaborationPresenceUser[];
  }> = [];
  closeEvent: { code: number; reason: string } | undefined;

  constructor(url: string) {
    this.socket = new WebSocketRuntime(url);
    this.socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener("close", (event) => {
      this.closeEvent = {
        code: event.code,
        reason: event.reason,
      };
    });
  }

  async open(): Promise<void> {
    await waitFor(
      () => this.socket.readyState === WebSocketRuntime.OPEN,
      "Timed out opening presence WebSocket.",
    );
  }

  sendUpdate(update: unknown): void {
    this.socket.send(JSON.stringify(update));
  }

  latestSnapshot() {
    return this.snapshots.at(-1);
  }

  close(): void {
    if (
      this.socket.readyState !== WebSocketRuntime.CLOSED &&
      this.socket.readyState !== WebSocketRuntime.CLOSING
    ) {
      this.socket.close();
    }
  }

  private async handleMessage(rawData: unknown): Promise<void> {
    const text =
      typeof rawData === "string"
        ? rawData
        : rawData instanceof ArrayBuffer
          ? new TextDecoder().decode(rawData)
          : rawData instanceof Uint8Array
            ? new TextDecoder().decode(rawData)
            : await (rawData as Blob).text();
    const payload = JSON.parse(text) as {
      type?: string;
      project?: string;
      environment?: string;
      users?: CollaborationPresenceUser[];
    };

    if (payload.type === "presence.snapshot") {
      this.snapshots.push({
        type: "presence.snapshot",
        project: payload.project ?? "",
        environment: payload.environment ?? "",
        users: payload.users ?? [],
      });
    }
  }
}

test("Bun collaboration sockets sync Yjs updates and finalize the document room on last disconnect", async () => {
  const contentStore = new IntegrationContentStore(
    createDocument({ body: "# Shared\n\nInitial body.", draftRevision: 5 }),
  );
  const redisStore = new IntegrationRedisStore();
  const authGuard: CollaborationRuntimeAuthGuard = {
    revalidateWrite: async () => ({ ok: true }),
  };
  const runtime = createCollaborationRuntime({
    contentStore,
    redisStore,
    authGuard,
    createRoomLeaseValue: () => "lease-1",
  });
  const transport = createCollaborationWebSocketTransport({
    authGuard: {
      authorizeHandshake: async (request) => {
        const url = new URL(request.url);
        return {
          ok: true,
          context: createSessionContext({
            userId: url.searchParams.get("userId") ?? "user-1",
          }),
        };
      },
      authorizePresenceHandshake: async () => ({
        ok: true,
        context: createPresenceContext(),
      }),
      authorizePresenceUpdate: async () => ({ ok: true }),
      filterPresenceSnapshot: async (_request, _context, users) => users,
      revalidateWrite: async () => ({ ok: true }),
    },
    runtime,
  });
  const port = await getAvailablePort();
  const server = BunRuntime.serve({
    port,
    websocket: transport.websocket,
    fetch: (request, bunServer) =>
      transport.handleFetchUpgrade(request, bunServer as never) ??
      new Response("ok"),
  });
  const baseUrl = `ws://127.0.0.1:${server.port}/api/v1/collaboration?project=marketing&environment=draft&documentId=${DOCUMENT_ID}`;
  const clientA = new RawHocuspocusSocket(
    `${baseUrl}&userId=writer-1`,
    DOCUMENT_NAME,
  );
  const clientB = new RawHocuspocusSocket(
    `${baseUrl}&userId=reader-1`,
    DOCUMENT_NAME,
  );

  try {
    await clientA.open();
    await clientB.open();

    await waitFor(
      () => /Initial body/.test(clientB.markdown()),
      "Timed out waiting for initial Yjs state.",
    );

    await clientA.sendMarkdown("# Updated from A\n\nSynced body.");

    await waitFor(
      () => /Updated from A/.test(clientB.markdown()),
      "Timed out waiting for peer Yjs update.",
    );

    clientA.close();
    clientB.close();

    await waitFor(
      () => contentStore.updates.length === 1,
      "Timed out waiting for final collaboration save.",
    );

    assert.match(contentStore.updates[0]?.payload.body ?? "", /Updated from A/);
    assert.equal(contentStore.updates[0]?.payload.updatedBy, DEFAULT_ACTOR);
    assert.equal(contentStore.updates[0]?.options?.expectedDraftRevision, 5);
    assert.deepEqual(redisStore.metadata, {
      draftRevision: 6,
      bodyHash: computeCollaborationBodyHash(contentStore.document.body),
    });
    assert.equal(
      redisStore.expirations.get(DOCUMENT_ID),
      COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
    );
    assert.equal(redisStore.activeLeaseValue, null);
  } finally {
    clientA.close();
    clientB.close();
    server.stop(true);
  }
});

test("Bun presence sockets exchange JSON snapshots and clean up on disconnect", async () => {
  const redisStore = new IntegrationRedisStore();
  const transport = createCollaborationWebSocketTransport({
    authGuard: {
      authorizeHandshake: async () => ({
        ok: true,
        context: createSessionContext(),
      }),
      authorizePresenceHandshake: async (request) => {
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
      },
      authorizePresenceUpdate: async () => ({ ok: true }),
      filterPresenceSnapshot: async (_request, _context, users) => users,
      revalidateWrite: async () => ({ ok: true }),
    },
    presenceStore: redisStore,
    now: () => new Date("2026-06-14T10:00:00.000Z"),
  });
  const port = await getAvailablePort();
  const server = BunRuntime.serve({
    port,
    websocket: transport.websocket,
    fetch: (request, bunServer) =>
      transport.handleFetchUpgrade(request, bunServer as never) ??
      new Response("ok"),
  });
  const baseUrl = `ws://127.0.0.1:${server.port}/api/v1/collaboration/presence?project=marketing&environment=draft`;
  const clientA = new PresenceSocket(
    `${baseUrl}&userId=ada&sessionId=session-a`,
  );
  let clientB: PresenceSocket | undefined;

  try {
    await clientA.open();
    await waitFor(
      () => clientA.latestSnapshot()?.users.length === 1,
      "Timed out waiting for initial presence snapshot.",
      1_000,
    );

    clientB = new PresenceSocket(`${baseUrl}&userId=grace&sessionId=session-b`);
    const connectedClientB = clientB;

    await connectedClientB.open();
    await waitFor(
      () =>
        clientA
          .latestSnapshot()
          ?.users.some((user) => user.sessionId === "session-b") === true &&
        connectedClientB.latestSnapshot()?.users.length === 2,
      "Timed out waiting for joined presence snapshot.",
      1_000,
    );

    clientA.sendUpdate({
      type: "presence.update",
      documentId: DOCUMENT_ID,
      mode: "edit",
      cursor: { anchor: 3, head: 9 },
    });

    await waitFor(
      () =>
        connectedClientB
          .latestSnapshot()
          ?.users.some(
            (user) =>
              user.sessionId === "session-a" &&
              user.documentId === DOCUMENT_ID &&
              user.mode === "edit" &&
              user.cursor?.anchor === 3 &&
              user.cursor.head === 9,
          ) === true,
      "Timed out waiting for edited presence snapshot.",
      1_000,
    );

    clientA.close();

    await waitFor(
      () =>
        connectedClientB
          .latestSnapshot()
          ?.users.every((user) => user.sessionId !== "session-a") === true,
      "Timed out waiting for disconnect presence cleanup.",
      1_000,
    );

    assert.equal(redisStore.presenceRecords.has("session-a"), false);
    assert.equal(redisStore.presenceRecords.has("session-b"), true);
  } finally {
    clientA.close();
    clientB?.close();
    server.stop(true);
  }
});

test("Bun collaboration socket receives a forbidden close message when write revalidation fails after upgrade", async () => {
  const contentStore = new IntegrationContentStore(
    createDocument({ body: "# Shared\n\nInitial body.", draftRevision: 5 }),
  );
  const redisStore = new IntegrationRedisStore();
  const runtime = createCollaborationRuntime({
    contentStore,
    redisStore,
    authGuard: {
      revalidateWrite: async () => ({ ok: false, closeCode: 4403 }),
    },
    createRoomLeaseValue: () => "lease-2",
  });
  const transport = createCollaborationWebSocketTransport({
    authGuard: {
      authorizeHandshake: async () => ({
        ok: true,
        context: createSessionContext({ userId: "writer-1" }),
      }),
      authorizePresenceHandshake: async () => ({
        ok: true,
        context: createPresenceContext(),
      }),
      authorizePresenceUpdate: async () => ({ ok: true }),
      filterPresenceSnapshot: async (_request, _context, users) => users,
      revalidateWrite: async () => ({ ok: true }),
    },
    runtime,
  });
  const port = await getAvailablePort();
  const server = BunRuntime.serve({
    port,
    websocket: transport.websocket,
    fetch: (request, bunServer) =>
      transport.handleFetchUpgrade(request, bunServer as never) ??
      new Response("ok"),
  });
  const client = new RawHocuspocusSocket(
    `ws://127.0.0.1:${server.port}/api/v1/collaboration?project=marketing&environment=draft&documentId=${DOCUMENT_ID}`,
    DOCUMENT_NAME,
  );

  try {
    await client.open();
    await client.sendMarkdown("# Forbidden update\n\nShould not persist.");

    await waitFor(
      () =>
        client.serverCloseReason ===
        "Collaboration write access is no longer allowed.",
      "Timed out waiting for collaboration forbidden close message.",
    );

    assert.equal(contentStore.updates.length, 0);
  } finally {
    client.close();
    server.stop(true);
  }
});
