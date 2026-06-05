# CMS-106 Media API Design

Date: 2026-06-05

## Goal

Ship the first media-management backend slice: project-scoped media metadata,
S3-compatible object storage, upload/read/delete API routes, and project media
settings needed to enforce the image-only upload size cap.

## Spec Delta

The owning spec update is in
`docs/specs/SPEC-010-media-webhooks-search-and-integrations.md`.

Changed behavior:

- Media storage now defines required S3 settings plus optional
  `S3_PUBLIC_BASE_URL` for browser-safe returned URLs.
- Media settings are project-scoped and use
  `media.image.maxUploadSizeBytes: number | null`.
- Public media metadata responses use `MediaAsset` and never expose `s3Key`.
- The media endpoint contract now covers:
  - `GET /api/v1/media/settings`
  - `PUT /api/v1/media/settings`
  - `POST /api/v1/media/upload`
  - `GET /api/v1/media/:id`
  - `DELETE /api/v1/media/:id`
- Deterministic media errors are specified, including upload-size, storage
  configuration, object-write/delete, and metadata-write/delete failures.

Supporting spec updates:

- `docs/specs/SPEC-005-auth-authorization-and-request-routing.md` now defines
  `media:read`, `media:upload`, and `media:delete` plus `media` capability
  response fields.
- `docs/specs/SPEC-011-local-development-and-operations.md` now lists
  `S3_PUBLIC_BASE_URL` in the local Docker Compose defaults.

Acceptance criteria covered by this delta:

- Upload/get/delete media endpoints have a normative HTTP contract.
- Required metadata fields are reflected by the existing `media` table and the
  `MediaAsset` response contract.
- Any file type is accepted; only image MIME types are checked against the
  optional size setting.
- Project scoping, explicit target routing, authorization, CSRF, and
  deterministic error behavior are defined.
- Operator-facing storage settings and public URL derivation are documented.

## Existing Code Context

The Drizzle schema and initial migration already contain a `media` table with
the required metadata columns:

- `id`
- `project_id`
- `filename`
- `mime_type`
- `size_bytes`
- `s3_key`
- `url`
- `uploaded_by`
- `uploaded_at`

There is no media route, media shared contract, project media settings
persistence, object-store adapter, or media authorization mapping yet.

`apps/studio-review` is not present in this checkout. Contract-consumer updates
for this ticket therefore apply to shared contracts and server tests, not a
separate Studio review app.

## Architecture

The implementation should mirror the existing webhook/content API shape:

- `@mdcms/shared` owns media contract types and validators.
- `apps/server/src/lib/media/*` owns media route parsing, store behavior,
  object-store abstraction, and tests.
- `apps/server/src/lib/auth.ts` and `apps/server/src/lib/rbac.ts` own the
  `media:*` scope/capability mapping.
- `apps/server/src/lib/env.ts` owns S3 operator configuration parsing.
- `apps/server/src/lib/server.ts` mounts the media routes through the normal
  Elysia app configurator path.

The object-store abstraction should be small and injectable:

```ts
type MediaObjectStore = {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  deleteObject(input: { key: string }): Promise<void>;
  publicUrlForKey(key: string): string;
};
```

Tests can use an in-memory object store. The production adapter can use Bun's
S3-compatible client if available in the current runtime, or a small
AWS-compatible signed `PUT`/`DELETE` implementation only if Bun's client cannot
support the needed operations. Keep the adapter behind the interface so API
tests do not depend on live MinIO.

## Data Flow

Upload:

1. Route resolves explicit target routing and authorizes `media:upload`.
2. Session requests pass CSRF validation.
3. Route parses `multipart/form-data` and extracts the required `file`.
4. Route derives filename, MIME type, byte size, and actor id.
5. Store reads project media settings.
6. If the upload is an image and a positive size limit exists, enforce it.
7. Store generates a media id and S3 key.
8. Object store writes bytes.
9. Database persists the metadata row.
10. Route returns `{ data: MediaAsset }`.
11. Webhook dispatcher emits `media.uploaded` after the successful mutation.

Read:

1. Route resolves target routing and authorizes `media:read`.
2. Store loads the metadata row by id and project.
3. Missing rows return `NOT_FOUND`.
4. Route returns `{ data: MediaAsset }`.

Delete:

1. Route resolves target routing and authorizes `media:delete`.
2. Session requests pass CSRF validation.
3. Store loads the metadata row by id and project.
4. Object store deletes the key.
5. Store deletes the metadata row.
6. Route returns `{ data: { deleted: true, id } }`.

Media settings:

1. `GET /api/v1/media/settings` and `PUT /api/v1/media/settings` are
   session-only admin/owner routes.
2. Settings are project-scoped and independent of schema sync.
3. A missing settings row returns the default unlimited state.

## Error Handling

Use `RuntimeError` with the exact codes from `SPEC-010`.

Important boundaries:

- Object-write failure must not create metadata.
- Metadata-write failure after object-write should attempt best-effort object
  cleanup and include `cleanupAttempted`.
- Object-delete failure must leave metadata in place for retry.
- A missing object that the object store treats as a successful delete is not a
  media API error when the metadata row exists.

## Testing Strategy

Use TDD for each implementation step.

Focused tests:

- Shared media contract validators accept valid media/settings payloads and
  reject invalid shapes.
- Auth tests prove `media:read`, `media:upload`, and `media:delete` are
  mappable scopes and appear in capabilities.
- Route unit tests cover missing routing, missing file, any-file upload,
  image-size rejection, non-image bypass, read not found, delete not found,
  storage write failure, metadata write cleanup, and delete storage failure.
- Database-backed integration tests prove project scoping and metadata
  persistence.
- Env tests cover S3 config and public URL parsing.

Verification:

- `bun test --cwd packages/shared ./src/lib/contracts/media.test.ts`
- `bun test --cwd apps/server ./src/lib/media`
- `bun test --cwd apps/server ./src/lib/auth.test.ts`
- `bun test --cwd apps/server ./src/lib/env.test.ts`
- `bun run format:check`
- `bun run check`

## Out Of Scope

- Studio media settings UI.
- Inline editor upload UI and Markdown insertion.
- Media library browse/search/filter UI.
- Bulk content operations.
- Tags, folders, asset usage tracking, image transformations, CDN controls,
  duplicate detection, and advanced asset governance.
