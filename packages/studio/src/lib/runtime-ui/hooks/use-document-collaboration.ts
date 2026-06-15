"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";

import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";
import {
  COLLABORATION_DOCUMENT_FIELD_NAME,
  COLLABORATION_FRONTMATTER_FIELD_NAME,
  createCollaborationDocumentConnectionKey,
  createCollaborationDocumentName,
  createCollaborationFlushRequest,
  createDocumentCollaborationWebSocketUrl,
  encodeCollaborationAuthMessage,
  encodeCollaborationSyncStep1Message,
  encodeCollaborationUpdateMessage,
  handleCollaborationSyncMessage,
  parseCollaborationFlushResult,
  type CollaborationFlushResult,
} from "../lib/collaboration-document.js";

export type DocumentCollaborationConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type UseDocumentCollaborationInput = {
  enabled: boolean;
  documentId?: string | null;
};

export type UseDocumentCollaborationResult = {
  enabled: boolean;
  status: DocumentCollaborationConnectionStatus;
  documentName: string | null;
  document: Y.Doc | null;
  body: Y.XmlFragment | null;
  frontmatter: Y.Map<unknown> | null;
  flush: () => Promise<CollaborationFlushResult>;
};

type CollaborationDocumentState = {
  connectionKey: string;
  documentName: string;
  document: Y.Doc;
  body: Y.XmlFragment;
  frontmatter: Y.Map<unknown>;
};

type PendingFlush = {
  resolve: (result: CollaborationFlushResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const SOCKET_UPDATE_ORIGIN = { source: "mdcms-document-socket" };
const COLLABORATION_FLUSH_TIMEOUT_MS = 10_000;

function createFlushRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `flush-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rejectPendingFlushes(
  pendingFlushes: Map<string, PendingFlush>,
  error: Error,
): void {
  for (const pending of pendingFlushes.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  pendingFlushes.clear();
}

async function readWebSocketMessageData(
  data: MessageEvent["data"],
): Promise<string | Uint8Array | null> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof Uint8Array) {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  return null;
}

export function useDocumentCollaboration({
  enabled,
  documentId,
}: UseDocumentCollaborationInput): UseDocumentCollaborationResult {
  const mountInfo = useStudioMountInfo();
  const sessionState = useStudioSession();
  const socketRef = useRef<WebSocket | null>(null);
  const pendingFlushesRef = useRef(new Map<string, PendingFlush>());
  const [status, setStatus] =
    useState<DocumentCollaborationConnectionStatus>("idle");

  const project = mountInfo.project;
  const environment = mountInfo.environment;
  const serverUrl = mountInfo.apiBaseUrl;
  const canConnect =
    enabled &&
    mountInfo.auth.mode === "cookie" &&
    sessionState.status === "authenticated" &&
    Boolean(project) &&
    Boolean(environment) &&
    Boolean(documentId) &&
    serverUrl.length > 0;

  const connectionConfig = useMemo(() => {
    if (!canConnect || !project || !environment || !documentId) {
      return null;
    }

    const webSocketUrl = createDocumentCollaborationWebSocketUrl({
      serverUrl,
      project,
      environment,
      documentId,
    });
    const documentName = createCollaborationDocumentName({
      project,
      environment,
      documentId,
    });

    return {
      webSocketUrl,
      documentName,
      connectionKey: createCollaborationDocumentConnectionKey({
        webSocketUrl,
        documentName,
      }),
    };
  }, [canConnect, documentId, environment, project, serverUrl]);

  const documentState = useMemo<CollaborationDocumentState | null>(() => {
    if (!connectionConfig) {
      return null;
    }

    const document = new Y.Doc();

    return {
      connectionKey: connectionConfig.connectionKey,
      documentName: connectionConfig.documentName,
      document,
      body: document.getXmlFragment(COLLABORATION_DOCUMENT_FIELD_NAME),
      frontmatter: document.getMap(COLLABORATION_FRONTMATTER_FIELD_NAME),
    };
  }, [connectionConfig]);

  useEffect(
    () => () => {
      documentState?.document.destroy();
    },
    [documentState],
  );

  useEffect(() => {
    if (
      !connectionConfig ||
      !documentState ||
      typeof WebSocket === "undefined"
    ) {
      rejectPendingFlushes(
        pendingFlushesRef.current,
        new Error("Document collaboration is not connected."),
      );
      socketRef.current = null;
      setStatus("idle");
      return;
    }

    let disposed = false;
    const socket = new WebSocket(connectionConfig.webSocketUrl);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    setStatus("connecting");

    const sendIfOpen = (data: Uint8Array | string) => {
      if (!disposed && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    };

    const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === SOCKET_UPDATE_ORIGIN) {
        return;
      }

      sendIfOpen(
        encodeCollaborationUpdateMessage(connectionConfig.documentName, update),
      );
    };

    documentState.document.on("update", onLocalUpdate);

    socket.onopen = () => {
      if (disposed) {
        return;
      }

      socket.send(
        encodeCollaborationAuthMessage(connectionConfig.documentName),
      );
      socket.send(
        encodeCollaborationSyncStep1Message(
          connectionConfig.documentName,
          documentState.document,
        ),
      );
    };

    socket.onmessage = (event) => {
      void (async () => {
        const data = await readWebSocketMessageData(event.data);

        if (disposed || data === null) {
          return;
        }

        if (typeof data === "string") {
          const flushResult = parseCollaborationFlushResult(data);

          if (flushResult) {
            const pending = pendingFlushesRef.current.get(
              flushResult.requestId,
            );

            if (pending) {
              clearTimeout(pending.timeout);
              pendingFlushesRef.current.delete(flushResult.requestId);
              pending.resolve(flushResult);
            }
          }

          return;
        }

        const result = handleCollaborationSyncMessage({
          documentName: connectionConfig.documentName,
          document: documentState.document,
          data,
          transactionOrigin: SOCKET_UPDATE_ORIGIN,
          send: sendIfOpen,
        });

        if (result.type === "sync") {
          setStatus("open");
        }

        if (result.type === "permission-denied" || result.type === "close") {
          setStatus("error");
        }
      })();
    };

    socket.onclose = () => {
      if (disposed) {
        return;
      }

      setStatus("closed");
      rejectPendingFlushes(
        pendingFlushesRef.current,
        new Error("Document collaboration socket closed."),
      );
    };

    socket.onerror = () => {
      if (disposed) {
        return;
      }

      setStatus("error");
      rejectPendingFlushes(
        pendingFlushesRef.current,
        new Error("Document collaboration socket failed."),
      );
    };

    return () => {
      disposed = true;
      documentState.document.off("update", onLocalUpdate);
      rejectPendingFlushes(
        pendingFlushesRef.current,
        new Error("Document collaboration disconnected."),
      );

      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }

      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [connectionConfig, documentState]);

  const flush = useCallback(() => {
    const socket = socketRef.current;

    if (
      !socket ||
      typeof WebSocket === "undefined" ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(
        new Error("Document collaboration is not connected."),
      );
    }

    const requestId = createFlushRequestId();

    return new Promise<CollaborationFlushResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingFlushesRef.current.delete(requestId);
        reject(new Error("Timed out waiting for collaboration flush."));
      }, COLLABORATION_FLUSH_TIMEOUT_MS);

      pendingFlushesRef.current.set(requestId, {
        resolve,
        reject,
        timeout,
      });

      socket.send(createCollaborationFlushRequest(requestId));
    });
  }, []);

  return {
    enabled: Boolean(connectionConfig && documentState),
    status,
    documentName: documentState?.documentName ?? null,
    document: documentState?.document ?? null,
    body: documentState?.body ?? null,
    frontmatter: documentState?.frontmatter ?? null,
    flush,
  };
}
