import bunAdapter, { type BunAdapter } from "crossws/adapters/bun";
import type { Message, Peer, PeerContext } from "crossws";
import {
  IncomingMessage,
  MessageType,
  type WebSocketLike,
} from "@hocuspocus/server";
import {
  CollaborationPresenceUpdateSchema,
  RuntimeError,
  type CollaborationPresenceUpdate,
  type CollaborationPresenceUser,
} from "@mdcms/shared";

import type {
  CollaborationCloseCode,
  CollaborationHandshakeResult,
  CollaborationPresenceContext,
  CollaborationPresenceHandshakeResult,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import { toServerErrorResponse } from "../errors.js";
import { createJsonResponse, resolvePathname } from "../http-utils.js";
import { createCollaborationUnavailableError } from "./errors.js";
import {
  createCollaborationDocumentName,
  type CollaborationDocumentFlushResult,
  type CollaborationDocumentPublishResult,
  type CollaborationRuntimeContext,
} from "./runtime.js";

export type BunUpgradeServer = Parameters<BunAdapter["handleUpgrade"]>[1];
export type CollaborationWebSocketHandler = BunAdapter["websocket"];

type HocuspocusClientConnection = {
  handleMessage: (message: Uint8Array) => void;
  handleClose: (event?: { code: number; reason: string }) => void;
  waitForPendingMessages?: () => Promise<void>;
};

type HocuspocusConnectionServer = {
  handleConnection: (
    websocket: WebSocketLike,
    request: Request,
    defaultContext: CollaborationRuntimeContext,
  ) => HocuspocusClientConnection;
  closeConnections?: (documentName?: string) => void;
  flushPendingStores?: () => void;
  flushDocument?: (
    documentName: string,
  ) => Promise<CollaborationDocumentFlushResult>;
  publishDocument?: (
    documentName: string,
    input: {
      context: CollaborationRuntimeContext;
      changeSummary?: string;
    },
  ) => Promise<CollaborationDocumentPublishResult>;
  getDocumentsCount?: () => number;
};

export type CollaborationAuthHandshakeGuard = {
  authorizeHandshake: (
    request: Request,
  ) => Promise<CollaborationHandshakeResult>;
  authorizePresenceHandshake: (
    request: Request,
  ) => Promise<CollaborationPresenceHandshakeResult>;
  authorizePresenceUpdate: (
    request: Request,
    context: CollaborationPresenceContext,
    update: CollaborationPresenceUpdate,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
  filterPresenceSnapshot: (
    request: Request,
    context: CollaborationPresenceContext,
    users: CollaborationPresenceUser[],
  ) => Promise<CollaborationPresenceUser[]>;
  revalidateWrite: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
  revalidatePublish: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
};

export type CollaborationPresenceStore = {
  setPresence: (
    record: CollaborationPresenceUser & {
      project: string;
      environment: string;
    },
  ) => Promise<void>;
  deletePresence: (input: {
    project: string;
    environment: string;
    sessionId: string;
  }) => Promise<void>;
  listPresence: (input: {
    project: string;
    environment: string;
  }) => Promise<CollaborationPresenceUser[]>;
};

export type CreateCollaborationWebSocketTransportOptions = {
  authGuard: CollaborationAuthHandshakeGuard;
  runtime?: { server: HocuspocusConnectionServer };
  presenceStore?: CollaborationPresenceStore;
  unavailableDetails?: Record<string, unknown>;
  now?: () => Date;
};

export type CollaborationWebSocketTransport = {
  handleFetchUpgrade: (
    request: Request,
    server: BunUpgradeServer,
  ) => Promise<Response | undefined>;
  websocket: CollaborationWebSocketHandler;
  shutdown: () => Promise<void>;
};

const COLLABORATION_PATHNAME = "/api/v1/collaboration";
const COLLABORATION_PRESENCE_PATHNAME = "/api/v1/collaboration/presence";
const COLLABORATION_SESSION_INVALID_REASON =
  "Collaboration session is no longer valid.";
const COLLABORATION_WRITE_FORBIDDEN_REASON =
  "Collaboration write access is no longer allowed.";
const COLLABORATION_PUBLISH_FORBIDDEN_REASON =
  "Collaboration publish access is no longer allowed.";
const COLLABORATION_PRESENCE_INVALID_UPDATE_REASON = "Invalid presence update.";
const COLLABORATION_PRESENCE_UNAUTHORIZED_UPDATE_REASON =
  "Presence update is no longer authorized.";
const COLLABORATION_SHUTDOWN_CLOSE_CODE = 1001;
const COLLABORATION_SHUTDOWN_CLOSE_REASON = "Server shutting down.";
const COLLABORATION_DRAIN_POLL_INTERVAL_MS = 10;
const COLLABORATION_DRAIN_TIMEOUT_MS = 10_000;

type CollaborationRouteKind = "document" | "presence";

type CollaborationFlushRequest = {
  type: "mdcms.collaboration.flush";
  requestId: string;
};

type CollaborationFlushResultPayload =
  | {
      type: "mdcms.collaboration.flush.result";
      requestId: string;
      status: "saved" | "unchanged";
      draftRevision: number;
    }
  | {
      type: "mdcms.collaboration.flush.result";
      requestId: string;
      status: "error";
      code: string;
      message: string;
    };

type CollaborationPublishRequest = {
  type: "mdcms.collaboration.publish";
  requestId: string;
  changeSummary?: string;
};

type CollaborationPublishResultPayload =
  | {
      type: "mdcms.collaboration.publish.result";
      requestId: string;
      status: "published";
      document: CollaborationDocumentPublishResult["document"];
    }
  | {
      type: "mdcms.collaboration.publish.result";
      requestId: string;
      status: "error";
      code: string;
      message: string;
    };

type CollaborationPeerContext =
  | {
      kind: "document";
      collaboration: CollaborationSessionContext;
    }
  | {
      kind: "presence";
      presence: CollaborationPresenceContext;
    };

type PresencePeerLifecycle = {
  peer: Peer;
  context: CollaborationPresenceContext;
  stored: boolean;
  counted: boolean;
  closing: boolean;
  openTask?: Promise<void>;
  closeTask?: Promise<void>;
};

type PresenceCloseOptions = {
  broadcast: boolean;
  waitForOpen: boolean;
};

function resolveCollaborationRouteKind(
  request: Request,
): CollaborationRouteKind | undefined {
  const pathname = resolvePathname(request);

  if (pathname === COLLABORATION_PATHNAME) {
    return "document";
  }

  if (pathname === COLLABORATION_PRESENCE_PATHNAME) {
    return "presence";
  }

  return undefined;
}

export function isCollaborationWebSocketUpgradeRequest(
  request: Request,
): boolean {
  return (
    request.method.toUpperCase() === "GET" &&
    resolveCollaborationRouteKind(request) !== undefined &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  );
}

function createErrorResponse(error: unknown, request: Request): Response {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  const response = toServerErrorResponse(error, {
    requestId,
    now: new Date(),
  });

  return createJsonResponse(response.body, response.statusCode);
}

function createHandshakeError(
  closeCode: CollaborationCloseCode,
  message: string,
): RuntimeError {
  if (closeCode === 4401) {
    return new RuntimeError({
      code: "UNAUTHORIZED",
      message,
      statusCode: 401,
      details: { closeCode },
    });
  }

  return new RuntimeError({
    code: "COLLABORATION_FORBIDDEN",
    message,
    statusCode: 403,
    details: { closeCode },
  });
}

function collaborationContextFromPeer(
  peer: Peer,
): CollaborationSessionContext | undefined {
  const context = peer.context as PeerContext &
    Partial<CollaborationPeerContext>;

  return context.kind === "document" ? context.collaboration : undefined;
}

function presenceContextFromPeer(
  peer: Peer,
): CollaborationPresenceContext | undefined {
  const context = peer.context as PeerContext &
    Partial<CollaborationPeerContext>;

  return context.kind === "presence" ? context.presence : undefined;
}

function createDocumentNameFromContext(
  context: CollaborationSessionContext,
): string {
  return createCollaborationDocumentName({
    project: context.project,
    environment: context.environment,
    documentId: context.documentId,
  });
}

function readStringMessage(message: Message): string | null {
  const rawData = (message as { rawData?: unknown }).rawData;

  if (typeof rawData === "string") {
    return rawData;
  }

  if (rawData !== undefined) {
    return null;
  }

  if (typeof message === "string") {
    return message;
  }

  try {
    return (message as { text?: () => string }).text?.() ?? null;
  } catch {
    return null;
  }
}

function parseCollaborationFlushRequest(
  message: Message,
): CollaborationFlushRequest | null {
  const text = readStringMessage(message);

  if (!text) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { type?: unknown }).type !== "mdcms.collaboration.flush" ||
    typeof (payload as { requestId?: unknown }).requestId !== "string"
  ) {
    return null;
  }

  return payload as CollaborationFlushRequest;
}

function parseCollaborationPublishRequest(
  message: Message,
): CollaborationPublishRequest | null {
  const text = readStringMessage(message);

  if (!text) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { type?: unknown }).type !== "mdcms.collaboration.publish" ||
    typeof (payload as { requestId?: unknown }).requestId !== "string"
  ) {
    return null;
  }

  if (
    (payload as { changeSummary?: unknown }).changeSummary !== undefined &&
    typeof (payload as { changeSummary?: unknown }).changeSummary !== "string"
  ) {
    return null;
  }

  return payload as CollaborationPublishRequest;
}

function createRuntimeContext(
  request: Request,
  context: CollaborationSessionContext,
): CollaborationRuntimeContext {
  return {
    ...context,
    request,
  };
}

function resolveCloseEventFromOutgoingMessage(
  data: string | ArrayBufferLike | Blob | ArrayBufferView,
): { code: CollaborationCloseCode; reason: string } | undefined {
  if (!(data instanceof Uint8Array)) {
    return undefined;
  }

  const message = new IncomingMessage(data);
  message.readVarString();

  if (message.readVarUint() !== MessageType.CLOSE) {
    return undefined;
  }

  const reason = message.readVarString();

  if (reason === COLLABORATION_SESSION_INVALID_REASON) {
    return { code: 4401, reason };
  }

  if (reason === COLLABORATION_WRITE_FORBIDDEN_REASON) {
    return { code: 4403, reason };
  }

  return undefined;
}

async function waitForCollaborationDocumentsToUnload(
  server: HocuspocusConnectionServer | undefined,
): Promise<void> {
  if (!server?.getDocumentsCount) {
    return;
  }

  const startedAt = Date.now();

  while (server.getDocumentsCount() > 0) {
    if (Date.now() - startedAt > COLLABORATION_DRAIN_TIMEOUT_MS) {
      throw new RuntimeError({
        code: "COLLABORATION_SHUTDOWN_TIMEOUT",
        message: "Timed out waiting for collaboration documents to unload.",
        statusCode: 500,
      });
    }

    await new Promise((resolve) =>
      setTimeout(resolve, COLLABORATION_DRAIN_POLL_INTERVAL_MS),
    );
  }
}

function presenceConnectionKey(context: CollaborationPresenceContext): string {
  return `${context.project}\0${context.environment}\0${context.sessionId}`;
}

function presenceTargetMatches(
  context: CollaborationPresenceContext,
  target: { project: string; environment: string },
): boolean {
  return (
    context.project === target.project &&
    context.environment === target.environment
  );
}

function createPresenceRecord(input: {
  context: CollaborationPresenceContext;
  update?: CollaborationPresenceUpdate;
  now: () => Date;
}): CollaborationPresenceUser & { project: string; environment: string } {
  const documentId = input.update?.documentId ?? null;
  const cursor =
    documentId !== null && input.update?.cursor
      ? { cursor: input.update.cursor }
      : {};

  return {
    project: input.context.project,
    environment: input.context.environment,
    userId: input.context.userId,
    sessionId: input.context.sessionId,
    label: input.context.label,
    color: input.context.color,
    documentId,
    mode: input.update?.mode ?? "view",
    ...cursor,
    updatedAt: input.now().toISOString(),
  };
}

function parsePresenceUpdate(message: Message): CollaborationPresenceUpdate {
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(message.uint8Array()));
  } catch {
    throw new RuntimeError({
      code: "COLLABORATION_FORBIDDEN",
      message: COLLABORATION_PRESENCE_INVALID_UPDATE_REASON,
      statusCode: 403,
    });
  }

  const result = CollaborationPresenceUpdateSchema.safeParse(parsed);

  if (!result.success) {
    throw new RuntimeError({
      code: "COLLABORATION_FORBIDDEN",
      message: COLLABORATION_PRESENCE_INVALID_UPDATE_REASON,
      statusCode: 403,
    });
  }

  return result.data;
}

export function createCollaborationWebSocketTransport(
  options: CreateCollaborationWebSocketTransportOptions,
): CollaborationWebSocketTransport {
  const peerConnections = new WeakMap<Peer, HocuspocusClientConnection>();
  const openPeers = new Set<Peer>();
  const presenceConnectionCounts = new Map<string, number>();
  const presencePeerLifecycles = new Map<Peer, PresencePeerLifecycle>();
  const pendingPresenceTasks = new Set<Promise<void>>();
  const pendingDocumentTasks = new Set<Promise<void>>();
  const now = options.now ?? (() => new Date());

  function trackPresenceTask(task: Promise<void>): void {
    const trackedTask = task
      .catch(() => {
        // The caller owns the visible close/cleanup behavior. This catch keeps
        // fire-and-forget adapter hooks from surfacing unhandled rejections.
      })
      .finally(() => {
        pendingPresenceTasks.delete(trackedTask);
      });

    pendingPresenceTasks.add(trackedTask);
  }

  function trackDocumentTask(task: Promise<void>): void {
    const trackedTask = task
      .catch(() => {
        // The task sends its own error payload. This prevents unhandled
        // rejections from fire-and-forget websocket adapter hooks.
      })
      .finally(() => {
        pendingDocumentTasks.delete(trackedTask);
      });

    pendingDocumentTasks.add(trackedTask);
  }

  async function handleDocumentFlushMessage(
    peer: Peer,
    context: CollaborationSessionContext,
    connection: HocuspocusClientConnection | undefined,
    request: CollaborationFlushRequest,
  ): Promise<void> {
    const server = options.runtime?.server;
    let payload: CollaborationFlushResultPayload;

    try {
      if (!server?.flushDocument) {
        throw new RuntimeError({
          code: "COLLABORATION_FLUSH_UNAVAILABLE",
          message: "Collaboration flush is unavailable.",
          statusCode: 503,
        });
      }

      await connection?.waitForPendingMessages?.();

      const authorization = await options.authGuard.revalidateWrite(
        peer.request,
        context,
      );

      if (!authorization.ok) {
        throw new RuntimeError({
          code: authorization.closeCode === 4401 ? "UNAUTHORIZED" : "FORBIDDEN",
          message:
            authorization.closeCode === 4401
              ? COLLABORATION_SESSION_INVALID_REASON
              : COLLABORATION_WRITE_FORBIDDEN_REASON,
          statusCode: authorization.closeCode === 4401 ? 401 : 403,
        });
      }

      const result = await server.flushDocument(
        createDocumentNameFromContext(context),
      );

      payload = {
        type: "mdcms.collaboration.flush.result",
        requestId: request.requestId,
        status: result.status,
        draftRevision: result.draftRevision,
      };
    } catch (error) {
      payload = {
        type: "mdcms.collaboration.flush.result",
        requestId: request.requestId,
        status: "error",
        code:
          error instanceof RuntimeError
            ? error.code
            : "COLLABORATION_FLUSH_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Collaboration flush failed.",
      };
    }

    peer.send(JSON.stringify(payload));
  }

  async function handleDocumentPublishMessage(
    peer: Peer,
    context: CollaborationSessionContext,
    connection: HocuspocusClientConnection | undefined,
    request: CollaborationPublishRequest,
  ): Promise<void> {
    const server = options.runtime?.server;
    let payload: CollaborationPublishResultPayload;

    try {
      if (!server?.publishDocument) {
        throw new RuntimeError({
          code: "COLLABORATION_PUBLISH_UNAVAILABLE",
          message: "Collaboration publish is unavailable.",
          statusCode: 503,
        });
      }

      await connection?.waitForPendingMessages?.();

      const authorization = await options.authGuard.revalidatePublish(
        peer.request,
        context,
      );

      if (!authorization.ok) {
        throw new RuntimeError({
          code: authorization.closeCode === 4401 ? "UNAUTHORIZED" : "FORBIDDEN",
          message:
            authorization.closeCode === 4401
              ? COLLABORATION_SESSION_INVALID_REASON
              : COLLABORATION_PUBLISH_FORBIDDEN_REASON,
          statusCode: authorization.closeCode === 4401 ? 401 : 403,
        });
      }

      const result = await server.publishDocument(
        createDocumentNameFromContext(context),
        {
          context: createRuntimeContext(peer.request, context),
          changeSummary: request.changeSummary,
        },
      );

      payload = {
        type: "mdcms.collaboration.publish.result",
        requestId: request.requestId,
        status: "published",
        document: result.document,
      };
    } catch (error) {
      payload = {
        type: "mdcms.collaboration.publish.result",
        requestId: request.requestId,
        status: "error",
        code:
          error instanceof RuntimeError
            ? error.code
            : "COLLABORATION_PUBLISH_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Collaboration publish failed.",
      };
    }

    peer.send(JSON.stringify(payload));
  }

  function incrementPresenceConnectionCount(
    context: CollaborationPresenceContext,
  ): void {
    const connectionKey = presenceConnectionKey(context);
    presenceConnectionCounts.set(
      connectionKey,
      (presenceConnectionCounts.get(connectionKey) ?? 0) + 1,
    );
  }

  async function deletePresenceIfNoOtherLocalConnection(
    context: CollaborationPresenceContext,
  ): Promise<void> {
    if (!options.presenceStore) {
      return;
    }

    if (
      (presenceConnectionCounts.get(presenceConnectionKey(context)) ?? 0) > 0
    ) {
      return;
    }

    await options.presenceStore.deletePresence({
      project: context.project,
      environment: context.environment,
      sessionId: context.sessionId,
    });
  }

  async function releaseCountedPresence(
    context: CollaborationPresenceContext,
  ): Promise<void> {
    if (!options.presenceStore) {
      return;
    }

    const connectionKey = presenceConnectionKey(context);
    const remaining = (presenceConnectionCounts.get(connectionKey) ?? 1) - 1;

    if (remaining > 0) {
      presenceConnectionCounts.set(connectionKey, remaining);
      return;
    }

    presenceConnectionCounts.delete(connectionKey);
    await options.presenceStore.deletePresence({
      project: context.project,
      environment: context.environment,
      sessionId: context.sessionId,
    });
  }

  async function broadcastPresenceSnapshot(target: {
    project: string;
    environment: string;
  }): Promise<void> {
    if (!options.presenceStore) {
      return;
    }

    const users = await options.presenceStore.listPresence(target);

    await Promise.all(
      Array.from(openPeers).map(async (peer) => {
        const lifecycle = presencePeerLifecycles.get(peer);
        const context = lifecycle?.context;

        if (!context || !presenceTargetMatches(context, target)) {
          return;
        }

        try {
          const filteredUsers = await options.authGuard.filterPresenceSnapshot(
            peer.request,
            context,
            users,
          );

          peer.send(
            JSON.stringify({
              type: "presence.snapshot",
              project: target.project,
              environment: target.environment,
              users: filteredUsers,
            }),
          );
        } catch {
          lifecycle.closing = true;
          peer.close(1011, "Presence snapshot failed.");
          await handlePresenceClose(lifecycle, {
            broadcast: true,
            waitForOpen: false,
          });
        }
      }),
    );
  }

  async function cleanupPresenceLifecycle(
    lifecycle: PresencePeerLifecycle,
    optionsOverride: { broadcast: boolean } = { broadcast: true },
  ): Promise<void> {
    if (lifecycle.counted) {
      lifecycle.counted = false;
      lifecycle.stored = false;
      await releaseCountedPresence(lifecycle.context);
    } else if (lifecycle.stored) {
      lifecycle.stored = false;
      await deletePresenceIfNoOtherLocalConnection(lifecycle.context);
    }

    presencePeerLifecycles.delete(lifecycle.peer);

    if (optionsOverride.broadcast) {
      await broadcastPresenceSnapshot({
        project: lifecycle.context.project,
        environment: lifecycle.context.environment,
      });
    }
  }

  async function handlePresenceOpen(
    lifecycle: PresencePeerLifecycle,
  ): Promise<void> {
    if (!options.presenceStore) {
      openPeers.delete(lifecycle.peer);
      presencePeerLifecycles.delete(lifecycle.peer);
      lifecycle.peer.close(1011, "Presence storage is unavailable.");
      return;
    }

    try {
      if (lifecycle.closing) {
        return;
      }

      await options.presenceStore.setPresence(
        createPresenceRecord({ context: lifecycle.context, now }),
      );
      lifecycle.stored = true;

      if (lifecycle.closing) {
        await cleanupPresenceLifecycle(lifecycle);
        return;
      }

      incrementPresenceConnectionCount(lifecycle.context);
      lifecycle.counted = true;

      await broadcastPresenceSnapshot({
        project: lifecycle.context.project,
        environment: lifecycle.context.environment,
      });
    } catch {
      lifecycle.closing = true;
      openPeers.delete(lifecycle.peer);
      try {
        await cleanupPresenceLifecycle(lifecycle, { broadcast: false });
      } catch {
        presencePeerLifecycles.delete(lifecycle.peer);
      }
      lifecycle.peer.close(1011, "Presence storage failed.");
    }
  }

  async function handlePresenceMessage(
    lifecycle: PresencePeerLifecycle,
    message: Message,
  ): Promise<void> {
    const { context, peer } = lifecycle;

    if (lifecycle.closing) {
      return;
    }

    if (!options.presenceStore) {
      peer.close(1011, "Presence storage is unavailable.");
      return;
    }

    let update: CollaborationPresenceUpdate;

    try {
      update = parsePresenceUpdate(message);
    } catch {
      peer.close(4403, COLLABORATION_PRESENCE_INVALID_UPDATE_REASON);
      return;
    }

    try {
      const authorization = await options.authGuard.authorizePresenceUpdate(
        peer.request,
        context,
        update,
      );

      if (!authorization.ok) {
        peer.close(
          authorization.closeCode,
          COLLABORATION_PRESENCE_UNAUTHORIZED_UPDATE_REASON,
        );
        return;
      }

      await options.presenceStore.setPresence(
        createPresenceRecord({ context, update, now }),
      );
      lifecycle.stored = true;
      await broadcastPresenceSnapshot({
        project: context.project,
        environment: context.environment,
      });
    } catch {
      lifecycle.closing = true;
      peer.close(1011, "Presence update failed.");
      await handlePresenceClose(lifecycle);
    }
  }

  async function handlePresenceClose(
    lifecycle: PresencePeerLifecycle,
    optionsOverride: PresenceCloseOptions = {
      broadcast: true,
      waitForOpen: true,
    },
  ): Promise<void> {
    if (lifecycle.closeTask) {
      await lifecycle.closeTask;
      return;
    }

    lifecycle.closing = true;
    openPeers.delete(lifecycle.peer);

    lifecycle.closeTask = (async () => {
      if (optionsOverride.waitForOpen) {
        await lifecycle.openTask;
      }
      await cleanupPresenceLifecycle(lifecycle, optionsOverride);
    })();

    await lifecycle.closeTask;
  }

  const adapter = bunAdapter({
    hooks: {
      upgrade: async (request) => {
        const routeKind = resolveCollaborationRouteKind(request);

        if (routeKind === "presence") {
          if (!options.presenceStore) {
            return createErrorResponse(
              createCollaborationUnavailableError(
                options.unavailableDetails ?? { reason: "runtime_unavailable" },
              ),
              request,
            );
          }

          const authorization =
            await options.authGuard.authorizePresenceHandshake(request);

          if (!authorization.ok) {
            return createErrorResponse(
              createHandshakeError(
                authorization.closeCode,
                authorization.message,
              ),
              request,
            );
          }

          return {
            context: {
              kind: "presence",
              presence: authorization.context,
            },
          };
        }

        if (!options.runtime) {
          return createErrorResponse(
            createCollaborationUnavailableError(
              options.unavailableDetails ?? { reason: "runtime_unavailable" },
            ),
            request,
          );
        }

        const authorization =
          await options.authGuard.authorizeHandshake(request);

        if (!authorization.ok) {
          return createErrorResponse(
            createHandshakeError(
              authorization.closeCode,
              authorization.message,
            ),
            request,
          );
        }

        return {
          context: {
            kind: "document",
            collaboration: authorization.context,
          },
        };
      },
      open: (peer) => {
        openPeers.add(peer);
        const presenceContext = presenceContextFromPeer(peer);

        if (presenceContext) {
          const lifecycle: PresencePeerLifecycle = {
            peer,
            context: presenceContext,
            stored: false,
            counted: false,
            closing: false,
          };
          presencePeerLifecycles.set(peer, lifecycle);
          lifecycle.openTask = handlePresenceOpen(lifecycle);
          trackPresenceTask(lifecycle.openTask);
          return;
        }

        const context = collaborationContextFromPeer(peer);

        if (!context || !options.runtime) {
          peer.close(1011, "Collaboration runtime is unavailable.");
          return;
        }

        const websocket: WebSocketLike = {
          get readyState() {
            return peer.websocket.readyState ?? 3;
          },
          send(data) {
            peer.send(data);
            const closeEvent = resolveCloseEventFromOutgoingMessage(data);

            if (closeEvent) {
              peer.close(closeEvent.code, closeEvent.reason);
            }
          },
          close(code, reason) {
            peer.close(code, reason);
          },
        };
        const connection = options.runtime.server.handleConnection(
          websocket,
          peer.request,
          createRuntimeContext(peer.request, context),
        );

        peerConnections.set(peer, connection);
      },
      message: (peer: Peer, message: Message) => {
        const presenceLifecycle = presencePeerLifecycles.get(peer);

        if (presenceLifecycle) {
          trackPresenceTask(handlePresenceMessage(presenceLifecycle, message));
          return;
        }

        const context = collaborationContextFromPeer(peer);
        const flushRequest = parseCollaborationFlushRequest(message);
        const publishRequest = parseCollaborationPublishRequest(message);

        if (context && flushRequest) {
          trackDocumentTask(
            handleDocumentFlushMessage(
              peer,
              context,
              peerConnections.get(peer),
              flushRequest,
            ),
          );
          return;
        }

        if (context && publishRequest) {
          trackDocumentTask(
            handleDocumentPublishMessage(
              peer,
              context,
              peerConnections.get(peer),
              publishRequest,
            ),
          );
          return;
        }

        peerConnections.get(peer)?.handleMessage(message.uint8Array());
      },
      close: (peer, event) => {
        const presenceLifecycle = presencePeerLifecycles.get(peer);

        if (presenceLifecycle) {
          trackPresenceTask(handlePresenceClose(presenceLifecycle));
          return;
        }

        const connection = peerConnections.get(peer);
        peerConnections.delete(peer);
        openPeers.delete(peer);
        connection?.handleClose(
          event.code === undefined && event.reason === undefined
            ? undefined
            : {
                code: event.code ?? 1005,
                reason: event.reason ?? "",
              },
        );
      },
    },
  });

  return {
    handleFetchUpgrade: (request, server) => {
      if (!isCollaborationWebSocketUpgradeRequest(request)) {
        return Promise.resolve(undefined);
      }

      return adapter.handleUpgrade(request, server);
    },
    websocket: adapter.websocket,
    shutdown: async () => {
      const server = options.runtime?.server;

      server?.closeConnections?.();

      for (const peer of Array.from(openPeers)) {
        peer.close(
          COLLABORATION_SHUTDOWN_CLOSE_CODE,
          COLLABORATION_SHUTDOWN_CLOSE_REASON,
        );
      }

      await Promise.all(
        Array.from(presencePeerLifecycles.values()).map((lifecycle) =>
          handlePresenceClose(lifecycle, {
            broadcast: false,
            waitForOpen: true,
          }),
        ),
      );
      await Promise.all(Array.from(pendingPresenceTasks));
      await Promise.all(Array.from(pendingDocumentTasks));
      server?.flushPendingStores?.();
      await waitForCollaborationDocumentsToUnload(server);
      openPeers.clear();
      presenceConnectionCounts.clear();
    },
  };
}
