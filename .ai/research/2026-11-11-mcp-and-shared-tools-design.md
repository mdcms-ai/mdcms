# MCP Server and Shared Agent Tools: Design

Date: 2026-11-11
Status: All five sub-projects designed.
Supersedes the deferral in `2026-05-01-ai-integration-mcp-scope.md`.

## Goal

Agents work with MDCMS content through the Model Context Protocol with the
same reach as a person in Studio, and the Studio Assistant and MCP share one
tool implementation instead of maintaining two. Every change records who made
it and through which client, and Studio shows that in version history.

Delivered surfaces:

- A remote MCP server on the MDCMS server (Streamable HTTP), authorized with
  OAuth 2.1 as the MCP authorization specification requires, so hosted agent
  clients can connect.
- `mdcms mcp` in the CLI: a stdio server for local agent clients that bridges
  to the remote MCP server with the CLI's credentials.
- The Studio Assistant running on the same tool definitions.

## Current state

- **Assistant tools.** Defined and executed on the server in
  `packages/modules/core.ai` (`chat-tools.ts`, Vercel AI SDK). Read tools
  return data to the model; write tools produce proposals that a person
  accepts in Studio. Proposals are applied by `core.ai/src/server/apply.ts`,
  which writes to the content store directly rather than through the content
  routes.
- **CLI MCP preview.** `apps/cli/src/lib/mcp.ts` registers seven tools that
  call the HTTP content API with an API key and write directly.
- **Attribution.** `documents.created_by` / `updated_by` and
  `document_versions.published_by` are `uuid` columns. Content routes fill
  them from optional request body fields (`createdBy`, `updatedBy`,
  `actorId`) and otherwise use `DEFAULT_ACTOR`
  (`content-api/types.ts`). Studio and the CLI send none of those fields, so
  stored actors are almost always `DEFAULT_ACTOR`. User ids are `text`. No
  record of the client exists. Webhook payloads resolve the actor from the
  authenticated principal (`actorFromAuthorizedRequest` in `auth.ts`), so
  webhooks and stored rows disagree.
- **OAuth.** better-auth 1.5.1 ships `mcp`, `oidcProvider` and `jwt`
  plugins; none is enabled. The `mcp` plugin does not bind tokens to a
  resource (RFC 8707), does not check access token expiry, and stores tokens
  and client secrets in plaintext, so it is not used as-is. The CLI login
  flow (`/api/v1/auth/cli/login/*`) already has a challenge table, hashed
  codes, a server-rendered login form with backoff, and mint-time scope
  checks that an authorization server can build on.
- **API-key reach.** Users, invites, API keys, environment create and delete,
  and media settings are session-only endpoints today.

## Decisions

1. **One server-hosted tool registry.** Each tool is defined once on the
   server: name, description, input schema, output schema, required scope,
   and a handler. Handlers call domain services (starting with a content
   service) that the HTTP routes also call, so authorization, attribution,
   validation and lifecycle events apply to every path.
2. **Per-surface write policy.** The Assistant exposes write tools as
   proposals, as SPEC-014 requires; proposal application goes through the
   same content service. MCP surfaces execute writes directly; the agent
   client's own approval prompt is the human gate.
3. **The CLI bridges, it does not reimplement.** `mdcms mcp` relays stdio to
   the server's MCP endpoint. Tools that need the local working copy (for
   example schema sync from `mdcms.config.ts`) run in the CLI and are added
   to the bridged tool list.
4. **Remote MCP uses OAuth 2.1.** Protected resource metadata,
   authorization server metadata, dynamic client registration, PKCE (S256
   only), resource-bound access tokens, refresh tokens, a consent screen,
   hashed token storage, and a Studio page to see and revoke connected
   applications. API keys remain valid bearer credentials for the MCP
   endpoint so the CLI bridge and scripts work without OAuth.
5. **Attribution: last change plus publishes.** See sub-project 1.
6. **Client identity: verified plus declared.** See sub-project 1.

## Sub-projects

Built in this order; each has its own spec delta, plan and review.

1. Change attribution (this document).
2. Shared tool layer: content service, tool registry, Assistant migration
   onto the registry, proposal application through the content service with
   the apply-time checks SPEC-014 requires (authorization, expiry, draft
   revision, schema, MDX).
3. Remote MCP endpoint and OAuth 2.1 authorization server.
4. CLI stdio bridge, a Node-compatible CLI entry point, and release.
5. Tool coverage for every Studio and Assistant operation, then docs, the
   public skills pack, an end-to-end MCP test in CI, and verification with
   real agent clients.

## Sub-project 1: change attribution

### Rule

The server derives the actor from authentication, never from the request
body:

- Session: the session user.
- API key: the user who created the key.
- OAuth access token (sub-project 3): the user who authorized the client.

Actor fields in request bodies (`createdBy`, `updatedBy`, `actorId`) are
accepted for compatibility and ignored. `DEFAULT_ACTOR` remains only for
`system` writes such as seeding and migrations.

### Change origin

A shared contract, `ContentChangeOrigin`, in `@mdcms/shared`, stored next to
each actor:

| Field           | Values                                           | Source                                    |
| --------------- | ------------------------------------------------ | ----------------------------------------- |
| `channel`       | `studio`, `studio_ai`, `mcp`, `api`, `system`    | Verified by the server                    |
| `credential`    | `session`, `api_key`, `oauth`, `system`          | Verified by the server                    |
| `apiKeyId`      | API key id, when `credential` is `api_key`       | Verified by the server                    |
| `oauthClientId` | OAuth client id, when `credential` is `oauth`    | Verified by the server (sub-project 3)    |
| `declared`      | Client name and version, for example `cli/1.4.0` | Reported by the client; shown as reported |

Channel derivation:

- `studio`: session requests to content routes, and collaboration autosave
  and publish.
- `studio_ai`: the Assistant's proposal apply and undo endpoints.
- `mcp`: tool calls through the server's MCP endpoint. `declared` is the MCP
  client's `clientInfo` name and version from `initialize`.
- `api`: any other API-key request. `declared` comes from the optional
  `X-MDCMS-Client` request header. The CLI sends
  `cli/<version>`. The read-only SDK does not send this header.
- `system`: server-internal writes.

`declared` is limited to 120 printable ASCII characters; longer or invalid values
are dropped, not rejected.

Known limitation: an Assistant proposal accepted while a live collaboration
room is open is applied in the browser and reaches the server as an ordinary
collaborative edit, so it is recorded as `studio` by the accepting user.

### Storage

One migration:

- `documents.created_by`, `documents.updated_by` and
  `document_versions.published_by` change from `uuid` to `text`. Existing
  values are kept.
- `documents.created_origin`, `documents.updated_origin` and
  `document_versions.published_origin` are added as nullable `jsonb`.
- Existing rows keep `DEFAULT_ACTOR` and a null origin. Studio shows them as
  "Unknown". There is no backfill; the information was never stored.

### Write paths

Content routes build `{ actor, origin }` from the authorized request and
pass it to every store operation: create (including translation variants),
update, publish, unpublish, soft delete, restore, version restore,
duplicate, and each bulk action. Store methods take the actor as a required
argument instead of an optional payload field. The collaboration runtime
passes the writer's user id and session origin directly; the conversion that
replaced non-UUID ids with `DEFAULT_ACTOR` is removed. The Assistant's apply
and undo paths pass the accepting user with channel `studio_ai`.

### API and events

All additions are optional fields on existing responses:

- Document responses: `createdOrigin`, `updatedOrigin`.
- Version list and version detail: `publishedOrigin`. Single-document GET
  and version lists also return an optional `users` map
  (`{ [userId]: { name, email } }`) like the content list's.
- Webhook payloads: `origin` from the document's `updatedOrigin`, next to
  the existing `user`.

### Studio

- History tab: each version shows the author's name and the channel, for
  example "Ada Lovelace · MCP (claude-code 1.2)". Declared names are labeled
  as reported by the client.
- Document properties: "Last edited by <name> via <channel>".
- Content list and Trash already render authors from `updatedBy`; they
  become accurate without changes.

### Specs to update

- SPEC-003: actor rule, change origin, column types, response fields.
- SPEC-005: `X-MDCMS-Client`, actor derivation per credential.
- SPEC-010: webhook `origin`.
- SPEC-007: collaboration attribution.
- SPEC-014: Assistant attribution and the live-room limitation.

### Tests

- Store and route tests: the actor comes from the principal for sessions and
  API keys; body actor fields are ignored.
- One test per channel, including `declared` parsing and limits.
- Migration contract test for the column type changes.
- Studio history and properties rendering with and without origin.
- Webhook payload includes `origin`.

### Out of scope

- An activity log of draft edits.
- Backfilling historical actors.
- Attribution for media, webhooks and environments (they already record the
  principal or are covered by later sub-projects).

## Sub-project 2: shared tool layer

### In-process dispatch

Tool handlers do not call the content store. They send requests to the
server's own HTTP handler in process, with the caller's credentials, so every
tool call goes through the same routing, authorization (including path-scoped
grants), validation, schema-hash gate, collaboration guard, attribution and
lifecycle events as an external request. There is one implementation of each
operation: the route.

- `createInternalDispatcher(handler)` builds requests against the in-process
  handler. Internal requests carry an `X-MDCMS-Internal` header whose value is
  a random secret generated at server start and never sent to clients. The
  server strips the header from every external request before routing, so
  only in-process callers can set it.
- On internal requests only, two more headers are trusted:
  `X-MDCMS-Internal-Channel` (`studio_ai` or `mcp`) and the declared client
  name. `attributionFromAuthorizedRequest` reads them; external requests
  cannot change the channel.
- The caller's credential is forwarded: the `Authorization` header for API
  keys and OAuth tokens; the session cookie and CSRF token for Studio
  sessions.

### Tool registry

`apps/server/src/lib/agent-tools/` holds the registry. A tool definition has:
`name`, `title`, `description`, Zod `inputSchema` and `outputSchema`,
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), the
required scopes, and `execute(input, context)`. `context` provides the
target `(project, environment)` and the dispatcher. Each tool lives in a file
per area (`content.ts`, `versions.ts`, `translations.ts`, `schema.ts`,
`media.ts`, `environments.ts`, `webhooks.ts`).

- Frontmatter validation against the synced schema moves from the CLI to
  `@mdcms/shared` so the CLI, the tools and the Assistant share one
  implementation. Write tools validate before dispatching and fail with
  `INVALID_FRONTMATTER` without writing.
- MDX bodies are syntax-checked with the parser the Assistant already uses.
  Component catalog validation applies only where a catalog exists (the
  Assistant, which receives it from Studio); the server does not store one.

### The Assistant on the registry

- The Assistant's read tools are the registry's `list_documents`,
  `get_document` and `get_schema`, adapted to the AI SDK. `find_entries` and
  `get_entry` are removed, and the system prompt uses the new names.
- Proposal tools stay Assistant-specific: they produce proposals, as SPEC-014
  requires. Applying and undoing a proposal dispatches the matching content
  request in process with channel `studio_ai`, instead of writing to the
  store directly. Apply re-checks expiry, validation status, schema and MDX
  on every path, including proposals sent back by the browser.
- The host passes the adapted tools to `core.ai` through its module deps, so
  `packages/modules` does not depend on server code.

## Sub-project 3: remote MCP and OAuth 2.1

### Endpoint

- `POST /api/v1/mcp` (and `GET`/`DELETE` as the transport requires) uses the
  SDK's `WebStandardStreamableHTTPServerTransport` in stateless mode with JSON
  responses: one MCP server instance per request, tools listed from the
  registry filtered by the caller's scopes.
- Target: an API key request names `(project, environment)` with the usual
  headers or query parameters. An OAuth token carries its target, chosen at
  consent; no headers are needed, because hosted clients cannot send custom
  headers.
- The MCP client's `clientInfo` name and version become the declared client
  name, and the channel is `mcp`.
- An unauthenticated request gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="<server>/.well-known/oauth-protected-resource/api/v1/mcp"`.

### Authorization server

Built on MDCMS's own auth, not better-auth's `mcp` plugin, which lacks
resource binding, expiry checks and hashed storage.

- Metadata: `/.well-known/oauth-protected-resource/api/v1/mcp` (RFC 9728)
  and `/.well-known/oauth-authorization-server` (RFC 8414).
- `POST /api/v1/oauth/register`: dynamic client registration (RFC 7591) for
  public clients (`token_endpoint_auth_method: none`). Redirect URIs must be
  HTTPS or loopback HTTP. Client names are shown as unverified.
- `GET /api/v1/oauth/authorize`: authorization code flow with PKCE (`S256`
  only) and the `resource` parameter (RFC 8707), which must be the MCP
  endpoint URL. A user without a session signs in with the existing
  server-rendered form. A consent page shows the client name, its redirect
  host, a target picker limited to the user's grants, and access levels; the
  granted scopes can never exceed what the user's role allows, using the
  same check as API key issuance.
- `POST /api/v1/oauth/token`: `authorization_code` and `refresh_token`
  grants. Access tokens last one hour, refresh tokens 30 days and rotate on
  use. Both are random, prefixed (`mdcms_oat_`, `mdcms_ort_`) and stored as
  SHA-256 hashes.
- `POST /api/v1/oauth/revoke` (RFC 7009).
- `authorizeRequest` accepts an OAuth access token only on the MCP endpoint
  and on internal requests dispatched from it, and only when its `resource`
  is the MCP endpoint. The principal is `{ type: "oauth", clientId, userId,
scopes, target }`; attribution uses credential `oauth` and the client id.
- Studio Settings gains "Connected apps": the user's authorized clients
  (admins see the project's), with scopes, target, last use, and revoke.

## Sub-project 4: CLI bridge

- `mdcms mcp` starts a stdio MCP server and connects to the server's MCP
  endpoint with the SDK's `StreamableHTTPClientTransport`, the resolved API
  key, and the target headers. `tools/list` and `tools/call` are relayed.
  The upstream connection's `clientInfo` is the local agent's, so attribution
  shows the agent's name.
- `sync_schema` stays a CLI-local tool, because it reads `mdcms.config.ts`
  from disk; it is appended to the relayed tool list.
- The CLI's published entry point runs on Node.js as well as Bun, so
  `npx mdcms mcp` works for agents that spawn it without Bun installed.

## Sub-project 5: coverage, docs and verification

Tools, each mapped to an existing route:

| Area         | Tools                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content      | `list_documents`, `get_document`, `create_document`, `update_document` (frontmatter patch, body, path move), `duplicate_document`, `delete_document`, `restore_document` |
| Publishing   | `publish_document`, `unpublish_document`                                                                                                                                 |
| Versions     | `list_versions`, `get_version`, `restore_version`                                                                                                                        |
| Translations | `list_translations`, `create_translation`                                                                                                                                |
| Schema       | `get_schema`; `sync_schema` in the CLI only                                                                                                                              |
| Media        | `list_media`, `get_media`, `upload_media` (base64, size-capped), `delete_media`                                                                                          |
| Environments | `list_environments`, `clone_environment`, `promote_documents` (with dry run)                                                                                             |
| Webhooks     | `list_webhooks`, `create_webhook`, `update_webhook`, `delete_webhook`, `list_webhook_deliveries`                                                                         |

Not exposed to agents: user, invite, role and API key management, and
environment creation and deletion. These change who can access the
instance and stay with people in Studio.

Also in this sub-project: a standalone MCP spec, docs pages for local and
remote setup, updates to the public skills pack, an MCP end-to-end test in
the integration job, and connection checks with real agent clients.
