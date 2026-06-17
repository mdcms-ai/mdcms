# Collaboration-Aware Publish Design

## Context

Studio editable document routes currently enable a document room whenever the
Session-authenticated user can write the latest draft. While the document room
is open, editor body changes and frontmatter changes flow through Yjs state and
the collaboration socket. The server persists that Yjs snapshot to PostgreSQL
through active collaboration autosave, explicit collaboration flush, and final
save after the last collaborator disconnects.

This makes the normal Studio editing path collaboration-first. The non-
collaboration HTTP draft save path still exists for embed modes where the
document room is unavailable or disabled, but it is not the primary local Studio
path.

The current publish rule blocks every publish while the active collaboration
lock exists. That protects external writers from publishing stale content, but
it also prevents the active Studio editor from publishing the persisted draft it
just saved through the collaboration runtime.

## Goal

Publish must be available from an active document room when the current user has
publish access. The action must publish the current durable draft head in
PostgreSQL unless the user explicitly chooses to save live editor changes first.

## Approaches Considered

### Recommended: Publish Saved Draft, Prompt for Unsaved Room State

Studio enables Publish during active collaboration when the document has
unpublished changes and the current draft is saved. If there are unsaved live
editor changes, clicking Publish opens a prompt:

- **Save and publish** flushes the document room, waits for persistence, then
  publishes the new durable draft head.
- **Publish saved draft** skips the flush and publishes the current PostgreSQL
  draft head. The live unsaved editor changes remain in the document room and
  may autosave later as new unpublished changes.
- **Cancel** closes the prompt without saving or publishing.

This keeps PostgreSQL as the durable source of truth for publish, avoids sending
body/frontmatter snapshots through the publish request, and makes the user
choose when live unsaved room state differs from the saved draft.

### Alternative: Always Flush Before Publish

Publish would always flush the document room before publishing. This is simple
and usually matches user intent, but it removes the ability to publish the
already saved draft while leaving ongoing in-room changes unpublished.

### Alternative: Publish Directly From Yjs State

Publish would serialize the current document room snapshot and create the
version from that snapshot. This would bypass the existing publish model where
versions are created from PostgreSQL document heads, and it would duplicate
draft persistence concerns inside publish.

## Detailed Behavior

### Saved Active Collaboration Draft

When the current Studio state is saved and `hasUnpublishedChanges` is true,
Publish is enabled even while the document room remains open. Clicking Publish
opens the existing publish dialog. Submitting the dialog publishes the current
PostgreSQL draft head.

### Unsaved Active Collaboration Draft

When the current Studio state is unsaved or saving, clicking Publish opens a
choice prompt before the publish dialog or publish submission proceeds.

If the user chooses **Save and publish**, Studio sends a collaboration flush and
waits for a `saved` or `unchanged` result. On success, Studio updates its draft
revision/save state from the flush result, then continues to publish. On flush
error or timeout, Studio does not publish and surfaces the collaboration save
error.

If the user chooses **Publish saved draft**, Studio publishes the current
PostgreSQL draft head without flushing the live room state first. The prompt
must make clear that unsaved editor changes remain unpublished and can later
autosave as new unpublished changes.

### Non-Collaboration Draft

The existing HTTP save and publish behavior remains unchanged for embed modes
without an active document room.

### External Writers

External HTTP clients, API-key callers, CLI operations, module surfaces, and
bulk operations remain blocked by the active collaboration lock for existing
document mutations unless they are explicitly routed through the active document
room contract.

### Multi-Collaborator Rooms

Any collaborator with publish access may publish the saved draft head from the
active document room. If their local Studio state has unsaved changes, they see
the same choice prompt. The published version is whatever PostgreSQL draft head
exists when the publish transaction runs.

Edits that arrive after the chosen draft head is published remain as draft
changes and can make the document show unpublished changes again.

## Contract Changes Needed

- The Studio spec must stop saying that Publish is disabled solely because an
  active collaboration lock exists.
- The editor/collaboration spec must define collaboration-aware publish:
  publish reads the PostgreSQL draft head, while Studio may first flush the
  document room when the user chooses to save live changes.
- The content API or collaboration runtime must expose a server-side way for
  publish requests from the active document room to bypass the generic active
  collaboration lock guard without weakening the guard for external writes.

## Testing

- Studio view tests cover Publish enabled for saved active collaboration drafts.
- Studio controller/state tests cover unsaved collaboration publish choices:
  save-and-publish, publish-saved-draft, cancel, and flush failure.
- Server tests cover active document-room publish authorization and preserve the
  active collaboration lock for external writes.
- Regression coverage verifies that publishing a saved active room leaves the
  document room active and does not require disconnecting the editor.
