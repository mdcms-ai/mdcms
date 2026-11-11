---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-03-11
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

Cloning creates a **new** environment with copies of content from the source. The clone payload is **configurable** — the user chooses what to include:

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

- Environment management requires global `owner` or `admin` privileges. List, create, and delete accept only an authenticated Studio session. Clone and promote accept either an authenticated Studio session with global `owner` or `admin` privileges or an API key holding the matching `environments:clone` or `environments:promote` scope. Session callers with only `editor` or `viewer` access receive `FORBIDDEN` (`403`).
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

| Method | Path                                     | Auth Mode          | Required Scope         | Target Routing      | Request                                                                                                  | Success                                                                  | Deterministic Errors                                                                                                                                           |
| ------ | ---------------------------------------- | ------------------ | ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/environments`                   | session            | none                   | required: `project` | explicit project routing only                                                                            | `200` `{ data: EnvironmentSummary[], meta: EnvironmentDefinitionsMeta }` | `MISSING_TARGET_ROUTING` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                  |
| POST   | `/api/v1/environments`                   | session            | none                   | required: `project` | JSON: `{ name, extends? }`                                                                               | `200` `{ data: EnvironmentSummary }`                                     | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `CONFIG_SNAPSHOT_REQUIRED` (`409`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `CONFLICT` (`409`) |
| DELETE | `/api/v1/environments/:id`               | session            | none                   | required: `project` | path `id`                                                                                                | `200` `{ data: { deleted: true, id } }`                                  | `MISSING_TARGET_ROUTING` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `CONFLICT` (`409`)                                         |
| POST   | `/api/v1/environments/:id/clone`         | session_or_api_key | `environments:clone`   | required: `project` | path `id`; JSON: `{ sourceEnvironmentId, include: { content, settings }, includeDrafts, preservePaths }` | `200` `{ data: { targetEnvironmentId, documentsCloned } }`               | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `REFERENCE_REMAP_FAILED` (`409`)  |
| POST   | `/api/v1/environments/:targetId/promote` | session_or_api_key | `environments:promote` | required: `project` | path `targetId`; JSON: `{ sourceEnvironmentId, documentIds, includeUnpublished, dryRun }`                | `200` `{ data: { promoted: DocumentPromotionResult[] } }`                | `MISSING_TARGET_ROUTING` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `REFERENCE_REMAP_FAILED` (`409`)  |
