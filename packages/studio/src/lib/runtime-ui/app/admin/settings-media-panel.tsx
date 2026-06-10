"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Image, RotateCcw, Save } from "lucide-react";

import type { SettingsPageMediaSettingsState } from "../../hooks/use-media-settings.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Switch } from "../../components/ui/switch.js";
import {
  buildMediaSettingsUpdateInput,
  createMediaSettingsFormState,
  formatMediaLimitLabel,
  getMediaSettingsDraftError,
  isMediaSettingsDraftDirty,
  reconcileMediaSettingsFormState,
  type MediaSettingsDraft,
} from "./settings-media-model.js";
import { cn } from "../../lib/utils.js";

export type SettingsMediaPanelProps = {
  state: SettingsPageMediaSettingsState;
  initialDraft?: MediaSettingsDraft;
};

function SettingsMediaHeader() {
  return (
    <div>
      <h2 className="font-heading text-[30px] font-semibold leading-tight text-foreground">
        Media
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Configure project-level media upload behavior for the active Studio
        target.
      </p>
    </div>
  );
}

function MediaSettingsLoadingState() {
  return (
    <section data-mdcms-settings-media-state="loading" className="space-y-5">
      <SettingsMediaHeader />
      <div className="rounded-lg border border-card-border bg-card p-5">
        <div className="space-y-3">
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      </div>
    </section>
  );
}

function MediaSettingsErrorState({
  status,
  message,
  onRetry,
}: {
  status: "error" | "unavailable";
  message: string;
  onRetry?: () => void;
}) {
  return (
    <section data-mdcms-settings-media-state={status} className="space-y-5">
      <SettingsMediaHeader />
      <div
        role="alert"
        aria-live="assertive"
        className="rounded-lg border border-destructive/25 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 space-y-3">
            <p>{message}</p>
            {onRetry ? (
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

export function SettingsMediaPanel({
  state,
  initialDraft,
}: SettingsMediaPanelProps) {
  const [formState, setFormState] = useState(() =>
    createMediaSettingsFormState(state.settings, initialDraft),
  );

  useEffect(() => {
    setFormState((current) =>
      reconcileMediaSettingsFormState(current, state.settings, initialDraft),
    );
  }, [initialDraft, state.settings]);

  if (state.status === "loading") {
    return <MediaSettingsLoadingState />;
  }

  if (state.status === "error") {
    return (
      <MediaSettingsErrorState
        status="error"
        message={state.errorMessage ?? "Failed to load media settings."}
        onRetry={state.refetch}
      />
    );
  }

  if (state.status === "unavailable") {
    return (
      <MediaSettingsErrorState
        status="unavailable"
        message={
          state.errorMessage ??
          "Studio is missing project or environment context."
        }
      />
    );
  }

  if (!state.settings || !formState.baseline || !formState.draft) {
    return <MediaSettingsLoadingState />;
  }

  const { baseline, draft, saved } = formState;
  const draftError = getMediaSettingsDraftError(draft);
  const isDirty = isMediaSettingsDraftDirty(draft, baseline);
  const currentLimit = baseline.media.image.maxUploadSizeBytes;
  const canSave = !draftError && isDirty && !state.isUpdating;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    state.resetUpdateError();
    state
      .updateSettings(buildMediaSettingsUpdateInput(draft))
      .then((updated) => {
        setFormState({
          ...createMediaSettingsFormState(updated),
          saved: true,
        });
      })
      .catch(() => {
        setFormState((current) => ({ ...current, saved: false }));
      });
  };

  const resetDraft = () => {
    setFormState(createMediaSettingsFormState(baseline));
    state.resetUpdateError();
  };

  return (
    <section data-mdcms-settings-media-state="ready" className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SettingsMediaHeader />
        <Badge variant="outline" className="rounded-sm font-mono text-[11px]">
          {formatMediaLimitLabel(currentLimit)}
        </Badge>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-card-border bg-card p-5"
      >
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Image className="size-4 text-primary" />
              Image upload limit
            </div>

            <div className="rounded-md border border-border bg-background-subtle p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="media-upload-unlimited">
                    Unlimited image uploads
                  </Label>
                  <p className="text-sm text-foreground-muted">
                    Store <code>null</code> and let MDCMS accept images without
                    an application-level byte cap.
                  </p>
                </div>
                <Switch
                  id="media-upload-unlimited"
                  checked={draft.mode === "unlimited"}
                  disabled={state.isUpdating}
                  onCheckedChange={(checked) => {
                    setFormState((current) => ({
                      ...current,
                      draft: {
                        mode: checked ? "unlimited" : "explicit",
                        explicitBytes: current.draft?.explicitBytes ?? "",
                      },
                      saved: false,
                    }));
                  }}
                  aria-label="Use unlimited image upload size"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="media-upload-limit">Explicit byte limit</Label>
              <Input
                id="media-upload-limit"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={draft.explicitBytes}
                disabled={draft.mode === "unlimited" || state.isUpdating}
                aria-invalid={draftError ? "true" : undefined}
                aria-describedby={
                  draftError ? "media-upload-limit-error" : undefined
                }
                onChange={(event) => {
                  setFormState((current) => ({
                    ...current,
                    draft: {
                      mode: "explicit",
                      explicitBytes: event.currentTarget.value,
                    },
                    saved: false,
                  }));
                }}
              />
              {draftError ? (
                <p
                  id="media-upload-limit-error"
                  className="text-sm text-destructive"
                  role="alert"
                >
                  {draftError}
                </p>
              ) : (
                <p className="text-sm text-foreground-muted">
                  Enter a positive whole number of bytes.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background-subtle p-4">
              <p className="font-mono text-[11px] uppercase text-foreground-muted">
                Enforcement
              </p>
              <p className="mt-3 text-sm text-foreground">
                This setting only controls the application-level byte cap for
                image uploads.
              </p>
              <p className="mt-2 text-sm text-foreground-muted">
                Infrastructure and proxy limits can still reject uploads before
                MDCMS sees them.
              </p>
            </div>

            {state.updateError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive"
              >
                {state.updateError.message || "Failed to save media settings."}
              </div>
            ) : null}

            <div
              role="status"
              aria-live="polite"
              className={cn(
                saved
                  ? "rounded-md border border-success/20 bg-success/10 p-3 text-sm text-success"
                  : "sr-only",
              )}
            >
              {saved ? "Media settings saved." : ""}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={!canSave}>
                <Save className="size-4" />
                Save changes
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!isDirty || state.isUpdating}
                onClick={resetDraft}
              >
                <RotateCcw className="size-4" />
                Reset
              </Button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
