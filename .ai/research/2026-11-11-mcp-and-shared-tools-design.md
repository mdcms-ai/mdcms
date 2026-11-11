# MCP Server and Shared Agent Tools: Design

Date: 2026-11-11
Status: Sub-project 1 designed; sub-projects 2 to 5 outlined and designed separately.
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
  `cli/<version>` and the SDK sends `sdk/<version>`.
- `system`: server-internal writes.

`declared` is limited to 120 printable characters; longer or invalid values
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
- Version list and version detail: `publishedOrigin`, plus a `users` map
  (`{ [userId]: { name, email } }`) like the content list's.
- Webhook payloads: `origin` next to the existing `user`.

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
