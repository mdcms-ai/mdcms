# CMS-105 Studio Webhooks CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Studio Settings -> Webhooks configuration CRUD for admins, backed by the existing webhook REST contracts and shown alongside delivery history.

**Architecture:** Keep webhook configuration reads/mutations in the Studio runtime webhooks API client and a focused React Query hook. Keep form state and input builders in a dedicated dialog component so `settings-page.tsx` only wires state into `SettingsWebhooksPanel`. Update SPEC-010 first because it currently treats the configuration UI as planned while CMS-105 makes it canonical.

**Tech Stack:** TypeScript 5.9, React 19, Bun test, React Query, Radix UI Dialog/Switch, Playwright for browser-level Settings route coverage.

---

## Spec Delta

- `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md` must state that Studio Settings -> Webhooks manages webhook configuration CRUD and delivery history for the mounted project/environment.
- The affected behavior is the Studio Webhooks settings surface plus the existing `GET/POST/PUT/DELETE /api/v1/webhooks` contracts.
- CMS-105 acceptance criteria depend on this delta: create/edit/delete UI, URL/events/secret/active fields, complete primary and edge states, `settings.manage` gating, and point-of-use operator documentation.

## File Structure

- Modify `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md`: make the Studio configuration UI canonical and define role-aware UI behavior.
- Modify `packages/studio/README.md`: document the Settings -> Webhooks operator workflow.
- Modify `packages/studio/src/lib/runtime-ui/lib/webhooks-api.ts`: add configuration list/create/update/delete methods.
- Modify `packages/studio/src/lib/runtime-ui/lib/webhooks-api.test.ts`: cover CRUD routing, scoped headers, CSRF headers, bearer auth, invalid responses, and route errors.
- Create `packages/studio/src/lib/runtime-ui/hooks/use-webhook-config-list.ts`: own configuration query and mutations.
- Create `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.tsx`: own create/edit dialog, reducer, event multi-select, secret handling, URL and active controls.
- Create `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.test.ts`: test input builders, submittable rules, reducer event toggles, and edit secret omission.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/settings-webhooks-panel.tsx`: render configuration list/states/actions above delivery history.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx`: wire configuration hook into the Settings view.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`: test the Webhooks tab configuration surface states and role gate.
- Create `e2e/studio-webhooks-settings.spec.ts`: browser coverage for the configured Settings -> Webhooks UI using route interception.
- Modify `package.json`: add the missing `e2e` script used by `playwright.config.ts`.

---

### Task 1: Canonical Spec And Operator Docs

**Files:**
- Modify: `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md`
- Modify: `packages/studio/README.md`

- [ ] **Step 1: Update SPEC-010 purpose and Studio UI behavior**

In `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md`, replace the current purpose paragraph:

```md
This chapter describes the webhook system design. Webhook configuration CRUD,
asynchronous server-side delivery, persisted delivery history, and the Studio
delivery history surface are available. Studio create/edit/delete configuration
UI remains a planned follow-up surface.
```

with:

```md
This chapter describes the webhook system design. Webhook configuration CRUD,
asynchronous server-side delivery, persisted delivery history, and the Studio
configuration and delivery history surfaces are available.
```

Then replace the delivery-history-only Studio paragraph after the `statusCode` explanation:

```md
The Studio Settings -> Webhooks surface is read-only for delivery history. It
shows the most recent attempts for the mounted project/environment, exposes
filters for webhook id, event, and outcome, and renders loading, empty, error,
and populated states. The Settings route remains gated by `settings.manage`;
users without that capability do not see or interact with the history view.
```

with:

```md
The Studio Settings -> Webhooks surface manages webhook configuration and
delivery history for the mounted project/environment. The Settings route remains
gated by `settings.manage`; users without that capability do not see or
interact with webhook configuration or history views, and the client does not
issue webhook configuration or delivery history requests while the route is
forbidden.

The configuration section shows loading, empty, error, unavailable, and
populated states. Admins can create, edit, and delete webhook configurations.
The create form includes URL, event multi-select, HMAC secret, and active
toggle controls. The edit form includes URL, event multi-select, an optional
HMAC secret field for rotation, and active toggle controls. Secrets are never
shown after save; leaving the edit secret empty omits `secret` from the update
payload and preserves the existing secret. Delete requires explicit
confirmation, removes only the webhook configuration, and leaves persisted
delivery history append-only.

Successful create, edit, and delete mutations refresh the configuration list.
Failed mutations surface the endpoint error message and keep the user's form or
confirmation state available for correction. The delivery history section shows
the most recent attempts for the mounted project/environment, exposes filters
for webhook id, event, and outcome, and renders loading, empty, error,
unavailable, and populated states.
```

- [ ] **Step 2: Update Studio README operator workflow**

In `packages/studio/README.md`, replace the current Webhooks paragraph under the route table:

```md
`/admin/settings` includes the Webhooks tab for read-only delivery history. It
shows the latest attempts for the mounted project/environment and filters by
webhook id, event, and outcome. Webhook create/edit/delete configuration remains
API-only until the configuration UI ships.
```

with:

```md
`/admin/settings` includes the Webhooks tab for admins and owners. It manages
webhook configurations for the mounted project/environment with create, edit,
and delete actions, including URL, event multi-select, HMAC secret rotation, and
active toggle controls. The same tab shows delivery history with filters for
webhook id, event, and outcome. Webhook secrets are write-only; Studio never
shows a saved secret, and leaving the edit secret field empty preserves the
existing secret.
```

- [ ] **Step 3: Run format check for docs only**

Run:

```bash
bun x prettier --check docs/specs/SPEC-010-media-webhooks-search-and-integrations.md packages/studio/README.md
```

Expected: `All matched files use Prettier code style!`

---

### Task 2: Studio Webhooks API Client CRUD

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/lib/webhooks-api.test.ts`
- Modify: `packages/studio/src/lib/runtime-ui/lib/webhooks-api.ts`

- [ ] **Step 1: Write failing API client tests**

Append these tests to `packages/studio/src/lib/runtime-ui/lib/webhooks-api.test.ts`:

```ts
import type { WebhookConfig, WebhookCreateInput } from "@mdcms/shared";
```

Merge the import above with the existing `@mdcms/shared` import, then add:

```ts
const webhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "marketing-site",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-03T00:00:00.000Z",
};

test("listConfigs fetches routed webhook configurations", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: [webhookConfig] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await api.listConfigs();

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/webhooks");
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(result[0]?.id, webhookConfig.id);
});

test("createConfig posts scoped webhook input with csrf", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: webhookConfig }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const input: WebhookCreateInput = {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret: "a".repeat(32),
    active: true,
  };

  const result = await api.createConfig(input, "csrf-token");

  assert.equal(result.id, webhookConfig.id);
  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/webhooks");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(readHeader(calls[0]?.init, "content-type"), "application/json");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "marketing-site");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), input);
});

test("updateConfig and deleteConfig route ids safely", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "cookie" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      const data =
        init?.method === "DELETE"
          ? { deleted: true, id: "webhook/with spaces" }
          : webhookConfig;
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await api.updateConfig(
    "webhook/with spaces",
    { active: false, secret: "b".repeat(32) },
    "csrf-token",
  );
  const deleted = await api.deleteConfig("webhook/with spaces", "csrf-token");

  assert.equal(
    String(calls[0]?.input),
    "http://localhost:4000/api/v1/webhooks/webhook%2Fwith%20spaces",
  );
  assert.equal(calls[0]?.init?.method, "PUT");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    active: false,
    secret: "b".repeat(32),
  });
  assert.equal(
    String(calls[1]?.input),
    "http://localhost:4000/api/v1/webhooks/webhook%2Fwith%20spaces",
  );
  assert.equal(calls[1]?.init?.method, "DELETE");
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.id, "webhook/with spaces");
});

test("token-authenticated config mutations do not attach csrf or credentials", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> =
    [];
  const api = createApi({
    auth: { mode: "token", token: "mdcms_key_test" },
    fetcher: async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ data: webhookConfig }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await api.createConfig(
    {
      url: "https://example.com/hooks/mdcms",
      events: ["content.published"],
      secret: "a".repeat(32),
      active: true,
    },
    undefined,
  );

  assert.equal(calls[0]?.init?.credentials, undefined);
  assert.equal(readHeader(calls[0]?.init, "authorization"), "Bearer mdcms_key_test");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), null);
});

test("config requests surface route errors and reject invalid responses", async () => {
  const failingApi = createApi({
    fetcher: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", message: "Nope." }), {
        status: 403,
      }),
  });

  await assert.rejects(
    () => failingApi.listConfigs(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "FORBIDDEN" &&
      error.statusCode === 403,
  );

  const invalidApi = createApi({
    fetcher: async () => new Response(JSON.stringify({ data: {} })),
  });

  await assert.rejects(
    () => invalidApi.listConfigs(),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "WEBHOOKS_RESPONSE_INVALID",
  );
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/webhooks-api.test.ts
```

Expected: fail with `api.listConfigs is not a function`.

- [ ] **Step 3: Implement CRUD methods**

In `packages/studio/src/lib/runtime-ui/lib/webhooks-api.ts`, update the shared import:

```ts
import {
  RuntimeError,
  assertWebhookConfig,
  assertWebhookDeliveryHistoryResponse,
  assertWebhookListResponse,
  type ParsedWebhookDeliveryHistoryQuery,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookDeliveryHistoryEntry,
  type WebhookUpdateInput,
} from "@mdcms/shared";
```

Update `StudioWebhooksApi`:

```ts
export type StudioWebhooksApi = {
  listConfigs: () => Promise<WebhookConfig[]>;
  createConfig: (
    input: WebhookCreateInput,
    csrfToken: string | undefined,
  ) => Promise<WebhookConfig>;
  updateConfig: (
    id: string,
    input: WebhookUpdateInput,
    csrfToken: string | undefined,
  ) => Promise<WebhookConfig>;
  deleteConfig: (
    id: string,
    csrfToken: string | undefined,
  ) => Promise<{ deleted: true; id: string }>;
  listDeliveryHistory: (
    filter: Partial<ParsedWebhookDeliveryHistoryQuery>,
  ) => Promise<WebhookDeliveryHistoryEntry[]>;
};
```

Add helpers above `createStudioWebhooksApi`:

```ts
function createScopedHeaders(
  config: StudioWebhooksApiConfig,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      "x-mdcms-project": config.project,
      "x-mdcms-environment": config.environment,
      ...extra,
    }).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as Record<string, string>;
}

function assertWebhookDeleteResponse(
  value: unknown,
): asserts value is { data: { deleted: true; id: string } } {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    value.data.deleted !== true ||
    typeof value.data.id !== "string"
  ) {
    throw new Error("Invalid webhook delete response.");
  }
}
```

Then add these methods before `listDeliveryHistory` in the returned object:

```ts
async listConfigs() {
  const operation = "GET /api/v1/webhooks";
  const url = resolveStudioRelativeUrl("/api/v1/webhooks", config.serverUrl);
  const response = await fetcher(
    url,
    applyStudioAuthToRequestInit(options.auth, {
      method: "GET",
      headers: createScopedHeaders(config),
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toRouteFailureError(
      operation,
      response,
      payload,
      "Webhook configuration list request failed.",
    );
  }

  try {
    assertWebhookListResponse(payload);
  } catch {
    throw toInvalidResponseError(operation, payload);
  }

  return payload.data;
},

async createConfig(input, csrfToken) {
  const operation = "POST /api/v1/webhooks";
  const url = resolveStudioRelativeUrl("/api/v1/webhooks", config.serverUrl);
  const response = await fetcher(
    url,
    applyStudioAuthToRequestInit(options.auth, {
      method: "POST",
      headers: createScopedHeaders(config, {
        "content-type": "application/json",
        "x-mdcms-csrf-token": csrfToken,
      }),
      body: JSON.stringify(input),
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toRouteFailureError(
      operation,
      response,
      payload,
      "Webhook configuration create request failed.",
    );
  }

  try {
    if (!isRecord(payload)) throw new Error("Invalid payload.");
    assertWebhookConfig(payload.data);
  } catch {
    throw toInvalidResponseError(operation, payload);
  }

  return payload.data;
},

async updateConfig(id, input, csrfToken) {
  const operation = `PUT /api/v1/webhooks/${id}`;
  const url = resolveStudioRelativeUrl(
    `/api/v1/webhooks/${encodeURIComponent(id)}`,
    config.serverUrl,
  );
  const response = await fetcher(
    url,
    applyStudioAuthToRequestInit(options.auth, {
      method: "PUT",
      headers: createScopedHeaders(config, {
        "content-type": "application/json",
        "x-mdcms-csrf-token": csrfToken,
      }),
      body: JSON.stringify(input),
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toRouteFailureError(
      operation,
      response,
      payload,
      "Webhook configuration update request failed.",
    );
  }

  try {
    if (!isRecord(payload)) throw new Error("Invalid payload.");
    assertWebhookConfig(payload.data);
  } catch {
    throw toInvalidResponseError(operation, payload);
  }

  return payload.data;
},

async deleteConfig(id, csrfToken) {
  const operation = `DELETE /api/v1/webhooks/${id}`;
  const url = resolveStudioRelativeUrl(
    `/api/v1/webhooks/${encodeURIComponent(id)}`,
    config.serverUrl,
  );
  const response = await fetcher(
    url,
    applyStudioAuthToRequestInit(options.auth, {
      method: "DELETE",
      headers: createScopedHeaders(config, {
        "x-mdcms-csrf-token": csrfToken,
      }),
    }),
  );
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw toRouteFailureError(
      operation,
      response,
      payload,
      "Webhook configuration delete request failed.",
    );
  }

  try {
    assertWebhookDeleteResponse(payload);
  } catch {
    throw toInvalidResponseError(operation, payload);
  }

  return payload.data;
},
```

Change the delivery history request headers to use `createScopedHeaders(config)`.

- [ ] **Step 4: Run API tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/webhooks-api.test.ts
```

Expected: all tests pass.

---

### Task 3: Webhook Configuration Dialog And Form Builders

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.test.ts`
- Create: `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.tsx`

- [ ] **Step 1: Write failing dialog/form tests**

Create `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.test.ts`:

```ts
import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  buildWebhookConfigCreateInput,
  buildWebhookConfigUpdateInput,
  createInitialWebhookConfigDialogFormState,
  isWebhookConfigDialogSubmittable,
  webhookConfigDialogFormReducer,
} from "./webhook-config-dialog.js";

test("buildWebhookConfigCreateInput trims url and includes required secret", () => {
  const state = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      webhookConfigDialogFormReducer(
        createInitialWebhookConfigDialogFormState("create"),
        { type: "url-change", value: " https://example.com/hooks/mdcms " },
      ),
      { type: "secret-change", value: "a".repeat(32) },
    ),
    { type: "event-toggle", event: "content.published" },
  );

  const input = buildWebhookConfigCreateInput(state);

  assert.deepEqual(input, {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret: "a".repeat(32),
    active: true,
  });
});

test("buildWebhookConfigUpdateInput omits blank edit secret", () => {
  const state = webhookConfigDialogFormReducer(
    createInitialWebhookConfigDialogFormState("edit", {
      id: "webhook-1",
      project: "marketing-site",
      environment: "production",
      url: "https://old.example.com/hooks",
      events: ["content.created"],
      active: true,
      createdBy: "user-1",
      updatedBy: "user-1",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    }),
    { type: "url-change", value: "https://new.example.com/hooks" },
  );

  assert.deepEqual(buildWebhookConfigUpdateInput(state), {
    url: "https://new.example.com/hooks",
    events: ["content.created"],
    active: true,
  });
});

test("isWebhookConfigDialogSubmittable enforces url event secret and pending state", () => {
  const missingSecret = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      createInitialWebhookConfigDialogFormState("create"),
      { type: "url-change", value: "https://example.com/hooks/mdcms" },
    ),
    { type: "event-toggle", event: "content.published" },
  );
  assert.equal(isWebhookConfigDialogSubmittable(missingSecret, false), false);

  const ready = webhookConfigDialogFormReducer(missingSecret, {
    type: "secret-change",
    value: "a".repeat(32),
  });
  assert.equal(isWebhookConfigDialogSubmittable(ready, false), true);
  assert.equal(isWebhookConfigDialogSubmittable(ready, true), false);

  const editReady = createInitialWebhookConfigDialogFormState("edit", {
    id: "webhook-1",
    project: "marketing-site",
    environment: "production",
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    active: true,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  });
  assert.equal(isWebhookConfigDialogSubmittable(editReady, false), true);
});

test("webhookConfigDialogFormReducer toggles events and active state immutably", () => {
  const selected = webhookConfigDialogFormReducer(
    createInitialWebhookConfigDialogFormState("create"),
    { type: "event-toggle", event: "content.published" },
  );
  const unselected = webhookConfigDialogFormReducer(selected, {
    type: "event-toggle",
    event: "content.published",
  });
  const inactive = webhookConfigDialogFormReducer(selected, {
    type: "active-change",
    value: false,
  });

  assert.deepEqual(Array.from(selected.selectedEvents), ["content.published"]);
  assert.deepEqual(Array.from(unselected.selectedEvents), []);
  assert.equal(inactive.active, false);
  assert.equal(selected.active, true);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/webhook-config-dialog.test.ts
```

Expected: fail because `webhook-config-dialog.tsx` does not exist.

- [ ] **Step 3: Implement dialog component**

Create `packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.tsx`:

```tsx
"use client";

import { useEffect, useReducer } from "react";
import { WEBHOOK_EVENTS, type WebhookConfig, type WebhookCreateInput, type WebhookEvent, type WebhookUpdateInput } from "@mdcms/shared";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Switch } from "./ui/switch.js";
import { cn } from "../lib/utils.js";

export type WebhookConfigDialogMode = "create" | "edit";

export type WebhookConfigDialogFormState = {
  mode: WebhookConfigDialogMode;
  url: string;
  selectedEvents: Set<WebhookEvent>;
  secret: string;
  active: boolean;
  submitError: string | null;
};

export type WebhookConfigDialogFormAction =
  | { type: "reset"; mode: WebhookConfigDialogMode; config?: WebhookConfig | null }
  | { type: "url-change"; value: string }
  | { type: "event-toggle"; event: WebhookEvent }
  | { type: "secret-change"; value: string }
  | { type: "active-change"; value: boolean }
  | { type: "submit-start" }
  | { type: "submit-error"; message: string };

export type WebhookConfigDialogProps = {
  mode: WebhookConfigDialogMode;
  open: boolean;
  config?: WebhookConfig | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: WebhookCreateInput | WebhookUpdateInput) => Promise<void>;
  isSubmitting: boolean;
  error: Error | null;
};

export function createInitialWebhookConfigDialogFormState(
  mode: WebhookConfigDialogMode,
  config?: WebhookConfig | null,
): WebhookConfigDialogFormState {
  return {
    mode,
    url: config?.url ?? "",
    selectedEvents: new Set(config?.events ?? []),
    secret: "",
    active: config?.active ?? true,
    submitError: null,
  };
}

export function webhookConfigDialogFormReducer(
  state: WebhookConfigDialogFormState,
  action: WebhookConfigDialogFormAction,
): WebhookConfigDialogFormState {
  switch (action.type) {
    case "reset":
      return createInitialWebhookConfigDialogFormState(action.mode, action.config);
    case "url-change":
      return { ...state, url: action.value };
    case "event-toggle": {
      const selectedEvents = new Set(state.selectedEvents);
      if (selectedEvents.has(action.event)) {
        selectedEvents.delete(action.event);
      } else {
        selectedEvents.add(action.event);
      }
      return { ...state, selectedEvents };
    }
    case "secret-change":
      return { ...state, secret: action.value };
    case "active-change":
      return { ...state, active: action.value };
    case "submit-start":
      return { ...state, submitError: null };
    case "submit-error":
      return { ...state, submitError: action.message };
  }
}

function hasValidSecretForMode(state: WebhookConfigDialogFormState): boolean {
  const secretLength = state.secret.trim().length;
  if (state.mode === "create") {
    return secretLength >= 32;
  }
  return secretLength === 0 || secretLength >= 32;
}

export function isWebhookConfigDialogSubmittable(
  state: WebhookConfigDialogFormState,
  isSubmitting: boolean,
): boolean {
  return (
    state.url.trim().length > 0 &&
    state.selectedEvents.size > 0 &&
    hasValidSecretForMode(state) &&
    !isSubmitting
  );
}

export function buildWebhookConfigCreateInput(
  state: WebhookConfigDialogFormState,
): WebhookCreateInput {
  return {
    url: state.url.trim(),
    events: Array.from(state.selectedEvents),
    secret: state.secret.trim(),
    active: state.active,
  };
}

export function buildWebhookConfigUpdateInput(
  state: WebhookConfigDialogFormState,
): WebhookUpdateInput {
  const secret = state.secret.trim();
  return {
    url: state.url.trim(),
    events: Array.from(state.selectedEvents),
    active: state.active,
    ...(secret.length > 0 ? { secret } : {}),
  };
}

export function WebhookConfigDialog({
  mode,
  open,
  config,
  onOpenChange,
  onSubmit,
  isSubmitting,
  error,
}: WebhookConfigDialogProps) {
  const [form, dispatch] = useReducer(
    webhookConfigDialogFormReducer,
    createInitialWebhookConfigDialogFormState(mode, config),
  );
  const canSubmit = isWebhookConfigDialogSubmittable(form, isSubmitting);

  useEffect(() => {
    if (open) {
      dispatch({ type: "reset", mode, config });
    }
  }, [config, mode, open]);

  const title = mode === "create" ? "Create webhook" : "Edit webhook";
  const description =
    mode === "create"
      ? "Add an HTTPS endpoint for selected MDCMS events."
      : "Update the endpoint, events, active state, or rotate the HMAC secret.";

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      dispatch({ type: "reset", mode, config });
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    dispatch({ type: "submit-start" });

    try {
      await onSubmit(
        mode === "create"
          ? buildWebhookConfigCreateInput(form)
          : buildWebhookConfigUpdateInput(form),
      );
      handleOpenChange(false);
    } catch (err) {
      dispatch({
        type: "submit-error",
        message:
          err instanceof Error ? err.message : "Failed to save webhook.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url">URL</Label>
              <Input
                id="webhook-url"
                value={form.url}
                onChange={(event) =>
                  dispatch({ type: "url-change", value: event.target.value })
                }
                placeholder="https://example.com/hooks/mdcms"
                disabled={isSubmitting}
              />
            </div>

            <div className="space-y-3">
              <Label>Events</Label>
              <div className="flex flex-wrap gap-1.5">
                {WEBHOOK_EVENTS.map((event) => {
                  const selected = form.selectedEvents.has(event);
                  return (
                    <button
                      key={event}
                      type="button"
                      aria-pressed={selected}
                      disabled={isSubmitting}
                      onClick={() => dispatch({ type: "event-toggle", event })}
                    >
                      <Badge
                        variant={selected ? "default" : "outline"}
                        className={cn(
                          "cursor-pointer select-none rounded-sm font-mono text-[11px]",
                          isSubmitting && "cursor-not-allowed opacity-50",
                        )}
                      >
                        {event}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhook-secret">
                {mode === "create" ? "HMAC secret" : "Rotate HMAC secret"}
              </Label>
              <Input
                id="webhook-secret"
                type="password"
                value={form.secret}
                onChange={(event) =>
                  dispatch({
                    type: "secret-change",
                    value: event.target.value,
                  })
                }
                placeholder={
                  mode === "create"
                    ? "At least 32 characters"
                    : "Leave empty to preserve existing secret"
                }
                disabled={isSubmitting}
              />
              <p className="text-xs text-foreground-muted">
                Secrets are write-only and must be at least 32 characters when
                provided.
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-card-border bg-background-subtle px-3 py-2">
              <Label htmlFor="webhook-active" className="text-sm font-medium">
                Active
              </Label>
              <Switch
                id="webhook-active"
                checked={form.active}
                onCheckedChange={(value) =>
                  dispatch({ type: "active-change", value })
                }
                disabled={isSubmitting}
              />
            </div>

            {(error || form.submitError) && (
              <p className="text-sm text-destructive">
                {form.submitError ?? error?.message}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? "Saving..." : mode === "create" ? "Create webhook" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run dialog tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/webhook-config-dialog.test.ts
```

Expected: all tests pass.

---

### Task 4: Configuration Query And Mutation Hook

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/hooks/use-webhook-config-list.ts`

- [ ] **Step 1: Implement the hook**

Create `packages/studio/src/lib/runtime-ui/hooks/use-webhook-config-list.ts`:

```ts
"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RuntimeError,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";
import { createStudioWebhooksApi } from "../lib/webhooks-api.js";

export type SettingsPageWebhookConfigStatus =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "unavailable";

export type SettingsPageWebhookConfigState = {
  status: SettingsPageWebhookConfigStatus;
  configs: WebhookConfig[];
  errorMessage?: string;
  createWebhook: (input: WebhookCreateInput) => Promise<WebhookConfig>;
  updateWebhook: (
    id: string,
    input: WebhookUpdateInput,
  ) => Promise<WebhookConfig>;
  deleteWebhook: (id: string) => Promise<{ deleted: true; id: string }>;
  isCreating: boolean;
  createError: Error | null;
  isUpdating: boolean;
  updateError: Error | null;
  isDeleting: boolean;
  deleteError: Error | null;
};

export type UseWebhookConfigListOptions = {
  enabled?: boolean;
};

function createMissingCsrfError(): RuntimeError {
  return new RuntimeError({
    code: "CSRF_TOKEN_MISSING",
    message: "CSRF token is not available. You must be authenticated.",
    statusCode: 0,
  });
}

export function useWebhookConfigList(
  options: UseWebhookConfigListOptions = {},
): SettingsPageWebhookConfigState {
  const enabled = options.enabled ?? true;
  const mountInfo = useStudioMountInfo();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const canLoad = Boolean(
    enabled &&
      mountInfo.project &&
      mountInfo.environment &&
      mountInfo.apiBaseUrl,
  );
  const csrfToken =
    session.status === "authenticated" ? session.csrfToken : null;

  const api = useMemo(() => {
    if (!canLoad || !mountInfo.project || !mountInfo.environment) {
      return null;
    }

    return createStudioWebhooksApi(
      {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      { auth: mountInfo.auth },
    );
  }, [
    canLoad,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
    mountInfo.environment,
    mountInfo.project,
  ]);

  const queryKey = [
    "webhook-configs",
    mountInfo.project ?? null,
    mountInfo.environment ?? null,
    mountInfo.apiBaseUrl ?? null,
    mountInfo.auth.mode,
    mountInfo.auth.mode === "token" ? mountInfo.auth.token : null,
  ] as const;

  const query = useQuery({
    queryKey,
    enabled: api !== null,
    queryFn: async () => api!.listConfigs(),
  });

  const requireMutationCsrfToken = useCallback((): string | undefined => {
    if (mountInfo.auth.mode === "token") {
      return undefined;
    }
    if (!csrfToken) {
      throw createMissingCsrfError();
    }
    return csrfToken;
  }, [csrfToken, mountInfo.auth.mode]);

  const invalidateConfigs = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const createMutation = useMutation({
    mutationFn: async (input: WebhookCreateInput) => {
      if (!api) {
        throw new RuntimeError({
          code: "API_NOT_AVAILABLE",
          message: "Webhook API client is not available.",
          statusCode: 0,
        });
      }
      return api.createConfig(input, requireMutationCsrfToken());
    },
    onSuccess: invalidateConfigs,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: { id: string; patch: WebhookUpdateInput }) => {
      if (!api) {
        throw new RuntimeError({
          code: "API_NOT_AVAILABLE",
          message: "Webhook API client is not available.",
          statusCode: 0,
        });
      }
      return api.updateConfig(
        input.id,
        input.patch,
        requireMutationCsrfToken(),
      );
    },
    onSuccess: invalidateConfigs,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!api) {
        throw new RuntimeError({
          code: "API_NOT_AVAILABLE",
          message: "Webhook API client is not available.",
          statusCode: 0,
        });
      }
      return api.deleteConfig(id, requireMutationCsrfToken());
    },
    onSuccess: invalidateConfigs,
  });

  const configs = query.data ?? [];

  const status: SettingsPageWebhookConfigStatus = useMemo(() => {
    if (!canLoad) return "unavailable";
    if (query.isLoading) return "loading";
    if (query.error) return "error";
    if (configs.length === 0) return "empty";
    return "ready";
  }, [canLoad, configs.length, query.error, query.isLoading]);

  const errorMessage = useMemo(() => {
    if (!query.error) {
      return status === "unavailable"
        ? "Studio is missing project or environment context."
        : undefined;
    }

    return query.error instanceof Error
      ? query.error.message
      : "Failed to load webhook configurations.";
  }, [query.error, status]);

  return {
    status,
    configs,
    errorMessage,
    createWebhook: (input) => createMutation.mutateAsync(input),
    updateWebhook: (id, input) =>
      updateMutation.mutateAsync({ id, patch: input }),
    deleteWebhook: (id) => deleteMutation.mutateAsync(id),
    isCreating: createMutation.isPending,
    createError: createMutation.error,
    isUpdating: updateMutation.isPending,
    updateError: updateMutation.error,
    isDeleting: deleteMutation.isPending,
    deleteError: deleteMutation.error,
  };
}
```

- [ ] **Step 2: Run typecheck for the hook**

Run:

```bash
bun run typecheck -- --projects studio
```

Expected: typecheck either passes or reports only the downstream Settings page mismatch until Task 5 wires the new state type.

---

### Task 5: Webhooks Panel Configuration UI

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-webhooks-panel.tsx`

- [ ] **Step 1: Expand panel props and imports**

Update imports in `settings-webhooks-panel.tsx`:

```tsx
import { useState } from "react";
import { AlertCircle, Activity, Pencil, Plus, Trash2, Webhook } from "lucide-react";
import {
  WEBHOOK_DELIVERY_OUTCOMES,
  WEBHOOK_EVENTS,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookDeliveryHistoryEntry,
  type WebhookDeliveryOutcome,
  type WebhookEvent,
  type WebhookUpdateInput,
} from "@mdcms/shared";
```

Add imports:

```tsx
import { WebhookConfigDialog } from "../../components/webhook-config-dialog.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import type { SettingsPageWebhookConfigState } from "../../hooks/use-webhook-config-list.js";
```

Update the exported props:

```tsx
export function SettingsWebhooksPanel({
  webhookConfigState,
  webhookHistoryState,
}: {
  webhookConfigState: SettingsPageWebhookConfigState;
  webhookHistoryState: SettingsPageWebhookHistoryState;
}) {
```

- [ ] **Step 2: Add configuration subcomponents**

Add these helpers above `SettingsWebhooksPanel`:

```tsx
function WebhookActiveBadge({ active }: { active: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-sm border px-2 py-0.5 font-mono text-[11px]",
        active
          ? "border-success/20 bg-success/10 text-success"
          : "border-border bg-background-subtle text-foreground-muted",
      )}
    >
      {active ? "Active" : "Inactive"}
    </Badge>
  );
}

function WebhookEventList({ events }: { events: WebhookEvent[] }) {
  return (
    <div className="flex max-w-[24rem] flex-wrap gap-1">
      {events.map((event) => (
        <Badge
          key={event}
          variant="outline"
          className="rounded-sm font-mono text-[10px]"
        >
          {event}
        </Badge>
      ))}
    </div>
  );
}

function WebhookConfigLoadingState() {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="loading"
      className="rounded-lg border border-card-border bg-card p-5"
    >
      <div className="space-y-3">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    </div>
  );
}

function WebhookConfigEmptyState({
  onCreate,
}: {
  onCreate: () => void;
}) {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="empty"
      className="rounded-lg border border-dashed border-border bg-card p-10 text-center"
    >
      <Webhook className="mx-auto size-8 text-foreground-muted" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        No webhook configurations yet
      </p>
      <p className="mt-1 text-sm text-foreground-muted">
        Create a webhook to notify external systems about content and media
        events.
      </p>
      <Button onClick={onCreate} className="mt-4" size="sm">
        <Plus className="size-4" />
        Create webhook
      </Button>
    </div>
  );
}

function WebhookConfigErrorState({
  status,
  message,
}: {
  status: "error" | "unavailable";
  message: string;
}) {
  return (
    <div
      data-mdcms-settings-webhook-configs-state={status}
      className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function WebhookConfigReadyState({
  configs,
  isMutating,
  onEdit,
  onDelete,
}: {
  configs: WebhookConfig[];
  isMutating: boolean;
  onEdit: (config: WebhookConfig) => void;
  onDelete: (config: WebhookConfig) => void;
}) {
  return (
    <div
      data-mdcms-settings-webhook-configs-state="ready"
      className="overflow-hidden rounded-lg border border-card-border bg-card"
    >
      <Table>
        <TableHeader>
          <TableRow className="bg-background-subtle hover:bg-background-subtle">
            <TableHead>URL</TableHead>
            <TableHead>Events</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-28"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {configs.map((config) => (
            <TableRow key={config.id} className="hover:bg-background-subtle/60">
              <TableCell className="min-w-[18rem] break-all font-mono text-[12px]">
                {config.url}
                <div className="mt-1 text-[11px] text-foreground-muted">
                  {config.id}
                </div>
              </TableCell>
              <TableCell className="min-w-[16rem] whitespace-normal">
                <WebhookEventList events={config.events} />
              </TableCell>
              <TableCell>
                <WebhookActiveBadge active={config.active} />
              </TableCell>
              <TableCell className="min-w-[11rem] text-sm text-foreground-muted">
                <div suppressHydrationWarning>
                  {formatClientDate(config.updatedAt)}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit webhook ${config.id}`}
                    disabled={isMutating}
                    onClick={() => onEdit(config)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete webhook ${config.id}`}
                    className="text-destructive hover:text-destructive"
                    disabled={isMutating}
                    onClick={() => onDelete(config)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 3: Add dialogs and configuration section in the panel**

Inside `SettingsWebhooksPanel`, add local state:

```tsx
const [createDialogOpen, setCreateDialogOpen] = useState(false);
const [editingConfig, setEditingConfig] = useState<WebhookConfig | null>(null);
const [deletingConfig, setDeletingConfig] = useState<WebhookConfig | null>(null);
const isMutating =
  webhookConfigState.isCreating ||
  webhookConfigState.isUpdating ||
  webhookConfigState.isDeleting;
```

Change the section data attribute to include both states:

```tsx
data-mdcms-settings-webhooks-state={`${webhookConfigState.status}:${webhookHistoryState.status}`}
```

Replace the description with:

```tsx
Manage webhook configurations and inspect delivery history for the active project and environment.
```

Render this configuration section before the delivery history heading:

```tsx
<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
    <Webhook className="size-4 text-primary" />
    Webhook configurations
  </div>
  <Button onClick={() => setCreateDialogOpen(true)} className="sm:self-start">
    <Plus className="size-4" />
    Create webhook
  </Button>
</div>

{webhookConfigState.deleteError && (
  <WebhookConfigErrorState
    status="error"
    message={
      webhookConfigState.deleteError.message || "Failed to delete webhook."
    }
  />
)}
{webhookConfigState.status === "loading" && <WebhookConfigLoadingState />}
{webhookConfigState.status === "error" && (
  <WebhookConfigErrorState
    status="error"
    message={
      webhookConfigState.errorMessage ??
      "Failed to load webhook configurations."
    }
  />
)}
{webhookConfigState.status === "unavailable" && (
  <WebhookConfigErrorState
    status="unavailable"
    message={
      webhookConfigState.errorMessage ??
      "Studio is missing project or environment context."
    }
  />
)}
{webhookConfigState.status === "empty" && (
  <WebhookConfigEmptyState onCreate={() => setCreateDialogOpen(true)} />
)}
{webhookConfigState.status === "ready" && (
  <WebhookConfigReadyState
    configs={webhookConfigState.configs}
    isMutating={isMutating}
    onEdit={setEditingConfig}
    onDelete={setDeletingConfig}
  />
)}
```

At the end of the section, before `</section>`, render:

```tsx
<WebhookConfigDialog
  mode="create"
  open={createDialogOpen}
  onOpenChange={setCreateDialogOpen}
  onSubmit={async (input) => {
    await webhookConfigState.createWebhook(input as WebhookCreateInput);
  }}
  isSubmitting={webhookConfigState.isCreating}
  error={webhookConfigState.createError}
/>
<WebhookConfigDialog
  mode="edit"
  open={editingConfig !== null}
  config={editingConfig}
  onOpenChange={(open) => {
    if (!open) setEditingConfig(null);
  }}
  onSubmit={async (input) => {
    if (!editingConfig) return;
    await webhookConfigState.updateWebhook(
      editingConfig.id,
      input as WebhookUpdateInput,
    );
  }}
  isSubmitting={webhookConfigState.isUpdating}
  error={webhookConfigState.updateError}
/>
<Dialog
  open={deletingConfig !== null}
  onOpenChange={(open) => {
    if (!open) setDeletingConfig(null);
  }}
>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Delete webhook</DialogTitle>
      <DialogDescription>
        Delete {deletingConfig?.url}. Delivery history remains available for
        audit.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setDeletingConfig(null)}
        disabled={webhookConfigState.isDeleting}
      >
        Cancel
      </Button>
      <Button
        type="button"
        variant="destructive"
        disabled={!deletingConfig || webhookConfigState.isDeleting}
        onClick={() => {
          if (!deletingConfig) return;
          webhookConfigState
            .deleteWebhook(deletingConfig.id)
            .then(() => setDeletingConfig(null))
            .catch(() => {
              // Error is surfaced through deleteError.
            });
        }}
      >
        {webhookConfigState.isDeleting ? "Deleting..." : "Delete webhook"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Run targeted typecheck**

Run:

```bash
bun run typecheck -- --projects studio
```

Expected: typecheck reports `SettingsWebhooksPanel` now requires `webhookConfigState` until Task 6 wires it.

---

### Task 6: Settings Page Wiring And Tests

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`

- [ ] **Step 1: Wire the new hook into Settings page**

In `settings-page.tsx`, add:

```ts
import {
  useWebhookConfigList,
  type SettingsPageWebhookConfigState,
} from "../../hooks/use-webhook-config-list.js";
```

Export the state type near the existing webhook history export:

```ts
export type { SettingsPageWebhookConfigState } from "../../hooks/use-webhook-config-list.js";
```

Add `webhookConfigState` to `SettingsPageView` props and pass it into the panel:

```tsx
webhookConfigState,
webhookHistoryState,
```

```ts
webhookConfigState: SettingsPageWebhookConfigState;
webhookHistoryState: SettingsPageWebhookHistoryState;
```

```tsx
<SettingsWebhooksPanel
  webhookConfigState={webhookConfigState}
  webhookHistoryState={webhookHistoryState}
/>
```

In the default page component, add:

```ts
const webhookConfigState = useWebhookConfigList({
  enabled: canManageSettings,
});
```

and pass `webhookConfigState={webhookConfigState}` into `SettingsPageView`.

- [ ] **Step 2: Write view tests for configuration states**

In `settings-page.test.tsx`, update imports:

```ts
import type { WebhookConfig, WebhookDeliveryHistoryEntry } from "@mdcms/shared";
```

Add `SettingsPageWebhookConfigState` to the `SettingsPageView` import block.

Add fixtures:

```ts
const readyWebhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "test-project",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published", "media.uploaded"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-2",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

const readyWebhookConfigState: SettingsPageWebhookConfigState = {
  status: "ready",
  configs: [readyWebhookConfig],
  errorMessage: undefined,
  createWebhook: async () => readyWebhookConfig,
  updateWebhook: async () => readyWebhookConfig,
  deleteWebhook: async (id: string) => ({ deleted: true, id }),
  isCreating: false,
  createError: null,
  isUpdating: false,
  updateError: null,
  isDeleting: false,
  deleteError: null,
};
```

Update `renderSettingsPageView` input:

```ts
webhookConfigState?: Partial<SettingsPageWebhookConfigState>;
```

Pass this prop:

```tsx
webhookConfigState={{
  ...readyWebhookConfigState,
  ...input.webhookConfigState,
}}
```

Add tests:

```ts
test("SettingsPageView renders webhook configuration rows and CRUD affordances", () => {
  const markup = renderSettingsPageView({ initialTab: "webhooks" });

  assert.match(markup, /Webhook configurations/);
  assert.match(markup, /Create webhook/);
  assert.match(markup, /https:\/\/example\.com\/hooks\/mdcms/);
  assert.match(markup, /content\.published/);
  assert.match(markup, /media\.uploaded/);
  assert.match(markup, /Active/);
  assert.match(markup, /aria-label="Edit webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/);
  assert.match(markup, /aria-label="Delete webhook 018f0c6d-98da-7f25-89fe-7c7ef5e8597d"/);
});

test("SettingsPageView renders webhook configuration loading empty error and unavailable states", () => {
  const loadingMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: { status: "loading", configs: [] },
  });
  assert.match(
    loadingMarkup,
    /data-mdcms-settings-webhook-configs-state="loading"/,
  );

  const emptyMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: { status: "empty", configs: [] },
  });
  assert.match(emptyMarkup, /No webhook configurations yet/);

  const errorMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "error",
      configs: [],
      errorMessage: "Failed to load webhook configurations.",
    },
  });
  assert.match(errorMarkup, /Failed to load webhook configurations/);

  const unavailableMarkup = renderSettingsPageView({
    initialTab: "webhooks",
    webhookConfigState: {
      status: "unavailable",
      configs: [],
      errorMessage: "Studio is missing project or environment context.",
    },
  });
  assert.match(
    unavailableMarkup,
    /Studio is missing project or environment context/,
  );
});
```

Update the forbidden test so it also asserts:

```ts
assert.doesNotMatch(markup, /Webhook configurations/);
assert.doesNotMatch(markup, /Create webhook/);
```

- [ ] **Step 3: Run Settings tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: all tests pass.

---

### Task 7: Browser E2E Coverage And Script

**Files:**
- Create: `e2e/studio-webhooks-settings.spec.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the missing e2e script**

In root `package.json`, add this script next to `unit`:

```json
"e2e": "bun x playwright test",
```

- [ ] **Step 2: Add Playwright coverage for Settings -> Webhooks**

Create `e2e/studio-webhooks-settings.spec.ts`:

```ts
import { expect, test, type Page, type Route } from "@playwright/test";

const LOGIN_EMAIL = process.env.E2E_LOGIN_EMAIL ?? "demo@mdcms.local";
const LOGIN_PASSWORD = process.env.E2E_LOGIN_PASSWORD ?? "Demo12345!";

type WebhookConfig = {
  id: string;
  project: string;
  environment: string;
  url: string;
  events: string[];
  active: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

const webhookConfig: WebhookConfig = {
  id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
  project: "test-project",
  environment: "production",
  url: "https://example.com/hooks/mdcms",
  events: ["content.published"],
  active: true,
  createdBy: "user-1",
  updatedBy: "user-1",
  createdAt: "2026-06-03T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

async function json(route: Route, data: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });
}

async function loginAndOpenWebhooks(page: Page): Promise<void> {
  const settingsPath = "/admin/settings";
  const loginPath = `/admin/login?returnTo=${encodeURIComponent(settingsPath)}`;

  await page.goto(loginPath);
  await page.getByRole("textbox", { name: "Email" }).fill(LOGIN_EMAIL);
  await page.getByRole("textbox", { name: "Password" }).fill(LOGIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname.endsWith(settingsPath));
  await page.getByRole("button", { name: "Webhooks" }).click();
}

test.describe("Studio Settings Webhooks", () => {
  test("admins can open create/edit/delete controls with routed webhook data", async ({
    page,
  }) => {
    await page.route("**/api/v1/webhooks/deliveries**", async (route) => {
      await json(route, { data: [] });
    });
    await page.route("**/api/v1/webhooks", async (route) => {
      if (route.request().method() === "GET") {
        await json(route, { data: [webhookConfig] });
        return;
      }
      await json(route, {
        data: {
          ...webhookConfig,
          url: "https://example.com/hooks/new",
          events: ["content.published", "media.uploaded"],
        },
      });
    });
    await page.route("**/api/v1/webhooks/*", async (route) => {
      if (route.request().method() === "DELETE") {
        await json(route, { data: { deleted: true, id: webhookConfig.id } });
        return;
      }
      await json(route, { data: webhookConfig });
    });

    await loginAndOpenWebhooks(page);

    await expect(
      page.getByRole("heading", { name: "Webhooks" }),
    ).toBeVisible();
    await expect(page.getByText("Webhook configurations")).toBeVisible();
    await expect(page.getByText(webhookConfig.url)).toBeVisible();

    await page.getByRole("button", { name: "Create webhook" }).click();
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Create webhook",
      }),
    ).toBeVisible();
    await page.getByLabel("URL").fill("https://example.com/hooks/new");
    await page.getByRole("button", { name: "content.published" }).click();
    await page.getByRole("button", { name: "media.uploaded" }).click();
    await page.getByLabel("HMAC secret").fill("a".repeat(32));
    await page.getByRole("button", { name: "Create webhook" }).click();

    await page
      .getByRole("button", { name: `Edit webhook ${webhookConfig.id}` })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Edit webhook",
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Rotate HMAC secret")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page
      .getByRole("button", { name: `Delete webhook ${webhookConfig.id}` })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("heading", {
        name: "Delete webhook",
      }),
    ).toBeVisible();
  });
});
```

- [ ] **Step 3: Run Playwright when the Studio example is available**

Start the existing e2e target in another terminal:

```bash
bun --cwd apps/studio-example run dev
```

Then run:

```bash
bun run e2e -- e2e/studio-webhooks-settings.spec.ts
```

Expected: the new spec passes against the running Studio example. If the local server/auth fixture is not running, record the exact startup blocker and rely on the Bun-rendered Studio tests plus API tests for this change.

---

### Task 8: Final Verification And Staging

**Files:**
- All files touched above.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/webhooks-api.test.ts ./src/lib/runtime-ui/components/webhook-config-dialog.test.ts ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run formatting and build/typecheck gate**

Run:

```bash
bun run format:check
bun run check
```

Expected: both pass.

- [ ] **Step 3: Run full unit gate**

Run:

```bash
bun run unit
```

Expected: pass. If it fails with existing local listener/socket issues, capture the exact failing tests and confirm the targeted Studio tests and `bun run check` passed.

- [ ] **Step 4: Inspect changed files**

Run:

```bash
git status --short
git diff -- docs/specs/SPEC-010-media-webhooks-search-and-integrations.md packages/studio/README.md packages/studio/src/lib/runtime-ui/lib/webhooks-api.ts packages/studio/src/lib/runtime-ui/hooks/use-webhook-config-list.ts packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-webhooks-panel.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx packages/studio/src/lib/runtime-ui/lib/webhooks-api.test.ts packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.test.ts e2e/studio-webhooks-settings.spec.ts package.json
```

Expected: only CMS-105 files plus previously staged webhook epic files are present; unrelated untracked local artifacts remain unstaged.

- [ ] **Step 5: Stage CMS-105 files**

Run:

```bash
git add .ai/plans/2026-06-04-cms-105-studio-webhooks-crud.md docs/specs/SPEC-010-media-webhooks-search-and-integrations.md packages/studio/README.md packages/studio/src/lib/runtime-ui/lib/webhooks-api.ts packages/studio/src/lib/runtime-ui/hooks/use-webhook-config-list.ts packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.tsx packages/studio/src/lib/runtime-ui/components/webhook-config-dialog.test.ts packages/studio/src/lib/runtime-ui/app/admin/settings-webhooks-panel.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-page.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx packages/studio/src/lib/runtime-ui/lib/webhooks-api.test.ts e2e/studio-webhooks-settings.spec.ts package.json
```

Expected: files are staged. Do not stage unrelated untracked `.ai/plans/2026-03-*`, `.mdcms/`, `apps/studio-example/content/`, or local report files.
