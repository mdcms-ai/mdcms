# CMS-110 and CMS-251 Bulk Ops Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining audited gaps for CMS-110 bulk content operations and CMS-251 media library behavior.

**Architecture:** Keep the existing backend and Studio implementations. Tighten shared public contracts and add behavior-focused Studio tests for CMS-110, then align the Studio media library UI and spec with CMS-251 filters, metadata, and point-of-use copy.

**Tech Stack:** Bun, TypeScript, Zod 4, React, TanStack Query, existing MDCMS Studio runtime UI.

---

## Spec Delta

CMS-110: no owning spec change is required. `SPEC-003` already defines strict `ContentBulkOperationInput` validation, and `SPEC-006` already defines content-list bulk UI behavior.

CMS-251: update `docs/specs/SPEC-006-studio-runtime-and-ui.md` so `/admin/media` exposes upload-date range controls instead of saying the gallery omits them. Keep the existing broader media-page upload/delete behavior because it is already present in the live spec and implementation, but do not expand CMS-251 beyond fixing browse/search/filter acceptance gaps.

## File Structure

- Modify `packages/shared/src/lib/contracts/content-api.ts` to make `ContentBulkOperationInputSchema` match the CMS-110 spec.
- Modify `packages/shared/src/lib/contracts/content-api.test.ts` with stricter shared contract tests.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx` only if a testable pure helper needs to be exported.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx` with focused CMS-110 behavior tests.
- Modify `docs/specs/SPEC-006-studio-runtime-and-ui.md` for CMS-251 date filter behavior.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/media-page.tsx` for CMS-251 date controls, uploader input, point-of-use copy, and per-card metadata.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/media-page.test.tsx` for CMS-251 UI coverage.

---

### Task 1: CMS-110 Shared Bulk Contract

**Files:**
- Modify: `packages/shared/src/lib/contracts/content-api.ts`
- Modify: `packages/shared/src/lib/contracts/content-api.test.ts`

- [x] **Step 1: Add failing contract tests**

Add tests proving:

```ts
ContentBulkOperationInputSchema.safeParse({
  action: "delete",
  documentIds: ["doc-1", "doc-1"],
}).success === false;

ContentBulkOperationInputSchema.safeParse({
  action: "delete",
  documentIds: [" "],
}).success === false;

ContentBulkOperationInputSchema.safeParse({
  action: "publish",
  documentIds: ["doc-1"],
  move: { targetDirectory: "archive" },
}).success === false;

ContentBulkOperationInputSchema.safeParse({
  action: "move",
  documentIds: ["doc-1"],
  move: { targetDirectory: "" },
}).success === true;
```

Also cover missing `move` for `action: "move"`, leading/trailing slash and `..` path segments, `changeSummary` rejected for non-publish actions, `actorId` rejected for delete/move, and 101 document ids rejected.

- [x] **Step 2: Verify red**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/content-api.test.ts
```

Expected before implementation: the new strict validation tests fail.

- [x] **Step 3: Tighten the shared schema**

Implement `ContentBulkOperationInputSchema` as a strict union that:

- trims and validates `documentIds`
- allows 1 through 100 unique ids
- validates `move.targetDirectory` with the same root/nested folder rules as the route
- allows `changeSummary` only for `publish`
- allows `actorId` only for `publish` and `unpublish`
- rejects `move` for non-move actions

- [x] **Step 4: Verify green**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/content-api.test.ts
```

Expected: all shared content API contract tests pass.

---

### Task 2: CMS-110 Studio Bulk Behavior Tests

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx`

- [x] **Step 1: Add focused behavior tests**

Add tests that verify the existing exported helpers and any newly exported pure helper cover:

- publish confirmation counts only eligible draft/changed selected rows
- unpublish confirmation counts only eligible published rows
- move confirmation requires a target folder input and surfaces validation copy for `/archive`
- bulk actions are unavailable when the matching capability is false
- move payload includes selected target ids and the schema hash
- partial failures render succeeded/failed counts and first failure copy

- [x] **Step 2: Verify red if a helper export is missing**

Run:

```bash
bun test --cwd packages/studio './src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx'
```

Expected before any needed helper export: tests fail only because the required behavior helper is not exported or covered.

- [x] **Step 3: Add the smallest testable helper/export**

If needed, export a pure helper from `page.tsx` that builds the bulk operation request from `(action, selectedDocuments, targetDirectory, schemaHash)`. Do not move runtime hook state or introduce a new abstraction unless the tests need it.

- [x] **Step 4: Verify green**

Run:

```bash
bun test --cwd packages/studio './src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx' ./src/lib/runtime-ui/lib/content-bulk-actions.test.ts
```

Expected: all CMS-110 Studio bulk tests pass.

---

### Task 3: CMS-251 Media Library Filters and Copy

**Files:**
- Modify: `docs/specs/SPEC-006-studio-runtime-and-ui.md`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/media-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/media-page.test.tsx`

- [x] **Step 1: Add failing Studio tests**

Add tests proving the media page:

- renders upload-date from/to controls in the filter surface
- sends `uploadedFrom` and `uploadedTo` through the existing query builder
- allows entering an exact raw `uploadedBy` actor id even when that actor is absent from the current result page
- renders point-of-use copy stating filename search only, simple metadata filters only, and no advanced organization
- shows MIME type and upload date on every media card, not only in the details drawer

- [x] **Step 2: Verify red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/media-page.test.tsx
```

Expected before implementation: the new CMS-251 tests fail.

- [x] **Step 3: Update the spec and UI**

Update `SPEC-006` to state that the gallery exposes `uploadedFrom` and `uploadedTo` controls. In `media-page.tsx`, add date inputs, a raw uploader actor-id input, concise basic-library limit copy, and card-level MIME/date metadata.

- [x] **Step 4: Verify green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/media-page.test.tsx ./src/lib/runtime-ui/app/admin/media-library-model.test.ts ./src/lib/runtime-ui/lib/media-library-api.test.ts
```

Expected: all CMS-251 Studio media tests pass.

---

### Task 4: Final Verification and PR Prep

**Files:**
- Check: all changed files
- Possibly add: generated changeset if the changeset gate requires it

- [x] **Step 1: Run focused validation**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/content-api.test.ts ./src/lib/contracts/media.test.ts
bun test --cwd apps/server ./src/lib/content-api.test.ts ./src/lib/media-api.test.ts
bun test --cwd packages/studio ./src/lib/content-list-api.test.ts ./src/lib/runtime-ui/lib/content-bulk-actions.test.ts './src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx' ./src/lib/runtime-ui/lib/media-library-api.test.ts ./src/lib/runtime-ui/app/admin/media-library-model.test.ts ./src/lib/runtime-ui/app/admin/media-page.test.tsx ./src/lib/remote-studio-app.test.ts
```

- [x] **Step 2: Run workspace gates**

Run:

```bash
bun run format:check
bun run check
```

- [x] **Step 3: Create changeset if required**

Run the repo changeset gate or `bun run changeset` if required by the published package policy. Do not hand-write changeset files.

- [ ] **Step 4: Commit and open PR**

Use conventional commit format and open a PR from `feat/cms-110-cms-251-bulk-ops` against `main`.
