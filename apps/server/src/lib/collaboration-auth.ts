import { RuntimeError } from "@mdcms/shared";
import { z } from "zod";

import type {
  AuthService,
  AuthorizedRequest,
  SessionPrincipal,
} from "./auth.js";

const CollaborationQuerySchema = z.object({
  project: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  documentId: z.string().uuid(),
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

/**
 * Loopback origins implicitly trusted for the collaboration handshake
 * when running outside production. Production deployments must rely on
 * an explicit `MDCMS_COLLAB_ALLOWED_ORIGINS` allowlist so the dev-time
 * convenience never leaks into a deployed environment.
 */
const COLLAB_LOOPBACK_DEV_ORIGINS = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
] as const;

export function resolveCollaborationAllowedOrigins(
  env: NodeJS.ProcessEnv,
): string[] {
  const configured = env.MDCMS_COLLAB_ALLOWED_ORIGINS ?? "";
  const origins = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const fallback = env.MDCMS_SERVER_URL
    ? [new URL(env.MDCMS_SERVER_URL).origin]
    : [];
  const includeLoopback = env.NODE_ENV !== "production";

  return [
    ...new Set([
      ...origins,
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
  revalidateWrite: (
    request: Request,
    context: CollaborationSessionContext,
  ) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
} {
  const allowedOrigins = new Set(options.allowedOrigins);

  async function authorizeDraftReadAndWrite(input: {
    request: Request;
    project: string;
    environment: string;
    documentPath: string;
  }): Promise<AuthorizedRequest> {
    const readAuthorized = await options.authService.authorizeRequest(
      input.request,
      {
        requiredScope: "content:read:draft",
        project: input.project,
        environment: input.environment,
        documentPath: input.documentPath,
      },
    );

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

  return {
    authorizeHandshake,
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

  collabApp.get?.("/api/v1/collaboration", async ({ request }: any) => {
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
  });
}
