"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  loadDashboardData,
  type DashboardLoadResult,
} from "../../dashboard-data.js";
import { createStudioContentListApi } from "../../content-list-api.js";
import { createStudioContentOverviewApi } from "../../content-overview-api.js";
import { createStudioSchemaRouteApi } from "../../schema-route-api.js";
import type { StudioRuntimeAuth } from "../../request-auth.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";

function getDashboardDataQueryKey(
  project: string | null | undefined,
  environment: string | null | undefined,
  apiBaseUrl: string | null | undefined,
  authMode: StudioRuntimeAuth["mode"] | null | undefined,
) {
  return [
    "studio",
    "dashboard",
    project,
    environment,
    apiBaseUrl,
    authMode,
  ] as const;
}

export function useDashboardData() {
  const mountInfo = useStudioMountInfo();
  const { project, environment, apiBaseUrl, auth } = mountInfo;

  const apis = useMemo(() => {
    if (!project || !environment || !apiBaseUrl) {
      return null;
    }
    const config = { project, environment, serverUrl: apiBaseUrl };
    const authOpts = { auth };
    return {
      schemaApi: createStudioSchemaRouteApi(config, authOpts),
      contentApi: createStudioContentListApi(config, authOpts),
      overviewApi: createStudioContentOverviewApi(config, authOpts),
    };
  }, [project, environment, apiBaseUrl, auth]);

  return useQuery<DashboardLoadResult>({
    queryKey: getDashboardDataQueryKey(
      project,
      environment,
      apiBaseUrl,
      auth.mode,
    ),
    queryFn: () =>
      loadDashboardData(apis!.schemaApi, apis!.contentApi, apis!.overviewApi),
    enabled: apis !== null,
  });
}
