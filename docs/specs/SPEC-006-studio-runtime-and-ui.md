---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-10
---

# SPEC-006 Studio Runtime and UI

This is the live canonical document under `docs/`.

## Studio Runtime Delivery Contract (Approach C)

Studio is loaded through `@mdcms/studio` embedded in host app. The component fetches a bootstrap startup payload and executes backend-served Studio runtime.

```typescript
export type StudioExecutionMode = "module";

export type StudioBootstrapManifest = {
  apiVersion: "1";
  studioVersion: string;
  mode: StudioExecutionMode;
  entryUrl: string;
  integritySha256: string;
  signature: string;
  keyId: string;
  buildId: string;
  minStudioPackageVersion: string;
  minHostBridgeVersion: string;
  expiresAt: string;
};

export type StudioBootstrapRejectionReason =
  | "integrity"
  | "signature"
  | "compatibility";

export type StudioBootstrapReadyResponse = {
  data:
    | {
        status: "ready";
        source: "active";
        manifest: StudioBootstrapManifest;
      }
    | {
        status: "ready";
        source: "lastKnownGood";
        manifest: StudioBootstrapManifest;
        recovery?: {
          rejectedBuildId: string;
          rejectionReason: StudioBootstrapRejectionReason;
        };
      };
};
```

`module` mode remote entry contract:

```typescript
export type RemoteStudioModule = {
  mount: (container: HTMLElement, ctx: StudioMountContext) => () => void;
};

export type StudioMountContext = {
  apiBaseUrl: string;
  basePath: string;
  auth: { mode: "cookie" | "token"; token?: string };
  hostBridge: HostBridgeV1;
  preview?: {
    hasPreviewUrlResolver?: (contentType: string) => boolean;
    resolvePreviewUrl: (document: {
      documentId: string;
      type: string;
      path: string;
      locale: string;
      frontmatter: Record<string, unknown>;
      draftRevision: number;
    }) => string | null;
  };
  mdx?: {
    catalog: MdxComponentCatalog; // Contract owned by SPEC-007
    resolvePropsEditor: (name: string) => unknown | null;
  };
};
```

`auth` semantics:

- `cookie` mode is the default. The remote Studio runtime uses credentialed browser requests against `apiBaseUrl` and obtains CSRF bootstrap state from the auth/session endpoints.
- `token` mode uses `Authorization: Bearer <token>` on Studio API requests. In MVP, this bearer token is an MDCMS API key.
- In both auth modes, the runtime may call `GET /api/v1/me/capabilities` with explicit `X-MDCMS-Project` and `X-MDCMS-Environment` routing to determine target-scoped UI capabilities. Capability responses drive UI gating only; backend authorization remains the final authority.

Host bridge (minimum):

```typescript
export type HostBridgeV1 = {
  version: "1";
  resolveComponent: (name: string) => unknown | null;
  renderMdxPreview: (input: {
    container: HTMLElement;
    componentName: string;
    props: Record<string, unknown>;
    key: string;
  }) => () => void;
};
```

The shared shell/runtime boundary keeps executable component values opaque at the
type level (`unknown | null`). In the host app these are normally React
components, but the shared contract does not depend on React type imports.

## Studio UI

### Embedding

The Studio is a React component published as `@mdcms/studio`. Developers embed it in their app at a catch-all route and pass the Studio subtree root through `basePath`. On mount, the shell fetches `/studio/bootstrap`, verifies the returned runtime manifest and asset, creates the host bridge, and calls the remote `mount(...)` entrypoint.

```tsx
// app/admin/[[...path]]/page.tsx (Next.js App Router example)
import { Studio } from "@mdcms/studio";
import config from "../../../mdcms.config";

export default function AdminPage() {
  return <Studio config={config} basePath="/admin" />;
}
```

When the host app supplies MDX loader callbacks, Studio takes a client-side
embedding path for MDX-aware features. The shell consumes the local component
catalog metadata from `mdcms.config.ts` and a local
`resolvePropsEditor(...)` capability from the host bundle, then passes them to
the embedded runtime. For MDX prop editing features, the host may prepare that
catalog on a Node-side integration path before the client shell renders so the
runtime receives serializable `extractedProps` metadata as defined in
`SPEC-007`; the runtime does not inspect TypeScript source in the browser.
Preview rendering remains host-bridge-driven through `resolveComponent(...)`
and `renderMdxPreview(...)`. The backend bootstrap/runtime publication model
stays unchanged; it still serves the signed runtime bundle and does not publish
the component catalog.

Cookie-authenticated Studio routes must redirect to `/admin/login` when the
session bootstrap request cannot verify the active browser session, including
`401` responses and network-level failures. The redirect includes `returnTo`
for the current Studio route. Token-authenticated embeds must not redirect to
the login route; token authentication failures remain inline operator-facing
states because the host application, not the Studio login form, owns the token.
When a cookie-authenticated Studio tab returns to focus or becomes visible again,
the runtime revalidates the active session so expired or revoked sessions move to
the login route without requiring a manual page refresh.

MDCMS built-in MDX components defined by `SPEC-007` are injected by the Studio
shell/runtime without host registration. Studio resolves their preview
components from MDCMS-owned React code before falling back to host-registered
component loaders. The host bridge remains the contract for host components;
built-ins do not require host `load` callbacks and do not change the signed
runtime bootstrap contract.

The backend may live on a different origin from the host app. Cross-origin Studio embedding is a first-class path; a same-origin reverse proxy is optional, not required. Browser access to the backend follows the Studio origin allowlist and CORS contract defined in `SPEC-005`.

Studio runtime publication selection is server-owned:

- The server tracks one `active` runtime build, an optional `lastKnownGood` runtime build, and an operator kill-switch state.
- `lastKnownGood` is the previously promoted verified publication snapshot. The server may serve it only as a recovery fallback; the shell never promotes or persists fallback builds on its own.
- `GET /api/v1/studio/bootstrap` returns exactly one startup outcome for the caller:
  - a ready payload for the `active` build
  - a ready payload for the `lastKnownGood` build when the active build was rejected during startup validation
  - a deterministic disabled or unavailable error response when no runtime should be started
- The shell never keeps browser-local fallback state and never selects between builds on its own.
- The MVP operator control surface for the kill switch is server configuration or environment only. Enabling or disabling it requires an operator configuration change followed by process restart or redeploy. No Studio UI toggle or public mutation endpoint is exposed in v1.

The shell owns only fatal startup failures and startup-disabled outcomes:

- bootstrap fetch failed
- bootstrap response invalid or incompatible
- bootstrap returned `STUDIO_RUNTIME_DISABLED` or `STUDIO_RUNTIME_UNAVAILABLE`
- runtime asset load failed
- remote `mount(...)` failed

Bootstrap fetch failure handling:

- A bootstrap fetch failure means the shell could not obtain a usable bootstrap HTTP response from `GET /api/v1/studio/bootstrap`.
- When the failure is transport-level and no HTTP response was received, the shell retries the same bootstrap URL up to two additional times with short client-side backoff before surfacing a fatal startup error.
- This bounded transport retry is separate from the manifest-rejection retry below. It does not change query parameters and does not apply to HTTP error responses, invalid bootstrap payloads, disabled/unavailable responses, or runtime asset failures.
- User-facing startup copy may mention cross-origin or CORS guidance only when the shell has concrete evidence that browser origin policy caused the failure.
- When the shell only knows that a cross-origin bootstrap request failed without a usable response, it must use neutral startup copy and expose the underlying fetch error cause in technical details.

If runtime validation fails because of integrity, signature, or compatibility rejection, the shell retries `GET /api/v1/studio/bootstrap` exactly once with:

- `rejectedBuildId=<buildId>`
- `rejectionReason=integrity|signature|compatibility`

Retry query parameters are optional only as a pair. If either parameter is provided without the other, or if `rejectionReason` is outside the allowed values, bootstrap returns `INVALID_QUERY_PARAM` (`400`).

The server then decides whether to serve `lastKnownGood` or return a deterministic disabled or unavailable response. The shell does not loop beyond that single retry.

After `mount(...)` succeeds, the remote Studio runtime owns all user-visible Studio UI states.

### Routing

The remote Studio runtime uses its own internal path-based router within the catch-all route subtree. The host app framework must be configured to pass all `/admin/*` routes to the Studio shell, and the shell must provide the subtree root through `basePath`.

The remote runtime owns browser-path syncing through the History API after startup. No framework-specific router adapter is required beyond the catch-all route.

Internal Studio routes (examples):

- `/admin` — Dashboard
- `/admin/content` — Content browser (schema-first navigation)
- `/admin/content/:type` — List documents of a specific type
- `/admin/content/:type/:documentId` — Document editor
- `/admin/environments` — Environment management, lineage, clone, and promote
- `/admin/media` — Media library
- `/admin/schema` — Read-only schema explorer
- `/admin/users` — User management (admin only)
- `/admin/settings` — CMS settings (admin only)
- `/admin/workflows` — Workflow shell surface
- `/admin/api` — API playground shell surface
- `/admin/trash` — Deleted content recovery

For `/admin/workflows` and `/admin/api`, the current phase permits
Studio-runtime-owned shell rendering backed by local mock state or placeholder
content while their future live data and mutation contracts remain deferred to
the owning work for those domains. `/admin/media` is a live media library backed
by the media metadata contract owned by SPEC-010.

### Media Library (`/admin/media`)

The `/admin/media` route is the Studio surface for managing project-scoped media
assets in the active mounted target. It is backed by:

- `GET /api/v1/me/capabilities` for target-scoped capability gating
- `GET /api/v1/media` for media metadata list/search/filter/sort/pagination
  and object-storage availability metadata
- `POST /api/v1/media/upload` for page-level uploads when media upload
  capability is available
- `GET /api/v1/auth/users` for display-only uploader name resolution when the
  current principal is allowed to manage users

Normative behavior:

- The route lists real media metadata from `GET /api/v1/media`; it must not use
  placeholder or mock media assets.
- The route is readable only when `capabilities.media.read` is true. If that
  capability is false, Studio renders a forbidden state and must not issue a
  media list request.
- Studio sends the active `(project, environment)` target routing with every
  media list request. The environment participates in routing and authorization
  only; media assets remain project-scoped and reusable across environments.
- The search input maps to the `q` query parameter and searches filenames only.
  Studio debounces search changes before issuing list requests and resets
  pagination offset when search changes.
- Filters map directly to the media list contract:
  - Type choices: `category=image|video|audio|document|archive|other`
  - Uploaded-by choices submit the exact `uploadedBy` actor id, but Studio shows
    a resolved user name and initials when that actor id matches a known user.
    Unresolved actor ids fall back to the raw id.
  - Upload date range query parameters remain `uploadedFrom` and `uploadedTo`;
    the gallery surface does not expose date controls.
- Sort controls map to the media list contract and expose uploaded date, name,
  and size in both directions. The default view is uploaded date descending.
- Pagination is server-side with `limit` and `offset`. The Studio page size is
  fixed at 30.
- Changing search, filters, sort, project, or environment resets the offset to
  zero and refetches the current media list.
- When `capabilities.media.upload` is true, the route exposes a page-level
  upload control using the same auth and target routing contract as document
  editor media uploads. Files dropped anywhere on the media surface also upload;
  an active file drag shows a drop-to-upload affordance over the library. While
  a batch is in flight, the route shows a docked upload panel that reports
  per-file progress — each file's name, live completion percentage, and final
  done or failed status — alongside the batch summary, and disables additional
  upload starts. Successful uploads refresh the current media list.
- The media list response includes `storage.objectStorageConfigured`. When it
  is `false`, Studio renders an immediate warning on `/admin/media`, disables
  upload controls and file-drop upload starts, and continues to allow reading,
  searching, filtering, sorting, and deleting existing media metadata according
  to the caller's capabilities. The upload endpoint still returns
  `MEDIA_STORAGE_UNAVAILABLE` if invoked directly while object storage is not
  configured.
- Each media row or card shows an inline preview/playback region, filename, MIME
  type, coarse category, formatted size, uploader display name when resolvable
  otherwise uploaded actor id, upload date, and a safe action cluster.
- Uploader resolution is presentation-only. Failure or denial from the users
  endpoint must not block the media list; Studio must continue rendering media
  assets with raw actor-id fallbacks.
- Image assets render an inline thumbnail from the returned `url`; video assets
  render inline browser playback controls with `preload="metadata"`; audio
  assets render inline browser playback controls with `preload="metadata"`.
  Other asset categories render a compact file/MIME placeholder.
- Safe actions are client-only inspection actions: open the returned `url` in a
  new tab, copy the returned `url` to the clipboard when the browser permits it,
  and download the asset by its returned `url`. These actions do not mutate
  backend media metadata or documents.
- Selecting an asset opens a dismissible detail panel that shows the asset
  preview and read-only metadata (filename, MIME type, coarse category, size,
  uploader, upload date, asset id). The panel can be closed to return the grid
  to full width; it never edits backend media metadata.
- When `capabilities.media.delete` is true, the route supports page-local
  multi-select: a per-asset selection control and a bulk action bar over the
  selection. The bar can download the selected assets (the client-only download
  action applied to each) or delete them. Bulk delete requires explicit
  confirmation and issues one `DELETE /api/v1/media/:id` request per selected
  asset using the media mutation contract in SPEC-010; it surfaces partial
  failures, clears the selection on success, and refreshes the media list.
  Selection and bulk controls are hidden when `capabilities.media.delete` is
  false.
- The route does not introduce tags, folders, collections, usage references,
  duplicate detection, image transformations, CDN controls, advanced asset
  governance, full-text file-content search, or bulk media metadata editing.
- Point-of-use copy must identify the basic library limits: filename search
  only, simple metadata filters only, and no advanced organization features.

Deterministic states:

- If Studio lacks a mounted project, environment, or server URL, the route
  renders an unavailable state and does not call media endpoints.
- If `capabilities.media.read` is false, or `GET /api/v1/media` returns `401`
  or `403`, the route renders a forbidden state.
- The loading state uses the same flat Studio treatment as other admin list
  routes.
- If the media list returns zero assets and no filters are active, the route
  renders an empty state explaining that uploaded assets will appear here.
- If the media list returns zero assets with active search or filters, the route
  renders a no-match state that preserves the controls.
- Non-auth, non-forbidden media list failures render an error state with a retry
  action and do not fall back to placeholder assets.

### Settings Media Panel

The `/admin/settings/media` route is the Studio surface for project-level
media settings. It is visible from the Settings subnavigation when the caller
can manage settings for the mounted target. Direct navigation remains
supported, but the route renders the same forbidden state as other Settings
surfaces when the caller lacks `capabilities.settings.manage`.

Normative behavior:

- The panel reads `GET /api/v1/media/settings` for the active
  `(project, environment)` target and writes `PUT /api/v1/media/settings`
  using the same mounted target headers. The environment participates in
  routing and authorization only; the setting itself remains project-scoped.
- The panel edits only `media.image.maxUploadSizeBytes`.
- The ready state offers an unlimited mode and an explicit byte-limit mode.
  Unlimited mode persists `maxUploadSizeBytes: null`. Explicit mode persists a
  positive safe integer byte value.
- Client-side validation rejects blank, zero, negative, fractional, unsafe, or
  non-numeric explicit values before submitting. The inline validation message
  must identify that the value must be a positive whole number of bytes.
- The panel explains only the image byte-limit setting and infrastructure/proxy
  caveat. It must not display a general file-type allowlist disclaimer in the
  document editor or content canvas.
- Save controls are disabled while loading, while the current form is invalid,
  while the form is unchanged, and while a save request is in flight.
- A failed load renders a deterministic error state with a retry affordance. A
  failed save keeps the current draft values visible and shows the failure
  inline. A successful save updates the clean baseline to the returned settings
  and shows a saved state without leaving the panel.
- If Studio lacks a mounted project, environment, or server URL, the panel
  renders an unavailable state and does not call the media settings endpoints.

### User Management Route

The `/admin/users` route is the Studio user-management surface for the active
mounted project. It is visible from the admin navigation when the target
capability snapshot exposes `capabilities.users.manage`.

Normative behavior:

- The route uses `GET /api/v1/auth/users` and `GET /api/v1/auth/invites` as
  its initial data sources.
- When the caller lacks `capabilities.users.manage`, the route renders a
  forbidden state and does not render invite, grant update, session revocation,
  invite revocation, or remove-user controls.
- The ready state renders a terse members-and-invitations layout on the
  offwhite Studio canvas:
  - a page title with member and pending-invitation counts,
  - a pending invitations strip when invites exist, with invite email, expiry,
    highest pending role, and a revoke action,
  - an active members table with avatar initials, user email, highest-role
    badge, scope chip, joined metadata, and per-row actions.
- Role display is derived from all active grants using the order `owner`,
  `admin`, `editor`, `viewer`; the table shows the highest role.
- Scope display is truthful to grant data. A grant with `pathPrefix` is shown as
  a folder-prefix scope chip; multiple folder-prefix grants are summarized as
  the first prefix plus the remaining count. Users without folder-prefix grants
  show `Full project`.
- Inviting a user sends `POST /api/v1/auth/users/invite` with exactly one grant.
  Admin invites use `global` scope. Editor and viewer invites use `project`
  scope when no path prefix is entered, or `folder_prefix` scope when a prefix
  and active environment are present. The invite dialog does not offer Owner,
  because owner invitations are forbidden by the auth contract.
- Editing grants sends `PATCH /api/v1/auth/users/:userId/grants`. The role
  picker supports Owner, Admin, Editor, and Viewer. Owner and Admin updates use
  `global` scope; Editor and Viewer updates use `project` scope without a path
  prefix or `folder_prefix` scope with a path prefix and active environment.
- Existing owner rows render owner-safe actions: remove is disabled with
  actionable feedback, and the server remains the enforcement boundary for
  final-owner demotion/removal and owner-only role assignment.
- Session revocation uses
  `POST /api/v1/auth/users/:userId/sessions/revoke-all`; invite revocation uses
  `DELETE /api/v1/auth/invites/:inviteId`; user removal uses
  `DELETE /api/v1/auth/users/:userId`.
- Loading, empty, error, forbidden, pending-invite, and mutation states use the
  same flat Studio treatment: 1 px hairline borders, 8 px card surfaces, 4 px
  action buttons, mono labels, and minimal non-bouncy transitions.
- At narrow widths, the table is horizontally scrollable and primary text uses
  truncation instead of overlapping adjacent controls.

The `/admin/schema` route is a live read-only schema browser for the active
`(project, environment)` target. It is backed by `GET /api/v1/schema`, is
visible when the current caller has `schema.read`, and never authors schema
changes in the UI.

### Content Navigation

The primary navigation model is **schema-first**: users navigate by content type (BlogPost, Page, Author) rather than folder structure. Each type shows a sortable, filterable list of documents.

Secondary navigation by folder path is available as an alternative view.

### Content Overview (`/admin/content`)

The `/admin/content` route is a live schema-first overview for the active
`(project, environment)` target. It is backed by:

- `GET /api/v1/me/capabilities` for target-scoped capability gating
- `GET /api/v1/schema` for the canonical list of schema types
- `GET /api/v1/content/overview` for metadata-only per-type counts

Normative behavior:

- Overview cards are keyed by live schema registry entries. Studio must not use
  mock content-type fixtures to decide which types appear.
- Each card links to `/admin/content/:type` only when the current caller can
  read content for that target. When the caller cannot read content, Studio
  keeps the card visible for schema discovery but disables list navigation.
- Studio must not present a count or label that the current route contracts
  cannot prove. Unsupported metrics are omitted instead of estimated.
- When `capabilities.content.read` is `true`, Studio may show a per-type
  `total`, `published`, and `drafts` counts derived from
  `GET /api/v1/content/overview`.
- On `/admin/content`, `drafts` means non-deleted documents whose current head
  has no published version. It does not include published documents that also
  have newer unpublished changes.
- The overview count contract is metadata-only. Showing these counts does not
  grant access to draft document rows, draft document bodies, or any broader
  draft list access outside the overview itself.
- Localization presentation on `/admin/content` is schema-derived in MVP:
  localized types may show a `Localized` badge from the schema contract and
  non-localized types may show `Single locale`.
- When the embedded runtime has explicit locale configuration for the active
  project, `/admin/content` may show that configured locale-code list next to a
  localized type badge. This list is config-derived only and must not be
  presented as translation coverage.

Deterministic states:

- If `GET /api/v1/schema` returns `401` or `403`, the route renders a forbidden
  state because Studio cannot determine which schema types exist.
- If schema loading succeeds but both `capabilities.content.read` and
  `capabilities.content.readDraft` are `false`, the route renders a
  permission-constrained overview: schema cards stay visible, all content
  counts are omitted, list navigation is disabled, and the page shows a clear
  permission banner instead of a full route-level forbidden state.
- If schema loading succeeds and returns zero types, the route renders a
  deterministic empty state for the active target.
- Non-auth, non-forbidden failures from the live schema or content overview
  requests render a deterministic error state. Partial metric failures must not
  fall back to mock values.

### Content Type List (`/admin/content/:type`)

The `/admin/content/:type` route is a live document list for a specific schema
type within the active `(project, environment)` target. It is backed by:

- `GET /api/v1/content?type=<typeId>&groupBy=translationGroup` for localized
  schema types so the route paginates logical documents instead of locale
  variants
- `GET /api/v1/content?type=<typeId>` for non-localized schema types
- `GET /api/v1/schema` for type metadata (name, directory, localized flag)
- `GET /api/v1/me/capabilities` for action gating (inherited from layout)

The list response includes an optional `users` sidecar map that batch-resolves
`createdBy` user IDs to `{ name, email }` for author display without per-user
lookups.

Normative behavior:

- The document list is keyed by the `type` route parameter resolved against live
  schema entries. Studio must not use mock content-type fixtures.
- For localized schema types, the list renders one row per
  `translationGroupId`, not one row per locale variant.
- For non-localized schema types, the list renders one row per document as it
  does today.
- For localized schema types, Studio must request grouped rows from the content
  API instead of grouping client-side after pagination.
- Server-side search uses the `q` query parameter. The Studio search input is
  debounced before issuing requests.
- For localized schema types, search matches any locale variant in the
  translation group, but the route renders a single grouped row for that
  logical document.
- Status filtering maps UI states (`published`, `draft`, `changed`) to the
  `published` and `hasUnpublishedChanges` query parameters.
- Pagination is server-side with `limit` and `offset`. Page size is fixed at 20.
- For localized schema types, pagination and total counts operate on grouped
  rows returned by the backend, not raw locale variants.
- Author initials are derived from the `users` sidecar email. When a user
  cannot be resolved, a placeholder is shown.
- For localized schema types, grouped rows use these representative-field
  rules:
  - title and path come from the representative locale variant
  - the representative locale prefers the project default locale, then the
    first available supported locale in configured order, then lexical locale
    order
  - `Updated` and `Author` use the most recently updated locale variant in the
    group
  - `Translations` reflects group coverage, not the representative locale only
- For localized schema types, grouped row status is derived from the full
  translation group:
  - `Draft` when no locale variant in the group has a published version
  - `Changed` when at least one locale variant is published and at least one
    locale variant is unpublished or has unpublished changes
  - `Published` only when every existing locale variant in the group has a
    published version and none have unpublished changes

Deterministic states:

- If the content list API returns `401` or `403`, the route renders a forbidden
  state with a permission banner.
- If the content list API returns a non-auth, non-forbidden error, the route
  renders an error state with a retry action.
- If the content list returns zero documents and no filters are active, the
  route renders a deterministic empty state encouraging document creation.
- If the content list returns zero documents with active filters (search or
  status), the route renders a "no results" state within the ready view.

Document creation:

- The "New Document" button is gated by `capabilities.content.write`. When
  the caller lacks write capability, the button is hidden.
- Clicking the button opens an inline creation dialog with:
  - **Path** (required text input, pre-populated with the type's directory
    prefix from the schema entry)
  - **Locale** (select, shown only when the type is localized and the project
    has configured `locales.supported`; for non-localized types, the document
    is created with the implicit default locale `__mdcms_default__`)
- On success, the dialog closes, the content list cache is invalidated, and
  Studio navigates to the new document editor at
  `/admin/content/:type/:documentId`.

Row-level actions:

- Each document row has a dropdown menu with the following default actions:

| Action    | Behavior                                       | Capability gate                  | Visibility condition    |
| --------- | ---------------------------------------------- | -------------------------------- | ----------------------- |
| Edit      | Navigate to document editor                    | None                             | Always                  |
| Publish   | `POST .../publish`, invalidate list            | `capabilities.content.publish`   | Draft or changed status |
| Unpublish | `POST .../unpublish`, invalidate list          | `capabilities.content.unpublish` | Published status        |
| Duplicate | `POST .../duplicate`, navigate to new document | `capabilities.content.write`     | Always                  |
| Delete    | `DELETE .../content/:id`, invalidate list      | `capabilities.content.delete`    | Always                  |

- Row action failures are surfaced inline with a dismissible error banner.
- For localized grouped rows, row click, `Edit`, `Publish`, `Unpublish`,
  `Duplicate`, and `Delete` target the representative locale variant's
  `documentId`. Grouped rows do not implicitly turn these actions into
  group-wide mutations.
- The `content.list.row.actions` extensibility slot applies to these actions.

### Document Editor (`/admin/content/:type/:documentId`)

The `/admin/content/:type/:documentId` route is the live document editor for a
single document head in the active `(project, environment)` target. It is
backed by:

- `GET /api/v1/content/:documentId?draft=true` for the current draft snapshot
  (`draft=true` is an authorization/read-model switch that returns the mutable
  head content snapshot for the addressed document when the caller is
  authorized; it is not a server-side status filter for "draft-only" or
  "show unpublished" documents)
- `PUT /api/v1/content/:documentId` for draft persistence
- `POST /api/v1/content/:documentId/publish` for publish
- `GET /api/v1/content/:documentId/versions` and
  `GET /api/v1/content/:documentId/versions/:version` for history and diff
- `GET /api/v1/content/:documentId/variants` for locale variant discovery
- `GET /api/v1/schema` for live type and field metadata
- `GET /api/v1/me/capabilities` for write/publish gating

Normative behavior:

- The editor route is keyed by the routed `type`, `documentId`, and active
  environment. Studio must reject stale async results when the active
  environment or routed document changes.
- `GET /api/v1/content/:documentId?draft=true` reads the mutable head snapshot
  for that single document in the active target. Authorization controls access
  to that mutable head snapshot.
- The primary canvas edits the document `body` through the editor engine owned
  by SPEC-007.
- The editor supports media insertion from four inputs: the toolbar image
  library picker, the picker's upload-new action, files dropped onto the
  editable body, and files present in a clipboard paste event. Upload inputs are
  available only when the active document is writable and the target capability
  snapshot exposes `capabilities.media.upload`. Browsing existing images in the
  toolbar picker also requires `capabilities.media.read`. If required
  capabilities are false, unavailable picker actions are disabled or hidden
  consistently with other read-only editor actions, and drag/drop or paste
  events must not start media uploads or mutate the body.
- The toolbar image control opens a compact picker anchored to the toolbar. It
  lists recent image media assets from `GET /api/v1/media?category=image`, shows
  loading, empty, and error states, and provides an upload-new action when media
  upload is allowed. Selecting a listed image inserts that asset without
  uploading a duplicate file. Successful picker uploads refresh the picker list.
- Media upload uses `POST /api/v1/media/upload` with one multipart `file` field
  and the active Studio `(project, environment)` target routing. The upload
  request uses the same auth mode as the Studio runtime and includes the session
  CSRF header for cookie-authenticated mutations. Studio must not add
  application multipart fields such as `project`, `environment`, `s3Key`, or
  `url`; the media endpoint derives metadata as defined by SPEC-010.
- When a media asset is chosen or uploaded, Studio inserts it into the Markdown
  body at the drop position when one is available, otherwise at the current
  selection/caret. A non-empty selection is replaced. Returned or selected assets
  whose `mimeType` starts with `image/` insert a native image node that renders
  as an `<img>` element in the editor and serializes to Markdown image syntax
  `![filename](url)` using the returned filename as the alt text. Other assets
  insert link syntax `[filename](url)`. Multiple files from one drag/paste/file
  selection are uploaded sequentially and inserted in user-provided order, with
  each generated reference separated from the next by a blank line when they
  land in the same insertion transaction.
- Native image nodes are selectable block atoms in the editor. A selected image
  must show a visible selected state and contextual controls for changing or
  deleting that image. The contextual change action opens the same image library
  picker as the toolbar image control and replaces the selected image node when
  the user chooses or uploads another image. Delete/Backspace and the contextual
  delete action must remove the selected image node.
- A successful media insertion marks the body draft unsaved and relies on the
  existing draft persistence path; it must not introduce a separate content save
  endpoint or bypass draft-save guards.
- During upload, the editor shows an inline upload state near the canvas with
  file-count progress for the active batch and disables additional media upload
  starts while the current batch is in flight. Upload failures keep the current
  document body unchanged for the failed file and render an assertive inline
  error with a deterministic message. Route errors use the backend error message
  when available; `MEDIA_UPLOAD_TOO_LARGE` should mention the image size limit
  when `details.limitBytes` and `details.sizeBytes` are present.
- On desktop, the document editor may expose the visual composition palette to
  the left of the canvas. The palette is part of the body editor surface and
  follows the MDX visual composition behavior owned by SPEC-007. It is
  collapsed by default, opens and closes through the editor toolbar's Insert
  Component control, and lets the central canvas fill the available width while
  closed. It must be hidden on narrow screens where touch/mobile composition is
  not supported.
- The document editor route starts in a focused editing layout on desktop:
  the global Studio navigation sidebar is collapsed by default for this route,
  and the document's right sidebar is also collapsed by default. Both sidebars
  remain available through their existing expand/collapse controls, and manual
  user toggles must not require a page reload.
- The editor topbar exposes, in order from leading edge: a breadcrumb trail
  (`Content` → routed type label → document label), an `UNPUBLISHED CHANGES`
  status pill that is rendered only while the document has unpublished
  changes, an inline auto-save indicator (`Saved`, `Saving...`, or
  `Unsaved changes`), and a trailing action cluster.
- The trailing action cluster contains, in order: the locale switcher (only
  for localized types with at least one supported locale), a `Read-only`
  badge when the active target denies writes, a ghost `Save draft` button,
  the primary `Publish` button, and the sidebar visibility toggle.
- The document editor exposes an `Edit` / `Split` / `Preview` segmented
  control in the topbar. `Edit` is the default authoring-only layout. `Split`
  renders the editor and a real-app preview surface side by side on desktop.
  `Preview` hides the editor canvas and gives the preview surface the available
  document area. The mode is local UI state and does not change the document
  body, frontmatter, publish state, sidebar state, or write authorization.
  Studio mirrors the selected layout mode into the document editor URL as
  `previewMode=edit|split|preview` so reloads and shared admin URLs preserve
  the current layout. Unsupported `previewMode` values are ignored.
- The real-app preview surface is a page renderer. It embeds a host route in an
  iframe and must not render Studio-only component mocks. The existing inline
  MDX component preview remains a node renderer owned by SPEC-007.
- The preview pane chrome contains a read-only resolved-route chip, a manual
  refresh control, viewport-size controls, and an open-in-new-tab link. The
  `Desktop` viewport preset is selected by default. The
  open-in-new-tab link is always available when a route is resolved so editors
  have a fallback when browser framing policy blocks embedding.
- Refreshing the real-app preview first runs the normal draft persistence path
  when local body or frontmatter edits are unsaved, then reloads the iframe only
  after persistence succeeds. Route resolution uses the latest persisted draft
  snapshot; local unsaved frontmatter changes must not navigate the iframe
  before the canonical draft row is updated.
- When route resolution returns a URL, Studio requests a signed preview token
  from `POST /api/v1/content/:documentId/preview-token` before loading the
  iframe. Studio sends the resolved URL as `previewUrl` when available, appends
  the returned token to the host URL as `mdcms_preview_token`, and may also add
  `preview=true` as a mode flag. Manual refresh repeats token minting after any
  required draft persistence so the iframe sees a token bound to the latest
  persisted draft revision.
- Route resolution is deterministic and config-owned. A content type may define
  `resolvePreviewUrl(document)` in `mdcms.config.ts`; Studio calls that resolver
  with the active document id, content type, path, locale, persisted draft
  frontmatter, and draft revision. The resolver returns a same-origin path or
  absolute URL to embed, or `null`/`undefined` when the document has no route.
  Studio must not derive preview routes from frontmatter fields such as
  `previewUrl`, and it must not ship built-in route assumptions for content
  types such as `post` or `page`.
- Documents whose content type has no `resolvePreviewUrl` resolver render a
  `Live preview not available` state with guidance to add the resolver to that
  content type in `mdcms.config.ts`. If a resolver is present but returns no
  URL for the active document, the pane renders an unavailable state that points
  operators back to the resolver and document fields instead of guessing.
- The iframe uses a restrictive sandbox:
  `allow-scripts allow-forms allow-same-origin`. `allow-same-origin` keeps host
  preview routes on their real origin so route-owned assets such as framework
  font files can load correctly. The preview route and preview token remain the
  authorization boundary; the sandbox is not an auth substitute. The preview
  surface must remain read-only from Studio's perspective.
- Preview failure states are explicit and actionable. Studio distinguishes at
  least: no route configured, no host adapter, framing blocked, unauthorized,
  token/session expiry, invalid preview-token configuration, and invalid draft.
  Cross-origin adapter failures are represented as unavailable states and an
  open-in-new-tab fallback rather than implicit background retries.
- `Save draft` calls the same draft-persistence routine that the auto-save
  debounce uses. It is enabled only while the draft is in `unsaved` state
  and a publish is not in flight; it is hidden when the active target denies
  writes. It must not introduce a separate write path or bypass the same
  guard checks that auto-save respects (RBAC, schema mismatch, viewing a
  prior version).
- The auto-save debounce continues to run independently of `Save draft`;
  removing the manual button must never disable auto-save.
- `Publish` opens the publish dialog and is disabled until the draft is
  saved, has unpublished changes, and a publish is not already running.
- The redundant workflow status pill (`Draft` / `Changed` / `Published`) and
  the redundant `v{publishedVersion}` chip are NOT shown in the topbar; both
  facts are surfaced via the `UNPUBLISHED CHANGES` badge and the inspector's
  `Document` block respectively.
- Above the editing surface, inside the centered canvas column, the editor
  renders a document canvas header consisting of a `📄 path/to/doc.<ext>`
  monospace path chip followed by a dashed-bordered monospace summary row of
  the most relevant frontmatter facts (`author`, `publishedAt`, `tags`,
  `slug` when present, plus `locale` and `format`). Mutation, write-message,
  publish-error, viewing-version, and restore-version banners render
  immediately below the canvas header and above the editor body.
- The right sidebar exposes these tabs in order:
  - `Info` for the document's read-only system metadata
  - `Properties` for schema-driven frontmatter editing
  - `Component` for the currently selected MDX/component block inspector
  - `History` for publish history and version comparison
- `Component` appears only while an MDX component node is selected in the
  editor canvas. Selecting a component switches the sidebar to that tab.
- The `Component` tab is one continuous selected-block inspector. It shows
  required prop and validation issues first, component props next, style
  groups next, and the advanced style object editor last. It must not hide
  current validation problems behind nested tabs. When a component is selected,
  the inspector identifies it with the component name instead of repeating
  generic labels such as "MDX component props" or "Selected component".
- Visual style controls in the `Component` tab use an intentional inspector UI,
  not a generated grid of raw CSS property names. Common controls are grouped
  into compact layout, spacing, fill, and typography sections with segmented
  controls, box-model spacing controls, color swatches, and small value inputs.
  Segmented controls should use familiar icons with accessible labels when the
  value is visually standard, such as layout mode, wrapping, alignment,
  justification, grid flow, and text alignment. The layout mode control combines
  flex display and direction into `row` and `column` options instead of exposing
  a separate flex-direction row. Color-valued fields
  expose a native color picker through the swatch while retaining the text input
  for exact CSS strings such as variables and functional color values. The full
  inline style object remains available as a collapsed advanced escape hatch for
  supported flat style keys that do not yet have first-class controls. The
  style inspector does not render redundant explanatory copy or badges above
  those concrete controls.
- The `Component` tab does not show placeholder copy for wrapper-only
  components whose editable surface is their nested canvas content. When a
  component has no editable non-style props, Studio omits the generic props
  editor area and shows only the sections that have concrete controls.
- Wrapper MDX components use a single visual editing surface in the canvas.
  Studio renders the component chrome once, then places the editable rich-text
  child slot where the component's `children` render. Studio must not render a
  separate read-only child preview above or beside a second editable child
  editor. Wrapper component canvases do not render persistent `Drop inside`
  text in normal editing. Drag/drop feedback may use drag-state-only outlines
  or highlights, but it must not place text over the editable caret or reserve
  content layout space. Host-rendered wrapper DOM outside the nested
  `children` slot is not editable document content; clicking prop-rendered
  headings, labels, links, or other component-owned DOM selects the component
  for prop editing rather than placing a caret inside that DOM.
- `Properties` is dedicated to schema-derived frontmatter fields for the
  current type in the active environment.
- `Properties` does not render document system metadata such as `status`,
  `publishedVersion`, `locale`, `updatedAt`, or `path`.
- `Properties` does not render MDX component prop editors or visual style
  controls.
- `Info` shows the read-only document metadata as a monospace key/value
  block (`status`, `type`, `locale`, `publishedVersion`, `updatedAt`,
  `path`).
- The default selected sidebar tab is `Properties` unless an MDX component
  is actively selected, in which case `Component` becomes the selected
  tab.
- Frontmatter controls are derived from the live resolved schema. Studio must
  not ship hard-coded per-type property forms for routed document editing.
- Every property row shows an always-visible compact type label derived from
  the resolved schema for the active environment.
- Schema file fields render in the Properties panel as media picker controls.
  The control stores the selected media asset id in frontmatter, never a URL or
  Markdown string. It uses media read capability for browsing/replacing and
  media upload capability for upload-new. Images render thumbnails, videos
  render inline playback, and other files render a compact file placeholder.
  Studio document editing requests `fileFields=raw` so the editor round-trips
  raw frontmatter values.
  Optional file fields expose a clear/remove action that stores the field as
  unset. Required file fields allow replacement but cannot be saved empty; an
  empty required file field shows an inline required-field validation message.
- MVP editable field support is intentionally narrow:
  - `string` fields render as single-line text inputs
  - `number` fields render as numeric inputs
  - `boolean` fields render as switches
  - enum-like fields render as selects when the resolved schema exposes a
    closed value set
  - optional wrappers of supported kinds reuse the same control and allow an
    empty/unset value
- Unsupported field shapes render deterministically as read-only property rows
  with a type label and a “Not editable in Studio yet” message. Unsupported
  shapes include reference fields, arrays, objects, tuples, unions, executable
  custom schemas, and any unrecognized field kind.
- Unsupported frontmatter values must be preserved in the local draft state and
  in subsequent `PUT /api/v1/content/:documentId` writes. Studio must not drop
  a field solely because the current UI cannot edit it.
- Property field order follows the resolved schema order for the current type.
- Fields that only exist in specific environments remain first-class controls
  when they are present in the active environment. Their environment badge is
  shown inline with the field label/control (for example `staging only`); a
  summary-only list without an editable control does not satisfy this contract.
- Fields omitted from the resolved schema for the active environment are not
  rendered as editable controls in that environment.
- Frontmatter edits participate in the same unsaved/saving/saved indicator model
  as body edits. Changing only a property field is sufficient to mark the draft
  unsaved and trigger draft persistence.
- Existing write-blocking states continue to apply to both body and property
  editing. When Studio is read-only because of RBAC, schema mismatch, or
  other guarded write conditions, the `Properties` schema form is disabled
  consistently with the main editor canvas.
- Validation failures returned by `PUT /api/v1/content/:documentId` should be
  anchored to the corresponding property control when the failure can be mapped
  to a named frontmatter field; otherwise Studio falls back to the route-level
  mutation error banner.
- File-field validation messages are file-specific and use
  `details.reason` from write validation failures. `MEDIA_REQUIRED` explains
  that a required media field is empty. `MEDIA_NOT_FOUND` explains that the
  selected media asset no longer exists. `MEDIA_TYPE_MISMATCH` explains that the
  selected asset type is not accepted by the field and, when available, includes
  the expected MIME preset or `accept` values.

### Theme Preference Persistence

Studio-owned theme preference persists in browser-local storage.

Normative behavior:

- The runtime stores the selected theme in `localStorage`; it is not persisted
  through the backend and is not host-bridge-owned in MVP.
- Preference precedence is:
  1. persisted Studio preference
  2. explicit runtime `defaultTheme`
  3. system theme when `enableSystem` is enabled
  4. `light`
- Persistence scope is browser-local across full page reloads and Studio
  remounts for the same browser profile.
- The theme toggle must continue to support both light and dark rendering even
  when the persisted preference was set by an earlier Studio runtime version.

### Project Scope and Switching

Each embedded Studio instance is configured with a specific project through `mdcms.config.ts` and shows only that project's content and schema.

For users who manage multiple projects, the Studio header provides a project switcher that links to the other Studio instances they are allowed to access.

### Environment Scope and Switching

The active environment is Studio-owned state. The host app provides the initial
environment through `documentRoute.environment` at mount time. Once mounted,
Studio owns the active environment and can switch it through an in-shell
environment selector without host involvement or page reload.

Normative behavior:

- The shell header displays an environment selector when the environment list API
  returns more than one environment for the current project.
- Selecting a different environment updates Studio-internal state. All
  environment-scoped API queries (capabilities, schema, content, trash) re-fetch
  against the new environment automatically.
- When only one environment exists, the header shows a read-only environment
  badge instead of a selector.
- Environment switching does not require host bridge cooperation. The host bridge
  does not define an environment navigation callback.

### Environment Management (`/admin/environments`)

The `/admin/environments` route is a live project-scoped environment management
surface for the currently mounted project. It is backed by:

- `GET /api/v1/environments` for the current project environment list
- `POST /api/v1/environments` for environment creation
- `DELETE /api/v1/environments/:id` for environment deletion
- `POST /api/v1/environments/:id/clone` for cloning into a target environment
- `POST /api/v1/environments/:id/promote` for promoting selected source
  documents into a target environment
- `GET /api/v1/content` (scoped to the source environment) for the document
  picker that drives the promote flow
- `GET /api/v1/me/capabilities` for shell-level admin navigation visibility

The route is the canonical surface for clone and promote workflows. There is
no separate `/admin/promote` route; per-document promotion is invoked from a
row-level action on the environments table and runs inside the same view.

Normative behavior:

- The route manages list, create, delete, clone, and promote behavior. Rename,
  description editing, and other environment workflows remain out of scope
  until their owning work is specified.
- Environment rows are rendered from the live `EnvironmentSummary[]` contract,
  and the route also consumes the `GET /api/v1/environments` metadata that
  reports whether synced environment definitions are available. Studio must not
  render mock environment metadata, synthetic document counts, or fake
  promotion history on this route.
- The create flow submits `{ name }` to `POST /api/v1/environments`. Studio may
  omit `extends` and rely on the server-side synced environment-definition
  validation rules defined by the environment-management contract.
- If `GET /api/v1/environments` reports `meta.definitionsStatus = "missing"`,
  the route remains readable but the create affordance must stay disabled or
  immediately explain that environment management requires a successful
  `cms schema sync` from the host app repo before new environments can be
  created.
- The route surfaces the `EnvironmentDefinitionsMeta` contract — the
  `definitionsStatus` value plus, when ready, the `configSnapshotHash` and
  `syncedAt` fields — as a definitions strip on the page so operators can see
  whether the server has a synced schema snapshot to validate against before
  promoting or cloning.
- On successful create, the creation dialog closes and the environment list
  reloads from the live API before the new row is presented as ready.
- The default `production` environment is rendered as the non-deletable default
  environment. Its delete action is disabled or omitted in the ready state.
- Deleting a non-default environment requires an explicit confirmation step and,
  on success, reloads the live environment list before removing the row from the
  UI.
- The route presents two complementary views of the live environment list:
  - A lineage view that walks the `extends` chain root → leaves, marking the
    default environment and visualizing parent-of relationships.
  - A management table that lists every environment with its name, default
    status, parent environment (`extends`), `createdAt`, and per-row actions
    for promote, clone, and delete.
- Clone is launched from the environments row action and submits to
  `POST /api/v1/environments/:targetId/clone`. The clone surface exposes the
  `sourceEnvironmentId` picker plus the live contract toggles
  (`include.content`, `include.settings`, `includeDrafts`, `preservePaths`)
  with their spec defaults pre-selected. Source must differ from target. On
  success the environment list reloads.
- Promote is launched from the environments row action and runs as a staged
  workflow inside the same surface, in this order:
  1. Configure — operator picks `sourceEnvironmentId` and `targetEnvironmentId`,
     selects one or more `documentIds` from the source environment's live
     `GET /api/v1/content` list, and toggles `includeUnpublished`. The
     configure stage must enforce that source differs from target before the
     stage can advance.
  2. Preview — Studio submits `dryRun: true` to
     `POST /api/v1/environments/:targetId/promote` and renders the returned
     `DocumentPromotionResult[]`, grouped by `overwrote`, `created`, and
     `skipped_unpublished`. The preview stage must explicitly state that
     promote is an overwrite — target content is replaced, no merge or
     conflict resolution — and surface the per-row `remappedReferences`
     count.
  3. Run — Studio submits `dryRun: false` using the configuration captured
     when the preview was produced, and replays the dry-run target ids via
     `preallocatedTargetIds` so the real run produces identical
     overwrote/created classification. Editing source, target, document
     selection, or `includeUnpublished` after a successful preview must
     invalidate the preview and require a new dry-run before the real run is
     allowed.
- Promote and clone surfaces must surface deterministic server failures
  truthfully. `REFERENCE_REMAP_FAILED` (`409`) on a promote run or preview
  must report the failure source (translation_group_id, locale, sourceDocumentId,
  fieldPath when present) and must not present the run as successful.
- The route must surface deterministic server failures truthfully:
  - `INVALID_INPUT` (`400`) on create is shown inline on the creation form.
  - `CONFIG_SNAPSHOT_REQUIRED` (`409`) on create is shown inline on the
    creation form with actionable guidance to run `cms schema sync` from the
    host app repo.
  - `CONFLICT` (`409`) on create or delete is shown inline without replacing the
    current ready view. When the delete confirmation dialog is still open, the
    delete conflict is shown inside that dialog instead of as a detached page
    error.
  - `NOT_FOUND` (`404`) on delete is surfaced as a non-destructive row/action
    failure and followed by a live list reload.
- The shell navigation entry for `/admin/environments` follows the same
  admin-owned visibility policy as other admin surfaces. Until a dedicated
  environment-management capability exists, Studio may use the current
  capability snapshot to hide the entry unless the caller exposes at least one
  admin-only capability (`capabilities.users.manage` or
  `capabilities.settings.manage`).
- Direct navigation to `/admin/environments` remains supported even when the
  navigation entry is hidden. Route authorization still depends on the
  environment-management endpoints; hidden navigation is advisory UI gating, not
  the security boundary.

Deterministic states:

- While the initial environment list request is pending, the route renders a
  dedicated loading state for environment management instead of mock cards.
- If `GET /api/v1/environments` returns `401` or `403`, the route renders a
  forbidden state for the active project.
- If `GET /api/v1/environments` returns a non-auth, non-forbidden failure, the
  route renders an error state with a retry action.
- If `GET /api/v1/environments` succeeds with zero rows, the route renders an
  empty state for the active project. When the current caller is allowed to use
  the route and synced environment definitions are available, the empty state
  may include the create affordance.
- When the list request succeeds with one or more rows, the route renders a
  ready state with per-row metadata limited to the live environment summary
  contract (`name`, `extends`, default status, `createdAt`).

### Target-Scoped Capabilities and Schema Recovery

Studio uses `GET /api/v1/me/capabilities` as the canonical source for
target-scoped UI capability gating.

Normative behavior:

- The runtime requests capabilities for the active `(project, environment)`
  target using the same explicit routing contract as other environment-scoped
  APIs.
- Schema route visibility depends on `capabilities.schema.read`.
- The `Sync Schema` action depends on both `capabilities.schema.write` and the
  runtime having a local schema sync payload available from the embedded
  `mdcms.config.ts` snapshot.
- The runtime must not infer write authority from local schema availability
  alone.
- Content list page action gating uses `capabilities.content.write` (create,
  duplicate), `capabilities.content.publish` (publish), `capabilities.content.unpublish`
  (unpublish), and `capabilities.content.delete` (delete).

Schema mismatch recovery:

- If a content write operation fails with `SCHEMA_NOT_SYNCED` (`409`) or
  `SCHEMA_HASH_MISMATCH` (`409`), Studio transitions the affected document
  editor into guarded read-only recovery mode.
- Guarded read-only recovery shows a schema mismatch banner, disables document
  write/publish/delete actions, and surfaces the local and server schema hashes
  when known.
- If `capabilities.schema.write` is `true`, the recovery UI may offer `Sync
Schema` as the privileged remediation action.
- If `capabilities.schema.write` is `false`, Studio must keep the recovery UI
  read-only and direct the user to the read-only schema browser and/or an
  authorized operator.

### Branding

Fixed MDCMS branding. No white-labeling in MVP. Configurable accent color may be considered.

### Content List Bulk Operations

The content list view supports page-local multi-select and bulk operations
against the active `/admin/content/:type` result set. Bulk actions use `POST
/api/v1/content/bulk` and inherit the same active `(project, environment)`
target routing, auth mode, CSRF behavior, and capability model as row-level
actions.

Selection behavior:

- Each ready-state row exposes a checkbox before the title column.
- The table header exposes a page-level select-all checkbox. It selects or
  clears only the rows currently rendered on the active page.
- Selection is keyed by `documentId` and is cleared when the user changes the
  type route, active project, active environment, filter set, search query, sort
  order, page offset, or when a bulk operation completes.
- Row click and `Edit` continue to navigate to the representative document
  editor. Checkbox clicks and bulk toolbar clicks must not trigger row
  navigation.
- For localized grouped rows, selection targets the representative locale
  variant's `documentId`. Bulk operations do not implicitly mutate every locale
  variant in the translation group.

Toolbar behavior:

- When no rows are selected, the bulk toolbar is not shown.
- When one or more rows are selected, the toolbar shows the selected count and
  available actions:
  - **Publish** when `capabilities.content.publish` is true and at least one
    selected row is `Draft` or `Changed`.
  - **Unpublish** when `capabilities.content.unpublish` is true and at least one
    selected row is `Published`.
  - **Move** when `capabilities.content.write` is true.
  - **Delete** when `capabilities.content.delete` is true.
- Disabled or hidden actions must not be invokable from keyboard, pointer, or
  programmatic event handlers.
- While a bulk operation is pending, row actions, selection changes, pagination,
  and filter changes are disabled for the list surface.

Confirmation behavior:

- Every bulk action requires confirmation before the API request is sent.
- Publish confirmation lists the number of selected rows that are eligible for
  publish and states that rows already published without changes are skipped by
  the user interface.
- Unpublish confirmation lists the number of selected published rows.
- Delete confirmation uses destructive styling, states that documents move to
  Trash, and does not promise permanent deletion.
- Move confirmation requires a target folder input. The input accepts an empty
  value for the content root. Non-empty values must not start or end with `/`
  and must not contain `..` path segments.
- Move sends the current schema hash for the selected type when the schema route
  provided one.

Result handling:

- The request payload includes only selected rows eligible for the chosen
  operation. Publish excludes already-published rows with no unpublished
  changes. Unpublish excludes draft and changed rows.
- A successful bulk request invalidates the content list query and translation
  coverage query for the active type.
- When every item succeeds, Studio shows a success toast summarizing the action
  and count.
- When one or more items fail, Studio keeps the route in ready state, shows a
  dismissible error banner with succeeded/failed counts, and exposes the first
  failure message. The list is refreshed so successful items disappear or update
  according to the active filters.
- Whole-request `401` or `403` failures render the same permission treatment as
  row-level action failures: the route remains mounted and surfaces the error
  inline unless the next list refresh itself becomes forbidden.
- Whole-request schema mismatch failures for move surface the existing guarded
  schema mismatch copy for write operations where available; otherwise they use
  the same inline error banner as other bulk failures.

### Extensibility Surfaces (Backend-First + Runtime Bundle)

Studio behavior is resolved in this order:

1. Read backend action catalog contract (`/actions` + `/actions/:id`) including action metadata.
2. Fetch and verify Studio bootstrap startup payload (`/studio/bootstrap`) and runtime artifact.
3. Execute the verified Studio runtime in `module` mode.
4. Remote Studio runtime builds its internal composition registry and validates it before first render.
5. Remote Studio runtime renders default UI for actions/forms/widgets from metadata and applies runtime customizations.

Supported Studio extension surfaces in v1:

These are Studio runtime composition surfaces used by first-party/custom runtime builds; they are not an untrusted third-party runtime plugin marketplace API in v1.

- `routes` (additional pages/views)
- `navItems` (navigation entries)
- `slotWidgets` (UI injections into standard slot IDs)
- `fieldKinds` (custom field editors/validators)
- `editorNodes` (TipTap/editor node integrations)
- `actionOverrides` (replace/enhance backend-generated action UI)
- `settingsPanels` (custom settings pages)

Standard slot IDs:

1. `dashboard.main`
2. `content.list.toolbar`
3. `content.list.row.actions`
4. `content.editor.header.actions`
5. `content.editor.sidebar`
6. `content.editor.footer`
7. `settings.sidebar`
8. `settings.panel.<id>`

Runtime composition rules:

- `routes` must be unique after normalized path matching; `/settings` and `/settings/` conflict, and equivalent parameterized shapes also conflict.
- `navItems` sort deterministically by explicit order, then `id`.
- `slotWidgets` must declare explicit numeric `priority`; widgets sort by `priority` descending, then `id` ascending.
- `fieldKinds`, `editorNodes`, `actionOverrides`, and `settingsPanels` must be unique by identifier.
- `settings.sidebar` entries must reference a registered settings panel.
- Unknown or unregistered field kinds fall back to a safe JSON editor and emit structured warning logs instead of failing the runtime.

Security model:

- Action catalog metadata is non-executable and drives generated defaults only.
- `module` mode: remote Studio executes in host JS context via verified runtime artifacts and capability-limited host bridge.
- Backend authorization remains final authority for every operation.

Execution mode:

- `module` is the only supported Studio execution mode in MVP.

---

## Core Runtime and Studio Runtime Endpoints

| Method | Path                               | Auth Mode          | Required Scope | Target Routing      | Request                                                                                                                     | Success                                                     | Deterministic Errors                                                                                                                                         |
| ------ | ---------------------------------- | ------------------ | -------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/healthz`                         | public             | none           | none                | no body                                                                                                                     | `200` health payload (service/version/uptime/startedAt/now) | `INTERNAL_ERROR` (`500`) when health provider fails                                                                                                          |
| GET    | `/api/v1/studio/bootstrap`         | public             | none           | none                | optional query pair: `rejectedBuildId`, `rejectionReason`                                                                   | `200` `StudioBootstrapReadyResponse`                        | `INVALID_QUERY_PARAM` (`400`), `FORBIDDEN_ORIGIN` (`403`), `STUDIO_RUNTIME_DISABLED` (`503`), `STUDIO_RUNTIME_UNAVAILABLE` (`503`), `INTERNAL_ERROR` (`500`) |
| GET    | `/api/v1/studio/assets/:buildId/*` | public             | none           | none                | `buildId` path param                                                                                                        | `200` immutable runtime asset stream                        | `FORBIDDEN_ORIGIN` (`403`), `NOT_FOUND` (`404`)                                                                                                              |
| GET    | `/api/v1/me/capabilities`          | session_or_api_key | none           | project+environment | session cookie or `Authorization: Bearer <mdcms_key_...>` plus explicit `X-MDCMS-Project` and `X-MDCMS-Environment` routing | `200` `{ data: { project, environment, capabilities } }`    | `UNAUTHORIZED` (`401`), `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `FORBIDDEN_ORIGIN` (`403`)                                      |
