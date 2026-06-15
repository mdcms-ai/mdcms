"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CollaborationPresenceCursor,
  CollaborationPresenceMode,
  CollaborationPresenceSnapshot,
  CollaborationPresenceUpdate,
} from "@mdcms/shared";

import {
  createPresenceConnectionKey,
  createPresenceWebSocketUrl,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  parsePresenceSnapshot,
} from "../lib/collaboration-presence.js";
import {
  getCollaborationReconnectDelayMs,
  isCollaborationCloseRetryable,
} from "../lib/collaboration-reconnect.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";

export type CollaborationPresenceConnectionStatus =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "open"
  | "closed"
  | "error";

export type UseCollaborationPresenceInput = {
  documentId?: string | null;
  mode: CollaborationPresenceMode;
  cursor?: CollaborationPresenceCursor | null;
};

export type UseCollaborationPresenceResult = {
  status: CollaborationPresenceConnectionStatus;
  snapshot: CollaborationPresenceSnapshot | null;
  currentSessionId: string | null;
};

export function useCollaborationPresence({
  documentId,
  mode,
  cursor,
}: UseCollaborationPresenceInput): UseCollaborationPresenceResult {
  const mountInfo = useStudioMountInfo();
  const sessionState = useStudioSession();
  const socketRef = useRef<WebSocket | null>(null);
  const updateMessageRef = useRef<string>("");
  const [status, setStatus] =
    useState<CollaborationPresenceConnectionStatus>("idle");
  const [snapshot, setSnapshot] =
    useState<CollaborationPresenceSnapshot | null>(null);

  const currentSessionId =
    sessionState.status === "authenticated" ? sessionState.session.id : null;
  const project = mountInfo.project;
  const environment = mountInfo.environment;
  const serverUrl = mountInfo.apiBaseUrl;
  const canConnect =
    mountInfo.auth.mode === "cookie" &&
    sessionState.status === "authenticated" &&
    Boolean(project) &&
    Boolean(environment) &&
    serverUrl.length > 0;

  const webSocketUrl = useMemo(() => {
    if (!canConnect || !project || !environment) {
      return null;
    }

    return createPresenceWebSocketUrl({
      serverUrl,
      project,
      environment,
    });
  }, [canConnect, environment, project, serverUrl]);
  const connectionKey = useMemo(() => {
    if (!webSocketUrl || !currentSessionId) {
      return null;
    }

    return createPresenceConnectionKey({
      webSocketUrl,
      currentSessionId,
    });
  }, [currentSessionId, webSocketUrl]);

  const updateMessage = useMemo(() => {
    const update: CollaborationPresenceUpdate = {
      type: "presence.update",
      mode,
    };

    if (documentId !== undefined) {
      update.documentId = documentId;
    }

    if (cursor !== undefined) {
      update.cursor = cursor;
    }

    return JSON.stringify(update);
  }, [cursor === null, cursor?.anchor, cursor?.head, documentId, mode]);

  useEffect(() => {
    updateMessageRef.current = updateMessage;

    const socket = socketRef.current;
    if (
      !socket ||
      typeof WebSocket === "undefined" ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    socket.send(updateMessage);
  }, [updateMessage]);

  useEffect(() => {
    if (!connectionKey || !webSocketUrl || typeof WebSocket === "undefined") {
      setSnapshot(null);
      setStatus("idle");
      return;
    }

    let disposed = false;
    let reconnectAttempt = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    setSnapshot(null);

    const clearReconnect = () => {
      if (reconnectTimeout !== undefined) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = undefined;
      }
    };

    const sendPresenceUpdate = (socket: WebSocket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(updateMessageRef.current);
      }
    };

    const clearHeartbeat = () => {
      if (heartbeatInterval !== undefined) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed) {
        return;
      }

      const delayMs = getCollaborationReconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      setSnapshot(null);
      setStatus("reconnecting");
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = undefined;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      const socket = new WebSocket(webSocketUrl);
      socketRef.current = socket;
      setStatus(reconnectAttempt === 0 ? "connecting" : "reconnecting");

      socket.addEventListener("open", () => {
        if (disposed) {
          return;
        }

        reconnectAttempt = 0;
        setStatus("open");
        sendPresenceUpdate(socket);
        heartbeatInterval = setInterval(
          () => sendPresenceUpdate(socket),
          PRESENCE_HEARTBEAT_INTERVAL_MS,
        );
      });

      socket.addEventListener("message", (event) => {
        if (disposed) {
          return;
        }

        const nextSnapshot = parsePresenceSnapshot(event.data);
        if (nextSnapshot) {
          setSnapshot(nextSnapshot);
        }
      });

      socket.addEventListener("error", () => {
        if (disposed) {
          return;
        }

        setStatus("reconnecting");
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      });

      socket.addEventListener("close", (event) => {
        if (disposed) {
          return;
        }

        clearHeartbeat();
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (isCollaborationCloseRetryable({ code: event.code })) {
          scheduleReconnect();
        } else {
          setSnapshot(null);
          setStatus("error");
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      clearHeartbeat();
      clearReconnect();
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
    };
  }, [connectionKey, webSocketUrl]);

  return {
    currentSessionId,
    snapshot,
    status,
  };
}
