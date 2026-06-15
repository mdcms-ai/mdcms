import {
  CollaborationPresenceSnapshotSchema,
  type CollaborationPresenceSnapshot,
  type CollaborationPresenceUser,
} from "@mdcms/shared";

import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export type CreatePresenceWebSocketUrlInput = {
  serverUrl: string;
  project: string;
  environment: string;
};

export type CreatePresenceConnectionKeyInput = {
  webSocketUrl: string;
  currentSessionId: string;
};

export type GroupPresenceByDocumentOptions = {
  visibleDocumentIds: Iterable<string>;
  currentSessionId?: string | null;
};

export const PRESENCE_HEARTBEAT_INTERVAL_MS = 20_000;

export function createPresenceConnectionKey({
  webSocketUrl,
  currentSessionId,
}: CreatePresenceConnectionKeyInput): string {
  return `${webSocketUrl}\u0000${currentSessionId}`;
}

export function createPresenceWebSocketUrl({
  serverUrl,
  project,
  environment,
}: CreatePresenceWebSocketUrlInput): string {
  const url = resolveStudioRelativeUrl(
    "/api/v1/collaboration/presence",
    serverUrl,
  );

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }

  url.searchParams.set("project", project);
  url.searchParams.set("environment", environment);

  return url.href;
}

function parsePresencePayload(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  return raw;
}

export function parsePresenceSnapshot(
  raw: unknown,
): CollaborationPresenceSnapshot | null {
  const parsed = CollaborationPresenceSnapshotSchema.safeParse(
    parsePresencePayload(raw),
  );

  return parsed.success ? parsed.data : null;
}

function comparePresenceUsers(
  left: CollaborationPresenceUser,
  right: CollaborationPresenceUser,
): number {
  if (left.mode !== right.mode) {
    return left.mode === "edit" ? -1 : 1;
  }

  const labelComparison = left.label.localeCompare(right.label);
  if (labelComparison !== 0) {
    return labelComparison;
  }

  return left.sessionId.localeCompare(right.sessionId);
}

export function groupPresenceByDocument(
  users: CollaborationPresenceUser[],
  { visibleDocumentIds, currentSessionId }: GroupPresenceByDocumentOptions,
): Map<string, CollaborationPresenceUser[]> {
  const visible = new Set(visibleDocumentIds);
  const grouped = new Map<string, CollaborationPresenceUser[]>();

  for (const user of users) {
    if (!user.documentId) {
      continue;
    }

    if (!visible.has(user.documentId)) {
      continue;
    }

    if (currentSessionId && user.sessionId === currentSessionId) {
      continue;
    }

    const group = grouped.get(user.documentId) ?? [];
    group.push(user);
    grouped.set(user.documentId, group);
  }

  for (const group of grouped.values()) {
    group.sort(comparePresenceUsers);
  }

  return grouped;
}
