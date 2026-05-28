import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ThemeProvider } from "../../adapters/next-themes.js";
import { ToastProvider } from "../../components/toast.js";
import { StudioNavigationProvider } from "../../navigation.js";
import {
  AdminCapabilitiesProvider,
  type AdminCapabilitiesValue,
} from "./capabilities-context.js";
import { StudioMountInfoProvider } from "./mount-info-context.js";
import { StudioSessionProvider } from "./session-context.js";
import UsersPage from "./users-page.js";
import {
  canUseOwnerProtectedAction,
  createGrantInput,
  createUpdatedGrants,
  getHighestRole,
  getScopeDisplay,
} from "./users-page-model.js";
import type { PendingInvite, UserWithGrants } from "../../../users-api.js";

const API_BASE_URL = "https://api.example.com";

const ownerUser: UserWithGrants = {
  id: "user-owner",
  name: "Maciej K.",
  email: "maciej@example.com",
  image: null,
  createdAt: "2025-09-04T10:00:00Z",
  grants: [
    {
      id: "grant-owner",
      role: "owner",
      scopeKind: "global",
      project: null,
      environment: null,
      pathPrefix: null,
      createdAt: "2025-09-04T10:00:00Z",
    },
  ],
};

const folderScopedEditor: UserWithGrants = {
  id: "user-editor",
  name: "Lena R.",
  email: "lena@example.com",
  image: null,
  createdAt: "2026-02-08T11:00:00Z",
  grants: [
    {
      id: "grant-editor-blog",
      role: "editor",
      scopeKind: "folder_prefix",
      project: "test-project",
      environment: "production",
      pathPrefix: "content/blog",
      createdAt: "2026-02-08T11:00:00Z",
    },
    {
      id: "grant-viewer-docs",
      role: "viewer",
      scopeKind: "folder_prefix",
      project: "test-project",
      environment: "production",
      pathPrefix: "content/docs",
      createdAt: "2026-02-08T11:00:00Z",
    },
  ],
};

const pendingViewerInvite: PendingInvite = {
  id: "invite-viewer",
  email: "noor@example.com",
  createdAt: "2026-05-28T00:00:00Z",
  expiresAt: "2026-05-31T00:00:00Z",
  grants: [
    {
      role: "viewer",
      scopeKind: "folder_prefix",
      project: "test-project",
      environment: "production",
      pathPrefix: "content/blog",
    },
  ],
};

function renderUsersPage(input: {
  capabilities?: Partial<AdminCapabilitiesValue>;
  users?: UserWithGrants[];
  pendingInvites?: PendingInvite[];
}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  if (input.users) {
    queryClient.setQueryData(["users", API_BASE_URL], input.users);
  }
  if (input.pendingInvites) {
    queryClient.setQueryData(["invites", API_BASE_URL], input.pendingInvites);
  }

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ThemeProvider,
        null,
        createElement(
          StudioNavigationProvider,
          {
            value: {
              pathname: "/admin/users",
              params: {},
              basePath: "/admin",
              push: () => {},
              replace: () => {},
              back: () => {},
            },
          },
          createElement(
            AdminCapabilitiesProvider,
            {
              value: {
                canReadSchema: true,
                canCreateContent: false,
                canPublishContent: false,
                canUnpublishContent: false,
                canDeleteContent: false,
                canManageUsers: false,
                canManageSettings: false,
                ...input.capabilities,
              },
            },
            createElement(
              StudioMountInfoProvider,
              {
                value: {
                  project: "test-project",
                  environment: "production",
                  apiBaseUrl: API_BASE_URL,
                  auth: { mode: "cookie" as const },
                  environments: [],
                  hostBridge: null,
                  setEnvironment: () => {},
                },
              },
              createElement(
                StudioSessionProvider,
                {
                  value: {
                    status: "authenticated" as const,
                    session: {
                      id: "sess-1",
                      userId: "user-1",
                      email: "test@example.com",
                      issuedAt: new Date().toISOString(),
                      expiresAt: new Date(Date.now() + 86400000).toISOString(),
                    },
                    csrfToken: "test-csrf-token",
                  },
                },
                createElement(ToastProvider, null, createElement(UsersPage)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

test("UsersPage shows access denied when canManageUsers is false", () => {
  const markup = renderUsersPage({ capabilities: { canManageUsers: false } });
  assert.match(markup, /Access denied/);
  assert.doesNotMatch(markup, /Invite user/);
});

test("UsersPage renders user management when canManageUsers is true", () => {
  const markup = renderUsersPage({ capabilities: { canManageUsers: true } });
  assert.match(markup, /Invite user/);
  assert.doesNotMatch(markup, /Access denied/);
});

test("UsersPage does not render a Last Active column", () => {
  const markup = renderUsersPage({ capabilities: { canManageUsers: true } });
  assert.doesNotMatch(markup, /Last Active/);
});

test("UsersPage renders the redesigned members and invitations layout", () => {
  const markup = renderUsersPage({
    capabilities: { canManageUsers: true },
    users: [ownerUser, folderScopedEditor],
    pendingInvites: [pendingViewerInvite],
  });

  assert.match(markup, /2 members/);
  assert.match(markup, /1 pending invitation/);
  assert.match(markup, /scoped to test-project/);
  assert.match(markup, /Awaiting acceptance/);
  assert.match(markup, /Pending invitations/);
  assert.match(markup, /noor@example.com/);
  assert.match(markup, /Active members/);
  assert.match(markup, /2 entries/);
  assert.match(markup, /Maciej K\./);
  assert.match(markup, /Owner/);
  assert.match(markup, /content\/blog \+1/);
  assert.match(markup, /Full project/);
  assert.doesNotMatch(markup, /Last Active/);
});

test("getHighestRole ranks owner above all other grants", () => {
  assert.equal(getHighestRole(folderScopedEditor.grants), "editor");
  assert.equal(
    getHighestRole([...folderScopedEditor.grants, ownerUser.grants[0]!]),
    "owner",
  );
});

test("getScopeDisplay summarizes folder-prefix grants truthfully", () => {
  assert.deepEqual(getScopeDisplay(ownerUser.grants), {
    label: "Full project",
    variant: "full",
  });
  assert.deepEqual(getScopeDisplay(folderScopedEditor.grants), {
    label: "content/blog +1",
    variant: "folder",
    title: "content/blog, content/docs",
  });
});

test("createGrantInput maps invite form values to project and folder-prefix scopes", () => {
  assert.deepEqual(
    createGrantInput({
      role: "viewer",
      pathPrefix: "",
      activeProject: "test-project",
      activeEnvironment: "production",
    }),
    {
      role: "viewer",
      scopeKind: "project",
      project: "test-project",
    },
  );

  assert.deepEqual(
    createGrantInput({
      role: "editor",
      pathPrefix: " content/blog ",
      activeProject: "test-project",
      activeEnvironment: "production",
    }),
    {
      role: "editor",
      scopeKind: "folder_prefix",
      project: "test-project",
      environment: "production",
      pathPrefix: "content/blog",
    },
  );
});

test("createUpdatedGrants supports owner role assignment and preserves secondary grants", () => {
  assert.deepEqual(
    createUpdatedGrants({
      role: "owner",
      pathPrefix: "",
      currentGrants: folderScopedEditor.grants,
      activeProject: "test-project",
      activeEnvironment: "production",
    }),
    [
      {
        role: "owner",
        scopeKind: "global",
      },
      {
        role: "viewer",
        scopeKind: "folder_prefix",
        project: "test-project",
        environment: "production",
        pathPrefix: "content/docs",
      },
    ],
  );
});

test("canUseOwnerProtectedAction blocks owner row mutations", () => {
  assert.equal(canUseOwnerProtectedAction("owner"), false);
  assert.equal(canUseOwnerProtectedAction("admin"), true);
  assert.equal(canUseOwnerProtectedAction("editor"), true);
  assert.equal(canUseOwnerProtectedAction("viewer"), true);
});
