# Studio Media Settings Design

## Context

The media API phase already defines project-scoped media settings and the
`GET/PUT /api/v1/media/settings` contract. The Studio Settings route currently
has General, API keys, and Webhooks sections, all gated by
`capabilities.settings.manage`.

CMS-107 adds the Studio UI for `media.image.maxUploadSizeBytes`.

## Spec Delta

- `docs/specs/SPEC-006-studio-runtime-and-ui.md` now owns the Studio Settings
  Media panel behavior at `/admin/settings/media`.
- The panel reads and writes the media settings endpoint for the active mounted
  target while preserving the backend rule that the setting is project-scoped.
- The UI contract defines unlimited/null mode, explicit positive byte mode,
  deterministic client validation, load/save/unavailable states, and
  role-aware gating through `capabilities.settings.manage`.

Acceptance criteria covered:

1. Owner/Admin users can view and update the project media upload setting.
2. The form supports unlimited/null and explicit positive byte values.
3. User-facing copy states that all file types are accepted and the limit
   applies only to image MIME types.
4. Primary, edge, and role-aware states are specified.
5. The public Studio behavior is documented in the owning spec.

## Design

Add a first-party `Media` section to the existing Settings subnavigation:

- Route: `/admin/settings/media`
- Label: `Media`
- Icon: `Image`
- Capability gate: reuse the existing Settings route gate,
  `canManageSettings`.

The panel should fit the existing Settings page tone: dense, operational, and
quiet. It should not create a separate card-heavy page or marketing-style
screen. The main content is one focused settings form with a small status
summary.

## Data Flow

Create a Studio media settings API helper under
`packages/studio/src/lib/runtime-ui/lib/media-settings-api.ts`.

Responsibilities:

- Build routed headers from the active Studio API config.
- `getSettings()` calls `GET /api/v1/media/settings`.
- `updateSettings(input)` calls `PUT /api/v1/media/settings` with JSON and the
  CSRF header for session-authenticated mutation requests.
- Validate responses with `assertMediaSettingsResponse`.
- Convert non-OK responses into `RuntimeError` with operation details.

Create a hook under
`packages/studio/src/lib/runtime-ui/hooks/use-media-settings.ts`.

Responsibilities:

- Derive API config from `useStudioApiConfig()`.
- Derive CSRF from `useStudioSession()`.
- Return `loading`, `ready`, `error`, or `unavailable`.
- Expose `settings`, `errorMessage`, `refetch`, `updateSettings`,
  `isUpdating`, and `updateError`.
- Invalidate the query after a successful update.

## Form Behavior

Create `SettingsMediaPanel` under
`packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx`.

Ready state behavior:

- The form initializes from the loaded settings.
- Unlimited mode maps to `media.image.maxUploadSizeBytes: null`.
- Explicit mode maps to a positive safe integer.
- Switching to unlimited keeps the previous explicit draft in local state, but
  save sends `null`.
- Switching back to explicit restores the last typed explicit draft.
- Save is disabled when unchanged, invalid, loading, or saving.
- Reset restores the last saved baseline.
- Save failures stay inline; successful saves update the baseline and show a
  small saved status.

Validation:

- Blank explicit value: invalid.
- Non-numeric value: invalid.
- Zero, negative, fractional, or unsafe integer: invalid.
- Valid explicit value: positive safe integer bytes.

Visible copy must make the backend semantics explicit:

- MDCMS accepts any file type.
- The configured limit applies only when the uploaded MIME type starts with
  `image/`.
- Infrastructure/proxy limits may still apply outside MDCMS.

## Tests

Test first in this order:

1. Studio API helper fetches and updates media settings with target headers,
   CSRF, and response validation.
2. The media settings hook reports unavailable, loading/ready/error states and
   invalidates after save.
3. Settings page routing exposes the Media tab and preserves addressable
   `/settings/media` route selection.
4. `SettingsMediaPanel` renders ready, loading, error, unavailable, invalid,
   unchanged, updating, and save-error states.
5. The existing forbidden Settings state hides Media content when
   `canManageSettings` is false.

## Open Decisions

No product decision is left open for this ticket. The UI follows the existing
Settings page layout and the backend contract shipped by the media API phase.
