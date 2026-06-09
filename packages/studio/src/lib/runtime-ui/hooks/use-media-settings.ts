"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RuntimeError, type MediaSettings } from "@mdcms/shared";

import { useStudioApiConfig } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";
import { createStudioMediaSettingsApi } from "../lib/media-settings-api.js";

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

export type UseMediaSettingsOptions = {
  enabled?: boolean;
};

function createUnavailableApiError(): Error {
  return new RuntimeError({
    code: "API_NOT_AVAILABLE",
    message: "Media settings API client is not available.",
    statusCode: 0,
  });
}

export function useMediaSettings(
  options: UseMediaSettingsOptions = {},
): SettingsPageMediaSettingsState {
  const enabled = options.enabled ?? true;
  const apiConfig = useStudioApiConfig();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const canLoad = enabled && Boolean(apiConfig?.config.serverUrl);
  const csrfToken =
    session.status === "authenticated" ? session.csrfToken : null;

  const api = useMemo(() => {
    if (!canLoad || !apiConfig) {
      return null;
    }

    return createStudioMediaSettingsApi(apiConfig.config, {
      ...apiConfig.authOptions,
      csrfToken,
    });
  }, [apiConfig, canLoad, csrfToken]);

  const queryKey = useMemo(
    () => [
      "media-settings",
      apiConfig?.config.project ?? null,
      apiConfig?.config.environment ?? null,
      apiConfig?.config.serverUrl ?? null,
      apiConfig?.authOptions.auth.mode ?? null,
      apiConfig?.authOptions.auth.mode === "token"
        ? apiConfig.authOptions.auth.token
        : null,
    ],
    [apiConfig],
  );

  const query = useQuery({
    queryKey,
    enabled: api !== null,
    queryFn: async () => api!.getSettings(),
  });

  const invalidateSettings = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const updateMutation = useMutation({
    mutationFn: async (input: MediaSettings) => {
      if (!api) {
        throw createUnavailableApiError();
      }

      return api.updateSettings(input);
    },
    onSuccess: invalidateSettings,
  });

  const status: SettingsPageMediaSettingsStatus = useMemo(() => {
    if (!canLoad) return "unavailable";
    if (query.isLoading) return "loading";
    if (query.error) return "error";
    return "ready";
  }, [canLoad, query.error, query.isLoading]);

  const errorMessage = useMemo(() => {
    if (!query.error) {
      return status === "unavailable"
        ? "Studio is missing project or environment context."
        : undefined;
    }

    return query.error instanceof Error
      ? query.error.message
      : "Failed to load media settings.";
  }, [query.error, status]);

  return {
    status,
    settings: query.data ?? null,
    errorMessage,
    refetch: () => {
      void query.refetch();
    },
    updateSettings: (input) => updateMutation.mutateAsync(input),
    isUpdating: updateMutation.isPending,
    updateError: updateMutation.error,
    resetUpdateError: () => updateMutation.reset(),
  };
}
