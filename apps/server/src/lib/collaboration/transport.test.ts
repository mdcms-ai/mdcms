import assert from "node:assert/strict";
import { test } from "bun:test";
import type { WebSocketLike } from "@hocuspocus/server";

import type { CollaborationSessionContext } from "../collaboration-auth.js";
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

function createAuthGuard(
  result:
    | { ok: true; context: CollaborationSessionContext }
    | { ok: false; closeCode: 4401 | 4403; message: string },
): CollaborationAuthHandshakeGuard {
  return {
    async authorizeHandshake() {
      return result;
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

  return {
    events,
    socket: {
      data,
      remoteAddress: "127.0.0.1",
      send(payload: unknown) {
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
    false,
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

test("collaboration transport falls through for non-collaboration requests", async () => {
  const { calls, server } = createBunServerStub();
  let authorized = false;
  const transport = createCollaborationWebSocketTransport({
    authGuard: {
      async authorizeHandshake() {
        authorized = true;
        return { ok: true, context: createContext() };
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
