---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-11-11
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

MDCMS supports the following auth modes:

- **Studio/browser clients:** session authentication (better-auth) by default. Embedded Studio may also use bearer API key authentication when the host selects Studio token mode.
- **SDK/CLI/machine clients:** API key authentication.
- **Remote MCP clients:** resource-bound OAuth bearer tokens or API keys. OAuth tokens are accepted only at the MCP boundary and its trusted internal dispatch.
- **Collaboration socket:** Studio session authentication only. API keys are not accepted.

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

All environment-scoped requests (content, schema, environments, migrations, collaboration sockets, and any future search/webhook routes) must explicitly include both target project and target environment. Project-scoped management requests (e.g., create/list environments) must include explicit project target.

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

Collaboration socket connections use query parameters on connect:

```
wss://<host>/api/v1/collaboration?project=marketing-site&environment=staging&documentId=<uuid>
```

The browser must send a valid Studio session cookie; API keys are not accepted on that endpoint.

### Client Identification Header

Clients may send `X-MDCMS-Client: <name>/<version>` (for example
`cli/0.4.0`) on any request. The value is recorded as the `declared` part of
the change origin for content writes (SPEC-003 "Change Attribution"). It is
informational, never used for authorization, and ignored when it is empty,
longer than 120 characters, or contains characters outside printable ASCII.
Surrounding whitespace is trimmed. The MDCMS CLI sends it on every request to
the configured server.

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
  - `X-MDCMS-Client`

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
    "createdBy": "user-id",
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

Content writes made with a session are attributed to the session user (SPEC-003 "Change Attribution").

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
- Session lifetime: 7-day rolling inactivity timeout with a 30-day absolute max age.
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

#### Collaboration Socket Authentication

Collaboration sockets are authenticated with the same Studio session cookie as the Studio runtime. API keys are rejected for collaboration endpoints even when a key has content scopes:

- Document-room URL: `/api/v1/collaboration?project=...&environment=...&documentId=...`
- Presence-stream URL: `/api/v1/collaboration/presence?project=...&environment=...`
- `Origin` must match the configured Studio allowlist.
- Session cookie is validated through better-auth during the WebSocket handshake.
- `project` and `environment` are required for every collaboration socket.
- `documentId` is required for document-room sockets and forbidden on the presence stream.
- For document-room sockets, the target document must belong to the requested `(project, environment)` scope.
- Folder/path RBAC (`documents.path`) is evaluated before subscribing the socket to the document room. Presence-stream snapshots are filtered to documents the subscriber can read in the routed target.
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
- Content writes made with an API key are attributed to the key's creator, with the key id in the change origin (SPEC-003 "Change Attribution").

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
  - `media:read`
  - `media:upload`
  - `media:delete`
  - `webhooks:read`
  - `webhooks:write`
  - `environments:read`
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

| Role       | Capabilities                                                                                                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Full access. Cannot be removed. Manages instance-level settings, billing (future SaaS), and can assign all roles. Always instance-wide.                                                                                                                                                                 |
| **Admin**  | User management and environment management, including clone and promote (both instance-wide Admin only), settings, read-only schema browsing, schema sync, all content operations, and destructive media operations. Can assign Editor and Viewer roles. Granted instance-wide or for a single project. |
| **Editor** | Create, edit, publish, unpublish, and delete content. Can browse schema read-only and upload media for assigned project contexts. Limited to assigned folders for document operations.                                                                                                                  |
| **Viewer** | Read-only access to CMS dashboard, schema, content, and media metadata. Can view content but not modify. Limited to assigned folders for document operations.                                                                                                                                           |

**Folder-level assignment:**

- Roles are assigned per user per logical content path prefix (e.g., "Alice is an Editor for `blog/*`", where `blog/*` maps to `documents.path`).
- A user can have different roles for different folders.
- Permissions cascade: access to `blog/` includes access to `blog/posts/`, `blog/drafts/`, etc.
- If multiple grants apply, the most permissive grant wins.
- Owner is always instance-wide. Admin is instance-wide or project-scoped. Neither can be folder-scoped.

### Project-Scoped and Global Authorization

Permissions can be assigned at two levels:

- **Global (instance-wide):** a role assigned globally applies to all projects that exist on the instance, including future projects.
- **Project-scoped:** a role assigned to a specific project applies only to that project. A user may therefore have different roles on different projects.

When both global and project-scoped roles exist, the most permissive applicable role wins for that project.

Which scopes each role may be granted with:

| Role     | Global | Project | Folder prefix |
| -------- | ------ | ------- | ------------- |
| `owner`  | yes    | no      | no            |
| `admin`  | yes    | yes     | no            |
| `editor` | yes    | yes     | yes           |
| `viewer` | yes    | yes     | yes           |

Grants that pair a role with a scope it does not support are rejected
(`VALIDATION_ERROR`, `400`, on the user management endpoints).

A project-scoped Admin has Admin capabilities for targets inside that project
only: content operations, schema sync, media deletion, environment management,
project settings, and issuing API keys whose allowlist stays inside the
project. A project-scoped Admin has no access to other projects.

User management is instance-level. Listing users, inviting users, changing
grants, removing users, and revoking another user's sessions require an
instance-wide Admin or Owner grant. A project-scoped Admin cannot perform them,
and the capabilities endpoint reports `users.manage = false` for a caller whose
only Admin grant is project-scoped.

`projects:write` is evaluated against the project the request creates or
changes, not against the routed project (see SPEC-004 "Project and Environment
Management Endpoints"). A project-scoped Admin grant may name a project slug
that does not exist yet; its holder may then create exactly that project. This
is how an operator reserves a project for a user in advance.

API keys follow the same project/environment scoping model through tuple allowlists:

- a global key is represented as an allowlist containing all `(project, environment)` tuples
- a restricted key contains only explicitly granted tuples
- request routing remains explicit; keys authorize access but do not select the route target

Schema authorization semantics:

- `schema:read` authorizes read-only schema browsing for the target `(project, environment)`.
- `schema:write` authorizes explicit schema sync for the target `(project, environment)`.

Media authorization semantics:

- Media assets are project-scoped and reusable across environments, but media API requests still require explicit `(project, environment)` routing so authorization is evaluated through the same target contract as Studio and content APIs.
- `media:read` authorizes reading media metadata in the routed project.
- `media:upload` authorizes storing new media assets in the routed project.
- `media:delete` authorizes destructive deletion of media metadata and the corresponding object storage asset in the routed project.
- Session callers derive `media.read` from viewer-or-higher access to the routed project, `media.upload` from editor-or-higher access to the routed project, and `media.delete` from admin/owner access. Folder-prefix grants never grant project-wide media deletion.
- API-key callers require the matching media operation scope and an allowlist tuple matching the explicit `(project, environment)` routing target.
- `schema:write` is reserved to `admin` and `owner`.
- `editor` and `viewer` may receive `schema:read`, but never `schema:write`.
- API key issuance rejects reserved scopes that the authorizing session may not grant. In particular, non-admin and non-owner sessions cannot mint or authorize API keys with `schema:write`.

Environment authorization semantics:

- `environments:read` authorizes read-only environment metadata discovery in one
  routed project through the SPEC-009 list endpoint. Only a global `admin` or
  `owner` may issue this scope to an API key or consent to it for OAuth. An
  `editor`, `viewer` or folder-prefix grant cannot issue or exercise it.
- At every bearer list request, require `environments:read` and re-check that the
  API key creator or OAuth granting user still has global admin/owner privileges.
  Possession of the scope alone never replaces the role check. Role removal
  yields `FORBIDDEN` (`403`) even if the credential remains otherwise valid.
- An API-key list request requires explicit project routing and at least one
  context-allowlist tuple for that project. If an environment is also supplied,
  it must match an allowed tuple. An OAuth list request is accepted only through
  trusted MCP dispatch, derives project from the immutable token target, and
  rejects conflicting project or environment routing. No external REST OAuth
  access is added.
- Listing returns only metadata for environments in the routed project visible
  to that current user. This project-scoped metadata read may include environment
  names other than the credential's selected environment. It does not add those
  environments to an API key's context allowlist or OAuth target, authorize their
  content, or permit any mutation. SPEC-009 owns the response and error contract.
- Environment create/delete remain session-only admin/owner actions. The read
  scope does not imply `environments:clone` or `environments:promote`, and those
  scopes do not imply `environments:read`. Existing login default scopes do not
  automatically acquire the new read scope.

- `environments:clone` authorizes cloning content from a source environment into a target environment of the routed project.
- `environments:promote` authorizes promoting documents from a source environment into a target environment of the routed project.
- Session callers derive both from admin/owner access. `editor` and `viewer` sessions are denied with `FORBIDDEN` (`403`).
- API key issuance rejects `environments:clone` and `environments:promote` for non-admin and non-owner sessions.

Session authorization is deny-by-default: a session caller is denied any operation scope that no role holds, and API key issuance rejects such a scope for every session.

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
      "media": {
        "read": true,
        "upload": true,
        "delete": false
      },
      "users": {
        "manage": false
      },
      "settings": {
        "manage": false
      },
      "ai": {
        "use": true
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
- `media.read`, `media.upload`, and `media.delete` correspond to the same authorization required by `GET /api/v1/media/:id`, `POST /api/v1/media/upload`, and `DELETE /api/v1/media/:id`.

## MCP OAuth Authorization (Normative)

OAuth grants are distinct from the CLI browser-login API-key flow. The canonical
resource is `${MDCMS_SERVER_URL}/api/v1/mcp`, derived from trusted startup
configuration, never Host or forwarded request headers. OAuth tokens do not grant
access to externally called REST routes, Studio or collaboration sockets.

### Principal and storage

An OAuth principal contains `{ type: "oauth", clientId, userId, scopes, target }`.
Target is exactly one project/environment chosen at consent and immutable for the
whole grant and refresh family. Supplied routing must match it; a mismatch is
TARGET_ROUTING_MISMATCH (400). Omitted routing resolves from the token only for
OAuth. API-key explicit routing requirements remain unchanged.

Effective authorization intersects token scopes, consented target and the user's
current grants, including path rules. Use the same scope-issuance rules as API
keys; never expand a path-scoped grant to project-wide access. Re-check grants at
consent, redemption, refresh and every operation. Deleted users, revoked grants,
expired tokens and invalid resources fail closed. Attribution is the granting
user, credential oauth and verified oauthClientId; declared names remain untrusted.

Codes, access tokens, refresh tokens and consent handles are generated with at
least 256 bits of cryptographic randomness and persisted only as SHA-256 hashes.
Access tokens use `mdcms_oat_` and expire after at most 3600 seconds, capped by
the remaining absolute family lifetime. Compute issuance time once and return
the actual positive integer expires*in matching the persisted expiry. Refresh
with less than one full second remaining returns invalid_grant. Refresh tokens use
`mdcms_ort*` and expire after 30 days; rotation never extends the original family's
absolute expiry. Authorization codes expire after 5 minutes and are single-use.
Atomic conditional consumption prevents concurrent code/refresh redemption.
Refresh reuse revokes the entire family including access tokens. Grant revocation
invalidates all its families immediately. Never persist or log raw credentials.

### HTTP endpoint contracts

OAuth protocol endpoints use OAuth JSON, not the domain `{data}` envelope. Token
responses include Cache-Control: no-store and Pragma: no-cache. All endpoint URLs
in metadata are absolute and use the configured canonical origin.

| Method | Path                                               | Auth mode                                                     | Scope            | Routing                    | Request                                                                               | Success                                                                                                 | Deterministic errors                                                                                                                                                               |
| ------ | -------------------------------------------------- | ------------------------------------------------------------- | ---------------- | -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/.well-known/oauth-protected-resource/api/v1/mcp` | public                                                        | none             | none                       | none                                                                                  | 200 `{resource, authorization_servers:[issuer], scopes_supported, bearer_methods_supported:["header"]}` | 500 server_error for invalid server configuration                                                                                                                                  |
| GET    | `/.well-known/oauth-authorization-server`          | public                                                        | none             | none                       | none                                                                                  | 200 metadata described below                                                                            | 500 server_error for invalid server configuration                                                                                                                                  |
| POST   | `/api/v1/oauth/register`                           | public                                                        | none             | none                       | JSON registration below                                                               | 201 registered public client                                                                            | 400 invalid_redirect_uri or invalid_client_metadata; 429 rate_limit_exceeded; 503 temporarily_unavailable                                                                          |
| GET    | `/api/v1/oauth/authorize`                          | session, with sign-in if absent                               | requested scopes | target selected at consent | Query authorization request below                                                     | 200 server-rendered sign-in/consent; approved redirect is issued by consent POST                        | 400 invalid_request, invalid_client, invalid_scope, unsupported_response_type, invalid_target; 429 rate_limit_exceeded; 503 temporarily_unavailable                                |
| POST   | `/api/v1/oauth/authorize`                          | session plus CSRF                                             | requested scopes | consent target             | Form `{consent, decision:"allow" or "deny", project, environment, scope?, csrfToken}` | 303 to registered redirect with code/state or error/state                                               | 401 UNAUTHORIZED; 403 FORBIDDEN; 400 invalid_request, invalid_scope, invalid_target; 410 invalid_request for expired consent; 429 rate_limit_exceeded; 503 temporarily_unavailable |
| POST   | `/api/v1/oauth/token`                              | public client identified by client_id and proof below         | grant scopes     | immutable stored target    | application/x-www-form-urlencoded token request below                                 | 200 token response below                                                                                | 400 invalid_request, invalid_grant, invalid_scope, invalid_target, unsupported_grant_type; 401 invalid_client; 429 rate_limit_exceeded; 503 temporarily_unavailable                |
| POST   | `/api/v1/oauth/revoke`                             | public client identified by client_id and possession of token | none             | stored grant               | Form `{client_id, token, token_type_hint?:"access_token" or "refresh_token"}`         | 200 empty, including unknown/already-revoked token                                                      | 400 invalid_request; 401 invalid_client; 429 rate_limit_exceeded; 503 temporarily_unavailable                                                                                      |
| GET    | `/api/v1/oauth/connections`                        | session                                                       | none             | explicit project           | no body                                                                               | 200 `{data: OAuthConnection[]}`                                                                         | MISSING_TARGET_ROUTING (400), UNAUTHORIZED (401), FORBIDDEN (403)                                                                                                                  |
| DELETE | `/api/v1/oauth/connections/:id`                    | session plus CSRF                                             | none             | explicit project           | path id                                                                               | 200 `{data:{id, revoked:true}}`                                                                         | MISSING_TARGET_ROUTING (400), UNAUTHORIZED (401), FORBIDDEN (403), NOT_FOUND (404)                                                                                                 |

Metadata includes issuer, authorization_endpoint, token_endpoint,
registration_endpoint, revocation_endpoint, response_types_supported=["code"],
grant_types_supported=["authorization_code","refresh_token"],
token_endpoint_auth_methods_supported=["none"],
code_challenge_methods_supported=["S256"] and scopes_supported containing only
issuable existing MDCMS operation scopes. Dynamic registration is supported;
client-ID metadata document fetching is not advertised.

Registration accepts `{client_name, redirect_uris:string[],
token_endpoint_auth_method:"none", grant_types?:["authorization_code","refresh_token"],
response_types?:["code"]}`. client_name is nonempty printable text up to 120
characters and displayed escaped as unverified. Require 1 to 10 distinct absolute
redirect URIs, HTTPS or HTTP with literal loopback host 127.0.0.1 or [::1]. Reject
userinfo, fragments, wildcards, non-loopback HTTP and unsupported client metadata.
No client secret is generated. Response is `{client_id, client_id_issued_at,
client_name, redirect_uris, token_endpoint_auth_method:"none", grant_types,
response_types}`. Registered redirect matching is exact, except that an HTTP redirect on literal
127.0.0.1 or [::1] may use a different port during authorization, as required by
[RFC 8252 section 7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3).
Only the port may differ: scheme, literal host, path and query must match. IPv4
and IPv6 loopback hosts are not interchangeable. HTTPS redirects have no port
exception. Store the concrete authorized redirect URI, including its selected
port, in consent and code records. Token redemption requires that exact URI;
the registration-time port exception must never apply to redemption.

Authorization query requires response_type=code, client_id, redirect_uri, scope
(space-delimited operation scopes), code_challenge, code_challenge_method=S256,
resource and state. Reject missing/invalid values. Validate redirect before any
redirect response; an invalid redirect gets a local error page, never a redirect.
S256 challenge is base64url SHA-256 with no padding. Unsupported resource returns
invalid_target. An opaque consent handle expires 10 minutes after creation,
without sliding renewal, and binds the validated request to
the signed-in user and session; sign-in completion must bind the handle to that
user/session before consent without extending its original expiresAt. An expired
handle requires a new authorization request.
GET never grants access. POST verifies the session, CSRF cookie/form token and
consent ownership, then atomically consumes the handle. Switching users requires
fresh consent. The page shows escaped client name, redirect host, target options
limited to the user's grants and requested access levels. A denial redirects with
error=access_denied and unchanged state. Approval redirects with code and unchanged
state. Neither form fields nor callback query may replace client, redirect,
resource, challenge or requested scopes stored in the consent record.

Code exchange requires grant_type=authorization_code, client_id, code,
redirect_uri, code_verifier and resource. Verifier is 43 to 128 RFC 7636 unreserved
characters. Check client, exact concrete authorized redirect (including loopback port),
resource, expiry, unconsumed status and
S256 proof atomically before issuing. Failure is invalid_grant except malformed
parameters (invalid_request), wrong resource (invalid_target) or unknown client
(invalid_client). Refresh requires grant_type=refresh_token, client_id,
refresh_token and resource, with optional scope limited to the existing grant.
No request may change target or expand scopes. Response is `{access_token,
token_type:"Bearer", expires_in:positive_integer_up_to_3600, refresh_token, scope}`. Error responses are
`{error, error_description?}` with no token or account information.

Revoking a recognized token owned by the supplied client revokes its grant and
families. Unknown tokens or tokens belonging to another client return empty 200
without affecting another client's grant. Studio connection deletion uses the same
revocation operation. OAuthConnection is `{id, clientId, clientName, userId,
project, environment, scopes:string[], createdAt:string, lastUsedAt:string|null}`;
it never contains tokens, hashes or redirect secrets. Members see their own
connections in the target project; project admins/owners may see and revoke all
connections there. Cross-project or inaccessible IDs return NOT_FOUND. Repeated
revocation of an accessible stored connection succeeds idempotently.

Rate-limit registration, authorization, token and revocation endpoints using
bounded server-side counters; return Retry-After on 429. Production OAuth requires
HTTPS. Existing session CSRF protections remain mandatory for consent and Studio
revocation; token and registration endpoints do not use session authentication.

### Canonical Origin Configuration

MDCMS_SERVER_URL is a typed, validated server setting and the single source for
auth base URL, OAuth issuer, metadata endpoint URLs and the MCP resource. It is an
absolute origin: HTTP or HTTPS scheme, host and optional valid port only. Trim
outer whitespace; permit an absent path or one trailing slash and normalize to
URL.origin with no trailing slash. Reject username/password, other paths, query,
fragment, invalid/empty hosts, non-HTTP schemes and malformed ports with INVALID_ENV
at boot. Never fall back after an explicitly supplied invalid value.

With NODE_ENV=production, MDCMS_SERVER_URL is required and must be HTTPS;
missing, empty or HTTP values fail boot with INVALID_ENV. TLS may terminate at a
trusted reverse proxy while the process listens on HTTP, but the configured
external origin must still be HTTPS. There is no request-header inference or
HTTP production bypass. In development/test, an absent value defaults to
http://localhost:<validated PORT>, with PORT defaulting to 4000. Explicit HTTP
origins are allowed only in development/test. These server-origin rules do not
remove the HTTP loopback redirect exception for native clients.

The environment example documents the local development origin and production
HTTPS requirement. Docker Compose must forward MDCMS_SERVER_URL into the server
container; an absent/empty forwarded value counts as absent in development/test
and fails in production. OAuth and existing auth use the same parsed ServerEnv
value, rather than independent raw-environment resolvers. Changing the canonical
origin changes the OAuth issuer/resource; tokens bound to the former resource
are rejected and clients reconnect and authorize against the new origin.

### OAuth and MCP External Ingress

Preserve server-rendered text/html error Responses at the exact
/api/v1/oauth/authorize path (GET and POST), as well as the existing CLI sign-in
path. Preserve status, content type and security/cache/rate-limit headers; do not
wrap the HTML in a domain JSON envelope. Render untrusted names and error text
escaped. OAuth JSON endpoints return explicit application/json Responses with
OAuth error bodies; shared error normalization must retain their status/body and
Cache-Control, Pragma and Retry-After. Do not throw a domain RuntimeError through
the outer handler for an already-classified OAuth protocol error.

Origin checks and CORS cover /api/v1/mcp, OAuth endpoints and the two discovery
metadata paths. Accept the configured canonical origin or a configured Studio
allowed origin; reject any other present Origin (including null) with 403
FORBIDDEN_ORIGIN. No-Origin native/server clients continue normally. Cross-origin
preflight is processed before bearer auth: an allowed OPTIONS returns 204 with
no body, the exact origin, Vary: Origin, allowed methods, and allowed headers.
Never use wildcard origin with credentials. In addition to the existing headers,
permit Accept, MCP-Protocol-Version and X-MDCMS-Client. Expose WWW-Authenticate and
Retry-After to browser callers, including on error responses. Session-based
consent and connection management still require their ordinary CSRF checks.

Do not add a blanket target guard to /.well-known or /api/v1/oauth or a pre-auth
project/environment guard on /api/v1/mcp. Discovery, registration and token flows
have no routing context. Connections enforce project routing at their own
boundary; MCP authenticates first and then resolves explicit API-key or stored
OAuth routing. Internal domain calls retain their ordinary target guards.

### Bounded Consent and Endpoint Throttling

Consent handles are single-use and expire at createdAt + 600 seconds, including
time spent signing in. At expiry, POST returns an escaped HTML 410 invalid_request
page with a restart instruction; no code is issued. A new consent GET creates a
new handle and never extends the previous handle's lifetime.

Use 60-second fixed-window counters shared across server instances in PostgreSQL.
Every request, successful or failed, consumes its endpoint-global counter. Also
count per known client ID for token/revoke and per signed-in user for consent POST,
with the same endpoint limit. Do not create per-value buckets for unregistered
client IDs. Counters expire after two windows; remove expired counters before
allocation and cap active counters at 10,000. At capacity or store unavailability,
fail closed with 503 temporarily_unavailable and Retry-After: 60; do not disable
throttling or evict a live bucket. Limit changes apply on restart.

| Typed server setting             | Default requests per 60 seconds | Accepted integer range |
| -------------------------------- | ------------------------------- | ---------------------- |
| MDCMS_OAUTH_REGISTER_RATE_LIMIT  | 10                              | 1 to 100               |
| MDCMS_OAUTH_AUTHORIZE_RATE_LIMIT | 120                             | 1 to 1000              |
| MDCMS_OAUTH_TOKEN_RATE_LIMIT     | 300                             | 1 to 3000              |
| MDCMS_OAUTH_REVOKE_RATE_LIMIT    | 120                             | 1 to 1000              |

Invalid settings fail boot with INVALID_ENV. Count authorize GET and POST together.
Use atomic increment/check so concurrent instances cannot exceed a limit through
races. Limit exhaustion returns 429 rate_limit_exceeded with Retry-After equal to
the integer seconds until the current window ends (minimum 1), never a token or
code. Return OAuth JSON on machine endpoints and HTML on authorization pages,
with no-store. Password-entry backoff remains independently enforced. The local
environment example and Compose server environment document and forward these
settings. Logs must not include token, consent or verifier values.

### OAuth Storage Capacity and Retention

Registration admits at most 10,000 registered clients per instance database.
Admission is atomic across server processes. At capacity return
503 temporarily_unavailable with Retry-After: 60. Clients have no automatic expiry
or eviction. This is an operator capacity limit; no client-management endpoint
is defined. Registration throttling remains independent of this storage limit.

Cleanup uses indexed expiry predicates and bounded batches, never an unbounded
request-time sweep. Expired authorization codes and access tokens may be removed.
Consumed refresh token hashes must remain available for replay detection until
the family's original absolute expiry, including after rotation or revocation.
Grant and connection records remain available for idempotent revocation.

Expired consent payloads may be discarded, retaining a minimal hashed-handle
tombstone until 24 hours after expiry. Known expired handles, including consumed handles, return HTML 410
invalid_request. After tombstone retention, purged or unknown handles return HTML
400 invalid_request. Cleanup does not extend any credential or consent lifetime.

### Consent Sign-in Continuation

GET /api/v1/oauth/authorize?consent=<handle> resumes an existing consent request.
Exactly one consent parameter is accepted, with no other query parameters.
Duplicate handles or mixed OAuth parameters return invalid_request (400).
For a signed-in user, atomically bind an unbound, unexpired, unconsumed handle to
that user and session. Never rebind or extend expiry. A different bound user or
session receives FORBIDDEN (403) with fresh-start guidance. GET never issues code.

The same-origin sign-in page reuses POST /api/v1/auth/login and its password
backoff. Credentials stay in the POST body; the fetch rejects redirects. After
successful sign-in, navigate to the continuation URL for the existing handle.
HTML uses a restrictive CSP with a nonce for any inline script, same-origin
connect actions, and escaped unverified names and URLs. Sign-in and error pages
use `form-action 'self'`. Authenticated consent pages permit only `'self'` and
the already validated registered callback origin in `form-action`, allowing the
303 redirect after approval or denial. Construct that source with the parsed
callback URL's `origin`; never interpolate raw request headers or use wildcards.
The sign-in form declares `method="POST"` and the explicit same-origin
`/api/v1/auth/login` action, so disabling or blocking JavaScript never places
email or password in a URL. The sign-in CSP never permits the callback origin.

### OAuth Request Body Bound

POST bodies on /api/v1/oauth/authorize, /api/v1/oauth/register,
/api/v1/oauth/token and /api/v1/oauth/revoke are capped at 64 KiB. Enforce the
byte limit while reading the stream even without Content-Length; cancel excess
input. Oversized bodies return 413 invalid_request, as HTML on authorization and
OAuth JSON on machine endpoints. Consume the endpoint-global request counter
before allocating or parsing the body, including malformed and oversized bodies.
After resolving a known client or signed-in user, consume its separate bucket
without counting the global request again. Existing auth/login is unchanged.

### Explicit Consent Downscoping

For each available target, compute the subset of the immutable requested scopes
that the user's current grants permit issuing. Show the exact proposed granted
scopes and unavailable requested scopes. Offer Allow only for a nonempty subset.
Consent POST includes scope as the explicitly selected space-delimited subset
when decision=allow. Reject malformed spacing, duplicates, scopes outside the
stored request, and scopes no longer issuable in the selected target with
invalid_scope. Recheck the submitted selection; do not silently add newly granted
permissions or silently remove revoked ones. Unknown or unissuable protocol
scopes return invalid_scope even before target selection. Denial does not require
a scope selection. Store only the selected subset in the grant, return it in the
token response, and prohibit refresh scope expansion. This permits clients that
request all advertised scopes to receive a limited grant suited to an editor.

Authorization HTML uses `Referrer-Policy: same-origin`: same-origin form POSTs
retain a verifiable Origin while cross-origin callbacks receive no referrer.
The configured canonical origin is also trusted on `/api/v1/auth` browser routes,
including login and session calls, when a TLS proxy forwards an internal HTTP
request URL. Forwarded headers never establish trust; null and unknown origins
remain rejected, and the configured Studio origin allowlist remains supported.
