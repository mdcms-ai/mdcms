import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ActionCatalogItem, StudioMountContext } from "@mdcms/shared";
import { createMdxAutoFormFields } from "@mdcms/shared/mdx/auto-form";

import {
  createStudioActionCatalogAdapter,
  type StudioActionCatalogAdapter,
} from "./action-catalog-adapter.js";
import AdminLayout from "./runtime-ui/app/admin/layout.js";
import ApiPlaygroundPage from "./runtime-ui/app/admin/api-page.js";
import DashboardPage from "./runtime-ui/app/admin/page.js";
import EnvironmentsPage from "./runtime-ui/app/admin/environments-page.js";
import MediaPage from "./runtime-ui/app/admin/media-page.js";
import ContentDocumentPage from "./runtime-ui/pages/content-document-page.js";
import ContentPage from "./runtime-ui/pages/content-page.js";
import ContentTypePage from "./runtime-ui/app/admin/content/[type]/page.js";
import SchemaPage from "./runtime-ui/app/admin/schema-page.js";
import SettingsPage from "./runtime-ui/app/admin/settings-page.js";
import TrashPage from "./runtime-ui/app/admin/trash-page.js";
import UsersPage from "./runtime-ui/app/admin/users-page.js";
import WorkflowsPage from "./runtime-ui/app/admin/workflows-page.js";
import InviteAcceptPage from "./runtime-ui/app/invite/invite-accept-page.js";
import LoginPage from "./runtime-ui/app/admin/login-page.js";
import { StudioSessionProvider } from "./runtime-ui/app/admin/session-context.js";
import { StudioMountInfoProvider } from "./runtime-ui/app/admin/mount-info-context.js";
import { ThemeProvider } from "./runtime-ui/adapters/next-themes.js";
import { StudioNavigationProvider } from "./runtime-ui/navigation.js";
import {
  extractStudioRouteParams,
  matchStudioRoute,
  startDocumentPreview,
  stripStudioBasePath,
  type MatchableRoute,
} from "./remote-studio-routing.js";

type StudioRuntimeRouteDefinition = MatchableRoute & {
  render: (context: StudioMountContext) => ReactNode;
};

const RUNTIME_ROUTES: readonly StudioRuntimeRouteDefinition[] = [
  {
    id: "login",
    path: "/login",
    render: () => <LoginPage />,
  },
  {
    id: "invite.accept",
    path: "/invite/:token",
    render: (context) => <InviteAcceptPage serverUrl={context.apiBaseUrl} />,
  },
  {
    id: "dashboard",
    path: "/",
    render: () => <DashboardPage />,
  },
  {
    id: "content.index",
    path: "/content",
    render: (context) => <ContentPage context={context} />,
  },
  {
    id: "content.type",
    path: "/content/:type",
    render: () => <ContentTypePage />,
  },
  {
    id: "content.document",
    path: "/content/:type/:documentId",
    render: (context) => <ContentDocumentPage context={context} />,
  },
  {
    id: "environments",
    path: "/environments",
    render: () => <EnvironmentsPage />,
  },
  {
    id: "media",
    path: "/media",
    render: () => <MediaPage />,
  },
  {
    id: "schema",
    path: "/schema",
    render: () => <SchemaPage />,
  },
  {
    id: "users",
    path: "/users",
    render: () => <UsersPage />,
  },
  {
    id: "settings",
    path: "/settings",
    render: () => <SettingsPage />,
  },
  {
    id: "settings.section",
    path: "/settings/:tab",
    render: () => <SettingsPage />,
  },
  {
    id: "settings.section.detail",
    path: "/settings/:tab/:section",
    render: () => <SettingsPage />,
  },
  {
    id: "workflows",
    path: "/workflows",
    render: () => <WorkflowsPage />,
  },
  {
    id: "api",
    path: "/api",
    render: () => <ApiPlaygroundPage />,
  },
  {
    id: "trash",
    path: "/trash",
    render: () => <TrashPage />,
  },
];

type StudioActionStripState =
  | {
      status: "loading";
      actions: ActionCatalogItem[];
    }
  | {
      status: "ready";
      actions: ActionCatalogItem[];
    }
  | {
      status: "error";
      actions: ActionCatalogItem[];
    };

export type RemoteStudioAppProps = {
  context: StudioMountContext;
  initialPathname?: string;
  initialActions?: ActionCatalogItem[];
  actionCatalogAdapter?: StudioActionCatalogAdapter;
};

function renderActionButton(action: ActionCatalogItem): ReactNode {
  const label =
    action.id === "content.publish"
      ? "Publish"
      : action.studio?.label?.trim().length
        ? action.studio.label.trim()
        : action.id;

  return (
    <button key={action.id} type="button" data-mdcms-action-id={action.id}>
      {label}
    </button>
  );
}

function getRegisteredMdxComponents(
  context: StudioMountContext,
): NonNullable<StudioMountContext["mdx"]>["catalog"]["components"] {
  return context.mdx?.catalog.components ?? [];
}

function getGeneratedAutoFormFields(
  component: NonNullable<
    StudioMountContext["mdx"]
  >["catalog"]["components"][number],
) {
  return createMdxAutoFormFields(component.extractedProps, component.propHints);
}

function RouteContent({
  route,
  context,
}: {
  route: StudioRuntimeRouteDefinition | undefined;
  context: StudioMountContext;
}): ReactNode {
  if (!route) {
    return (
      <div className="p-6 text-sm text-amber-900">Unknown Studio route.</div>
    );
  }

  return route.render(context);
}

const visuallyHiddenStyles = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
} as const;

function RuntimeDocumentDiagnostics(props: {
  context: StudioMountContext;
  previewContainerRef: React.RefObject<HTMLDivElement | null>;
  actionStripState: StudioActionStripState;
}) {
  const registeredMdxComponents = getRegisteredMdxComponents(props.context);

  return (
    <div style={visuallyHiddenStyles} aria-hidden="true">
      <div
        data-mdcms-preview-surface="content.document"
        ref={props.previewContainerRef}
      />
      {registeredMdxComponents.length === 0 ? (
        <p data-mdcms-mdx-component-state="empty">
          No local MDX components registered.
        </p>
      ) : (
        registeredMdxComponents.map((component) => (
          <div key={component.name} data-mdcms-mdx-component={component.name}>
            <span>{component.name}</span>
            {component.propsEditor ? (
              <span data-mdcms-mdx-props-editor-configured={component.name}>
                Custom editor configured
              </span>
            ) : (
              (() => {
                const autoFormFields = getGeneratedAutoFormFields(component);

                return autoFormFields.length > 0 ? (
                  <>
                    <span data-mdcms-mdx-auto-form={component.name}>
                      Auto form
                    </span>
                    {autoFormFields.map((field) => (
                      <span
                        key={`${component.name}:${field.name}:${field.control}`}
                        data-mdcms-mdx-auto-control={`${component.name}:${field.name}:${field.control}`}
                      />
                    ))}
                  </>
                ) : null;
              })()
            )}
          </div>
        ))
      )}
      {props.actionStripState.status === "loading" ? (
        <p data-mdcms-action-state="loading">Loading actions…</p>
      ) : null}
      {props.actionStripState.status === "error" ? (
        <p data-mdcms-action-state="error">
          Actions are temporarily unavailable.
        </p>
      ) : null}
      {props.actionStripState.status === "ready"
        ? props.actionStripState.actions.map((action) =>
            renderActionButton(action),
          )
        : null}
    </div>
  );
}

export function RemoteStudioApp({
  context,
  initialPathname,
  initialActions,
  actionCatalogAdapter,
}: RemoteStudioAppProps) {
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined"
      ? (initialPathname ?? context.basePath)
      : window.location.pathname,
  );
  const [actionStripState, setActionStripState] =
    useState<StudioActionStripState>(
      initialActions
        ? {
            status: "ready",
            actions: initialActions,
          }
        : {
            status: "loading",
            actions: [],
          },
    );
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onPopState = () => {
      setPathname(window.location.pathname);
    };

    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (initialActions) {
      return;
    }

    let cancelled = false;
    const adapter =
      actionCatalogAdapter ??
      createStudioActionCatalogAdapter(context.apiBaseUrl, {
        auth: context.auth,
      });

    void adapter
      .list()
      .then((actions) => {
        if (cancelled) {
          return;
        }

        setActionStripState({
          status: "ready",
          actions,
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setActionStripState({
          status: "error",
          actions: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [actionCatalogAdapter, context.apiBaseUrl, context.auth, initialActions]);

  const internalPath = stripStudioBasePath(pathname, context.basePath);
  const activeRoute =
    matchStudioRoute(internalPath, RUNTIME_ROUTES) ?? RUNTIME_ROUTES[0];
  const routeParams = extractStudioRouteParams(internalPath, activeRoute);

  useEffect(() => {
    return startDocumentPreview({
      routeId: activeRoute?.id,
      container: previewContainerRef.current,
      hostBridge: context.hostBridge,
    });
  }, [activeRoute?.id, context.hostBridge]);

  const updatePathname = (href: string, mode: "push" | "replace") => {
    if (typeof window === "undefined") {
      setPathname(href);
      return;
    }

    // Preserve active environment query param across navigations
    const searchParams = new URLSearchParams(window.location.search);
    const currentEnv = searchParams.get("env");
    let resolvedHref = href;
    if (currentEnv) {
      const url = new URL(href, window.location.origin);
      if (!url.searchParams.has("env")) {
        url.searchParams.set("env", currentEnv);
      }
      resolvedHref = url.pathname + url.search + url.hash;
    }

    if (mode === "replace") {
      window.history.replaceState(null, "", resolvedHref);
    } else {
      window.history.pushState(null, "", resolvedHref);
    }

    setPathname(window.location.pathname);
  };

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <StudioNavigationProvider
        value={{
          pathname,
          params: routeParams,
          basePath: context.basePath,
          push: (href) => updatePathname(href, "push"),
          replace: (href) => updatePathname(href, "replace"),
          back: () => {
            if (typeof window !== "undefined") {
              window.history.back();
            }
          },
        }}
      >
        <section
          data-testid="mdcms-remote-studio-root"
          data-mdcms-base-path={context.basePath}
          data-mdcms-internal-path={internalPath}
          data-mdcms-active-route={activeRoute?.id ?? "unknown"}
          className="mdcms-studio-runtime"
        >
          {activeRoute?.id === "invite.accept" ? (
            <RouteContent route={activeRoute} context={context} />
          ) : activeRoute?.id === "login" ? (
            <StudioSessionProvider value={{ status: "unauthenticated" }}>
              <StudioMountInfoProvider
                value={{
                  project: context.documentRoute?.project ?? null,
                  environment:
                    context.documentRoute?.initialEnvironment ?? null,
                  setEnvironment: () => {},
                  apiBaseUrl: context.apiBaseUrl,
                  auth: context.auth,
                  environments: [],
                  hostBridge: context.hostBridge,
                }}
              >
                <RouteContent route={activeRoute} context={context} />
              </StudioMountInfoProvider>
            </StudioSessionProvider>
          ) : (
            <AdminLayout context={context}>
              <RouteContent route={activeRoute} context={context} />
              {activeRoute?.id === "content.document" ? (
                <RuntimeDocumentDiagnostics
                  context={context}
                  previewContainerRef={previewContainerRef}
                  actionStripState={actionStripState}
                />
              ) : null}
            </AdminLayout>
          )}
        </section>
      </StudioNavigationProvider>
    </ThemeProvider>
  );
}
