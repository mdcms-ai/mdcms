---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-11-11
---

# SPEC-009 i18n and Environments

This is the live canonical document under `docs/`.

## Internationalization (i18n)

### Data Model

Localization is configured per content type via `defineType(..., { localized?: boolean })`. Every stored document still has a non-null `locale` string.

- For `localized: true` types, each locale variant is stored as a **separate document** (`document_id`) linked by a shared `translation_group_id`.
- For `localized: false` types, the document is stored as a single implicit-locale variant with locale `__mdcms_default__`.

Examples:

- `document_id: aaa`, `translation_group_id: ggg`, `path: "blog/hello-world"`, `locale: "en"`
- `document_id: bbb`, `translation_group_id: ggg`, `path: "blog/hello-world"`, `locale: "fr"`
- `document_id: ccc`, `translation_group_id: hhh`, `path: "authors/karol"`, `locale: "__mdcms_default__"` (non-localized type)

`translation_group_id` is preserved across environments (clone/promote), while `document_id` remains environment-local.

### Configuration

`locales.supported` is project-defined, not product-predefined. MDCMS accepts broad BCP 47 locale tags and normalizes tags canonically.

When explicit localization is used (`localized: true` on any type), locales are configured in `mdcms.config.ts`:

```typescript
locales: {
  default: "en-US",
  supported: ["en-US", "fr", "de", "ja"],
  aliases: {
    en_us: "en-US",
    EN: "en-US",
    fr_FR: "fr",
  },
}
```

If all types are non-localized, `locales` may be omitted. In that implicit single-locale mode, MDCMS uses reserved locale token `__mdcms_default__` internally and in API payloads.

### Editor UX

- A **locale switcher dropdown** is shown only for localized types (`localized: true`).
  The locale switcher is populated by merging two data sources: `GET /api/v1/content/:documentId/variants` (which locales already have variants) and the project's `locales.supported` configuration (the full set of available locales). Locales without an existing variant are shown with a creation indicator.
- Switching to an untranslated locale shows an option to create the variant (optionally pre-filled with the default locale's content).
  Variant creation uses `POST /api/v1/content` with the full create payload plus
  `sourceDocumentId` pointing at an existing non-deleted document in the same
  routed `project` and `environment`. The server derives
  `translation_group_id` from the source document.
- The content list indicates translation status for localized types (e.g., "2/4 locales translated").
- Non-localized types render as single-variant content with no locale switcher.
- When creating a new document for a localized type, the Studio creation dialog
  shows a locale picker populated from the project's configured
  `locales.supported` list. For non-localized types, no locale picker is shown
  and the document is created with the implicit default locale
  (`__mdcms_default__`).

### SDK Usage

```typescript
// Localized type
const postEn = await cms.get("BlogPost", {
  slug: "hello-world",
  locale: "en-US",
});
const postFr = await cms.get("BlogPost", { slug: "hello-world", locale: "fr" });

// List all posts in French (localized type)
const frenchPosts = await cms.list("BlogPost", { locale: "fr" });

// Non-localized type (locale omitted; server uses implicit single-locale token internally)
const author = await cms.get("Author", { slug: "karol" });
```

### CLI Behavior

`cms pull` supports mixed localized and non-localized mappings:

```
content/blog/hello-world.en-US.md
content/blog/hello-world.fr.mdx
content/pages/about.mdx
```

- Localized types: `<document.path>.<locale>.<ext>`
- Non-localized types: `<document.path>.<ext>`
- `cms init` brownfield import detects locale hints with precedence `frontmatter > filename suffix > folder segment`, normalizes tags, prompts for unresolved remaps, and persists remaps in `locales.aliases`.

---

## Content Environments

### Architecture

Environments are **logical partitions** within a project. MVP hierarchy is **Project → Environment**. Content rows include both `project_id` and `environment_id`.

**Hierarchy:**

- **Open-source (self-hosted):** `Project -> Environment`
- **Hosted version (future SaaS):** `Organization -> Project -> Environment`

The hosted organization layer is not part of MVP, but the data model must not preclude it. The `projects` table therefore reserves an optional `organization_id` column that is `NULL` for self-hosted installations and may become a foreign key in the hosted edition later.

Projects are the top-level isolation boundary. Each project owns:

- its content model (`mdcms.config.ts` schema types)
- its content rows and version history
- its environments
- its media files
- its webhook configurations

There is no cross-project content sharing or cross-project references.

The `mdcms.config.ts` declares which project it belongs to:

```typescript
export default defineConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",
  types: [...],
  environments: { ... },
});
```

**`projects` table:**

```sql
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,               -- NULL for self-hosted, populated for hosted version (future FK in hosted edition)
    name            TEXT NOT NULL,       -- Human-readable name
    slug            TEXT NOT NULL UNIQUE, -- URL-friendly identifier (matches config's `project` field)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      UUID NOT NULL
);
```

**`environments` table:**

```sql
CREATE TABLE environments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id),
    name        TEXT NOT NULL,           -- e.g., "production", "staging"
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by  UUID NOT NULL,
    CONSTRAINT unique_environment_id_project UNIQUE (id, project_id),
    CONSTRAINT unique_environment_per_project UNIQUE (project_id, name)
);
```

All content queries include both `project_id` and `environment_id` scope. API keys are checked against their allowed `(project, environment)` tuples.

### Default Environments

On initial setup, a `production` environment is created automatically. Additional environments (e.g., `staging`) are created via the Studio UI or API.

### Cloning

Cloning copies content from the source into an existing destination environment. Creating that destination is a separate session-only operation. The clone payload is **configurable**: the user chooses what to include:

- **Content** — Current mutable head rows (plus latest published snapshots when present), not full history
- **Settings** — Environment-level configuration
- **Media** — Post-MVP only; not part of the reduced MVP clone payload
- **Draft inclusion default:** `includeDrafts` defaults to `true` in clone requests.

Cloning is implemented as a bulk insert of new `documents` rows (new environment-local `document_id`s, preserved `translation_group_id`) and optionally their latest published `document_versions` rows.

API payload:

```json
{
  "sourceEnvironmentId": "uuid",
  "include": {
    "content": true,
    "settings": false
  },
  "includeDrafts": true,
  "preservePaths": true
}
```

Reference remapping during clone:

- References are remapped by `translation_group_id + locale` to target-environment document IDs.
- If any reference cannot be remapped, the clone operation fails atomically (no partial success, no null substitution).

### Promoting (Cross-Environment Sync)

Promoting copies content from one existing environment to another (e.g., staging → production). It operates **per-document with full overwrite** — no merge or conflict resolution.

**Workflow:**

1. In the Studio UI, user selects one or more documents in the source environment.
2. User chooses "Promote to..." and selects the target environment.
3. For each selected document:
   - If the document exists in the target (matched by `translation_group_id` + `locale`): the target's draft row is **overwritten** with source content, then published.
   - If the document does not exist in the target: a new draft row is **created** in the target (new `document_id`, preserved `translation_group_id`), then published.
4. A confirmation dialog shows exactly which documents will be overwritten in the target before executing.

**No merge conflict resolution** — source content wins. If the same document was edited in both environments, target content is replaced (recoverable in target version history).

Reference remapping during promotion:

- References are remapped by `translation_group_id + locale`.
- If any remap fails, the entire promotion fails atomically (no partial success).

**API endpoint:**

```
POST /api/v1/environments/:targetId/promote
{
  "sourceEnvironmentId": "uuid",
  "documentIds": ["uuid", "uuid", "..."],  // documents in the source environment
  "includeUnpublished": false,
  "dryRun": false
}
```

### Environment in API / SDK

```typescript
// SDK
const cms = createClient({
  serverUrl: "http://localhost:4000",
  apiKey: process.env.MDCMS_API_KEY,
  project: "marketing-site",
  environment: "staging",
});

// REST API — target routing is explicit
// X-MDCMS-Project: marketing-site
// X-MDCMS-Environment: staging
```

---

## Environment Endpoints

| Method   | Endpoint                          | Description                                       |
| -------- | --------------------------------- | ------------------------------------------------- |
| `GET`    | `/environments`                   | List all environments                             |
| `POST`   | `/environments`                   | Create an environment                             |
| `POST`   | `/environments/:id/clone`         | Clone an environment                              |
| `POST`   | `/environments/:targetId/promote` | Promote content from one environment into another |
| `DELETE` | `/environments/:id`               | Delete an environment                             |

## Environment Management Endpoints

All `/api/v1/environments*` endpoints require explicit project routing. Clone/promote remain MVP; clone does not include media in reduced scope. No update endpoint is defined for environments.

`EnvironmentSummary`:

```json
{
  "id": "uuid",
  "project": "marketing-site",
  "name": "staging",
  "extends": "production",
  "isDefault": false,
  "createdAt": "2026-03-11T12:00:00.000Z"
}
```

`EnvironmentDefinitionsMeta`:

```json
{
  "definitionsStatus": "ready",
  "configSnapshotHash": "sha256:abc123",
  "syncedAt": "2026-03-11T12:00:00.000Z"
}
```

Notes:

- `definitionsStatus` is `ready` or `missing`.
- `configSnapshotHash` and `syncedAt` are returned only when
  `definitionsStatus` is `ready`.

Rules:

- Environment management requires global `owner` or `admin` privileges. Create
  and delete accept only an authenticated Studio session. List accepts an
  admin/owner session or a bearer credential with `environments:read` whose API
  key creator or OAuth granting user currently retains global admin/owner
  privileges. OAuth is accepted only through trusted MCP dispatch, never on the
  externally called REST endpoint. Clone and promote accept either an
  authenticated Studio session with global `owner` or `admin` privileges or an
  API key holding the matching `environments:clone` or `environments:promote`
  scope. Session callers with only `editor` or `viewer` access receive
  `FORBIDDEN` (`403`).
- The latest synced project config snapshot derived from `mdcms.config.ts` is authoritative for valid environment names and `extends` chains.
- `GET /api/v1/environments` may return existing environment rows even when no synced project config snapshot is available yet. In that case:
  - `meta.definitionsStatus` is `missing`
  - `extends` may be `null` for rows whose parent chain cannot be derived from synced config
- `POST /api/v1/environments` may create the project row implicitly if it does not yet exist; any such provisioning must also ensure a default `production` environment row exists transactionally.
- `POST /api/v1/environments` accepts `{ name, extends? }`.
  - a synced project config snapshot must exist; otherwise the request fails with `CONFIG_SNAPSHOT_REQUIRED` (`409`)
  - `name` must be non-empty and unique within the routed project.
  - `name` must exist in the synced environment definitions for the routed project.
  - if `extends` is provided, it must exactly match the synced parent for that environment.
  - creating `production` succeeds only when that row is missing; otherwise it returns `CONFLICT`.
- `DELETE /api/v1/environments/:id`:
  - must reject deleting `production`
  - must reject deleting environments that still have content rows or schema sync state
  - returns `NOT_FOUND` when the environment id does not belong to the routed project
  - must not fail solely because the latest synced project config snapshot is missing

| Method | Path                                     | Auth Mode                                               | Required Scope                                                      | Target Routing                                                                    | Request                                                                                                  | Success                                                                  | Deterministic Errors                                                                                                                                                                             |
| ------ | ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/environments`                   | session_or_api_key; oauth only via trusted MCP dispatch | `environments:read` for bearer; global admin/owner for every caller | explicit `project` for session/API key; immutable token target for internal OAuth | routing only, no body                                                                                    | `200` `{ data: EnvironmentSummary[], meta: EnvironmentDefinitionsMeta }` | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                 |
| POST   | `/api/v1/environments`                   | session                                                 | none                                                                | required: `project`                                                               | JSON: `{ name, extends? }`                                                                               | `200` `{ data: EnvironmentSummary }`                                     | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `CONFIG_SNAPSHOT_REQUIRED` (`409`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `CONFLICT` (`409`)                                   |
| DELETE | `/api/v1/environments/:id`               | session                                                 | none                                                                | required: `project`                                                               | path `id`                                                                                                | `200` `{ data: { deleted: true, id } }`                                  | `MISSING_TARGET_ROUTING` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `CONFLICT` (`409`)                                                                           |
| POST   | `/api/v1/environments/:id/clone`         | session_or_api_key; oauth only via trusted MCP dispatch | `environments:clone` plus source/settings scopes below              | required: `project`                                                               | path `id`; JSON: `{ sourceEnvironmentId, include: { content, settings }, includeDrafts, preservePaths }` | `200` `{ data: { targetEnvironmentId, documentsCloned } }`               | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `REFERENCE_REMAP_FAILED` (`409`), `TARGET_ROUTING_MISMATCH` (`400`) |
| POST   | `/api/v1/environments/:targetId/promote` | session_or_api_key; oauth only via trusted MCP dispatch | `environments:promote` plus source/settings scopes below            | required: `project`                                                               | path `targetId`; JSON: `{ sourceEnvironmentId, documentIds, includeUnpublished, dryRun }`                | `200` `{ data: { promoted: DocumentPromotionResult[] } }`                | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `REFERENCE_REMAP_FAILED` (`409`), `TARGET_ROUTING_MISMATCH` (`400`) |

### Bearer Environment Listing

`GET /api/v1/environments` is a metadata discovery operation. It does not create
an environment, provision a project, read content, or modify the caller's target.
Session callers retain the existing global admin/owner requirement and explicit
project routing. Bearer callers must satisfy both the `environments:read` scope
and the same current global admin/owner requirement for the credential's user.

API keys send project using `X-MDCMS-Project` or `project` query routing. The key
must have at least one allowed tuple in that project. An optional supplied
environment must match an allowed tuple. For MCP, the outer request still requires
the explicit project/environment tuple defined in SPEC-015. OAuth internal
requests use the token's stored project/environment; a supplied value that differs
from either field is rejected. No tool argument may override this routing.

The success body uses the existing EnvironmentListResponse contract:

```ts
type EnvironmentListResponse = {
  data: {
    id: string;
    project: string;
    name: string;
    extends: string | null;
    isDefault: boolean;
    createdAt: string;
  }[];
  meta:
    | { definitionsStatus: "missing" }
    | {
        definitionsStatus: "ready";
        configSnapshotHash: string;
        syncedAt: string;
      };
};
```

Filter data to the routed project and the granting user's currently visible
environments before serialization. Global admin/owner currently sees all
existing environment rows in that project. Metadata discovery is project-scoped,
so the list can include environments outside the credential's selected tuple;
it grants no content access or mutation rights to those environments. Never
return rows from another project, credentials or config snapshot contents.
`extends` remains the parent environment name or null, and createdAt/syncedAt are
ISO timestamps. There is no pagination or additional request filter. No visible
rows returns an empty data array with the normal project definitions metadata.
Missing synced config uses definitionsStatus=missing rather than failing listing.

Deterministic errors use the normal domain error envelope:

- Missing required session/API-key project: MISSING_TARGET_ROUTING (400).
- Project outside an API key's allowed contexts, a supplied environment outside
  its tuples, or routing inconsistent with an OAuth token: TARGET_ROUTING_MISMATCH
  (400).
- Missing, invalid, expired or revoked credential, including OAuth presented to
  the external REST endpoint: UNAUTHORIZED (401).
- Missing environments:read on a bearer credential, or a credential user without
  current global admin/owner privileges: FORBIDDEN (403).

Listing with environments:read alone never authorizes clone/promote, which keep
independent operation scopes and source/destination checks. POST create and DELETE
environment remain session-only even for an admin-owned bearer credential.

### Clone and Promote Authorization Boundary

Before loading source payloads or mutating the destination, resolve both environment
IDs in the routed project. Missing or foreign-project IDs return NOT_FOUND (404).
The path destination ID must resolve to the environment named by any supplied
routing environment; mismatch returns TARGET_ROUTING_MISMATCH (400). An MCP call
always has a destination environment: explicit API-key routing or the immutable
OAuth token target. The resolved path destination must equal that environment.
Session and direct API-key requests with project-only routing use the resolved
path destination as their effective environment; this does not bypass allowlists.

Require environments:clone or environments:promote at the resolved destination,
plus the current granting user's global admin/owner role. For API keys, both source
and destination tuples must be allowed. For OAuth, source and destination must be
in the token's project and destination must equal the stored target. Source reads
are a narrowly defined part of this operation: intersect the token's scopes with
the granting user's current source grants. This does not permit an OAuth request
to route to the source as its target or to call arbitrary source-content tools.

Source permissions, also required for dry runs:

| Operation                                            | Required source operation scopes              | Data permitted                                                                            |
| ---------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Clone with include.content=true, includeDrafts=false | content:read, schema:read                     | Published snapshots and schema needed for reference remapping; never mutable draft fields |
| Clone with include.content=true, includeDrafts=true  | content:read:draft, content:read, schema:read | Mutable heads and any latest published snapshots copied with them                         |
| Clone with include.settings=true                     | schema:read                                   | Source schema registry and sync snapshot; also require schema:write at destination        |
| Promote with either includeUnpublished value         | content:read:draft, schema:read               | Mutable source heads and schema needed for remapping                                      |

Clone content defaults to included and includeDrafts defaults to true. Settings
defaults to false. Promote includeUnpublished=false skips documents with no
published version; it does not select the published snapshot instead of the
mutable head. Thus it never reduces the source scope to content:read.

Check source-read grants for every selected document path and destination write
and publish grants for every affected path, including the old path of an
existing overwritten document and its resulting path. The destination environment
operation scope authorizes its defined copy/publish behavior; it does not imply
source-read scopes or settings schema:write. Reference resolution must not expose
otherwise unreadable documents. Any denied source or destination fails the whole
operation with FORBIDDEN (403), without partial writes, events or a dry-run plan
containing denied data. Existing atomic reference-remap failure semantics remain.
Authorization must cover the exact rows/paths consumed by the transaction; a
preflight outside the transaction cannot justify consuming a changed source set.

The endpoint contract table's required scopes include these conditional source
scopes and settings destination scope. Routing errors include
TARGET_ROUTING_MISMATCH (400). No environment is created by clone: the destination
must already exist; provisioning it remains a separate session-only action.

### Clone and Promote Content Attribution

Every clone/promote content mutation requires a server-derived
ContentWriteAttribution containing actorId and origin, as defined by SPEC-003.
After authorizing the operation and its source/destination contexts, carry this
required value through the route, environment store and transactional engine.
It is execution context, never part of EnvironmentCloneInput or
EnvironmentPromoteInput accepted from the client. HTTP callers cannot choose an
actor, credential, origin or channel through request bodies or untrusted headers.
Unexpected attribution fields follow normal request validation and cannot affect
the attribution passed to persistence.

The actor is the session user, API key creator, or OAuth granting user. Ordinary
session operations use channel studio and credential session; external API-key
operations use channel api and credential api_key. Trusted MCP dispatch uses
channel mcp with the actual API-key or OAuth credential and its verified
identifier. Declared client metadata remains unverified under SPEC-005/015 and
never changes actor, channel or permissions. systemAttribution is reserved for
explicit server-internal jobs; it is not a missing-context fallback for a request.

Persistence rules apply to all raw inserts and updates inside clone/promote:

- A newly created target head records createdBy and updatedBy as actorId, and
  createdOrigin and updatedOrigin as origin. Do not copy the source document's
  authorship or substitute a default actor.
- An overwritten target head preserves its existing createdBy and createdOrigin,
  including a historical null origin, and sets updatedBy and updatedOrigin to the
  current operation's actor and origin.
- A newly inserted cloned version 1 and every newly inserted promoted version
  record publishedBy as actorId and publishedOrigin as origin. These are new
  target publication events, even when their content came from an existing source
  snapshot. Source publication attribution is not the target publication actor.
- Source heads and versions remain unchanged. Clone does not copy a complete
  historical series, and promotion does not rewrite old target versions.
- Attribution fields commit in the same transaction as their head/version changes.
  Any lifecycle event emitted for the operation carries the same actor/origin;
  failed operations emit no successful mutation event or attribution change.

Promotion dryRun computes the authorized plan without writing heads, versions,
origins, authors or lifecycle events. It does not refresh last-editor metadata.
The same source scopes, destination binding, tuple restrictions and per-path
checks defined above apply before returning a dry-run result. Passing attribution
is not authorization and cannot bypass any of those checks.
