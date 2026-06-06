# CMS-110 Bulk Content Operations Design

## Context

The content API already exposes single-document publish, unpublish, delete,
duplicate, restore, and draft update routes. Studio's content list already has
row-level publish, unpublish, duplicate, and delete actions gated by target
capabilities. The missing slice is a batch contract and a page-local
multi-select UI for publish, unpublish, delete, and move.

The owning specs now define:

- `SPEC-003`: `POST /api/v1/content/bulk`, request and response types, per-item
  partial-success semantics, action scopes, path-scoped authorization, schema
  hash behavior for move, and deterministic errors.
- `SPEC-006`: content list multi-select behavior, bulk toolbar eligibility,
  confirmation requirements, move target validation, and result handling.

## Decision

Use a single `POST /api/v1/content/bulk` endpoint with an `action` discriminator
and per-document result entries.

This keeps the public contract compact while preserving deterministic per-item
outcomes:

- The request is validated once.
- The global operation scope is checked once.
- Each document is loaded, path-authorized, mutated, and reported independently
  in input order.
- Successful items emit the same lifecycle events as the equivalent
  single-document route.
- A valid request returns `200` even when one or more selected documents fail;
  failures are represented in `data.results[]`.

Move uses `targetDirectory` rather than per-document destination paths. The
server preserves the current slug, constructs the new path, checks destination
path permission, and calls the existing draft update path with schema-hash
validation.

## Alternatives Considered

1. Separate endpoints such as `/content/bulk/publish`.
   This is easy to read but duplicates validation, response parsing, and Studio
   API code across four routes.

2. Studio loops over single-document endpoints.
   This avoids a backend route, but cannot provide a stable bulk contract,
   result envelope, or documented operator workflow. It also makes move hard to
   express consistently.

3. Transactional all-or-nothing batches.
   This sounds simpler, but it hides path-scoped RBAC and conflict outcomes
   behind a coarse failure. Partial success better matches operator selection
   workflows and existing single-document semantics.

## Implementation Shape

Backend:

- Add shared contract types for `ContentBulkAction`,
  `ContentBulkOperationInput`, `ContentBulkOperationResult`, and
  `ContentBulkOperationResponse`.
- Add parsing helpers in content routes for action, document IDs, actor fields,
  change summary, and target directory.
- Mount `POST /api/v1/content/bulk`.
- Reuse existing store methods: `publish`, `unpublish`, `softDelete`, and
  `update` for move.
- Reuse lifecycle event emission with the matching content event per successful
  item.

Studio:

- Add a bulk-operation API helper near the content list API.
- Extract pure content-list bulk UI model helpers for selected IDs, eligible
  action targets, confirmation summaries, and move folder validation.
- Update the content list page with checkboxes, select-all, toolbar actions,
  confirmation dialogs, pending state, and result banners/toasts.
- Clear selection on route target/filter/page changes and after successful bulk
  request completion.

Tests:

- Server route tests cover validation, partial success, move path construction,
  schema-hash requirements, and lifecycle events.
- Studio API tests cover request construction, auth/CSRF headers, response
  validation, and error mapping.
- Studio pure model tests cover action eligibility, selection clearing inputs,
  and move folder validation.
- Existing content list render tests cover the new checkbox column behavior.

## Risks

- The single-document unpublish endpoint currently uses the `content:publish`
  operation scope while Studio exposes a separate `content.unpublish`
  capability. CMS-110 keeps the new bulk API consistent with the existing
  public endpoint table and UI capability model rather than introducing a new
  API-key scope in this slice.
- Bulk move depends on schema hashes. Studio must pass the type schema hash when
  available; server tests should prove move fails deterministically without a
  required hash.
