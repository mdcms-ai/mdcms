import * as decoding from "lib0/decoding.js";
import * as encoding from "lib0/encoding.js";
import * as syncProtocol from "y-protocols/sync.js";
import type * as Y from "yjs";

import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export const COLLABORATION_DOCUMENT_FIELD_NAME = "default";
export const COLLABORATION_FRONTMATTER_FIELD_NAME = "frontmatter";

const HOCUSPOCUS_MESSAGE_SYNC = 0;
const HOCUSPOCUS_MESSAGE_AUTH = 2;
const HOCUSPOCUS_MESSAGE_SYNC_REPLY = 4;
const HOCUSPOCUS_MESSAGE_CLOSE = 7;
const HOCUSPOCUS_MESSAGE_SYNC_STATUS = 8;

const HOCUSPOCUS_AUTH_TOKEN = 0;
const HOCUSPOCUS_AUTH_PERMISSION_DENIED = 1;
const HOCUSPOCUS_AUTH_AUTHENTICATED = 2;

export type CreateDocumentCollaborationWebSocketUrlInput = {
  serverUrl: string;
  project: string;
  environment: string;
  documentId: string;
};

export type CreateCollaborationDocumentConnectionKeyInput = {
  webSocketUrl: string;
  documentName: string;
};

export type CreateCollaborationDocumentNameInput = {
  project: string;
  environment: string;
  documentId: string;
};

export type CollaborationSyncMessageResult =
  | { type: "sync" }
  | { type: "authenticated"; readonly: boolean }
  | { type: "permission-denied"; reason: string }
  | { type: "token-requested" }
  | { type: "sync-status" }
  | { type: "close"; reason: string }
  | { type: "ignored" };

export type CollaborationFlushResult =
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

export function createCollaborationDocumentName({
  project,
  environment,
  documentId,
}: CreateCollaborationDocumentNameInput): string {
  return `${project}:${environment}:${documentId}`;
}

export function createCollaborationDocumentConnectionKey({
  webSocketUrl,
  documentName,
}: CreateCollaborationDocumentConnectionKeyInput): string {
  return `${webSocketUrl}\u0000${documentName}`;
}

export function createDocumentCollaborationWebSocketUrl({
  serverUrl,
  project,
  environment,
  documentId,
}: CreateDocumentCollaborationWebSocketUrlInput): string {
  const url = resolveStudioRelativeUrl("/api/v1/collaboration", serverUrl);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    url.protocol = "ws:";
  }

  url.searchParams.set("project", project);
  url.searchParams.set("environment", environment);
  url.searchParams.set("documentId", documentId);

  return url.href;
}

function createHocuspocusMessageEncoder(
  documentName: string,
  messageType: number,
): encoding.Encoder {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, messageType);
  return encoder;
}

export function encodeCollaborationAuthMessage(
  documentName: string,
): Uint8Array {
  const encoder = createHocuspocusMessageEncoder(
    documentName,
    HOCUSPOCUS_MESSAGE_AUTH,
  );
  encoding.writeVarUint(encoder, HOCUSPOCUS_AUTH_TOKEN);
  encoding.writeVarString(encoder, "");
  return encoding.toUint8Array(encoder);
}

export function encodeCollaborationSyncStep1Message(
  documentName: string,
  document: Y.Doc,
): Uint8Array {
  const encoder = createHocuspocusMessageEncoder(
    documentName,
    HOCUSPOCUS_MESSAGE_SYNC,
  );
  syncProtocol.writeSyncStep1(encoder, document);
  return encoding.toUint8Array(encoder);
}

export function encodeCollaborationUpdateMessage(
  documentName: string,
  update: Uint8Array,
): Uint8Array {
  const encoder = createHocuspocusMessageEncoder(
    documentName,
    HOCUSPOCUS_MESSAGE_SYNC,
  );
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function handleCollaborationSyncMessage({
  documentName,
  document,
  data,
  send,
  transactionOrigin = null,
}: {
  documentName: string;
  document: Y.Doc;
  data: Uint8Array;
  send: (data: Uint8Array) => void;
  transactionOrigin?: unknown;
}): CollaborationSyncMessageResult {
  const decoder = decoding.createDecoder(data);
  const messageDocumentName = decoding.readVarString(decoder);

  if (messageDocumentName !== documentName) {
    return { type: "ignored" };
  }

  const messageType = decoding.readVarUint(decoder);

  if (
    messageType === HOCUSPOCUS_MESSAGE_SYNC ||
    messageType === HOCUSPOCUS_MESSAGE_SYNC_REPLY
  ) {
    const replyEncoder = createHocuspocusMessageEncoder(
      documentName,
      HOCUSPOCUS_MESSAGE_SYNC,
    );
    const replyStartLength = encoding.length(replyEncoder);
    syncProtocol.readSyncMessage(
      decoder,
      replyEncoder,
      document,
      transactionOrigin,
    );

    if (encoding.length(replyEncoder) > replyStartLength) {
      send(encoding.toUint8Array(replyEncoder));
    }

    return { type: "sync" };
  }

  if (messageType === HOCUSPOCUS_MESSAGE_AUTH) {
    const authType = decoding.readVarUint(decoder);

    if (authType === HOCUSPOCUS_AUTH_AUTHENTICATED) {
      return {
        type: "authenticated",
        readonly: decoding.readVarString(decoder) === "readonly",
      };
    }

    if (authType === HOCUSPOCUS_AUTH_PERMISSION_DENIED) {
      return {
        type: "permission-denied",
        reason: decoding.readVarString(decoder),
      };
    }

    if (authType === HOCUSPOCUS_AUTH_TOKEN) {
      return { type: "token-requested" };
    }
  }

  if (messageType === HOCUSPOCUS_MESSAGE_CLOSE) {
    return { type: "close", reason: decoding.readVarString(decoder) };
  }

  if (messageType === HOCUSPOCUS_MESSAGE_SYNC_STATUS) {
    return { type: "sync-status" };
  }

  return { type: "ignored" };
}

export function createCollaborationFlushRequest(requestId: string): string {
  return JSON.stringify({
    type: "mdcms.collaboration.flush",
    requestId,
  });
}

export function parseCollaborationFlushResult(
  raw: unknown,
): CollaborationFlushResult | null {
  if (typeof raw !== "string") {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as { type?: unknown }).type !==
      "mdcms.collaboration.flush.result" ||
    typeof (payload as { requestId?: unknown }).requestId !== "string"
  ) {
    return null;
  }

  const status = (payload as { status?: unknown }).status;

  if (
    (status === "saved" || status === "unchanged") &&
    typeof (payload as { draftRevision?: unknown }).draftRevision === "number"
  ) {
    return payload as CollaborationFlushResult;
  }

  if (
    status === "error" &&
    typeof (payload as { code?: unknown }).code === "string" &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    return payload as CollaborationFlushResult;
  }

  return null;
}
