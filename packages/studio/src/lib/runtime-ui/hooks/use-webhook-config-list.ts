"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RuntimeError,
  type WebhookConfig,
  type WebhookCreateInput,
  type WebhookUpdateInput,
} from "@mdcms/shared";

import { createStudioWebhooksApi } from "../../webhooks-api.js";
import { useStudioApiConfig } from "../app/admin/mount-info-context.js";
import { useStudioSession } from "../app/admin/session-context.js";

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
  clearDeleteError: () => void;
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

function createUnavailableApiError(): RuntimeError {
  return new RuntimeError({
    code: "API_NOT_AVAILABLE",
    message: "Webhook API client is not available.",
    statusCode: 0,
  });
}

export function useWebhookConfigList(
  options: UseWebhookConfigListOptions = {},
): SettingsPageWebhookConfigState {
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

    return createStudioWebhooksApi(apiConfig.config, apiConfig.authOptions);
  }, [apiConfig, canLoad]);

  const queryKey = useMemo(
    () => [
      "webhook-configs",
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
    queryFn: async () => api!.listConfigs(),
  });

  const requireMutationCsrfToken = useCallback((): string | undefined => {
    if (apiConfig?.authOptions.auth.mode === "token") {
      return undefined;
    }
    if (!csrfToken) {
      throw createMissingCsrfError();
    }
    return csrfToken;
  }, [apiConfig, csrfToken]);

  const invalidateConfigs = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const createMutation = useMutation({
    mutationFn: async (input: WebhookCreateInput) => {
      if (!api) {
        throw createUnavailableApiError();
      }

      return api.createConfig(input, requireMutationCsrfToken());
    },
    onSuccess: invalidateConfigs,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: { id: string; patch: WebhookUpdateInput }) => {
      if (!api) {
        throw createUnavailableApiError();
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
        throw createUnavailableApiError();
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
    clearDeleteError: () => deleteMutation.reset(),
  };
}
