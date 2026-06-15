import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { createDatabaseContentStore } from "../content-api.js";
import {
  DEFAULT_ACTOR,
  type ContentLifecycleEventSink,
} from "../content-api/types.js";
import {
  createContentDocument,
  createDatabaseTestContext,
  resetDatabaseTestScope,
  seedSchemaRegistryScope,
  stableFixtureName,
  stableFixturePath,
  testWithDatabase,
} from "../content-api-test-support.js";
import { documentVersions, documents } from "../db/schema.js";

import type { CollaborationYjsMetadata } from "./redis-store.js";
import {
  computeCollaborationBodyHash,
  createCollaborationDocumentName,
  createCollaborationRuntimeHooks,
  markdownToYDoc,
  yDocToFrontmatter,
  yDocToMarkdown,
  yjsUpdateToYDoc,
  type CollaborationRuntimeAuthGuard,
  type CollaborationRuntimeContext,
  type CollaborationRuntimeRedisStore,
} from "./runtime.js";

type CreatedDocument = {
  documentId: string;
  draftRevision: number;
  path: string;
};

class DatabaseRecoveryRedisStore implements CollaborationRuntimeRedisStore {
  readonly activeLocks = new Map<string, string>();
  readonly calls: Array<{
    method: "getFreshYjsState";
    documentId: string;
    hit: boolean;
  }> = [];

  private readonly states = new Map<string, Uint8Array>();
  private readonly metadata = new Map<string, CollaborationYjsMetadata>();

  async getFreshYjsState(
    documentId: string,
    draftHead: { draftRevision: number; bodyHash: string },
  ) {
    const state = this.states.get(documentId);
    const metadata = this.metadata.get(documentId);
    const hit =
      state !== undefined &&
      metadata?.draftRevision === draftHead.draftRevision &&
      metadata.bodyHash === draftHead.bodyHash;

    this.calls.push({ method: "getFreshYjsState", documentId, hit });

    if (!hit) {
      return null;
    }

    return {
      state: new Uint8Array(state),
      metadata,
    };
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

  async clearInactiveCacheTtl(_documentId: string): Promise<void> {
    return;
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
    return true;
  }

  flushVolatileCollaborationState(): void {
    this.states.clear();
    this.metadata.clear();
    this.activeLocks.clear();
  }
}

class DatabaseRecoveryLifecycleEvents implements ContentLifecycleEventSink {
  readonly events: Parameters<
    ContentLifecycleEventSink["emitContentEvent"]
  >[0][] = [];

  async emitContentEvent(
    event: Parameters<ContentLifecycleEventSink["emitContentEvent"]>[0],
  ): Promise<void> {
    this.events.push(event);
  }
}

const databaseRecoveryAuthGuard = {
  async revalidateWrite(): Promise<{ ok: true }> {
    return { ok: true };
  },
} satisfies CollaborationRuntimeAuthGuard;

function createContext(input: {
  created: CreatedDocument;
  project: string;
  environment: string;
  sessionId: string;
  userId: string;
}): CollaborationRuntimeContext {
  return {
    userId: input.userId,
    userEmail: "collaboration-recovery@mdcms.local",
    sessionId: input.sessionId,
    project: input.project,
    environment: input.environment,
    documentId: input.created.documentId,
    documentPath: input.created.path,
    role: "editor",
  };
}

testWithDatabase(
  "collaboration recovers edited draft content from Postgres after Redis state is lost",
  async () => {
    const { handler, dbConnection, csrfHeaders, cookie, userId } =
      await createDatabaseTestContext(
        "test:collaboration-db-recovery-after-redis-loss",
      );
    const scope = {
      project: stableFixtureName("collaboration-db-recovery"),
      environment: "production",
    };
    const requestScopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await resetDatabaseTestScope(dbConnection.db, scope);
      await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        schemaHash: "collaboration-db-recovery-schema",
        entries: [
          {
            type: "page",
            directory: "content/pages",
            localized: false,
            fields: {
              title: { kind: "string", required: true, nullable: false },
            },
          },
        ],
      });

      const created = (await createContentDocument(
        handler,
        csrfHeaders,
        requestScopeHeaders,
        {
          path: stableFixturePath("pages", "collaboration-db-recovery"),
          type: "page",
          locale: "__mdcms_default__",
          format: "mdx",
          frontmatter: {
            title: "Collaboration DB recovery",
          },
          body: "# Collaboration DB recovery\n\nInitial persisted body.",
        },
      )) as CreatedDocument;
      const documentName = createCollaborationDocumentName({
        project: scope.project,
        environment: scope.environment,
        documentId: created.documentId,
      });
      const redisStore = new DatabaseRecoveryRedisStore();
      const lifecycleEvents = new DatabaseRecoveryLifecycleEvents();
      let leaseIndex = 0;
      const hooks = createCollaborationRuntimeHooks({
        contentStore: createDatabaseContentStore({ db: dbConnection.db }),
        redisStore,
        authGuard: databaseRecoveryAuthGuard,
        lifecycleEvents,
        setActiveLockHeartbeat: () => "heartbeat",
        clearActiveLockHeartbeat: () => undefined,
        setFinalizedRoomLeaseTimeout: () => "finalized-room",
        clearFinalizedRoomLeaseTimeout: () => undefined,
        createRoomLeaseValue: () => `lease-${++leaseIndex}`,
      });
      const editContext = createContext({
        created,
        project: scope.project,
        environment: scope.environment,
        sessionId: "session-db-recovery-edit",
        userId,
      });

      await hooks.onLoadDocument({
        context: editContext,
        documentName,
      });

      const expectedFrontmatter = {
        title: "Recovered collaboration draft",
      };
      const editedDocument = markdownToYDoc(
        "# Recovered collaboration draft\n\nPersisted through Postgres.",
        expectedFrontmatter,
      );
      const expectedMarkdown = yDocToMarkdown(editedDocument);

      await hooks.onChange({
        context: editContext,
        documentName,
        document: editedDocument,
      });
      await hooks.onStoreDocument({
        lastContext: editContext,
        documentName,
        document: editedDocument,
      });
      await hooks.onDisconnect({
        context: editContext,
        documentName,
        document: editedDocument,
        clientsCount: 0,
      });

      const expectedDraftRevision = created.draftRevision + 1;
      const persisted = await dbConnection.db.query.documents.findFirst({
        where: eq(documents.documentId, created.documentId),
      });

      assert.ok(persisted);
      assert.equal(persisted.body, expectedMarkdown);
      assert.deepEqual(persisted.frontmatter, expectedFrontmatter);
      assert.equal(persisted.draftRevision, expectedDraftRevision);
      assert.equal(persisted.updatedBy, DEFAULT_ACTOR);
      assert.equal(lifecycleEvents.events.length, 1);
      assert.equal(lifecycleEvents.events[0]?.actor.id, userId);

      const apiReadResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${created.documentId}?draft=true`,
          {
            headers: {
              ...requestScopeHeaders,
              cookie,
            },
          },
        ),
      );
      const apiReadBody = (await apiReadResponse.json()) as {
        data: {
          body: string;
          draftRevision: number;
          frontmatter: Record<string, unknown>;
        };
      };

      assert.equal(apiReadResponse.status, 200);
      assert.equal(apiReadBody.data.body, expectedMarkdown);
      assert.deepEqual(apiReadBody.data.frontmatter, expectedFrontmatter);
      assert.equal(apiReadBody.data.draftRevision, expectedDraftRevision);

      const versionsBeforeRecovery = await dbConnection.db
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, created.documentId),
            eq(documentVersions.projectId, persisted.projectId),
            eq(documentVersions.environmentId, persisted.environmentId),
          ),
        );

      assert.equal(versionsBeforeRecovery.length, 0);

      redisStore.flushVolatileCollaborationState();

      const recoveryContext = createContext({
        created,
        project: scope.project,
        environment: scope.environment,
        sessionId: "session-db-recovery-reopen",
        userId,
      });
      const recoveredState = await hooks.onLoadDocument({
        context: recoveryContext,
        documentName,
      });
      const recoveredDocument = yjsUpdateToYDoc(recoveredState);

      assert.equal(yDocToMarkdown(recoveredDocument), expectedMarkdown);
      assert.deepEqual(
        yDocToFrontmatter(recoveredDocument),
        expectedFrontmatter,
      );
      assert.deepEqual(
        redisStore.calls.map(({ hit }) => hit),
        [false, false],
      );

      const rebuiltRedisState = await redisStore.getFreshYjsState(
        created.documentId,
        {
          draftRevision: expectedDraftRevision,
          bodyHash: computeCollaborationBodyHash(expectedMarkdown),
        },
      );

      assert.ok(rebuiltRedisState);

      await hooks.onDisconnect({
        context: recoveryContext,
        documentName,
        document: recoveredDocument,
        clientsCount: 0,
      });

      const versionsAfterRecovery = await dbConnection.db
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, created.documentId),
            eq(documentVersions.projectId, persisted.projectId),
            eq(documentVersions.environmentId, persisted.environmentId),
          ),
        );
      const persistedAfterRecovery =
        await dbConnection.db.query.documents.findFirst({
          where: eq(documents.documentId, created.documentId),
        });

      assert.equal(versionsAfterRecovery.length, 0);
      assert.equal(
        persistedAfterRecovery?.draftRevision,
        expectedDraftRevision,
      );
    } finally {
      await dbConnection.close();
    }
  },
);
