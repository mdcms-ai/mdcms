import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  type CollaborationPresenceUpdate,
  type CollaborationPresenceUser,
  RuntimeError,
  createEmptyCurrentPrincipalCapabilities,
} from "@mdcms/shared";

import {
  createCollaborationAuthGuard,
  mountCollaborationRoutes,
} from "./collaboration-auth.js";
import type {
  ApiKeyMetadata,
  AuthService,
  AuthorizationRequirement,
  AuthorizedRequest,
  CreateApiKeyInput,
  StudioSession,
} from "./auth.js";
import { createServerRequestHandler } from "./server.js";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const UNREADABLE_DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";

function createCollaborationRequest(pathAndQuery: string, init?: RequestInit) {
  return new Request(`http://localhost${pathAndQuery}`, {
    ...init,
    headers: {
      origin: "http://localhost:4173",
      ...init?.headers,
    },
  });
}

function createSession(userId = "user-1"): StudioSession {
  return {
    id: "session-1",
    userId,
    email: `${userId}@mdcms.local`,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

function createPresenceContext() {
  return {
    userId: "editor-1",
    sessionId: "session-1",
    project: "marketing",
    environment: "staging",
    role: "editor",
    label: "editor-1",
    color: "#2563eb",
  };
}

function createPresenceUpdate(
  overrides: Partial<CollaborationPresenceUpdate> = {},
): CollaborationPresenceUpdate {
  return {
    type: "presence.update",
    documentId: DOCUMENT_ID,
    mode: "view",
    ...overrides,
  };
}

function createPresenceUser(
  overrides: Partial<CollaborationPresenceUser> = {},
): CollaborationPresenceUser {
  return {
    userId: "editor-1",
    sessionId: "session-1",
    label: "editor-1",
    color: "#2563eb",
    documentId: DOCUMENT_ID,
    mode: "view",
    updatedAt: "2026-06-14T10:00:00.000Z",
    ...overrides,
  };
}

function createAuthServiceStub(overrides: Partial<AuthService>): AuthService {
  const session = createSession();

  const stub: AuthService = {
    async login(_request, _email, _password) {
      return {
        outcome: "success",
        csrfToken: "fake",
        session,
        setCookie: "session_token=fake",
      };
    },
    async getSession() {
      return session;
    },
    async getCurrentPrincipalCapabilities() {
      return {
        project: "marketing-site",
        environment: "staging",
        capabilities: createEmptyCurrentPrincipalCapabilities(),
      };
    },
    async requireAdminSession() {
      return session;
    },
    async logout() {
      return {
        revoked: true,
      };
    },
    async signOut() {
      return new Response(null, { status: 204 });
    },
    async authorizeRequest(
      _request: Request,
      _requirement: AuthorizationRequirement,
    ): Promise<AuthorizedRequest> {
      return {
        mode: "session",
        principal: {
          type: "session",
          session,
          role: "editor",
        },
      };
    },
    async requireCsrfProtection() {
      return undefined;
    },
    issueCsrfBootstrap() {
      return {
        token: "fake",
        setCookie: "mdcms_csrf=fake",
      };
    },
    clearCsrfCookie() {
      return "mdcms_csrf=; Max-Age=0";
    },
    async createApiKey(
      _request: Request,
      _input: CreateApiKeyInput,
    ): Promise<{ key: string; metadata: ApiKeyMetadata }> {
      throw new Error("unused");
    },
    async listApiKeys() {
      return [];
    },
    async revokeApiKey() {
      throw new Error("unused");
    },
    async revokeSelfApiKey() {
      return {
        revoked: true,
        keyId: "api-key-1",
      };
    },
    async revokeAllUserSessions() {
      return 0;
    },
    async revokeAllSessionsForUserByAdmin() {
      return {
        userId: "user-1",
        revokedSessions: 0,
      };
    },
    async startSsoSignIn() {
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://localhost/oidc/authorize",
        },
      });
    },
    async handleSsoCallback() {
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://localhost/studio",
        },
      });
    },
    async handleSamlAcs() {
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://localhost/studio",
        },
      });
    },
    async handleSamlMetadata() {
      return new Response(null, { status: 200 });
    },
    async startCliLogin() {
      return {
        challengeId: "11111111-1111-4111-8111-111111111111",
        authorizeUrl:
          "http://localhost/api/v1/auth/cli/login/authorize?challenge=11111111-1111-4111-8111-111111111111&state=state-1234567890abcdef",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    async authorizeCliLogin() {
      return {
        outcome: "redirect",
        location:
          "http://127.0.0.1:45123/callback?code=code-1234567890abcdef&state=state-1234567890abcdef",
      };
    },
    async exchangeCliLogin(_input) {
      return {
        key: "mdcms_key_test",
        metadata: {
          id: "api-key-1",
          label: "cli:test",
          keyPrefix: "mdcms_key_test...",
          createdByUserId: "user-1",
          scopes: ["content:read"],
          contextAllowlist: [
            {
              project: "marketing",
              environment: "staging",
            },
          ],
          createdAt: new Date().toISOString(),
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        },
      };
    },
    async handleAuthRequest() {
      return new Response("not implemented", { status: 501 });
    },
    listSsoProviders() {
      return [];
    },
    async listUsers() {
      return [];
    },
    async getUser() {
      throw new Error("unused");
    },
    async inviteUser() {
      throw new Error("unused");
    },
    async updateUserGrants() {
      throw new Error("unused");
    },
    async removeUser() {
      return { removed: true as const };
    },
    async listInvites() {
      return [];
    },
    async revokeInvite() {
      return { revoked: true as const };
    },
    async acceptInvite() {
      return { userId: "user-1" };
    },
  };

  return {
    ...stub,
    ...overrides,
  };
}

test("collaboration handshake rejects API key auth with 4403", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({}),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizeHandshake(
    new Request(
      `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
      {
        headers: {
          origin: "http://localhost:4173",
          authorization: "Bearer mdcms_key_test",
        },
      },
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("collaboration handshake rejects missing documentId with 4403", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({}),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizeHandshake(
    createCollaborationRequest(
      "/api/v1/collaboration?project=marketing&environment=staging",
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("presence handshake accepts target-only query and returns label and color", async () => {
  const session = createSession("editor-1");
  const requiredScopes: AuthorizationRequirement[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement);
        return {
          mode: "session",
          principal: {
            type: "session",
            session,
            role: "editor",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceHandshake(
    createCollaborationRequest(
      "/api/v1/collaboration/presence?project=marketing&environment=staging",
    ),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.context.userId, "editor-1");
  assert.equal(result.context.sessionId, "session-1");
  assert.equal(result.context.project, "marketing");
  assert.equal(result.context.environment, "staging");
  assert.equal(result.context.role, "editor");
  assert.equal(result.context.label, "editor-1");
  assert.match(result.context.color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(requiredScopes, [
    {
      requiredScope: "content:read:draft",
      project: "marketing",
      environment: "staging",
    },
  ]);
});

test("presence handshake rejects URL documentId with 4403", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({}),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceHandshake(
    createCollaborationRequest(
      `/api/v1/collaboration/presence?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("presence handshake rejects API key auth with 4403", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({}),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceHandshake(
    createCollaborationRequest(
      "/api/v1/collaboration/presence?project=marketing&environment=staging",
      {
        headers: {
          authorization: "Bearer mdcms_key_test",
        },
      },
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("presence edit update checks draft-read and write permissions with document path", async () => {
  const requiredScopes: AuthorizationRequirement[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement);
        return {
          mode: "session",
          principal: {
            type: "session",
            session: createSession("editor-1"),
            role: "editor",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceUpdate(
    createCollaborationRequest("/api/v1/collaboration/presence"),
    createPresenceContext(),
    createPresenceUpdate({
      mode: "edit",
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requiredScopes, [
    {
      requiredScope: "content:read:draft",
      project: "marketing",
      environment: "staging",
      documentPath: "blog/post-1",
    },
    {
      requiredScope: "content:write",
      project: "marketing",
      environment: "staging",
      documentPath: "blog/post-1",
    },
  ]);
});

test("presence view update only checks draft-read permission with document path", async () => {
  const requiredScopes: AuthorizationRequirement[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement);
        return {
          mode: "session",
          principal: {
            type: "session",
            session: createSession("viewer-1"),
            role: "viewer",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceUpdate(
    createCollaborationRequest("/api/v1/collaboration/presence"),
    createPresenceContext(),
    createPresenceUpdate({
      mode: "view",
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requiredScopes, [
    {
      requiredScope: "content:read:draft",
      project: "marketing",
      environment: "staging",
      documentPath: "blog/post-1",
    },
  ]);
});

test("presence update maps authorization failures to 4403", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest() {
        throw new RuntimeError({
          code: "FORBIDDEN",
          message: "Denied",
          statusCode: 403,
        });
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceUpdate(
    createCollaborationRequest("/api/v1/collaboration/presence"),
    createPresenceContext(),
    createPresenceUpdate({
      mode: "edit",
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("presence update maps unauthorized revalidation failures to 4401", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest() {
        throw new RuntimeError({
          code: "UNAUTHORIZED",
          message: "Session expired",
          statusCode: 401,
        });
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizePresenceUpdate(
    createCollaborationRequest("/api/v1/collaboration/presence"),
    createPresenceContext(),
    createPresenceUpdate({
      mode: "edit",
    }),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4401);
});

test("presence snapshot filtering removes unreadable documents and keeps target-level users", async () => {
  const requiredScopes: AuthorizationRequirement[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement);
        if (requirement.documentPath === "secret/post-2") {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: "Denied",
            statusCode: 403,
          });
        }
        return {
          mode: "session",
          principal: {
            type: "session",
            session: createSession("viewer-1"),
            role: "viewer",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async ({ documentId }) => {
      if (documentId === DOCUMENT_ID) {
        return { path: "blog/post-1" };
      }
      if (documentId === UNREADABLE_DOCUMENT_ID) {
        return { path: "secret/post-2" };
      }
      return undefined;
    },
  });

  const users = [
    createPresenceUser({
      sessionId: "online",
      documentId: null,
    }),
    createPresenceUser({
      sessionId: "readable",
      documentId: DOCUMENT_ID,
    }),
    createPresenceUser({
      sessionId: "unreadable",
      documentId: UNREADABLE_DOCUMENT_ID,
    }),
  ];

  const filtered = await guard.filterPresenceSnapshot(
    createCollaborationRequest("/api/v1/collaboration/presence"),
    createPresenceContext(),
    users,
  );

  assert.deepEqual(
    filtered.map((user) => user.sessionId),
    ["online", "readable"],
  );
  assert.deepEqual(requiredScopes, [
    {
      requiredScope: "content:read:draft",
      project: "marketing",
      environment: "staging",
      documentPath: "blog/post-1",
    },
    {
      requiredScope: "content:read:draft",
      project: "marketing",
      environment: "staging",
      documentPath: "secret/post-2",
    },
  ]);
});

test("collaboration handshake maps unauthorized session failures to 4401", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest() {
        throw new RuntimeError({
          code: "UNAUTHORIZED",
          message: "No session",
          statusCode: 401,
        });
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizeHandshake(
    new Request(
      `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
      {
        headers: {
          origin: "http://localhost:4173",
        },
      },
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4401);
});

test("collaboration handshake returns session context on success", async () => {
  const session = createSession("editor-1");
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest() {
        return {
          mode: "session",
          principal: {
            type: "session",
            session,
            role: "editor",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizeHandshake(
    new Request(
      `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
      {
        headers: {
          origin: "http://localhost:4173",
        },
      },
    ),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.context.userId, "editor-1");
  assert.equal(result.context.role, "editor");
  assert.equal(result.context.documentPath, "blog/post-1");
});

test("collaboration handshake requires both draft-read and write permissions", async () => {
  const requiredScopes: string[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement.requiredScope);
        return {
          mode: "session",
          principal: {
            type: "session",
            session: createSession("editor-2"),
            role: "editor",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });

  const result = await guard.authorizeHandshake(
    new Request(
      `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
      {
        headers: {
          origin: "http://localhost:4173",
        },
      },
    ),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requiredScopes, ["content:read:draft", "content:write"]);
});

test("collaboration write revalidation closes with 4401 when session is missing", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async getSession() {
        return undefined;
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });
  const result = await guard.revalidateWrite(
    new Request("http://localhost/api/v1/collaboration", {
      headers: {
        origin: "http://localhost:4173",
      },
    }),
    {
      userId: "user-1",
      sessionId: "session-1",
      project: "marketing",
      environment: "staging",
      documentId: DOCUMENT_ID,
      documentPath: "blog/post-1",
      role: "editor",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4401);
});

test("collaboration write revalidation closes with 4403 on RBAC deny", async () => {
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest() {
        throw new RuntimeError({
          code: "FORBIDDEN",
          message: "Denied",
          statusCode: 403,
        });
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });
  const result = await guard.revalidateWrite(
    new Request("http://localhost/api/v1/collaboration", {
      headers: {
        origin: "http://localhost:4173",
      },
    }),
    {
      userId: "user-1",
      sessionId: "session-1",
      project: "marketing",
      environment: "staging",
      documentId: DOCUMENT_ID,
      documentPath: "blog/post-1",
      role: "editor",
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.closeCode, 4403);
});

test("collaboration write revalidation checks draft-read and write permissions", async () => {
  const requiredScopes: string[] = [];
  const guard = createCollaborationAuthGuard({
    authService: createAuthServiceStub({
      async authorizeRequest(_request, requirement) {
        requiredScopes.push(requirement.requiredScope);
        return {
          mode: "session",
          principal: {
            type: "session",
            session: createSession("editor-3"),
            role: "editor",
          },
        };
      },
    }),
    allowedOrigins: ["http://localhost:4173"],
    resolveDocument: async () => ({ path: "blog/post-1" }),
  });
  const result = await guard.revalidateWrite(
    new Request("http://localhost/api/v1/collaboration", {
      headers: {
        origin: "http://localhost:4173",
      },
    }),
    {
      userId: "user-1",
      sessionId: "session-1",
      project: "marketing",
      environment: "staging",
      documentId: DOCUMENT_ID,
      documentPath: "blog/post-1",
      role: "editor",
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requiredScopes, ["content:read:draft", "content:write"]);
});

test("collaboration route returns 426 after successful handshake authorization", async () => {
  const handler = createServerRequestHandler({
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "debug",
      APP_VERSION: "0.0.0",
      PORT: "4000",
      SERVICE_NAME: "mdcms-server",
      MDCMS_COLLAB_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    configureApp(app) {
      mountCollaborationRoutes(app, {
        authService: createAuthServiceStub({}),
        resolveDocument: async () => ({ path: "blog/post-1" }),
        env: {
          MDCMS_COLLAB_ALLOWED_ORIGINS: "http://localhost:4173",
        },
      });
    },
  });

  const response = await handler(
    new Request(
      `http://localhost/api/v1/collaboration?project=marketing&environment=staging&documentId=${DOCUMENT_ID}`,
      {
        headers: {
          origin: "http://localhost:4173",
        },
      },
    ),
  );

  assert.equal(response.status, 426);
});

test("collaboration presence route returns 426 after successful handshake authorization", async () => {
  const handler = createServerRequestHandler({
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "debug",
      APP_VERSION: "0.0.0",
      PORT: "4000",
      SERVICE_NAME: "mdcms-server",
      MDCMS_COLLAB_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    configureApp(app) {
      mountCollaborationRoutes(app, {
        authService: createAuthServiceStub({}),
        resolveDocument: async () => ({ path: "blog/post-1" }),
        env: {
          MDCMS_COLLAB_ALLOWED_ORIGINS: "http://localhost:4173",
        },
      });
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/collaboration/presence?project=marketing&environment=staging",
      {
        headers: {
          origin: "http://localhost:4173",
        },
      },
    ),
  );
  const body = (await response.json()) as {
    data?: {
      status?: string;
      closeCodeOnSessionInvalid?: number;
      closeCodeOnForbidden?: number;
      context?: {
        userId?: string;
        sessionId?: string;
        project?: string;
        environment?: string;
        role?: string;
        label?: string;
        color?: string;
      };
    };
  };

  assert.equal(response.status, 426);
  assert.equal(body.data?.status, "presence_handshake_authorized");
  assert.equal(body.data?.closeCodeOnSessionInvalid, 4401);
  assert.equal(body.data?.closeCodeOnForbidden, 4403);
  assert.deepEqual(body.data?.context, {
    userId: "user-1",
    sessionId: "session-1",
    project: "marketing",
    environment: "staging",
    role: "editor",
    label: "user-1",
    color: body.data?.context?.color,
  });
  assert.match(body.data?.context?.color ?? "", /^#[0-9a-f]{6}$/);
});
