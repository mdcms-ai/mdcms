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
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";

export type CollaborationPresenceConnectionStatus =
  | "idle"
  | "connecting"
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
    const socket = new WebSocket(webSocketUrl);
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
    socketRef.current = socket;
    setSnapshot(null);
    setStatus("connecting");

    const sendPresenceUpdate = () => {
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

    socket.addEventListener("open", () => {
      if (disposed) {
        return;
      }

      setStatus("open");
      sendPresenceUpdate();
      heartbeatInterval = setInterval(
        sendPresenceUpdate,
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

      setStatus("error");
    });

    socket.addEventListener("close", () => {
      if (disposed) {
        return;
      }

      clearHeartbeat();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setStatus("closed");
    });

    return () => {
      disposed = true;
      clearHeartbeat();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [connectionKey, webSocketUrl]);

  return {
    currentSessionId,
    snapshot,
    status,
  };
}
