import { createHash, randomUUID } from "node:crypto";

import { Hocuspocus, type Configuration } from "@hocuspocus/server";
import { TiptapTransformer } from "@hocuspocus/transformer";
import {
  createEditorCoreExtensions,
  parseMarkdownToDocument,
  serializeDocumentToMarkdown,
} from "@mdcms/editor-core";
import { RuntimeError } from "@mdcms/shared";
import * as Y from "yjs";

import type {
  CollaborationCloseCode,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import type {
  ContentDocument,
  ContentLifecycleEventSink,
  ContentScope,
} from "../content-api/types.js";

import {
  createCollaborationUnavailableError,
  createDocumentCollaborationActiveError,
} from "./errors.js";
import {
  COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
  COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
  createCollaborationRedisStore,
  type CollaborationRedisDependency,
  type CollaborationYjsMetadata,
  type FreshCollaborationYjsState,
} from "./redis-store.js";

export const COLLABORATION_HOCUSPOCUS_DEBOUNCE_MS = 2000;
export const COLLABORATION_HOCUSPOCUS_MAX_DEBOUNCE_MS = 10000;
export const COLLABORATION_ACTIVE_LOCK_HEARTBEAT_INTERVAL_MS = Math.floor(
  (COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS * 1000) / 3,
);
export const COLLABORATION_FINALIZED_ROOM_LEASE_TTL_MS =
  COLLABORATION_INACTIVE_CACHE_TTL_SECONDS * 1000;
export const COLLABORATION_YJS_FIELD_NAME = "default";

export type CollaborationRuntimeLastWriter = {
  userId: string;
  email?: string;
};

export type CollaborationRuntimeContext = CollaborationSessionContext & {
  userEmail?: string;
  loadedDraftRevision?: number;
  loadedBodyHash?: string;
  loadedCanonicalBody?: string;
  roomLeaseValue?: string;
  lastWriter?: CollaborationRuntimeLastWriter;
  request?: Request;
};

export type CollaborationRuntimeAuthGuard = {
  revalidateWrite: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
};

export type CollaborationRuntimeContentStore = {
  getById: (
    scope: ContentScope,
    documentId: string,
    options?: { draft?: boolean },
  ) => Promise<ContentDocument | undefined>;
  update: (
    scope: ContentScope,
    documentId: string,
    payload: { body: string; updatedBy: string },
    options?: { expectedDraftRevision?: number },
  ) => Promise<ContentDocument>;
};

export type CollaborationRuntimeRedisStore = {
  getFreshYjsState: (
    documentId: string,
    draftHead: { draftRevision: number; bodyHash: string },
  ) => Promise<FreshCollaborationYjsState | null>;
  setYjsState: (documentId: string, state: Uint8Array) => Promise<void>;
  setYjsMetadata: (
    documentId: string,
    metadata: CollaborationYjsMetadata,
  ) => Promise<void>;
  clearInactiveCacheTtl: (documentId: string) => Promise<void>;
  acquireActiveLock: (
    documentId: string,
    leaseValue: string,
  ) => Promise<boolean>;
  heartbeatActiveLock: (
    documentId: string,
    leaseValue: string,
  ) => Promise<boolean>;
  releaseActiveLock: (
    documentId: string,
    leaseValue: string,
  ) => Promise<boolean>;
  finalizeInactiveRoom: (
    documentId: string,
    leaseValue: string,
  ) => Promise<boolean>;
};

type RoomState = {
  documentId: string;
  documentName: string;
  loadedDraftRevision: number;
  loadedBodyHash: string;
  loadedCanonicalBody: string;
  roomLeaseValue: string;
  lastWriter?: CollaborationRuntimeLastWriter;
  activeLockHeartbeatInFlight?: boolean;
  activeLockHeartbeatTimer?: unknown;
  activeLockLost?: boolean;
};

type FinalizedRoomLease = {
  expiresAt: number;
  leaseValue: string;
  timeout?: unknown;
};

export type CreateCollaborationRuntimeHooksOptions = {
  contentStore: CollaborationRuntimeContentStore;
  redisStore: CollaborationRuntimeRedisStore;
  authGuard: CollaborationRuntimeAuthGuard;
  lifecycleEvents?: ContentLifecycleEventSink;
  activeLockHeartbeatIntervalMs?: number;
  setActiveLockHeartbeat?: (
    callback: () => Promise<void> | void,
    intervalMs: number,
  ) => unknown;
  clearActiveLockHeartbeat?: (timer: unknown) => void;
  finalizedRoomLeaseTtlMs?: number;
  setFinalizedRoomLeaseTimeout?: (
    callback: () => void,
    timeoutMs: number,
  ) => unknown;
  clearFinalizedRoomLeaseTimeout?: (timer: unknown) => void;
  closeRoom?: (documentName: string) => Promise<void> | void;
  createRoomLeaseValue?: () => string;
  convertMarkdownToYjsUpdate?: (markdown: string) => Uint8Array;
};

export type CreateCollaborationRuntimeOptions = Omit<
  CreateCollaborationRuntimeHooksOptions,
  "redisStore"
> & {
  redisStore?: CollaborationRuntimeRedisStore;
  redisDependency?: CollaborationRedisDependency;
};

export type CollaborationRuntimeHooks = ReturnType<
  typeof createCollaborationRuntimeHooks
>;

export type CollaborationRuntime = {
  config: Partial<Configuration<CollaborationRuntimeContext>>;
  hooks: CollaborationRuntimeHooks;
  server: Hocuspocus<CollaborationRuntimeContext>;
};

type RuntimeHookPayload = {
  context?: CollaborationRuntimeContext;
  documentName: string;
  document?: Y.Doc;
  clientsCount?: number;
  update?: Uint8Array;
  request?: Request;
  requestHeaders?: Headers;
  requestParameters?: URLSearchParams;
  lastContext?: CollaborationRuntimeContext;
};

export function computeCollaborationBodyHash(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

export function encodeYDocState(document: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(document);
}

export function yjsUpdateToYDoc(update: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, update);
  return document;
}

export function markdownToYDoc(markdown: string): Y.Doc {
  const tiptapDocument = parseMarkdownToDocument(markdown);
  return TiptapTransformer.toYdoc(
    tiptapDocument,
    COLLABORATION_YJS_FIELD_NAME,
    createEditorCoreExtensions(),
  );
}

export function markdownToYjsUpdate(markdown: string): Uint8Array {
  return encodeYDocState(markdownToYDoc(markdown));
}

export function yDocToMarkdown(document: Y.Doc): string {
  const tiptapDocument = TiptapTransformer.fromYdoc(
    document,
    COLLABORATION_YJS_FIELD_NAME,
  ) as Parameters<typeof serializeDocumentToMarkdown>[0];

  return serializeDocumentToMarkdown(tiptapDocument);
}

export function yjsUpdateToMarkdown(update: Uint8Array): string {
  return yDocToMarkdown(yjsUpdateToYDoc(update));
}

function canonicalizeMarkdownUpdate(update: Uint8Array): string {
  return yjsUpdateToMarkdown(update);
}

export function createCollaborationDocumentName(input: {
  project: string;
  environment: string;
  documentId: string;
}): string {
  return `${input.project}:${input.environment}:${input.documentId}`;
}

function parseCollaborationDocumentName(
  documentName: string,
): Partial<
  Pick<CollaborationRuntimeContext, "project" | "environment" | "documentId">
> {
  const colonParts = documentName.split(":");
  if (colonParts.length === 3) {
    return {
      project: colonParts[0],
      environment: colonParts[1],
      documentId: colonParts[2],
    };
  }

  const slashParts = documentName.split("/");
  if (slashParts.length === 3) {
    return {
      project: slashParts[0],
      environment: slashParts[1],
      documentId: slashParts[2],
    };
  }

  return {
    documentId: documentName,
  };
}

function requireRuntimeContext(
  payload: RuntimeHookPayload,
): CollaborationRuntimeContext {
  const context = payload.context ?? payload.lastContext;

  if (!context) {
    throw new RuntimeError({
      code: "INVALID_COLLABORATION_CONTEXT",
      message: "Collaboration hook is missing authenticated room context.",
      statusCode: 500,
      details: {
        documentName: payload.documentName,
      },
    });
  }

  const room = parseCollaborationDocumentName(payload.documentName);
  const mismatches: Record<string, { expected: string; actual: string }> = {};

  if (room.project && room.project !== context.project) {
    mismatches.project = {
      expected: context.project,
      actual: room.project,
    };
  }

  if (room.environment && room.environment !== context.environment) {
    mismatches.environment = {
      expected: context.environment,
      actual: room.environment,
    };
  }

  if (room.documentId && room.documentId !== context.documentId) {
    mismatches.documentId = {
      expected: context.documentId,
      actual: room.documentId,
    };
  }

  if (Object.keys(mismatches).length > 0) {
    throw new RuntimeError({
      code: "COLLABORATION_ROOM_MISMATCH",
      message:
        "Collaboration room name does not match the authenticated context.",
      statusCode: 403,
      details: {
        documentName: payload.documentName,
        mismatches,
      },
    });
  }

  return context;
}

function roomKey(context: CollaborationRuntimeContext): string {
  return createCollaborationDocumentName({
    project: context.project,
    environment: context.environment,
    documentId: context.documentId,
  });
}

function scopeFromContext(context: CollaborationRuntimeContext): ContentScope {
  return {
    project: context.project,
    environment: context.environment,
  };
}

async function loadDraftDocument(
  contentStore: CollaborationRuntimeContentStore,
  context: CollaborationRuntimeContext,
): Promise<ContentDocument> {
  const document = await contentStore.getById(
    scopeFromContext(context),
    context.documentId,
    { draft: true },
  );

  if (!document || document.isDeleted) {
    throw new RuntimeError({
      code: "NOT_FOUND",
      message: "Collaboration target document was not found.",
      statusCode: 404,
      details: {
        documentId: context.documentId,
      },
    });
  }

  return document;
}

function assignLoadedRoomState(
  context: CollaborationRuntimeContext,
  state: RoomState,
): void {
  context.loadedDraftRevision = state.loadedDraftRevision;
  context.loadedBodyHash = state.loadedBodyHash;
  context.loadedCanonicalBody = state.loadedCanonicalBody;
  context.roomLeaseValue = state.roomLeaseValue;
  context.lastWriter = state.lastWriter;
}

function createCloseEvent(closeCode: CollaborationCloseCode): {
  code: CollaborationCloseCode;
  reason: string;
} {
  return {
    code: closeCode,
    reason:
      closeCode === 4401
        ? "Collaboration session is no longer valid."
        : "Collaboration write access is no longer allowed.",
  };
}

function createRequestForRevalidation(
  payload: RuntimeHookPayload,
  context: CollaborationRuntimeContext,
): Request {
  if (payload.request) {
    return payload.request;
  }

  if (context.request) {
    return context.request;
  }

  const url = new URL("http://mdcms.local/api/v1/collaboration");
  url.searchParams.set("project", context.project);
  url.searchParams.set("environment", context.environment);
  url.searchParams.set("documentId", context.documentId);

  return new Request(url, {
    headers: payload.requestHeaders ?? new Headers(),
  });
}

function resolveRedisStore(
  options: CreateCollaborationRuntimeOptions,
): CollaborationRuntimeRedisStore {
  if (options.redisStore) {
    return options.redisStore;
  }

  if (!options.redisDependency) {
    throw createCollaborationUnavailableError({
      reason: "missing_redis_dependency",
    });
  }

  if (options.redisDependency.status === "unavailable") {
    throw createCollaborationUnavailableError({
      reason: options.redisDependency.reason,
      errorMessage:
        options.redisDependency.error instanceof Error
          ? options.redisDependency.error.message
          : undefined,
    });
  }

  return createCollaborationRedisStore(options.redisDependency);
}

function updateLastWriter(
  roomStates: Map<string, RoomState>,
  context: CollaborationRuntimeContext,
): void {
  const writer = {
    userId: context.userId,
    ...(context.userEmail ? { email: context.userEmail } : {}),
  };
  const state = roomStates.get(roomKey(context));

  if (state) {
    state.lastWriter = writer;
  }

  context.lastWriter = writer;
}

function createLifecycleActor(writer: CollaborationRuntimeLastWriter): {
  id: string;
  email: string;
} {
  return {
    id: writer.userId,
    // The lifecycle sink type requires an email string. Collaboration
    // handshake context may only carry userId, so keep the value neutral
    // instead of fabricating an address when email is not available.
    email: writer.email ?? "",
  };
}

function createActiveLockLostError(documentId: string): RuntimeError {
  return new RuntimeError({
    code: "COLLABORATION_ACTIVE_LOCK_LOST",
    message: "Collaboration active lock is no longer owned by this room.",
    statusCode: 409,
    details: {
      documentId,
    },
  });
}

function assertActiveLockHeld(state: RoomState | undefined): void {
  if (state?.activeLockLost) {
    throw createActiveLockLostError(state.documentId);
  }
}

function metadataFromContextOrState(
  context: CollaborationRuntimeContext,
  state?: RoomState,
): CollaborationYjsMetadata {
  const draftRevision =
    state?.loadedDraftRevision ?? context.loadedDraftRevision;
  const bodyHash = state?.loadedBodyHash ?? context.loadedBodyHash;

  if (typeof draftRevision !== "number" || typeof bodyHash !== "string") {
    throw new RuntimeError({
      code: "INVALID_COLLABORATION_CONTEXT",
      message: "Collaboration room is missing loaded draft metadata.",
      statusCode: 500,
      details: {
        documentId: context.documentId,
      },
    });
  }

  return {
    draftRevision,
    bodyHash,
  };
}

export function createCollaborationRuntimeHooks(
  options: CreateCollaborationRuntimeHooksOptions,
) {
  const roomStates = new Map<string, RoomState>();
  const finalizedRoomLeases = new Map<string, FinalizedRoomLease>();
  const activeLockHeartbeatIntervalMs =
    options.activeLockHeartbeatIntervalMs ??
    COLLABORATION_ACTIVE_LOCK_HEARTBEAT_INTERVAL_MS;
  const finalizedRoomLeaseTtlMs =
    options.finalizedRoomLeaseTtlMs ??
    COLLABORATION_FINALIZED_ROOM_LEASE_TTL_MS;
  const setActiveLockHeartbeat =
    options.setActiveLockHeartbeat ??
    ((callback: () => Promise<void> | void, intervalMs: number): unknown =>
      setInterval(() => {
        void callback();
      }, intervalMs));
  const clearActiveLockHeartbeat =
    options.clearActiveLockHeartbeat ??
    ((timer: unknown): void => {
      clearInterval(timer as ReturnType<typeof setInterval>);
    });
  const setFinalizedRoomLeaseTimeout =
    options.setFinalizedRoomLeaseTimeout ??
    ((callback: () => void, timeoutMs: number): unknown => {
      const timer = setTimeout(callback, timeoutMs);
      const maybeUnref = timer as { unref?: () => void };
      maybeUnref.unref?.();
      return timer;
    });
  const clearFinalizedRoomLeaseTimeout =
    options.clearFinalizedRoomLeaseTimeout ??
    ((timer: unknown): void => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
  const createRoomLeaseValue =
    options.createRoomLeaseValue ?? (() => randomUUID());
  const convertMarkdownToYjsUpdate =
    options.convertMarkdownToYjsUpdate ?? markdownToYjsUpdate;

  function deleteFinalizedRoomLease(key: string): void {
    const lease = finalizedRoomLeases.get(key);

    if (lease?.timeout !== undefined) {
      clearFinalizedRoomLeaseTimeout(lease.timeout);
    }

    finalizedRoomLeases.delete(key);
  }

  function getFinalizedRoomLeaseValue(key: string): string | undefined {
    const lease = finalizedRoomLeases.get(key);

    if (!lease) {
      return undefined;
    }

    if (lease.expiresAt <= Date.now()) {
      deleteFinalizedRoomLease(key);
      return undefined;
    }

    return lease.leaseValue;
  }

  function setFinalizedRoomLease(key: string, leaseValue: string): void {
    deleteFinalizedRoomLease(key);

    const lease: FinalizedRoomLease = {
      expiresAt: Date.now() + finalizedRoomLeaseTtlMs,
      leaseValue,
    };
    lease.timeout = setFinalizedRoomLeaseTimeout(() => {
      if (finalizedRoomLeases.get(key) === lease) {
        finalizedRoomLeases.delete(key);
      }
    }, finalizedRoomLeaseTtlMs);

    finalizedRoomLeases.set(key, lease);
  }

  function stopActiveLockHeartbeat(state: RoomState | undefined): void {
    if (state?.activeLockHeartbeatTimer === undefined) {
      return;
    }

    clearActiveLockHeartbeat(state.activeLockHeartbeatTimer);
    state.activeLockHeartbeatTimer = undefined;
  }

  async function markActiveLockLost(
    key: string,
    state: RoomState,
  ): Promise<void> {
    if (state.activeLockLost) {
      return;
    }

    state.activeLockLost = true;
    stopActiveLockHeartbeat(state);

    try {
      await options.closeRoom?.(state.documentName);
    } catch {
      // The room is already marked fail-closed; hook entrypoints reject any
      // further edits even if the transport cannot close immediately.
    }

    roomStates.set(key, state);
  }

  async function heartbeatActiveRoom(
    key: string,
    state: RoomState,
  ): Promise<void> {
    if (state.activeLockLost || state.activeLockHeartbeatInFlight) {
      return;
    }

    state.activeLockHeartbeatInFlight = true;

    try {
      const ownsActiveLock = await options.redisStore.heartbeatActiveLock(
        state.documentId,
        state.roomLeaseValue,
      );

      if (!ownsActiveLock) {
        await markActiveLockLost(key, state);
      }
    } catch {
      await markActiveLockLost(key, state);
    } finally {
      state.activeLockHeartbeatInFlight = false;
    }
  }

  function startActiveLockHeartbeat(key: string, state: RoomState): void {
    stopActiveLockHeartbeat(state);
    state.activeLockHeartbeatTimer = setActiveLockHeartbeat(
      () => heartbeatActiveRoom(key, state),
      activeLockHeartbeatIntervalMs,
    );
  }

  async function verifyActiveLockOwnership(input: {
    documentId: string;
    documentName: string;
    key: string;
    leaseValue: string;
    state?: RoomState;
  }): Promise<void> {
    assertActiveLockHeld(input.state);

    let ownsActiveLock = false;

    try {
      ownsActiveLock = await options.redisStore.heartbeatActiveLock(
        input.documentId,
        input.leaseValue,
      );
    } catch {
      ownsActiveLock = false;
    }

    if (ownsActiveLock) {
      return;
    }

    if (input.state) {
      await markActiveLockLost(input.key, input.state);
    } else {
      try {
        await options.closeRoom?.(input.documentName);
      } catch {
        // The caller will throw a fail-closed active-lock error below.
      }
    }

    throw createActiveLockLostError(input.documentId);
  }

  return {
    async onLoadDocument(payload: RuntimeHookPayload): Promise<Uint8Array> {
      const context = requireRuntimeContext(payload);
      const draft = await loadDraftDocument(options.contentStore, context);
      const draftHead = {
        draftRevision: draft.draftRevision,
        bodyHash: computeCollaborationBodyHash(draft.body),
      };

      const cached = await options.redisStore.getFreshYjsState(
        context.documentId,
        draftHead,
      );

      const state = cached?.state ?? convertMarkdownToYjsUpdate(draft.body);
      const loadedCanonicalBody = canonicalizeMarkdownUpdate(state);

      const roomLeaseValue = createRoomLeaseValue();
      const acquired = await options.redisStore.acquireActiveLock(
        context.documentId,
        roomLeaseValue,
      );

      if (!acquired) {
        throw createDocumentCollaborationActiveError(context.documentId);
      }

      const loadedState: RoomState = {
        documentId: context.documentId,
        documentName: payload.documentName,
        loadedDraftRevision: draftHead.draftRevision,
        loadedBodyHash: draftHead.bodyHash,
        loadedCanonicalBody,
        roomLeaseValue,
      };
      const key = roomKey(context);

      try {
        if (!cached) {
          await options.redisStore.setYjsState(context.documentId, state);
          await options.redisStore.setYjsMetadata(
            context.documentId,
            draftHead,
          );
        }

        await options.redisStore.clearInactiveCacheTtl(context.documentId);
      } catch (error) {
        try {
          await options.redisStore.releaseActiveLock(
            context.documentId,
            roomLeaseValue,
          );
        } catch {
          // Preserve the original load failure; the active lock is lease-owned
          // and will expire even if the best-effort release fails.
        }

        throw error;
      }

      deleteFinalizedRoomLease(key);
      roomStates.set(key, loadedState);
      assignLoadedRoomState(context, loadedState);
      startActiveLockHeartbeat(key, loadedState);

      return state;
    },

    async beforeHandleMessage(payload: RuntimeHookPayload): Promise<void> {
      const context = requireRuntimeContext(payload);
      assertActiveLockHeld(roomStates.get(roomKey(context)));

      const result = await options.authGuard.revalidateWrite(
        createRequestForRevalidation(payload, context),
        context,
      );

      if (!result.ok) {
        throw createCloseEvent(result.closeCode);
      }
    },

    async onChange(payload: RuntimeHookPayload): Promise<void> {
      const context = requireRuntimeContext(payload);
      const key = roomKey(context);
      const state = roomStates.get(key);
      const contextLeaseValue = context.roomLeaseValue;
      assertActiveLockHeld(state);

      if (
        contextLeaseValue &&
        getFinalizedRoomLeaseValue(key) === contextLeaseValue
      ) {
        return;
      }

      if (
        state &&
        contextLeaseValue &&
        state.roomLeaseValue !== contextLeaseValue
      ) {
        return;
      }

      if (state) {
        assignLoadedRoomState(context, state);
      }

      updateLastWriter(roomStates, context);
    },

    async onStoreDocument(payload: RuntimeHookPayload): Promise<void> {
      const context = requireRuntimeContext({
        ...payload,
        context: payload.lastContext ?? payload.context,
      });
      const key = roomKey(context);
      const state = roomStates.get(key);
      const contextLeaseValue = context.roomLeaseValue;
      assertActiveLockHeld(state);

      if (
        contextLeaseValue &&
        getFinalizedRoomLeaseValue(key) === contextLeaseValue
      ) {
        return;
      }

      if (!state && getFinalizedRoomLeaseValue(key) !== undefined) {
        return;
      }

      if (
        state &&
        contextLeaseValue &&
        state.roomLeaseValue !== contextLeaseValue
      ) {
        return;
      }

      const result = await options.authGuard.revalidateWrite(
        createRequestForRevalidation(payload, context),
        context,
      );

      if (!result.ok) {
        throw createCloseEvent(result.closeCode);
      }

      const metadata = metadataFromContextOrState(context, state);
      const document = payload.document;

      if (!document) {
        throw new RuntimeError({
          code: "INVALID_COLLABORATION_CONTEXT",
          message: "Collaboration store hook is missing a Yjs document.",
          statusCode: 500,
          details: {
            documentId: context.documentId,
          },
        });
      }

      const leaseValue = state?.roomLeaseValue ?? context.roomLeaseValue;

      if (leaseValue) {
        await verifyActiveLockOwnership({
          documentId: context.documentId,
          documentName: payload.documentName,
          key,
          leaseValue,
          state,
        });
      }

      await options.redisStore.setYjsState(
        context.documentId,
        encodeYDocState(document),
      );
      await options.redisStore.setYjsMetadata(context.documentId, metadata);

      updateLastWriter(roomStates, context);
    },

    async onDisconnect(payload: RuntimeHookPayload): Promise<void> {
      if ((payload.clientsCount ?? 0) > 0) {
        return;
      }

      const context = requireRuntimeContext(payload);
      const key = roomKey(context);
      const state = roomStates.get(key);
      const leaseValue = state?.roomLeaseValue ?? context.roomLeaseValue;

      if (!leaseValue) {
        throw new RuntimeError({
          code: "INVALID_COLLABORATION_CONTEXT",
          message: "Collaboration room is missing its active lock lease.",
          statusCode: 500,
          details: {
            documentId: context.documentId,
          },
        });
      }

      const document = payload.document;

      if (!document) {
        throw new RuntimeError({
          code: "INVALID_COLLABORATION_CONTEXT",
          message: "Collaboration disconnect hook is missing a Yjs document.",
          statusCode: 500,
          details: {
            documentId: context.documentId,
          },
        });
      }

      try {
        const nextState = encodeYDocState(document);
        const nextBody = yDocToMarkdown(document);
        const loadedCanonicalBody =
          state?.loadedCanonicalBody ?? context.loadedCanonicalBody;

        if (typeof loadedCanonicalBody !== "string") {
          throw new RuntimeError({
            code: "INVALID_COLLABORATION_CONTEXT",
            message: "Collaboration room is missing loaded canonical body.",
            statusCode: 500,
            details: {
              documentId: context.documentId,
            },
          });
        }

        await verifyActiveLockOwnership({
          documentId: context.documentId,
          documentName: payload.documentName,
          key,
          leaseValue,
          state,
        });

        const currentDraft = await loadDraftDocument(
          options.contentStore,
          context,
        );
        let metadata: CollaborationYjsMetadata = {
          draftRevision: currentDraft.draftRevision,
          bodyHash: computeCollaborationBodyHash(currentDraft.body),
        };

        if (nextBody !== loadedCanonicalBody) {
          const writer = state?.lastWriter ??
            context.lastWriter ?? {
              userId: context.userId,
              ...(context.userEmail ? { email: context.userEmail } : {}),
            };
          const expectedDraftRevision =
            state?.loadedDraftRevision ?? context.loadedDraftRevision;

          if (typeof expectedDraftRevision !== "number") {
            throw new RuntimeError({
              code: "INVALID_COLLABORATION_CONTEXT",
              message:
                "Collaboration final save is missing expected draft revision.",
              statusCode: 500,
              details: {
                documentId: context.documentId,
              },
            });
          }

          const updated = await options.contentStore.update(
            scopeFromContext(context),
            context.documentId,
            {
              body: nextBody,
              updatedBy: writer.userId,
            },
            { expectedDraftRevision },
          );

          metadata = {
            draftRevision: updated.draftRevision,
            bodyHash: computeCollaborationBodyHash(updated.body),
          };

          await options.lifecycleEvents?.emitContentEvent({
            event: "content.updated",
            scope: scopeFromContext(context),
            document: updated,
            actor: createLifecycleActor(writer),
          });
        }

        await options.redisStore.setYjsState(context.documentId, nextState);
        await options.redisStore.setYjsMetadata(context.documentId, metadata);

        if (
          await options.redisStore.finalizeInactiveRoom(
            context.documentId,
            leaseValue,
          )
        ) {
          stopActiveLockHeartbeat(state);
          setFinalizedRoomLease(key, leaseValue);
          roomStates.delete(key);
        } else {
          if (state) {
            await markActiveLockLost(key, state);
          }

          throw createActiveLockLostError(context.documentId);
        }
      } catch (error) {
        if (state) {
          await markActiveLockLost(key, state);
        } else {
          stopActiveLockHeartbeat(state);
        }

        throw error;
      }
    },
  };
}

export function createCollaborationRuntime(
  options: CreateCollaborationRuntimeOptions,
): CollaborationRuntime {
  const redisStore = resolveRedisStore(options);
  let server: Hocuspocus<CollaborationRuntimeContext> | undefined;
  const hooks = createCollaborationRuntimeHooks({
    ...options,
    redisStore,
    closeRoom: async (documentName) => {
      try {
        await options.closeRoom?.(documentName);
      } finally {
        server?.closeConnections(documentName);
      }
    },
  });
  const config: Partial<Configuration<CollaborationRuntimeContext>> = {
    name: "mdcms-collaboration",
    quiet: true,
    debounce: COLLABORATION_HOCUSPOCUS_DEBOUNCE_MS,
    maxDebounce: COLLABORATION_HOCUSPOCUS_MAX_DEBOUNCE_MS,
    onLoadDocument: hooks.onLoadDocument,
    beforeHandleMessage: hooks.beforeHandleMessage,
    onChange: hooks.onChange,
    onStoreDocument: hooks.onStoreDocument,
    onDisconnect: hooks.onDisconnect,
  };

  return {
    config,
    hooks,
    server: (server = new Hocuspocus<CollaborationRuntimeContext>(config)),
  };
}
