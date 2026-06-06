# CMS-109 Editor Media Upload Design

## Context

CMS-109 adds inline Studio media upload behavior on top of the media API shipped
by CMS-106 and the TipTap markdown pipeline shipped by CMS-51. The existing
media endpoint contract is owned by `SPEC-010`; the new editor behavior is
owned by `SPEC-006` under the document editor route.

The current Studio editor already centralizes toolbar commands, drag/drop
behavior, read-only gating, and markdown emission inside
`packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`.
Document page state already derives `canWrite` from the content route and schema
guard state, while the shared capabilities contract exposes
`capabilities.media.upload`.

## Spec Delta

`docs/specs/SPEC-006-studio-runtime-and-ui.md` now defines editor media
insertion behavior for `/admin/content/:type/:documentId`:

- Toolbar upload, dropped files, and pasted files are equivalent inputs.
- Upload starts only when the document is writable and the target capability
  snapshot grants `capabilities.media.upload`.
- Studio uploads one multipart `file` field to `POST /api/v1/media/upload`
  using the mounted project/environment routing and Studio auth mode.
- Returned image assets insert `![filename](url)` and other assets insert
  `[filename](url)`.
- Insertions mark the normal body draft unsaved and rely on existing draft
  persistence.
- Upload progress/error states render inline, with deterministic copy and
  assertive error feedback.

## Considered Approaches

### Preferred: Extend the TipTap Editor Wrapper

Add a small Studio media upload API helper, a document-page upload controller,
and media insertion helpers in the existing TipTap editor wrapper.

Why this fits:

- The wrapper already owns the toolbar image button, editor read-only state,
  drop handling, and markdown emission.
- Paste/drop/button insertion can share one implementation.
- The document page can keep API/auth/capability concerns outside the editor and
  pass a focused `mediaUpload` prop.
- Tests can cover pure insertion formatting, API request construction, page
  gating, and editor static UI without requiring a browser upload stack.

Tradeoff: `tiptap-editor.tsx` is already large. Keep new logic in focused helper
files and only wire it from the component.

### Alternative: ProseMirror Plugin

Create a dedicated ProseMirror plugin for paste/drop handling and command
insertion.

Why not now:

- It is a good fit for deep editor semantics, but this task also needs Studio
  auth, upload UI state, and toolbar file picker wiring.
- It would spread one upload state machine across ProseMirror plugin state and
  React state for little benefit at this scope.

### Alternative: Page-Level DOM Handlers

Keep `TipTapEditor` unchanged and wrap it from `ContentDocumentPageView` with
upload drop/paste handlers.

Why not:

- The page does not have direct access to editor coordinates, selection, or
  markdown insertion commands.
- It would duplicate read-only and drop behavior that the editor already owns.

## Design

### API Helper

Create `packages/studio/src/lib/runtime-ui/lib/media-upload-api.ts`:

- `createStudioMediaUploadApi(config, options)` mirrors the style of the media
  settings API.
- `upload(file)` posts `FormData` with only the `file` field.
- Requests include `x-mdcms-project`, `x-mdcms-environment`, Studio auth, and
  `x-mdcms-csrf-token` for cookie-authenticated mutations.
- Responses are validated with `assertMediaAssetResponse`.
- Route errors preserve backend `code`, `message`, `status`, and details so the
  editor can render deterministic messages.

### Document Page Controller

Derive `canUploadMedia` in `content-document-page-state.ts` from ready schema
capabilities. This keeps capability details out of the editor component.

In `content-document-page.tsx`, create the media upload API from active Studio
mount context/session state and pass a focused upload state to `TipTapEditor`:

- `canUpload` is true only when state is ready, `state.canWrite` is true, no
  historical version is being viewed, and `state.canUploadMedia` is true.
- Missing API configuration or missing cookie CSRF disables upload and produces
  an unavailable state if triggered indirectly.
- Upload failures are held in page/editor local state and do not change the
  draft body.

### Editor Integration

Add focused helpers near the editor component or in
`media-markdown-insertion.ts`:

- `formatMediaAssetMarkdown(asset)` returns image syntax for
  `mimeType.startsWith("image/")`, otherwise link syntax.
- Filenames are used as alt/link text after bracket escaping and fallback to
  `asset.filename || "media"`.
- Batch insertions are joined with blank lines.

`TipTapEditor` receives a `mediaUpload` prop with `canUpload`, `isUploading`,
`uploadFiles(files)`, and `errorMessage`. The toolbar image button opens a
hidden file input when enabled. Drop and paste handlers collect `File` objects
and call the same upload path. After successful upload, the editor inserts the
generated markdown at the drop position when available, otherwise at the current
selection/caret, then emits markdown immediately through the existing change
pipeline.

### UI States

- Uploading: inline status near the canvas, `role="status"` and polite live
  region.
- Error: inline alert near the canvas, `role="alert"` and assertive live region.
- Read-only/no media scope: toolbar action disabled with a descriptive tooltip
  or title. Drag/paste upload does not intercept the event.
- Copy states that MDCMS does not enforce a file-type allowlist and the image
  byte limit only applies to MIME types starting with `image/`.

### Testing

Use test-driven slices:

- Pure markdown helper tests for image/link formatting, escaping, and batch
  ordering.
- Media upload API tests for request shape, target routing, cookie CSRF,
  API-key auth, response validation, and route errors.
- Document page state tests for `canUploadMedia` derivation and guarded schema
  updates.
- Static render tests for toolbar enabled/disabled/uploading/error copy.
- Editor interaction tests where feasible with synthetic paste/drop events and
  stubbed upload callbacks.

## Scope Boundaries

In scope:

- Single-file and multi-file upload from button, drop, and paste.
- Markdown insertion of returned URLs.
- Role-aware upload constraints and inline states.
- Studio-side API helper and tests.

Out of scope:

- Media library picker/search.
- Asset replacement, deletion, tagging, folders, transforms, or usage tracking.
- Rewriting existing document URLs when media assets are deleted.
- Server endpoint changes beyond consuming the existing contract.

## Self-Review

- No placeholders or unresolved decisions remain.
- The spec delta is standalone and does not reference task IDs.
- Public endpoint behavior remains owned by `SPEC-010`; Studio editor behavior
  is owned by `SPEC-006`.
- The design preserves package boundaries: shared types stay in
  `@mdcms/shared`, Studio API/client UI lives in `@mdcms/studio`, and backend
  media behavior stays in `@mdcms/server`.
