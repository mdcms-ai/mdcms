---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-02
---

# SPEC-005 Auth, Authorization, and Request Routing

This is the live canonical document under `docs/`.

## REST API Boundary

This spec owns the shared HTTP boundary rules for authentication, target routing, response envelopes, and the normative auth-related endpoint contracts. Domain-specific endpoint families are owned by their corresponding domain specs.

## Contract Template (Normative)

Every endpoint contract in this section specifies:

- Method and path
- Auth mode (`public`, `session`, `api_key`, or `session_or_api_key`)
- Required operation scope (if any)
- Required target routing context (`project` / `environment`)
- Request schema
- Success response schema
- Deterministic error mapping

## Base URL

`{MDCMS_SERVER_URL}/api/v1`

## Authentication

MDCMS supports two auth modes:

- **Studio/browser clients:** session authentication (better-auth) by default. Embedded Studio may also use bearer API key authentication when the host selects Studio token mode.
- **SDK/CLI/machine clients:** API key authentication.
- **Post-MVP collaboration WebSocket:** Studio session authentication only (API keys are not accepted).

API key format:

```
Authorization: Bearer mdcms_key_xxxxxxxxxxxx
```

Draft content access requires `draft=true` plus `content:read:draft` permission:

```
GET /api/v1/content?type=BlogPost&draft=true
```

API keys are access-control objects, not routing objects. Each key stores an allowlist of `(project, environment)` tuples.

### Explicit Target Routing

All environment-scoped requests (content, schema, environments, migrations, and any future search/webhook/collaboration routes) must explicitly include both target project and target environment. Project-scoped management requests (e.g., create/list environments) must include explicit project target.

Media assets are project-scoped (reusable across environments), and any future media API requests still carry explicit `(project, environment)` routing for authorization and request consistency.

Supported request forms:

```
X-MDCMS-Project: marketing-site
X-MDCMS-Environment: staging
```

or query parameters (`?project=marketing-site&environment=staging`).

The server rejects requests missing explicit target routing, even when the caller uses a scoped key.

Deterministic routing errors:

- `MISSING_TARGET_ROUTING` (`400`) means the required project/environment routing context was not provided.
- `TARGET_ROUTING_MISMATCH` (`400`) means routing context was provided, but it does not match the caller's authorized `(project, environment)` allowlist or the resolved target resource.

For post-MVP collaboration WebSocket connections, use query parameters on connect:

```
wss://<host>/api/v1/collaboration?project=marketing-site&environment=staging&documentId=<uuid>
```

The browser must send a valid Studio session cookie; API keys are not accepted on that endpoint.

### Cross-Origin Studio Browser Contract (Normative)

Cross-origin Studio embedding is a first-class deployment path. MDCMS must support a host app on a different origin from `MDCMS_SERVER_URL` without requiring a reverse proxy.

Allowed browser origins are configured through `MDCMS_STUDIO_ALLOWED_ORIGINS`, a comma-separated list of absolute origins (`scheme://host[:port]`).

Origin validation and CORS behavior apply to browser requests that include an `Origin` header for:

- Studio runtime delivery endpoints (`/api/v1/studio/*`)
- Studio action catalog endpoints (`/api/v1/actions`, `/api/v1/actions/:id`)
- Studio auth/session bootstrap endpoints invoked through fetch/XHR (`/api/v1/auth/login`, `/api/v1/auth/session`, `/api/v1/auth/get-session`, `/api/v1/auth/logout`, `/api/v1/auth/sign-out`)
- Studio-called domain APIs such as content, schema, and environment endpoints
- Any future HTTP endpoint called directly by the Studio runtime from the browser

Requests without an `Origin` header are not subject to this browser-origin allowlist.

For an allowlisted origin, the server must:

- echo the exact origin in `Access-Control-Allow-Origin`
- emit `Vary: Origin`
- emit `Access-Control-Allow-Credentials: true`
- allow methods `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`
- allow headers at minimum:
  - `Authorization`
  - `Content-Type`
  - `X-MDCMS-Project`
  - `X-MDCMS-Environment`
  - `X-MDCMS-Locale`
  - `X-MDCMS-Schema-Hash`
  - `X-MDCMS-CSRF-Token`

Studio browser request modes:

- Session (`cookie`) mode sends browser requests with credentials included and relies on the session cookie plus CSRF token bootstrap.
- Token mode sends `Authorization: Bearer <mdcms_key_...>` and does not rely on browser session cookies.

Successful browser preflight requests (`OPTIONS`) for allowlisted origins return `204` with no body.

If a browser request includes an `Origin` header that is not allowlisted, the server must reject both the preflight request and the actual request with `FORBIDDEN_ORIGIN` (`403`).

### Embedded Host Route Preview

The Studio document editor may embed a host application's preview route in an
iframe. That iframe renders host application HTML; it is not an MDCMS API
endpoint and does not weaken the shared MDCMS request-routing rules above.

Normative rules:

- MDCMS API calls made by Studio continue to require the same session or API-key
  auth mode, explicit project/environment routing, CSRF behavior, and CORS
  allowlist checks as any other Studio browser request.
- The iframe target must not be treated as an implicit authorization grant. Any
  host preview route that reads MDCMS draft data must authenticate its own
  draft-aware reads and must carry explicit project/environment/document
  context.
- The first Studio preview slice may embed same-origin host preview routes that
  already rely on the host application's normal session/runtime context. It does
  not introduce a public MDCMS preview-token mint endpoint.
- Cross-origin host preview adapters require a future scoped preview-token
  contract before they may read draft content in an embedded frame. Such a token
  must be read-only, short-lived, scoped to
  `{ project, environment, documentId }`, and rejected for all mutation
  endpoints.
- Browser cookies must not be the only cross-origin preview auth mechanism.
  Third-party cookie restrictions make iframe session sharing unreliable, so a
  future cross-origin adapter must use the scoped preview-token contract or
  render an explicit unauthorized/unavailable state.
- The host application controls its own frame policy. When the host route cannot
  be framed because of `Content-Security-Policy` or `X-Frame-Options`, Studio
  must surface a framing-blocked state and keep the open-in-new-tab fallback
  available.

## Response Format

```json
{
  "data": {
    "documentId": "uuid",
    "translationGroupId": "uuid",
    "project": "marketing-site",
    "environment": "production",
    "path": "blog/hello-world",
    "type": "BlogPost",
    "locale": "en",
    "format": "md",
    "isDeleted": false,
    "hasUnpublishedChanges": false,
    "version": 5,
    "publishedVersion": 5,
    "draftRevision": 42,
    "frontmatter": {
      "title": "Hello World",
      "slug": "hello-world",
      "author": { "$ref": "uuid", "type": "Author" },
      "tags": ["intro", "tutorial"]
    },
    "body": "# Hello World\n\nThis is my first blog post...",
    "createdBy": "uuid",
    "createdAt": "2026-02-12T10:00:00Z",
    "updatedAt": "2026-02-12T12:30:00Z"
  }
}
```

`locale` is always a string in API responses. In implicit single-locale mode (no explicit `locales` config), API responses return the reserved internal locale token `__mdcms_default__`. `format` indicates whether the content is stored/synced as `md` or `mdx`.

List responses include pagination metadata:

```json
{
  "data": [...],
  "pagination": {
    "total": 142,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

## Authentication & Authorization

### User Authentication

Implemented via **better-auth**.

**Supported methods:**

- **Email + password** — Required. Always available.
- **SSO (OIDC + SAML)** — Required for MVP. OIDC is the default recommended provider profile. SAML 2.0 is supported for startup-configured enterprise providers.
- Enterprise providers supported include Okta, Azure AD, Google Workspace, Auth0.

Authentication state is managed via sessions. The Studio communicates with the backend over the same session.

#### OIDC Provider Support

- MDCMS standardizes on the Better Auth SSO plugin for OIDC support.
- OIDC uses startup-configured provider profiles only. Runtime provider registration, Studio provider settings, email/domain-based provider discovery, domain verification, and organization provisioning are out of scope.
- Supported provider IDs are:
  - `okta`
  - `azure-ad`
  - `google-workspace`
  - `auth0`
- Deny-by-default applies to provider selection:
  - only explicitly configured provider profiles are available for sign-in
  - requests for unsupported or unconfigured provider IDs fail with `SSO_PROVIDER_NOT_CONFIGURED` (`404`)

#### OIDC Startup Configuration (Normative)

- OIDC providers are configured through `MDCMS_AUTH_OIDC_PROVIDERS`, a JSON array of provider profiles loaded during server startup.
- OIDC is available when one or more valid provider profiles are configured. An absent or empty `MDCMS_AUTH_OIDC_PROVIDERS` value means no OIDC providers are available for sign-in.
- Each provider profile must include:
  - `providerId` (`okta` | `azure-ad` | `google-workspace` | `auth0`)
  - `issuer`
  - `domain`
  - `clientId`
  - `clientSecret`
- Optional fields:
  - `scopes` (defaults to `["openid", "email", "profile"]`)
  - `trustedOrigins[]` for explicitly permitted non-issuer absolute origins (`scheme://host[:port]`) used by discovery or callback validation
  - `discoveryOverrides` for metadata correction when a provider fixture or tenant advertises incomplete metadata
- Supported `discoveryOverrides` keys are:
  - `authorizationEndpoint`
  - `tokenEndpoint`
  - `userInfoEndpoint`
  - `jwksUri`
  - `tokenEndpointAuthMethod` (`client_secret_basic` or `client_secret_post`)
- PKCE is enabled for all configured OIDC providers.
- MDCMS performs OIDC discovery from `{issuer}/.well-known/openid-configuration` and refuses startup when:
  - the JSON payload is malformed
  - a provider profile is missing required fields
  - `providerId` is unsupported
  - `providerId` or `domain` is duplicated
  - discovery metadata cannot be resolved or validated
  - discovery resolves to an origin outside the configured `issuer` origin plus any explicit `trustedOrigins[]`
- Startup validation failures are deterministic `INVALID_ENV` boot failures, not deferred runtime warnings.
- OIDC provider configuration is instance-global and requires process restart after changes.
- Operators must register the provider callback URI `${MDCMS_SERVER_URL}/api/v1/auth/sso/callback/<providerId>` with each configured provider profile.

Example `MDCMS_AUTH_OIDC_PROVIDERS` value:

```json
[
  {
    "providerId": "okta",
    "issuer": "https://example.okta.com/oauth2/default",
    "domain": "example.com",
    "clientId": "okta-client-id",
    "clientSecret": "okta-client-secret"
  },
  {
    "providerId": "google-workspace",
    "issuer": "https://accounts.google.com",
    "domain": "workspace.example.com",
    "clientId": "google-client-id",
    "clientSecret": "google-client-secret"
  }
]
```

#### Canonical OIDC Claims Mapping (Normative)

All configured provider profiles normalize to the same MDCMS user fields:

- `id <- sub` (required)
- `email <- email` (required, non-empty)
- `emailVerified <- email_verified` when present and boolean; otherwise `false`
- `name <- name`; fallback order is `given_name + family_name`, then `preferred_username`, then `email`
- `image <- picture` when present; otherwise `null`

Provider-specific claims remapping is not operator-configurable.

MDCMS rejects sign-in with `AUTH_OIDC_REQUIRED_CLAIM_MISSING` (`401`) when:

- `sub` is missing or empty
- `email` is missing, empty, or unusable as an account identifier

#### SAML Provider Support

- MDCMS standardizes on the Better Auth SSO plugin for SAML 2.0 support.
- SAML uses startup-configured provider profiles only. Runtime provider registration, Studio provider settings, email/domain-based provider discovery, IdP-initiated login, and SAML Single Logout are out of scope.
- Deny-by-default applies to provider selection:
  - only explicitly configured provider profiles are available for sign-in
  - requests for unsupported or unconfigured provider IDs fail with `SSO_PROVIDER_NOT_CONFIGURED` (`404`)

#### SAML Startup Configuration (Normative)

- SAML providers are configured through `MDCMS_AUTH_SAML_PROVIDERS`, a JSON array of provider profiles loaded during server startup.
- SAML is available when one or more valid provider profiles are configured. An absent or empty `MDCMS_AUTH_SAML_PROVIDERS` value means no SAML providers are available for sign-in.
- `MDCMS_AUTH_OIDC_PROVIDERS` and `MDCMS_AUTH_SAML_PROVIDERS` remain separate operator-facing env vars.
- Each SAML provider profile must include:
  - `providerId`
  - `issuer`
  - `domain`
  - `entryPoint`
  - `cert`
- Optional fields:
  - `audience`
  - `spEntityId`
  - `identifierFormat`
  - `authnRequestsSigned`
  - `wantAssertionsSigned`
  - `attributeMapping` with optional keys `id`, `email`, `name`, `firstName`, and `lastName`
- `providerId` must be unique across all configured OIDC and SAML providers.
- `domain` must be unique within the configured SAML provider set.
- Startup validation failures are deterministic `INVALID_ENV` boot failures, not deferred runtime warnings.
- SAML provider configuration is instance-global and requires process restart after changes.
- MDCMS derives the canonical Assertion Consumer Service (ACS) endpoint as `${MDCMS_SERVER_URL}/api/v1/auth/sso/saml2/sp/acs/<providerId>`.
- MDCMS derives provider-specific SP metadata from `${MDCMS_SERVER_URL}/api/v1/auth/sso/saml2/sp/metadata?providerId=<providerId>&format=xml`.
- When `spEntityId` is omitted, operators must treat the generated SP metadata as the source of truth for the effective SP entity identifier.
- Operators must register the MDCMS SP metadata or ACS URL with each configured IdP.

Example `MDCMS_AUTH_SAML_PROVIDERS` value:

```json
[
  {
    "providerId": "okta-saml",
    "issuer": "http://www.okta.com/exk123456789",
    "domain": "example.com",
    "entryPoint": "https://example.okta.com/app/example/sso/saml",
    "cert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "spEntityId": "https://cms.example.com/saml/okta-saml/sp",
    "audience": "https://cms.example.com/saml/okta-saml/sp",
    "attributeMapping": {
      "id": "nameID",
      "email": "email",
      "name": "displayName",
      "firstName": "givenName",
      "lastName": "surname"
    }
  }
]
```

#### Canonical SAML Attribute Mapping (Normative)

All configured provider profiles normalize to the same MDCMS user fields:

- `id <- attributeMapping.id`; fallback `NameID`
- `email <- attributeMapping.email`; fallback `NameID` only when it is a usable email address
- `emailVerified <- false`
- `name <- firstName + lastName`; fallback order is `attributeMapping.name`, then `email`
- `image <- null`

Provider-specific attribute remapping is limited to the optional `attributeMapping` fields defined above.

MDCMS rejects sign-in with `AUTH_SAML_REQUIRED_ATTRIBUTE_MISSING` (`401`) when:

- the configured mapping plus `NameID` do not yield a usable `id`
- the configured mapping plus `NameID` do not yield a usable `email`

#### Session Security

- Session cookie is `httpOnly`, `Secure`, `SameSite=None`, and scoped to `/`.
- `mdcms_csrf` cookie is readable, `Secure`, `SameSite=None`, and scoped to `/`.
- Session lifetime: 2h rolling inactivity timeout with a 12h absolute max age.
- Password sign-in creates a new session without revoking the user's other
  active sessions.
- Session IDs rotate on sign-in and privilege changes.
- CSRF token required for Studio state-changing requests.
- Failed password login attempts apply exponential backoff keyed by normalized email.
- Password-entry routes protected by this backoff are `POST /api/v1/auth/login` and `POST /api/v1/auth/cli/login/authorize` when credentials are submitted.
- Invalid credentials outside active backoff return `AUTH_INVALID_CREDENTIALS` (`401`).
- Active backoff rejects password-entry requests with `AUTH_BACKOFF_ACTIVE` (`429`) and `Retry-After`.
- Successful password sign-in resets the stored backoff state.
- A quiet window of 15 minutes without failed attempts resets the backoff state.
- MVP backoff schedule is capped exponential delay: `1s`, `2s`, `4s`, `8s`, `16s`, `32s`.
- Session revocation is explicit: `logout` invalidates the current session, and
  owner/admin users can revoke all active sessions for a user.

#### CSRF Enforcement (Normative)

- Session-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests require CSRF validation.
- The server sets a readable `mdcms_csrf` cookie.
- Clients must echo the same token value in the `x-mdcms-csrf-token` header.
- Successful session bootstrap responses also return the same token in the response payload as `csrfToken` so cross-origin Studio clients can cache and replay it without reading cookies from the API origin:
  - `POST /api/v1/auth/login`
  - `GET /api/v1/auth/session`
  - `GET /api/v1/auth/get-session`
- CSRF validation succeeds only when a valid session cookie is present and the `mdcms_csrf` cookie matches the `x-mdcms-csrf-token` header value.
- Read-only requests (`GET`, `HEAD`, `OPTIONS`) are exempt.
- API-key authenticated requests are exempt.
- Public auth flows are exempt: `/api/v1/auth/login`, `/api/v1/auth/sign-up/email`, `/api/v1/auth/sign-in/email`, and `/api/v1/auth/cli/login/*`.
- CSRF validation failures return `FORBIDDEN` (`403`) with message `Valid CSRF token is required for session-authenticated state-changing requests.`

#### Collaboration Socket Authentication (Post-MVP)

Collaboration sockets are deferred to Post-MVP. When implemented, they are authenticated with the same Studio session cookie (not API keys):

- Connect URL: `/api/v1/collaboration?project=...&environment=...&documentId=...`
- `Origin` must match the configured Studio allowlist.
- Session cookie is validated through better-auth during the WebSocket handshake.
- Target document must belong to the requested `(project, environment)` scope.
- Folder/path RBAC (`documents.path`) is evaluated before subscribing the socket to the document room.
- Revoked/expired sessions are disconnected immediately with `4401`; authorization failures return `4403`.

### API Authentication

Machine-to-machine access (SDK, CI/CD) uses API keys:

- API keys are generated in the Studio UI under Settings.
- Each key has a name, creation date, optional expiration, and owner audit metadata.
- Keys are prefixed for identification: `mdcms_key_xxxxxxxxxxxx`.
- The `?draft=true` query parameter requires an API key with `content:read:draft`.
- Keys are scoped as an allowlist of `(project, environment)` tuples.
- Keys authorize access only; they do not select routing targets.
- API keys are not accepted by the collaboration WebSocket endpoint.

#### API Key Scope Model

- Scope is defined at two levels:
  - **Context**: `(project, environment)` tuple allowlist.
  - **Permission**: operation-level scope values.
- Required minimum operations:
  - `content:read`
  - `content:read:draft`
  - `content:write`
  - `content:write:draft` (legacy compatibility alias for write-only behavior)
  - `content:publish`
  - `content:delete`
  - `schema:read`
  - `schema:write`
  - `media:upload`
  - `media:delete`
  - `webhooks:read`
  - `webhooks:write`
  - `environments:clone`
  - `environments:promote`
  - `ai:use`
  - `migrations:run`
- Scopes are deny-by-default: a key without an operation scope cannot perform that action.
- Public routes and session-only routes may specify required scope `none`; operation scopes apply only to API-key-capable routes.
- Keys are hashed at rest and never retrievable after creation.
- On creation, keys are shown once and user confirms secure storage.
- Key rotation creates a new key and disables old key by `revoked_at` timestamp.
- Optional API key labels support operational ownership (`ci`, `bot`, `editorial`, etc.).
- Breaking compatibility note: legacy keys with only `content:write:draft` no longer satisfy draft-read authorization; they satisfy write operations only.

#### CLI Browser Login/Logout Handshake

`cms login` is implemented as a browser-based authorization code flow, not as direct credential entry in CLI.

**Flow (normative):**

1. CLI calls `POST /api/v1/auth/cli/login/start` with:
   - `project`, `environment`
   - `redirectUri` (loopback HTTP only: `127.0.0.1` / `localhost` / `::1`, explicit port required)
   - `state` (caller-generated anti-CSRF token)
   - optional `scopes` (defaults applied when omitted)
2. Server creates a persisted login challenge:
   - TTL: 10 minutes
   - stores hashed `state`
   - status lifecycle: `pending` -> `authorized` -> `exchanged`
3. CLI opens `authorizeUrl` in browser:
   - `GET /api/v1/auth/cli/login/authorize`
   - if no active browser session, server returns login form
4. Browser authorization:
   - `POST /api/v1/auth/cli/login/authorize` validates session or performs sign-in
   - on success server issues one-time auth code and redirects to loopback callback: `redirectUri?code=...&state=...`
5. CLI exchanges code:
   - `POST /api/v1/auth/cli/login/exchange` with `challengeId`, `state`, `code`
   - server validates challenge TTL, state hash, single-use code semantics, and returns API key + metadata
6. CLI stores credential profile under `(serverUrl, project, environment)` tuple.

**CLI auth defaults and precedence:**

- Login-generated API keys request scopes: `projects:read`, `projects:write`, `schema:read`, `schema:write`, `content:read`, `content:read:draft`, `content:write`, `content:delete`. The server validates that the session's effective role permits all requested scopes. **MVP limitation:** CLI requires Admin or Owner role (see SPEC-008).
- CLI auth precedence is: `--api-key` > `MDCMS_API_KEY` > stored profile.

**Deterministic failure semantics:**

- `INVALID_INPUT` (400) — malformed payload, invalid redirect URI, missing fields
- `UNAUTHORIZED` (401) — invalid credentials/session where required
- `FORBIDDEN` (403) — policy-denied operation
- `NOT_FOUND` (404) — unknown challenge or key id when applicable
- `LOGIN_CHALLENGE_EXPIRED` (410) — challenge expired before exchange
- `LOGIN_CHALLENGE_USED` (409) — challenge or code already consumed
- `INVALID_LOGIN_EXCHANGE` (400) — state mismatch, wrong code, or invalid challenge status for exchange

`cms logout` clears local tuple credentials and calls `POST /api/v1/auth/api-keys/self/revoke` using the stored bearer token when available.

Studio traffic uses session authentication by default and may use bearer API key authentication when the embed host selects token mode. Both modes use the same authorization layer.

### Authorization (Role-Based, Per-Folder)

**Roles:**

| Role       | Capabilities                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Full access. Cannot be removed. Manages instance-level settings, billing (future SaaS), and can assign all roles. One per instance. |
| **Admin**  | User management, settings, read-only schema browsing, schema sync, and all content operations. Can assign Editor and Viewer roles.  |
| **Editor** | Create, edit, publish, unpublish, and delete content. Can browse schema read-only. Limited to assigned folders.                     |
| **Viewer** | Read-only access to CMS dashboard and schema. Can view content but not modify. Limited to assigned folders.                         |

**Folder-level assignment:**

- Roles are assigned per user per logical content path prefix (e.g., "Alice is an Editor for `blog/*`", where `blog/*` maps to `documents.path`).
- A user can have different roles for different folders.
- Permissions cascade: access to `blog/` includes access to `blog/posts/`, `blog/drafts/`, etc.
- If multiple grants apply, the most permissive grant wins.
- Admin and Owner roles are instance-wide (not folder-scoped).

### Project-Scoped and Global Authorization

Permissions can be assigned at two levels:

- **Global (instance-wide):** a role assigned globally applies to all projects that exist on the instance, including future projects.
- **Project-scoped:** a role assigned to a specific project applies only to that project. A user may therefore have different roles on different projects.

When both global and project-scoped roles exist, the most permissive applicable role wins for that project.

API keys follow the same project/environment scoping model through tuple allowlists:

- a global key is represented as an allowlist containing all `(project, environment)` tuples
- a restricted key contains only explicitly granted tuples
- request routing remains explicit; keys authorize access but do not select the route target

Schema authorization semantics:

- `schema:read` authorizes read-only schema browsing for the target `(project, environment)`.
- `schema:write` authorizes explicit schema sync for the target `(project, environment)`.
- `schema:write` is reserved to `admin` and `owner`.
- `editor` and `viewer` may receive `schema:read`, but never `schema:write`.
- API key issuance rejects reserved scopes that the authorizing session may not grant. In particular, non-admin and non-owner sessions cannot mint or authorize API keys with `schema:write`.

---

## Authentication, Session, and API Key Endpoints

**CSRF note (normative):**

- Session-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests in this endpoint family require `mdcms_csrf` cookie plus matching `x-mdcms-csrf-token` header, except for `/api/v1/auth/login`, `/api/v1/auth/sign-up/email`, `/api/v1/auth/sign-in/email`, and `/api/v1/auth/cli/login/*`.
- API-key authenticated routes in this endpoint family are exempt from CSRF validation.
- CSRF validation failures return `FORBIDDEN` (`403`).

| Method | Path                                             | Auth Mode             | Required Scope | Target Routing      | Request                                                                                 | Success                                                  | Deterministic Errors                                                                                                                                                                            |
| ------ | ------------------------------------------------ | --------------------- | -------------- | ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/auth/login`                             | public                | none           | none                | JSON: `{ email, password }`                                                             | `200` `{ data: { session, csrfToken } }` + `set-cookie`  | `INVALID_INPUT` (`400`), `AUTH_INVALID_CREDENTIALS` (`401`), `AUTH_BACKOFF_ACTIVE` (`429`), `INTERNAL_ERROR` (`500`), `FORBIDDEN_ORIGIN` (`403`)                                                |
| GET    | `/api/v1/auth/session`                           | session               | none           | none                | session cookie                                                                          | `200` `{ data: { session, csrfToken } }`                 | `UNAUTHORIZED` (`401`), `FORBIDDEN_ORIGIN` (`403`)                                                                                                                                              |
| GET    | `/api/v1/auth/get-session`                       | session               | none           | none                | session cookie                                                                          | `200` `{ data: { session, csrfToken } }`                 | `UNAUTHORIZED` (`401`), `FORBIDDEN_ORIGIN` (`403`)                                                                                                                                              |
| GET    | `/api/v1/me/capabilities`                        | session_or_api_key    | none           | project+environment | session cookie or `Authorization: Bearer <mdcms_key_...>` plus explicit target routing  | `200` `{ data: { project, environment, capabilities } }` | `UNAUTHORIZED` (`401`), `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `FORBIDDEN_ORIGIN` (`403`)                                                                         |
| GET    | `/api/v1/me/projects`                            | session               | none           | none                | session cookie                                                                          | `200` `{ data: ProjectSummary[] }`                       | `UNAUTHORIZED` (`401`)                                                                                                                                                                          |
| POST   | `/api/v1/auth/logout`                            | session               | none           | none                | session cookie                                                                          | `200` `{ data: { revoked: boolean } }`                   | `FORBIDDEN` (`403`), `INTERNAL_ERROR` (`500`)                                                                                                                                                   |
| POST   | `/api/v1/auth/users/:userId/sessions/revoke-all` | session (admin/owner) | none           | none                | `userId` path param                                                                     | `200` `{ data: { userId, revokedSessions } }`            | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                                |
| GET    | `/api/v1/auth/users`                             | session (admin/owner) | none           | none                | session cookie                                                                          | `200` `{ data: UserWithGrants[] }`                       | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                                                                                     |
| GET    | `/api/v1/auth/users/:userId`                     | session (admin/owner) | none           | none                | `userId` path param                                                                     | `200` `{ data: UserWithGrants }`                         | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                                |
| POST   | `/api/v1/auth/users/invite`                      | session (admin/owner) | none           | none                | JSON: `{ email, grants[] }`                                                             | `200` `{ data: { id, email, expiresAt } }`               | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `INVALID_INPUT` (`400`), `CONFLICT` (`409`)                                                                                                        |
| GET    | `/api/v1/auth/invites`                           | session (admin/owner) | none           | none                | session cookie                                                                          | `200` `{ data: PendingInvite[] }`                        | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                                                                                     |
| DELETE | `/api/v1/auth/invites/:inviteId`                 | session (admin/owner) | none           | none                | `inviteId` path param                                                                   | `200` `{ data: { revoked: true } }`                      | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `CONFLICT` (`409`)                                                                                                            |
| POST   | `/api/v1/auth/invites/:token/accept`             | public                | none           | none                | JSON: `{ name, password }`                                                              | `200` `{ data: { userId } }`                             | `NOT_FOUND` (`404`), `CONFLICT` (`409`), `GONE` (`410`), `VALIDATION_ERROR` (`400`)                                                                                                             |
| PATCH  | `/api/v1/auth/users/:userId/grants`              | session (admin/owner) | none           | none                | JSON: `{ grants[] }`                                                                    | `200` `{ data: UserWithGrants }`                         | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `INVALID_INPUT` (`400`)                                                                                                       |
| DELETE | `/api/v1/auth/users/:userId`                     | session (admin/owner) | none           | none                | `userId` path param                                                                     | `200` `{ data: { removed: true } }`                      | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                                |
| GET    | `/api/v1/auth/api-keys`                          | session               | none           | none                | session cookie                                                                          | `200` `{ data: ApiKeyMetadata[] }`                       | `UNAUTHORIZED` (`401`)                                                                                                                                                                          |
| POST   | `/api/v1/auth/api-keys`                          | session               | none           | none                | JSON: `{ label, scopes[], contextAllowlist[], expiresAt? }`                             | `200` `{ data: { key, ...metadata } }` (key shown once)  | `UNAUTHORIZED` (`401`), `INVALID_INPUT` (`400`), `FORBIDDEN` (`403`), `INTERNAL_ERROR` (`500`)                                                                                                  |
| POST   | `/api/v1/auth/api-keys/:keyId/revoke`            | session               | none           | none                | `keyId` path param                                                                      | `200` `{ data: ApiKeyMetadata }`                         | `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                                |
| POST   | `/api/v1/auth/api-keys/self/revoke`              | api_key               | none           | none                | `Authorization: Bearer <mdcms_key_...>`                                                 | `200` `{ data: { revoked: true, keyId } }`               | `UNAUTHORIZED` (`401`)                                                                                                                                                                          |
| POST   | `/api/v1/auth/sign-up/email`                     | public                | none           | none                | better-auth sign-up payload                                                             | better-auth success payload                              | better-auth deterministic auth/provider errors                                                                                                                                                  |
| POST   | `/api/v1/auth/sign-in/email`                     | public                | none           | none                | better-auth sign-in payload                                                             | better-auth success payload                              | better-auth deterministic auth/provider errors                                                                                                                                                  |
| POST   | `/api/v1/auth/sign-out`                          | session               | none           | none                | better-auth sign-out payload                                                            | better-auth sign-out payload                             | better-auth deterministic auth/provider errors                                                                                                                                                  |
| POST   | `/api/v1/auth/sign-in/sso`                       | public                | none           | none                | JSON: `{ providerId, callbackURL, errorCallbackURL?, newUserCallbackURL?, loginHint? }` | `302` redirect to configured provider sign-in URL        | `INVALID_INPUT` (`400`), `SSO_PROVIDER_NOT_CONFIGURED` (`404`), `INTERNAL_ERROR` (`500`)                                                                                                        |
| GET    | `/api/v1/auth/sso/callback/:providerId`          | public                | none           | none                | OIDC callback query per Better Auth SSO flow                                            | `302` redirect to validated callback URL + `set-cookie`  | `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `AUTH_OIDC_REQUIRED_CLAIM_MISSING` (`401`), `SSO_PROVIDER_NOT_CONFIGURED` (`404`), `AUTH_PROVIDER_ERROR` (`502`), `INTERNAL_ERROR` (`500`)     |
| POST   | `/api/v1/auth/sso/saml2/sp/acs/:providerId`      | public                | none           | none                | form or body: `SAMLResponse`, optional `RelayState`                                     | `302` redirect to validated callback URL + `set-cookie`  | `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `AUTH_SAML_REQUIRED_ATTRIBUTE_MISSING` (`401`), `SSO_PROVIDER_NOT_CONFIGURED` (`404`), `AUTH_PROVIDER_ERROR` (`502`), `INTERNAL_ERROR` (`500`) |
| GET    | `/api/v1/auth/sso/saml2/sp/metadata`             | public                | none           | none                | query: `providerId`, optional `format` enum (`xml` or `json`)                           | `200` provider-specific SP metadata                      | `INVALID_INPUT` (`400`), `SSO_PROVIDER_NOT_CONFIGURED` (`404`)                                                                                                                                  |

### User Management Type Shapes

**UserWithGrants:**

```typescript
{
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
  grants: UserGrant[];
}
```

**UserGrant:**

```typescript
{
  id: string;
  role: "owner" | "admin" | "editor" | "viewer";
  scopeKind: "global" | "project" | "folder_prefix";
  project: string | null;
  environment: string | null;
  pathPrefix: string | null;
  createdAt: string;
}
```

**PendingInvite:**

```typescript
{
  id: string;
  email: string;
  grants: GrantInput[];
  createdAt: string;
  expiresAt: string;
}
```

**Invite grant input:**

```typescript
{
  role: "admin" | "editor" | "viewer";
  scopeKind: "global" | "project" | "folder_prefix";
  project?: string;       // required when scopeKind is "project" or "folder_prefix"
  environment?: string;   // optional
  pathPrefix?: string;    // required when scopeKind is "folder_prefix"
}
```

Invite grants never accept `owner`; ownership is assigned only through explicit
grant updates by an existing owner.

**User grant update input:**

```typescript
{
  role: "owner" | "admin" | "editor" | "viewer";
  scopeKind: "global" | "project" | "folder_prefix";
  project?: string;       // required when scopeKind is "project" or "folder_prefix"
  environment?: string;   // required when scopeKind is "folder_prefix"
  pathPrefix?: string;    // required when scopeKind is "folder_prefix"
}
```

`owner` and `admin` grants must use `global` scope. Only an existing global
owner may grant the `owner` role. Updates that would remove or demote the final
active owner are rejected deterministically.

**ProjectSummary:**

```typescript
{
  id: string;
  slug: string;
  name: string;
  environmentCount: number;
  createdAt: string;
}
```

## OIDC Sign-In Semantics

- MDCMS uses the Better Auth SSO plugin route family under `/api/v1/auth/*` for OIDC sign-in and callback handling.
- OIDC sign-in initiation is restricted to explicit `providerId` selection. MDCMS does not expose email/domain-based provider resolution.
- `providerId` on `POST /api/v1/auth/sign-in/sso` must match a startup-configured provider profile.
- `callbackURL`, `errorCallbackURL`, and `newUserCallbackURL` must be either:
  - relative application paths, or
  - absolute URLs whose origin matches `MDCMS_SERVER_URL`
- External callback origins are rejected with `INVALID_INPUT` (`400`).
- The default OIDC callback route is `/api/v1/auth/sso/callback/:providerId`.
- Callback success issues the same session authentication contract used for email/password login.
- Provider token exchange, userinfo retrieval, or callback validation failures return `AUTH_PROVIDER_ERROR` (`502`) unless a stricter deterministic error above applies.
- Requests targeting unsupported or unconfigured provider profiles remain deny-by-default and return `SSO_PROVIDER_NOT_CONFIGURED` (`404`).
- Verification must include a deterministic fixture matrix covering:
  - `okta`
  - `azure-ad`
  - `google-workspace`
  - `auth0`
  - missing required-claim failures
  - unconfigured-provider rejection

## SAML Sign-In Semantics

- MDCMS uses the Better Auth SSO plugin route family under `/api/v1/auth/*` for SAML SP-initiated sign-in and ACS handling.
- SAML sign-in initiation is restricted to explicit `providerId` selection. SAML and OIDC share `POST /api/v1/auth/sign-in/sso`; `providerId` must match a startup-configured provider profile.
- `callbackURL`, `errorCallbackURL`, and `newUserCallbackURL` follow the same validation rules used for OIDC:
  - relative application paths, or
  - absolute URLs whose origin matches `MDCMS_SERVER_URL`
- External callback origins are rejected with `INVALID_INPUT` (`400`).
- The canonical SAML ACS route is `/api/v1/auth/sso/saml2/sp/acs/:providerId`.
- The canonical SAML SP metadata route is `/api/v1/auth/sso/saml2/sp/metadata?providerId=<providerId>&format=xml|json`.
- Callback success issues the same session authentication contract used for email/password and OIDC login.
- SAML is SP-initiated only in MVP. IdP-initiated responses are rejected.
- InResponseTo validation is required for SAML sign-in responses.
- Assertion timestamp conditions are required for accepted SAML sign-in responses.
- Assertion or response signatures must validate against the configured IdP certificate for the targeted provider profile.
- Assertion validation failures, replay detection, issuer mismatch, signature or certificate failures, and other provider-side SAML failures return `AUTH_PROVIDER_ERROR` (`502`) unless a stricter deterministic error above applies.
- Requests targeting unsupported or unconfigured provider profiles remain deny-by-default and return `SSO_PROVIDER_NOT_CONFIGURED` (`404`).
- Verification must include deterministic SAML coverage for:
  - configured-provider happy path
  - missing required-attribute failures
  - unsolicited IdP response rejection
  - replay rejection
  - unconfigured-provider rejection

## CLI Browser Login Endpoints

| Method | Path                               | Auth Mode              | Required Scope | Target Routing | Request                                                                                     | Success                                                                                                                                   | Deterministic Errors                                                                                                                                                                                             |
| ------ | ---------------------------------- | ---------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/auth/cli/login/start`     | public                 | none           | none           | JSON: `{ project, environment, redirectUri, state, scopes? }`                               | `200` `{ data: { challengeId, authorizeUrl, expiresAt } }`                                                                                | `INVALID_INPUT` (`400`), `INTERNAL_ERROR` (`500`)                                                                                                                                                                |
| GET    | `/api/v1/auth/cli/login/authorize` | public (session-aware) | none           | none           | query: `challenge`, `state`                                                                 | `200` HTML login form when session missing; or `302` JSON `{ data: { redirectTo } }` + `Location` when authorization succeeds immediately | `NOT_FOUND` (`404`), `LOGIN_CHALLENGE_EXPIRED` (`410`), `LOGIN_CHALLENGE_USED` (`409`), `INVALID_LOGIN_EXCHANGE` (`400`)                                                                                         |
| POST   | `/api/v1/auth/cli/login/authorize` | public (session-aware) | none           | none           | query: `challenge`, `state`; credentials via form or JSON `{ email, password }` when needed | `302` JSON `{ data: { redirectTo } }` + `Location`; may also set session cookie                                                           | `AUTH_INVALID_CREDENTIALS` (`401`), `AUTH_BACKOFF_ACTIVE` (`429`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `LOGIN_CHALLENGE_EXPIRED` (`410`), `LOGIN_CHALLENGE_USED` (`409`), `INVALID_LOGIN_EXCHANGE` (`400`) |
| POST   | `/api/v1/auth/cli/login/exchange`  | public                 | none           | none           | JSON: `{ challengeId, state, code }`                                                        | `200` `{ data: { key, ...ApiKeyMetadata } }`                                                                                              | `INVALID_INPUT` (`400`), `NOT_FOUND` (`404`), `LOGIN_CHALLENGE_EXPIRED` (`410`), `LOGIN_CHALLENGE_USED` (`409`), `INVALID_LOGIN_EXCHANGE` (`400`)                                                                |

**One-time semantics (normative):**

- Challenge TTL is 10 minutes.
- `state` is validated against stored hash.
- Authorization code is single-use.
- Exchange succeeds only for `authorized` challenge state and then transitions challenge to `exchanged`.

## Current Principal Capabilities Endpoint

`GET /api/v1/me/capabilities` returns the effective capabilities of the current caller for the explicitly routed target `(project, environment)`.

This endpoint is an introspection surface:

- it does not mutate state
- it does not require a separate operation scope of its own
- it evaluates the same authorization model used by content, schema, settings, and user-management routes
- insufficient privileges resolve to `false` capability values instead of a `FORBIDDEN` response

Request routing follows the shared target-routing contract and must provide both:

- `X-MDCMS-Project` (or `?project=...`)
- `X-MDCMS-Environment` (or `?environment=...`)

Success response:

```json
{
  "data": {
    "project": "marketing-site",
    "environment": "staging",
    "capabilities": {
      "schema": {
        "read": true,
        "write": false
      },
      "content": {
        "read": true,
        "readDraft": true,
        "write": true,
        "publish": true,
        "unpublish": true,
        "delete": true
      },
      "users": {
        "manage": false
      },
      "settings": {
        "manage": false
      }
    }
  }
}
```

Normative semantics:

- `project` and `environment` in the response echo the resolved explicit routing target; they are target identifiers, not database row IDs.
- Session callers receive capabilities derived from their effective grants for the target project/environment.
- API-key callers receive capabilities derived from the key's operation scopes plus tuple allowlist.
- For API-key callers, explicit routing outside the key allowlist fails with `TARGET_ROUTING_MISMATCH` (`400`) instead of returning a capability payload.
- `schema.write` corresponds to the same authorization required by `PUT /api/v1/schema`.
- `schema.read` corresponds to the same authorization required by `GET /api/v1/schema`.
