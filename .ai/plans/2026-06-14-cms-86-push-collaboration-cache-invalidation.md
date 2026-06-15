# CMS-86 Push Collaboration Cache Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make successful existing-document `cms push` updates/deletes invalidate inactive collaboration Yjs Redis state and metadata without exposing Redis behavior to the CLI.

**Architecture:** Keep Redis invalidation server-owned. Add a small collaboration Redis store method that atomically deletes the documented inactive Yjs state/meta keys only when the active-room lock key is absent, expose it to content routes as an optional post-commit side effect, and wire it from the runtime's shared collaboration Redis store. Existing active collaboration locking remains the pre-mutation gate; invalidation runs only after the database mutation succeeds and failures are swallowed like lifecycle/webhook side effects.

**Tech Stack:** Bun tests, Elysia route handlers, TypeScript, Redis store abstraction, existing content API route harness.

---

## Spec Delta Summary

- Owning specs already cover the CMS-86 behavior; no `docs/specs` change is required.
- `docs/specs/SPEC-008-cli-and-sdk.md` defines `cms push` active collaboration handling and inactive cache invalidation.
- `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md` defines that inactive cache invalidation must not fail the already-committed mutation.
- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` defines the Redis Yjs state/meta key names.

## Task 1: Redis Store Inactive Cache Deletion

**Files:**
- Modify: `apps/server/src/lib/collaboration/redis-store.ts`
- Modify: `apps/server/src/lib/collaboration/redis-store.test.ts`

- [x] **Step 1: Write the failing Redis deletion tests**

Add this test near the existing inactive-cache lifecycle test in `apps/server/src/lib/collaboration/redis-store.test.ts`:

```typescript
test("inactive collaboration cache invalidation deletes Yjs state and metadata", async () => {
  const documentId = "9c003bee-4f4c-42d4-b445-d393a17067bb";
  const { client, store } = createStore();

  client.values.set(buildCollaborationYjsStateKey(documentId), Buffer.from("state"));
  client.values.set(
    buildCollaborationYjsMetaKey(documentId),
    JSON.stringify({ draftRevision: 4, bodyHash: "body-hash" }),
  );

  await store.invalidateInactiveCache(documentId);

  assert.equal(client.values.has(buildCollaborationYjsStateKey(documentId)), false);
  assert.equal(client.values.has(buildCollaborationYjsMetaKey(documentId)), false);
  assert.deepEqual(
    client.calls.filter((call) => call.method === "del"),
    [
      {
        method: "del",
        keys: [
          buildCollaborationYjsStateKey(documentId),
          buildCollaborationYjsMetaKey(documentId),
        ],
      },
    ],
  );
});

test("inactive collaboration cache invalidation preserves cache when active lock exists", async () => {
  const documentId = "54f00952-2fb9-49d4-8510-086850825c86";
  const { client, store } = createStore();
  const stateKey = buildCollaborationYjsStateKey(documentId);
  const metaKey = buildCollaborationYjsMetaKey(documentId);

  client.values.set(stateKey, Buffer.from("state"));
  client.values.set(
    metaKey,
    JSON.stringify({ draftRevision: 4, bodyHash: "body-hash" }),
  );
  client.values.set(buildCollaborationActiveKey(documentId), "room-1");

  await store.invalidateInactiveCache(documentId);

  assert.equal(client.values.has(stateKey), true);
  assert.equal(client.values.has(metaKey), true);
  assert.deepEqual(
    client.calls.filter((call) => call.method === "eval"),
    [
      {
        method: "eval",
        keys: [stateKey, metaKey, buildCollaborationActiveKey(documentId)],
      },
    ],
  );
});
```

- [x] **Step 2: Run the focused Redis test to verify failure**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts
```

Expected: fail with `store.invalidateInactiveCache is not a function`.

- [x] **Step 3: Add the atomic Redis script and store method**

In `apps/server/src/lib/collaboration/redis-store.ts`, add this script near the existing active-lock scripts:

```typescript
const INVALIDATE_INACTIVE_CACHE_SCRIPT = `
if redis.call("EXISTS", KEYS[3]) == 0 then
  return redis.call("DEL", KEYS[1], KEYS[2])
end
return 0
`;
```

Then add this method next to `clearInactiveCacheTtl` and `expireInactiveCache`:

```typescript
async invalidateInactiveCache(documentId: string): Promise<void> {
  const client = requireCollaborationRedisClient(dependency);

  await client.eval(
    INVALIDATE_INACTIVE_CACHE_SCRIPT,
    3,
    buildCollaborationYjsStateKey(documentId),
    buildCollaborationYjsMetaKey(documentId),
    buildCollaborationActiveKey(documentId),
  );
},
```

- [x] **Step 4: Run the focused Redis test to verify pass**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts
```

Expected: pass.

## Task 2: Content API Post-Commit Invalidation Hook

**Files:**
- Modify: `apps/server/src/lib/content-api/types.ts`
- Modify: `apps/server/src/lib/content-api/routes.ts`
- Modify: `apps/server/src/lib/content-api-test-support.ts`
- Modify: `apps/server/src/lib/content-api.test.ts`

- [x] **Step 1: Extend the content route option type**

In `apps/server/src/lib/content-api/types.ts`, add this type near `ContentActiveCollaborationChecker`:

```typescript
export type ContentInactiveCollaborationCacheInvalidator = {
  invalidateDocument: (documentId: string) => Promise<void>;
};
```

Then add this optional field to `MountContentApiRoutesOptions`:

```typescript
inactiveCollaborationCache?: ContentInactiveCollaborationCacheInvalidator;
```

- [x] **Step 2: Add failing route tests for update/delete invalidation**

In `apps/server/src/lib/content-api.test.ts`, add these tests near the active collaboration route tests:

```typescript
test("content API update invalidates inactive collaboration cache after successful commit", async () => {
  const invalidated: string[] = [];
  const handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidate-after-update",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidate-after-update" },
      body: "before",
    },
  );

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "invalidate-after-update" },
        body: "after",
        draftRevision: created.draftRevision,
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [created.documentId]);
});

test("content API delete invalidates inactive collaboration cache after successful commit", async () => {
  const invalidated: string[] = [];
  const handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidate-after-delete",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidate-after-delete" },
      body: "delete me",
    },
  );

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "DELETE",
      headers: { ...scopeHeaders, "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(invalidated, [created.documentId]);
});
```

- [x] **Step 3: Add failing tests for blocked/failed mutation behavior**

Add these tests after the update/delete invalidation tests:

```typescript
test("content API does not invalidate inactive collaboration cache when active collaboration blocks update", async () => {
  const invalidated: string[] = [];
  const activeDocumentIds = new Set<string>();
  const handler = createHandler({
    activeCollaboration: {
      isDocumentActive: async (documentId) => activeDocumentIds.has(documentId),
    },
    inactiveCollaborationCache: {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/no-invalidate-when-active",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "no-invalidate-when-active" },
      body: "before",
    },
  );

  activeDocumentIds.add(String(created.documentId));

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "no-invalidate-when-active" },
        body: "after",
      }),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(invalidated, []);
});

test("content API update remains successful when inactive collaboration cache invalidation fails", async () => {
  const invalidationFailure = new Error("redis unavailable");
  const handler = createHandler({
    inactiveCollaborationCache: {
      invalidateDocument: async () => {
        throw invalidationFailure;
      },
    },
  });
  const created = await createContentDocument(
    handler,
    (headers = {}) => headers,
    scopeHeaders,
    {
      path: "blog/invalidation-failure-still-updates",
      type: "BlogPost",
      locale: "en",
      format: "md",
      frontmatter: { slug: "invalidation-failure-still-updates" },
      body: "before",
    },
  );

  const response = await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}`, {
      method: "PUT",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        frontmatter: { slug: "invalidation-failure-still-updates" },
        body: "after",
        draftRevision: created.draftRevision,
      }),
    }),
  );
  const body = (await response.json()) as { data: { body: string } };

  assert.equal(response.status, 200);
  assert.equal(body.data.body, "after");
});
```

- [x] **Step 4: Update the test handler helper**

In `apps/server/src/lib/content-api-test-support.ts`, extend `createHandler` options:

```typescript
inactiveCollaborationCache?: MountContentApiRoutesOptions["inactiveCollaborationCache"];
```

Then pass it through to `mountContentApiRoutes`:

```typescript
inactiveCollaborationCache: options.inactiveCollaborationCache,
```

- [x] **Step 5: Run the focused content API tests to verify failure**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
```

Expected: fail because the new invalidator option is not implemented.

- [x] **Step 6: Add post-commit invalidation in routes**

In `apps/server/src/lib/content-api/routes.ts`, add this helper near `assertNoActiveCollaboration`:

```typescript
async function invalidateInactiveCollaborationCache(
  inactiveCollaborationCache: MountContentApiRoutesOptions["inactiveCollaborationCache"],
  documentId: string,
): Promise<void> {
  if (!inactiveCollaborationCache) {
    return;
  }

  await inactiveCollaborationCache.invalidateDocument(documentId).catch(() => {
    // The database mutation is already committed. Stale inactive Redis cache is
    // guarded by draft-revision/body-hash metadata on the next room load, so a
    // Redis deletion failure must not turn a successful content write into a
    // failed API response.
  });
}
```

Call it immediately after successful `commitMutation` results for:

```typescript
// PUT /api/v1/content/:documentId
await invalidateInactiveCollaborationCache(
  options.inactiveCollaborationCache,
  params.documentId,
);

// DELETE /api/v1/content/:documentId
await invalidateInactiveCollaborationCache(
  options.inactiveCollaborationCache,
  params.documentId,
);
```

For bulk operations, call it only for successful `delete` and `move` actions after the `commitMutation` result is assigned:

```typescript
if (payload.action === "delete" || payload.action === "move") {
  await invalidateInactiveCollaborationCache(
    options.inactiveCollaborationCache,
    documentId,
  );
}
```

Do not add invalidation to create, publish, unpublish, or plain restore in this task.
Version restore was added during code-review follow-up because it rewrites the
draft head and increments `draftRevision`, so it falls under the owning spec's
inactive-cache invalidation rule.

- [x] **Step 7: Run the focused content API tests to verify pass**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
```

Expected: pass.

## Task 3: Runtime Wiring and Verification

**Files:**
- Modify: `apps/server/src/lib/runtime-with-modules.ts`
- Modify: `apps/server/src/lib/runtime-with-modules.test.ts`
- Modify: `.ai/plans/2026-06-14-cms-86-push-collaboration-cache-invalidation.md`

- [x] **Step 1: Extend the runtime Redis store type**

In `apps/server/src/lib/runtime-with-modules.ts`, extend `RuntimeCollaborationRedisStore` with:

```typescript
  invalidateInactiveCache: (documentId: string) => Promise<void>;
```

- [x] **Step 2: Wire the content API route option**

In the `mountContentApiRoutes` call inside `createServerRequestHandlerWithModules`, add:

```typescript
inactiveCollaborationCache: collaborationRedisStore
  ? {
      invalidateDocument: (documentId) =>
        collaborationRedisStore.invalidateInactiveCache(documentId),
    }
  : undefined,
```

Keep `activeCollaboration` unchanged.

- [x] **Step 3: Add guarded AI/content-store invalidation tests**

In `apps/server/src/lib/runtime-with-modules.test.ts`, add tests near the existing `createCollaborationGuardedAiContentStore` coverage:

```typescript
test("collaboration-guarded AI content store invalidates inactive cache after update and delete", async () => {
  const invalidated: string[] = [];
  const store = createCollaborationGuardedAiContentStore(
    {
      getById: async () => undefined,
      create: async (_scope, payload) =>
        ({
          documentId: "created",
          path: payload.path ?? "content/created",
        }) as never,
      update: async (_scope, documentId) =>
        ({ documentId, path: "content/updated" }) as never,
      softDelete: async (_scope, documentId) =>
        ({ documentId, path: "content/deleted" }) as never,
    },
    undefined,
    {
      invalidateDocument: async (documentId) => {
        invalidated.push(documentId);
      },
    },
  );

  await store.update(
    { project: "marketing", environment: "draft" },
    "doc-update",
    { body: "updated" },
  );
  await store.softDelete(
    { project: "marketing", environment: "draft" },
    "doc-delete",
  );

  assert.deepEqual(invalidated, ["doc-update", "doc-delete"]);
});

test("collaboration-guarded AI content store ignores inactive cache invalidation failure", async () => {
  const store = createCollaborationGuardedAiContentStore(
    {
      getById: async () => undefined,
      create: async (_scope, payload) =>
        ({
          documentId: "created",
          path: payload.path ?? "content/created",
        }) as never,
      update: async (_scope, documentId) =>
        ({ documentId, path: "content/updated" }) as never,
      softDelete: async (_scope, documentId) =>
        ({ documentId, path: "content/deleted" }) as never,
    },
    undefined,
    {
      invalidateDocument: async () => {
        throw new Error("redis unavailable");
      },
    },
  );

  const updated = await store.update(
    { project: "marketing", environment: "draft" },
    "doc-update",
    { body: "updated" },
  );

  assert.equal(updated.documentId, "doc-update");
});
```

- [x] **Step 4: Extend the guarded AI/content-store wrapper**

In `apps/server/src/lib/runtime-with-modules.ts`, update `createCollaborationGuardedAiContentStore` to accept a third optional argument:

```typescript
inactiveCollaborationCache?: {
  invalidateDocument: (documentId: string) => Promise<void>;
}
```

Add a local helper inside the function:

```typescript
const invalidateInactiveCache = async (documentId: string) => {
  if (!inactiveCollaborationCache) {
    return;
  }

  await inactiveCollaborationCache.invalidateDocument(documentId).catch(() => {
    // The store mutation is already committed. Inactive Redis cache deletion is
    // best-effort because future room loads still validate cache metadata
    // against the PostgreSQL draft head.
  });
};
```

Then in `update`, `softDelete`, and optional `restore`, await invalidation after the underlying store call succeeds:

```typescript
const document = await store.update(scope, documentId, payload, opts);
await invalidateInactiveCache(documentId);
return document;
```

Use the same pattern for `softDelete` and `restore`.

- [x] **Step 5: Pass the runtime invalidator to the guarded AI/content-store wrapper**

Where `createCollaborationGuardedAiContentStore` is called in `apps/server/src/lib/runtime-with-modules.ts`, pass:

```typescript
collaborationRedisStore
  ? {
      invalidateDocument: (documentId) =>
        collaborationRedisStore.invalidateInactiveCache(documentId),
    }
  : undefined
```

- [x] **Step 6: Run focused tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts ./src/lib/content-api.test.ts ./src/lib/runtime-with-modules.test.ts
```

Expected: pass.

- [x] **Step 7: Run workspace gates**

Run:

```bash
bun run check
bun run format:check
git diff --check
bun run changeset:check
```

Expected: all pass. This task changes server-only runtime code and a plan file, so a changeset should not be required.

- [ ] **Step 8: Commit the CMS-86 slice**

Run:

```bash
git add .ai/memory/lessons.md .ai/plans/2026-06-14-cms-86-push-collaboration-cache-invalidation.md apps/server/src/lib/collaboration/redis-store.ts apps/server/src/lib/collaboration/redis-store.test.ts apps/server/src/lib/content-api/types.ts apps/server/src/lib/content-api/routes.ts apps/server/src/lib/content-api-test-support.ts apps/server/src/lib/content-api.test.ts apps/server/src/lib/runtime-with-modules.ts apps/server/src/lib/runtime-with-modules.test.ts
git commit -m "fix(collaboration): invalidate inactive cache after push writes"
```

Expected: commit succeeds and the worktree is clean.
