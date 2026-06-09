import type { MediaSettings } from "@mdcms/shared";

const explicitBytesError = "Enter a positive whole number of bytes.";

export type MediaSettingsDraft =
  | { mode: "unlimited"; explicitBytes: string }
  | { mode: "explicit"; explicitBytes: string };

export type MediaSettingsFormState = {
  baseline: MediaSettings | null;
  draft: MediaSettingsDraft | null;
  saved: boolean;
};

function mediaSettingsEqual(
  first: MediaSettings,
  second: MediaSettings,
): boolean {
  return (
    first.media.image.maxUploadSizeBytes ===
    second.media.image.maxUploadSizeBytes
  );
}

export function createMediaSettingsDraft(
  settings: MediaSettings,
): MediaSettingsDraft {
  const maxUploadSizeBytes = settings.media.image.maxUploadSizeBytes;

  if (maxUploadSizeBytes === null) {
    return { mode: "unlimited", explicitBytes: "" };
  }

  return { mode: "explicit", explicitBytes: String(maxUploadSizeBytes) };
}

export function parseExplicitBytes(value: string): number | null {
  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getMediaSettingsDraftError(
  draft: MediaSettingsDraft,
): string | null {
  if (draft.mode === "unlimited") {
    return null;
  }

  return parseExplicitBytes(draft.explicitBytes) === null
    ? explicitBytesError
    : null;
}

export function buildMediaSettingsUpdateInput(
  draft: MediaSettingsDraft,
): MediaSettings {
  if (draft.mode === "unlimited") {
    return {
      media: {
        image: {
          maxUploadSizeBytes: null,
        },
      },
    };
  }

  const maxUploadSizeBytes = parseExplicitBytes(draft.explicitBytes);

  if (maxUploadSizeBytes === null) {
    throw new Error("Cannot build media settings input from invalid bytes.");
  }

  return {
    media: {
      image: {
        maxUploadSizeBytes,
      },
    },
  };
}

export function isMediaSettingsDraftDirty(
  draft: MediaSettingsDraft,
  baseline: MediaSettings,
): boolean {
  const baselineLimit = baseline.media.image.maxUploadSizeBytes;

  if (draft.mode === "unlimited") {
    return baselineLimit !== null;
  }

  const parsedLimit = parseExplicitBytes(draft.explicitBytes);

  return parsedLimit === null || parsedLimit !== baselineLimit;
}

export function formatMediaLimitLabel(value: number | null): string {
  if (value === null) {
    return "Unlimited";
  }

  return `${new Intl.NumberFormat("en-US").format(value)} bytes`;
}

export function createMediaSettingsFormState(
  settings: MediaSettings | null,
  initialDraft?: MediaSettingsDraft,
): MediaSettingsFormState {
  return {
    baseline: settings,
    draft: settings
      ? (initialDraft ?? createMediaSettingsDraft(settings))
      : null,
    saved: false,
  };
}

export function reconcileMediaSettingsFormState(
  current: MediaSettingsFormState,
  settings: MediaSettings | null,
  initialDraft?: MediaSettingsDraft,
): MediaSettingsFormState {
  if (!settings) {
    return { baseline: null, draft: null, saved: false };
  }

  if (!current.baseline || !current.draft) {
    return createMediaSettingsFormState(settings, initialDraft);
  }

  if (mediaSettingsEqual(current.baseline, settings)) {
    return current;
  }

  if (isMediaSettingsDraftDirty(current.draft, current.baseline)) {
    return {
      baseline: settings,
      draft: current.draft,
      saved: false,
    };
  }

  return createMediaSettingsFormState(settings);
}
