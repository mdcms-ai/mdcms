# CMS-55 Presence Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement baseline real-time Studio presence for content lists and editor pages, including online/view/edit state, user labels/colors, and editor cursor/selection snapshots.

**Architecture:** Use a target-scoped JSON WebSocket at `/api/v1/collaboration/presence` for presence updates and snapshots. Store ephemeral per-session presence records in Redis with a 30-second TTL, authorize view/edit document updates server-side, and render compact Studio indicators from backend-filtered snapshots. Do not introduce the full Hocuspocus/Yjs Studio editor provider in this ticket.

**Tech Stack:** Bun test, TypeScript, Zod contracts in `@mdcms/shared`, Redis-backed collaboration store, crossws Bun WebSocket transport, React 19 Studio runtime UI.

---

## Spec Delta

Owning specs were updated before implementation:

- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` now defines `presence.update` JSON messages on the target-scoped presence stream.
- The presence stream URL remains target-scoped (`project` + `environment`, no URL `documentId`), while document-specific state is reported in socket messages.
- `view` updates with a `documentId` require draft read access. `edit` updates require draft read and content write access. Unauthorized updates close with the existing collaboration `4401` / `4403` close codes.
- Baseline cursor/selection snapshots are carried by the presence stream so Studio can render editor cursors before a full document-room client provider exists.

CMS-55 acceptance criteria covered by this plan:

1. Content list and editor render real-time presence from presence snapshots.
2. Presence tracks online users, document view/edit targets, and editor cursor/selection positions.
3. Indicators use user-identifiable labels/colors from the server contract.
4. Role-aware constraints are enforced by server authorization for presence updates and by Studio mode selection.
5. The public contract is documented in the spec and typed in `@mdcms/shared`.

## File Structure

- Create `packages/shared/src/lib/contracts/collaboration.ts`
  - Zod schemas and types for presence modes, cursors, update messages, users, and snapshots.
- Modify `packages/shared/src/index.ts`
  - Export the collaboration contract.
- Modify `apps/server/src/lib/collaboration/redis-store.ts`
  - Add presence key builder, TTL constant, record schema parsing, `setPresence`, `deletePresence`, and `listPresence`.
- Modify `apps/server/src/lib/collaboration/redis-store.test.ts`
  - Cover presence key shape, TTL writes, target isolation, and invalid record filtering.
- Modify `apps/server/src/lib/collaboration-auth.ts`
  - Split document-room query validation from presence-stream query validation.
  - Add presence handshake/update authorization.
- Modify `apps/server/src/lib/collaboration-auth.test.ts`
  - Cover presence auth, forbidden URL `documentId`, API-key rejection, and edit-mode write checks.
- Modify `apps/server/src/lib/collaboration/transport.ts`
  - Route both document-room and presence-stream upgrades through one Bun websocket handler.
  - Add presence peer lifecycle, JSON message handling, snapshot broadcast, and cleanup.
- Modify `apps/server/src/lib/collaboration/transport.test.ts`
  - Cover route detection, handshake failure mapping, JSON snapshot delivery, invalid updates, and close cleanup.
- Modify `apps/server/src/lib/collaboration/transport.integration.test.ts`
  - Add end-to-end presence snapshots for online/editing users and disconnect cleanup.
- Modify `apps/server/src/lib/runtime-with-modules.ts`
  - Wire the Redis-backed presence store through the collaboration transport.
- Create `packages/studio/src/lib/collaboration-presence.ts`
  - WebSocket URL builder, snapshot parser, grouping/filtering helpers, and update serialization.
- Create `packages/studio/src/lib/collaboration-presence.test.ts`
  - Unit tests for URL conversion, schema parsing, current-session filtering, and edit-precedence grouping.
- Create `packages/studio/src/lib/runtime-ui/hooks/use-collaboration-presence.ts`
  - React hook that opens the presence stream in cookie-authenticated Studio sessions, sends updates, and stores snapshots.
- Create `packages/studio/src/lib/runtime-ui/components/presence/presence-indicators.tsx`
  - Compact avatar stack, mode chips, editor collaborator bar, and remote cursor layer primitives.
- Create `packages/studio/src/lib/runtime-ui/components/presence/presence-indicators.test.tsx`
  - Static markup tests for list/editor indicators and accessible labels.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx`
  - Subscribe to presence, group by visible document ids, and render row indicators in the title/path cell.
- Modify `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx`
  - Cover presence table columns staying stable and row indicators rendering from supplied data.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
  - Emit collapsed and non-collapsed cursor selections, and render remote cursor labels from presence users.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts`
  - Cover cursor callback normalization and read-only behavior.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
  - Subscribe to presence for the routed document, send `view` or `edit` mode based on `canWrite`/version state, pass remote cursors into `TipTapEditor`, and render the editor collaborator bar.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`
  - Cover editor presence markup and view-mode behavior when write is forbidden.

## Task 1: Shared Presence Contract

**Files:**
- Create: `packages/shared/src/lib/contracts/collaboration.ts`
- Create: `packages/shared/src/lib/contracts/collaboration.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add failing contract tests**

Add tests that assert valid update/snapshot payloads parse and invalid cursor/update payloads fail:

```typescript
test("collaboration presence schemas parse updates and snapshots", () => {
  const update = CollaborationPresenceUpdateSchema.parse({
    type: "presence.update",
    documentId: "11111111-1111-4111-8111-111111111111",
    mode: "edit",
    cursor: { anchor: 2, head: 7 },
  });
  assert.equal(update.mode, "edit");

  const snapshot = CollaborationPresenceSnapshotSchema.parse({
    type: "presence.snapshot",
    project: "marketing",
    environment: "draft",
    users: [
      {
        userId: "user-1",
        sessionId: "session-1",
        label: "Ada",
        color: "#2563eb",
        documentId: "11111111-1111-4111-8111-111111111111",
        mode: "view",
        cursor: { anchor: 1, head: 1 },
        updatedAt: "2026-06-14T10:00:00.000Z",
      },
    ],
  });
  assert.equal(snapshot.users[0]?.label, "Ada");
});

test("collaboration presence schemas reject invalid modes and cursors", () => {
  assert.equal(
    CollaborationPresenceUpdateSchema.safeParse({
      type: "presence.update",
      mode: "publish",
    }).success,
    false,
  );
  assert.equal(
    CollaborationPresenceCursorSchema.safeParse({ anchor: -1, head: 1 })
      .success,
    false,
  );
});
```

- [ ] **Step 2: Implement schemas and exports**

Implement:

```typescript
export const CollaborationPresenceModeSchema = z.enum(["view", "edit"]);
export const CollaborationPresenceCursorSchema = z.object({
  anchor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
});
export const CollaborationPresenceUpdateSchema = z.object({
  type: z.literal("presence.update"),
  documentId: z.string().uuid().nullable().optional(),
  mode: CollaborationPresenceModeSchema,
  cursor: CollaborationPresenceCursorSchema.nullable().optional(),
});
export const CollaborationPresenceUserSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  documentId: z.string().uuid().nullable(),
  mode: CollaborationPresenceModeSchema,
  cursor: CollaborationPresenceCursorSchema.optional(),
  updatedAt: z.string().datetime(),
});
export const CollaborationPresenceSnapshotSchema = z.object({
  type: z.literal("presence.snapshot"),
  project: z.string().min(1),
  environment: z.string().min(1),
  users: z.array(CollaborationPresenceUserSchema),
});
```

Export inferred types and add `export * from "./lib/contracts/collaboration.js";` to `packages/shared/src/index.ts`.

- [ ] **Step 3: Verify shared tests**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/collaboration.test.ts
```

Expected: pass.

## Task 2: Redis Presence Store

**Files:**
- Modify: `apps/server/src/lib/collaboration/redis-store.ts`
- Modify: `apps/server/src/lib/collaboration/redis-store.test.ts`

- [ ] **Step 1: Add failing Redis tests**

Add tests for:

- `buildCollaborationPresenceKey("marketing", "draft", "session-1")` equals `mdcms:collaboration:presence:marketing:draft:session-1`.
- `setPresence` writes JSON with `EX 30`.
- `listPresence` returns only valid records for the requested target.
- `deletePresence` deletes the exact session key.

- [ ] **Step 2: Extend the Redis client contract**

Add `scan(cursor, "MATCH", pattern, "COUNT", count)` to `CollaborationRedisClient`, and implement it in `FakeRedisClient` for tests by filtering `values.keys()` against the supplied pattern.

- [ ] **Step 3: Add presence store methods**

Add:

```typescript
export const COLLABORATION_PRESENCE_TTL_SECONDS = 30;
export function buildCollaborationPresenceKey(input: {
  project: string;
  environment: string;
  sessionId: string;
}): string {
  return `mdcms:collaboration:presence:${input.project}:${input.environment}:${input.sessionId}`;
}
```

Add store methods:

```typescript
setPresence(record: CollaborationPresenceUser): Promise<void>;
deletePresence(input: { project: string; environment: string; sessionId: string }): Promise<void>;
listPresence(input: { project: string; environment: string }): Promise<CollaborationPresenceUser[]>;
```

Use `CollaborationPresenceUserSchema.safeParse` when reading. Ignore malformed records.

- [ ] **Step 4: Verify Redis tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts
```

Expected: pass.

## Task 3: Presence Authorization

**Files:**
- Modify: `apps/server/src/lib/collaboration-auth.ts`
- Modify: `apps/server/src/lib/collaboration-auth.test.ts`

- [ ] **Step 1: Add failing auth tests**

Cover:

- Document-room handshake still requires `documentId`.
- Presence handshake accepts `project` and `environment` with no `documentId`.
- Presence handshake rejects URL `documentId`.
- API-key bearer tokens are rejected for presence.
- Presence `edit` update for a document calls write authorization and maps authorization failure to `4403`.

- [ ] **Step 2: Add presence context and query parsing**

Add:

```typescript
export type CollaborationPresenceContext = {
  userId: string;
  sessionId: string;
  project: string;
  environment: string;
  role: string;
  label: string;
  color: string;
};
```

Use a deterministic color derived from `userId` with a stable palette. Label should prefer a display name if a future session exposes one, otherwise use the email local-part, then `userId`.

- [ ] **Step 3: Add presence auth guard methods**

Extend `createCollaborationAuthGuard` return type with:

```typescript
authorizePresenceHandshake(request): Promise<PresenceHandshakeResult>;
authorizePresenceUpdate(request, context, update): Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;
filterPresenceSnapshot(request, context, users): Promise<CollaborationPresenceUser[]>;
```

Handshake requires session auth and `content:read:draft` for the target scope. `view` update with `documentId` requires draft read for that document path. `edit` update requires draft read and content write for that document path.

- [ ] **Step 4: Verify auth tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration-auth.test.ts
```

Expected: pass.

## Task 4: Presence Transport And Runtime Wiring

**Files:**
- Modify: `apps/server/src/lib/collaboration/transport.ts`
- Modify: `apps/server/src/lib/collaboration/transport.test.ts`
- Modify: `apps/server/src/lib/collaboration/transport.integration.test.ts`
- Modify: `apps/server/src/lib/runtime-with-modules.ts`

- [ ] **Step 1: Add failing transport tests**

Cover:

- `isCollaborationWebSocketUpgradeRequest` returns true for `/api/v1/collaboration/presence`.
- Presence upgrade returns `503` when presence storage is unavailable.
- Presence open sends an initial `presence.snapshot`.
- Valid `presence.update` stores the record and broadcasts a filtered snapshot.
- Invalid JSON or invalid update closes with `4403`.
- Closing the last socket for a session deletes that session's presence record; closing one of two sockets for the same session does not.

- [ ] **Step 2: Extend transport context**

Use one crossws adapter. Store peer context as either `{ kind: "document"; collaboration }` or `{ kind: "presence"; presence }`. Existing document-room behavior must remain byte-for-byte compatible with Hocuspocus.

- [ ] **Step 3: Implement presence peer lifecycle**

On presence open:

1. Add peer to a per-target/session connection set.
2. Store an online record with `documentId: null`, `mode: "view"`, server label/color, and `updatedAt`.
3. Send an immediate snapshot to the peer.

On presence message:

1. Parse UTF-8 JSON.
2. Validate `CollaborationPresenceUpdateSchema`.
3. Reauthorize update with the presence auth guard.
4. Store the updated record.
5. Broadcast a fresh filtered snapshot to open presence peers for the same target.

On close:

1. Remove peer from the connection set.
2. Delete Redis presence only when no other local socket for that session remains.
3. Broadcast the fresh snapshot.

- [ ] **Step 4: Wire runtime-with-modules**

Pass the Redis collaboration store to the transport as presence storage when Redis is available. Keep the existing unavailable error details for both document-room and presence-stream upgrades.

- [ ] **Step 5: Verify server collaboration tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts ./src/lib/collaboration/transport.test.ts ./src/lib/collaboration/transport.integration.test.ts
```

If the integration test fails with `EPERM` on `127.0.0.1`, rerun the same command with sandbox escalation for localhost binding.

Expected: pass.

## Task 5: Studio Presence Client And List Indicators

**Files:**
- Create: `packages/studio/src/lib/collaboration-presence.ts`
- Create: `packages/studio/src/lib/collaboration-presence.test.ts`
- Create: `packages/studio/src/lib/runtime-ui/hooks/use-collaboration-presence.ts`
- Create: `packages/studio/src/lib/runtime-ui/components/presence/presence-indicators.tsx`
- Create: `packages/studio/src/lib/runtime-ui/components/presence/presence-indicators.test.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx`

- [ ] **Step 1: Add pure helper tests**

Cover:

- `http://localhost:4000` becomes `ws://localhost:4000/api/v1/collaboration/presence?...`.
- `https://cms.example.com/api` becomes `wss://cms.example.com/api/api/v1/collaboration/presence?...`.
- Snapshot parsing rejects unknown shapes.
- Grouping filters current `sessionId`, filters to visible ids, and sorts edit-mode users before view-mode users.

- [ ] **Step 2: Implement pure helpers**

Implement:

```typescript
createPresenceWebSocketUrl(config): string;
parsePresenceSnapshot(raw): CollaborationPresenceSnapshot | null;
groupPresenceByDocument(users, { visibleDocumentIds, currentSessionId }): Map<string, CollaborationPresenceUser[]>;
```

- [ ] **Step 3: Implement the React hook**

`useCollaborationPresence` should:

- Return idle state when `auth.mode !== "cookie"` or the session is not authenticated.
- Open the presence WebSocket with credentials via browser cookies.
- Send `presence.update` on open and whenever `documentId`, `mode`, or `cursor` changes.
- Keep the latest parsed snapshot in React state.
- Close the socket on unmount or target changes.

- [ ] **Step 4: Implement compact indicators**

Create small avatar-stack components using existing `Avatar`, `AvatarFallback`, and `Tooltip` primitives. Include `data-mdcms-presence-mode="edit|view"` and a tooltip label like `Ada editing` or `Grace viewing`.

- [ ] **Step 5: Render list indicators**

In `ContentTypePage`, call `useCollaborationPresence({ mode: "view" })`, group by visible row ids, and pass `presenceByDocumentId` to `ContentTypeDocumentsTable`. Render indicators inside the title/path cell next to the document title. Do not add an `Online now` sidebar or a new table column.

- [ ] **Step 6: Verify Studio list tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/collaboration-presence.test.ts ./src/lib/runtime-ui/components/presence/presence-indicators.test.tsx './src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx'
```

Expected: pass.

## Task 6: Editor Presence And Remote Cursor Rendering

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

- [ ] **Step 1: Add failing editor tests**

Cover:

- `TipTapEditor` publishes `{ anchor, head }` on collapsed cursor and selection changes.
- Read-only editor still reports `view` presence from the page but does not send `edit`.
- Editor collaborator bar renders non-current sessions for the routed document.
- Remote cursor labels render with `data-mdcms-remote-cursor` and server-provided labels/colors.

- [ ] **Step 2: Add cursor callback and remote cursor props**

Add TipTap props:

```typescript
type TipTapEditorCursorSelection = { anchor: number; head: number };
onCursorSelectionChange?: (selection: TipTapEditorCursorSelection) => void;
remoteCursors?: Array<{
  sessionId: string;
  label: string;
  color: string;
  cursor: TipTapEditorCursorSelection;
}>;
```

Call `onCursorSelectionChange` from `onSelectionUpdate` with ProseMirror `selection.anchor` and `selection.head`.

- [ ] **Step 3: Render remote cursors**

Inside the editor canvas wrapper, compute cursor coordinates with `editor.view.coordsAtPos(cursor.head)` relative to the editor wrapper. Render compact absolutely positioned labels with `data-mdcms-remote-cursor={sessionId}`. If coordinate calculation throws because a cursor is stale, skip that cursor until the next snapshot.

- [ ] **Step 4: Wire document page presence**

In `ContentDocumentPage`, call `useCollaborationPresence` with:

```typescript
documentId: state.status === "ready" ? state.documentId : null;
mode: state.status === "ready" && state.canWrite && !state.viewingVersion ? "edit" : "view";
cursor: latestCursorSelection;
```

Pass filtered remote cursors into `TipTapEditor` and render the editor collaborator bar near the preview mode/action controls.

- [ ] **Step 5: Verify editor tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

## Task 7: CMS-55 Verification And Release Hygiene

**Files:**
- Update only if needed: `.ai/memory/architecture.md`, `.ai/memory/product.md`, `.ai/memory/lessons.md`
- Generated by CLI if package source changed: `.changeset/*.md`

- [ ] **Step 1: Run focused server tests**

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-store.test.ts ./src/lib/collaboration/transport.test.ts ./src/lib/collaboration/transport.integration.test.ts ./src/lib/collaboration-auth.test.ts
```

- [ ] **Step 2: Run focused Studio/shared tests**

```bash
bun test --cwd packages/shared ./src/lib/contracts/collaboration.test.ts
bun test --cwd packages/studio ./src/lib/collaboration-presence.test.ts ./src/lib/runtime-ui/components/presence/presence-indicators.test.tsx './src/lib/runtime-ui/app/admin/content/[type]/page.test.tsx' ./src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

- [ ] **Step 3: Run workspace gates**

```bash
bun run typecheck
bun run format:check
git diff --check
```

- [ ] **Step 4: Create a changeset**

This ticket touches published packages `@mdcms/shared` and `@mdcms/studio`. Run:

```bash
bun run changeset
```

Select `@mdcms/shared` and `@mdcms/studio`, choose patch releases, and summarize the presence contract/UI additions. Do not hand-write the generated changeset.

## Completion Notes

CMS-55 is ready for review when:

- presence contracts parse and reject invalid messages deterministically;
- presence stream auth rejects API keys, enforces target scope, forbids URL `documentId`, and enforces view/edit document permissions;
- Redis presence records use the documented key shape and expire within 30 seconds;
- list/editor Studio surfaces render compact labels/colors from backend-filtered snapshots;
- editor cursor/selection snapshots are sent and remote cursor labels render for readable same-document collaborators;
- token-mode Studio does not attempt session-cookie collaboration sockets;
- focused tests, typecheck, format check, and changeset generation are complete.
