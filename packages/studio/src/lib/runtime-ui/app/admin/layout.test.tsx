import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import {
  AdminCapabilitiesProvider,
  useAdminCapabilities,
  useCanReadMedia,
} from "./capabilities-context.js";
import {
  AdminTokenErrorStateView,
  createAdminLayoutCapabilitiesLoadInput,
  createAdminLayoutSessionLoadInput,
  createAdminLayoutTokenErrorState,
  createAdminLayoutTokenSessionState,
  getDefaultAdminSidebarCollapsed,
  getAdminSidebarStorageKey,
  isDocumentEditorPathname,
  registerAdminLayoutSessionResumeRefetch,
  resolveAdminLayoutLoginRedirectPath,
  shouldRefetchAdminLayoutSessionOnResume,
} from "./layout.js";

function CapabilitiesProbe() {
  const capabilities = useAdminCapabilities();
  const canReadMedia = useCanReadMedia();

  return createElement(
    "pre",
    null,
    JSON.stringify({ ...capabilities, hookCanReadMedia: canReadMedia }),
  );
}

function parseProbeMarkup(markup: string): Record<string, unknown> {
  const json = markup
    .replace(/^<pre>/, "")
    .replace(/<\/pre>$/, "")
    .replace(/&quot;/g, '"');

  return JSON.parse(json) as Record<string, unknown>;
}

function createContext(): StudioMountContext {
  return {
    apiBaseUrl: "http://localhost:4000",
    basePath: "/admin",
    auth: { mode: "cookie" },
    hostBridge: {
      version: "1",
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  };
}

test("createAdminLayoutCapabilitiesLoadInput maps the mounted project and environment", () => {
  assert.deepEqual(createAdminLayoutCapabilitiesLoadInput(createContext()), {
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "http://localhost:4000",
    },
    auth: { mode: "cookie" },
  });
});

test("AdminCapabilitiesProvider exposes media capability defaults and mapped values", () => {
  const defaultValues = parseProbeMarkup(
    renderToStaticMarkup(createElement(CapabilitiesProbe)),
  );
  assert.equal(defaultValues.canReadMedia, false);
  assert.equal(defaultValues.canUploadMedia, false);
  assert.equal(defaultValues.canDeleteMedia, false);
  assert.equal(defaultValues.hookCanReadMedia, false);

  const mappedValues = parseProbeMarkup(
    renderToStaticMarkup(
      createElement(
        AdminCapabilitiesProvider,
        {
          value: {
            canReadSchema: true,
            canCreateContent: true,
            canPublishContent: false,
            canUnpublishContent: false,
            canDeleteContent: false,
            canManageUsers: false,
            canManageSettings: false,
            canReadMedia: true,
            canUploadMedia: true,
            canDeleteMedia: false,
          },
        },
        createElement(CapabilitiesProbe),
      ),
    ),
  );

  assert.equal(mappedValues.canReadMedia, true);
  assert.equal(mappedValues.canUploadMedia, true);
  assert.equal(mappedValues.canDeleteMedia, false);
  assert.equal(mappedValues.hookCanReadMedia, true);

  const undefinedValues = parseProbeMarkup(
    renderToStaticMarkup(
      createElement(
        AdminCapabilitiesProvider,
        {
          value: {
            canReadMedia: undefined,
            canUploadMedia: undefined,
            canDeleteMedia: undefined,
          },
        },
        createElement(CapabilitiesProbe),
      ),
    ),
  );

  assert.equal(undefinedValues.canReadMedia, false);
  assert.equal(undefinedValues.canUploadMedia, false);
  assert.equal(undefinedValues.canDeleteMedia, false);
  assert.equal(undefinedValues.hookCanReadMedia, false);
});

test("createAdminLayoutCapabilitiesLoadInput returns null without an active document route", () => {
  const context = createContext();
  delete context.documentRoute;

  assert.equal(createAdminLayoutCapabilitiesLoadInput(context), null);
});

test("createAdminLayoutCapabilitiesLoadInput returns null for token auth without a token", () => {
  const context = createContext();
  context.auth = { mode: "token" };

  assert.equal(createAdminLayoutCapabilitiesLoadInput(context), null);
});

test("createAdminLayoutSessionLoadInput maps the server URL and auth", () => {
  assert.deepEqual(createAdminLayoutSessionLoadInput(createContext()), {
    config: { serverUrl: "http://localhost:4000" },
    auth: { mode: "cookie" },
  });
});

test("createAdminLayoutTokenSessionState returns an authenticated shell session for token auth", () => {
  const context = createContext();
  context.auth = { mode: "token", token: "mdcms_key_test" };

  assert.deepEqual(createAdminLayoutTokenSessionState(context.auth), {
    status: "authenticated",
    session: {
      id: "token-auth-session",
      userId: "token-auth-user",
      email: "API token",
      issuedAt: "",
      expiresAt: "",
    },
    csrfToken: "",
  });
});

test("createAdminLayoutTokenSessionState returns null for cookie auth", () => {
  assert.equal(createAdminLayoutTokenSessionState(createContext().auth), null);
});

test("createAdminLayoutTokenSessionState returns token-error for token auth with missing token", () => {
  const context = createContext();
  context.auth = { mode: "token", token: "" };

  const result = createAdminLayoutTokenSessionState(context.auth);
  assert.equal(result?.status, "token-error");
  assert.equal(
    result && "reason" in result ? result.reason : undefined,
    "missing",
  );
});

test("createAdminLayoutTokenSessionState returns token-error when token is undefined in token mode", () => {
  const result = createAdminLayoutTokenSessionState({
    mode: "token",
  } as StudioMountContext["auth"]);
  assert.equal(result?.status, "token-error");
  assert.equal(
    result && "reason" in result ? result.reason : undefined,
    "missing",
  );
});

test("document editor routes use a focused collapsed app sidebar default", () => {
  assert.equal(
    isDocumentEditorPathname("/admin/content/page/home", "/admin"),
    true,
  );
  assert.equal(
    isDocumentEditorPathname(
      "/review/editor/admin/content/page/home",
      "/review/editor/admin",
    ),
    true,
  );
  assert.equal(isDocumentEditorPathname("/admin/content", "/admin"), false);
  assert.equal(
    isDocumentEditorPathname("/admin/content/page", "/admin"),
    false,
  );

  assert.equal(
    getDefaultAdminSidebarCollapsed("/admin/content/page/home", "/admin"),
    true,
  );
  assert.equal(
    getDefaultAdminSidebarCollapsed("/admin/content", "/admin"),
    false,
  );
  assert.equal(
    getAdminSidebarStorageKey("/admin/content/page/home", "/admin"),
    "sidebar-collapsed:document-editor",
  );
  assert.equal(
    getAdminSidebarStorageKey("/admin/content", "/admin"),
    "sidebar-collapsed",
  );
});

test("createAdminLayoutTokenErrorState maps 401 to an invalid-token error", () => {
  assert.deepEqual(createAdminLayoutTokenErrorState(401), {
    status: "token-error",
    reason: "invalid",
    message: "The bearer token is invalid, expired, or has been revoked.",
  });
});

test("createAdminLayoutTokenErrorState maps 403 to a forbidden-token error", () => {
  assert.deepEqual(createAdminLayoutTokenErrorState(403), {
    status: "token-error",
    reason: "forbidden",
    message:
      "The bearer token is not allowed for the requested project or environment.",
  });
});

test("createAdminLayoutTokenErrorState ignores non-auth status codes", () => {
  assert.equal(createAdminLayoutTokenErrorState(500), null);
  assert.equal(createAdminLayoutTokenErrorState(null), null);
});

test("resolveAdminLayoutLoginRedirectPath redirects cookie session failures to login", () => {
  assert.equal(
    resolveAdminLayoutLoginRedirectPath({
      isTokenMode: false,
      pathname: "/admin/content/page/home",
      sessionState: { status: "error", message: "Failed to fetch" },
    }),
    "/admin/login?returnTo=%2Fadmin%2Fcontent%2Fpage%2Fhome",
  );
});

test("resolveAdminLayoutLoginRedirectPath preserves cookie unauthenticated redirects", () => {
  assert.equal(
    resolveAdminLayoutLoginRedirectPath({
      isTokenMode: false,
      pathname: "/admin/schema",
      sessionState: { status: "unauthenticated" },
    }),
    "/admin/login?returnTo=%2Fadmin%2Fschema",
  );
});

test("resolveAdminLayoutLoginRedirectPath keeps token auth failures inline", () => {
  assert.equal(
    resolveAdminLayoutLoginRedirectPath({
      isTokenMode: true,
      pathname: "/admin/content/page/home",
      sessionState: { status: "error", message: "Failed to fetch" },
    }),
    null,
  );
});

test("shouldRefetchAdminLayoutSessionOnResume only refetches verified cookie sessions", () => {
  assert.equal(
    shouldRefetchAdminLayoutSessionOnResume({
      isTokenMode: false,
      sessionState: {
        status: "authenticated",
        csrfToken: "csrf",
        session: {
          id: "session-1",
          userId: "user-1",
          email: "editor@example.com",
          issuedAt: "2026-06-02T10:00:00.000Z",
          expiresAt: "2026-06-02T12:00:00.000Z",
        },
      },
    }),
    true,
  );
  assert.equal(
    shouldRefetchAdminLayoutSessionOnResume({
      isTokenMode: false,
      sessionState: { status: "unauthenticated" },
    }),
    false,
  );
  assert.equal(
    shouldRefetchAdminLayoutSessionOnResume({
      isTokenMode: true,
      sessionState: {
        status: "authenticated",
        csrfToken: "",
        session: {
          id: "token-auth-session",
          userId: "token-auth-user",
          email: "API token",
          issuedAt: "",
          expiresAt: "",
        },
      },
    }),
    false,
  );
});

test("registerAdminLayoutSessionResumeRefetch refetches on resume and cleans up listeners", () => {
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  let visibilityState: DocumentVisibilityState = "hidden";
  let refetchCount = 0;
  const addListener = (
    listeners: Map<string, Set<() => void>>,
    event: string,
    handler: () => void,
  ) => {
    const handlers = listeners.get(event) ?? new Set<() => void>();
    handlers.add(handler);
    listeners.set(event, handlers);
  };
  const removeListener = (
    listeners: Map<string, Set<() => void>>,
    event: string,
    handler: () => void,
  ) => {
    listeners.get(event)?.delete(handler);
  };
  const dispatch = (listeners: Map<string, Set<() => void>>, event: string) => {
    for (const handler of listeners.get(event) ?? []) {
      handler();
    }
  };

  const unregister = registerAdminLayoutSessionResumeRefetch({
    windowTarget: {
      addEventListener: (event, handler) =>
        addListener(windowListeners, event, handler),
      removeEventListener: (event, handler) =>
        removeListener(windowListeners, event, handler),
    },
    documentTarget: {
      addEventListener: (event, handler) =>
        addListener(documentListeners, event, handler),
      removeEventListener: (event, handler) =>
        removeListener(documentListeners, event, handler),
      get visibilityState() {
        return visibilityState;
      },
    },
    refetchSession: () => {
      refetchCount += 1;
    },
  });

  dispatch(windowListeners, "focus");
  assert.equal(refetchCount, 1);

  dispatch(documentListeners, "visibilitychange");
  assert.equal(refetchCount, 1);

  visibilityState = "visible";
  dispatch(documentListeners, "visibilitychange");
  assert.equal(refetchCount, 2);

  unregister();
  dispatch(windowListeners, "focus");
  dispatch(documentListeners, "visibilitychange");
  assert.equal(refetchCount, 2);
});

test("AdminTokenErrorStateView renders retry action and technical details", () => {
  const markup = renderToStaticMarkup(
    createElement(AdminTokenErrorStateView, {
      state: {
        status: "token-error",
        reason: "missing",
        message:
          'No bearer token was provided. The host application must supply a token when using auth.mode = "token".',
      },
      context: createContext(),
      activeEnvironment: "staging",
    }),
  );

  assert.match(markup, /Token authentication failed/);
  assert.match(markup, /Retry/);
  assert.match(markup, /Reason:/);
  assert.match(markup, /missing/);
  assert.match(markup, /Auth mode:/);
  assert.match(markup, /Project:/);
  assert.match(markup, /marketing-site/);
  assert.match(markup, /Environment:/);
  assert.match(markup, /staging/);
  assert.match(markup, /auth.mode = &quot;token&quot;/);
});
