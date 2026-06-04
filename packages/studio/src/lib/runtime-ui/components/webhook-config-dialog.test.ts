import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WebhookConfigDialog,
  WebhookConfigDialogError,
  buildWebhookConfigCreateInput,
  buildWebhookConfigUpdateInput,
  createInitialWebhookConfigDialogFormState,
  getWebhookConfigDialogErrorMessage,
  isWebhookConfigDialogSubmittable,
  webhookConfigDialogFormReducer,
} from "./webhook-config-dialog.js";

test("buildWebhookConfigCreateInput trims url and preserves required secret exactly", () => {
  const secret = ` ${"a".repeat(30)} `;
  const state = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      webhookConfigDialogFormReducer(
        createInitialWebhookConfigDialogFormState("create"),
        { type: "url-change", value: " https://example.com/hooks/mdcms " },
      ),
      { type: "secret-change", value: secret },
    ),
    { type: "event-toggle", event: "content.published" },
  );

  const input = buildWebhookConfigCreateInput(state);

  assert.deepEqual(input, {
    url: "https://example.com/hooks/mdcms",
    events: ["content.published"],
    secret,
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

test("buildWebhookConfigUpdateInput preserves provided edit secret exactly", () => {
  const secret = ` ${"b".repeat(32)} `;
  const state = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
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
    ),
    { type: "secret-change", value: secret },
  );

  assert.deepEqual(buildWebhookConfigUpdateInput(state), {
    url: "https://new.example.com/hooks",
    events: ["content.created"],
    active: true,
    secret,
  });
});

test("isWebhookConfigDialogSubmittable enforces url event secret and pending state", () => {
  const missingUrl = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      webhookConfigDialogFormReducer(
        createInitialWebhookConfigDialogFormState("create"),
        { type: "url-change", value: "   " },
      ),
      { type: "event-toggle", event: "content.published" },
    ),
    { type: "secret-change", value: "a".repeat(32) },
  );
  assert.equal(isWebhookConfigDialogSubmittable(missingUrl, false), false);

  const missingEvents = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      createInitialWebhookConfigDialogFormState("create"),
      { type: "url-change", value: "https://example.com/hooks/mdcms" },
    ),
    { type: "secret-change", value: "a".repeat(32) },
  );
  assert.equal(isWebhookConfigDialogSubmittable(missingEvents, false), false);

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
    value: ` ${"a".repeat(30)} `,
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

  const editShortSecret = webhookConfigDialogFormReducer(editReady, {
    type: "secret-change",
    value: "short",
  });
  assert.equal(isWebhookConfigDialogSubmittable(editShortSecret, false), false);

  const editRotatingSecret = webhookConfigDialogFormReducer(editReady, {
    type: "secret-change",
    value: ` ${"b".repeat(30)} `,
  });
  assert.equal(
    isWebhookConfigDialogSubmittable(editRotatingSecret, false),
    true,
  );
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

test("failed submit path preserves form state and renders an error", () => {
  const ready = webhookConfigDialogFormReducer(
    webhookConfigDialogFormReducer(
      webhookConfigDialogFormReducer(
        webhookConfigDialogFormReducer(
          createInitialWebhookConfigDialogFormState("create"),
          { type: "url-change", value: "https://example.com/hooks/mdcms" },
        ),
        { type: "event-toggle", event: "content.published" },
      ),
      { type: "secret-change", value: "a".repeat(32) },
    ),
    { type: "active-change", value: false },
  );

  const submitting = webhookConfigDialogFormReducer(ready, {
    type: "submit-start",
  });
  const failed = webhookConfigDialogFormReducer(submitting, {
    type: "submit-error",
    message: "Endpoint rejected webhook.",
  });

  assert.equal(failed.submitError, "Endpoint rejected webhook.");
  assert.equal(failed.url, "https://example.com/hooks/mdcms");
  assert.equal(failed.selectedEvents.has("content.published"), true);
  assert.equal(failed.active, false);
  assert.equal(failed.secret, "a".repeat(32));

  assert.equal(
    getWebhookConfigDialogErrorMessage(failed, null),
    "Endpoint rejected webhook.",
  );

  // This package does not ship a DOM interaction helper. The reducer covers the
  // rejected-submit state transition; static markup covers preserved field
  // rendering without adding a test-only dependency.
  const markup = renderToStaticMarkup(
    createElement(WebhookConfigDialog, {
      mode: "edit",
      open: true,
      config: {
        id: "webhook-1",
        project: "marketing-site",
        environment: "production",
        url: "https://example.com/hooks/mdcms",
        events: ["content.published"],
        active: false,
        createdBy: "user-1",
        updatedBy: "user-1",
        createdAt: "2026-06-03T00:00:00.000Z",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
      onOpenChange: () => {},
      onSubmit: async () => {
        throw new Error("Endpoint rejected webhook.");
      },
      isSubmitting: false,
      error: null,
    }),
  );

  assert.match(markup, /value="https:\/\/example\.com\/hooks\/mdcms"/);
  assert.match(
    markup,
    /aria-pressed="true"[^>]*><span[^>]*>content\.published<\/span>/,
  );
  assert.match(markup, /aria-checked="false"/);

  const errorMarkup = renderToStaticMarkup(
    createElement(WebhookConfigDialogError, {
      message: "Endpoint rejected webhook.",
    }),
  );
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, /Endpoint rejected webhook\./);
});

test("parent mutation errors are hidden until a submit attempt in the current open cycle", () => {
  const parentError = new Error("Stale mutation failure.");
  const initial = createInitialWebhookConfigDialogFormState("create");

  assert.equal(getWebhookConfigDialogErrorMessage(initial, parentError), null);

  const submitting = webhookConfigDialogFormReducer(initial, {
    type: "submit-start",
  });
  assert.equal(
    getWebhookConfigDialogErrorMessage(submitting, parentError),
    "Stale mutation failure.",
  );

  const failed = webhookConfigDialogFormReducer(submitting, {
    type: "submit-error",
    message: "Current submit failed.",
  });
  assert.equal(
    getWebhookConfigDialogErrorMessage(failed, parentError),
    "Current submit failed.",
  );

  const reset = webhookConfigDialogFormReducer(failed, {
    type: "reset",
    mode: "create",
  });
  assert.equal(getWebhookConfigDialogErrorMessage(reset, parentError), null);
});

test("fresh dialog render suppresses stale parent errors and exposes rendered errors accessibly", () => {
  const staleMarkup = renderToStaticMarkup(
    createElement(WebhookConfigDialog, {
      mode: "create",
      open: true,
      onOpenChange: () => {},
      onSubmit: async () => {},
      isSubmitting: false,
      error: new Error("Stale mutation failure."),
    }),
  );

  assert.doesNotMatch(staleMarkup, /Stale mutation failure\./);
  assert.doesNotMatch(staleMarkup, /role="alert"/);

  const submitFailed = webhookConfigDialogFormReducer(
    createInitialWebhookConfigDialogFormState("create"),
    {
      type: "submit-error",
      message: "Current submit failed.",
    },
  );
  assert.equal(
    getWebhookConfigDialogErrorMessage(submitFailed, null),
    "Current submit failed.",
  );

  const parentFailedAfterSubmit = webhookConfigDialogFormReducer(
    createInitialWebhookConfigDialogFormState("create"),
    { type: "submit-start" },
  );
  assert.equal(
    getWebhookConfigDialogErrorMessage(
      parentFailedAfterSubmit,
      new Error("Current parent mutation failed."),
    ),
    "Current parent mutation failed.",
  );

  const parentErrorMarkup = renderToStaticMarkup(
    createElement(WebhookConfigDialogError, {
      message: getWebhookConfigDialogErrorMessage(
        parentFailedAfterSubmit,
        new Error("Current parent mutation failed."),
      ),
    }),
  );
  assert.match(parentErrorMarkup, /role="alert"/);
  assert.match(parentErrorMarkup, /Current parent mutation failed\./);
});
