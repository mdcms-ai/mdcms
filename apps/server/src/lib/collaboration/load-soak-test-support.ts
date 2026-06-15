import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import type {
  CollaborationPresenceSnapshot,
  CollaborationPresenceUpdate,
  CollaborationPresenceUser,
} from "@mdcms/shared";
import * as Y from "yjs";

import type {
  CollaborationHandshakeResult,
  CollaborationPresenceContext,
  CollaborationPresenceHandshakeResult,
} from "../collaboration-auth.js";
import type {
  ContentDocument,
  ContentLifecycleEventSink,
  ContentScope,
} from "../content-api/types.js";

import type { CollaborationYjsMetadata } from "./redis-store.js";
import {
  COLLABORATION_FRONTMATTER_FIELD_NAME,
  COLLABORATION_YJS_FIELD_NAME,
  computeCollaborationBodyHash,
  createCollaborationDocumentName,
  createCollaborationRuntimeHooks,
  yDocToFrontmatter,
  yDocToMarkdown,
  yjsUpdateToYDoc,
  type CollaborationRuntimeAuthGuard,
  type CollaborationRuntimeContentStore,
  type CollaborationRuntimeContext,
  type CollaborationRuntimeRedisStore,
} from "./runtime.js";
import {
  createCollaborationWebSocketTransport,
  type CollaborationAuthHandshakeGuard,
} from "./transport.js";

export const COLLABORATION_BASELINE_PROFILE = {
  roomCount: 4,
  sessionsPerRoom: 3,
  mutationsPerSession: 25,
  timeoutMs: 30_000,
} as const;

export type CollaborationBaselineRoomResult = {
  documentId: string;
  type: string;
  sessionCount: number;
  mutationCount: number;
  draftRevisionBefore: number;
  draftRevisionAfter: number;
  expectedMarkdown: string;
  finalMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
  finalFrontmatter: Record<string, unknown>;
  convergedClientMarkdown: string[];
  redisFreshBeforeCleanup: boolean;
  activeLockPresentBeforeCleanup: boolean;
  activeLockPresentAfterCleanup: boolean;
  finalizedAfterCleanup: boolean;
  updateCount: number;
  lifecycleEventCount: number;
  versionRowsCreated: number;
  expectedPresenceDuring: CollaborationPresenceUser[];
  presenceDuring: CollaborationPresenceUser[];
  presenceAfter: CollaborationPresenceUser[];
};

export type CollaborationRedisLossRecoveryResult = {
  documentId: string;
  expectedMarkdown: string;
  recoveredMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
  recoveredFrontmatter: Record<string, unknown>;
  rebuiltFromPostgres: boolean;
  redisFreshAfterReopen: boolean;
};

export type CollaborationBaselineResult = {
  elapsedMs: number;
  rooms: CollaborationBaselineRoomResult[];
  redisLossRecovery: CollaborationRedisLossRecoveryResult;
  activeLockCountBeforeCleanup: number;
  targetPresenceDuring: CollaborationPresenceUser[];
  targetPresenceAfter: CollaborationPresenceUser[];
  totals: {
    roomCount: number;
    sessionCount: number;
    mutationCount: number;
    contentUpdatedEvents: number;
    versionRowsCreated: number;
  };
};

const PROJECT = "marketing";
const ENVIRONMENT = "draft";
const BASELINE_UPDATED_AT = "2026-06-14T12:00:00.000Z";

type BaselineContentTypeFixture = {
  type: string;
  directory: string;
  locale?: string;
  frontmatter: (roomIndex: number) => Record<string, unknown>;
};

const BASELINE_CONTENT_TYPE_FIXTURES: readonly BaselineContentTypeFixture[] = [
  {
    type: "post",
    directory: "content/posts",
    frontmatter: (roomIndex: number) => ({
      title: `Baseline post ${roomIndex}`,
      slug: `baseline-post-${roomIndex}`,
      featured: false,
      abTestVariant: "control",
    }),
  },
  {
    type: "author",
    directory: "content/authors",
    frontmatter: (roomIndex: number) => ({
      name: `Baseline author ${roomIndex}`,
    }),
  },
  {
    type: "page",
    directory: "content/pages",
    frontmatter: (roomIndex: number) => ({
      title: `Baseline page ${roomIndex}`,
    }),
  },
  {
    type: "campaign",
    directory: "content/campaigns",
    locale: "en",
    frontmatter: (roomIndex: number) => ({
      title: `Baseline campaign ${roomIndex}`,
      slug: `baseline-campaign-${roomIndex}`,
      summary: `Initial campaign summary ${roomIndex}`,
    }),
  },
];

type BaselineRoomState = {
  roomIndex: number;
  seedDocument: ContentDocument;
  documentName: string;
  sessions: CollaborationRuntimeContext[];
  draftRevisionBefore: number;
  initialBody: string;
  mutations: string[];
  roomDocument: Y.Doc;
  clientDocuments: Y.Doc[];
  presencePeers: BaselinePresencePeer[];
};

type BaselineStoredRoom = {
  state: BaselineRoomState;
  expectedMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
  redisFreshBeforeCleanup: boolean;
  activeLockPresentBeforeCleanup: boolean;
  presenceDuring: CollaborationPresenceUser[];
};

function cloneJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function cloneDocument(document: ContentDocument): ContentDocument {
  return {
    ...document,
    frontmatter: cloneJsonObject(document.frontmatter),
  };
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual(left, right);
}

function createBaselineDocument(roomIndex: number): ContentDocument {
  const fixture =
    BASELINE_CONTENT_TYPE_FIXTURES[
      (roomIndex - 1) % BASELINE_CONTENT_TYPE_FIXTURES.length
    ];

  return {
    documentId: `00000000-0000-4000-8000-${roomIndex
      .toString()
      .padStart(12, "0")}`,
    translationGroupId: `10000000-0000-4000-8000-${roomIndex
      .toString()
      .padStart(12, "0")}`,
    project: PROJECT,
    environment: ENVIRONMENT,
    path: `${fixture.directory}/baseline-room-${roomIndex}`,
    type: fixture.type,
    locale: fixture.locale ?? "__mdcms_default__",
    format: "mdx",
    isDeleted: false,
    hasUnpublishedChanges: true,
    version: 0,
    publishedVersion: null,
    draftRevision: roomIndex,
    frontmatter: fixture.frontmatter(roomIndex),
    body: `# Baseline room ${roomIndex}\n\nInitial draft body for room ${roomIndex}.`,
    createdBy: "baseline-fixture",
    createdAt: BASELINE_UPDATED_AT,
    updatedBy: "baseline-fixture",
    updatedAt: BASELINE_UPDATED_AT,
  };
}

class BaselineContentStore implements CollaborationRuntimeContentStore {
  readonly documents = new Map<string, ContentDocument>();
  readonly updateCounts = new Map<string, number>();
  readonly versionRowsCreated = new Map<string, number>();

  constructor(documents: ContentDocument[]) {
    for (const document of documents) {
      this.documents.set(document.documentId, cloneDocument(document));
      this.updateCounts.set(document.documentId, 0);
      this.versionRowsCreated.set(document.documentId, 0);
    }
  }

  async getById(
    scope: ContentScope,
    documentId: string,
    options?: { draft?: boolean },
  ): Promise<ContentDocument | undefined> {
    if (
      scope.project !== PROJECT ||
      scope.environment !== ENVIRONMENT ||
      options?.draft !== true
    ) {
      return undefined;
    }

    const document = this.documents.get(documentId);
    return document ? cloneDocument(document) : undefined;
  }

  async update(
    scope: ContentScope,
    documentId: string,
    payload: {
      body: string;
      frontmatter: Record<string, unknown>;
      updatedBy: string;
    },
    options?: { expectedDraftRevision?: number },
  ): Promise<ContentDocument> {
    const current = this.documents.get(documentId);

    if (!current) {
      throw new Error(`Unknown baseline document ${documentId}`);
    }

    if (scope.project !== PROJECT || scope.environment !== ENVIRONMENT) {
      throw new Error(
        `Unexpected baseline scope ${scope.project}/${scope.environment}`,
      );
    }

    if (
      options?.expectedDraftRevision !== undefined &&
      options.expectedDraftRevision !== current.draftRevision
    ) {
      throw new Error(
        `Expected draft revision ${options.expectedDraftRevision}, got ${current.draftRevision}`,
      );
    }

    const updated: ContentDocument = {
      ...current,
      body: payload.body,
      frontmatter: cloneJsonObject(payload.frontmatter),
      draftRevision: current.draftRevision + 1,
      updatedBy: payload.updatedBy,
      updatedAt: BASELINE_UPDATED_AT,
    };

    this.documents.set(documentId, updated);
    this.updateCounts.set(
      documentId,
      (this.updateCounts.get(documentId) ?? 0) + 1,
    );

    return cloneDocument(updated);
  }

  requireDocument(documentId: string): ContentDocument {
    const document = this.documents.get(documentId);

    if (!document) {
      throw new Error(`Unknown baseline document ${documentId}`);
    }

    return cloneDocument(document);
  }

  updateCount(documentId: string): number {
    return this.updateCounts.get(documentId) ?? 0;
  }

  versionRowCount(documentId: string): number {
    return this.versionRowsCreated.get(documentId) ?? 0;
  }
}

class BaselineRedisStore implements CollaborationRuntimeRedisStore {
  readonly activeLocks = new Map<string, string>();
  readonly finalizedDocumentIds = new Set<string>();
  readonly presenceRecords = new Map<
    string,
    CollaborationPresenceUser & { project: string; environment: string }
  >();

  private readonly states = new Map<string, Uint8Array>();
  private readonly metadata = new Map<string, CollaborationYjsMetadata>();

  async getFreshYjsState(
    documentId: string,
    draftHead: { draftRevision: number; bodyHash: string },
  ) {
    const state = this.states.get(documentId);
    const metadata = this.metadata.get(documentId);

    if (
      state &&
      metadata?.draftRevision === draftHead.draftRevision &&
      metadata.bodyHash === draftHead.bodyHash
    ) {
      return {
        state: new Uint8Array(state),
        metadata,
      };
    }

    return null;
  }

  async setYjsState(documentId: string, state: Uint8Array): Promise<void> {
    this.states.set(documentId, new Uint8Array(state));
  }

  async setYjsMetadata(
    documentId: string,
    metadata: CollaborationYjsMetadata,
  ): Promise<void> {
    this.metadata.set(documentId, metadata);
  }

  async clearInactiveCacheTtl(documentId: string): Promise<void> {
    this.finalizedDocumentIds.delete(documentId);
  }

  async acquireActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLocks.has(documentId)) {
      return false;
    }

    this.activeLocks.set(documentId, leaseValue);
    return true;
  }

  async heartbeatActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    return this.activeLocks.get(documentId) === leaseValue;
  }

  async releaseActiveLock(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLocks.get(documentId) !== leaseValue) {
      return false;
    }

    this.activeLocks.delete(documentId);
    return true;
  }

  async finalizeInactiveRoom(
    documentId: string,
    leaseValue: string,
  ): Promise<boolean> {
    if (this.activeLocks.get(documentId) !== leaseValue) {
      return false;
    }

    this.activeLocks.delete(documentId);
    this.finalizedDocumentIds.add(documentId);
    return true;
  }

  async setPresence(
    record: CollaborationPresenceUser & {
      project: string;
      environment: string;
    },
  ): Promise<void> {
    this.presenceRecords.set(record.sessionId, record);
  }

  async deletePresence(input: {
    project: string;
    environment: string;
    sessionId: string;
  }): Promise<void> {
    const record = this.presenceRecords.get(input.sessionId);

    if (
      record?.project === input.project &&
      record.environment === input.environment
    ) {
      this.presenceRecords.delete(input.sessionId);
    }
  }

  async listPresence(input: {
    project: string;
    environment: string;
  }): Promise<CollaborationPresenceUser[]> {
    return Array.from(this.presenceRecords.values())
      .filter(
        (record) =>
          record.project === input.project &&
          record.environment === input.environment,
      )
      .map(({ project: _project, environment: _environment, ...user }) => ({
        ...user,
      }));
  }

  flushVolatileCollaborationState(): void {
    this.states.clear();
    this.metadata.clear();
    this.activeLocks.clear();
    this.finalizedDocumentIds.clear();
  }
}

class BaselineLifecycleEvents implements ContentLifecycleEventSink {
  readonly events: Parameters<
    ContentLifecycleEventSink["emitContentEvent"]
  >[0][] = [];

  async emitContentEvent(
    event: Parameters<ContentLifecycleEventSink["emitContentEvent"]>[0],
  ): Promise<void> {
    this.events.push(event);
  }

  contentUpdatedCount(documentId: string): number {
    return this.events.filter(
      (event) =>
        event.event === "content.updated" &&
        event.document.documentId === documentId,
    ).length;
  }
}

class BaselineAuthGuard implements CollaborationRuntimeAuthGuard {
  async revalidateWrite(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

class BaselinePresenceAuthGuard implements CollaborationAuthHandshakeGuard {
  async authorizeHandshake(): Promise<CollaborationHandshakeResult> {
    return {
      ok: false,
      closeCode: 4403,
      message:
        "Document sockets are not used by the baseline presence harness.",
    };
  }

  async authorizePresenceHandshake(): Promise<CollaborationPresenceHandshakeResult> {
    return {
      ok: false,
      closeCode: 4403,
      message: "Presence handshakes are bypassed by test peers.",
    };
  }

  async authorizePresenceUpdate(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async filterPresenceSnapshot(
    _request: Request,
    _context: CollaborationPresenceContext,
    users: CollaborationPresenceUser[],
  ): Promise<CollaborationPresenceUser[]> {
    return users;
  }

  async revalidateWrite(): Promise<{ ok: true }> {
    return { ok: true };
  }
}

class BaselinePresencePeer {
  readonly data: {
    request: Request;
    context: {
      kind: "presence";
      presence: CollaborationPresenceContext;
    };
    namespace: string;
    peer?: unknown;
  };
  readonly remoteAddress = "127.0.0.1";
  readonly snapshots: CollaborationPresenceSnapshot[] = [];
  readonly closeEvents: { code?: number; reason?: string }[] = [];
  readyState = 1;

  constructor(context: CollaborationPresenceContext) {
    this.data = {
      request: new Request(
        `http://127.0.0.1/api/v1/collaboration/presence?project=${PROJECT}&environment=${ENVIRONMENT}`,
      ),
      context: {
        kind: "presence",
        presence: context,
      },
      namespace: "baseline-presence",
    };
  }

  send(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    const parsed = JSON.parse(data) as CollaborationPresenceSnapshot;

    if (parsed.type === "presence.snapshot") {
      this.snapshots.push(parsed);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeEvents.push({ code, reason });
  }

  publish(): void {
    return;
  }

  subscribe(): void {
    return;
  }

  unsubscribe(): void {
    return;
  }

  terminate(): void {
    this.close();
  }
}

function createSessionContext(input: {
  document: ContentDocument;
  roomIndex: number;
  sessionIndex: number;
}): CollaborationRuntimeContext {
  return {
    userId: `baseline-user-${input.roomIndex}-${input.sessionIndex}`,
    userEmail: `baseline-user-${input.roomIndex}-${input.sessionIndex}@mdcms.test`,
    sessionId: `baseline-session-${input.roomIndex}-${input.sessionIndex}`,
    project: PROJECT,
    environment: ENVIRONMENT,
    documentId: input.document.documentId,
    documentPath: input.document.path,
    role: "editor",
  };
}

function createPresenceLabel(sessionIndex: number): string {
  return `Baseline editor ${sessionIndex}`;
}

function createPresenceColor(sessionIndex: number): string {
  return `#${sessionIndex.toString().padStart(6, "0")}`;
}

function createPresenceContext(
  context: CollaborationRuntimeContext,
  sessionIndex: number,
): CollaborationPresenceContext {
  return {
    userId: context.userId,
    sessionId: context.sessionId,
    label: createPresenceLabel(sessionIndex),
    color: createPresenceColor(sessionIndex),
    project: context.project,
    environment: context.environment,
    role: context.role,
  };
}

function createExpectedPresenceUsers(input: {
  sessions: CollaborationRuntimeContext[];
  mutationCount: number;
}): CollaborationPresenceUser[] {
  return input.sessions.map((context, index) => {
    const sessionIndex = index + 1;

    return {
      userId: context.userId,
      sessionId: context.sessionId,
      label: createPresenceLabel(sessionIndex),
      color: createPresenceColor(sessionIndex),
      documentId: context.documentId,
      mode: "edit",
      cursor: {
        anchor: sessionIndex,
        head: sessionIndex + input.mutationCount,
      },
      updatedAt: BASELINE_UPDATED_AT,
    };
  });
}

function buildExpectedRoomMarkdown(input: {
  roomIndex: number;
  initialBody: string;
  mutations: string[];
}): string {
  return [
    `# Baseline room ${input.roomIndex}`,
    "",
    input.initialBody,
    ...input.mutations.flatMap((mutation) => ["", mutation]),
  ].join("\n");
}

function createMutationLabel(input: {
  roomIndex: number;
  sessionIndex: number;
  mutationIndex: number;
}): string {
  return `room ${input.roomIndex} session ${input.sessionIndex} mutation ${input.mutationIndex}`;
}

function appendMutationParagraph(
  document: Y.Doc,
  mutation: string,
): Uint8Array {
  const stateVector = Y.encodeStateVector(document);
  const fragment = document.getXmlFragment(COLLABORATION_YJS_FIELD_NAME);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();

  text.insert(0, mutation);
  paragraph.insert(0, [text]);
  fragment.insert(fragment.length, [paragraph]);

  return Y.encodeStateAsUpdate(document, stateVector);
}

function writeCollaborationFrontmatterMutation(input: {
  document: Y.Doc;
  frontmatter: Record<string, unknown>;
}): void {
  const frontmatter = input.document.getMap<unknown>(
    COLLABORATION_FRONTMATTER_FIELD_NAME,
  );

  frontmatter.clear();

  for (const [fieldName, value] of Object.entries(input.frontmatter)) {
    frontmatter.set(fieldName, value);
  }
}

function buildExpectedCollaborationFrontmatter(input: {
  seedDocument: ContentDocument;
  mutationCount: number;
  sessionId: string;
}): Record<string, unknown> {
  const frontmatter = cloneJsonObject(input.seedDocument.frontmatter);

  if (input.seedDocument.type === "post") {
    return {
      ...frontmatter,
      abTestVariant: input.sessionId,
      featured: true,
    };
  }

  if (input.seedDocument.type === "author") {
    return {
      ...frontmatter,
      name: `${String(frontmatter.name)} (${input.mutationCount})`,
    };
  }

  if (input.seedDocument.type === "page") {
    return {
      ...frontmatter,
      title: `${String(frontmatter.title)} (${input.mutationCount})`,
    };
  }

  if (input.seedDocument.type === "campaign") {
    return {
      ...frontmatter,
      summary: `Updated by ${input.sessionId} after ${input.mutationCount} mutations`,
    };
  }

  throw new Error(`Unsupported baseline type ${input.seedDocument.type}`);
}

function createPresenceUpdateMessage(input: {
  documentId: string;
  sessionIndex: number;
  mutationCount: number;
}): string {
  const update: CollaborationPresenceUpdate = {
    type: "presence.update",
    documentId: input.documentId,
    mode: "edit",
    cursor: {
      anchor: input.sessionIndex,
      head: input.sessionIndex + input.mutationCount,
    },
  };

  return JSON.stringify(update);
}

async function flushPresenceTasks(): Promise<void> {
  for (let taskIndex = 0; taskIndex < 8; taskIndex++) {
    await Promise.resolve();
  }
}

function latestPresenceSnapshotForDocument(
  peers: BaselinePresencePeer[],
  documentId: string,
): CollaborationPresenceUser[] {
  const latestSnapshot = peers
    .flatMap((peer) => peer.snapshots)
    .filter((snapshot) => snapshot.project === PROJECT)
    .filter((snapshot) => snapshot.environment === ENVIRONMENT)
    .at(-1);

  return (
    latestSnapshot?.users.filter((user) => user.documentId === documentId) ?? []
  );
}

async function isFreshRedisState(input: {
  redisStore: BaselineRedisStore;
  document: ContentDocument;
  expectedMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
}): Promise<boolean> {
  const fresh = await input.redisStore.getFreshYjsState(
    input.document.documentId,
    {
      draftRevision: input.document.draftRevision,
      bodyHash: computeCollaborationBodyHash(input.document.body),
    },
  );

  if (!fresh) {
    return false;
  }

  const freshDocument = yjsUpdateToYDoc(fresh.state);

  return (
    yDocToMarkdown(freshDocument) === input.expectedMarkdown &&
    recordsEqual(yDocToFrontmatter(freshDocument), input.expectedFrontmatter)
  );
}

export async function runCollaborationBaselineScenario(): Promise<CollaborationBaselineResult> {
  const startedAt = performance.now();
  const seedDocuments = Array.from(
    { length: COLLABORATION_BASELINE_PROFILE.roomCount },
    (_, index) => createBaselineDocument(index + 1),
  );
  const contentStore = new BaselineContentStore(seedDocuments);
  const redisStore = new BaselineRedisStore();
  const lifecycleEvents = new BaselineLifecycleEvents();
  const hooks = createCollaborationRuntimeHooks({
    contentStore,
    redisStore,
    authGuard: new BaselineAuthGuard(),
    lifecycleEvents,
    createRoomLeaseValue: (() => {
      let leaseIndex = 0;
      return () => `baseline-lease-${++leaseIndex}`;
    })(),
    setActiveLockHeartbeat: () => Symbol("heartbeat"),
    clearActiveLockHeartbeat: () => undefined,
    setFinalizedRoomLeaseTimeout: () => Symbol("finalized-room"),
    clearFinalizedRoomLeaseTimeout: () => undefined,
  });
  const presenceTransport = createCollaborationWebSocketTransport({
    authGuard: new BaselinePresenceAuthGuard(),
    presenceStore: redisStore,
    now: () => new Date(BASELINE_UPDATED_AT),
  });

  const roomStates: BaselineRoomState[] = [];

  for (const [documentIndex, seedDocument] of seedDocuments.entries()) {
    const roomIndex = documentIndex + 1;
    const documentName = createCollaborationDocumentName({
      project: PROJECT,
      environment: ENVIRONMENT,
      documentId: seedDocument.documentId,
    });
    const sessions = Array.from(
      { length: COLLABORATION_BASELINE_PROFILE.sessionsPerRoom },
      (_, sessionIndex) =>
        createSessionContext({
          document: seedDocument,
          roomIndex,
          sessionIndex: sessionIndex + 1,
        }),
    );
    const draftRevisionBefore = seedDocument.draftRevision;
    const initialBody = `Initial draft body for room ${roomIndex}.`;
    const mutations: string[] = [];
    const loaded = await hooks.onLoadDocument({
      context: sessions[0],
      documentName,
    });
    const roomDocument = yjsUpdateToYDoc(loaded);
    const clientDocuments = sessions.map(() => yjsUpdateToYDoc(loaded));
    const presencePeers = sessions.map(
      (context, sessionIndex) =>
        new BaselinePresencePeer(
          createPresenceContext(context, sessionIndex + 1),
        ),
    );

    roomStates.push({
      roomIndex,
      seedDocument,
      documentName,
      sessions,
      draftRevisionBefore,
      initialBody,
      mutations,
      roomDocument,
      clientDocuments,
      presencePeers,
    });
  }

  for (const roomState of roomStates) {
    for (const peer of roomState.presencePeers) {
      presenceTransport.websocket.open?.(peer as never);
    }
  }

  await flushPresenceTasks();

  for (const roomState of roomStates) {
    for (const [sessionIndex, peer] of roomState.presencePeers.entries()) {
      presenceTransport.websocket.message?.(
        peer as never,
        createPresenceUpdateMessage({
          documentId: roomState.seedDocument.documentId,
          sessionIndex: sessionIndex + 1,
          mutationCount: 0,
        }) as never,
      );
    }
  }

  await flushPresenceTasks();

  for (
    let mutationIndex = 1;
    mutationIndex <= COLLABORATION_BASELINE_PROFILE.mutationsPerSession;
    mutationIndex++
  ) {
    for (
      let sessionIndex = 0;
      sessionIndex < COLLABORATION_BASELINE_PROFILE.sessionsPerRoom;
      sessionIndex++
    ) {
      for (const roomState of roomStates) {
        const context = roomState.sessions[sessionIndex];
        await hooks.beforeHandleMessage({
          context,
          documentName: roomState.documentName,
          document: roomState.roomDocument,
        });
        const mutation = createMutationLabel({
          roomIndex: roomState.roomIndex,
          sessionIndex: sessionIndex + 1,
          mutationIndex,
        });
        roomState.mutations.push(mutation);
        const update = appendMutationParagraph(
          roomState.clientDocuments[sessionIndex],
          mutation,
        );

        for (const [
          clientIndex,
          clientDocument,
        ] of roomState.clientDocuments.entries()) {
          if (clientIndex !== sessionIndex) {
            Y.applyUpdate(clientDocument, update);
          }
        }

        Y.applyUpdate(roomState.roomDocument, update);
        await hooks.onChange({
          context,
          documentName: roomState.documentName,
          document: roomState.roomDocument,
        });
      }
    }
  }

  for (const roomState of roomStates) {
    for (const [sessionIndex, peer] of roomState.presencePeers.entries()) {
      presenceTransport.websocket.message?.(
        peer as never,
        createPresenceUpdateMessage({
          documentId: roomState.seedDocument.documentId,
          sessionIndex: sessionIndex + 1,
          mutationCount: COLLABORATION_BASELINE_PROFILE.mutationsPerSession,
        }) as never,
      );
    }
  }

  await flushPresenceTasks();

  const storedRooms: BaselineStoredRoom[] = [];

  for (const roomState of roomStates) {
    const expectedMarkdown = buildExpectedRoomMarkdown({
      roomIndex: roomState.roomIndex,
      initialBody: roomState.initialBody,
      mutations: roomState.mutations,
    });
    const lastContext = roomState.sessions[roomState.sessions.length - 1];

    const expectedFrontmatter = buildExpectedCollaborationFrontmatter({
      seedDocument: roomState.seedDocument,
      mutationCount: roomState.mutations.length,
      sessionId: lastContext.sessionId,
    });

    writeCollaborationFrontmatterMutation({
      document: roomState.roomDocument,
      frontmatter: expectedFrontmatter,
    });

    await hooks.onStoreDocument({
      lastContext,
      documentName: roomState.documentName,
      document: roomState.roomDocument,
    });

    const persistedBeforeCleanup = contentStore.requireDocument(
      roomState.seedDocument.documentId,
    );
    const redisFreshBeforeCleanup = await isFreshRedisState({
      redisStore,
      document: persistedBeforeCleanup,
      expectedMarkdown,
      expectedFrontmatter,
    });
    const activeLockPresentBeforeCleanup = redisStore.activeLocks.has(
      roomState.seedDocument.documentId,
    );
    const presenceDuring = latestPresenceSnapshotForDocument(
      roomState.presencePeers,
      roomState.seedDocument.documentId,
    );

    storedRooms.push({
      state: roomState,
      expectedMarkdown,
      expectedFrontmatter,
      redisFreshBeforeCleanup,
      activeLockPresentBeforeCleanup,
      presenceDuring,
    });
  }

  const activeLockCountBeforeCleanup = roomStates.filter((roomState) =>
    redisStore.activeLocks.has(roomState.seedDocument.documentId),
  ).length;
  const targetPresenceDuring = await redisStore.listPresence({
    project: PROJECT,
    environment: ENVIRONMENT,
  });

  for (const storedRoom of storedRooms) {
    const lastContext =
      storedRoom.state.sessions[storedRoom.state.sessions.length - 1];

    await hooks.onDisconnect({
      context: lastContext,
      documentName: storedRoom.state.documentName,
      document: storedRoom.state.roomDocument,
      clientsCount: 0,
    });
  }

  for (const roomState of roomStates) {
    for (const peer of roomState.presencePeers) {
      presenceTransport.websocket.close?.(
        peer as never,
        1000 as never,
        "baseline room complete" as never,
      );
    }
  }

  await flushPresenceTasks();

  const targetPresenceAfter = await redisStore.listPresence({
    project: PROJECT,
    environment: ENVIRONMENT,
  });
  const rooms: CollaborationBaselineRoomResult[] = storedRooms.map(
    (storedRoom) => {
      const { state } = storedRoom;
      const persistedAfterCleanup = contentStore.requireDocument(
        state.seedDocument.documentId,
      );
      const presenceAfter = targetPresenceAfter.filter(
        (user) => user.documentId === state.seedDocument.documentId,
      );
      const convergedClientMarkdown = state.clientDocuments.map(
        (clientDocument) => yDocToMarkdown(clientDocument),
      );

      return {
        documentId: state.seedDocument.documentId,
        type: state.seedDocument.type,
        sessionCount: state.sessions.length,
        mutationCount: state.mutations.length,
        draftRevisionBefore: state.draftRevisionBefore,
        draftRevisionAfter: persistedAfterCleanup.draftRevision,
        expectedMarkdown: storedRoom.expectedMarkdown,
        finalMarkdown: persistedAfterCleanup.body,
        expectedFrontmatter: storedRoom.expectedFrontmatter,
        finalFrontmatter: persistedAfterCleanup.frontmatter,
        convergedClientMarkdown,
        redisFreshBeforeCleanup: storedRoom.redisFreshBeforeCleanup,
        activeLockPresentBeforeCleanup:
          storedRoom.activeLockPresentBeforeCleanup,
        activeLockPresentAfterCleanup: redisStore.activeLocks.has(
          state.seedDocument.documentId,
        ),
        finalizedAfterCleanup: redisStore.finalizedDocumentIds.has(
          state.seedDocument.documentId,
        ),
        updateCount: contentStore.updateCount(state.seedDocument.documentId),
        lifecycleEventCount: lifecycleEvents.contentUpdatedCount(
          state.seedDocument.documentId,
        ),
        versionRowsCreated: contentStore.versionRowCount(
          state.seedDocument.documentId,
        ),
        expectedPresenceDuring: createExpectedPresenceUsers({
          sessions: state.sessions,
          mutationCount: COLLABORATION_BASELINE_PROFILE.mutationsPerSession,
        }),
        presenceDuring: storedRoom.presenceDuring,
        presenceAfter,
      };
    },
  );

  const recoveryRoom = rooms[0];
  const recoveryDocument = contentStore.requireDocument(
    recoveryRoom.documentId,
  );
  redisStore.flushVolatileCollaborationState();

  const recoveryContext = createSessionContext({
    document: recoveryDocument,
    roomIndex: 1,
    sessionIndex: 99,
  });
  const recoveryDocumentName = createCollaborationDocumentName({
    project: PROJECT,
    environment: ENVIRONMENT,
    documentId: recoveryDocument.documentId,
  });
  const recoveredState = await hooks.onLoadDocument({
    context: recoveryContext,
    documentName: recoveryDocumentName,
  });
  const recoveredDocument = yjsUpdateToYDoc(recoveredState);
  const recoveredMarkdown = yDocToMarkdown(recoveredDocument);
  const recoveredFrontmatter = yDocToFrontmatter(recoveredDocument);
  const redisFreshAfterReopen = await isFreshRedisState({
    redisStore,
    document: recoveryDocument,
    expectedMarkdown: recoveryRoom.expectedMarkdown,
    expectedFrontmatter: recoveryRoom.expectedFrontmatter,
  });

  await hooks.onDisconnect({
    context: recoveryContext,
    documentName: recoveryDocumentName,
    document: recoveredDocument,
    clientsCount: 0,
  });
  await presenceTransport.shutdown();

  const redisLossRecovery: CollaborationRedisLossRecoveryResult = {
    documentId: recoveryDocument.documentId,
    expectedMarkdown: recoveryRoom.expectedMarkdown,
    recoveredMarkdown,
    expectedFrontmatter: recoveryRoom.expectedFrontmatter,
    recoveredFrontmatter,
    rebuiltFromPostgres:
      recoveredMarkdown === recoveryDocument.body &&
      recordsEqual(recoveredFrontmatter, recoveryDocument.frontmatter),
    redisFreshAfterReopen,
  };

  const elapsedMs = performance.now() - startedAt;
  const totals = rooms.reduce(
    (accumulator, room) => ({
      roomCount: accumulator.roomCount + 1,
      sessionCount: accumulator.sessionCount + room.sessionCount,
      mutationCount: accumulator.mutationCount + room.mutationCount,
      contentUpdatedEvents:
        accumulator.contentUpdatedEvents + room.lifecycleEventCount,
      versionRowsCreated:
        accumulator.versionRowsCreated + room.versionRowsCreated,
    }),
    {
      roomCount: 0,
      sessionCount: 0,
      mutationCount: 0,
      contentUpdatedEvents: 0,
      versionRowsCreated: 0,
    },
  );

  return {
    elapsedMs,
    rooms,
    redisLossRecovery,
    activeLockCountBeforeCleanup,
    targetPresenceDuring,
    targetPresenceAfter,
    totals,
  };
}
