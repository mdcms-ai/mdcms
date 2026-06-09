# CMS-110 Bulk Content Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scoped bulk publish, unpublish, delete, and move operations to the content API and Studio content list.

**Architecture:** The backend exposes one `POST /api/v1/content/bulk` endpoint with action-discriminated input and per-document results. Studio adds a list-scoped bulk API helper and keeps selection/action eligibility in pure helpers so the page component stays testable.

**Tech Stack:** Bun, TypeScript, Elysia-style route mounting, Zod-style runtime validation, React, TanStack Query, Radix dialog primitives.

---

## Spec Delta

- `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md` defines `POST /api/v1/content/bulk`, action scopes, request/response types, partial-success behavior, move schema-hash validation, and deterministic errors.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` defines content-list selection, toolbar action gating, confirmation behavior, move folder validation, and result handling.

## File Structure

- Modify `packages/shared/src/lib/contracts/content-api.ts` for exported bulk request/response contract types.
- Modify `apps/server/src/lib/content-api/types.ts` for route-local payload/result types.
- Modify `apps/server/src/lib/content-api/routes.ts` for parsing helpers and the bulk route.
- Modify `apps/server/src/lib/content-api-test-support.ts` so schema-hash test wrapping covers bulk move.
- Modify `apps/server/src/lib/content-api.test.ts` for route tests.
- Modify `packages/studio/src/lib/content-list-api.ts` to add `bulkOperation`.
- Add `packages/studio/src/lib/content-list-api.test.ts` for list and bulk API request/response behavior.
- Add `packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.ts` for pure Studio selection/action helpers.
- Add `packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.test.ts` for helper behavior.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx` for checkboxes, toolbar, confirmation dialog, mutation, and result banner.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx` for table column and helper-render coverage.
- Add a generated changeset with `bun run changeset` because published package source changes touch `@mdcms/shared` and `@mdcms/studio`.

---

### Task 1: Backend Bulk Content Contract and Route

**Files:**
- Modify: `packages/shared/src/lib/contracts/content-api.ts`
- Modify: `apps/server/src/lib/content-api/types.ts`
- Modify: `apps/server/src/lib/content-api/routes.ts`
- Modify: `apps/server/src/lib/content-api-test-support.ts`
- Modify: `apps/server/src/lib/content-api.test.ts`

- [x] **Step 1: Add failing route tests**

Add tests in `apps/server/src/lib/content-api.test.ts` covering:

```ts
test("content API bulk publish returns per-document partial results", async () => {
  const handler = createHandler();
  const first = await createContentDocument(handler, (headers = {}) => headers, scopeHeaders, {
    path: "blog/bulk-publish-one",
    type: "BlogPost",
    locale: "en",
    format: "md",
    frontmatter: { slug: "bulk-publish-one" },
    body: "one",
  });

  const response = await handler(new Request("http://localhost/api/v1/content/bulk", {
    method: "POST",
    headers: { ...scopeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      action: "publish",
      documentIds: [first.documentId, "missing-document"],
      changeSummary: "Bulk publish",
    }),
  }));
  const body = await response.json() as {
    data: {
      action: "publish";
      requested: number;
      succeeded: number;
      failed: number;
      results: Array<{ documentId: string; status: string; document?: { publishedVersion: number | null }; error?: { code: string } }>;
    };
  };

  assert.equal(response.status, 200);
  assert.equal(body.data.requested, 2);
  assert.equal(body.data.succeeded, 1);
  assert.equal(body.data.failed, 1);
  assert.equal(body.data.results[0]?.status, "succeeded");
  assert.equal(body.data.results[0]?.document?.publishedVersion, 1);
  assert.equal(body.data.results[1]?.status, "failed");
  assert.equal(body.data.results[1]?.error?.code, "NOT_FOUND");
});
```

Also add tests for invalid duplicate IDs, bulk move path construction to `archive/<slug>`, and bulk move without schema hash returning `SCHEMA_HASH_REQUIRED`.

- [x] **Step 2: Run backend tests and verify they fail for the missing endpoint**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
```

Expected: FAIL because `/api/v1/content/bulk` is not mounted or contract types do not exist yet.

- [x] **Step 3: Add shared and route-local bulk types**

In `packages/shared/src/lib/contracts/content-api.ts`, export:

```ts
export type ContentBulkAction = "publish" | "unpublish" | "delete" | "move";

export type ContentBulkOperationInput = {
  action: ContentBulkAction;
  documentIds: string[];
  changeSummary?: string;
  actorId?: string;
  move?: {
    targetDirectory: string;
  };
};

export type ContentBulkOperationItemError = {
  code: string;
  message: string;
  statusCode: number;
  details?: unknown;
};

export type ContentBulkOperationResult =
  | {
      documentId: string;
      status: "succeeded";
      document: ContentDocumentResponse;
    }
  | {
      documentId: string;
      status: "failed";
      error: ContentBulkOperationItemError;
    };

export type ContentBulkOperationResponse = {
  action: ContentBulkAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: ContentBulkOperationResult[];
};
```

Mirror payload typing in `apps/server/src/lib/content-api/types.ts` by importing these shared types.

- [x] **Step 4: Implement parsing helpers and route execution**

In `apps/server/src/lib/content-api/routes.ts`:

- parse `action`, `documentIds`, optional `changeSummary`, optional `actorId`, and `move.targetDirectory`
- require CSRF for the route
- require `requireMatchingWriteSchemaHash` only for `move`
- authorize the global scope once using the action's required scope
- for each document ID, load `draft: true`, check current path authorization, check destination path authorization for move, run the existing store method, emit the matching lifecycle event, and append a result
- catch per-item `RuntimeError` failures and convert them into failed result entries

- [x] **Step 5: Extend schema-hash test wrapping for bulk move**

Update `apps/server/src/lib/content-api-test-support.ts` so `wrapHandlerWithAutoSchemaHash` adds `x-mdcms-schema-hash` for `POST /api/v1/content/bulk` only when the JSON body has `action: "move"`.

- [x] **Step 6: Run backend tests and verify green**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
```

Expected: PASS.

---

### Task 2: Studio Bulk API and Pure Selection Model

**Files:**
- Modify: `packages/studio/src/lib/content-list-api.ts`
- Add: `packages/studio/src/lib/content-list-api.test.ts`
- Add: `packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.ts`
- Add: `packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.test.ts`

- [x] **Step 1: Add failing Studio API tests**

Create `packages/studio/src/lib/content-list-api.test.ts` with tests proving `bulkOperation`:

- sends `POST /api/v1/content/bulk`
- includes `x-mdcms-project`, `x-mdcms-environment`, JSON content type, auth, and CSRF headers in cookie auth mode
- includes `x-mdcms-schema-hash` when provided
- returns valid `ContentBulkOperationResponse`
- throws `RuntimeError` for non-2xx responses and invalid success payloads

- [x] **Step 2: Add failing pure helper tests**

Create `packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.test.ts` with tests for:

- publish targets include only `draft` and `changed`
- unpublish targets include only `published`
- delete and move include all selected rows
- available actions follow capability booleans and selected row statuses
- target directory validation accepts `""` and `"archive/news"`, rejects `"/archive"`, `"archive/"`, and `"../archive"`

- [x] **Step 3: Run Studio focused tests and verify red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/content-list-api.test.ts ./src/lib/runtime-ui/lib/content-bulk-actions.test.ts
```

Expected: FAIL because the new API and helper files are missing.

- [x] **Step 4: Implement `bulkOperation` in the content list API**

Extend `createStudioContentListApi` with:

```ts
bulkOperation: (input: StudioContentBulkOperationInput) => Promise<ContentBulkOperationResponse>;
```

Use the same URL resolution and auth helpers as `list`. Bootstrap CSRF for cookie auth by following the existing document route API pattern. Validate the response shape strictly enough to reject missing `data.results[]`.

- [x] **Step 5: Implement pure helper module**

Implement `content-bulk-actions.ts` with:

- `getSelectedDocuments(documents, selectedDocumentIds)`
- `getBulkOperationTargets(action, selectedDocuments)`
- `getAvailableBulkActions(selectedDocuments, capabilities)`
- `validateBulkMoveTargetDirectory(value)`
- `formatBulkOperationSummary(action, count)`

- [x] **Step 6: Run Studio focused tests and verify green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/content-list-api.test.ts ./src/lib/runtime-ui/lib/content-bulk-actions.test.ts
```

Expected: PASS.

---

### Task 3: Studio Content List Bulk UI

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx`

- [x] **Step 1: Add failing render/model tests**

Extend `page.test.tsx` to verify:

- `getContentTypeTableColumns(false)` starts with a selection column and ends with actions
- `getContentTypeTableColumns(true)` includes selection, translations, and actions
- exported confirmation helper text for delete mentions Trash and the selected count

- [x] **Step 2: Run page tests and verify red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx
```

Expected: FAIL because the table column model and confirmation helper do not include bulk behavior yet.

- [x] **Step 3: Add selection column and toolbar state**

Update `page.tsx` to:

- add a `"selection"` table column with stable width
- render row checkboxes and a header select-all checkbox
- keep `selectedDocumentIds` in page controller state
- clear selection when `typeId`, project, environment, filters, search input, sort, page offset, or document list changes
- prevent checkbox clicks from triggering row navigation

- [x] **Step 4: Add confirmation dialog and bulk mutation**

Use the existing `Dialog` components to render one confirmation dialog for the active action. Use the content list API `bulkOperation` mutation, pass `schemaEntry?.schemaHash` for move, invalidate the content list and translation coverage queries on settled success, and show toast or inline error banner from result counts.

- [x] **Step 5: Disable pending interactions**

While a bulk mutation is pending, disable row actions, checkboxes, select-all, pagination clicks, filter controls, search input, and bulk toolbar buttons.

- [x] **Step 6: Run page tests and verify green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx
```

Expected: PASS.

---

### Task 4: Package Gate, Changeset, and Final Verification

**Files:**
- Add: `.changeset/*.md` via Changesets CLI
- Modify: `.ai/plans/2026-06-06-cms-110-bulk-content-operations.md`

- [x] **Step 1: Generate a changeset**

Run:

```bash
bun run changeset
```

Select patch releases for `@mdcms/shared` and `@mdcms/studio`.

- [x] **Step 2: Run focused verification**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
bun test --cwd packages/studio ./src/lib/content-list-api.test.ts ./src/lib/runtime-ui/lib/content-bulk-actions.test.ts ./src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx
```

Expected: PASS.

- [x] **Step 3: Run required gates**

Run:

```bash
bun run format:check
bun run check
git diff --check
```

Expected: PASS.

- [x] **Step 4: Mark this plan complete and commit**

After verification is green, mark all checkboxes in this plan complete, then stage and commit the CMS-110 slice:

```bash
git add docs/specs/SPEC-003-content-storage-versioning-and-migrations.md docs/specs/SPEC-006-studio-runtime-and-ui.md .ai/research/2026-06-06-cms-110-bulk-content-operations-design.md .ai/plans/2026-06-06-cms-110-bulk-content-operations.md packages/shared/src/lib/contracts/content-api.ts apps/server/src/lib/content-api/types.ts apps/server/src/lib/content-api/routes.ts apps/server/src/lib/content-api-test-support.ts apps/server/src/lib/content-api.test.ts packages/studio/src/lib/content-list-api.ts packages/studio/src/lib/content-list-api.test.ts packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.ts packages/studio/src/lib/runtime-ui/lib/content-bulk-actions.test.ts 'packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx' 'packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx' .changeset
git commit -m "feat(content): add bulk operations"
```
