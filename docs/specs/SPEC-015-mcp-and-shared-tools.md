---
status: live
canonical: true
created: 2026-11-11
last_updated: 2026-11-11
---

# SPEC-015 MCP and Shared Tools

## Ownership

This specification owns the shared agent tool registry, in-process dispatch,
remote MCP transport and tool contracts. SPEC-005 owns OAuth and authorization;
SPEC-008 owns the CLI bridge; SPEC-014 owns Assistant proposals. Domain route
contracts in SPEC-003, SPEC-004, SPEC-009 and SPEC-010 remain authoritative for
persistence, responses and domain errors. Tools do not create a second store API.

## Shared execution boundary

Every tool executes through the existing server HTTP handler in process. The
caller supplies no arbitrary URL, HTTP headers or credential in tool arguments.
The dispatcher fixes the origin, target and allowed route from the tool
registration and encodes every path segment and query value. It forwards the
caller's bearer credential, or session cookie and CSRF token. It never substitutes
an administrative credential. Every dispatched request repeats authorization,
including current per-user path grants, validation, schema-hash checks,
collaboration locks, revision checks, attribution and lifecycle events.

The server creates a random internal secret at startup. External ingress removes
all `X-MDCMS-Internal*` headers before routing. Only the private dispatcher can
supply `X-MDCMS-Internal` and `X-MDCMS-Internal-Channel`. Internal dispatch enters
behind that stripping boundary; it must not re-enter external ingress. Channel
is `mcp` or `studio_ai`. Secret comparison and channel trust happen together;
missing or invalid trust never authorizes an OAuth token on a domain route.
Secrets, cookies and bearer tokens are never returned or logged.

The registry is server-owned under `apps/server/src/lib/agent-tools/`. Each entry
has a unique stable name, title, description, Zod input and output schemas,
required scopes, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and an
executor receiving the authenticated request context and dispatcher. Scope
filtering in tool discovery is not authorization: execution checks again.
The Assistant receives adapted read tools and content dispatch interfaces through
module dependencies; modules never import server implementation files.

Frontmatter validation is a pure shared utility in `@mdcms/shared`, shared with
CLI validation. Validation reports all errors as `INVALID_FRONTMATTER` before
writing. Unknown types return `UNKNOWN_TYPE`. MDX syntax is checked before writes
using the Assistant parser. Component catalog checks apply when a catalog is
provided by Studio; the remote server does not invent or persist a catalog.

## Remote transport contract

| Method | Path          | Auth mode        | Required scope | Routing                                                    | Request                                                              | Success                                               | Errors                                                                                                                            |
| ------ | ------------- | ---------------- | -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/mcp` | api_key_or_oauth | Per tool       | API key: explicit project/environment; OAuth: token target | MCP JSON-RPC initialize, ping, notifications, tools/list, tools/call | 200 JSON-RPC result; accepted notifications 202 empty | 401 UNAUTHORIZED; 403 FORBIDDEN_ORIGIN or FORBIDDEN; 400 MISSING_TARGET_ROUTING or TARGET_ROUTING_MISMATCH; protocol errors below |
| GET    | `/api/v1/mcp` | api_key_or_oauth | none           | Same as POST                                               | No body                                                              | No standalone SSE stream                              | 405 with Allow: POST after auth/routing; same auth errors as POST                                                                 |
| DELETE | `/api/v1/mcp` | api_key_or_oauth | none           | Same as POST                                               | No body                                                              | No stateful session to delete                         | 405 with Allow: POST after auth/routing; same auth errors as POST                                                                 |

Use `WebStandardStreamableHTTPServerTransport` with JSON responses and no session
ID generator. Create and close one server/transport per request. Do not require a
prior initialize request in process memory. Do not advertise resumability,
subscriptions or server-initiated requests. Validate Origin using SPEC-005's
allowlist whenever present. Negotiate the supported MCP protocol version and
validate `MCP-Protocol-Version` on subsequent requests through the SDK. CORS permits
that header and exposes `WWW-Authenticate` and `Retry-After`, including on
errors. SPEC-005 owns canonical-origin validation, preflight handling and the
shared Origin allowlist; allowed preflights do not require bearer credentials. Malformed JSON is JSON-RPC -32700,
invalid requests -32600, unknown methods -32601 and invalid tool parameters or
unknown tool names -32602. Protocol parsing must not execute tools.

An unauthenticated request returns 401 and
`WWW-Authenticate: Bearer resource_metadata="<server>/.well-known/oauth-protected-resource/api/v1/mcp"`.
Expired, revoked or wrong-resource tokens also return 401. A valid credential with
insufficient scope returns 403 with a Bearer `insufficient_scope` challenge when
rejected at the HTTP boundary. Tool-level domain failures use the result below.

### Declared identity in stateless requests

`initialize.clientInfo` is unverified, request-local metadata. It cannot be
remembered by a later request's server instance. Never cache it by bearer token,
OAuth client ID, IP or target: multiple agent clients may share these values.
For attribution on tools/call, clients may repeat `{ name, version }` in
`params._meta["ai.mdcms/clientInfo"]`. The bridge supplies its downstream client's
initialize identity there on each upstream tool call. Render as `name/version`,
using SPEC-005's printable ASCII and 120-character limits; invalid values are
omitted. A client that does not repeat identity has no declared name on its writes.
No value here proves identity or affects access. The verified `mcp` channel,
credential kind and OAuth client ID remain available independently.

## Tool contracts

All inputs are strict JSON objects. `?` means optional. IDs and paths are nonempty
strings validated by the destination route; versions are positive integers.
`schemaHash` is a nonempty string forwarded as `X-MDCMS-Schema-Hash`. Required
schemaHash inputs must never be replaced with a freshly fetched hash. Read tools
return the complete route JSON envelope, including pagination and user maps.
Mutation tools return the complete route JSON envelope. Every output schema is
that owning route's response schema, wrapped by the MCP result below. All tools
use the authenticated target; target override arguments are rejected.

In the table, `C` is `/api/v1/content`, `E` is `/api/v1/environments`, `W` is
`/api/v1/webhooks`. `documentId`, `version` and `id` substitute only encoded path
segments. No actor fields are accepted. All domain errors and statuses from the
mapped endpoint's owning spec are preserved, without rewriting them to success.

| Tool                    | Input schema                                                                                                                            | Route                                        | Scopes and response                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| list_documents          | `{type?, locale?, q?, path?, isDeleted?:boolean, published?:boolean, hasUnpublishedChanges?:boolean, limit?:integer, offset?:integer}`  | GET C with draft=true                        | content:read:draft; document list envelope                                                            |
| get_document            | `{documentId}`                                                                                                                          | GET C/:documentId?draft=true                 | content:read:draft; document envelope                                                                 |
| create_document         | `{type, path, frontmatter:object, body:string, locale, format?:unknown, schemaHash}`                                                    | POST C                                       | schema:read, content:write; document envelope                                                         |
| update_document         | `{documentId, frontmatter?:object, body?:string, path?:string, schemaHash}`                                                             | GET draft then PUT C/:documentId             | schema:read, content:read:draft, content:write; document envelope                                     |
| duplicate_document      | `{documentId, schemaHash}`                                                                                                              | POST C/:documentId/duplicate                 | content:write; document envelope                                                                      |
| delete_document         | `{documentId}`                                                                                                                          | DELETE C/:documentId                         | content:delete; soft-deleted document envelope                                                        |
| restore_document        | `{documentId, targetStatus?:"draft" or "published"}`                                                                                    | POST C/:documentId/restore                   | content:write for draft, content:publish for published; document envelope                             |
| publish_document        | `{documentId, changeSummary?:string}`                                                                                                   | POST C/:documentId/publish                   | content:publish; document envelope                                                                    |
| unpublish_document      | `{documentId}`                                                                                                                          | POST C/:documentId/unpublish                 | content:publish; document envelope                                                                    |
| list_versions           | `{documentId, limit?:integer, offset?:integer}`                                                                                         | GET C/:documentId/versions                   | content:read; version list envelope                                                                   |
| get_version             | `{documentId, version:integer}`                                                                                                         | GET C/:documentId/versions/:version          | content:read; version document envelope                                                               |
| restore_version         | `{documentId, version:integer, targetStatus?:"draft" or "published"}`                                                                   | POST C/:documentId/versions/:version/restore | content:write for draft, content:publish for published; document envelope                             |
| list_translations       | `{documentId}`                                                                                                                          | GET C/:documentId/variants                   | content:read; translation variant envelope                                                            |
| create_translation      | `{sourceDocumentId, type, path, locale, frontmatter:object, body:string, format?:unknown, schemaHash}`                                  | POST C                                       | schema:read, content:write; document envelope                                                         |
| get_schema              | `{}`                                                                                                                                    | GET /api/v1/schema                           | schema:read; types, schemaHash and syncedAt envelope                                                  |
| list_media              | `{q?, category?, uploadedBy?, uploadedFrom?, uploadedTo?, sort?, order?, limit?:integer, offset?:integer}`                              | GET /api/v1/media                            | media:read; assets, pagination and storage envelope                                                   |
| get_media               | `{id}`                                                                                                                                  | GET /api/v1/media/:id                        | media:read; asset envelope                                                                            |
| upload_media            | `{filename:string, mimeType:string, base64:string}`                                                                                     | POST /api/v1/media/upload multipart file     | media:upload; asset envelope                                                                          |
| delete_media            | `{id}`                                                                                                                                  | DELETE /api/v1/media/:id                     | media:delete; deleted/id envelope                                                                     |
| list_environments       | `{}`                                                                                                                                    | GET E                                        | environments:read plus current global admin/owner; environment summaries and meta envelope            |
| clone_environment       | `{targetEnvironmentId, sourceEnvironmentId, include:{content:boolean, settings:boolean}, includeDrafts:boolean, preservePaths:boolean}` | POST E/:targetEnvironmentId/clone            | environments:clone plus SPEC-009 source/settings scopes; targetEnvironmentId/documentsCloned envelope |
| promote_documents       | `{targetEnvironmentId, sourceEnvironmentId, documentIds:string[], includeUnpublished:boolean, dryRun:boolean}`                          | POST E/:targetEnvironmentId/promote          | environments:promote, content:read:draft, schema:read; promoted results envelope                      |
| list_webhooks           | `{}`                                                                                                                                    | GET W                                        | webhooks:read; webhook list envelope                                                                  |
| create_webhook          | `WebhookCreateInput` from SPEC-010                                                                                                      | POST W                                       | webhooks:write; webhook envelope                                                                      |
| update_webhook          | `{id, ...WebhookUpdateInput}` from SPEC-010                                                                                             | PUT W/:id                                    | webhooks:write; webhook envelope                                                                      |
| delete_webhook          | `{id}`                                                                                                                                  | DELETE W/:id                                 | webhooks:write; deleted/id envelope                                                                   |
| list_webhook_deliveries | `WebhookDeliveryHistoryQuery` from SPEC-010                                                                                             | GET W/deliveries                             | webhooks:read; delivery history envelope                                                              |

String fields without an explicit type in the table are strings. Domain enums,
limits, required fields and defaults are exactly those in the owning route spec.
Content list limit defaults to 20, maximum 100; offset defaults to 0.
Restore defaults to draft. Missing both frontmatter, body and path on update is
INVALID_INPUT. Updates read the draft, shallow-merge frontmatter (null deletes a
key), validate the merged document and send the read draftRevision. Concurrent
changes fail with STALE_DRAFT_REVISION (409), never an automatic retry. Moving a
path must satisfy grants for both the source and destination. Create locale and
format follow SPEC-003 and SPEC-009; locale cannot be guessed from a user identity.
Compatibility `format` inputs are accepted and ignored. Validation infers the
format from the resulting body before checking MDX syntax, including updates
and Assistant writes through the shared tools.
Create requires an explicit locale, including `__mdcms_default__` for a
non-localized type. Missing locale is rejected before dispatch with INVALID_INPUT.

Media upload requires canonical base64; malformed encoding returns INVALID_INPUT
(400). Reject encoded bodies above the bounded decoded limit before allocation.
Maximum decoded tool upload is 10 MiB or the configured media limit, whichever is
lower; excess returns MEDIA_UPLOAD_TOO_LARGE (413). No URL fetching or filesystem
reads are available through upload_media. The domain upload validates MIME type
and storage settings normally. Webhook tools preserve URL/SSRF restrictions and
never expose stored secrets in results.

Environment clone/promote require authorization on both source and destination.
OAuth's immutable target must equal the destination; its granting user's current
source grants and SPEC-009's explicit source-read requirements still apply.
Clone requires content:read plus schema:read for published-only content, and also
content:read:draft when copying mutable heads. Settings copy requires source
schema:read and destination schema:write. Promote always requires source
content:read:draft and schema:read, even when includeUnpublished=false. Resolve
the destination ID and require equality with the authenticated target before
loading source data or dispatching any mutation; validate both source/destination
paths in the transaction. API keys must allow both environment tuples. This is not a
general target override. list_environments is available to API-key and OAuth MCP
callers holding environments:read whose credential user currently has global
admin/owner privileges. Its strict input is `{}`; it dispatches GET
/api/v1/environments with the authenticated project. API-key MCP requests retain
explicit project/environment routing; OAuth uses its immutable target. Discovery
filters by scope and current role, and execution rechecks both. The output is the
SPEC-009 EnvironmentListResponse envelope, including definitions metadata. It
lists only the granting user's visible environment metadata in that project;
listing another environment does not authorize its content or change the token
target. Missing scope or current role returns FORBIDDEN (403); routing mismatch
returns TARGET_ROUTING_MISMATCH (400). Other errors follow SPEC-009. The tool is
read-only, non-destructive and idempotent. Environment create/delete remain
session-only and are not exposed as tools.
User, invitation, role, API key and environment create/delete operations are not
agent tools. Studio-only configuration and proposal acceptance stay human actions.

### Results and errors

Success is `{ content: [{ type: "text", text: JSON.stringify(envelope) }],
structuredContent: envelope, isError: false }`. Domain failure is
`{ content: [{ type: "text", text: JSON.stringify({code, message, status, details?}) }],
isError: true }`. Never include credentials or internal stack traces. Preserve
SCHEMA_HASH_REQUIRED (400), SCHEMA_NOT_SYNCED (409), SCHEMA_HASH_MISMATCH (409),
DOCUMENT_COLLABORATION_ACTIVE (409), path/translation conflicts (409), FORBIDDEN
(403), NOT_FOUND (404), and other owning route errors. Local validation adds
INVALID_FRONTMATTER (422), UNKNOWN_TYPE (400), INVALID_MDX (422). An unexpected
internal failure is INTERNAL_ERROR (500) with a generic message.

Read tools have readOnlyHint=true, destructiveHint=false, idempotentHint=true.
Mutation tools have readOnlyHint=false; delete, restore, publish, unpublish,
update, clone and promote have destructiveHint=true. Mutation idempotentHint is
false unless the route explicitly guarantees repeated execution without further
side effects. Dry run does not make a generally mutating tool read-only.

## Verification and operator workflow

Remote clients connect to `<server>/api/v1/mcp` using OAuth consent or an API key
with explicit target headers. Local clients use SPEC-008's stdio bridge with two local tools:
sync_schema and the read-only get_credentials_info capabilities diagnostic.
The diagnostic is an explicit exception to remote registry ownership, performs
only a target-bound capabilities read, and does not implement remote content
operations. The remote inventory remains 27 tools; the bridge adds these two. Schema-changing work first syncs schema, reads the resulting
hash, then passes that hash to write tools. Reads do not silently acknowledge a
schema change on behalf of a caller.

Tests must execute registry tools against actual mounted routes, prove path-grant
isolation, spoofed internal-header rejection, schema and revision conflicts,
collaboration guards and lifecycle attribution. OAuth tests cover concurrent code
redemption, refresh replay, revoked grants and cross-resource/target attempts.
Integration CI runs a real MCP client through initialize, list, read, write and
denial cases. Real agent-client connection checks are separately recorded; unit
or SDK tests do not establish those results.

## Protocol references

The transport follows [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
Authorization discovery follows [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
