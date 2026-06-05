import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebhookConfig } from "@mdcms/shared";

import {
  WebhookConfigFormError,
  WebhookConfigForm,
  buildWebhookConfigCreateInput,
  buildWebhookConfigUpdateInput,
  createInitialWebhookConfigFormState,
  generateWebhookSigningSecret,
  getWebhookConfigFormErrorMessage,
  isWebhookConfigFormSubmittable,
  shouldResetWebhookConfigForm,
  webhookConfigFormReducer,
} from "./webhook-config-form.js";

function createWebhookConfig(
  overrides: Partial<WebhookConfig> = {},
): WebhookConfig {
  return {
    id: "webhook-1",
    project: "marketing-site",
    environment: "production",
    url: "https://example.com/hooks/mdcms",
    events: ["content.published" as const],
    active: true,
    createdBy: "user-1",
    updatedBy: "user-1",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

test("generateWebhookSigningSecret creates a prefixed 32-byte hex secret", () => {
  const secret = generateWebhookSigningSecret((bytes) => {
    bytes.forEach((_, index) => {
      bytes[index] = index;
    });
  });

  assert.equal(
    secret,
    "whsec_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  assert.equal(secret.length, 70);
});

test("create form state starts with a generated signing secret", () => {
  const generatedSecret = `whsec_${"c".repeat(64)}`;

  const state = createInitialWebhookConfigFormState("create", null, {
    createSecret: () => generatedSecret,
  });

  assert.equal(state.secret, generatedSecret);
});

test("buildWebhookConfigCreateInput trims url and preserves required secret exactly", () => {
  const secret = ` ${"a".repeat(30)} `;
  const state = webhookConfigFormReducer(
    webhookConfigFormReducer(
      webhookConfigFormReducer(createInitialWebhookConfigFormState("create"), {
        type: "url-change",
        value: " https://example.com/hooks/mdcms ",
      }),
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
  const state = webhookConfigFormReducer(
    createInitialWebhookConfigFormState("edit", {
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
  const state = webhookConfigFormReducer(
    webhookConfigFormReducer(
      createInitialWebhookConfigFormState("edit", {
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

test("isWebhookConfigFormSubmittable enforces url event secret and pending state", () => {
  const missingUrl = webhookConfigFormReducer(
    webhookConfigFormReducer(
      webhookConfigFormReducer(createInitialWebhookConfigFormState("create"), {
        type: "url-change",
        value: "   ",
      }),
      { type: "event-toggle", event: "content.published" },
    ),
    { type: "secret-change", value: "a".repeat(32) },
  );
  assert.equal(isWebhookConfigFormSubmittable(missingUrl, false), false);

  const missingEvents = webhookConfigFormReducer(
    webhookConfigFormReducer(createInitialWebhookConfigFormState("create"), {
      type: "url-change",
      value: "https://example.com/hooks/mdcms",
    }),
    { type: "secret-change", value: "a".repeat(32) },
  );
  assert.equal(isWebhookConfigFormSubmittable(missingEvents, false), false);

  const missingSecret = webhookConfigFormReducer(
    webhookConfigFormReducer(
      webhookConfigFormReducer(createInitialWebhookConfigFormState("create"), {
        type: "secret-change",
        value: "",
      }),
      { type: "url-change", value: "https://example.com/hooks/mdcms" },
    ),
    { type: "event-toggle", event: "content.published" },
  );
  assert.equal(isWebhookConfigFormSubmittable(missingSecret, false), false);

  const ready = webhookConfigFormReducer(missingSecret, {
    type: "secret-change",
    value: ` ${"a".repeat(30)} `,
  });
  assert.equal(isWebhookConfigFormSubmittable(ready, false), true);
  assert.equal(isWebhookConfigFormSubmittable(ready, true), false);

  const editReady = createInitialWebhookConfigFormState("edit", {
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
  assert.equal(isWebhookConfigFormSubmittable(editReady, false), true);

  const editShortSecret = webhookConfigFormReducer(editReady, {
    type: "secret-change",
    value: "short",
  });
  assert.equal(isWebhookConfigFormSubmittable(editShortSecret, false), false);

  const editRotatingSecret = webhookConfigFormReducer(editReady, {
    type: "secret-change",
    value: ` ${"b".repeat(30)} `,
  });
  assert.equal(isWebhookConfigFormSubmittable(editRotatingSecret, false), true);
});

test("isWebhookConfigFormSubmittable follows the shared webhook input contract", () => {
  const base = webhookConfigFormReducer(
    webhookConfigFormReducer(
      webhookConfigFormReducer(createInitialWebhookConfigFormState("create"), {
        type: "url-change",
        value: "https://example.com/hooks/mdcms",
      }),
      { type: "event-toggle", event: "content.published" },
    ),
    { type: "secret-change", value: "a".repeat(32) },
  );

  const httpUrl = webhookConfigFormReducer(base, {
    type: "url-change",
    value: "http://example.com/hooks/mdcms",
  });
  assert.equal(isWebhookConfigFormSubmittable(httpUrl, false), false);

  const urlWithFragment = webhookConfigFormReducer(base, {
    type: "url-change",
    value: "https://example.com/hooks/mdcms#fragment",
  });
  assert.equal(isWebhookConfigFormSubmittable(urlWithFragment, false), false);

  const oversizedSecret = webhookConfigFormReducer(base, {
    type: "secret-change",
    value: "a".repeat(4097),
  });
  assert.equal(isWebhookConfigFormSubmittable(oversizedSecret, false), false);
});

test("shouldResetWebhookConfigForm ignores fresh objects for the same edit target", () => {
  const originalConfig = createWebhookConfig({
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    url: "https://example.com/hooks/original",
  });
  const refetchedConfig = createWebhookConfig({
    id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597d",
    url: "https://example.com/hooks/refetched",
  });

  assert.equal(
    shouldResetWebhookConfigForm(
      { mode: "edit", config: originalConfig },
      { mode: "edit", config: refetchedConfig },
    ),
    false,
  );
  assert.equal(
    shouldResetWebhookConfigForm(
      { mode: "edit", config: originalConfig },
      {
        mode: "edit",
        config: createWebhookConfig({
          id: "018f0c6d-98da-7f25-89fe-7c7ef5e8597e",
        }),
      },
    ),
    true,
  );
  assert.equal(
    shouldResetWebhookConfigForm(
      { mode: "create", config: null },
      { mode: "edit", config: originalConfig },
    ),
    true,
  );
});

test("webhookConfigFormReducer toggles events and active state immutably", () => {
  const selected = webhookConfigFormReducer(
    createInitialWebhookConfigFormState("create"),
    { type: "event-toggle", event: "content.published" },
  );
  const unselected = webhookConfigFormReducer(selected, {
    type: "event-toggle",
    event: "content.published",
  });
  const inactive = webhookConfigFormReducer(selected, {
    type: "active-change",
    value: false,
  });

  assert.deepEqual(Array.from(selected.selectedEvents), ["content.published"]);
  assert.deepEqual(Array.from(unselected.selectedEvents), []);
  assert.equal(inactive.active, false);
  assert.equal(selected.active, true);
});

test("failed submit path preserves form state and renders an error", () => {
  const ready = webhookConfigFormReducer(
    webhookConfigFormReducer(
      webhookConfigFormReducer(
        webhookConfigFormReducer(
          createInitialWebhookConfigFormState("create"),
          { type: "url-change", value: "https://example.com/hooks/mdcms" },
        ),
        { type: "event-toggle", event: "content.published" },
      ),
      { type: "secret-change", value: "a".repeat(32) },
    ),
    { type: "active-change", value: false },
  );

  const submitting = webhookConfigFormReducer(ready, {
    type: "submit-start",
  });
  const failed = webhookConfigFormReducer(submitting, {
    type: "submit-error",
    message: "Endpoint rejected webhook.",
  });

  assert.equal(failed.submitError, "Endpoint rejected webhook.");
  assert.equal(failed.url, "https://example.com/hooks/mdcms");
  assert.equal(failed.selectedEvents.has("content.published"), true);
  assert.equal(failed.active, false);
  assert.equal(failed.secret, "a".repeat(32));

  assert.equal(
    getWebhookConfigFormErrorMessage(failed, null),
    "Endpoint rejected webhook.",
  );

  const markup = renderToStaticMarkup(
    createElement(WebhookConfigForm, {
      mode: "edit",
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
      onCancel: () => {},
      onSubmit: async () => {
        throw new Error("Endpoint rejected webhook.");
      },
      isSubmitting: false,
      error: null,
    }),
  );

  assert.match(markup, /value="https:\/\/example\.com\/hooks\/mdcms"/);
  assert.match(markup, /aria-pressed="true"[^>]*>[\s\S]*Published content/);
  assert.match(markup, /Notify when content becomes visible to readers/);
  assert.match(markup, /aria-checked="false"/);

  const errorMarkup = renderToStaticMarkup(
    createElement(WebhookConfigFormError, {
      message: "Endpoint rejected webhook.",
    }),
  );
  assert.match(errorMarkup, /role="alert"/);
  assert.match(errorMarkup, /Endpoint rejected webhook\./);
});

test("WebhookConfigForm renders event choices as operator-facing actions", () => {
  const markup = renderToStaticMarkup(
    createElement(WebhookConfigForm, {
      mode: "create",
      onCancel: () => {},
      onSubmit: async () => {},
      isSubmitting: false,
      error: null,
    }),
  );

  assert.match(markup, /Published content/);
  assert.match(markup, /Notify when content becomes visible to readers/);
  assert.match(markup, /Media uploaded/);
  assert.match(markup, /Notify when an asset is added to media storage/);
});

test("WebhookConfigForm renders generated signing secret controls for create", () => {
  const markup = renderToStaticMarkup(
    createElement(WebhookConfigForm, {
      mode: "create",
      onCancel: () => {},
      onSubmit: async () => {},
      isSubmitting: false,
      error: null,
    }),
  );

  assert.match(markup, /Signing secret/);
  assert.match(markup, /Regenerate/);
  assert.match(markup, /value="whsec_[0-9a-f]{64}"/);
  assert.doesNotMatch(markup, /HMAC secret/);
});

test("WebhookConfigForm exposes stable body and footer layout hooks", () => {
  const markup = renderToStaticMarkup(
    createElement(WebhookConfigForm, {
      mode: "create",
      onCancel: () => {},
      onSubmit: async () => {},
      isSubmitting: false,
      error: null,
      bodyClassName: "test-body",
      footerClassName: "test-footer",
    }),
  );

  assert.match(
    markup,
    /<div(?=[^>]*data-mdcms-webhook-config-form-body="create")(?=[^>]*class="test-body")[^>]*>/,
  );
  assert.match(
    markup,
    /<div(?=[^>]*data-mdcms-webhook-config-form-footer="true")(?=[^>]*class="test-footer")[^>]*>/,
  );
});

test("parent mutation errors are hidden until a submit attempt in the current open cycle", () => {
  const parentError = new Error("Stale mutation failure.");
  const initial = createInitialWebhookConfigFormState("create");

  assert.equal(getWebhookConfigFormErrorMessage(initial, parentError), null);

  const submitting = webhookConfigFormReducer(initial, {
    type: "submit-start",
  });
  assert.equal(
    getWebhookConfigFormErrorMessage(submitting, parentError),
    "Stale mutation failure.",
  );

  const failed = webhookConfigFormReducer(submitting, {
    type: "submit-error",
    message: "Current submit failed.",
  });
  assert.equal(
    getWebhookConfigFormErrorMessage(failed, parentError),
    "Current submit failed.",
  );

  const reset = webhookConfigFormReducer(failed, {
    type: "reset",
    mode: "create",
  });
  assert.equal(getWebhookConfigFormErrorMessage(reset, parentError), null);
});

test("fresh form render suppresses stale parent errors and exposes rendered errors accessibly", () => {
  const staleMarkup = renderToStaticMarkup(
    createElement(WebhookConfigForm, {
      mode: "create",
      onCancel: () => {},
      onSubmit: async () => {},
      isSubmitting: false,
      error: new Error("Stale mutation failure."),
    }),
  );

  assert.doesNotMatch(staleMarkup, /Stale mutation failure\./);
  assert.doesNotMatch(staleMarkup, /role="alert"/);

  const submitFailed = webhookConfigFormReducer(
    createInitialWebhookConfigFormState("create"),
    {
      type: "submit-error",
      message: "Current submit failed.",
    },
  );
  assert.equal(
    getWebhookConfigFormErrorMessage(submitFailed, null),
    "Current submit failed.",
  );

  const parentFailedAfterSubmit = webhookConfigFormReducer(
    createInitialWebhookConfigFormState("create"),
    { type: "submit-start" },
  );
  assert.equal(
    getWebhookConfigFormErrorMessage(
      parentFailedAfterSubmit,
      new Error("Current parent mutation failed."),
    ),
    "Current parent mutation failed.",
  );

  const parentErrorMarkup = renderToStaticMarkup(
    createElement(WebhookConfigFormError, {
      message: getWebhookConfigFormErrorMessage(
        parentFailedAfterSubmit,
        new Error("Current parent mutation failed."),
      ),
    }),
  );
  assert.match(parentErrorMarkup, /role="alert"/);
  assert.match(parentErrorMarkup, /Current parent mutation failed\./);
});
