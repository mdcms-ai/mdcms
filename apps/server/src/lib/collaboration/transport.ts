import bunAdapter, { type BunAdapter } from "crossws/adapters/bun";
import type { Message, Peer, PeerContext } from "crossws";
import {
  IncomingMessage,
  MessageType,
  type WebSocketLike,
} from "@hocuspocus/server";
import { RuntimeError } from "@mdcms/shared";

import type {
  CollaborationCloseCode,
  CollaborationHandshakeResult,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import { toServerErrorResponse } from "../errors.js";
import { createJsonResponse, resolvePathname } from "../http-utils.js";
import { createCollaborationUnavailableError } from "./errors.js";
import type { CollaborationRuntimeContext } from "./runtime.js";

export type BunUpgradeServer = Parameters<BunAdapter["handleUpgrade"]>[1];
export type CollaborationWebSocketHandler = BunAdapter["websocket"];

type HocuspocusClientConnection = {
  handleMessage: (message: Uint8Array) => void;
  handleClose: (event?: { code: number; reason: string }) => void;
};

type HocuspocusConnectionServer = {
  handleConnection: (
    websocket: WebSocketLike,
    request: Request,
    defaultContext: CollaborationRuntimeContext,
  ) => HocuspocusClientConnection;
};

export type CollaborationAuthHandshakeGuard = {
  authorizeHandshake: (
    request: Request,
  ) => Promise<CollaborationHandshakeResult>;
};

export type CreateCollaborationWebSocketTransportOptions = {
  authGuard: CollaborationAuthHandshakeGuard;
  runtime?: { server: HocuspocusConnectionServer };
  unavailableDetails?: Record<string, unknown>;
};

export type CollaborationWebSocketTransport = {
  handleFetchUpgrade: (
    request: Request,
    server: BunUpgradeServer,
  ) => Promise<Response | undefined>;
  websocket: CollaborationWebSocketHandler;
};

const COLLABORATION_PATHNAME = "/api/v1/collaboration";
const COLLABORATION_SESSION_INVALID_REASON =
  "Collaboration session is no longer valid.";
const COLLABORATION_WRITE_FORBIDDEN_REASON =
  "Collaboration write access is no longer allowed.";

const peerConnections = new WeakMap<Peer, HocuspocusClientConnection>();

export function isCollaborationWebSocketUpgradeRequest(
  request: Request,
): boolean {
  return (
    request.method.toUpperCase() === "GET" &&
    resolvePathname(request) === COLLABORATION_PATHNAME &&
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
  const context = peer.context as PeerContext & {
    collaboration?: CollaborationSessionContext;
  };

  return context.collaboration;
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

export function createCollaborationWebSocketTransport(
  options: CreateCollaborationWebSocketTransportOptions,
): CollaborationWebSocketTransport {
  const adapter = bunAdapter({
    hooks: {
      upgrade: async (request) => {
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
            collaboration: authorization.context,
          },
        };
      },
      open: (peer) => {
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
        peerConnections.get(peer)?.handleMessage(message.uint8Array());
      },
      close: (peer, event) => {
        const connection = peerConnections.get(peer);
        peerConnections.delete(peer);
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
  };
}
