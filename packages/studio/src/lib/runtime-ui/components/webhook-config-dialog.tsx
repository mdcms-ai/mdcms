"use client";

import { useEffect, useReducer } from "react";
import { Check, RefreshCw } from "lucide-react";
import {
  WEBHOOK_EVENTS,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookEvent,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import { cn } from "../lib/utils.js";
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
import { getWebhookEventDisplay } from "./webhook-event-display.js";

export type WebhookConfigDialogMode = "create" | "edit";

export type WebhookConfigDialogFormState = {
  mode: WebhookConfigDialogMode;
  url: string;
  selectedEvents: Set<WebhookEvent>;
  secret: string;
  active: boolean;
  submitError: string | null;
  hasSubmitAttempted: boolean;
};

export type WebhookConfigDialogFormAction =
  | {
      type: "reset";
      mode: WebhookConfigDialogMode;
      config?: WebhookConfig | null;
    }
  | { type: "url-change"; value: string }
  | { type: "event-toggle"; event: WebhookEvent }
  | { type: "secret-change"; value: string }
  | { type: "active-change"; value: boolean }
  | { type: "submit-start" }
  | { type: "submit-error"; message: string };

type WebhookConfigDialogBaseProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSubmitting: boolean;
  error: Error | null;
};

export type WebhookConfigCreateDialogProps = WebhookConfigDialogBaseProps & {
  mode: "create";
  onSubmit: (input: WebhookCreateInput) => Promise<unknown>;
};

export type WebhookConfigEditDialogProps = WebhookConfigDialogBaseProps & {
  mode: "edit";
  config: WebhookConfig | null;
  onSubmit: (input: WebhookUpdateInput) => Promise<unknown>;
};

export type WebhookConfigDialogProps =
  | WebhookConfigCreateDialogProps
  | WebhookConfigEditDialogProps;

export type WebhookSigningSecretRandomValues = (
  bytes: Uint8Array,
) => Uint8Array | void;

export type CreateInitialWebhookConfigDialogFormStateOptions = {
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

export function createInitialWebhookConfigDialogFormState(
  mode: WebhookConfigDialogMode,
  config?: WebhookConfig | null,
  options: CreateInitialWebhookConfigDialogFormStateOptions = {},
): WebhookConfigDialogFormState {
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

export function webhookConfigDialogFormReducer(
  state: WebhookConfigDialogFormState,
  action: WebhookConfigDialogFormAction,
): WebhookConfigDialogFormState {
  switch (action.type) {
    case "reset":
      return createInitialWebhookConfigDialogFormState(
        action.mode,
        action.config,
      );
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

function hasValidSecretForMode(state: WebhookConfigDialogFormState): boolean {
  const secretLength = state.secret.length;
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
    secret: state.secret,
    active: state.active,
  };
}

export function buildWebhookConfigUpdateInput(
  state: WebhookConfigDialogFormState,
): WebhookUpdateInput {
  const secret = state.secret;

  return {
    url: state.url.trim(),
    events: Array.from(state.selectedEvents),
    active: state.active,
    ...(secret.length > 0 ? { secret } : {}),
  };
}

export function getWebhookConfigDialogErrorMessage(
  state: WebhookConfigDialogFormState,
  error: Error | null,
): string | null {
  if (state.submitError) {
    return state.submitError;
  }

  return state.hasSubmitAttempted ? (error?.message ?? null) : null;
}

export function WebhookConfigDialogError({
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

export function WebhookConfigDialog(props: WebhookConfigDialogProps) {
  const { mode, open, onOpenChange, isSubmitting, error } = props;
  const config = mode === "edit" ? props.config : null;
  const [form, dispatch] = useReducer(
    webhookConfigDialogFormReducer,
    { config, mode },
    (initial) =>
      createInitialWebhookConfigDialogFormState(initial.mode, initial.config),
  );
  const canSubmit = isWebhookConfigDialogSubmittable(form, isSubmitting);
  const errorMessage = getWebhookConfigDialogErrorMessage(form, error);

  useEffect(() => {
    if (open) {
      dispatch({ type: "reset", mode, config });
    }
  }, [config, mode, open]);

  const title = mode === "create" ? "Create webhook" : "Edit webhook";
  const description =
    mode === "create"
      ? "Add an HTTPS endpoint for selected MDCMS events."
      : "Update the endpoint, events, active state, or rotate the signing secret.";

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
      if (props.mode === "create") {
        await props.onSubmit(buildWebhookConfigCreateInput(form));
      } else {
        await props.onSubmit(buildWebhookConfigUpdateInput(form));
      }
      handleOpenChange(false);
    } catch (err) {
      dispatch({
        type: "submit-error",
        message: err instanceof Error ? err.message : "Failed to save webhook.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-mdcms-webhook-dialog-content
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"
      >
        <form
          data-mdcms-webhook-dialog-form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div
            data-mdcms-webhook-dialog-body
            className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-4"
          >
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
                  {mode === "create"
                    ? "Signing secret"
                    : "Rotate signing secret"}
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

            <WebhookConfigDialogError message={errorMessage} />
          </div>

          <DialogFooter
            data-mdcms-webhook-dialog-footer
            className="shrink-0 pt-2"
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
