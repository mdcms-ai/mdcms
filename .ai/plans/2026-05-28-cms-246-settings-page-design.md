# CMS-246 Settings Page Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the new MDCMS Studio visual system to Settings while preserving the existing API key and capability contracts.

**Architecture:** Keep Settings as a Studio-runtime page and avoid backend contract changes. Add a small read-only schema summary query for the General tab using the existing schema route contract, and keep API key create/list/revoke through the current `useApiKeyList` flow.

**Tech Stack:** React 19, TanStack Query, Bun tests, Tailwind runtime styles, Lucide icons.

---

## Spec Delta

- No new spec behavior is required. The implementation uses existing spec-owned contracts:
  - `SPEC-006` owns `/admin/settings` as an admin/settings-managed Studio route and capability-gated UI.
  - `SPEC-005` owns API key metadata, create, one-time secret reveal, revoke, operation scopes, and context allowlists.
  - `SPEC-004` owns schema sync as code-first/CLI-owned and supports read-only schema metadata.
- Affected UI/contract surface: Settings page only. Existing API calls remain `GET /api/v1/auth/api-keys`, `POST /api/v1/auth/api-keys`, `POST /api/v1/auth/api-keys/:id/revoke`, and `GET /api/v1/schema`.
- Acceptance criteria covered: visual redesign, read-only General context, API key lifecycle preservation, `capabilities.settings.manage` gate, loading/empty/error/mutation states, responsive layout, and Studio review check. `apps/studio-review` is not present in this branch.

## Files

- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/api-key-create-dialog.tsx`
- Modify: `apps/docs/guide/studio/settings.mdx`
- Create: no new source files unless the Settings page becomes too large during refactor.

## Task 1: Failing Settings Coverage

- [x] **Step 1: Add tests for General read-only design**

Add tests in `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx` that assert:

```ts
assert.match(markup, /data-mdcms-settings-subnav/);
assert.match(markup, /Schema hash/);
assert.match(markup, /Last schema sync/);
assert.match(markup, /mdcms schema sync/);
assert.doesNotMatch(markup, /Save changes/);
```

- [x] **Step 2: Add tests for API key ready state and revoke controls**

Add a pure view test or hook-friendly render test that supplies one `ApiKeyMetadata` and asserts the API keys tab renders `keyPrefix`, operation scopes, context allowlist, computed `Active` status, and a `Revoke` action.

- [x] **Step 3: Add tests for create dialog lifecycle helpers**

Export internal helper functions from `api-key-create-dialog.tsx` and test:

```ts
const input = buildApiKeyCreateInput({
  label: " CI ",
  selectedScopes: new Set(["content:read"]),
  expiresAt: "2026-06-01",
  project: "marketing-site",
  environment: "production",
});
assert.equal(input.label, "CI");
assert.deepEqual(input.contextAllowlist, [
  { project: "marketing-site", environment: "production" },
]);
```

Also verify a successful reducer transition reaches `step: "created"` with the one-time `key` present.

- [x] **Step 4: Verify red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx ./src/lib/runtime-ui/components/api-key-create-dialog.test.ts
```

Expected: new tests fail because schema summary, view helper, and dialog helpers are not implemented yet.

## Task 2: Settings Page Implementation

- [x] **Step 1: Add read-only schema summary query**

Use `createStudioSchemaRouteApi` and `useQuery` in `settings-page.tsx` to fetch `GET /api/v1/schema` only when `project`, `environment`, and `apiBaseUrl` are present. Derive `schemaHash` from `response.schemaHash` first, then from consistent entry hashes if needed. Derive `syncedAt` from consistent entry timestamps.

- [x] **Step 2: Redesign Settings shell**

Use an offwhite page canvas, responsive two-column layout (`lg:grid-cols-[220px_1fr]`), left sub-nav with General and API keys, flat 8px surfaces, 1px hairline borders, cobalt primary actions, and mono metadata rows. The mobile layout stacks the sub-nav above content.

- [x] **Step 3: Redesign General**

Render read-only rows for project, environment, server URL, schema hash, and synced timestamp. Include a terse CLI hint for `mdcms schema sync`. Show loading and error treatments for schema metadata without adding write controls.

- [x] **Step 4: Redesign API keys**

Keep existing `useApiKeyList`, create dialog, one-time reveal, and revoke calls. Restyle loading, empty, error, ready, and mutation states. Keep table horizontally scrollable and avoid text overlap by using `break-all`, `min-w`, and responsive grid/card wrappers where needed.

- [x] **Step 5: Verify green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx ./src/lib/runtime-ui/components/api-key-create-dialog.test.ts
```

Expected: tests pass.

## Task 3: Docs And Review App Check

- [x] **Step 1: Update Settings docs**

Update `apps/docs/guide/studio/settings.mdx` so it describes the current Settings page as General + API Keys, keeps schema/config editing CLI-owned, and leaves post-MVP Webhooks/Media as planned only.

- [x] **Step 2: Check Studio review**

Run:

```bash
test -d apps/studio-review
```

Expected in this branch: command exits non-zero because the app is absent. Document this in the final summary instead of inventing fixtures.

## Task 4: Verification

- [x] **Step 1: Run targeted Studio tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx ./src/lib/runtime-ui/components/api-key-create-dialog.test.ts ./src/lib/api-keys-api.test.ts
```

- [x] **Step 2: Run package check**

Run:

```bash
bun run check
```

- [x] **Step 3: Run unit suite if feasible**

Run:

```bash
bun run unit
```

Result: failed in an unrelated CLI loopback callback test with `Failed to start loopback callback listener` / `Failed to start server. Is port 0 in use?`. The clean branch had already shown the same port-0 listener failure mode in `apps/server/src/lib/auth.test.ts`; the changed Studio tests pass independently.
