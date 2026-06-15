# CMS-54 Active Collaboration Autosave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist active collaboration room changes from Redis/Yjs to the PostgreSQL draft head through server-owned autosave without creating document versions.

**Architecture:** Keep Hocuspocus as the collaboration transport and use its existing 2s/10s debounced `onStoreDocument` hook as the active autosave trigger. Serialize body/frontmatter from one Y.Doc snapshot, update the content store only when the draft actually changed, and publish the matching Y.Doc binary/metadata to Redis only after the durable save path succeeds. Share one persistence helper between debounced autosave and last-disconnect final save so final disconnect becomes a no-op after a successful autosave.

**Tech Stack:** Bun test, TypeScript, Hocuspocus, Yjs, `@hocuspocus/transformer`, `@mdcms/editor-core`, Elysia content-store interfaces.

---

## Spec Delta

Owning specs were updated before implementation:

- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` now defines active collaboration autosave, frontmatter in the collaboration Y.Doc, explicit flush control messages, Redis-loss recovery, and deterministic coverage.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` now says active collaboration saves must use collaboration autosave/final-save, not HTTP `PUT`.
- `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md` now defines collaboration autosave as a silent draft `UPDATE` that increments `draft_revision`, emits `content.updated`, and never creates `document_versions`.
- `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md` now includes active collaboration autosave/final-save in `content.updated`.

CMS-54 acceptance criteria covered by this plan:

1. Autosave writes Yjs binary state to Redis, serializes Y.Doc to ProseMirror JSON to Markdown, updates `documents`, increments `draft_revision`, and creates no `document_versions`.
2. Autosave emits `content.updated`.
3. Behavior remains internally consistent with active locks, optimistic draft revision checks, and Redis recovery metadata.
4. Public/operator workflow is documented in the specs above.

## File Structure

- Modify `apps/server/src/lib/collaboration/runtime.ts`
  - Add frontmatter Y.Map helpers.
  - Extend runtime content-store update payload to include `frontmatter`.
  - Add one `persistRoomDraft` helper used by `onStoreDocument` and `onDisconnect`.
  - Refresh room metadata after successful autosave.
  - Fail closed on stale draft revisions or active-lock loss.
- Modify `apps/server/src/lib/collaboration/runtime.test.ts`
  - Extend fake content store to preserve/update frontmatter.
  - Add focused runtime tests for active autosave, frontmatter, no-op final save, lifecycle events, and stale-revision fail-closed behavior.
- Modify only if types fail: `apps/server/src/lib/content-api/types.ts`
  - Prefer no change. The real content store already accepts `ContentWritePayload`; update only local collaboration runtime type imports if TypeScript needs the shared type.

## Task 1: Frontmatter in Collaboration Y.Doc

**Files:**
- Modify: `apps/server/src/lib/collaboration/runtime.ts`
- Test: `apps/server/src/lib/collaboration/runtime.test.ts`

- [ ] **Step 1: Write the failing frontmatter helper test**

Add this test near the markdown/Yjs helper coverage in `apps/server/src/lib/collaboration/runtime.test.ts`:

```typescript
test("markdownToYDoc stores frontmatter in the collaboration Y.Doc", () => {
  const frontmatter = {
    title: "Launch",
    featured: true,
    order: 3,
  };

  const ydoc = markdownToYDoc("# Launch\n\nBody.", frontmatter);

  assert.deepEqual(yDocToFrontmatter(ydoc), frontmatter);
  assert.equal(yDocToMarkdown(ydoc), "# Launch\n\nBody.");
});
```

Update the runtime imports in the same test file:

```typescript
import {
  computeCollaborationBodyHash,
  createCollaborationRuntime,
  createCollaborationRuntimeHooks,
  encodeYDocState,
  markdownToYDoc,
  yDocToFrontmatter,
  yDocToMarkdown,
  type CollaborationRuntimeAuthGuard,
  type CollaborationRuntimeContentStore,
  type CollaborationRuntimeContext,
  type CollaborationRuntimeRedisStore,
} from "./runtime.js";
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "markdownToYDoc stores frontmatter"
```

Expected: fails because `markdownToYDoc` does not accept frontmatter and `yDocToFrontmatter` is not exported.

- [ ] **Step 3: Implement frontmatter Y.Doc helpers**

In `apps/server/src/lib/collaboration/runtime.ts`, add a second field constant and helper functions near `COLLABORATION_YJS_FIELD_NAME` and the existing markdown conversion helpers:

```typescript
export const COLLABORATION_FRONTMATTER_FIELD_NAME = "frontmatter";

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function writeFrontmatterToYDoc(
  document: Y.Doc,
  frontmatter: Record<string, unknown>,
): void {
  const map = document.getMap<unknown>(COLLABORATION_FRONTMATTER_FIELD_NAME);
  map.clear();

  for (const [key, value] of Object.entries(cloneJsonObject(frontmatter))) {
    map.set(key, value);
  }
}

export function yDocToFrontmatter(document: Y.Doc): Record<string, unknown> {
  const map = document.getMap<unknown>(COLLABORATION_FRONTMATTER_FIELD_NAME);
  return cloneJsonObject(Object.fromEntries(map.entries()));
}
```

Update `markdownToYDoc` to accept frontmatter and seed the map:

```typescript
export function markdownToYDoc(
  markdown: string,
  frontmatter: Record<string, unknown> = {},
): Y.Doc {
  const tiptapDocument = parseMarkdownToDocument(markdown);
  const ydoc = TiptapTransformer.toYdoc(
    tiptapDocument,
    COLLABORATION_YJS_FIELD_NAME,
    createEditorCoreExtensions(),
  );
  writeFrontmatterToYDoc(ydoc, frontmatter);
  return ydoc;
}
```

Update `markdownToYjsUpdate`:

```typescript
export function markdownToYjsUpdate(
  markdown: string,
  frontmatter: Record<string, unknown> = {},
): Uint8Array {
  return encodeYDocState(markdownToYDoc(markdown, frontmatter));
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "markdownToYDoc stores frontmatter"
```

Expected: pass.

## Task 2: Autosave Persistence Helper

**Files:**
- Modify: `apps/server/src/lib/collaboration/runtime.ts`
- Test: `apps/server/src/lib/collaboration/runtime.test.ts`

- [ ] **Step 1: Write failing autosave tests**

Extend `FakeContentStore` update payload typing in `runtime.test.ts`:

```typescript
readonly updates: Array<{
  scope: ContentScope;
  documentId: string;
  payload: {
    body?: string;
    frontmatter?: Record<string, unknown>;
    updatedBy?: string;
  };
  options?: { expectedDraftRevision?: number };
}> = [];
```

Update `FakeContentStore.update` payload type and assignment:

```typescript
async update(
  scope: ContentScope,
  documentId: string,
  payload: {
    body?: string;
    frontmatter?: Record<string, unknown>;
    updatedBy?: string;
  },
  options?: { expectedDraftRevision?: number },
): Promise<ContentDocument> {
  this.updates.push({ scope, documentId, payload, options });

  if (this.updateError) {
    throw this.updateError;
  }

  if (
    options?.expectedDraftRevision !== undefined &&
    options.expectedDraftRevision !== this.document.draftRevision
  ) {
    throw new RuntimeError({
      code: "STALE_DRAFT_REVISION",
      message: "Draft has been modified since the room loaded.",
      statusCode: 409,
      details: {
        documentId,
        expectedDraftRevision: options.expectedDraftRevision,
        currentDraftRevision: this.document.draftRevision,
      },
    });
  }

  this.document = {
    ...this.document,
    body: payload.body ?? this.document.body,
    frontmatter: payload.frontmatter ?? this.document.frontmatter,
    draftRevision: this.document.draftRevision + 1,
    updatedBy: payload.updatedBy ?? this.document.updatedBy,
    updatedAt: "2026-06-11T10:01:00.000Z",
  };

  return this.document;
}
```

Add this test after `onStoreDocument writes Redis state and metadata only`; it must fail until autosave updates PostgreSQL:

```typescript
test("onStoreDocument autosaves changed body and frontmatter to PostgreSQL", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 4,
    frontmatter: { title: "Original", featured: false },
  });
  const { hooks, contentStore, lifecycleEvents, redisStore } =
    createHarness(document);
  const context = createContext();
  const ydoc = markdownToYDoc("# Changed\n\nBody.", {
    title: "Changed",
    featured: true,
  });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: ydoc,
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-1",
      userEmail: "writer-1@example.com",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.updates[0]?.options?.expectedDraftRevision, 4);
  assert.equal(contentStore.updates[0]?.payload.updatedBy, "writer-1");
  assert.match(contentStore.updates[0]?.payload.body ?? "", /# Changed/);
  assert.deepEqual(contentStore.updates[0]?.payload.frontmatter, {
    title: "Changed",
    featured: true,
  });
  assert.equal(contentStore.document.draftRevision, 5);
  assert.deepEqual(redisStore.metadata, {
    draftRevision: 5,
    bodyHash: computeCollaborationBodyHash(contentStore.document.body),
  });
  assert.equal(lifecycleEvents.events.length, 1);
  assert.equal(lifecycleEvents.events[0]?.event, "content.updated");
  assert.equal(lifecycleEvents.events[0]?.actor.id, "writer-1");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "autosaves changed body and frontmatter"
```

Expected: fails because `onStoreDocument` does not update the content store.

- [ ] **Step 3: Extend runtime store payload and room state**

In `runtime.ts`, update `CollaborationRuntimeContentStore.update` payload:

```typescript
payload: {
  body: string;
  frontmatter: Record<string, unknown>;
  updatedBy: string;
},
```

Extend `CollaborationRuntimeContext` and `RoomState`:

```typescript
loadedFrontmatterHash?: string;
loadedCanonicalFrontmatter?: Record<string, unknown>;
```

Add stable JSON hashing helpers near `computeCollaborationBodyHash`:

```typescript
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function computeFrontmatterHash(frontmatter: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(stableJson(frontmatter), "utf8").digest("hex")}`;
}
```

- [ ] **Step 4: Seed and assign frontmatter room state**

In `onLoadDocument`, call `convertMarkdownToYjsUpdate(draft.body, draft.frontmatter)` after updating the option type:

```typescript
convertMarkdownToYjsUpdate?: (
  markdown: string,
  frontmatter?: Record<string, unknown>,
) => Uint8Array;
```

Set room state with frontmatter:

```typescript
loadedFrontmatterHash: computeFrontmatterHash(draft.frontmatter),
loadedCanonicalFrontmatter: cloneJsonObject(draft.frontmatter),
```

Update `assignLoadedRoomState` to copy `loadedFrontmatterHash` and `loadedCanonicalFrontmatter` to context.

- [ ] **Step 5: Implement `persistRoomDraft` and call it from `onStoreDocument`**

Add a helper inside `createCollaborationRuntimeHooks` before the returned hook object:

```typescript
async function persistRoomDraft(input: {
  context: CollaborationRuntimeContext;
  document: Y.Doc;
  key: string;
  state: RoomState | undefined;
  writer: CollaborationRuntimeLastWriter;
}): Promise<CollaborationYjsMetadata> {
  const nextBody = yDocToMarkdown(input.document);
  const nextFrontmatter = yDocToFrontmatter(input.document);
  const loadedCanonicalBody =
    input.state?.loadedCanonicalBody ?? input.context.loadedCanonicalBody;
  const loadedFrontmatterHash =
    input.state?.loadedFrontmatterHash ?? input.context.loadedFrontmatterHash;

  if (typeof loadedCanonicalBody !== "string") {
    throw new RuntimeError({
      code: "INVALID_COLLABORATION_CONTEXT",
      message: "Collaboration room is missing loaded canonical body.",
      statusCode: 500,
      details: { documentId: input.context.documentId },
    });
  }

  if (typeof loadedFrontmatterHash !== "string") {
    throw new RuntimeError({
      code: "INVALID_COLLABORATION_CONTEXT",
      message: "Collaboration room is missing loaded frontmatter metadata.",
      statusCode: 500,
      details: { documentId: input.context.documentId },
    });
  }

  const nextFrontmatterHash = computeFrontmatterHash(nextFrontmatter);
  const bodyChanged = nextBody !== loadedCanonicalBody;
  const frontmatterChanged = nextFrontmatterHash !== loadedFrontmatterHash;

  if (!bodyChanged && !frontmatterChanged) {
    const currentDraft = await loadDraftDocument(options.contentStore, input.context);
    return {
      draftRevision: currentDraft.draftRevision,
      bodyHash: computeCollaborationBodyHash(currentDraft.body),
    };
  }

  const expectedDraftRevision =
    input.state?.loadedDraftRevision ?? input.context.loadedDraftRevision;

  if (typeof expectedDraftRevision !== "number") {
    throw new RuntimeError({
      code: "INVALID_COLLABORATION_CONTEXT",
      message: "Collaboration autosave is missing expected draft revision.",
      statusCode: 500,
      details: { documentId: input.context.documentId },
    });
  }

  const updated = await options.contentStore.update(
    scopeFromContext(input.context),
    input.context.documentId,
    {
      body: nextBody,
      frontmatter: nextFrontmatter,
      updatedBy: input.writer.userId,
    },
    { expectedDraftRevision },
  );

  const metadata = {
    draftRevision: updated.draftRevision,
    bodyHash: computeCollaborationBodyHash(updated.body),
  };

  if (input.state) {
    input.state.loadedDraftRevision = updated.draftRevision;
    input.state.loadedBodyHash = metadata.bodyHash;
    input.state.loadedCanonicalBody = nextBody;
    input.state.loadedFrontmatterHash = computeFrontmatterHash(updated.frontmatter);
    input.state.loadedCanonicalFrontmatter = cloneJsonObject(updated.frontmatter);
    input.state.lastWriter = input.writer;
  }

  assignLoadedRoomState(input.context, input.state ?? {
    documentId: input.context.documentId,
    documentName: input.key,
    loadedDraftRevision: updated.draftRevision,
    loadedBodyHash: metadata.bodyHash,
    loadedCanonicalBody: nextBody,
    loadedFrontmatterHash: computeFrontmatterHash(updated.frontmatter),
    loadedCanonicalFrontmatter: cloneJsonObject(updated.frontmatter),
    roomLeaseValue: input.context.roomLeaseValue ?? "",
    lastWriter: input.writer,
  });

  await options.lifecycleEvents?.emitContentEvent({
    event: "content.updated",
    scope: scopeFromContext(input.context),
    document: updated,
    actor: createLifecycleActor(input.writer),
  });

  return metadata;
}
```

Then in `onStoreDocument`, after `setYjsState`, call `persistRoomDraft` and store refreshed metadata:

```typescript
const writer = state?.lastWriter ??
  context.lastWriter ?? {
    userId: context.userId,
    ...(context.userEmail ? { email: context.userEmail } : {}),
  };
const metadata = await persistRoomDraft({
  context,
  document,
  key,
  state,
  writer,
});
await options.redisStore.setYjsMetadata(context.documentId, metadata);
updateLastWriter(roomStates, context);
```

- [ ] **Step 6: Run the focused autosave test**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "autosaves changed body and frontmatter"
```

Expected: pass.

## Task 3: Final Save Reuses Autosave State

**Files:**
- Modify: `apps/server/src/lib/collaboration/runtime.ts`
- Test: `apps/server/src/lib/collaboration/runtime.test.ts`

- [ ] **Step 1: Write failing no-op final-save-after-autosave test**

Add this test near the final disconnect tests:

```typescript
test("last disconnect after active autosave does not increment draft revision again", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 8,
    frontmatter: { title: "Original" },
  });
  const { hooks, contentStore, lifecycleEvents } = createHarness(document);
  const context = createContext();
  const changed = markdownToYDoc("# Changed\n\nBody.", { title: "Changed" });

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  await hooks.onStoreDocument({
    document: changed,
    documentName: DOCUMENT_ID,
    lastContext: createContext({
      userId: "writer-2",
      loadedDraftRevision: context.loadedDraftRevision,
      loadedBodyHash: context.loadedBodyHash,
      loadedFrontmatterHash: context.loadedFrontmatterHash,
      roomLeaseValue: context.roomLeaseValue,
    }),
  });
  await hooks.onDisconnect({
    clientsCount: 0,
    context,
    document: changed,
    documentName: DOCUMENT_ID,
  });

  assert.equal(contentStore.updates.length, 1);
  assert.equal(contentStore.document.draftRevision, 9);
  assert.equal(lifecycleEvents.events.length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails if final save duplicates**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "last disconnect after active autosave"
```

Expected before implementation is complete: fails with a second update or stale revision.

- [ ] **Step 3: Replace final-save body in `onDisconnect` with `persistRoomDraft`**

In `onDisconnect`, keep active-lock verification and final Redis/finalize behavior, but replace the manual `currentDraft`, body comparison, content store update, and lifecycle code with:

```typescript
const writer = state?.lastWriter ??
  context.lastWriter ?? {
    userId: context.userId,
    ...(context.userEmail ? { email: context.userEmail } : {}),
  };
const metadata = await persistRoomDraft({
  context,
  document,
  key,
  state,
  writer,
});

await options.redisStore.setYjsState(context.documentId, nextState);
await options.redisStore.setYjsMetadata(context.documentId, metadata);
```

Keep the existing `finalizeInactiveRoom`, heartbeat cleanup, finalized lease, and fail-closed behavior.

- [ ] **Step 4: Run final-save focused tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "last disconnect"
```

Expected: all last-disconnect tests pass after updating assertions for the new frontmatter-aware payload shape.

## Task 4: Fail-Closed Autosave Errors

**Files:**
- Modify: `apps/server/src/lib/collaboration/runtime.ts`
- Test: `apps/server/src/lib/collaboration/runtime.test.ts`

- [ ] **Step 1: Write stale autosave failure test**

Add this test near the stale revision final-save test:

```typescript
test("active autosave stale draft revision fails closed without overwriting PostgreSQL", async () => {
  const document = createDocument({
    body: "# Original\n\nBody.",
    draftRevision: 3,
  });
  const { hooks, contentStore, redisStore, closedRooms } =
    createHarness(document);
  const context = createContext();

  await hooks.onLoadDocument({ context, documentName: DOCUMENT_ID });
  contentStore.document = {
    ...contentStore.document,
    body: "# External change",
    draftRevision: 4,
  };

  await assert.rejects(
    hooks.onStoreDocument({
      document: markdownToYDoc("# Collaboration change"),
      documentName: DOCUMENT_ID,
      lastContext: context,
    }),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "STALE_DRAFT_REVISION",
  );

  assert.equal(contentStore.document.body, "# External change");
  assert.deepEqual(closedRooms, [DOCUMENT_ID]);
  assert.equal(
    redisStore.calls.some((call) => call.method === "finalizeInactiveRoom"),
    false,
  );
});
```

- [ ] **Step 2: Run the stale autosave test and verify it fails if room stays open**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts -t "active autosave stale draft revision"
```

Expected: fails until `onStoreDocument` marks the active lock lost on persistence errors.

- [ ] **Step 3: Mark room fail-closed on autosave persistence errors**

Wrap the `persistRoomDraft` call in `onStoreDocument`:

```typescript
let metadata: CollaborationYjsMetadata;
try {
  metadata = await persistRoomDraft({
    context,
    document,
    key,
    state,
    writer,
  });
} catch (error) {
  if (state) {
    await markActiveLockLost(key, state);
  }
  throw error;
}
```

Do not call `finalizeInactiveRoom` in this path.

- [ ] **Step 4: Run runtime collaboration tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts
```

Expected: all runtime tests pass.

## Task 5: Broader Verification

**Files:**
- Validate only; no planned file edits.

- [ ] **Step 1: Run collaboration server tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts ./src/lib/collaboration/redis-store.test.ts ./src/lib/collaboration/transport.test.ts ./src/lib/collaboration/transport.integration.test.ts
```

Expected: pass.

- [ ] **Step 2: Run content API active-lock regression tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts -t "collaboration"
```

Expected: pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Run format check**

Run:

```bash
bun run format:check
```

Expected: pass.

## Completion Notes

When this plan is implemented, the CMS-54 ticket is ready for review if:

- active `onStoreDocument` writes Redis state and PostgreSQL draft state;
- frontmatter is carried in the collaboration Y.Doc;
- autosave increments `draft_revision` exactly once per changed persisted snapshot;
- no version rows are created by tests or implementation paths;
- `content.updated` emits for changed autosaves;
- stale autosave/final-save failures fail closed;
- last-disconnect final save is no-op after successful active autosave.
