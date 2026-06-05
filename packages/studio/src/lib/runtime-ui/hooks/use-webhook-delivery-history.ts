"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ParsedWebhookDeliveryHistoryQuery,
  WebhookDeliveryHistoryEntry,
  WebhookDeliveryOutcome,
  WebhookEvent,
} from "@mdcms/shared";

import { createStudioWebhooksApi } from "../lib/webhooks-api.js";
import { useStudioApiConfig } from "../app/admin/mount-info-context.js";

export type SettingsPageWebhookHistoryFilters = {
  webhookId: string;
  event: WebhookEvent | "";
  outcome: WebhookDeliveryOutcome | "";
  limit: number;
};

export type SettingsPageWebhookHistoryStatus =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "unavailable";

export type SettingsPageWebhookHistoryState = {
  status: SettingsPageWebhookHistoryStatus;
  entries: WebhookDeliveryHistoryEntry[];
  filters: SettingsPageWebhookHistoryFilters;
  errorMessage?: string;
  setFilters: (
    updater:
      | SettingsPageWebhookHistoryFilters
      | ((
          filters: SettingsPageWebhookHistoryFilters,
        ) => SettingsPageWebhookHistoryFilters),
  ) => void;
};

export type UseWebhookDeliveryHistoryOptions = {
  enabled?: boolean;
};

function toHistoryQuery(
  filters: SettingsPageWebhookHistoryFilters,
): Partial<ParsedWebhookDeliveryHistoryQuery> {
  return {
    ...(filters.webhookId.trim()
      ? { webhookId: filters.webhookId.trim() }
      : {}),
    ...(filters.event ? { event: filters.event } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    limit: filters.limit,
  };
}

export function useWebhookDeliveryHistory(
  options: UseWebhookDeliveryHistoryOptions = {},
): SettingsPageWebhookHistoryState {
  const enabled = options.enabled ?? true;
  const apiConfig = useStudioApiConfig();
  const [filters, setFilters] = useState<SettingsPageWebhookHistoryFilters>({
    webhookId: "",
    event: "",
    outcome: "",
    limit: 50,
  });
  const canLoad = enabled && Boolean(apiConfig?.config.serverUrl);

  const api = useMemo(() => {
    if (!canLoad || !apiConfig) {
      return null;
    }

    return createStudioWebhooksApi(apiConfig.config, apiConfig.authOptions);
  }, [apiConfig, canLoad]);

  const historyQuery = useMemo(() => toHistoryQuery(filters), [filters]);

  const query = useQuery({
    queryKey: [
      "webhook-delivery-history",
      apiConfig?.config.project ?? null,
      apiConfig?.config.environment ?? null,
      apiConfig?.config.serverUrl ?? null,
      apiConfig?.authOptions.auth.mode ?? null,
      apiConfig?.authOptions.auth.mode === "token"
        ? apiConfig.authOptions.auth.token
        : null,
      historyQuery.webhookId ?? null,
      historyQuery.event ?? null,
      historyQuery.outcome ?? null,
      historyQuery.limit,
    ],
    enabled: api !== null,
    queryFn: async () => api!.listDeliveryHistory(historyQuery),
  });

  const entries = query.data ?? [];

  const status: SettingsPageWebhookHistoryStatus = useMemo(() => {
    if (!canLoad) return "unavailable";
    if (query.isLoading) return "loading";
    if (query.error) return "error";
    if (entries.length === 0) return "empty";
    return "ready";
  }, [canLoad, entries.length, query.error, query.isLoading]);

  const errorMessage = useMemo(() => {
    if (!query.error) {
      return status === "unavailable"
        ? "Studio is missing project or environment context."
        : undefined;
    }

    return query.error instanceof Error
      ? query.error.message
      : "Failed to load webhook delivery history.";
  }, [query.error, status]);

  return {
    status,
    entries,
    filters,
    errorMessage,
    setFilters,
  };
}
