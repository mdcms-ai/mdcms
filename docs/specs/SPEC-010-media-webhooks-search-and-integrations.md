---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-14
---

# SPEC-010 Media, Webhooks, Search, and Integrations

This is the live canonical document under `docs/`.

## Media Management

### Storage

Media files are stored in S3-compatible object storage and are
**project-scoped** (reusable across environments in the same project). In
development, MinIO provides a local S3-compatible API within the Docker Compose
stack. In production, any S3-compatible service works (AWS S3, Cloudflare R2,
DigitalOcean Spaces, etc.).

The server object-store adapter uses the private S3 connection settings for
storage operations and stores a public URL in media metadata for insertion into
Markdown and for browser previews. Operators may configure a distinct public
base URL when the internal S3 endpoint is not browser-reachable.

Required storage settings:

- `S3_ENDPOINT` — S3-compatible API endpoint used by the server.
- `S3_ACCESS_KEY` — object-store access key.
- `S3_SECRET_KEY` — object-store secret key.
- `S3_BUCKET` — bucket that stores media objects.

Optional storage settings:

- `S3_PUBLIC_BASE_URL` — public URL prefix used to derive returned media URLs.
  When omitted, the server derives URLs from `S3_ENDPOINT`, `S3_BUCKET`, and the
  object key. The public base URL must be an absolute `http` or `https` URL and
  must not include query parameters or a fragment.

Media object keys are server-generated and must be unique within the bucket. The
key format is implementation-owned but must include the project identifier and
media id so objects for different projects cannot collide.

#### Upload Constraints Config

Media uploads are intentionally **not file-type restricted**: MDCMS accepts any MIME type/extension and stores it as media metadata + object storage.

Owner/Admin users can configure an optional image upload size limit in Studio
Settings. The setting is project-scoped, not environment-scoped, because media
assets are reusable across environments in the same project.

```ts
type MediaSettings = {
  media: {
    image: {
      maxUploadSizeBytes: number | null;
    };
  };
};
```

Equivalent JSON example:

```json
{
  "media": {
    "image": {
      "maxUploadSizeBytes": 10485760
    }
  }
}
```

Rules:

- No MIME/extension allowlist is enforced for media uploads.
- `media.image.maxUploadSizeBytes` applies only to files classified as images (`mime_type` starts with `image/`).
- If `maxUploadSizeBytes` is omitted/null, image uploads are unlimited at the MDCMS layer (infrastructure/proxy limits may still apply).
- A configured `maxUploadSizeBytes` must be a positive safe integer in bytes.
- Updating media settings replaces only the media settings document. It does not
  modify schema sync state or content type definitions.

### Upload Flow

1. User drags/pastes/uploads a file in the editor context (or uses an upload button).
2. Studio uploads the file to the MDCMS backend API (`POST /api/v1/media/upload`).
3. Backend stores the file in S3, records metadata in PostgreSQL, and returns the media asset metadata.
4. Studio inserts the asset URL into Markdown or stores the asset id in a schema file field, depending on the editor context.

### Media Metadata

```sql
CREATE TABLE media (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id),
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL,
    s3_key      TEXT NOT NULL,
    url         TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_media_settings (
    project_id                         UUID PRIMARY KEY REFERENCES projects(id),
    image_max_upload_size_bytes         BIGINT,
    updated_by                         TEXT NOT NULL,
    created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT project_media_settings_image_max_size_positive
      CHECK (image_max_upload_size_bytes IS NULL OR image_max_upload_size_bytes > 0)
);
```

The public media API returns metadata in camelCase and never exposes `s3_key`:

```ts
type MediaAsset = {
  id: string;
  project: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
};
```

`uploadedBy` is the authenticated actor id. For API-key initiated uploads it is
the user id that owns the API key.

Media metadata rows are deleted when a media asset is deleted. Deletion does not
rewrite existing documents that may contain the deleted asset URL or stored media
asset id. Expanded schema file field reads surface `MEDIA_NOT_FOUND` for deleted
or missing assets.

### API Surface

The media API provides project-scoped upload, list/search/filter, metadata read,
deletion, and project media settings. Studio editor uploads and the Studio media
library use the same project-scoped media metadata rows. Schema file fields use
media asset ids in content and `MediaAsset` metadata for validation and expanded
content responses.

---

## Webhooks (Post-MVP)

### Purpose

This chapter describes the webhook system design. Webhook configuration CRUD,
asynchronous server-side delivery, persisted delivery history, and the Studio
configuration and delivery history surfaces are available.

Webhooks notify external systems of content events. Primary use case: triggering static site rebuilds when content is published.

### Configuration

Webhooks are configured in the Studio UI under Settings → Webhooks.

Webhook configurations are environment-scoped. All webhook API routes require
explicit `project` and `environment` target routing, and the routed target
selects the configuration scope. Request bodies must not provide `project` or
`environment`; callers select scope only through the shared routing contract
defined in `SPEC-005`.

`WebhookConfig`:

```ts
type WebhookEvent =
  | "content.created"
  | "content.updated"
  | "content.published"
  | "content.unpublished"
  | "content.deleted"
  | "content.restored"
  | "media.uploaded";

type WebhookConfig = {
  id: string;
  project: string;
  environment: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};
```

Each webhook has:

- **URL** — The endpoint to call
- **Events** — Which events trigger the webhook (multi-select)
- **Secret** — signing secret for HMAC payload verification
- **Active** — Enable/disable toggle

Secrets are write-only API inputs. They are required on create, optional on
update for rotation, used as delivery signing material, and never returned by
list/create/update responses. Updating `url`, `events`, or `active` does not
change the stored secret unless a new `secret` value is provided.

Validation rules:

- `url` must be an absolute HTTPS URL with no fragment and a maximum length of
  2048 characters.
- `events` must be a non-empty array of unique values from the webhook event
  allowlist.
- `secret` must be a non-empty UTF-8 string with enough entropy for HMAC
  signing; MDCMS requires at least 32 characters and at most 4096 characters.
- `active` defaults to `true` on create when omitted.
- Target validation rejects private, loopback, link-local, and otherwise
  non-routable endpoints before delivery.
- Target validation applies to literal IP hosts and DNS names. The server
  resolves DNS names during create/update validation and immediately before
  delivery. If a hostname does not resolve, or any resolved address is private,
  loopback, link-local, multicast, reserved, documentation-only, or otherwise
  non-routable, the target is forbidden.

### Events

| Event                 | Trigger                                                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content.created`     | A new document is created                                                                                                                                                                                                                                             |
| `content.updated`     | Draft content persisted (includes single-user editor auto-save ticks, active collaboration autosaves/final saves, and explicit draft writes). Intended for staging/preview cache invalidation — production consumers should subscribe to `content.published` instead. |
| `content.published`   | A document is published                                                                                                                                                                                                                                               |
| `content.unpublished` | A document is unpublished (`published_version` cleared)                                                                                                                                                                                                               |
| `content.deleted`     | A document is soft-deleted                                                                                                                                                                                                                                            |
| `content.restored`    | A deleted document is restored                                                                                                                                                                                                                                        |
| `media.uploaded`      | A media file is uploaded                                                                                                                                                                                                                                              |

### Payload Format

All webhook payloads include:

- `event` — one of the allowed event values
- `timestamp` — ISO 8601 timestamp generated by the server
- `project` — routed project slug
- `environment` — routed environment name
- `user` — authenticated actor that caused the event; API-key initiated actions
  resolve to the API key owner

Content lifecycle events include `document`. The `version` field is the current
published version after the mutation, or `null` when no published snapshot
exists.

```json
{
  "event": "content.published",
  "timestamp": "2026-02-12T12:00:00Z",
  "project": "marketing-site",
  "environment": "production",
  "document": {
    "documentId": "uuid",
    "translationGroupId": "uuid",
    "path": "blog/hello-world",
    "type": "BlogPost",
    "locale": "en",
    "format": "md",
    "version": 5
  },
  "user": {
    "id": "uuid",
    "email": "alice@example.com"
  }
}
```

Media events include `media` and omit `document`:

```json
{
  "event": "media.uploaded",
  "timestamp": "2026-02-12T12:00:00Z",
  "project": "marketing-site",
  "environment": "production",
  "media": {
    "id": "uuid",
    "filename": "hero.png",
    "mimeType": "image/png",
    "sizeBytes": 204800,
    "url": "https://cdn.example.com/media/hero.png"
  },
  "user": {
    "id": "uuid",
    "email": "alice@example.com"
  }
}
```

Signed delivery headers use HMAC-SHA256 with the webhook signing secret.

#### Signing and Verification

- `X-MDCMS-Signature` format:
  - `t=<unix_timestamp>,v1=<hex_hmac_sha256(secret, t + "." + raw_body)>`
- Timestamp skew tolerance: 5 minutes.
- Webhook deliveries include:
  - `X-MDCMS-Delivery-Id` (UUID)
  - `X-MDCMS-Event-Id` (UUID idempotency key stable for the emitted event)
- Each delivery attempt uses a fresh `X-MDCMS-Delivery-Id`; all attempts for the
  same emitted event reuse the same `X-MDCMS-Event-Id`.
- Receivers verify the signature against the exact raw request body bytes.
- Verification rejects missing or malformed signature headers, signatures whose
  timestamp is outside the 5-minute skew tolerance, signature mismatches, and
  delivery ids that have already been accepted within the replay retention
  window.
- The default replay retention window is 5 minutes. Operators may keep accepted
  delivery ids longer, but must retain them for at least the skew tolerance.

### Delivery

- Webhooks are delivered asynchronously (fire-and-forget from the user's perspective).
- HTTPS-only delivery targets; non-HTTPS URLs are rejected.
- Retry and delivery targets are revalidated to avoid private network SSRF
  endpoints, including DNS rebinding after configuration.
- Failed deliveries use three total attempts: the initial attempt, then retries
  after 1 second and 2 seconds. The default worker runs in-process and
  fire-and-forget; delivery attempts must not keep the user-facing content or
  media mutation request open.
- The server persists every delivery attempt, including successful attempts,
  retryable failures, discarded targets, and exhausted failures. The persisted
  history is available to operators through the webhook history API and the
  Studio Settings → Webhooks surface.
- Migrations do not emit webhooks.

Webhook emission hooks run after successful content or media mutations commit.
For each emitted event, MDCMS selects active webhook configurations in the same
project/environment whose `events` array contains that event. Inactive webhooks
are ignored. A webhook delivery failure must not roll back the user-facing
content or media mutation.

Each delivery attempt sends the webhook payload as a JSON `POST` request to the
configured URL. Transport failures and non-2xx HTTP responses are retryable
until the configured attempt policy is exhausted.

Persisted delivery history records are append-only audit entries for each
attempt:

```ts
type WebhookDeliveryOutcome = "succeeded" | "retrying" | "failed" | "discarded";

type WebhookDeliveryHistoryEntry = {
  id: string;
  webhookId: string;
  project: string;
  environment: string;
  event: WebhookEvent;
  eventId: string;
  deliveryId: string;
  url: string;
  attempt: number;
  maxAttempts: number;
  outcome: WebhookDeliveryOutcome;
  statusCode: number | null;
  error: string | null;
  createdAt: string;
};
```

`statusCode` stores the downstream HTTP status when one was observed. Transport
failures and target validation failures use `null`.

The Studio Settings → Webhooks surface manages webhook configuration and
delivery history for the mounted project/environment. The Settings route remains
gated by `settings.manage`; users without that capability do not see or
interact with webhook configuration or history views, and the client does not
issue webhook configuration or delivery history requests while the route is
forbidden.

The configuration section shows loading, empty, error, unavailable, and
populated states. Admins can create, edit, and delete webhook configurations.
Creation and editing are addressable pages under the Webhooks settings section
rather than modals, so refresh and back navigation preserve the operator's
location. The create page includes URL, event multi-select, a generated signing
secret, and active toggle controls. Studio generates a high-entropy signing
secret for new webhooks, shows it before save so the operator can copy it to the
receiver, and allows regeneration or manual replacement before submission. A
successful create returns the operator to the Webhooks settings list. The edit
page includes URL, event multi-select, an optional signing secret field for
rotation, and active toggle controls. A successful edit returns the operator to
the Webhooks settings list. Secrets are never shown after save; leaving the edit
secret empty omits `secret` from the update payload and preserves the existing
secret. The configuration table exposes a direct active/inactive toggle for
quickly enabling or disabling a webhook without opening the edit page. Delete
requires explicit confirmation, removes only the webhook configuration, and
leaves persisted delivery history append-only.

Successful create, edit, and delete mutations refresh the configuration list.
Failed mutations surface the endpoint error message and keep the user's form or
confirmation state available for correction. The delivery history section shows
the most recent attempts for the mounted project/environment, exposes filters
for webhook id, event, and outcome, and renders loading, empty, error,
unavailable, and populated states.

---

## Search (Post-MVP)

### Deferred Design Target

When implemented, full-text search uses PostgreSQL's built-in full-text search capabilities (`tsvector` / `tsquery`) over a **materialized latest-published index**.

Default behavior:

- Search indexes only latest published snapshots (same visibility as default content API).
- Draft search is opt-in (`draft=true`) and requires draft permissions.
- Text search config is selected by locale (locale-aware analyzer with fallback to `simple`).

```sql
CREATE TABLE published_search_index (
    project_id      UUID NOT NULL,
    environment_id  UUID NOT NULL,
    document_id     UUID NOT NULL,
    locale          TEXT NOT NULL,
    schema_type     TEXT NOT NULL,
    search_config   REGCONFIG NOT NULL, -- e.g., 'english', 'french', 'german', 'simple'
    search_vector   TSVECTOR NOT NULL,
    PRIMARY KEY (project_id, environment_id, document_id, locale),
    FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);

CREATE INDEX idx_published_search_vector
  ON published_search_index
  USING gin(search_vector);

CREATE INDEX idx_published_search_scope_type_locale
  ON published_search_index (project_id, environment_id, schema_type, locale);
```

### API Usage (When Implemented)

```
# Required headers:
# X-MDCMS-Project: marketing-site
# X-MDCMS-Environment: production

GET /api/v1/content?q=hello+world&type=BlogPost
```

Use `draft=true` to search draft content (requires draft access permissions) once search is implemented.

### Future

The search backend is designed to be pluggable. A post-MVP upgrade path to Meilisearch or Typesense can be implemented without API changes.

---

## Media Endpoints

These routes define the canonical media API surface.

All `/api/v1/media*` endpoints require explicit target routing for `project`
and `environment` via headers or query parameters. Media metadata is stored at
project scope; the routed environment is used only for authorization and request
consistency. Request bodies must not provide `project` or `environment`.

Session-authenticated state-changing media requests follow the shared CSRF
rules from `SPEC-005`. API-key requests use bearer authentication and the
`media:*` operation scopes.

`MediaSettings`:

```ts
type MediaSettings = {
  media: {
    image: {
      maxUploadSizeBytes: number | null;
    };
  };
};
```

`MediaAsset`:

```ts
type MediaAsset = {
  id: string;
  project: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  uploadedBy: string;
  uploadedAt: string;
};
```

Schema file fields use `MediaAsset` metadata for validation and expansion.
Media upload remains unrestricted by schema; schema restrictions apply when
assigning an existing or newly uploaded asset to a content field.

`MediaAssetCategory` is a coarse server-defined filter category derived from
`mimeType`; it is not persisted in media metadata and is not returned as a
separate field:

```ts
type MediaAssetCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";
```

Category derivation:

- `image`, `video`, and `audio` match MIME types starting with `image/`,
  `video/`, and `audio/`.
- `document` matches `text/*` and common document-like `application/*` MIME
  types such as PDF, JSON, XML, RTF, Microsoft Office, and OpenDocument files.
- `archive` matches common archive MIME types such as ZIP, gzip, tar, 7z, and
  RAR.
- `other` is the fallback for every MIME type that does not match the categories
  above.

`GET /api/v1/media` lists project-scoped media metadata for the routed target.
It never reads the object body from storage and does not require the object-store
adapter to be configured. The response reports whether object storage is
configured so clients can disable upload entry points before attempting a
mutation.

Query parameters:

- `q` — optional filename search. The server trims the value, treats an empty
  value as omitted, limits it to 200 characters, and performs a
  case-insensitive substring match against `filename` only.
- `category` — optional `MediaAssetCategory` filter.
- `uploadedBy` — optional exact actor id filter against `uploadedBy`.
- `uploadedFrom` — optional `YYYY-MM-DD` UTC calendar date. Results include
  assets with `uploadedAt` greater than or equal to the start of that date.
- `uploadedTo` — optional `YYYY-MM-DD` UTC calendar date. Results include assets
  with `uploadedAt` less than the start of the following UTC date.
- `sort` — optional field: `uploadedAt`, `filename`, or `sizeBytes`. Default:
  `uploadedAt`.
- `order` — optional `asc` or `desc`. When omitted, `filename` sorts ascending;
  `uploadedAt` and `sizeBytes` sort descending.
- `limit` — optional integer from 1 through 100. Default: 30.
- `offset` — optional non-negative integer. Default: 0.

The date range is inclusive from the user's perspective. If both date filters
are provided, `uploadedFrom` must be less than or equal to `uploadedTo`.

Success response:

```ts
type MediaAssetListResponse = {
  data: MediaAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  storage: {
    objectStorageConfigured: boolean;
  };
};
```

`POST /api/v1/media/upload` accepts `multipart/form-data` with one required
`file` field. Additional fields are ignored only if they are browser-generated
multipart metadata; explicit application fields such as `project`,
`environment`, `s3Key`, or `url` are invalid. The server derives:

- `filename` from the uploaded file name, trimmed; if unavailable, the fallback
  is `upload`.
- `mimeType` from the uploaded file type; if unavailable, the fallback is
  `application/octet-stream`.
- `sizeBytes` from the uploaded byte length.
- `uploadedBy` from the authenticated actor. API-key uploads use the API key
  owner user id.

Upload size enforcement:

- If `mimeType` starts with `image/` and `media.image.maxUploadSizeBytes` is a
  positive number, `sizeBytes` must be less than or equal to that limit.
- Non-image uploads are not subject to `media.image.maxUploadSizeBytes`.
- Omitted or `null` `maxUploadSizeBytes` means unlimited at the MDCMS layer.

| Method | Path                     | Auth Mode             | Required Scope | Target Routing                  | Request                                               | Success                                             | Deterministic Errors                                                                                                                                                                                                                                                                         |
| ------ | ------------------------ | --------------------- | -------------- | ------------------------------- | ----------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/media/settings` | session (admin/owner) | none           | required: `project_environment` | explicit routing only                                 | `200` `{ data: MediaSettings }`                     | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                                                                                                             |
| PUT    | `/api/v1/media/settings` | session (admin/owner) | none           | required: `project_environment` | JSON: `MediaSettings`                                 | `200` `{ data: MediaSettings }`                     | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                                                                                    |
| GET    | `/api/v1/media`          | session_or_api_key    | `media:read`   | required: `project_environment` | explicit routing plus list/search/filter query params | `200` `{ data: MediaAsset[], pagination, storage }` | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_QUERY_PARAM` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                         |
| POST   | `/api/v1/media/upload`   | session_or_api_key    | `media:upload` | required: `project_environment` | multipart form data with required `file`              | `200` `{ data: MediaAsset }`                        | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `MEDIA_UPLOAD_TOO_LARGE` (`413`), `MEDIA_STORAGE_UNAVAILABLE` (`503`), `MEDIA_OBJECT_WRITE_FAILED` (`502`), `MEDIA_METADATA_WRITE_FAILED` (`500`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`) |
| GET    | `/api/v1/media/:id`      | session_or_api_key    | `media:read`   | required: `project_environment` | path `id`; explicit routing only                      | `200` `{ data: MediaAsset }`                        | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                               |
| DELETE | `/api/v1/media/:id`      | session_or_api_key    | `media:delete` | required: `project_environment` | path `id`                                             | `200` `{ data: { deleted: true, id } }`             | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `MEDIA_STORAGE_UNAVAILABLE` (`503`), `MEDIA_OBJECT_DELETE_FAILED` (`502`), `MEDIA_METADATA_DELETE_FAILED` (`500`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)            |

Error split:

- `INVALID_INPUT` (`400`) means a path id is not a UUID, the request body is not
  valid `multipart/form-data` or JSON for the selected endpoint, the required
  `file` field is missing, the uploaded part is not a file, a client-supplied
  reserved media field was provided, or `maxUploadSizeBytes` is not `null` or a
  positive safe integer.
- `INVALID_QUERY_PARAM` (`400`) means a media list query parameter is malformed,
  unsupported, outside its allowed range, or the uploaded date range is inverted.
- `MEDIA_UPLOAD_TOO_LARGE` (`413`) means an image upload exceeds the configured
  `media.image.maxUploadSizeBytes` value. Implementations must include
  `details.limitBytes` and `details.sizeBytes`.
- `MEDIA_STORAGE_UNAVAILABLE` (`503`) means the object-store adapter is not
  configured or cannot create a usable client from operator configuration.
- `MEDIA_OBJECT_WRITE_FAILED` (`502`) means the object-store write failed before
  metadata could be persisted. Implementations must not create a metadata row
  for this failure.
- `MEDIA_METADATA_WRITE_FAILED` (`500`) means object storage succeeded but
  metadata persistence failed. Implementations should attempt best-effort object
  cleanup and include `details.cleanupAttempted`.
- `MEDIA_OBJECT_DELETE_FAILED` (`502`) means a metadata row exists but the
  object-store delete failed. Implementations must leave the metadata row in
  place so the operation can be retried.
- `MEDIA_METADATA_DELETE_FAILED` (`500`) means the object-store delete
  succeeded or was idempotently accepted, but metadata deletion failed.
- `NOT_FOUND` (`404`) means the media id does not exist in the routed project.

Deletion semantics:

- Deleting a media asset deletes the object from S3-compatible storage and then
  deletes the metadata row.
- Object deletion is idempotent for a known metadata row: if the object is
  already absent and the object store reports a successful delete, MDCMS
  continues with metadata deletion.
- Deleting media does not scan or rewrite existing documents that may still
  contain the asset URL or stored media asset id. Expanded schema file field
  reads surface `MEDIA_NOT_FOUND` for deleted or missing assets.

## Webhook Endpoints

These routes are **Post-MVP**. They are intentionally omitted from the canonical MVP endpoint appendix in §24.

All `/api/v1/webhooks*` endpoints require explicit target routing for `project`
and `environment` via headers or query parameters. Session-authenticated
state-changing webhook requests follow the shared CSRF rules from `SPEC-005`.
API-key requests use bearer authentication and the `webhooks:*` operation
scopes.

`WebhookCreateInput`:

```ts
type WebhookCreateInput = {
  url: string;
  events: WebhookEvent[];
  secret: string;
  active?: boolean;
};
```

`WebhookUpdateInput`:

```ts
type WebhookUpdateInput = {
  url?: string;
  events?: WebhookEvent[];
  secret?: string;
  active?: boolean;
};
```

`PUT /api/v1/webhooks/:id` is a partial update. It must include at least one
defined field. Omitted fields retain their existing values.

`GET /api/v1/webhooks/deliveries` accepts these query parameters:

- `webhookId` — optional webhook id filter.
- `event` — optional `WebhookEvent` filter.
- `outcome` — optional `WebhookDeliveryOutcome` filter.
- `limit` — optional integer from 1 through 100; defaults to 50.

| Method | Path                          | Auth Mode          | Required Scope   | Target Routing                  | Request                               | Success                                         | Deterministic Errors                                                                                                                                                                                                                                                     |
| ------ | ----------------------------- | ------------------ | ---------------- | ------------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/webhooks`            | session_or_api_key | `webhooks:read`  | required: `project_environment` | explicit routing only                 | `200` `{ data: WebhookConfig[] }`               | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                                                                                         |
| GET    | `/api/v1/webhooks/deliveries` | session_or_api_key | `webhooks:read`  | required: `project_environment` | explicit routing plus query filters   | `200` `{ data: WebhookDeliveryHistoryEntry[] }` | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `WEBHOOK_EVENT_UNSUPPORTED` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                                                           |
| POST   | `/api/v1/webhooks`            | session_or_api_key | `webhooks:write` | required: `project_environment` | JSON: `WebhookCreateInput`            | `200` `{ data: WebhookConfig }`                 | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `WEBHOOK_EVENT_UNSUPPORTED` (`400`), `WEBHOOK_URL_NOT_HTTPS` (`400`), `WEBHOOK_TARGET_FORBIDDEN` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                      |
| PUT    | `/api/v1/webhooks/:id`        | session_or_api_key | `webhooks:write` | required: `project_environment` | path `id`; JSON: `WebhookUpdateInput` | `200` `{ data: WebhookConfig }`                 | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `WEBHOOK_EVENT_UNSUPPORTED` (`400`), `WEBHOOK_URL_NOT_HTTPS` (`400`), `WEBHOOK_TARGET_FORBIDDEN` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`) |
| DELETE | `/api/v1/webhooks/:id`        | session_or_api_key | `webhooks:write` | required: `project_environment` | path `id`                             | `200` `{ data: { deleted: true, id } }`         | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                                                                                                                    |

Error split:

- `INVALID_INPUT` (`400`) means the request body or path parameter is malformed,
  the update body has no defined fields, the URL is not absolute, the URL
  contains a fragment, `events` is empty or contains duplicates, `secret` fails
  the length rules, `active` is not boolean, or a delivery history query
  parameter is malformed.
- `WEBHOOK_EVENT_UNSUPPORTED` (`400`) means an event value is syntactically a
  string but is not in the webhook event allowlist.
- `WEBHOOK_URL_NOT_HTTPS` (`400`) means the URL scheme is not `https:`.
- `WEBHOOK_TARGET_FORBIDDEN` (`400`) means target validation identified a
  private, loopback, link-local, or otherwise non-routable endpoint.
  Implementations should include `details.field = "url"` plus a stable
  `details.reason` such as `forbidden_hostname`, `forbidden_address`,
  `resolved_forbidden_address`, `target_not_resolved`, or
  `resolution_failed`. When known, `details.hostname` and `details.address`
  identify the rejected target.
- `NOT_FOUND` (`404`) means the webhook id does not exist in the routed
  project/environment.
