import { readOAuthBody } from "./body.js";
import { mountConsentRoutes } from "./consent.js";
import {
  RuntimeError,
  assertRequestTargetRouting,
  type OAuthConnection,
} from "@mdcms/shared";
import { executeWithRuntimeErrorsHandled } from "../http-utils.js";
import { evaluatePermission } from "../rbac.js";
import { Elysia } from "elysia";
import { and, eq, isNull } from "drizzle-orm";
import {
  API_KEY_OPERATION_SCOPES,
  resolveApiKeyRbacAction,
  assertGrantsCanIssueApiKeyScopes,
  type ApiKeyOperationScope,
  type AuthService,
} from "../auth.js";
import type { DrizzleDatabase } from "../db.js";
import type { ServerEnv } from "../env.js";
import { oauthClients, oauthGrants } from "../db/schema.js";
import {
  createOAuthStore,
  OAuthError,
  type GrantCheck,
} from "./database-store.js";
import { createOAuthRateLimiter } from "./rate-limit.js";
import { parseRegistration } from "./validation.js";

export function mountOAuthRoutes(
  app: unknown,
  options: {
    db: DrizzleDatabase;
    auth: AuthService;
    env: ServerEnv;
    limiter?: ReturnType<typeof createOAuthRateLimiter>;
  },
) {
  const routes = app as Elysia;
  const origin = options.env.MDCMS_SERVER_URL;
  const resource = `${origin}/api/v1/mcp`;
  const store = createOAuthStore(options.db);
  const limiter = options.limiter ?? createOAuthRateLimiter(options.db);
  mountConsentRoutes(app, {
    db: options.db,
    auth: options.auth,
    store,
    limiter,
    resource,
    limit: options.env.MDCMS_OAUTH_AUTHORIZE_RATE_LIMIT,
  });
  const scopes = API_KEY_OPERATION_SCOPES.filter((scope) => {
    try {
      resolveApiKeyRbacAction(scope);
      return true;
    } catch {
      return false;
    }
  });
  const headers = { "cache-control": "no-store", pragma: "no-cache" };
  const check: GrantCheck = async (grant, requestedScopes, transaction) => {
    try {
      assertGrantsCanIssueApiKeyScopes(
        await options.auth.getOAuthUserGrants(grant.userId, transaction),
        requestedScopes as ApiKeyOperationScope[],
        [{ project: grant.project, environment: grant.environment }],
      );
      return true;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        [401, 403].includes(error.statusCode)
      )
        return false;
      throw error;
    }
  };
  async function connectionContext(request: Request) {
    const session = await options.auth.getSession(request);
    if (!session)
      throw new RuntimeError({
        code: "UNAUTHORIZED",
        message: "A session is required.",
        statusCode: 401,
      });
    const target = assertRequestTargetRouting(request, "project");
    const project = target.project!;
    const grants = await options.auth.getOAuthUserGrants(session.userId);
    const admin = grants.some(
      (grant) =>
        grant.scope.kind === "global" &&
        (grant.role === "admin" || grant.role === "owner"),
    );
    if (
      !evaluatePermission({
        grants,
        target: { project },
        action: "projects:read",
      }).allowed
    )
      throw new RuntimeError({
        code: "FORBIDDEN",
        message: "Project access required.",
        statusCode: 403,
      });
    return { session, project, admin };
  }
  routes.get("/api/v1/oauth/connections", ({ request }) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const context = await connectionContext(request);
      const rows = await options.db
        .select({ grant: oauthGrants, clientName: oauthClients.name })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .where(
          and(
            eq(oauthGrants.project, context.project),
            isNull(oauthGrants.revokedAt),
            context.admin
              ? undefined
              : eq(oauthGrants.userId, context.session.userId),
          ),
        );
      const data: OAuthConnection[] = rows.map(({ grant, clientName }) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName,
        userId: grant.userId,
        project: grant.project,
        environment: grant.environment,
        scopes: grant.scopes,
        createdAt: grant.createdAt.toISOString(),
        lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
      }));
      return { data };
    }),
  );
  routes.delete("/api/v1/oauth/connections/:id", ({ request, params }) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const context = await connectionContext(request);
      const csrfHeaders = new Headers(request.headers);
      csrfHeaders.delete("authorization");
      await options.auth.requireCsrfProtection(
        new Request(request.url, {
          method: request.method,
          headers: csrfHeaders,
        }),
      );
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          params.id,
        )
      )
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Connection not found.",
          statusCode: 404,
        });
      const [grant] = await options.db
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.id, params.id),
            eq(oauthGrants.project, context.project),
            context.admin
              ? undefined
              : eq(oauthGrants.userId, context.session.userId),
          ),
        );
      if (!grant)
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Connection not found.",
          statusCode: 404,
        });
      await store.revokeGrant(grant.id);
      return { data: { id: grant.id, revoked: true } };
    }),
  );
  routes.get("/.well-known/oauth-protected-resource/api/v1/mcp", () =>
    Response.json(
      {
        resource,
        authorization_servers: [origin],
        scopes_supported: scopes,
        bearer_methods_supported: ["header"],
      },
      { headers },
    ),
  );
  routes.get("/.well-known/oauth-authorization-server", () =>
    Response.json(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/api/v1/oauth/authorize`,
        token_endpoint: `${origin}/api/v1/oauth/token`,
        registration_endpoint: `${origin}/api/v1/oauth/register`,
        revocation_endpoint: `${origin}/api/v1/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: scopes,
      },
      { headers },
    ),
  );
  for (const endpoint of ["register", "token", "revoke"] as const)
    routes.post(
      `/api/v1/oauth/${endpoint}`,
      async ({ request }) => {
        try {
          const limit =
            endpoint === "register"
              ? options.env.MDCMS_OAUTH_REGISTER_RATE_LIMIT
              : endpoint === "token"
                ? options.env.MDCMS_OAUTH_TOKEN_RATE_LIMIT
                : options.env.MDCMS_OAUTH_REVOKE_RATE_LIMIT;
          await limiter.consume(endpoint, limit);
          const text = await readOAuthBody(request);
          const form = new URLSearchParams(text);
          const clientId = form.get("client_id") ?? "";
          const [client] =
            endpoint === "register"
              ? []
              : await options.db
                  .select()
                  .from(oauthClients)
                  .where(eq(oauthClients.id, clientId));
          if (client) await limiter.consume(endpoint, limit, client.id, false);
          await store.cleanup();
          if (endpoint === "register") {
            if (
              !request.headers.get("content-type")?.includes("application/json")
            )
              throw new OAuthError("invalid_client_metadata");
            let input: unknown;
            try {
              input = JSON.parse(text);
            } catch {
              throw new OAuthError("invalid_client_metadata");
            }
            const parsed = parseRegistration(input);
            const registered = await store.register(
              parsed.client_name,
              parsed.redirect_uris,
            );
            return Response.json(
              {
                client_id: registered.id,
                client_id_issued_at: Math.floor(
                  registered.createdAt.getTime() / 1000,
                ),
                client_name: registered.name,
                redirect_uris: registered.redirectUris,
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
              },
              { status: 201, headers },
            );
          }
          if (
            !request.headers
              .get("content-type")
              ?.includes("application/x-www-form-urlencoded")
          )
            throw new OAuthError("invalid_request");
          const required = (key: string) => {
            const values = form.getAll(key);
            if (values.length !== 1 || !values[0])
              throw new OAuthError("invalid_request");
            return values[0];
          };
          required("client_id");
          if (!client) throw new OAuthError("invalid_client", 401);
          if (endpoint === "revoke") {
            const hint = form.get("token_type_hint");
            if (hint && !["access_token", "refresh_token"].includes(hint))
              throw new OAuthError("invalid_request");
            await store.revokeToken(client.id, required("token"));
            return new Response(null, { status: 200, headers });
          }
          const requestedResource = required("resource");
          if (requestedResource !== resource)
            throw new OAuthError("invalid_target");
          if (form.has("project") || form.has("environment"))
            throw new OAuthError("invalid_target");
          const grantType = required("grant_type");
          if (grantType === "authorization_code") {
            const verifier = required("code_verifier");
            if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
              throw new OAuthError("invalid_request");
            return Response.json(
              await store.exchangeCode(
                {
                  clientId: client.id,
                  code: required("code"),
                  redirectUri: required("redirect_uri"),
                  verifier,
                  resource,
                },
                check,
              ),
              { headers },
            );
          }
          if (grantType === "refresh_token")
            return Response.json(
              await store.refresh(
                {
                  clientId: client.id,
                  token: required("refresh_token"),
                  resource,
                  scopes: form.has("scope")
                    ? required("scope").split(" ")
                    : undefined,
                },
                check,
              ),
              { headers },
            );
          throw new OAuthError("unsupported_grant_type");
        } catch (error) {
          const failure =
            error instanceof OAuthError
              ? error
              : new OAuthError("temporarily_unavailable", 503, 60);
          return Response.json(
            { error: failure.code },
            {
              status: failure.status,
              headers: {
                ...headers,
                ...(failure.retryAfter
                  ? { "retry-after": String(failure.retryAfter) }
                  : {}),
              },
            },
          );
        }
      },
      { parse: "none" },
    );
}
