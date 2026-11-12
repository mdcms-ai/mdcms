import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createInMemoryContentStore } from "./in-memory-store.js";
import type { ContentStore } from "./types.js";
import { createDatabaseContentStore } from "./database-store.js";
import { createDatabaseConnection } from "../db.js";
import { RuntimeError } from "@mdcms/shared";
import { createServerRequestHandler } from "../server.js";
import { mountContentApiRoutes } from "./routes.js";
import { baseEnv, authorizedTestRequest } from "../content-api-test-support.js";
import {
  dbEnv,
  seedSchemaRegistryScope,
  testAttribution,
  testWithDatabase,
} from "../content-api-test-support.js";

const schema = {
  type: "Note",
  directory: "notes",
  localized: true,
  fields: {},
};
const attribution = testAttribution;

async function verifyTransitions(
  store: ContentStore,
  scope: { project: string; environment: string },
) {
  const created = await store.create(
    scope,
    {
      type: "Note",
      path: `notes/${randomUUID()}`,
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "original",
    },
    { attribution },
  );
  const published = await store.publish(scope, created.documentId, {
    attribution,
  });
  assert.equal(published.draftRevision, created.draftRevision);
  await assert.rejects(
    store.softDelete(scope, created.documentId, {
      attribution,
      expectedDraftRevision: created.draftRevision,
      requireUnpublished: true,
    }),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "DOCUMENT_PUBLISHED",
  );
  assert.equal(
    (await store.getById(scope, created.documentId))?.publishedVersion,
    1,
  );
  assert.deepEqual(
    await store.restore(scope, created.documentId, {
      attribution,
      expectedDraftRevision: published.draftRevision,
    }),
    { document: published, transition: "none" },
  );
  await assert.rejects(
    store.restore(scope, created.documentId, {
      attribution,
      expectedDraftRevision: published.draftRevision + 1,
    }),
    (error: any) => error.code === "STALE_DRAFT_REVISION",
  );
  const deleted = await store.softDelete(scope, created.documentId, {
    attribution,
    expectedDraftRevision: published.draftRevision,
  });
  assert.equal(deleted.draftRevision, published.draftRevision + 1);
  await assert.rejects(
    store.restore(scope, created.documentId, {
      attribution,
      expectedDraftRevision: published.draftRevision,
    }),
    (error: any) => error.code === "STALE_DRAFT_REVISION",
  );
  const { document: restored, transition: draftTransition } =
    await store.restore(scope, created.documentId, {
      attribution,
      expectedDraftRevision: deleted.draftRevision,
    });
  assert.equal(draftTransition, "restored_draft");
  assert.equal(restored.publishedVersion, null);
  assert.equal(restored.hasUnpublishedChanges, true);
  assert.equal(restored.draftRevision, deleted.draftRevision + 1);
  assert.equal(
    (await store.listVersions(scope, created.documentId, {})).total,
    1,
  );
  await assert.rejects(
    store.softDelete(scope, created.documentId, {
      attribution,
      expectedDraftRevision: deleted.draftRevision,
    }),
    (error: any) => error.code === "STALE_DRAFT_REVISION",
  );
  const againDeleted = await store.softDelete(scope, created.documentId, {
    attribution,
    expectedDraftRevision: restored.draftRevision,
  });
  const { document: againPublished, transition: publishedTransition } =
    await store.restore(scope, created.documentId, {
      attribution,
      expectedDraftRevision: againDeleted.draftRevision,
      targetStatus: "published",
    });
  assert.equal(publishedTransition, "restored_published");
  assert.equal(againPublished.publishedVersion, 2);
  assert.equal(againPublished.hasUnpublishedChanges, false);
  assert.equal(againPublished.draftRevision, againDeleted.draftRevision + 1);
  assert.equal(
    (await store.getById(scope, created.documentId))?.body,
    "original",
  );
  assert.ok(
    (await store.list(scope, { q: "original" })).rows.some(
      (document) => document.documentId === created.documentId,
    ),
  );
  assert.equal(
    (await store.getVersion(scope, created.documentId, 2)).publishedBy,
    attribution.actorId,
  );
  const outcomes = await Promise.allSettled([
    store.softDelete(scope, created.documentId, {
      attribution,
      expectedDraftRevision: againPublished.draftRevision,
    }),
    store.softDelete(scope, created.documentId, {
      attribution,
      expectedDraftRevision: againPublished.draftRevision,
    }),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  await assert.rejects(
    store.publish(scope, created.documentId, { attribution }),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "NOT_FOUND",
  );
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.equal(rejected?.reason.code, "STALE_DRAFT_REVISION");
  assert.equal(
    (await store.listVersions(scope, created.documentId, {})).total,
    2,
  );
  const concurrentRestores = await Promise.all([
    store.restore(scope, created.documentId, {
      attribution,
      targetStatus: "published",
    }),
    store.restore(scope, created.documentId, {
      attribution,
      targetStatus: "published",
    }),
  ]);
  assert.deepEqual(
    concurrentRestores.map((result) => result.transition).sort(),
    ["none", "restored_published"],
  );
  assert.equal(
    (await store.listVersions(scope, created.documentId, {})).total,
    3,
  );
}

test("in-memory delete and restore enforce revision preconditions and restore publication state", async () => {
  const scope = { project: "transitions", environment: "production" };
  await verifyTransitions(
    createInMemoryContentStore({
      schemaScopes: [{ ...scope, schemas: { Note: schema } }],
    }),
    scope,
  );
});

testWithDatabase(
  "PostgreSQL delete and restore transitions are atomic under competing revisions",
  async () => {
    const connection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `transitions-${randomUUID()}`,
      environment: "production",
    };
    try {
      await seedSchemaRegistryScope(connection.db, {
        scope,
        entries: [schema],
      });
      await verifyTransitions(
        createDatabaseContentStore({ db: connection.db }),
        scope,
      );
    } finally {
      await connection.close();
    }
  },
);

testWithDatabase(
  "publish rechecks deletion after waiting for the document lock",
  async () => {
    const connection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `publish-lock-${randomUUID()}`,
      environment: "production",
    };
    let unlock: () => void = () => {};
    try {
      await seedSchemaRegistryScope(connection.db, {
        scope,
        entries: [schema],
      });
      const store = createDatabaseContentStore({ db: connection.db });
      const created = await store.create(
        scope,
        {
          type: "Note",
          path: "notes/locked",
          locale: "en",
          format: "md",
          frontmatter: {},
          body: "original",
        },
        { attribution },
      );
      let locked: () => void = () => {};
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const deletion = connection.db.transaction(async (tx) => {
        await tx.execute(
          sql`select document_id from documents where document_id = ${created.documentId} for update`,
        );
        locked();
        await released;
        await tx.execute(
          sql`update documents set is_deleted = true, draft_revision = draft_revision + 1 where document_id = ${created.documentId}`,
        );
      });
      await acquired;
      const publication = store.publish(scope, created.documentId, {
        attribution,
      });
      let waiting = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await connection.db.execute(
            sql`select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%documents%'`,
          );
          if (rows.length > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        unlock();
      }
      await deletion;
      await assert.rejects(
        publication,
        (error: unknown) =>
          error instanceof RuntimeError && error.code === "NOT_FOUND",
      );
      assert.equal(
        waiting,
        true,
        "publish must reach the locked transition before deletion commits",
      );
      assert.equal(
        (await store.listVersions(scope, created.documentId, {})).total,
        0,
      );
      assert.equal(
        (await store.getById(scope, created.documentId, { draft: true }))
          ?.isDeleted,
        true,
      );
    } finally {
      unlock();
      await connection.close();
    }
  },
);

test("restore HTTP scopes, preconditions and lifecycle events match resulting state", async () => {
  const scope = { project: "transitions", environment: "production" };
  const store = createInMemoryContentStore({
    schemaScopes: [{ ...scope, schemas: { Note: schema } }],
  });
  const created = await store.create(
    scope,
    {
      type: "Note",
      path: "notes/route",
      locale: "en",
      format: "md",
      frontmatter: {},
      body: "searchable",
    },
    { attribution },
  );
  const deleted = await store.softDelete(scope, created.documentId, {
    attribution,
  });
  let scopes = ["content:publish"];
  let assistant = false;
  const events: string[] = [];
  const handler = createServerRequestHandler({
    env: baseEnv,
    configureApp: (app) =>
      mountContentApiRoutes(app, {
        store,
        authorize: async (_request, requirement) => {
          if (!scopes.includes(requirement.requiredScope))
            throw new RuntimeError({
              code: "FORBIDDEN",
              message: "Scope denied.",
              statusCode: 403,
            });
          return {
            ...authorizedTestRequest,
            ...(assistant ? { internalChannel: "studio_ai" as const } : {}),
          };
        },
        requireCsrf: async () => {},
        getWriteSchemaSyncState: async () => ({ schemaHash: "hash" }),
        lifecycleEvents: {
          emitContentEvent: async (event) => {
            events.push(event.event);
          },
        },
      }),
  });
  const restore = (body: unknown) =>
    handler(
      new Request(
        `http://localhost/api/v1/content/${created.documentId}/restore`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mdcms-project": scope.project,
            "x-mdcms-environment": scope.environment,
          },
          body: JSON.stringify(body),
        },
      ),
    );
  assert.equal((await restore({})).status, 403);
  assert.equal((await restore({ targetStatus: "bad" })).status, 400);
  assert.equal(
    (await restore({ targetStatus: "published", expectedDraftRevision: "1" }))
      .status,
    400,
  );
  assert.equal(
    (
      await restore({
        targetStatus: "published",
        expectedDraftRevision: created.draftRevision,
      })
    ).status,
    409,
  );
  assert.deepEqual(events, []);
  const success = await restore({
    targetStatus: "published",
    expectedDraftRevision: deleted.draftRevision,
  });
  assert.equal(success.status, 200, await success.clone().text());
  assert.deepEqual(events, ["content.restored", "content.published"]);
  assert.equal((await restore({ targetStatus: "published" })).status, 200);
  assert.deepEqual(events, ["content.restored", "content.published"]);
  const current = await store.getById(scope, created.documentId);
  assert.equal(current?.publishedVersion, 1);
  assert.equal(
    current?.updatedBy,
    authorizedTestRequest.principal.session.userId,
  );
  assert.equal(
    (await store.getVersion(scope, created.documentId, 1)).publishedOrigin
      ?.channel,
    "studio",
  );
  await store.unpublish(scope, created.documentId, { attribution });
  const liveDraft = await store.getById(scope, created.documentId, {
    draft: true,
  });
  assert.equal((await restore({ targetStatus: "published" })).status, 200);
  assert.deepEqual(
    await store.getById(scope, created.documentId, { draft: true }),
    liveDraft,
  );
  assert.deepEqual(events, ["content.restored", "content.published"]);
  assert.equal(
    (await store.listVersions(scope, created.documentId, {})).total,
    1,
  );
  assert.equal((await store.list(scope, { q: "searchable" })).total, 0);
  await store.softDelete(scope, created.documentId, { attribution });
  events.length = 0;
  const concurrent = await Promise.all([
    restore({ targetStatus: "published" }),
    restore({ targetStatus: "published" }),
  ]);
  assert.deepEqual(
    concurrent.map((response) => response.status),
    [200, 200],
  );
  assert.deepEqual(events, ["content.restored", "content.published"]);
  assert.equal(
    (await store.listVersions(scope, created.documentId, {})).total,
    2,
  );
  scopes = ["content:delete"];
  const response = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}?expectedDraftRevision=${deleted.draftRevision}`,
      {
        method: "DELETE",
        headers: {
          "x-mdcms-project": scope.project,
          "x-mdcms-environment": scope.environment,
        },
      },
    ),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(events, ["content.restored", "content.published"]);
  assert.equal(
    (await store.getById(scope, created.documentId))?.publishedVersion,
    2,
  );
  assistant = true;
  const restoredHead = await store.getById(scope, created.documentId, {
    draft: true,
  });
  const protectedDelete = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}?expectedDraftRevision=${restoredHead!.draftRevision}`,
      {
        method: "DELETE",
        headers: {
          "x-mdcms-project": scope.project,
          "x-mdcms-environment": scope.environment,
        },
      },
    ),
  );
  assert.equal(protectedDelete.status, 409);
  assert.equal(
    ((await protectedDelete.json()) as { code: string }).code,
    "DOCUMENT_PUBLISHED",
  );
  assert.deepEqual(events, ["content.restored", "content.published"]);
  assert.equal(
    (await store.getById(scope, created.documentId))?.publishedVersion,
    2,
  );
});
