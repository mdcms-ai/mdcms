"use client";

import { useReducer } from "react";
import { Copy, Check } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Badge } from "./ui/badge.js";
import { cn } from "../lib/utils.js";

import type {
  ApiKeyOperationScope,
  ApiKeyCreateInput,
  ApiKeyCreateResult,
} from "../../api-keys-api.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";

/* ------------------------------------------------------------------ */
/*  Scope groups for organized display                                 */
/* ------------------------------------------------------------------ */

type ScopeGroup = {
  label: string;
  scopes: ApiKeyOperationScope[];
};

const SCOPE_GROUPS: ScopeGroup[] = [
  {
    label: "Content",
    scopes: [
      "content:read",
      "content:read:draft",
      "content:write",
      "content:write:draft",
      "content:publish",
      "content:delete",
    ],
  },
  {
    label: "Schema",
    scopes: ["schema:read", "schema:write"],
  },
  {
    label: "Media",
    scopes: ["media:upload", "media:delete"],
  },
  {
    label: "Webhooks",
    scopes: ["webhooks:read", "webhooks:write"],
  },
  {
    label: "Environments",
    scopes: ["environments:clone", "environments:promote"],
  },
  {
    label: "Migrations",
    scopes: ["migrations:run"],
  },
  {
    label: "Projects",
    scopes: ["projects:read", "projects:write"],
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export type ApiKeyCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ApiKeyCreateInput) => Promise<ApiKeyCreateResult>;
  isSubmitting: boolean;
  error: Error | null;
};

type Step = "form" | "created";

export type ApiKeyCreateDialogFormState = {
  step: Step;
  label: string;
  selectedScopes: Set<ApiKeyOperationScope>;
  expiresAt: string;
  createdResult: ApiKeyCreateResult | null;
  copied: boolean;
  submitError: string | null;
};

export function createInitialApiKeyCreateDialogFormState(): ApiKeyCreateDialogFormState {
  return {
    step: "form",
    label: "",
    selectedScopes: new Set(),
    expiresAt: "",
    createdResult: null,
    copied: false,
    submitError: null,
  };
}

const initialFormState: ApiKeyCreateDialogFormState =
  createInitialApiKeyCreateDialogFormState();

function formatDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type ApiKeyCreateDialogFormAction =
  | { type: "reset" }
  | { type: "label-change"; value: string }
  | { type: "scope-toggle"; scope: ApiKeyOperationScope }
  | { type: "expires-at-change"; value: string }
  | { type: "submit-start" }
  | { type: "submit-success"; result: ApiKeyCreateResult }
  | { type: "submit-error"; message: string }
  | { type: "copy-set"; copied: boolean };

export function apiKeyCreateDialogFormReducer(
  state: ApiKeyCreateDialogFormState,
  action: ApiKeyCreateDialogFormAction,
): ApiKeyCreateDialogFormState {
  switch (action.type) {
    case "reset":
      // Build a fresh state so `selectedScopes` is a new Set rather than the
      // shared one held by `initialFormState` — otherwise a subsequent
      // `scope-toggle` would mutate the module-level reference.
      return createInitialApiKeyCreateDialogFormState();
    case "label-change":
      return { ...state, label: action.value };
    case "scope-toggle": {
      const next = new Set(state.selectedScopes);
      if (next.has(action.scope)) {
        next.delete(action.scope);
      } else {
        next.add(action.scope);
      }
      return { ...state, selectedScopes: next };
    }
    case "expires-at-change":
      return { ...state, expiresAt: action.value };
    case "submit-start":
      return { ...state, submitError: null };
    case "submit-success":
      return { ...state, step: "created", createdResult: action.result };
    case "submit-error":
      return { ...state, submitError: action.message };
    case "copy-set":
      return { ...state, copied: action.copied };
  }
}

export function isApiKeyCreateDialogSubmittable(
  state: Pick<ApiKeyCreateDialogFormState, "label" | "selectedScopes">,
  isSubmitting: boolean,
): boolean {
  return (
    state.label.trim().length > 0 &&
    state.selectedScopes.size > 0 &&
    !isSubmitting
  );
}

export function buildApiKeyCreateInput(input: {
  label: string;
  selectedScopes: Set<ApiKeyOperationScope>;
  expiresAt: string;
  project: string | null | undefined;
  environment: string | null | undefined;
}): ApiKeyCreateInput {
  const contextAllowlist =
    input.project && input.environment
      ? [{ project: input.project, environment: input.environment }]
      : [];

  return {
    label: input.label.trim(),
    scopes: Array.from(input.selectedScopes),
    contextAllowlist,
    ...(input.expiresAt
      ? { expiresAt: new Date(input.expiresAt).toISOString() }
      : {}),
  };
}

export function ApiKeyCreateDialog({
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  error,
}: ApiKeyCreateDialogProps) {
  const mountInfo = useStudioMountInfo();
  const [form, dispatch] = useReducer(
    apiKeyCreateDialogFormReducer,
    initialFormState,
  );
  const {
    step,
    label,
    selectedScopes,
    expiresAt,
    createdResult,
    copied,
    submitError,
  } = form;
  const todayMinDate = open ? formatDateInputValue(new Date()) : undefined;

  const canSubmit = isApiKeyCreateDialogSubmittable(form, isSubmitting);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    dispatch({ type: "submit-start" });

    const input = buildApiKeyCreateInput({
      label,
      selectedScopes,
      expiresAt,
      project: mountInfo.project,
      environment: mountInfo.environment,
    });

    try {
      const result = await onSubmit(input);
      dispatch({ type: "submit-success", result });
    } catch (err) {
      dispatch({
        type: "submit-error",
        message:
          err instanceof Error ? err.message : "Failed to create API key.",
      });
    }
  };

  const handleCopy = async () => {
    if (!createdResult) return;
    await navigator.clipboard.writeText(createdResult.key);
    dispatch({ type: "copy-set", copied: true });
    setTimeout(() => dispatch({ type: "copy-set", copied: false }), 2000);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      dispatch({ type: "reset" });
    }
    onOpenChange(nextOpen);
  };
  const handleDismiss = () => {
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {step === "form" && (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Create API Key</DialogTitle>
              <DialogDescription>
                Create a new API key with specific permissions.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Label input */}
              <div className="space-y-2">
                <Label htmlFor="api-key-label">Label</Label>
                <Input
                  id="api-key-label"
                  value={label}
                  onChange={(e) =>
                    dispatch({ type: "label-change", value: e.target.value })
                  }
                  placeholder="e.g. CI/CD Pipeline"
                  disabled={isSubmitting}
                />
              </div>

              {/* Scope selection */}
              <div className="space-y-3">
                <Label>Scopes</Label>
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.label} className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {group.label}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {group.scopes.map((scope) => {
                        const isSelected = selectedScopes.has(scope);
                        return (
                          <button
                            key={scope}
                            type="button"
                            disabled={isSubmitting}
                            aria-pressed={isSelected}
                            onClick={() =>
                              dispatch({ type: "scope-toggle", scope })
                            }
                          >
                            <Badge
                              variant={isSelected ? "default" : "outline"}
                              className={cn(
                                "cursor-pointer select-none",
                                isSubmitting && "opacity-50 cursor-not-allowed",
                              )}
                            >
                              {scope}
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Expiration date */}
              <div className="space-y-2">
                <Label htmlFor="api-key-expires">Expires</Label>
                <Input
                  id="api-key-expires"
                  type="date"
                  value={expiresAt}
                  onChange={(e) =>
                    dispatch({
                      type: "expires-at-change",
                      value: e.target.value,
                    })
                  }
                  disabled={isSubmitting}
                  min={todayMinDate}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for no expiration.
                </p>
              </div>

              {/* Error display */}
              {(error || submitError) && (
                <p className="text-sm text-destructive">
                  {submitError ?? error?.message}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={handleDismiss}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled={!canSubmit}
              >
                {isSubmitting ? "Creating..." : "Create API Key"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "created" && createdResult && (
          <div>
            <DialogHeader>
              <DialogTitle>API Key Created</DialogTitle>
              <DialogDescription>
                Copy your API key now. You will not be able to see it again.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>API Key</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm font-mono break-all">
                    {createdResult.key}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <Check className="size-4 text-green-500" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={handleDismiss}
              >
                I've saved this key
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
