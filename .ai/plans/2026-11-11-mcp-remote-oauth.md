# Remote OAuth and MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implementation and focused validation complete; integration review and the full CI gate remain required.

**Goal:** Expose the shared registry through authenticated stateless MCP and resource-bound OAuth.

**Architecture:** OAuth state persists in PostgreSQL with atomic consumption and hashed tokens. MCP and trusted internal dispatch use existing authorization and current user grants.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia, Drizzle/PostgreSQL, MCP TypeScript SDK, React.

---

Paths are relative to the repository root. Preserve unrelated working changes.
This plan does not authorize commit, push, publish, deployment or external messages.
Run focused tests after each task; parent integration owns commits and the full gate.

## Spec delta

SPEC-005 adds OAuth discovery, registration, consent, code/refresh exchange,
revocation and connection endpoints. SPEC-015 defines stateless MCP and declared
identity. Acceptance requires resource/target isolation and no credential bypass.
Dependency: shared dispatcher and registry plan. SPEC-005/009 also add
environments:read for admin/owner project metadata discovery, without permitting
OAuth target changes or environment create/delete.

Storage spec delta: registration has an atomic 10,000-client cap with no expiry
or eviction and returns 503/Retry-After:60 at capacity. Indexed bounded cleanup
removes expired codes/access tokens, preserves refresh replay hashes through
family expiry, retains connections for idempotent revoke, and retains expired
consent tombstones for 24 hours (410 before purge, 400 afterward). Persistence
verification covers concurrent admission and cleanup without loss of replay or
revocation semantics.

### Task 0: Typed canonical origin and bounded OAuth settings

Modify `apps/server/src/lib/env.ts`, `env.test.ts`, `auth.ts`,
`runtime-with-modules.ts`, `.env.example`, `docker-compose.yml` and operator docs.
This is a prerequisite for metadata, consent URLs and resource validation.

- [x] Add required resolved string MDCMS_SERVER_URL to ServerEnv. Parse as SPEC-005's
      canonical origin, normalize a lone slash, reject paths/query/fragment/userinfo
      and unsupported schemes. Development/test fallback uses validated PORT;
      production requires explicit HTTPS. Replace resolveAuthBaseUrl's raw-env
      fallback with this same typed value; never derive OAuth origin from headers.
- [x] Add the four SPEC-005 OAuth rate-limit settings with exact defaults/ranges
      to typed parsing. Forward origin and limits in Compose server.environment
      and document them in .env.example. Empty Compose origin counts as missing;
      it must fail production startup rather than select a local HTTP default.
- [x] Test absent/empty/invalid/normalized origins in development and production,
      reverse-proxy HTTPS origin with local HTTP listener, spoofed Host/Forwarded
      headers and invalid rate limits. Inspect rendered Compose configuration with
      synthetic env values, without starting or deploying services.
- [x] Run `bun test apps/server/src/lib/env.test.ts` and the relevant auth tests.

### Task 1: OAuth storage and atomic transitions

Create `apps/server/src/lib/oauth/{types,store,database-store}.ts`,
`apps/server/src/lib/oauth/database-store.test.ts`. Modify
`apps/server/src/lib/db/schema.ts` and `schema.contract.test.ts`; generate a new
migration through `bun run --cwd apps/server db:generate`. Do not overwrite or
regenerate the existing attribution migration.

- [x] Define rows for registered clients, consent requests, authorization codes,
      grants and token families. Persist hashes, client/user/target/resource/scopes,
      creation/expiry/use/revocation timestamps; never raw credentials. A code row
      holds redirect URI and S256 challenge; a refresh row links parent/family.
- [x] Implement atomic conditional transitions. SQL semantics for consumption:

```sql
UPDATE oauth_codes SET consumed_at = now()
WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
RETURNING id;
```

Include client/resource/redirect/proof validation in the same transaction before
issuing tokens. Lock the refresh family during consume/rotate; replay revokes
the family. Use SHA-256 and cryptographic randomBytes(32), encoded base64url.

- [x] Add database tests with simultaneous redemption: exactly one code exchange
      succeeds; two refresh uses cannot both yield live descendants; failed proof
      cannot issue a token. Assert database rows contain hashes, never raw values.
- [x] Run database contract and OAuth storage tests, then integration migration
      verification. Do not claim concurrency proof from an in-memory fake alone.

### Task 1a: Persistent bounded throttle counters

Create `apps/server/src/lib/oauth/rate-limit.ts` and `rate-limit.test.ts`, with
counter persistence in oauth/database-store.ts and the generated OAuth migration.

- [x] Implement atomic 60-second counters shared across server instances, global
      per endpoint plus known-client/user buckets, exact limits from SPEC-005.
      Expire after two windows, cap active buckets at 10,000, never allocate buckets
      for arbitrary unknown client IDs and never evict live counters to admit work.
- [x] Test exact limit/next-window boundaries, concurrent requests, active-bucket
      cap, cleanup, database unavailable and separate password backoff. Assert
      429 rate_limit_exceeded or 503 temporarily_unavailable and Retry-After;
      failures issue no code/token. No token/verifier/consent values enter logs.
- [x] Run the focused throttle tests and database concurrency integration case.

### Task 2: Authorization and consent routes

Create `apps/server/src/lib/oauth/{routes,validation,service}.ts` and
`apps/server/src/lib/oauth/routes.test.ts`. Wire in
`apps/server/src/lib/runtime-with-modules.ts`. Reuse the server-rendered login
patterns in `apps/server/src/lib/auth.ts`, including backoff and session CSRF.

- [x] Implement exact request/response/error contracts from SPEC-005 tables.
      Metadata uses configured server URL. Registration rejects fragments, userinfo,
      wildcard and non-loopback HTTP redirects; no arbitrary metadata URL fetches.
- [x] Bind validated authorization parameters to a hashed consent handle and
      signed-in session/user. Render escaped client/redirect/target/scope values.
      POST verifies CSRF, ownership and the fixed 600-second handle lifetime;
      GET never mints a code. A sign-in round trip does not renew the handle.
- [x] Use assertGrantsCanIssueApiKeyScopes for scope eligibility and the same
      project/path grant rules. Store target immutably; do not derive target from
      untrusted refresh or token request fields.
- [x] Implement the RFC8252 loopback-port exception only when matching an
      authorization redirect against registration. Persist the selected concrete
      URI and require exact match, including port, at code exchange. Test IPv4 and
      IPv6 ephemeral-port success; host/path/query changes and redemption with a
      different port fail. HTTPS redirects retain exact port matching.
- [x] Add tests for changed session user, CSRF failure, altered hidden fields,
      denied consent, expired handle, invalid redirect, unknown client, plain PKCE,
      wrong verifier/resource and scope expansion. Each rejects without a grant.
- [x] Implement token/revoke responses with no-store and bounded rate limits.
      Code/refresh expiry uses injected clock tests at exact boundary times.
- [x] Run `bun test apps/server/src/lib/oauth/routes.test.ts`.

### Task 2a: Preserve protocol behavior at external ingress

Modify `apps/server/src/lib/server.ts`,
`apps/server/src/lib/target-routing-guard.test.ts` and
`apps/server/src/lib/mcp/routes.test.ts`; create
`apps/server/src/lib/oauth/ingress.test.ts` using createServerRequestHandler.
Task 2 mounted-route tests alone do not cover this boundary.

- [x] Extend shouldPreserveHtmlErrorResponse with exact /api/v1/oauth/authorize
      path; retain status, text/html, no-store and Retry-After on GET/POST errors.
      OAuth machine endpoint errors must be explicit application/json Responses;
      these already survive normalization. Do not throw a domain RuntimeError
      through the outer handler for OAuth invalid_grant/invalid_target.
- [x] Extend Origin/CORS routing to MCP, OAuth and discovery endpoints as SPEC-005
      requires. Accept canonical origin plus configured allowed origins, reject
      null/unknown origins, handle allowed OPTIONS before bearer authentication,
      allow MCP-Protocol-Version/Accept/X-MDCMS-Client and expose WWW-Authenticate
      and Retry-After on success and failure. Preserve session CSRF enforcement.
- [x] Keep public metadata/register/token paths outside target guards. Do not add
      blanket /oauth or pre-auth project_environment /mcp policies. Connections
      enforce project themselves; MCP derives target after credential verification.
- [x] Through the external handler test HTML consent 400/410/429/503; token JSON
      invalid_grant/invalid_target/429 headers; preflight without auth; rejected
      Origin; MCP 401 challenge exposure; metadata/token without target headers;
      OAuth MCP initialized/listed using only its token. Assert headers and body,
      not merely status or a direct mounted handler's response.
- [x] Run `bun test apps/server/src/lib/oauth/ingress.test.ts` and
      `bun test apps/server/src/lib/target-routing-guard.test.ts`.

### Task 3: OAuth principal integration

Modify `apps/server/src/lib/auth.ts`, `auth.test.ts`, `auth-actor.test.ts` and
`apps/server/src/lib/agent-tools/dispatcher.ts`.

- [x] Extend the principal union with oauth and derive the user/client attribution
      from stored grant. Validate hash, resource, expiry, revocation and current user
      before authorizing. Do not turn the grant into an unrestricted API-key principal.
- [x] Accept tokens at /api/v1/mcp or trusted internal dispatch only. Resolve
      omitted OAuth routing from stored target; reject any conflicting header/query.
      Preserve explicit routing for API keys and reject OAuth at external REST routes.
- [x] Include environments:read in advertised/issuable scopes only under the
      existing global admin/owner rules. Verify issuance rejection for editor/viewer,
      role removal after consent, project-confined list output, and unchanged target
      restrictions after listing another environment.
- [x] Add tests for OAuth REST bypass, spoofed internal headers, target changes,
      revoked membership, path-only grants and credential reuse across resources.
      Test persisted grant revocation against an already-issued access token.
- [x] Run auth and dispatcher suites before mounting MCP.

### Task 4: MCP adapter and identity

Create `apps/server/src/lib/mcp/{routes,server}.ts`,
`apps/server/src/lib/mcp/routes.test.ts`; update `apps/server/package.json` via Bun
for the SDK dependency and wire the routes in runtime-with-modules.ts.

- [x] Use the installed SDK export
      `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` after verifying
      its export map; create WebStandardStreamableHTTPServerTransport per request with
      enableJsonResponse=true and no sessionIdGenerator. Close it in finally.
- [x] Register schemas and executors from the shared registry, binding request
      context. Map route failures to isError tool results and protocol failures to
      JSON-RPC errors. Advertise only implemented capabilities.
- [x] Parse per-call metadata `ai.mdcms/clientInfo` as optional untrusted data,
      normalize printable 120-character name/version, and omit invalid values. Never
      retain initialize clientInfo across request instances or by credential key.
- [x] Test independent initialize/list/call requests, authenticated GET/DELETE 405,
      invalid Origin, unauthenticated WWW-Authenticate, unknown tool, malformed input,
      path grants, structured errors and concurrent clients sharing a credential.
- [x] Run `bun test apps/server/src/lib/mcp/routes.test.ts` with a real SDK client
      transport connected to the mounted handler, including teardown on failures.

### Task 5: Connection list and revoke

Add endpoint handlers to oauth/routes.ts and contracts to
`packages/shared/src/lib/contracts/oauth.ts`, exported from shared/src/index.ts.

- [x] Implement OAuthConnection exactly as SPEC-005. Query by explicit project and
      granting user, expanding visibility only for project admin/owner. Exclude all
      token/hash columns before serialization. DELETE requires session CSRF.
- [x] Test member self-view, admin project view, foreign ID 404, missing target,
      repeat revoke and immediate access/refresh rejection after revoke.
- [x] Run focused suites and `bun run check`; record actual results. Generate a
      shared-package changeset through the CLI when required. No release is implied.


## Implementation details

Persistence contracts are colocated in `oauth/database-store.ts`; consent rendering
and bounded request parsing are separate modules. MCP transport and handlers are
colocated in `mcp/routes.ts`. The shared registry exposes a validated-call boundary
so transport validation does not parse inputs twice. OAuth integration is included
in `bun run integration` and can run independently with `bun run integration:oauth`.
The shared connection contract has a CLI-generated minor changeset.
