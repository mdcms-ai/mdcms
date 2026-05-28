"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  loadStudioContentOverviewState,
  type LoadStudioContentOverviewStateInput,
  type StudioContentOverviewState,
} from "../../content-overview-state.js";
import type { StudioRuntimeAuth } from "../../request-auth.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";

function getContentOverviewQueryKey(
  project: string | null | undefined,
  environment: string | null | undefined,
  apiBaseUrl: string | null | undefined,
  authMode: StudioRuntimeAuth["mode"] | null | undefined,
  supportedLocales: readonly string[] | undefined,
) {
  return [
    "studio",
    "content-overview",
    project,
    environment,
    apiBaseUrl,
    authMode,
    supportedLocales,
  ] as const;
}

export function useStudioContentOverview(
  loadState: (
    input: LoadStudioContentOverviewStateInput,
  ) => Promise<StudioContentOverviewState> = loadStudioContentOverviewState,
) {
  const mountInfo = useStudioMountInfo();

  const loadInput = useMemo<LoadStudioContentOverviewStateInput | null>(() => {
    if (!mountInfo.project || !mountInfo.environment) {
      return null;
    }
    return {
      config: {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
        supportedLocales: mountInfo.supportedLocales,
      },
      auth: mountInfo.auth,
    };
  }, [
    mountInfo.project,
    mountInfo.environment,
    mountInfo.apiBaseUrl,
    mountInfo.auth,
    mountInfo.supportedLocales,
  ]);

  return useQuery<StudioContentOverviewState>({
    queryKey: getContentOverviewQueryKey(
      mountInfo.project,
      mountInfo.environment,
      mountInfo.apiBaseUrl,
      mountInfo.auth.mode,
      mountInfo.supportedLocales,
    ),
    queryFn: () => loadState(loadInput!),
    enabled: loadInput !== null,
  });
}
