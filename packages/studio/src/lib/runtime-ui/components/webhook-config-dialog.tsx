"use client";

import { useEffect, useReducer } from "react";
import {
  WEBHOOK_EVENTS,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookEvent,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import { cn } from "../lib/utils.js";
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
    createInitialWebhookConfigDialogFormState(mode, config),
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
              <p className="text-xs text-muted-foreground">
                Secrets are write-only and must be at least 32 characters when
                provided.
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

          <DialogFooter>
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
