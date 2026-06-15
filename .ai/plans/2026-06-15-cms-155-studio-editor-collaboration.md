# CMS-155 Studio Editor Collaboration Wiring

## Scope

Wire the Studio content editor into the existing collaboration document room so body edits flow through the Hocuspocus/Yjs socket, active-room saves flush the collaboration room, and presence chips include the current session while cursor overlays remain remote-only.

## Spec Delta

- No new product contract is required. The behavior is already specified by:
  - `docs/specs/SPEC-006-studio-runtime-and-ui.md`: active editor route uses `WS /api/v1/collaboration`, avoids HTTP `PUT` body saves while the collaboration room is active, and Save Draft flushes the room.
  - `docs/specs/SPEC-007-editor-mdx-and-collaboration.md`: document-room Yjs field names, session-cookie auth, room flush control messages, and presence rendering rules.
- Affected behavior:
  - Studio content document editor body binding.
  - Studio Save Draft/autosave behavior while a document room is active.
  - Presence chips and remote cursor filtering.
- Acceptance coverage:
  - CMS-53: Studio joins and syncs the Hocuspocus/Yjs document room.
  - CMS-54: Save/autosave flushes collaboration state instead of HTTP-writing active rooms.
  - CMS-55: Presence chips render current and remote collaborators; cursor overlays exclude the current session.

## Implementation Plan

1. Add failing coverage.
   - Update presence tests so the current session appears in `users` and is absent from `remoteCursors`.
   - Add pure Studio helper tests for document-room URL construction and Hocuspocus-compatible sync message framing.
   - Add server transport coverage for string JSON flush control messages routed outside binary Hocuspocus sync frames.

2. Add Studio document collaboration primitives.
   - Create `collaboration-document` helpers with document-room URL construction, document-name generation, sync/auth message encoding, incoming message application, and flush request parsing.
   - Add a React hook that owns a Y.Doc, opens the document-room socket, sends auth + sync step 1, applies incoming sync updates, sends local Yjs updates, and exposes `flush()`.

3. Bind TipTap to Yjs.
   - Add a collaboration prop to `TipTapEditor`.
   - Inject a small TipTap extension backed by `y-prosemirror` `ySyncPlugin` for the existing `default` Y.XmlFragment.
   - Keep existing markdown emission so page state and preview can follow the collaborative document without performing HTTP draft writes.

4. Wire Studio page behavior.
   - Enable document collaboration only for authenticated cookie sessions, writable latest drafts, and valid project/environment routing.
   - Pass the Y.XmlFragment into `TipTapEditor`.
   - Route Save Draft and autosave through `flush()` while collaboration is active; leave the existing guarded HTTP path for non-collaborative/read-only cases.
   - Include the current session in presence chips and filter it only from cursor overlays.

5. Verify.
   - Run focused Studio and server tests.
   - Run formatting/check gates.
   - Use the existing dev compose stack to verify the server and Studio example still boot and expose the active editor route.
