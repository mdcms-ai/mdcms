# Collaboration-Aware Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Studio users to publish from an active collaboration document room while keeping PostgreSQL as the version source of truth.

**Architecture:** Add a collaboration socket publish control message parallel to the existing flush message. Studio uses that message for active document rooms and keeps normal HTTP publish for non-collaborative operation. If live editor changes are unsaved, Studio prompts the user to either flush first, publish the saved database draft, or cancel.

**Tech Stack:** Bun, TypeScript, Elysia/crossws, Hocuspocus/Yjs, React, TanStack Query, Bun test.

---

### Task 1: Canonical Spec Delta

**Files:**
- Modify: `docs/specs/SPEC-006-studio-runtime-and-ui.md`
- Modify: `docs/specs/SPEC-007-editor-mdx-and-collaboration.md`

- [x] **Step 1: Update Studio publish behavior**

Document that `Publish` is enabled for saved active collaboration drafts and that unsaved active-room changes require a prompt with `Save and publish`, `Publish saved draft`, and `Cancel`.

- [x] **Step 2: Update collaboration contract**

Document `mdcms.collaboration.publish` and `mdcms.collaboration.publish.result`, and state that normal HTTP/API/CLI writes remain blocked by the active collaboration lock.

- [ ] **Step 3: Run docs format check after implementation edits settle**

Run: `bun x prettier --check docs/specs/SPEC-006-studio-runtime-and-ui.md docs/specs/SPEC-007-editor-mdx-and-collaboration.md`

Expected: Prettier reports both files are formatted.

### Task 2: Backend Publish Control Message

**Files:**
- Modify: `apps/server/src/lib/collaboration-auth.ts`
- Modify: `apps/server/src/lib/collaboration/runtime.ts`
- Modify: `apps/server/src/lib/collaboration/transport.ts`
- Modify: `apps/server/src/lib/collaboration/transport.test.ts`
- Modify: `apps/server/src/lib/collaboration/runtime.test.ts`
- Modify if type compilation requires it: `apps/server/src/lib/collaboration/transport.integration.test.ts`
- Modify if test support requires it: `apps/server/src/lib/collaboration/recovery.integration.test.ts`
- Modify if test support requires it: `apps/server/src/lib/collaboration/load-soak-test-support.ts`

- [ ] **Step 1: Write transport tests for publish results**

Add tests in `apps/server/src/lib/collaboration/transport.test.ts`:

```ts
test("document collaboration publish message revalidates publish access and returns published document", async () => {
  const publishedDocument = createContentDocumentResponse({
    documentId: "11111111-1111-4111-8111-111111111111",
    hasUnpublishedChanges: false,
    publishedVersion: 6,
  });
  const publishContexts: CollaborationSessionContext[] = [];
  const server = createHocuspocusServerStub({
    async publishDocument(_documentName, input) {
      publishContexts.push(input.context);
      assert.equal(input.changeSummary, "Ready for launch.");
      return { document: publishedDocument };
    },
  });
  const { peer, transport } = createOpenDocumentPeer({ server });

  await sendJsonMessage(peer, {
    type: "mdcms.collaboration.publish",
    requestId: "publish-1",
    changeSummary: "Ready for launch.",
  });

  assert.deepEqual(peer.sentJson.at(-1), {
    type: "mdcms.collaboration.publish.result",
    requestId: "publish-1",
    status: "published",
    document: publishedDocument,
  });
  assert.equal(publishContexts[0]?.documentId, "11111111-1111-4111-8111-111111111111");
  await transport.shutdown();
});

test("document collaboration publish message returns authorization errors without publishing", async () => {
  let publishCalled = false;
  const server = createHocuspocusServerStub({
    async publishDocument() {
      publishCalled = true;
      throw new Error("publish should not run");
    },
  });
  const { peer, transport } = createOpenDocumentPeer({
    server,
    revalidatePublish: async () => ({ ok: false, closeCode: 4403 }),
  });

  await sendJsonMessage(peer, {
    type: "mdcms.collaboration.publish",
    requestId: "publish-denied",
  });

  assert.equal(publishCalled, false);
  assert.equal(peer.sentJson.at(-1)?.status, "error");
  assert.equal(peer.sentJson.at(-1)?.code, "FORBIDDEN");
  await transport.shutdown();
});
```

Use the local helper names already present in `transport.test.ts`; if their exact names differ, adapt the snippets to that file's existing stub pattern without changing the tested behavior.

- [ ] **Step 2: Run transport tests and verify RED**

Run: `bun test --cwd apps/server ./src/lib/collaboration/transport.test.ts`

Expected: the new publish-message tests fail because publish parsing, `revalidatePublish`, and `server.publishDocument` do not exist.

- [ ] **Step 3: Add publish authorization revalidation**

In `apps/server/src/lib/collaboration-auth.ts`, add `revalidatePublish` beside `revalidateWrite`:

```ts
async function revalidatePublish(
  request: Request,
  context: CollaborationSessionContext,
): Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }> {
  try {
    const session = await options.authService.getSession(request);
    if (!session) {
      return { ok: false, closeCode: 4401 };
    }

    await authorizeDraftRead({
      request,
      project: context.project,
      environment: context.environment,
      documentPath: context.documentPath,
    });
    await options.authService.authorizeRequest(request, {
      requiredScope: "content:publish",
      project: context.project,
      environment: context.environment,
      documentPath: context.documentPath,
    });

    return { ok: true };
  } catch (error) {
    const failure = mapAuthErrorToHandshakeFailure(error);
    return { ok: false, closeCode: failure.closeCode };
  }
}
```

Return it from `createCollaborationAuthGuard(...)` and extend the transport/runtime auth guard types.

- [ ] **Step 4: Add runtime publish method**

In `apps/server/src/lib/collaboration/runtime.ts`, extend `CollaborationRuntimeContentStore` with:

```ts
publish: (
  scope: ContentScope,
  documentId: string,
  input: { changeSummary?: string; actorId?: string },
) => Promise<ContentDocument>;
```

Extend the runtime server type with:

```ts
publishDocument?: (
  documentName: string,
  input: {
    context: CollaborationRuntimeContext;
    changeSummary?: string;
  },
) => Promise<{ document: ContentDocument }>;
```

Implement it by verifying the document name matches the room context, checking active-lock ownership when room state exists, calling `options.contentStore.publish(scopeFromContext(context), context.documentId, { changeSummary, actorId: toContentStoreActorId(context.userId) })`, and emitting `content.published` with `createLifecycleActor({ userId: context.userId, email: context.userEmail })`.

- [ ] **Step 5: Add transport publish message parsing**

In `apps/server/src/lib/collaboration/transport.ts`, add:

```ts
type CollaborationPublishRequest = {
  type: "mdcms.collaboration.publish";
  requestId: string;
  changeSummary?: string;
};
```

Parse JSON messages by `type`. Flush messages continue through `handleDocumentFlushMessage`; publish messages call a new `handleDocumentPublishMessage`.

`handleDocumentPublishMessage` must:

1. Require `options.runtime?.server.publishDocument`.
2. `await connection?.waitForPendingMessages?.()`.
3. Call `options.authGuard.revalidatePublish(peer.request, context)`.
4. On success, call `server.publishDocument(createDocumentNameFromContext(context), { context, changeSummary })`.
5. Send `{ type: "mdcms.collaboration.publish.result", requestId, status: "published", document }`.
6. On error, send `{ type: "mdcms.collaboration.publish.result", requestId, status: "error", code, message }`.

- [ ] **Step 6: Add runtime tests**

Add tests in `apps/server/src/lib/collaboration/runtime.test.ts` proving:

- `server.publishDocument(...)` publishes while an active lock exists and leaves the active lock in place.
- The lifecycle sink receives `content.published`.
- A mismatched document name/context fails without publishing.

Run: `bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts`

Expected after implementation: pass.

- [ ] **Step 7: Run backend focused tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/transport.test.ts
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts
bun test --cwd apps/server ./src/lib/collaboration-auth.test.ts
```

Expected: all pass.

### Task 3: Studio Collaboration Publish Client

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/lib/collaboration-document.ts`
- Modify: `packages/studio/src/lib/runtime-ui/hooks/use-document-collaboration.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

- [ ] **Step 1: Write client helper tests**

Add tests for `createCollaborationPublishRequest(...)` and `parseCollaborationPublishResult(...)` in the nearest existing collaboration document test file, or add one if absent:

```ts
test("collaboration publish request and result helpers round-trip", () => {
  const request = createCollaborationPublishRequest({
    requestId: "publish-1",
    changeSummary: "Ready for launch.",
  });
  assert.deepEqual(JSON.parse(request), {
    type: "mdcms.collaboration.publish",
    requestId: "publish-1",
    changeSummary: "Ready for launch.",
  });

  const result = parseCollaborationPublishResult(
    JSON.stringify({
      type: "mdcms.collaboration.publish.result",
      requestId: "publish-1",
      status: "published",
      document: createDocumentResponse({ hasUnpublishedChanges: false }),
    }),
  );
  assert.equal(result?.status, "published");
});
```

- [ ] **Step 2: Run helper tests and verify RED**

Run the relevant Studio test file.

Expected: tests fail because the publish helpers do not exist.

- [ ] **Step 3: Add Studio publish helper types**

In `collaboration-document.ts`, add `CollaborationPublishResult`, Zod validation for published/error payloads, `createCollaborationPublishRequest(...)`, and `parseCollaborationPublishResult(...)`. Reuse the shared `ContentDocumentResponse` shape by validating the envelope fields Studio consumes, or use `z.object({}).passthrough()` for `document` and cast to `ContentDocumentResponse` after safe parsing.

- [ ] **Step 4: Extend useDocumentCollaboration**

Add to `UseDocumentCollaborationResult`:

```ts
publish: (input: { changeSummary?: string }) => Promise<CollaborationPublishResult>;
```

Implement it using the same pending request map pattern as `flush()`, sending `createCollaborationPublishRequest(...)` and resolving when `parseCollaborationPublishResult(...)` sees the matching `requestId`.

- [ ] **Step 5: Make publish state accept injected publish function**

In `content-document-page-state.ts`, keep `publishContentDocumentReadyState(...)` unchanged structurally, but allow callers to pass an API whose `publish` method is backed by collaboration. The existing `Pick<StudioDocumentRouteApi, "publish" | "listVersions">` signature should remain valid if the collaboration wrapper matches `StudioDocumentRouteApi["publish"]`.

- [ ] **Step 6: Add Studio view tests for active collaboration publish button**

Update existing tests in `content-document-page.test.tsx`:

- Replace the old assertion that active collaboration disables publish.
- Add a test where `state.saveState === "saved"`, `hasUnpublishedChanges === true`, and `documentCollaboration.status === "open"` renders Publish without `disabled`.
- Add a test where `state.saveState === "unsaved"` and active collaboration renders Publish enabled and clicking/opening state is represented by the unsaved prompt props.

- [ ] **Step 7: Add prompt UI and state**

In `content-document-page-state.ts`, add:

```ts
publishUnsavedPromptOpen: boolean;
```

Initialize it to `false`, clear it after publish, clear it when canceling the prompt, and keep it closed for non-ready states.

In `ContentDocumentPageView`, render a dialog with:

- Title: `Publish unsaved changes?`
- `Save and publish`
- `Publish saved draft`
- `Cancel`

The dialog copy must state that `Publish saved draft` leaves live editor changes unpublished.

- [ ] **Step 8: Route publish button through prompt logic**

Change the Publish button logic:

- `canPublish` is true when ready, writable, has unpublished changes, not publishing, not viewing a historical version, and either saved or active collaboration is open.
- Clicking Publish with active collaboration and `saveState !== "saved"` opens the unsaved prompt.
- Clicking Publish with saved state opens the normal publish dialog.

- [ ] **Step 9: Implement save-and-publish and publish-saved-draft**

Add handlers:

- `onPublishUnsavedPromptOpenChange`
- `onPublishSaveAndContinue`
- `onPublishSavedDraft`

`Save and publish` must call the existing collaboration `flush()` path, update state, and then open the normal publish dialog or directly submit if the publish dialog was already confirmed. `Publish saved draft` must skip flush and open the normal publish dialog.

The actual publish submission must use collaboration `publish({ changeSummary })` when `documentCollaboration.enabled`; otherwise it uses the existing HTTP API publish.

- [ ] **Step 10: Run Studio focused tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

### Task 4: Integration Verification and Release Metadata

**Files:**
- Create: `.changeset/*.md` using `bun run changeset add`
- Modify if generated/needed: package changeset metadata only

- [ ] **Step 1: Run focused server and Studio tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/transport.test.ts
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts
bun test --cwd apps/server ./src/lib/collaboration-auth.test.ts
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run formatting and workspace check**

Run:

```bash
bun run format:check
bun run check
```

Expected: both pass.

- [ ] **Step 3: Add changeset**

Run: `bun run changeset add`

Select patch bumps for `@mdcms/studio` only unless shared package exports or published server package metadata require additional package bumps. Do not hand-write changeset files.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/specs/SPEC-006-studio-runtime-and-ui.md docs/specs/SPEC-007-editor-mdx-and-collaboration.md .ai/plans/2026-06-16-collaboration-aware-publish.md apps/server/src/lib/collaboration-auth.ts apps/server/src/lib/collaboration/runtime.ts apps/server/src/lib/collaboration/transport.ts apps/server/src/lib/collaboration/transport.test.ts apps/server/src/lib/collaboration/runtime.test.ts packages/studio/src/lib/runtime-ui/lib/collaboration-document.ts packages/studio/src/lib/runtime-ui/hooks/use-document-collaboration.ts packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx .changeset
git commit -m "feat(studio): publish from active collaboration rooms"
```

Expected: commit succeeds with only scoped files staged.

---

## Self-Review

- Spec coverage: `SPEC-006` covers the prompt and button behavior; `SPEC-007` covers socket publish and active-lock semantics. Tasks 2 and 3 implement those contracts.
- Placeholder scan: the plan contains no deferred implementation markers.
- Type consistency: server uses `publishDocument` for socket publish; Studio uses `publish` on the collaboration hook and adapts it to `StudioDocumentRouteApi["publish"]` for existing state reducers.
