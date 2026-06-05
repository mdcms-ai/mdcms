"use client";

import {
  useEffect,
  useReducer,
  useRef,
  type Dispatch,
  type FormEvent,
} from "react";
import { Check, RefreshCw } from "lucide-react";
import {
  WEBHOOK_EVENTS,
  parseWebhookCreateInput,
  parseWebhookUpdateInput,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookEvent,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Switch } from "./ui/switch.js";
import { getWebhookEventDisplay } from "./webhook-event-display.js";

export type WebhookConfigFormMode = "create" | "edit";

export type WebhookConfigFormState = {
  mode: WebhookConfigFormMode;
  url: string;
  selectedEvents: Set<WebhookEvent>;
  secret: string;
  active: boolean;
  submitError: string | null;
  hasSubmitAttempted: boolean;
};

export type WebhookConfigFormAction =
  | {
      type: "reset";
      mode: WebhookConfigFormMode;
      config?: WebhookConfig | null;
    }
  | { type: "url-change"; value: string }
  | { type: "event-toggle"; event: WebhookEvent }
  | { type: "secret-change"; value: string }
  | { type: "active-change"; value: boolean }
  | { type: "submit-start" }
  | { type: "submit-error"; message: string };

type WebhookConfigFormBaseProps = {
  isSubmitting: boolean;
  error: Error | null;
  onCancel: () => void;
  onSubmitted?: () => void;
  formClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
};

export type WebhookConfigCreateFormProps = WebhookConfigFormBaseProps & {
  mode: "create";
  config?: null;
  onSubmit: (input: WebhookCreateInput) => Promise<unknown>;
};

export type WebhookConfigEditFormProps = WebhookConfigFormBaseProps & {
  mode: "edit";
  config: WebhookConfig | null;
  onSubmit: (input: WebhookUpdateInput) => Promise<unknown>;
};

export type WebhookConfigFormProps =
  | WebhookConfigCreateFormProps
  | WebhookConfigEditFormProps;

export type WebhookSigningSecretRandomValues = (
  bytes: Uint8Array,
) => Uint8Array | void;

export type CreateInitialWebhookConfigFormStateOptions = {
  createSecret?: () => string;
};

const WEBHOOK_SIGNING_SECRET_BYTE_LENGTH = 32;
const WEBHOOK_SIGNING_SECRET_PREFIX = "whsec_";

function getSecureRandomValues(bytes: Uint8Array): Uint8Array {
  const crypto = globalThis.crypto;

  if (!crypto?.getRandomValues) {
    throw new Error(
      "Webhook signing secret generation requires Web Crypto support.",
    );
  }

  return crypto.getRandomValues(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function generateWebhookSigningSecret(
  randomValues: WebhookSigningSecretRandomValues = getSecureRandomValues,
): string {
  const bytes = new Uint8Array(WEBHOOK_SIGNING_SECRET_BYTE_LENGTH);
  randomValues(bytes);

  return `${WEBHOOK_SIGNING_SECRET_PREFIX}${bytesToHex(bytes)}`;
}

export function createInitialWebhookConfigFormState(
  mode: WebhookConfigFormMode,
  config?: WebhookConfig | null,
  options: CreateInitialWebhookConfigFormStateOptions = {},
): WebhookConfigFormState {
  const createSecret = options.createSecret ?? generateWebhookSigningSecret;

  return {
    mode,
    url: config?.url ?? "",
    selectedEvents: new Set(config?.events ?? []),
    secret: mode === "create" ? createSecret() : "",
    active: config?.active ?? true,
    submitError: null,
    hasSubmitAttempted: false,
  };
}

export function webhookConfigFormReducer(
  state: WebhookConfigFormState,
  action: WebhookConfigFormAction,
): WebhookConfigFormState {
  switch (action.type) {
    case "reset":
      return createInitialWebhookConfigFormState(action.mode, action.config);
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
      return { ...state, submitError: null, hasSubmitAttempted: true };
    case "submit-error":
      return {
        ...state,
        submitError: action.message,
        hasSubmitAttempted: true,
      };
  }
}

function hasValidSecretForMode(state: WebhookConfigFormState): boolean {
  const secretLength = state.secret.length;
  if (state.mode === "create") {
    return secretLength >= 32;
  }

  return secretLength === 0 || secretLength >= 32;
}

function hasValidWebhookInputForMode(state: WebhookConfigFormState): boolean {
  try {
    if (state.mode === "create") {
      parseWebhookCreateInput(buildWebhookConfigCreateInput(state));
    } else {
      parseWebhookUpdateInput(buildWebhookConfigUpdateInput(state));
    }
  } catch {
    return false;
  }

  return true;
}

export function isWebhookConfigFormSubmittable(
  state: WebhookConfigFormState,
  isSubmitting: boolean,
): boolean {
  return (
    state.url.trim().length > 0 &&
    state.selectedEvents.size > 0 &&
    hasValidSecretForMode(state) &&
    hasValidWebhookInputForMode(state) &&
    !isSubmitting
  );
}

export function buildWebhookConfigCreateInput(
  state: WebhookConfigFormState,
): WebhookCreateInput {
  return {
    url: state.url.trim(),
    events: Array.from(state.selectedEvents),
    secret: state.secret,
    active: state.active,
  };
}

export function buildWebhookConfigUpdateInput(
  state: WebhookConfigFormState,
): WebhookUpdateInput {
  const secret = state.secret;

  return {
    url: state.url.trim(),
    events: Array.from(state.selectedEvents),
    active: state.active,
    ...(secret.length > 0 ? { secret } : {}),
  };
}

export function getWebhookConfigFormErrorMessage(
  state: WebhookConfigFormState,
  error: Error | null,
): string | null {
  if (state.submitError) {
    return state.submitError;
  }

  return state.hasSubmitAttempted ? (error?.message ?? null) : null;
}

export function WebhookConfigFormError({
  message,
}: {
  message: string | null;
}) {
  if (!message) return null;

  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

export function shouldResetWebhookConfigForm(
  previous: { mode: WebhookConfigFormMode; config: WebhookConfig | null },
  next: { mode: WebhookConfigFormMode; config: WebhookConfig | null },
): boolean {
  if (previous.mode !== next.mode) {
    return true;
  }

  if (previous.mode === "create" || next.mode === "create") {
    return false;
  }

  return previous.config?.id !== next.config?.id;
}

function WebhookConfigFormFields({
  form,
  dispatch,
  isSubmitting,
  errorMessage,
}: {
  form: WebhookConfigFormState;
  dispatch: Dispatch<WebhookConfigFormAction>;
  isSubmitting: boolean;
  errorMessage: string | null;
}) {
  const mode = form.mode;

  return (
    <>
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

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Events</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {WEBHOOK_EVENTS.map((event) => {
            const selected = form.selectedEvents.has(event);
            const display = getWebhookEventDisplay(event);
            return (
              <button
                key={event}
                type="button"
                aria-pressed={selected}
                aria-label={`${display.label}: ${display.description}`}
                disabled={isSubmitting}
                onClick={() => dispatch({ type: "event-toggle", event })}
                className={cn(
                  "group flex min-h-20 w-full items-start gap-3 rounded-md border border-border bg-background-subtle/40 p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selected && "border-primary/60 bg-primary/10",
                  isSubmitting && "cursor-not-allowed opacity-50",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-transparent group-hover:border-primary/50",
                  )}
                >
                  {selected ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {display.label}
                    </span>
                    <span className="rounded-sm border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted">
                      {display.scope}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-foreground-muted">
                    {display.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="webhook-secret">
            {mode === "create" ? "Signing secret" : "Rotate signing secret"}
          </Label>
          {mode === "create" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                dispatch({
                  type: "secret-change",
                  value: generateWebhookSigningSecret(),
                })
              }
              disabled={isSubmitting}
            >
              <RefreshCw className="size-3.5" />
              Regenerate
            </Button>
          ) : null}
        </div>
        <Input
          id="webhook-secret"
          type={mode === "create" ? "text" : "password"}
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
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {mode === "create"
            ? "Generated automatically. Store it with the receiver before saving; it will not be shown again."
            : "Leave empty to preserve the existing signing secret."}
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2">
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

      <WebhookConfigFormError message={errorMessage} />
    </>
  );
}

function WebhookConfigFormFooter({
  canSubmit,
  isSubmitting,
  mode,
  onCancel,
  className,
}: {
  canSubmit: boolean;
  isSubmitting: boolean;
  mode: WebhookConfigFormMode;
  onCancel: () => void;
  className?: string;
}) {
  const footerProps = {
    "data-mdcms-webhook-config-form-footer": true,
    className,
  };
  const content = (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={isSubmitting}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        disabled={!canSubmit}
      >
        {isSubmitting
          ? "Saving..."
          : mode === "create"
            ? "Create webhook"
            : "Save changes"}
      </Button>
    </>
  );

  return <div {...footerProps}>{content}</div>;
}

export function WebhookConfigForm(props: WebhookConfigFormProps) {
  const { mode, isSubmitting, error } = props;
  const config = mode === "edit" ? props.config : null;
  const [form, dispatch] = useReducer(
    webhookConfigFormReducer,
    { config, mode },
    (initial) =>
      createInitialWebhookConfigFormState(initial.mode, initial.config),
  );
  const previousInputs = useRef({ config, mode });
  const canSubmit = isWebhookConfigFormSubmittable(form, isSubmitting);
  const errorMessage = getWebhookConfigFormErrorMessage(form, error);

  useEffect(() => {
    if (
      shouldResetWebhookConfigForm(previousInputs.current, { config, mode })
    ) {
      previousInputs.current = { config, mode };
      dispatch({ type: "reset", mode, config });
    }
  }, [config, mode]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    dispatch({ type: "submit-start" });

    try {
      if (props.mode === "create") {
        await props.onSubmit(buildWebhookConfigCreateInput(form));
      } else {
        await props.onSubmit(buildWebhookConfigUpdateInput(form));
      }
      props.onSubmitted?.();
    } catch (err) {
      dispatch({
        type: "submit-error",
        message: err instanceof Error ? err.message : "Failed to save webhook.",
      });
    }
  };

  return (
    <form
      data-mdcms-webhook-config-form={mode}
      onSubmit={handleSubmit}
      className={props.formClassName}
    >
      <div
        data-mdcms-webhook-config-form-body={mode}
        className={props.bodyClassName}
      >
        <WebhookConfigFormFields
          form={form}
          dispatch={dispatch}
          isSubmitting={isSubmitting}
          errorMessage={errorMessage}
        />
      </div>

      <WebhookConfigFormFooter
        canSubmit={canSubmit}
        isSubmitting={isSubmitting}
        mode={mode}
        onCancel={props.onCancel}
        className={props.footerClassName}
      />
    </form>
  );
}
