# CMS-148 Search Design

## Scope

This design covers the search epic as three sequential tickets:

1. Add the latest-published search index schema and synchronization path.
2. Add locale-aware analyzer selection and draft-search permission gating.
3. Integrate `q` search through the Content API and SDK.

The implementation must preserve MDCMS target routing, permission checks,
document visibility, version history, and existing content list sort/pagination
semantics.

## Current State

`SPEC-010` defines the intended PostgreSQL full-text search table, but still
labels search as a deferred design target. `SPEC-003` already lists `q` on the
content list endpoint, but only as a broad free-text filter. The server currently
accepts `q` in `ContentListQuery` and filters resolved documents with an
in-memory lowercase substring check over `path`, `body`, and serialized
frontmatter. The SDK list input does not expose `q`.

There is no `apps/studio-review` directory in this worktree. The Studio package
already forwards `q` from content list UI hooks to the content list endpoint.

## Recommended Approach

Use PostgreSQL full-text search as the canonical search implementation while
keeping `q` as a filter in the existing content list contract. Existing
`sort`, `order`, `limit`, `offset`, and grouped translation list behavior stay
authoritative. Search narrows the candidate rows before the existing list
shaping rules apply.

Default published search uses a materialized `published_search_index` table.
Draft search remains opt-in through `draft=true`, requires the existing
`content:read:draft` scope, and uses PostgreSQL full-text search over mutable
`documents` rows without adding a persisted draft index.

This is the smallest design that satisfies the ticket requirements without
creating a second index that the specs do not ask for.

## Alternatives Considered

### Add Published And Draft Indexes

This would make draft search faster and symmetrical, but it expands schema and
synchronization responsibilities beyond the accepted table contract. It also
creates another consistency surface for mutable drafts, which change more often
than published snapshots.

### Keep Substring Search Behind An Interface

This would be easy to wire, but it would not satisfy the PostgreSQL
`tsvector`/`tsquery`, GIN index, analyzer, or search-backend acceptance criteria.

## Data Model

Add `published_search_index` with:

- `project_id uuid not null`
- `environment_id uuid not null`
- `document_id uuid not null`
- `locale text not null`
- `schema_type text not null`
- `search_config regconfig not null`
- `search_vector tsvector not null`
- primary key `(project_id, environment_id, document_id, locale)`
- `document_id` foreign key to `documents(document_id) on delete cascade`
- GIN index on `search_vector`
- btree lookup index on `(project_id, environment_id, schema_type, locale)`

The migration should backfill rows for non-deleted documents with a published
version. The Drizzle schema and schema contract test should assert the table,
columns, indexes, and cascade foreign key.

## Search Text

The indexed/searchable text is deterministic:

```text
path
body
JSON.stringify(frontmatter)
```

This keeps title, slug, and other frontmatter fields searchable without coupling
the index to schema-specific field names.

## Locale Analyzer Selection

Create a small server-owned helper that maps known BCP 47 primary subtags to
PostgreSQL search configs:

- `da` -> `danish`
- `de` -> `german`
- `en` -> `english`
- `es` -> `spanish`
- `fi` -> `finnish`
- `fr` -> `french`
- `hu` -> `hungarian`
- `it` -> `italian`
- `nl` -> `dutch`
- `no`, `nb`, `nn` -> `norwegian`
- `pt` -> `portuguese`
- `ro` -> `romanian`
- `ru` -> `russian`
- `sv` -> `swedish`
- `tr` -> `turkish`

Unknown, blank, or unsupported locales fall back to `simple`. Region subtags
inherit from the primary subtag, so `en-US` uses `english`.

## Backend Boundary

Add a content-search backend abstraction owned by the server content API. The
database store should call the backend for:

- Synchronizing the latest published snapshot after publish and
  restore-to-published.
- Removing the published index row after unpublish and soft delete.
- Resolving matching document IDs for published and draft list searches.

The PostgreSQL backend is the default implementation. Tests can inject a backend
to prove store coordination without reaching into database internals.

## Synchronization Rules

Publishing inserts an immutable version and upserts the corresponding
`published_search_index` row in the same transaction. Restoring a historical
version directly to published follows the same path.

Unpublishing removes the index row in the same transaction that clears
`published_version`. Soft-deleting removes the index row when the document is
hidden from default published reads. A future hard delete is covered by the
cascade foreign key.

Draft updates do not change `published_search_index` until the draft is
published.

## API Semantics

`GET /api/v1/content?q=...`:

- Trims `q`.
- Treats an empty trimmed value as omitted.
- Limits `q` to 200 characters.
- Fails malformed or too-long `q` with `INVALID_QUERY_PARAM` (`400`).
- Uses published search by default with required scope `content:read`.
- Uses draft search only when `draft=true`, with required scope
  `content:read:draft`.
- Preserves existing filters, sorting, pagination, and grouped translation list
  behavior.

`q` is a filter, not a rank-based sort. The list endpoint should not change the
response shape.

## SDK Semantics

`MdcmsListInput` adds `q?: string`. `createClient().list(type, { q })` forwards
`q` to `GET /api/v1/content` with the other list filters. The SDK does not
client-validate search syntax; the server owns deterministic query validation
and error envelopes.

## Ticket Execution Order

1. `CMS-30`: schema, migration, search backend abstraction, published index
   synchronization, and contract tests.
2. `CMS-99`: locale analyzer helper, draft-search path, query validation, and
   permission tests.
3. `CMS-100`: Content API `q` integration tests, SDK input and serialization,
   and final docs/changeset work.

Each ticket should follow test-driven development. The implementation plan will
spell out red/green/refactor steps and verification commands per task.
