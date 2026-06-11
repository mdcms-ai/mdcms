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
  createCollaborationRedisStore,
  type CollaborationRedisDependency,
  type CollaborationYjsMetadata,
  type FreshCollaborationYjsState,
} from "./redis-store.js";

export const COLLABORATION_HOCUSPOCUS_DEBOUNCE_MS = 2000;
export const COLLABORATION_HOCUSPOCUS_MAX_DEBOUNCE_MS = 10000;
export const COLLABORATION_YJS_FIELD_NAME = "default";

export type CollaborationRuntimeLastWriter = {
  userId: string;
  email?: string;
};

export type CollaborationRuntimeContext = CollaborationSessionContext & {
  loadedDraftRevision?: number;
  loadedBodyHash?: string;
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
  finalizeInactiveRoom: (
    documentId: string,
    leaseValue: string,
  ) => Promise<boolean>;
};

type RoomState = {
  loadedDraftRevision: number;
  loadedBodyHash: string;
  roomLeaseValue: string;
  lastWriter?: CollaborationRuntimeLastWriter;
};

export type CreateCollaborationRuntimeHooksOptions = {
  contentStore: CollaborationRuntimeContentStore;
  redisStore: CollaborationRuntimeRedisStore;
  authGuard: CollaborationRuntimeAuthGuard;
  lifecycleEvents?: ContentLifecycleEventSink;
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
  const room = parseCollaborationDocumentName(payload.documentName);

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

  if (room.project && context.project !== room.project) {
    context.project = room.project;
  }

  if (room.environment && context.environment !== room.environment) {
    context.environment = room.environment;
  }

  if (room.documentId && context.documentId !== room.documentId) {
    context.documentId = room.documentId;
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
  };
  const state = roomStates.get(roomKey(context));

  if (state) {
    state.lastWriter = writer;
  }

  context.lastWriter = writer;
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
  const createRoomLeaseValue =
    options.createRoomLeaseValue ?? (() => randomUUID());
  const convertMarkdownToYjsUpdate =
    options.convertMarkdownToYjsUpdate ?? markdownToYjsUpdate;

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

      const roomLeaseValue = createRoomLeaseValue();
      const acquired = await options.redisStore.acquireActiveLock(
        context.documentId,
        roomLeaseValue,
      );

      if (!acquired) {
        throw createDocumentCollaborationActiveError(context.documentId);
      }

      if (!cached) {
        await options.redisStore.setYjsState(context.documentId, state);
        await options.redisStore.setYjsMetadata(context.documentId, draftHead);
      }

      const loadedState: RoomState = {
        loadedDraftRevision: draftHead.draftRevision,
        loadedBodyHash: draftHead.bodyHash,
        roomLeaseValue,
      };
      roomStates.set(roomKey(context), loadedState);
      assignLoadedRoomState(context, loadedState);

      await options.redisStore.clearInactiveCacheTtl(context.documentId);

      return state;
    },

    async beforeHandleMessage(payload: RuntimeHookPayload): Promise<void> {
      const context = requireRuntimeContext(payload);
      const result = await options.authGuard.revalidateWrite(
        createRequestForRevalidation(payload, context),
        context,
      );

      if (!result.ok) {
        throw createCloseEvent(result.closeCode);
      }

      updateLastWriter(roomStates, context);
    },

    async onStoreDocument(payload: RuntimeHookPayload): Promise<void> {
      const context = requireRuntimeContext({
        ...payload,
        context: payload.lastContext ?? payload.context,
      });
      const result = await options.authGuard.revalidateWrite(
        createRequestForRevalidation(payload, context),
        context,
      );

      if (!result.ok) {
        throw createCloseEvent(result.closeCode);
      }

      const state = roomStates.get(roomKey(context));
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

      await options.redisStore.setYjsState(
        context.documentId,
        encodeYDocState(document),
      );
      await options.redisStore.setYjsMetadata(context.documentId, metadata);

      if (context.roomLeaseValue) {
        await options.redisStore.heartbeatActiveLock(
          context.documentId,
          context.roomLeaseValue,
        );
      }

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

      try {
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

        const nextState = encodeYDocState(document);
        const nextBody = yDocToMarkdown(document);
        const currentDraft = await loadDraftDocument(
          options.contentStore,
          context,
        );
        let metadata: CollaborationYjsMetadata = {
          draftRevision: currentDraft.draftRevision,
          bodyHash: computeCollaborationBodyHash(currentDraft.body),
        };

        if (nextBody !== currentDraft.body) {
          const writer = state?.lastWriter ??
            context.lastWriter ?? {
              userId: context.userId,
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
            actor: {
              id: writer.userId,
              email: writer.email ?? writer.userId,
            },
          });
        }

        await options.redisStore.setYjsState(context.documentId, nextState);
        await options.redisStore.setYjsMetadata(context.documentId, metadata);
      } finally {
        await options.redisStore.finalizeInactiveRoom(
          context.documentId,
          leaseValue,
        );
        roomStates.delete(key);
      }
    },
  };
}

export function createCollaborationRuntime(
  options: CreateCollaborationRuntimeOptions,
): CollaborationRuntime {
  const redisStore = resolveRedisStore(options);
  const hooks = createCollaborationRuntimeHooks({
    ...options,
    redisStore,
  });
  const config: Partial<Configuration<CollaborationRuntimeContext>> = {
    name: "mdcms-collaboration",
    quiet: true,
    debounce: COLLABORATION_HOCUSPOCUS_DEBOUNCE_MS,
    maxDebounce: COLLABORATION_HOCUSPOCUS_MAX_DEBOUNCE_MS,
    onLoadDocument: hooks.onLoadDocument,
    beforeHandleMessage: hooks.beforeHandleMessage,
    onStoreDocument: hooks.onStoreDocument,
    onDisconnect: hooks.onDisconnect,
  };

  return {
    config,
    hooks,
    server: new Hocuspocus<CollaborationRuntimeContext>(config),
  };
}
