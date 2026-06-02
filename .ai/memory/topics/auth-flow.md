# Auth flow

## What it is

Three authentication modes coexist in MDCMS, each suited to a different surface:

- **Session** — browser-based, used by Studio. Server-issued, cookie-bound, stored in the Postgres `sessions` table.
- **API key** — long-lived bearer token. Used by SDK consumers and any non-interactive client. Carries scopes.
- **Loopback OAuth flow** — CLI's browser-based auth handoff using OAuth2 with a localhost callback (RFC 8252). Trades a one-time authorization code (with `state` validation) for an API key stored in the user's local CLI config.

All three resolve to the same internal concept downstream: an authenticated principal with a project context and a set of scopes.

## How it works

### Session (Studio)

Browser sessions are persisted server-side; the `sessions` table in `apps/server/src/lib/db/schema.ts` holds them with a unique-token index. Studio fetches the active principal on mount and caches it in its TanStack Query layer; writes carry CSRF protection.
Session bootstrap returns the existing readable `mdcms_csrf` cookie when present and only creates a new token when the cookie is missing, so cached Studio clients can replay the token without another bootstrap invalidating it.
Cookie-authenticated Studio tabs revalidate the session when the tab regains
focus or becomes visible, so expired or revoked sessions redirect to login
without a manual refresh.

### API key (SDK / non-interactive)

Clients construct `createClient({ url, apiKey, project, environment })` and send `Authorization: Bearer <api-key>` on every request. The server resolves `key → principal → project ACL → scopes → request`. The SDK is read-only by design; writes go directly to the server.

### Loopback OAuth flow (CLI)

1. `mdcms login` starts a local HTTP listener (`createCallbackListener` in `apps/cli/src/lib/login.ts`) bound to `127.0.0.1` on an ephemeral port. Callback path is `/callback`.
2. CLI opens a browser to the server's authorization page with the `redirectUri` (e.g. `http://127.0.0.1:54321/callback`), a one-time `state` value, and a server-issued `challengeId`.
3. User authenticates in the browser. Server redirects to the loopback URL with `code` + `state`.
4. The local listener validates that the inbound `state` matches the value the CLI sent (CSRF protection).
5. CLI exchanges the `code` with the server for an API key.
6. Key is stored in the user's CLI credential store. Subsequent CLI commands use it as a bearer token.

If the listener doesn't receive a callback within a timeout, the CLI surfaces "Timed out waiting for browser callback. Please retry `mdcms login`."

## Guarantees / invariants

- Every authenticated request resolves a project context **before** reaching domain code. No cross-tenant leak via missing scoping.
- API keys carry scopes; sessions inherit scopes from the user's role.
- CSRF bootstrap must not rotate an existing `mdcms_csrf` cookie; multiple Studio clients and route helpers may cache that token concurrently.
- The loopback flow validates `state` to defeat CSRF; binding to `127.0.0.1` confines redirect targets to the local machine.
- API keys are revocable; sessions are revocable; both invalidate immediately on the server.
- Password sign-in does not revoke a user's other active Studio sessions; users
  can stay signed in from multiple browser contexts until inactivity, absolute
  max age, logout, or explicit admin revocation invalidates a session.

## Cross-refs

- Spec: `docs/specs/SPEC-005-auth-authorization-and-request-routing.md`
- Per-package: `apps/server/AGENTS.md`, `apps/cli/AGENTS.md`
- Implementation: `apps/cli/src/lib/login.ts` (loopback listener), `apps/server/src/lib/auth.ts`, `apps/server/src/lib/db/schema.ts` (sessions table)
- Related topic: [`multi-tenancy.md`](multi-tenancy.md) for how `project_id` scoping interacts with auth

## Open extensions

OIDC and SAML provider support are upcoming-work items; see `docs/specs/` for the current spec inventory and check whether a dedicated spec has landed before assuming behavior.
