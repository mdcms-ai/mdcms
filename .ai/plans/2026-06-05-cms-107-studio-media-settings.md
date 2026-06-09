# CMS-107 Studio Media Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Studio Settings Media panel for viewing and updating `media.image.maxUploadSizeBytes`.

**Architecture:** Studio gets a small media settings API wrapper, a focused hook, a pure form model for validation/dirtiness/payload building, and a Settings tab panel that follows the existing Settings page layout. Backend authorization remains final; Studio gates the route with the existing `settings.manage` capability and sends the active mounted target headers to the media settings endpoints.

**Tech Stack:** React 19, TanStack Query, Bun test, TypeScript, `@mdcms/shared` media contracts, existing Studio UI primitives.

---

## Spec Delta

- `docs/specs/SPEC-006-studio-runtime-and-ui.md` now defines `/admin/settings/media`, its capability gate, load/save/unavailable states, client validation, and copy requirements.
- Affected behavior: Studio Settings gains a Media tab that calls `GET/PUT /api/v1/media/settings` for the mounted `(project, environment)` target.
- Acceptance criteria depending on this delta: all CMS-107 criteria, especially role-aware Studio access, unlimited/null mode, positive byte validation, and backend semantic messaging.

## File Structure

- Create `packages/studio/src/lib/runtime-ui/lib/media-settings-api.ts`: routed Studio API wrapper for media settings.
- Create `packages/studio/src/lib/runtime-ui/lib/media-settings-api.test.ts`: API wrapper tests.
- Create `packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.ts`: pure draft/validation/payload helpers.
- Create `packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.test.ts`: model tests.
- Create `packages/studio/src/lib/runtime-ui/hooks/use-media-settings.ts`: TanStack Query hook for Settings page data/mutation state.
- Create `packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx`: Media Settings panel UI.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx`: add Media tab, route parsing, hook wiring, and panel rendering.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`: Settings route/tab/forbidden tests and panel render-state tests.
- Modify `docs/specs/SPEC-006-studio-runtime-and-ui.md`: already updated with the UI contract.
- Create a changeset with `bun run changeset` because `@mdcms/studio` source changes.

---

### Task 1: Studio Media Settings API Wrapper

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/lib/media-settings-api.test.ts`
- Create: `packages/studio/src/lib/runtime-ui/lib/media-settings-api.ts`

- [ ] **Step 1: Write failing API wrapper tests**

Add tests that prove target routing, CSRF, response validation, and deterministic errors:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";
import { RuntimeError, type MediaSettings } from "@mdcms/shared";

import {
  createStudioMediaSettingsApi,
  type StudioMediaSettingsApiOptions,
} from "./media-settings-api.js";

function readHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers instanceof Headers) return headers.get(name);
  if (headers && !Array.isArray(headers)) {
    const value = (headers as Record<string, string>)[name];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function createApi(options: StudioMediaSettingsApiOptions = {}) {
  return createStudioMediaSettingsApi(
    {
      project: "marketing-site",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    options,
  );
}

const settings: MediaSettings = {
  media: { image: { maxUploadSizeBytes: 10_485_760 } },
};

test("getSettings fetches routed media settings with cookie auth", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: settings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.getSettings();

  assert.deepEqual(result, settings);
  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/media/settings");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "authorization"), null);
});

test("updateSettings sends JSON media settings with target routing and csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const api = createApi({
    auth: { mode: "cookie" },
    csrfToken: "csrf-token",
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: settings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const input: MediaSettings = {
    media: { image: { maxUploadSizeBytes: null } },
  };

  const result = await api.updateSettings(input);

  assert.deepEqual(result, settings);
  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/media/settings");
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(readHeader(calls[0]?.init, "content-type"), "application/json");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
});

test("updateSettings rejects missing csrf for cookie mutations", async () => {
  const api = createApi({ auth: { mode: "cookie" } });

  await assert.rejects(
    () => api.updateSettings(settings),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "CSRF_TOKEN_MISSING",
  );
});

test("media settings API surfaces route errors and invalid responses", async () => {
  const failingApi = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "Nope." }), {
        status: 403,
      }),
  });

  await assert.rejects(
    () => failingApi.getSettings(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN" &&
      error.statusCode === 403,
  );

  const invalidApi = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => invalidApi.getSettings(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_SETTINGS_RESPONSE_INVALID",
  );
});
```

- [ ] **Step 2: Run API wrapper tests and verify RED**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-settings-api.test.ts
```

Expected: FAIL because `media-settings-api.ts` does not exist.

- [ ] **Step 3: Implement the API wrapper**

Implement `createStudioMediaSettingsApi(config, options)` with:

```ts
export type StudioMediaSettingsApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioMediaSettingsApiOptions = {
  auth?: StudioRuntimeAuth;
  csrfToken?: string | null;
  fetcher?: typeof fetch;
};

export type StudioMediaSettingsApi = {
  getSettings: () => Promise<MediaSettings>;
  updateSettings: (input: MediaSettings) => Promise<MediaSettings>;
};
```

Use the same helper patterns as `webhooks-api.ts`: `resolveStudioRelativeUrl`,
`applyStudioAuthToRequestInit`, target headers, `RuntimeError` for route
failures, `assertMediaSettingsResponse` for response validation, and
`CSRF_TOKEN_MISSING` for cookie-mode mutations without a CSRF token.

- [ ] **Step 4: Run API wrapper tests and verify GREEN**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-settings-api.test.ts
```

Expected: PASS.

---

### Task 2: Pure Media Settings Form Model

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.test.ts`
- Create: `packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.ts`

- [ ] **Step 1: Write failing model tests**

Add tests for unlimited/null, explicit positive values, invalid explicit values,
dirtiness, payload construction, and byte display:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";
import type { MediaSettings } from "@mdcms/shared";

import {
  buildMediaSettingsUpdateInput,
  createMediaSettingsDraft,
  formatMediaLimitLabel,
  getMediaSettingsDraftError,
  isMediaSettingsDraftDirty,
  type MediaSettingsDraft,
} from "./settings-media-model.js";

const unlimited: MediaSettings = { media: { image: { maxUploadSizeBytes: null } } };
const limited: MediaSettings = { media: { image: { maxUploadSizeBytes: 10485760 } } };

test("createMediaSettingsDraft maps null to unlimited mode", () => {
  assert.deepEqual(createMediaSettingsDraft(unlimited), {
    mode: "unlimited",
    explicitBytes: "",
  });
});

test("createMediaSettingsDraft maps positive values to explicit mode", () => {
  assert.deepEqual(createMediaSettingsDraft(limited), {
    mode: "explicit",
    explicitBytes: "10485760",
  });
});

test("buildMediaSettingsUpdateInput emits null for unlimited mode", () => {
  const draft: MediaSettingsDraft = { mode: "unlimited", explicitBytes: "2048" };
  assert.deepEqual(buildMediaSettingsUpdateInput(draft), unlimited);
});

test("buildMediaSettingsUpdateInput emits a positive safe integer for explicit mode", () => {
  const draft: MediaSettingsDraft = { mode: "explicit", explicitBytes: "2048" };
  assert.deepEqual(buildMediaSettingsUpdateInput(draft), {
    media: { image: { maxUploadSizeBytes: 2048 } },
  });
});

test("getMediaSettingsDraftError rejects invalid explicit byte values", () => {
  for (const explicitBytes of ["", "0", "-1", "1.5", "abc", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(
      getMediaSettingsDraftError({ mode: "explicit", explicitBytes }),
      "Enter a positive whole number of bytes.",
    );
  }
  assert.equal(getMediaSettingsDraftError({ mode: "explicit", explicitBytes: "1" }), null);
});

test("isMediaSettingsDraftDirty compares payloads against the saved settings", () => {
  assert.equal(
    isMediaSettingsDraftDirty(createMediaSettingsDraft(limited), limited),
    false,
  );
  assert.equal(
    isMediaSettingsDraftDirty({ mode: "unlimited", explicitBytes: "10485760" }, limited),
    true,
  );
});

test("formatMediaLimitLabel describes unlimited and explicit limits", () => {
  assert.equal(formatMediaLimitLabel(null), "Unlimited");
  assert.equal(formatMediaLimitLabel(10485760), "10,485,760 bytes");
});
```

- [ ] **Step 2: Run model tests and verify RED**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-media-model.test.ts
```

Expected: FAIL because `settings-media-model.ts` does not exist.

- [ ] **Step 3: Implement the model**

Implement:

```ts
export type MediaSettingsDraft =
  | { mode: "unlimited"; explicitBytes: string }
  | { mode: "explicit"; explicitBytes: string };

export function createMediaSettingsDraft(settings: MediaSettings): MediaSettingsDraft;
export function parseExplicitBytes(value: string): number | null;
export function getMediaSettingsDraftError(draft: MediaSettingsDraft): string | null;
export function buildMediaSettingsUpdateInput(draft: MediaSettingsDraft): MediaSettings;
export function isMediaSettingsDraftDirty(draft: MediaSettingsDraft, baseline: MediaSettings): boolean;
export function formatMediaLimitLabel(value: number | null): string;
```

Validation must use `Number.isSafeInteger(parsed)` and `parsed > 0`. Do not
accept decimal, blank, non-numeric, or unsafe values.

- [ ] **Step 4: Run model tests and verify GREEN**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-media-model.test.ts
```

Expected: PASS.

---

### Task 3: Media Settings Hook

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/hooks/use-media-settings.ts`

- [ ] **Step 1: Implement the hook from the proven API helper**

Create `useMediaSettings({ enabled?: boolean })` with:

```ts
export type SettingsPageMediaSettingsStatus =
  | "loading"
  | "ready"
  | "error"
  | "unavailable";

export type SettingsPageMediaSettingsState = {
  status: SettingsPageMediaSettingsStatus;
  settings: MediaSettings | null;
  errorMessage?: string;
  refetch: () => void;
  updateSettings: (input: MediaSettings) => Promise<MediaSettings>;
  isUpdating: boolean;
  updateError: Error | null;
  resetUpdateError: () => void;
};
```

Use `useStudioApiConfig()`, `useStudioSession()`, `useQueryClient()`,
`createStudioMediaSettingsApi()`, and the query key:

```ts
[
  "media-settings",
  project,
  environment,
  serverUrl,
  authMode,
  tokenOrNull,
]
```

Return `unavailable` with message
`Studio is missing project or environment context.` when no API config is
available or the hook is disabled.

- [ ] **Step 2: Typecheck the hook**

Run:

```bash
bun nx run studio:typecheck
```

Expected: PASS.

---

### Task 4: Media Settings Panel UI

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`

- [ ] **Step 1: Write failing panel render-state tests**

Extend `settings-page.test.tsx` imports with:

```ts
import type { MediaSettings } from "@mdcms/shared";
import type { SettingsPageMediaSettingsState } from "../../hooks/use-media-settings.js";
```

Add a `readyMediaSettingsState` fixture and pass `mediaSettingsState` into
`renderSettingsPageView`.

Add tests:

```ts
test("SettingsPageView renders media settings ready state with backend semantics", () => {
  const markup = renderSettingsPageView({ initialTab: "media" });

  assert.match(markup, /data-mdcms-settings-media-state="ready"/);
  assert.match(markup, /Image upload limit/);
  assert.match(markup, /No file-type allowlist/);
  assert.match(markup, /image\/\*/);
  assert.match(markup, /10,485,760 bytes/);
  assert.match(markup, /Save changes/);
});

test("SettingsPageView renders media settings loading error and unavailable states", () => {
  const loadingMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: { status: "loading", settings: null },
  });
  assert.match(loadingMarkup, /data-mdcms-settings-media-state="loading"/);

  const errorMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      status: "error",
      settings: null,
      errorMessage: "Failed to load media settings.",
    },
  });
  assert.match(errorMarkup, /Failed to load media settings/);
  assert.match(errorMarkup, /Retry/);

  const unavailableMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      status: "unavailable",
      settings: null,
      errorMessage: "Studio is missing project or environment context.",
    },
  });
  assert.match(unavailableMarkup, /Studio is missing project or environment context/);
});

test("SettingsPageView surfaces invalid and failed media settings saves inline", () => {
  const invalidMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaDraftOverride: { mode: "explicit", explicitBytes: "0" },
  });
  assert.match(invalidMarkup, /Enter a positive whole number of bytes/);
  assert.match(invalidMarkup, /aria-invalid="true"/);

  const failedMarkup = renderSettingsPageView({
    initialTab: "media",
    mediaSettingsState: {
      ...readyMediaSettingsState,
      updateError: new Error("Save failed."),
    },
  });
  assert.match(failedMarkup, /Save failed\./);
  assert.match(failedMarkup, /role="alert"/);
});
```

- [ ] **Step 2: Run Settings page tests and verify RED**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: FAIL because `SettingsPageView` has no Media panel support yet.

- [ ] **Step 3: Implement `SettingsMediaPanel`**

Create the panel with props:

```ts
export type SettingsMediaPanelProps = {
  state: SettingsPageMediaSettingsState;
  initialDraft?: MediaSettingsDraft;
};
```

Render states:

- `loading`: skeleton card with `data-mdcms-settings-media-state="loading"`.
- `error`: error card with retry button calling `state.refetch`.
- `unavailable`: error card with `data-mdcms-settings-media-state="unavailable"`.
- `ready`: form with:
  - heading `Media`
  - status label from `formatMediaLimitLabel`
  - `Switch` for unlimited mode
  - `Input` for explicit byte limit
  - Save and Reset buttons
  - semantic copy containing `No file-type allowlist` and `image/*`
  - inline validation and save errors using `role="alert"`

The submit handler builds the payload with `buildMediaSettingsUpdateInput`,
awaits `state.updateSettings`, then updates the local baseline from the returned
settings and shows a saved message.

- [ ] **Step 4: Run Settings page tests and verify GREEN for panel states**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: PASS for newly added panel tests after Task 5 wiring, or fail only
on missing route wiring if Task 5 has not started.

---

### Task 5: Wire Media Into Settings Routing

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`

- [ ] **Step 1: Write failing routing tests**

Replace the existing test named `SettingsPage renders Webhooks tab and still
omits Media tab` with a positive Media tab test:

```ts
test("SettingsPage renders Media tab in Settings navigation", () => {
  const markup = renderSettingsPage({
    initialTab: "general",
    capabilities: { canManageSettings: true },
  });
  assert.match(markup, /Webhooks/);
  assert.match(markup, /Media/);
});
```

Extend subnav-link and route-selection tests:

```ts
assert.match(markup, /href="\/admin\/settings\/media"/);
```

Add:

```ts
test("SettingsPage selects the Media section from the route", () => {
  const markup = renderSettingsPage({
    routeTab: "media",
    capabilities: { canManageSettings: true },
  });

  assert.match(markup, /data-mdcms-settings-media-state="loading"/);
  assert.match(
    markup,
    /data-active="true"[^>]*href="\/admin\/settings\/media"/,
  );
});
```

- [ ] **Step 2: Run Settings page tests and verify RED**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: FAIL because Settings routing does not recognize `media`.

- [ ] **Step 3: Implement route wiring**

In `settings-page.tsx`:

- Import `Image` from `lucide-react`.
- Add `{ id: "media", label: "Media", icon: Image, href: "/settings/media" }`
  to `settingsTabs`.
- Update `toSettingsTabId` to accept `"media"`.
- Import `SettingsMediaPanel` and `useMediaSettings`.
- Add `mediaSettingsState` to `SettingsPageView` props.
- Render `SettingsMediaPanel` when `activeTab === "media"`.
- Instantiate `useMediaSettings({ enabled: canManageSettings })` in
  `SettingsPage`.

- [ ] **Step 4: Run Settings page tests and verify GREEN**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: PASS.

---

### Task 6: Verification, Changeset, Review, Commit

**Files:**
- Create: one new `.changeset/*.md` through `bun run changeset`
- Commit all CMS-107 files

- [ ] **Step 1: Run focused Studio tests**

Run:

```bash
bun test --cwd packages/studio \
  ./src/lib/runtime-ui/lib/media-settings-api.test.ts \
  ./src/lib/runtime-ui/app/admin/settings-media-model.test.ts \
  ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run Studio typecheck**

Run:

```bash
bun nx run studio:typecheck
```

Expected: PASS.

- [ ] **Step 3: Create changeset through the CLI**

Run:

```bash
bun run changeset
```

Select `@mdcms/studio` as a patch change and summarize:

```text
Add Studio media upload settings UI.
```

- [ ] **Step 4: Run required repo checks**

Run:

```bash
bun run format:check
bun run check
```

Expected: both PASS.

- [ ] **Step 5: Dispatch spec and code review subagents**

Ask one reviewer to verify the implementation against:

- CMS-107 Jira acceptance criteria
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` Settings Media Panel section
- `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md` media settings semantics

Ask a second reviewer for code quality, accessibility, and maintainability.

- [ ] **Step 6: Fix reviewer blockers, rerun focused verification, then commit**

If reviewers approve, stage:

```bash
git add \
  docs/specs/SPEC-006-studio-runtime-and-ui.md \
  .ai/research/2026-06-05-cms-107-studio-media-settings-design.md \
  .ai/plans/2026-06-05-cms-107-studio-media-settings.md \
  packages/studio/src/lib/runtime-ui/lib/media-settings-api.ts \
  packages/studio/src/lib/runtime-ui/lib/media-settings-api.test.ts \
  packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.ts \
  packages/studio/src/lib/runtime-ui/app/admin/settings-media-model.test.ts \
  packages/studio/src/lib/runtime-ui/hooks/use-media-settings.ts \
  packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx \
  packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx \
  packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx \
  .changeset/*.md
git commit -m "feat(studio): add media settings UI"
```

---

## Self-Review

- Spec coverage: the plan covers view/update, unlimited/null and explicit
  positive byte values, semantic copy, role-aware gating, deterministic states,
  and point-of-use documentation.
- Completeness scan: no implementation step relies on TBD/TODO language.
- Type consistency: `MediaSettings`, `SettingsPageMediaSettingsState`, and
  `MediaSettingsDraft` names are introduced before use.
