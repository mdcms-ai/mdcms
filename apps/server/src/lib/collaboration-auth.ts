import { createHash } from "node:crypto";

import { RuntimeError } from "@mdcms/shared";
import type {
  CollaborationPresenceUpdate,
  CollaborationPresenceUser,
} from "@mdcms/shared";
import { z } from "zod";

import type {
  AuthService,
  AuthorizationRequirement,
  AuthorizedRequest,
  SessionPrincipal,
  StudioSession,
} from "./auth.js";
import { executeWithRuntimeErrorsHandled } from "./http-utils.js";

const CollaborationQuerySchema = z.object({
  project: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  documentId: z.string().uuid(),
});

const CollaborationPresenceQuerySchema = z.object({
  project: z.string().trim().min(1),
  environment: z.string().trim().min(1),
});

export type CollaborationCloseCode = 4401 | 4403;

export type CollaborationSessionContext = {
  userId: string;
  sessionId: string;
  project: string;
  environment: string;
  documentId: string;
  documentPath: string;
  role: string;
};

export type CollaborationPresenceContext = {
  userId: string;
  sessionId: string;
  project: string;
  environment: string;
  role: string;
  label: string;
  color: string;
};

export type CollaborationHandshakeResult =
  | {
      ok: true;
      context: CollaborationSessionContext;
    }
  | {
      ok: false;
      closeCode: CollaborationCloseCode;
      message: string;
    };

export type CollaborationPresenceHandshakeResult =
  | {
      ok: true;
      context: CollaborationPresenceContext;
    }
  | {
      ok: false;
      closeCode: CollaborationCloseCode;
      message: string;
    };

export type CollaborationDocumentLocator = (input: {
  project: string;
  environment: string;
  documentId: string;
}) => Promise<{ path: string } | undefined>;

export type CreateCollaborationAuthGuardOptions = {
  authService: AuthService;
  resolveDocument: CollaborationDocumentLocator;
  allowedOrigins: readonly string[];
};

function mapAuthErrorToHandshakeFailure(error: unknown): {
  closeCode: CollaborationCloseCode;
  message: string;
} {
  if (!(error instanceof RuntimeError)) {
    throw error;
  }

  if (error.code === "UNAUTHORIZED") {
    return {
      closeCode: 4401,
      message: "A valid Studio session is required for collaboration.",
    };
  }

  return {
    closeCode: 4403,
    message:
      error.message || "Collaboration access is forbidden for this request.",
  };
}

function hasApiKeyBearerToken(authorizationHeader: string | null): boolean {
  if (!authorizationHeader) {
    return false;
  }

  const [scheme, token] = authorizationHeader.trim().split(/\s+/, 2);
  return (
    scheme?.toLowerCase() === "bearer" &&
    typeof token === "string" &&
    token.startsWith("mdcms_key_")
  );
}

function parseCollaborationQuery(request: Request): {
  project: string;
  environment: string;
  documentId: string;
} | null {
  const url = new URL(request.url);
  const parsed = CollaborationQuerySchema.safeParse({
    project: url.searchParams.get("project"),
    environment: url.searchParams.get("environment"),
    documentId: url.searchParams.get("documentId"),
  });

  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

function parseCollaborationPresenceQuery(request: Request): {
  project: string;
  environment: string;
} | null {
  const url = new URL(request.url);
  const parsed = CollaborationPresenceQuerySchema.safeParse({
    project: url.searchParams.get("project"),
    environment: url.searchParams.get("environment"),
  });

  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

function originIsAllowed(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.get("origin")?.trim();

  if (!origin) {
    return false;
  }

  return allowedOrigins.has(origin);
}

function derivePresenceLabel(session: StudioSession): string {
  const label = session.name?.trim();

  return label && label.length > 0 ? label : session.userId;
}

function derivePresenceColor(userId: string): string {
  return `#${createHash("sha256").update(userId).digest("hex").slice(0, 6)}`;
}

/**
 * Loopback origins are implicitly trusted for the collaboration handshake when
 * running outside production. Production deployments use the documented Studio
 * browser allowlist, with the collaboration-specific allowlist kept as an
 * additive override for operators that need a narrower or transitional setup.
 */
const COLLAB_LOOPBACK_DEV_ORIGINS = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
] as const;

function parseAllowedOriginList(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function resolveCollaborationAllowedOrigins(
  env: NodeJS.ProcessEnv,
): string[] {
  const studioOrigins = parseAllowedOriginList(
    env.MDCMS_STUDIO_ALLOWED_ORIGINS,
  );
  const collaborationOrigins = parseAllowedOriginList(
    env.MDCMS_COLLAB_ALLOWED_ORIGINS,
  );
  const fallback = env.MDCMS_SERVER_URL
    ? [new URL(env.MDCMS_SERVER_URL).origin]
    : [];
  const includeLoopback = env.NODE_ENV !== "production";

  return [
    ...new Set([
      ...studioOrigins,
      ...collaborationOrigins,
      ...fallback,
      ...(includeLoopback ? COLLAB_LOOPBACK_DEV_ORIGINS : []),
    ]),
  ];
}

/**
 * Collaboration auth guard implements the CMS-45 handshake policy and exposes
 * deterministic `4401` / `4403` results for socket adapters.
 */
export function createCollaborationAuthGuard(
  options: CreateCollaborationAuthGuardOptions,
): {
  authorizeHandshake: (
    request: Request,
  ) => Promise<CollaborationHandshakeResult>;
  authorizePresenceHandshake: (
    request: Request,
  ) => Promise<CollaborationPresenceHandshakeResult>;
  authorizePresenceUpdate: (
    request: Request,
    context: CollaborationPresenceContext,
    update: CollaborationPresenceUpdate,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
  filterPresenceSnapshot: (
    request: Request,
    context: CollaborationPresenceContext,
    users: CollaborationPresenceUser[],
  ) => Promise<CollaborationPresenceUser[]>;
  revalidatePublish: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
  revalidateWrite: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
} {
  const allowedOrigins = new Set(options.allowedOrigins);

  async function authorizeDraftRead(input: {
    request: Request;
    project: string;
    environment: string;
    documentPath?: string;
  }): Promise<AuthorizedRequest> {
    const requirement: AuthorizationRequirement = {
      requiredScope: "content:read:draft",
      project: input.project,
      environment: input.environment,
    };

    if (input.documentPath !== undefined) {
      requirement.documentPath = input.documentPath;
    }

    return options.authService.authorizeRequest(input.request, requirement);
  }

  async function authorizeDraftReadAndWrite(input: {
    request: Request;
    project: string;
    environment: string;
    documentPath: string;
  }): Promise<AuthorizedRequest> {
    const readAuthorized = await authorizeDraftRead(input);

    await options.authService.authorizeRequest(input.request, {
      requiredScope: "content:write",
      project: input.project,
      environment: input.environment,
      documentPath: input.documentPath,
    });

    return readAuthorized;
  }

  async function authorizeHandshake(
    request: Request,
  ): Promise<CollaborationHandshakeResult> {
    if (!originIsAllowed(request, allowedOrigins)) {
      return {
        ok: false,
        closeCode: 4403,
        message: "Origin is not allowed for collaboration.",
      };
    }

    if (hasApiKeyBearerToken(request.headers.get("authorization"))) {
      return {
        ok: false,
        closeCode: 4403,
        message: "API keys are not accepted for collaboration endpoints.",
      };
    }

    const query = parseCollaborationQuery(request);
    if (!query) {
      return {
        ok: false,
        closeCode: 4403,
        message:
          "Collaboration requires valid project, environment, and documentId query parameters.",
      };
    }

    const document = await options.resolveDocument(query);

    if (!document) {
      return {
        ok: false,
        closeCode: 4403,
        message:
          "Collaboration target document does not exist in the requested scope.",
      };
    }

    try {
      const authorized = await authorizeDraftReadAndWrite({
        request,
        project: query.project,
        environment: query.environment,
        documentPath: document.path,
      });

      if (authorized.mode !== "session") {
        return {
          ok: false,
          closeCode: 4403,
          message: "Only Studio sessions can access collaboration endpoints.",
        };
      }

      const principal = authorized.principal as SessionPrincipal;

      return {
        ok: true,
        context: {
          userId: principal.session.userId,
          sessionId: principal.session.id,
          project: query.project,
          environment: query.environment,
          documentId: query.documentId,
          documentPath: document.path,
          role: principal.role ?? "viewer",
        },
      };
    } catch (error) {
      const failure = mapAuthErrorToHandshakeFailure(error);
      return {
        ok: false,
        closeCode: failure.closeCode,
        message: failure.message,
      };
    }
  }

  async function authorizePresenceHandshake(
    request: Request,
  ): Promise<CollaborationPresenceHandshakeResult> {
    if (!originIsAllowed(request, allowedOrigins)) {
      return {
        ok: false,
        closeCode: 4403,
        message: "Origin is not allowed for collaboration.",
      };
    }

    if (hasApiKeyBearerToken(request.headers.get("authorization"))) {
      return {
        ok: false,
        closeCode: 4403,
        message: "API keys are not accepted for collaboration endpoints.",
      };
    }

    const url = new URL(request.url);
    if (url.searchParams.has("documentId")) {
      return {
        ok: false,
        closeCode: 4403,
        message:
          "Presence connections are target-scoped and must not include documentId.",
      };
    }

    const query = parseCollaborationPresenceQuery(request);
    if (!query) {
      return {
        ok: false,
        closeCode: 4403,
        message:
          "Presence collaboration requires valid project and environment query parameters.",
      };
    }

    try {
      const authorized = await authorizeDraftRead({
        request,
        project: query.project,
        environment: query.environment,
      });

      if (authorized.mode !== "session") {
        return {
          ok: false,
          closeCode: 4403,
          message: "Only Studio sessions can access collaboration endpoints.",
        };
      }

      const principal = authorized.principal as SessionPrincipal;

      return {
        ok: true,
        context: {
          userId: principal.session.userId,
          sessionId: principal.session.id,
          project: query.project,
          environment: query.environment,
          role: principal.role ?? "viewer",
          label: derivePresenceLabel(principal.session),
          color: derivePresenceColor(principal.session.userId),
        },
      };
    } catch (error) {
      const failure = mapAuthErrorToHandshakeFailure(error);
      return {
        ok: false,
        closeCode: failure.closeCode,
        message: failure.message,
      };
    }
  }

  async function authorizePresenceUpdate(
    request: Request,
    context: CollaborationPresenceContext,
    update: CollaborationPresenceUpdate,
  ): Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }> {
    try {
      const session = await options.authService.getSession(request);
      if (!session) {
        return {
          ok: false,
          closeCode: 4401,
        };
      }

      const documentId = update.documentId ?? null;

      if (!documentId) {
        if (update.mode === "edit") {
          return {
            ok: false,
            closeCode: 4403,
          };
        }

        const authorized = await authorizeDraftRead({
          request,
          project: context.project,
          environment: context.environment,
        });

        if (authorized.mode !== "session") {
          return {
            ok: false,
            closeCode: 4403,
          };
        }

        return { ok: true };
      }

      const document = await options.resolveDocument({
        project: context.project,
        environment: context.environment,
        documentId,
      });

      if (!document) {
        return {
          ok: false,
          closeCode: 4403,
        };
      }

      const authorized = await authorizeDraftRead({
        request,
        project: context.project,
        environment: context.environment,
        documentPath: document.path,
      });

      if (authorized.mode !== "session") {
        return {
          ok: false,
          closeCode: 4403,
        };
      }

      if (update.mode === "edit") {
        await options.authService.authorizeRequest(request, {
          requiredScope: "content:write",
          project: context.project,
          environment: context.environment,
          documentPath: document.path,
        });
      }

      return { ok: true };
    } catch (error) {
      const failure = mapAuthErrorToHandshakeFailure(error);
      return {
        ok: false,
        closeCode: failure.closeCode,
      };
    }
  }

  async function filterPresenceSnapshot(
    request: Request,
    context: CollaborationPresenceContext,
    users: CollaborationPresenceUser[],
  ): Promise<CollaborationPresenceUser[]> {
    try {
      const authorized = await authorizeDraftRead({
        request,
        project: context.project,
        environment: context.environment,
      });

      if (authorized.mode !== "session") {
        return [];
      }
    } catch (error) {
      if (error instanceof RuntimeError) {
        return [];
      }

      throw error;
    }

    const filtered: CollaborationPresenceUser[] = [];

    for (const user of users) {
      if (user.documentId === null) {
        filtered.push(user);
        continue;
      }

      const document = await options.resolveDocument({
        project: context.project,
        environment: context.environment,
        documentId: user.documentId,
      });

      if (!document) {
        continue;
      }

      try {
        const authorized = await authorizeDraftRead({
          request,
          project: context.project,
          environment: context.environment,
          documentPath: document.path,
        });

        if (authorized.mode === "session") {
          filtered.push(user);
        }
      } catch (error) {
        if (!(error instanceof RuntimeError)) {
          throw error;
        }
      }
    }

    return filtered;
  }

  async function revalidateWrite(
    request: Request,
    context: CollaborationSessionContext,
  ): Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }> {
    try {
      const session = await options.authService.getSession(request);
      if (!session) {
        return {
          ok: false,
          closeCode: 4401,
        };
      }

      await authorizeDraftReadAndWrite({
        request,
        project: context.project,
        environment: context.environment,
        documentPath: context.documentPath,
      });

      return { ok: true };
    } catch (error) {
      const failure = mapAuthErrorToHandshakeFailure(error);
      return {
        ok: false,
        closeCode: failure.closeCode,
      };
    }
  }

  async function revalidatePublish(
    request: Request,
    context: CollaborationSessionContext,
  ): Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }> {
    try {
      const session = await options.authService.getSession(request);
      if (!session) {
        return {
          ok: false,
          closeCode: 4401,
        };
      }

      await authorizeDraftRead({
        request,
        project: context.project,
        environment: context.environment,
        documentPath: context.documentPath,
      });
      await options.authService.authorizeRequest(request, {
        requiredScope: "content:publish",
        project: context.project,
        environment: context.environment,
        documentPath: context.documentPath,
      });

      return { ok: true };
    } catch (error) {
      const failure = mapAuthErrorToHandshakeFailure(error);
      return {
        ok: false,
        closeCode: failure.closeCode,
      };
    }
  }

  return {
    authorizeHandshake,
    authorizePresenceHandshake,
    authorizePresenceUpdate,
    filterPresenceSnapshot,
    revalidatePublish,
    revalidateWrite,
  };
}

export type MountCollaborationRoutesOptions = {
  authService: AuthService;
  resolveDocument: CollaborationDocumentLocator;
  env?: NodeJS.ProcessEnv;
  authGuard?: ReturnType<typeof createCollaborationAuthGuard>;
};

type CollaborationRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => CollaborationRouteApp;
};

export function mountCollaborationRoutes(
  app: unknown,
  options: MountCollaborationRoutesOptions,
): void {
  const collabApp = app as CollaborationRouteApp;
  const guard =
    options.authGuard ??
    createCollaborationAuthGuard({
      authService: options.authService,
      resolveDocument: options.resolveDocument,
      allowedOrigins: resolveCollaborationAllowedOrigins(
        options.env ?? process.env,
      ),
    });

  collabApp.get?.("/api/v1/collaboration", async ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const result = await guard.authorizeHandshake(request);

      if (!result.ok) {
        const status = result.closeCode === 4401 ? 401 : 403;
        throw new RuntimeError({
          code:
            result.closeCode === 4401
              ? "UNAUTHORIZED"
              : "COLLABORATION_FORBIDDEN",
          message: result.message,
          statusCode: status,
          details: {
            closeCode: result.closeCode,
          },
        });
      }

      return new Response(
        JSON.stringify({
          data: {
            status: "handshake_authorized",
            closeCodeOnSessionInvalid: 4401,
            closeCodeOnForbidden: 4403,
            context: result.context,
          },
        }),
        {
          status: 426,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }),
  );

  collabApp.get?.("/api/v1/collaboration/presence", async ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const result = await guard.authorizePresenceHandshake(request);

      if (!result.ok) {
        const status = result.closeCode === 4401 ? 401 : 403;
        throw new RuntimeError({
          code:
            result.closeCode === 4401
              ? "UNAUTHORIZED"
              : "COLLABORATION_FORBIDDEN",
          message: result.message,
          statusCode: status,
          details: {
            closeCode: result.closeCode,
          },
        });
      }

      return new Response(
        JSON.stringify({
          data: {
            status: "presence_handshake_authorized",
            closeCodeOnSessionInvalid: 4401,
            closeCodeOnForbidden: 4403,
            context: result.context,
          },
        }),
        {
          status: 426,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }),
  );
}
