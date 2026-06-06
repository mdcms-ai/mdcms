# CMS-251 Media Library Design

## Context

CMS-251 adds the first live Studio media library after the upload API and editor insertion flow. Existing media support covers project media settings, upload, single-asset read, deletion, and inline editor insertion. The `/admin/media` route is still a placeholder, and the media metadata store has no list/search contract.

`apps/studio-review` is not present in this checkout, so review-app fixture/handler updates cannot be made here unless that app is restored under `apps/`.

## Spec Delta

- `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md` now defines `GET /api/v1/media`.
- The media list contract supports filename-only search (`q`), MIME category, uploader, upload date range, sort, `limit`, and `offset`.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` now defines `/admin/media` as a live Studio page, not a placeholder shell.
- The Studio route is gated by `capabilities.media.read`, uses the media list endpoint, and renders loading, empty, no-match, forbidden, unavailable, error, and retry states.

## Product Scope

The library is intentionally basic. Editors can find existing project media assets and inspect or copy URLs. It does not add tags, folders, collections, usage references, duplicate detection, image transformations, CDN controls, full-text file-content search, or bulk media editing.

## Backend Design

Add a read-only `GET /api/v1/media` route to the existing media API mount. The route uses the same explicit project/environment routing as other media routes and requires `media:read`. It does not require object storage because it only reads metadata rows.

Shared contracts add:

- `MediaAssetCategory`
- `MediaAssetListQuery`
- `MediaAssetListResponse`
- response assertion for list payloads

The route parses query parameters at the route boundary and passes a typed query object into `MediaMetadataStore.listAssets`. Invalid query values return `INVALID_QUERY_PARAM`.

The database store applies all filters server-side and returns `{ assets, pagination }`. Category filters are derived from MIME type. Search is a case-insensitive filename substring match. Date filters are UTC calendar dates and are inclusive from the user's perspective.

## Studio Design

Add a dedicated media library route client and hook:

- `createStudioMediaLibraryApi(config, options).list(query)`
- `useMediaLibrary({ enabled })`

The hook mirrors existing Studio API patterns: scoped headers, auth mode handling, RuntimeError mapping, response validation, TanStack Query cache keys, unavailable state when the mount lacks API config, and no request when `media.read` is false.

The media page replaces the Coming Soon component with a dense operational list surface:

- Search input for filename search
- MIME category select
- Uploader id input
- From/to date inputs
- Sort select covering uploaded date, filename, and size in both directions
- Server-side pagination with a fixed page size of 30
- Rows showing filename, MIME type/category, formatted size, uploaded actor id, upload date, and safe open/copy URL actions

The route exposes the basic-library limits in point-of-use copy. It does not add upload or delete controls for this ticket.

## Testing

Backend tests cover:

- list route authorization and scope
- filename search
- each category filter family
- uploader and date range filters
- sort and pagination
- invalid query handling
- project isolation in the database store

Studio tests cover:

- API request serialization and response validation
- hook/model derivation for loading, ready, empty, no-match, forbidden, unavailable, and error states
- page render helpers for controls, metadata display, basic-library limits, and safe action copy
- capability context exposing media read/upload/delete booleans

## Open Constraint

React Doctor remains blocked in this environment because `npx -y react-doctor@latest . --verbose --diff` needs to fetch third-party npm code and the sandbox escalation was rejected earlier on this branch.
