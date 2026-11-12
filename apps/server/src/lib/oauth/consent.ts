import { readOAuthBody } from "./body.js";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { RuntimeError } from "@mdcms/shared";
import {
  assertGrantsCanIssueApiKeyScopes,
  type ApiKeyOperationScope,
  type AuthService,
} from "../auth.js";
import type { DrizzleDatabase } from "../db.js";
import {
  environments,
  projects,
  oauthClients,
  oauthCodes,
  oauthGrants,
} from "../db/schema.js";
import {
  hashCredential,
  OAuthError,
  type OAuthStore,
} from "./database-store.js";
import { matchesRedirect, parseAuthorization } from "./validation.js";
import type { createOAuthRateLimiter } from "./rate-limit.js";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function mountConsentRoutes(
  app: unknown,
  options: {
    db: DrizzleDatabase;
    auth: AuthService;
    store: OAuthStore;
    limiter: ReturnType<typeof createOAuthRateLimiter>;
    resource: string;
    limit: number;
  },
) {
  (app as Elysia).all(
    "/api/v1/oauth/authorize",
    async ({ request }) => {
      const nonce = randomBytes(24).toString("base64url");
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        pragma: "no-cache",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        "referrer-policy": "same-origin",
      };
      const html = (
        body: string,
        status = 200,
        extra: Record<string, string> = {},
      ) =>
        new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>MDCMS authorization</title></head><body>${body}</body></html>`,
          { status, headers: { ...headers, ...extra } },
        );
      try {
        await options.limiter.consume("authorize", options.limit);
        const body =
          request.method === "POST" ? await readOAuthBody(request) : undefined;
        await options.store.cleanup();
        const session = await options.auth.getSession(request);
        if (request.method === "POST" && session)
          await options.limiter.consume(
            "authorize",
            options.limit,
            session.userId,
            false,
          );
        if (request.method === "GET") {
          const params = new URL(request.url).searchParams;
          let handle: string;
          if (params.has("consent")) {
            if ([...params.keys()].length !== 1 || !params.get("consent"))
              throw new OAuthError("invalid_request");
            handle = params.get("consent")!;
            await options.store.readConsent(handle);
          } else {
            const input = parseAuthorization(params, options.resource);
            const [client] = await options.db
              .select()
              .from(oauthClients)
              .where(eq(oauthClients.id, input.clientId));
            if (!client) throw new OAuthError("invalid_client");
            if (
              !client.redirectUris.some((uri) =>
                matchesRedirect(uri, input.redirectUri),
              )
            )
              throw new OAuthError("invalid_request");
            handle = await options.store.createConsent(
              client.id,
              input,
              session
                ? { userId: session.userId, sessionId: session.id }
                : undefined,
            );
          }
          if (!session) {
            const continuation = `/api/v1/oauth/authorize?consent=${encodeURIComponent(handle)}`;
            return html(
              `<h1>Sign in</h1><form id="login" method="POST" action="/api/v1/auth/login"><label>Email <input name="email" type="email" required autocomplete="username"></label><label>Password <input name="password" type="password" required autocomplete="current-password"></label><button>Sign in</button></form><p id="error"></p><script nonce="${nonce}">document.getElementById('login').addEventListener('submit',async(event)=>{event.preventDefault();const values=new FormData(event.target);try{const response=await fetch('/api/v1/auth/login',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({email:values.get('email'),password:values.get('password')})});if(!response.ok){document.getElementById('error').textContent=response.status===429?'Try signing in again after the backoff period.':'Sign-in failed.';return;}location.replace(${JSON.stringify(continuation)});}catch{document.getElementById('error').textContent='Sign-in unavailable. Please try again.';}});</script>`,
            );
          }
          const consent = await options.store.bindConsent(handle, {
            userId: session.userId,
            sessionId: session.id,
          });
          if (!consent.payload) throw new OAuthError("invalid_request");
          const [client] = await options.db
            .select()
            .from(oauthClients)
            .where(eq(oauthClients.id, consent.clientId));
          if (!client) throw new OAuthError("invalid_client");
          const grants = await options.auth.getOAuthUserGrants(session.userId);
          const targets = await options.db
            .select({ project: projects.slug, environment: environments.name })
            .from(environments)
            .innerJoin(projects, eq(projects.id, environments.projectId));
          const allowed = targets
            .map((target) => {
              const granted = consent.payload!.scopes.filter((scope) => {
                try {
                  assertGrantsCanIssueApiKeyScopes(
                    grants,
                    [scope as ApiKeyOperationScope],
                    [target],
                  );
                  return true;
                } catch {
                  return false;
                }
              });
              return {
                ...target,
                granted,
                unavailable: consent.payload!.scopes.filter(
                  (scope) => !granted.includes(scope),
                ),
              };
            })
            .filter((target) => target.granted.length > 0);
          const csrf = options.auth.issueCsrfBootstrap(request);
          const form = (target?: {
            project: string;
            environment: string;
            granted: string[];
            unavailable: string[];
          }) =>
            `<form method="POST" action="/api/v1/oauth/authorize"><input type="hidden" name="consent" value="${escape(handle)}"><input type="hidden" name="csrfToken" value="${escape(csrf.token)}"><input type="hidden" name="project" value="${escape(target?.project ?? "")}"><input type="hidden" name="scope" value="${escape(target?.granted.join(" ") ?? "")}"><input type="hidden" name="environment" value="${escape(target?.environment ?? "")}">${target ? `<p>${escape(target.project)} / ${escape(target.environment)}</p><p>Granted: ${escape(target.granted.join(", "))}</p><p>Unavailable: ${escape(target.unavailable.join(", "))}</p><button name="decision" value="allow">Allow</button>` : ""}<button name="decision" value="deny">Deny</button></form>`;
          return html(
            `<h1>Authorize ${escape(client.name)} (unverified)</h1><p>Redirect: ${escape(new URL(consent.payload.redirectUri).host)}</p><p>Requested scopes: ${escape(consent.payload.scopes.join(", "))}</p>${allowed.length ? allowed.map(form).join("") : "<p>No eligible targets.</p>" + form()}`,
            200,
            {
              "set-cookie": csrf.setCookie,
              "content-security-policy": headers[
                "content-security-policy"
              ].replace(
                "form-action 'self';",
                `form-action 'self' ${new URL(consent.payload.redirectUri).origin};`,
              ),
            },
          );
        }
        if (request.method !== "POST")
          return html("<p>Method not allowed.</p>", 405);
        if (!session) throw new OAuthError("UNAUTHORIZED", 401);
        const form = new URLSearchParams(body);
        const required = (key: string) => {
          const values = form.getAll(key);
          if (values.length !== 1 || !values[0])
            throw new OAuthError("invalid_request");
          return values[0];
        };
        if (
          [...form.keys()].some(
            (key) =>
              ![
                "consent",
                "decision",
                "project",
                "environment",
                "csrfToken",
                "scope",
              ].includes(key),
          )
        )
          throw new OAuthError("invalid_request");
        const decision = required("decision");
        if (decision !== "allow" && decision !== "deny")
          throw new OAuthError("invalid_request");
        const csrfHeaders = new Headers(request.headers);
        csrfHeaders.delete("authorization");
        csrfHeaders.set("x-mdcms-csrf-token", required("csrfToken"));
        await options.auth.requireCsrfProtection(
          new Request(request.url, { method: "POST", headers: csrfHeaders }),
        );
        let code: string | undefined;
        const consent = await options.store.consumeConsent(
          required("consent"),
          { userId: session.userId, sessionId: session.id },
          async (tx, record) => {
            if (decision === "deny") return;
            const target = {
              project: required("project"),
              environment: required("environment"),
            };
            const selectedScope = required("scope");
            const selected = selectedScope.split(" ");
            if (
              !/^[^\s]+(?: [^\s]+)*$/.test(selectedScope) ||
              new Set(selected).size !== selected.length ||
              selected.some((scope) => !record.payload!.scopes.includes(scope))
            )
              throw new OAuthError("invalid_scope");

            const [existing] = await tx
              .select({ id: environments.id })
              .from(environments)
              .innerJoin(projects, eq(projects.id, environments.projectId))
              .where(
                and(
                  eq(projects.slug, target.project),
                  eq(environments.name, target.environment),
                ),
              );
            if (!existing) throw new OAuthError("invalid_target");
            try {
              assertGrantsCanIssueApiKeyScopes(
                await options.auth.getOAuthUserGrants(session.userId, tx),
                selected as ApiKeyOperationScope[],
                [target],
              );
            } catch (error) {
              if (
                error instanceof RuntimeError &&
                [401, 403].includes(error.statusCode)
              )
                throw new OAuthError("invalid_scope");
              throw error;
            }
            const grantId = randomUUID();
            const createdAt = new Date();
            await tx.insert(oauthGrants).values({
              id: grantId,
              clientId: record.clientId,
              userId: session.userId,
              ...target,
              resource: record.payload!.resource,
              scopes: selected,
              createdAt,
            });
            code = randomBytes(32).toString("base64url");
            await tx.insert(oauthCodes).values({
              hash: hashCredential(code),
              grantId,
              redirectUri: record.payload!.redirectUri,
              challenge: record.payload!.challenge,
              expiresAt: new Date(createdAt.getTime() + 300000),
            });
          },
        );
        const redirect = new URL(consent.payload!.redirectUri);
        redirect.searchParams.set("state", consent.payload!.state);
        redirect.searchParams.set(
          code ? "code" : "error",
          code ?? "access_denied",
        );
        return new Response(null, {
          status: 303,
          headers: { ...headers, location: redirect.href },
        });
      } catch (error) {
        const failure =
          error instanceof OAuthError
            ? error
            : error instanceof RuntimeError && error.statusCode < 500
              ? new OAuthError(error.code, error.statusCode)
              : new OAuthError("temporarily_unavailable", 503, 60);
        return html(
          `<h1>${escape(failure.code)}</h1><p>Start a fresh authorization request and try again.</p>`,
          failure.status,
          failure.retryAfter
            ? { "retry-after": String(failure.retryAfter) }
            : {},
        );
      }
    },
    { parse: "none" },
  );
}
