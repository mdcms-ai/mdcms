"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  QueryClientProvider,
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { MdxComponentCatalog, StudioMountContext } from "@mdcms/shared";

import { createStudioQueryClient } from "../../query-client.js";
import { ToastProvider } from "../../components/toast.js";

import { createStudioCurrentPrincipalCapabilitiesApi } from "../../../current-principal-capabilities-api.js";
import { createStudioSessionApi } from "../../../session-api.js";
import { createStudioEnvironmentApi } from "../../../environment-api.js";
import { AdminCapabilitiesProvider } from "./capabilities-context.js";
import {
  StudioSessionProvider,
  type StudioSessionState,
} from "./session-context.js";
import {
  StudioMountInfoProvider,
  type StudioMountInfo,
} from "./mount-info-context.js";
import { usePathname, useRouter } from "../../navigation.js";
import { AppSidebar } from "../../components/layout/app-sidebar.js";
import {
  AssistantProvider,
  type AssistantProviderProps,
} from "../../components/assistant/assistant-context.js";
import {
  AssistantRail,
  useAssistantMainPadding,
  useAssistantMainPaddingStyle,
} from "../../components/assistant/assistant-rail.js";
import { useAssistant } from "../../components/assistant/assistant-context.js";
import { cn } from "../../lib/utils.js";
import {
  createStudioAiRouteApi,
  type StudioAiRouteApi,
} from "../../../ai-route-api.js";
import { createStudioComponentReferences } from "../../../component-reference-renderer.js";
import { createStudioSchemaRouteApi } from "../../../schema-route-api.js";

type AdminLayoutCapabilitiesLoadInput = {
  config: {
    project: string;
    environment: string;
    serverUrl: string;
  };
  auth: StudioMountContext["auth"];
};

type AdminLayoutSessionLoadInput = {
  config: { serverUrl: string };
  auth: StudioMountContext["auth"];
};

type AdminLayoutTokenErrorState = Extract<
  StudioSessionState,
  { status: "token-error" }
>;

const ADMIN_SIDEBAR_STORAGE_KEY = "sidebar-collapsed";
const DOCUMENT_EDITOR_ADMIN_SIDEBAR_STORAGE_KEY =
  "sidebar-collapsed:document-editor";

export function isDocumentEditorPathname(
  pathname: string,
  basePath?: string,
): boolean {
  const routePath = stripStudioBasePath(pathname, basePath);
  const adminRelativePath = routePath.startsWith("/admin/")
    ? routePath.slice("/admin".length)
    : routePath;
  const segments = adminRelativePath.split("/").filter(Boolean);

  return segments[0] === "content" && segments.length >= 3;
}

export function getDefaultAdminSidebarCollapsed(
  pathname: string,
  basePath?: string,
): boolean {
  return isDocumentEditorPathname(pathname, basePath);
}

export function getAdminSidebarStorageKey(
  pathname: string,
  basePath?: string,
): string {
  return isDocumentEditorPathname(pathname, basePath)
    ? DOCUMENT_EDITOR_ADMIN_SIDEBAR_STORAGE_KEY
    : ADMIN_SIDEBAR_STORAGE_KEY;
}

function stripStudioBasePath(pathname: string, basePath?: string): string {
  const normalizedPathname = normalizePathname(pathname);
  const normalizedBasePath = normalizePathname(basePath ?? "");

  if (
    normalizedBasePath !== "/" &&
    (normalizedPathname === normalizedBasePath ||
      normalizedPathname.startsWith(`${normalizedBasePath}/`))
  ) {
    return normalizedPathname.slice(normalizedBasePath.length) || "/";
  }

  return normalizedPathname;
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/";
}

export function createAdminLayoutCapabilitiesLoadInput(
  context: StudioMountContext,
): AdminLayoutCapabilitiesLoadInput | null {
  const route = context.documentRoute;

  if (!route || (context.auth.mode === "token" && !context.auth.token)) {
    return null;
  }

  return {
    config: {
      project: route.project,
      environment: route.initialEnvironment,
      serverUrl: context.apiBaseUrl,
    },
    auth: context.auth,
  };
}

export function createAdminLayoutSessionLoadInput(
  context: StudioMountContext,
): AdminLayoutSessionLoadInput {
  return {
    config: { serverUrl: context.apiBaseUrl },
    auth: context.auth,
  };
}

export function createAdminLayoutTokenSessionState(
  auth: StudioMountContext["auth"],
): StudioSessionState | null {
  if (auth.mode !== "token") {
    return null;
  }

  if (!auth.token) {
    return {
      status: "token-error",
      reason: "missing",
      message:
        'No bearer token was provided. The host application must supply a token when using auth.mode = "token".',
    };
  }

  return {
    status: "authenticated",
    session: {
      id: "token-auth-session",
      userId: "token-auth-user",
      email: "API token",
      issuedAt: "",
      expiresAt: "",
    },
    csrfToken: "",
  };
}

export function createAdminLayoutTokenErrorState(
  statusCode: number | null,
): AdminLayoutTokenErrorState | null {
  if (statusCode === 401) {
    return {
      status: "token-error",
      reason: "invalid",
      message: "The bearer token is invalid, expired, or has been revoked.",
    };
  }

  if (statusCode === 403) {
    return {
      status: "token-error",
      reason: "forbidden",
      message:
        "The bearer token is not allowed for the requested project or environment.",
    };
  }

  return null;
}

export function resolveAdminLayoutLoginRedirectPath(input: {
  sessionState: StudioSessionState;
  isTokenMode: boolean;
  pathname: string;
}): string | null {
  if (input.isTokenMode) {
    return null;
  }

  if (
    input.sessionState.status !== "unauthenticated" &&
    input.sessionState.status !== "error"
  ) {
    return null;
  }

  const returnTo = encodeURIComponent(
    input.pathname.includes("/admin") ? input.pathname : "/admin",
  );

  return `/admin/login?returnTo=${returnTo}`;
}

export function shouldRefetchAdminLayoutSessionOnResume(input: {
  sessionState: StudioSessionState;
  isTokenMode: boolean;
}): boolean {
  return !input.isTokenMode && input.sessionState.status === "authenticated";
}

type AdminLayoutSessionResumeWindowTarget = {
  addEventListener: (event: "focus", handler: () => void) => void;
  removeEventListener: (event: "focus", handler: () => void) => void;
};

type AdminLayoutSessionResumeDocumentTarget = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (event: "visibilitychange", handler: () => void) => void;
  removeEventListener: (event: "visibilitychange", handler: () => void) => void;
};

export function registerAdminLayoutSessionResumeRefetch(input: {
  windowTarget: AdminLayoutSessionResumeWindowTarget;
  documentTarget: AdminLayoutSessionResumeDocumentTarget;
  refetchSession: () => void;
}): () => void {
  const refetchVisibleSession = () => {
    if (input.documentTarget.visibilityState === "visible") {
      input.refetchSession();
    }
  };

  input.windowTarget.addEventListener("focus", input.refetchSession);
  input.documentTarget.addEventListener(
    "visibilitychange",
    refetchVisibleSession,
  );

  return () => {
    input.windowTarget.removeEventListener("focus", input.refetchSession);
    input.documentTarget.removeEventListener(
      "visibilitychange",
      refetchVisibleSession,
    );
  };
}

export function AdminTokenErrorStateView({
  state,
  context,
  activeEnvironment,
}: {
  state: AdminLayoutTokenErrorState;
  context: StudioMountContext;
  activeEnvironment: string | null;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="max-w-md w-full rounded-xl border border-border bg-card p-8 shadow-sm space-y-4">
        <div className="space-y-1 text-center">
          <p className="text-sm font-medium text-foreground">
            Token authentication failed
          </p>
          <p className="text-sm text-foreground-muted">
            Studio is configured for token-based authentication (
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              auth.mode = &quot;token&quot;
            </code>
            ) but the supplied token could not be used.
          </p>
        </div>

        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </div>

        <div className="rounded-md bg-muted px-3 py-2 text-xs text-foreground-muted space-y-1">
          <p>
            <span className="font-medium">Reason:</span> {state.reason}
          </p>
          <p>
            <span className="font-medium">Auth mode:</span> token
          </p>
          {context.documentRoute?.project && (
            <p>
              <span className="font-medium">Project:</span>{" "}
              {context.documentRoute.project}
            </p>
          )}
          {activeEnvironment && (
            <p>
              <span className="font-medium">Environment:</span>{" "}
              {activeEnvironment}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function extractStatusCode(error: unknown): number | null {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return null;
}

function readStoredSidebarCollapsed(
  storageKey: string,
  defaultCollapsed: boolean,
): boolean {
  if (typeof localStorage === "undefined") {
    return defaultCollapsed;
  }
  const stored = localStorage.getItem(storageKey);
  return stored !== null ? stored === "true" : defaultCollapsed;
}

export default function AdminLayout({
  children,
  context,
}: {
  children: React.ReactNode;
  context: StudioMountContext;
}) {
  const [queryClient] = useState(() => createStudioQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AdminLayoutInner context={context}>{children}</AdminLayoutInner>
    </QueryClientProvider>
  );
}

function AdminLayoutInner({
  children,
  context,
}: {
  children: React.ReactNode;
  context: StudioMountContext;
}) {
  const pathname = usePathname();
  const sidebarStorageKey = getAdminSidebarStorageKey(
    pathname,
    context.basePath,
  );
  const sidebarDefaultCollapsed = getDefaultAdminSidebarCollapsed(
    pathname,
    context.basePath,
  );
  return (
    <AdminLayoutRouted
      key={sidebarStorageKey}
      context={context}
      pathname={pathname}
      sidebarStorageKey={sidebarStorageKey}
      sidebarDefaultCollapsed={sidebarDefaultCollapsed}
    >
      {children}
    </AdminLayoutRouted>
  );
}

function AdminLayoutRouted(props: {
  children: React.ReactNode;
  context: StudioMountContext;
  pathname: string;
  sidebarStorageKey: string;
  sidebarDefaultCollapsed: boolean;
}) {
  return useAdminLayoutRoutedElement(props);
}

function useAdminLayoutRoutedElement({
  children,
  context,
  pathname,
  sidebarStorageKey,
  sidebarDefaultCollapsed,
}: {
  children: React.ReactNode;
  context: StudioMountContext;
  pathname: string;
  sidebarStorageKey: string;
  sidebarDefaultCollapsed: boolean;
}) {
  const { replace } = useRouter();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStoredSidebarCollapsed(sidebarStorageKey, sidebarDefaultCollapsed),
  );
  const [activeEnvironment, setActiveEnvironmentRaw] = useState<string | null>(
    () => {
      if (typeof window !== "undefined") {
        const fromQuery = new URLSearchParams(window.location.search).get(
          "env",
        );
        if (fromQuery) return fromQuery;
      }
      return context.documentRoute?.initialEnvironment ?? null;
    },
  );

  const setActiveEnvironment = useCallback((env: string) => {
    setActiveEnvironmentRaw(env);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("env", env);
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  // Re-fetch auth-scoped studio queries when the host rotates the bearer
  // token. The token is intentionally not part of query keys (matches the
  // pattern in the other CMS-132 TanStack hooks and avoids leaking the
  // secret into React Query DevTools / telemetry), so we explicitly
  // invalidate on change to restore the pre-refactor useEffect's
  // auth.token-dep behavior.
  const queryClient = useQueryClient();
  const previousAuthTokenRef = useRef(context.auth.token);
  useEffect(() => {
    if (previousAuthTokenRef.current === context.auth.token) return;
    previousAuthTokenRef.current = context.auth.token;
    void queryClient.invalidateQueries({ queryKey: ["studio"] });
  }, [queryClient, context.auth.token]);

  // Capabilities
  const capabilitiesLoadInput = useMemo(() => {
    const baseLoadInput = createAdminLayoutCapabilitiesLoadInput(context);
    if (!baseLoadInput || !activeEnvironment) return null;
    return {
      ...baseLoadInput,
      config: {
        ...baseLoadInput.config,
        environment: activeEnvironment,
      },
    };
  }, [activeEnvironment, context]);

  const capabilitiesQuery = useQuery({
    queryKey: [
      "studio",
      "capabilities",
      capabilitiesLoadInput?.config.project,
      capabilitiesLoadInput?.config.environment,
      capabilitiesLoadInput?.config.serverUrl,
      capabilitiesLoadInput?.auth.mode,
    ],
    queryFn: () => {
      const api = createStudioCurrentPrincipalCapabilitiesApi(
        capabilitiesLoadInput!.config,
        { auth: capabilitiesLoadInput!.auth },
      );
      return api.get();
    },
    enabled: capabilitiesLoadInput !== null,
    // Preserve the last successful capabilities across environment switches so
    // the sidebar does not briefly flash to "no permissions" while the new
    // fetch is in flight. Matches the pre-refactor useEffect behavior that
    // only updated cap flags on resolution.
    placeholderData: keepPreviousData,
  });

  // Session
  const tokenSessionState = useMemo(
    () => createAdminLayoutTokenSessionState(context.auth),
    [context.auth],
  );
  const isTokenMode = context.auth.mode === "token";
  const sessionLoadInput = useMemo(
    () => createAdminLayoutSessionLoadInput(context),
    [context],
  );

  const sessionQuery = useQuery({
    queryKey: [
      "studio",
      "session",
      sessionLoadInput.config.serverUrl,
      sessionLoadInput.auth.mode,
    ],
    queryFn: () => {
      const api = createStudioSessionApi(sessionLoadInput.config, {
        auth: sessionLoadInput.auth,
      });
      return api.get();
    },
    enabled: !isTokenMode,
  });

  const sessionState: StudioSessionState = useMemo(() => {
    if (isTokenMode) {
      if (tokenSessionState?.status === "token-error") {
        return tokenSessionState;
      }
      const tokenErrorFromCapabilities = capabilitiesQuery.error
        ? createAdminLayoutTokenErrorState(
            extractStatusCode(capabilitiesQuery.error),
          )
        : null;
      if (tokenErrorFromCapabilities) {
        return tokenErrorFromCapabilities;
      }
      return tokenSessionState ?? { status: "loading" };
    }

    if (sessionQuery.isPending) {
      return { status: "loading" };
    }
    if (sessionQuery.error) {
      const statusCode = extractStatusCode(sessionQuery.error);
      if (statusCode === 401) {
        return { status: "unauthenticated" };
      }
      return {
        status: "error",
        message:
          sessionQuery.error instanceof Error
            ? sessionQuery.error.message
            : "Session fetch failed.",
      };
    }
    const data = sessionQuery.data!;
    return {
      status: "authenticated",
      session: data.session,
      csrfToken: data.csrfToken,
    };
  }, [
    isTokenMode,
    tokenSessionState,
    capabilitiesQuery.error,
    sessionQuery.isPending,
    sessionQuery.error,
    sessionQuery.data,
  ]);

  const shouldRefetchSessionOnResume = shouldRefetchAdminLayoutSessionOnResume({
    sessionState,
    isTokenMode,
  });

  useEffect(() => {
    if (
      !shouldRefetchSessionOnResume ||
      typeof window === "undefined" ||
      typeof document === "undefined"
    ) {
      return;
    }

    return registerAdminLayoutSessionResumeRefetch({
      windowTarget: {
        addEventListener: (event, handler) =>
          window.addEventListener(event, handler),
        removeEventListener: (event, handler) =>
          window.removeEventListener(event, handler),
      },
      documentTarget: {
        addEventListener: (event, handler) =>
          document.addEventListener(event, handler),
        removeEventListener: (event, handler) =>
          document.removeEventListener(event, handler),
        get visibilityState() {
          return document.visibilityState;
        },
      },
      refetchSession: () => {
        void sessionQuery.refetch();
      },
    });
  }, [sessionQuery.refetch, shouldRefetchSessionOnResume]);

  // Environments
  const environmentsEnabled = Boolean(
    context.documentRoute?.project && activeEnvironment,
  );
  const environmentsQuery = useQuery({
    queryKey: [
      "studio",
      "environments",
      context.documentRoute?.project,
      activeEnvironment,
      context.apiBaseUrl,
      context.auth.mode,
    ],
    queryFn: () => {
      const api = createStudioEnvironmentApi(
        {
          project: context.documentRoute!.project,
          environment: activeEnvironment!,
          serverUrl: context.apiBaseUrl,
        },
        { auth: context.auth },
      );
      return api.list();
    },
    enabled: environmentsEnabled,
    // Same rationale as capabilitiesQuery: keep the last env list during a
    // refetch so the switcher does not briefly empty out.
    placeholderData: keepPreviousData,
  });

  const capabilities = capabilitiesQuery.data?.capabilities;
  const canReadSchema = capabilities?.schema.read ?? false;
  const canCreateContent = capabilities?.content.write ?? false;
  const canPublishContent = capabilities?.content.publish ?? false;
  const canUnpublishContent = capabilities?.content.unpublish ?? false;
  const canDeleteContent = capabilities?.content.delete ?? false;
  const canManageUsers = capabilities?.users.manage ?? false;
  const canManageSettings = capabilities?.settings.manage ?? false;
  const canReadMedia = capabilities?.media.read ?? false;
  const canUploadMedia = capabilities?.media.upload ?? false;
  const canDeleteMedia = capabilities?.media.delete ?? false;

  const environments = environmentsQuery.data?.data ?? [];

  const loginRedirectPath = resolveAdminLayoutLoginRedirectPath({
    sessionState,
    isTokenMode,
    pathname,
  });

  // Token-mode embeds must never redirect to the login screen; token auth
  // failures are shown inline because the host app owns the bearer token.
  useEffect(() => {
    if (loginRedirectPath) {
      replace(loginRedirectPath);
    }
  }, [loginRedirectPath, replace]);

  const mdxCatalog = useMemo<MdxComponentCatalog>(
    () => context.mdx?.catalog ?? { components: [] },
    [context.mdx?.catalog],
  );
  const componentReferenceProvider = useMemo(
    () =>
      mdxCatalog.components.length > 0
        ? () =>
            createStudioComponentReferences({
              catalog: mdxCatalog,
              hostBridge: context.hostBridge,
            })
        : undefined,
    [context.hostBridge, mdxCatalog],
  );

  if (sessionState.status === "loading" && typeof window !== "undefined") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-foreground-muted text-sm">Loading…</div>
      </div>
    );
  }

  if (loginRedirectPath) {
    return null;
  }

  if (sessionState.status === "unauthenticated") {
    return null;
  }

  if (sessionState.status === "token-error") {
    return (
      <AdminTokenErrorStateView
        state={sessionState}
        context={context}
        activeEnvironment={activeEnvironment}
      />
    );
  }

  if (sessionState.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="max-w-md text-center space-y-2">
          <p className="text-sm font-medium text-foreground">
            Session could not be verified
          </p>
          <p className="text-sm text-foreground-muted">
            {sessionState.message}
          </p>
        </div>
      </div>
    );
  }

  const handleToggle = () => {
    const newState = !sidebarCollapsed;
    setSidebarCollapsed(newState);
    localStorage.setItem(sidebarStorageKey, String(newState));
  };

  const mountInfo = {
    project: context.documentRoute?.project ?? null,
    environment: activeEnvironment,
    setEnvironment: setActiveEnvironment,
    apiBaseUrl: context.apiBaseUrl,
    auth: context.auth,
    environments,
    hostBridge: context.hostBridge,
    supportedLocales: context.documentRoute?.supportedLocales,
  };

  // Construct the AI route client once per (project, environment, auth)
  // tuple so the assistant rail's chat / apply / reject calls share a
  // stable fetcher with the rest of the studio.
  const aiRouteApi: StudioAiRouteApi | undefined =
    context.documentRoute && activeEnvironment
      ? createStudioAiRouteApi(
          {
            project: context.documentRoute.project,
            environment: activeEnvironment,
            serverUrl: context.apiBaseUrl,
          },
          { auth: context.auth },
        )
      : undefined;

  // The assistant's apply path needs the project schemaHash even when no
  // document is open in the editor (e.g. accepting a `create_document`
  // proposal from the standalone assistant page). The fetcher hits the
  // schema list endpoint; the provider caches the result for the
  // session.
  const schemaHashFetcher: (() => Promise<string | null>) | undefined =
    context.documentRoute && activeEnvironment
      ? async () => {
          const api = createStudioSchemaRouteApi(
            {
              project: context.documentRoute!.project,
              environment: activeEnvironment!,
              serverUrl: context.apiBaseUrl,
            },
            { auth: context.auth },
          );
          const response = await api.list();
          return response.schemaHash ?? null;
        }
      : undefined;
  const permissions = {
    canReadSchema,
    canCreateContent,
    canPublishContent,
    canUnpublishContent,
    canDeleteContent,
    canManageUsers,
    canManageSettings,
    canReadMedia,
    canUploadMedia,
    canDeleteMedia,
  };

  return (
    <AdminLayoutShell
      activeEnvironment={activeEnvironment}
      aiRouteApi={aiRouteApi}
      componentReferenceProvider={componentReferenceProvider}
      context={context}
      handleToggle={handleToggle}
      mdxCatalog={mdxCatalog}
      mountInfo={mountInfo}
      permissions={permissions}
      schemaHashFetcher={schemaHashFetcher}
      sessionState={sessionState}
      sidebarCollapsed={sidebarCollapsed}
    >
      {children}
    </AdminLayoutShell>
  );
}

function AdminLayoutShell({
  activeEnvironment,
  aiRouteApi,
  children,
  componentReferenceProvider,
  context,
  handleToggle,
  mdxCatalog,
  mountInfo,
  permissions,
  schemaHashFetcher,
  sessionState,
  sidebarCollapsed,
}: {
  activeEnvironment: string | null;
  aiRouteApi: StudioAiRouteApi | undefined;
  children: React.ReactNode;
  componentReferenceProvider: AssistantProviderProps["componentReferenceProvider"];
  context: StudioMountContext;
  handleToggle: () => void;
  mdxCatalog: MdxComponentCatalog;
  mountInfo: StudioMountInfo;
  permissions: {
    canReadSchema: boolean;
    canCreateContent: boolean;
    canPublishContent: boolean;
    canUnpublishContent: boolean;
    canDeleteContent: boolean;
    canManageUsers: boolean;
    canManageSettings: boolean;
    canReadMedia: boolean;
    canUploadMedia: boolean;
    canDeleteMedia: boolean;
  };
  schemaHashFetcher: (() => Promise<string | null>) | undefined;
  sessionState: StudioSessionState;
  sidebarCollapsed: boolean;
}) {
  return (
    <ToastProvider>
      <AssistantProvider
        api={aiRouteApi}
        schemaHashFetcher={schemaHashFetcher}
        mdxCatalog={mdxCatalog}
        componentReferenceProvider={componentReferenceProvider}
        storageKey={
          context.documentRoute && activeEnvironment
            ? `mdcms-assistant-v1:${context.documentRoute.project}:${activeEnvironment}`
            : undefined
        }
      >
        <div className="min-h-screen overflow-x-hidden bg-background">
          <AdminCapabilitiesProvider value={permissions}>
            <StudioSessionProvider value={sessionState}>
              <StudioMountInfoProvider value={mountInfo}>
                <AppSidebar
                  canReadSchema={permissions.canReadSchema}
                  canManageUsers={permissions.canManageUsers}
                  canManageSettings={permissions.canManageSettings}
                  collapsed={sidebarCollapsed}
                  onToggle={handleToggle}
                />
                <AdminMain sidebarCollapsed={sidebarCollapsed}>
                  {children}
                </AdminMain>
                <AssistantRail sidebarCollapsed={sidebarCollapsed} />
              </StudioMountInfoProvider>
            </StudioSessionProvider>
          </AdminCapabilitiesProvider>
        </div>
      </AssistantProvider>
    </ToastProvider>
  );
}

/**
 * <main> element split out so it can subscribe to the assistant rail
 * state and reserve right padding while the rail is docked.
 */
function AdminMain({
  children,
  sidebarCollapsed,
}: {
  children: ReactNode;
  sidebarCollapsed: boolean;
}) {
  const assistantPadding = useAssistantMainPadding();
  const assistantPaddingStyle = useAssistantMainPaddingStyle();
  const assistant = useAssistant();
  // While the rail is in fullscreen mode, hide the editor entirely so
  // the rail can take over the page without dual-scroll glitches.
  const fullscreenHidden = assistant.isFullscreen;
  return (
    <main
      className={cn(
        "min-h-screen min-w-0 overflow-x-hidden transition-all duration-300",
        sidebarCollapsed ? "ml-16" : "ml-60",
        assistantPadding,
        fullscreenHidden && "invisible",
      )}
      style={assistantPaddingStyle}
      aria-hidden={fullscreenHidden ? true : undefined}
    >
      {children}
    </main>
  );
}
