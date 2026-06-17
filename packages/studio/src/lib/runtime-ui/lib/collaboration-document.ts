import * as decoding from "lib0/decoding.js";
import * as encoding from "lib0/encoding.js";
import * as syncProtocol from "y-protocols/sync.js";
import type { ContentDocumentResponse } from "@mdcms/shared";
import type * as Y from "yjs";
import { z } from "zod";

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

export type CollaborationPublishResult =
  | {
      type: "mdcms.collaboration.publish.result";
      requestId: string;
      status: "published";
      document: ContentDocumentResponse;
    }
  | {
      type: "mdcms.collaboration.publish.result";
      requestId: string;
      status: "error";
      code: string;
      message: string;
    };

const CollaborationFlushResultSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("mdcms.collaboration.flush.result"),
    requestId: z.string(),
    status: z.enum(["saved", "unchanged"]),
    draftRevision: z.number(),
  }),
  z.object({
    type: z.literal("mdcms.collaboration.flush.result"),
    requestId: z.string(),
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

const ContentReferenceResolveErrorSchema = z.object({
  code: z.enum([
    "REFERENCE_NOT_FOUND",
    "REFERENCE_DELETED",
    "REFERENCE_TYPE_MISMATCH",
    "REFERENCE_FORBIDDEN",
  ]),
  message: z.string(),
  ref: z.object({
    documentId: z.string(),
    type: z.string(),
  }),
});

const ContentMediaResolveErrorSchema = z.object({
  code: z.enum(["MEDIA_NOT_FOUND", "MEDIA_TYPE_MISMATCH"]),
  message: z.string(),
  media: z.object({
    assetId: z.string(),
    expectedMime: z.array(z.string()).optional(),
    actualMimeType: z.string().optional(),
  }),
});

const ContentResolveErrorSchema = z.discriminatedUnion("code", [
  ContentReferenceResolveErrorSchema,
  ContentMediaResolveErrorSchema,
]);

const ContentDocumentResponseSchema = z.object({
  documentId: z.string(),
  translationGroupId: z.string(),
  project: z.string(),
  environment: z.string(),
  path: z.string(),
  type: z.string(),
  locale: z.string(),
  format: z.enum(["md", "mdx"]),
  isDeleted: z.boolean(),
  hasUnpublishedChanges: z.boolean(),
  version: z.number(),
  publishedVersion: z.number().nullable(),
  draftRevision: z.number(),
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  resolveErrors: z.record(z.string(), ContentResolveErrorSchema).optional(),
  localesPresent: z.array(z.string()).optional(),
  publishedLocales: z.array(z.string()).optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

const CollaborationPublishResultSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("mdcms.collaboration.publish.result"),
    requestId: z.string(),
    status: z.literal("published"),
    document: ContentDocumentResponseSchema,
  }),
  z.object({
    type: z.literal("mdcms.collaboration.publish.result"),
    requestId: z.string(),
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);

function encodeCollaborationDocumentNameSegment(segment: string): string {
  return encodeURIComponent(segment);
}

export function createCollaborationDocumentName({
  project,
  environment,
  documentId,
}: CreateCollaborationDocumentNameInput): string {
  return [
    encodeCollaborationDocumentNameSegment(project),
    encodeCollaborationDocumentNameSegment(environment),
    encodeCollaborationDocumentNameSegment(documentId),
  ].join(":");
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

export function createCollaborationPublishRequest(input: {
  requestId: string;
  changeSummary?: string;
}): string {
  return JSON.stringify({
    type: "mdcms.collaboration.publish",
    requestId: input.requestId,
    ...(input.changeSummary !== undefined
      ? { changeSummary: input.changeSummary }
      : {}),
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

  const result = CollaborationFlushResultSchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function parseCollaborationPublishResult(
  raw: unknown,
): CollaborationPublishResult | null {
  if (typeof raw !== "string") {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const result = CollaborationPublishResultSchema.safeParse(payload);
  return result.success ? (result.data as CollaborationPublishResult) : null;
}
