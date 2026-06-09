# CMS-251 Media Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Studio media library backed by project-scoped media metadata, with filename search, simple filters, sort, and pagination.

**Architecture:** Add a read-only `GET /api/v1/media` endpoint to the existing media API and metadata store. Studio consumes it through a dedicated media library API client and renders `/admin/media` as a dense list surface gated by `capabilities.media.read`.

**Tech Stack:** Bun, TypeScript, Elysia-style route mounting, Drizzle ORM, Zod 4, React, TanStack Query.

---

## Spec Delta

- `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md` defines `GET /api/v1/media`, filename-only search, MIME category/uploader/upload-date filters, sort, pagination, and `INVALID_QUERY_PARAM`.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` defines `/admin/media` as a live Studio media library with `media.read` gating, safe open/copy actions, and deterministic loading/empty/no-match/error/forbidden/unavailable states.
- `apps/studio-review` is absent from this checkout, so review-app fixture/handler/test updates cannot be made here.

## File Structure

- Modify `packages/shared/src/lib/contracts/media.ts` and `.test.ts` for list response contracts and media category helpers.
- Modify `apps/server/src/lib/media/types.ts`, `routes.ts`, `database-store.ts`, `media-api.test.ts`, and `database-store.test.ts` for backend list/search/filter/sort/pagination.
- Add `packages/studio/src/lib/runtime-ui/lib/media-library-api.ts` and `.test.ts`.
- Add `packages/studio/src/lib/runtime-ui/app/admin/media-library-model.ts` and `.test.ts`.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/capabilities-context.tsx` and `layout.tsx` to expose media capabilities.
- Replace `packages/studio/src/lib/runtime-ui/app/admin/media-page.tsx` placeholder and add `media-page.test.tsx`.
- Update `packages/studio/src/lib/remote-studio-app.test.ts` if route markup expectations change.
- Update `apps/docs/api-reference/media-and-webhooks.mdx` for the public media list endpoint.
- Add a generated changeset with `bun run changeset` because published package source changes touch `@mdcms/shared` and `@mdcms/studio`.

---

### Task 1: Shared Media List Contract

**Files:**
- Modify: `packages/shared/src/lib/contracts/media.ts`
- Modify: `packages/shared/src/lib/contracts/media.test.ts`

- [x] **Step 1: Add failing shared contract tests**

Add tests for:

- `deriveMediaAssetCategory("image/png") === "image"`
- document category for `text/plain` and `application/pdf`
- archive category for `application/zip`
- fallback category for `application/octet-stream`
- `assertMediaAssetListResponse` accepts `{ data: MediaAsset[], pagination }`
- `assertMediaAssetListResponse` rejects invalid pagination or invalid asset rows

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/media.test.ts
```

Expected: FAIL because the helper and list assertion do not exist yet.

- [x] **Step 2: Implement shared category and list response contracts**

In `media.ts`, export:

```ts
export type MediaAssetCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";

export type MediaAssetListResponse = {
  data: MediaAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};
```

Add `deriveMediaAssetCategory(mimeType: string): MediaAssetCategory` and `assertMediaAssetListResponse`.

- [x] **Step 3: Verify shared contract tests green**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/media.test.ts
```

Expected: PASS.

---

### Task 2: Backend Media List Endpoint and Store Query

**Files:**
- Modify: `apps/server/src/lib/media/types.ts`
- Modify: `apps/server/src/lib/media/routes.ts`
- Modify: `apps/server/src/lib/media/database-store.ts`
- Modify: `apps/server/src/lib/media-api.test.ts`
- Modify: `apps/server/src/lib/media/database-store.test.ts`

- [x] **Step 1: Add failing route tests**

In `media-api.test.ts`, add route tests proving:

- `GET /api/v1/media` requires `media:read`, passes project/environment scope, and forwards parsed query values to `store.listAssets`.
- Filename search query `q=hero` is trimmed and forwarded.
- Category, uploader, uploadedFrom/uploadedTo, sort/order, limit, and offset are parsed and forwarded.
- Invalid category, invalid dates, inverted date range, invalid sort/order, `limit=0`, `limit=101`, and negative offset return `INVALID_QUERY_PARAM`.
- The route requires explicit target routing.

Run:

```bash
bun test --cwd apps/server ./src/lib/media-api.test.ts
```

Expected: FAIL because `GET /api/v1/media` and `listAssets` are missing.

- [x] **Step 2: Add failing database store tests**

In `database-store.test.ts`, add tests proving:

- `listAssets` returns only media for the routed project.
- Filename search is case-insensitive.
- Category filters cover image, document, archive, and other.
- `uploadedBy`, `uploadedFrom`, and `uploadedTo` filters work.
- Sort by uploaded date, filename, and size works with explicit order.
- Pagination returns `total`, `limit`, `offset`, and `hasMore`.

Run:

```bash
bun test --cwd apps/server ./src/lib/media/database-store.test.ts
```

Expected: FAIL because `listAssets` is missing.

- [x] **Step 3: Implement typed query parsing and route**

Add `MediaAssetListQuery` and `MediaAssetListResult` in `types.ts`. In `routes.ts`, mount `GET /api/v1/media` before `GET /api/v1/media/:id`, parse query params, authorize `media:read`, and return `{ data, pagination }`.

Use `INVALID_QUERY_PARAM` (`400`) for malformed query values. Do not require object storage for this route.

- [x] **Step 4: Implement database filtering, sorting, and pagination**

In `database-store.ts`, implement `listAssets(scope, query)` using Drizzle conditions:

- project isolation via resolved project id
- case-insensitive filename search
- MIME category predicates matching SPEC-010
- exact `uploadedBy`
- UTC date range
- stable ordering by requested sort field plus `id` as tie-breaker
- separate total count query and paged data query

- [x] **Step 5: Verify backend media tests green**

Run:

```bash
bun test --cwd apps/server ./src/lib/media-api.test.ts
bun test --cwd apps/server ./src/lib/media/database-store.test.ts
```

Expected: PASS.

---

### Task 3: Studio Media Library API, Model, and Capabilities

**Files:**
- Add: `packages/studio/src/lib/runtime-ui/lib/media-library-api.ts`
- Add: `packages/studio/src/lib/runtime-ui/lib/media-library-api.test.ts`
- Add: `packages/studio/src/lib/runtime-ui/app/admin/media-library-model.ts`
- Add: `packages/studio/src/lib/runtime-ui/app/admin/media-library-model.test.ts`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/capabilities-context.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/layout.tsx`

- [x] **Step 1: Add failing Studio API tests**

Add tests proving the media library API:

- sends `GET /api/v1/media` with project/environment headers
- serializes q, category, uploadedBy, uploadedFrom, uploadedTo, sort, order, limit, and offset
- uses cookie or token auth consistently with existing Studio API clients
- returns valid `MediaAssetListResponse`
- throws `RuntimeError` for non-2xx responses and invalid success payloads

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-library-api.test.ts
```

Expected: FAIL because the API client does not exist yet.

- [x] **Step 2: Add failing model and capability tests**

Add `media-library-model.test.ts` for:

- active filter detection
- sort option to query mapping
- byte formatting
- date formatting fallback
- category labels
- empty vs no-match state derivation

Extend capability tests or add focused assertions so `AdminCapabilitiesValue` exposes `canReadMedia`, `canUploadMedia`, and `canDeleteMedia`.

- [x] **Step 3: Implement media library API and model helpers**

Follow existing `media-settings-api.ts` and `media-upload-api.ts` patterns. Keep model helpers pure and colocated with the media page.

- [x] **Step 4: Expose media capabilities through Admin layout context**

Map `capabilities.media.read/upload/delete` from the layout capability query into `AdminCapabilitiesProvider`.

- [x] **Step 5: Verify Studio API/model tests green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-library-api.test.ts ./src/lib/runtime-ui/app/admin/media-library-model.test.ts
```

Expected: PASS.

---

### Task 4: Studio Media Library Page

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/media-page.tsx`
- Add: `packages/studio/src/lib/runtime-ui/app/admin/media-page.test.tsx`
- Modify: `packages/studio/src/lib/remote-studio-app.test.ts`

- [x] **Step 1: Add failing page render tests**

Add tests proving the page renders:

- forbidden state when `canReadMedia` is false
- unavailable state when Studio API config is missing
- loading state
- empty state without active filters
- no-match state with active filters
- error state with retry action
- ready state with search/filter/sort controls, media metadata, open/copy actions, and basic-library limits copy

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/media-page.test.tsx ./src/lib/remote-studio-app.test.ts
```

Expected: FAIL because the page still renders Coming Soon.

- [x] **Step 2: Implement `useMediaLibrary` state and page controller**

Use TanStack Query with a query key scoped by project, environment, server URL, auth mode, and list query. Do not call the API when mounted context is unavailable or `canReadMedia` is false. Reset offset when search, filters, sort, project, or environment changes.

- [x] **Step 3: Replace the placeholder UI**

Render a dense Studio list surface:

- page header and concise limits copy
- filename search input
- MIME category select
- uploader id input
- uploaded-from and uploaded-to date inputs
- sort select
- list rows/cards with filename, MIME type/category, formatted size, uploaded actor id, upload date, open URL, and copy URL
- pagination controls using fixed page size 30
- deterministic loading, empty, no-match, forbidden, unavailable, error, and retry states

Do not add upload, delete, tags, folders, usage references, or bulk media actions.

- [x] **Step 4: Verify page tests green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/media-page.test.tsx ./src/lib/remote-studio-app.test.ts
```

Expected: PASS.

---

### Task 5: API Docs, Changeset, Verification, and Commit

**Files:**
- Modify: `apps/docs/api-reference/media-and-webhooks.mdx`
- Add: `.changeset/*.md` via Changesets CLI
- Modify: `.ai/plans/2026-06-06-cms-251-media-library.md`

- [x] **Step 1: Update public API docs**

Update `apps/docs/api-reference/media-and-webhooks.mdx` so media upload/read/delete paths match SPEC-010 and add `GET /api/v1/media` query parameters and response example.

- [x] **Step 2: Generate a changeset**

Run:

```bash
bun run changeset
```

Select a minor release for `@mdcms/shared` and a patch release for
`@mdcms/studio`.

- [x] **Step 3: Run focused verification**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/media.test.ts
bun test --cwd apps/server ./src/lib/media-api.test.ts ./src/lib/media/database-store.test.ts
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-library-api.test.ts ./src/lib/runtime-ui/app/admin/media-library-model.test.ts ./src/lib/runtime-ui/app/admin/media-page.test.tsx ./src/lib/remote-studio-app.test.ts
```

Expected: PASS.

- [x] **Step 4: Run required gates**

Run:

```bash
bun run format:check
bun run check
bun run changeset:check
git diff --check
```

Expected: PASS.

React Doctor should also run before committing React code:

```bash
npx -y react-doctor@latest . --verbose --diff
```

Current environment note: this command was blocked earlier because it requires fetching third-party npm code and escalation was rejected.

- [x] **Step 5: Mark this plan complete and commit**

After verification is green, mark all checkboxes in this plan complete, then stage and commit the CMS-251 slice:

```bash
git add docs/specs/SPEC-010-media-webhooks-search-and-integrations.md docs/specs/SPEC-006-studio-runtime-and-ui.md .ai/research/2026-06-06-cms-251-media-library-design.md .ai/plans/2026-06-06-cms-251-media-library.md packages/shared/src/lib/contracts/media.ts packages/shared/src/lib/contracts/media.test.ts apps/server/src/lib/media/types.ts apps/server/src/lib/media/routes.ts apps/server/src/lib/media/database-store.ts apps/server/src/lib/media-api.test.ts apps/server/src/lib/media/database-store.test.ts packages/studio/src/lib/runtime-ui/lib/media-library-api.ts packages/studio/src/lib/runtime-ui/lib/media-library-api.test.ts packages/studio/src/lib/runtime-ui/app/admin/media-library-model.ts packages/studio/src/lib/runtime-ui/app/admin/media-library-model.test.ts packages/studio/src/lib/runtime-ui/app/admin/capabilities-context.tsx packages/studio/src/lib/runtime-ui/app/admin/layout.tsx packages/studio/src/lib/runtime-ui/app/admin/media-page.tsx packages/studio/src/lib/runtime-ui/app/admin/media-page.test.tsx packages/studio/src/lib/remote-studio-app.test.ts apps/docs/api-reference/media-and-webhooks.mdx .changeset
git commit -m "feat(studio): add media library"
```
