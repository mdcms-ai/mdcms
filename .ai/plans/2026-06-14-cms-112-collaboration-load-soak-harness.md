# CMS-112 Collaboration Load/Soak Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic CI coverage for the SPEC-007 collaboration baseline concurrency profile.

**Architecture:** Build a server-side test harness around `createCollaborationRuntimeHooks` with in-memory content, Redis/Yjs, lifecycle, and presence fakes. The harness simulates the SPEC-007 baseline without real network sockets, real timers, Redis, or PostgreSQL, so it remains deterministic and fast in CI while still exercising the collaboration runtime persistence path, CrossWS presence transport hooks, Yjs update convergence, and Redis-loss rebuild behavior.

**Tech Stack:** Bun test, TypeScript, Yjs, existing collaboration runtime hooks, in-memory test doubles.

---

## Spec Delta Summary

- No `docs/specs` change is required for CMS-112.
- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` already defines the collaboration regression coverage, baseline concurrency profile, Redis-loss validation, and 30-second CI pass/fail threshold.
- Affected behavior: deterministic server CI coverage for collaboration runtime convergence, Redis state/metadata, autosave persistence, lifecycle events, active locks, cleanup, presence transport hook records, and PostgreSQL rebuild after Redis loss.
- Acceptance criteria covered:
  - AC1: baseline profile and pass/fail thresholds are documented in SPEC-007 and mirrored as named test constants.
  - AC2: new coverage is deterministic because it uses runtime hooks and in-memory test doubles.
  - AC3: no new public operator workflow or public contract is introduced; the harness documents the baseline at point of use in test-support code and assertions.

## File Structure

- Create `apps/server/src/lib/collaboration/load-soak-test-support.ts`
  - Owns the deterministic baseline profile constants, in-memory fakes, and `runCollaborationBaselineScenario`.
  - This is test support, not production runtime behavior.
- Create `apps/server/src/lib/collaboration/load-soak.test.ts`
  - Owns assertions that the harness result satisfies SPEC-007.
- Modify `.ai/plans/2026-06-14-cms-112-collaboration-load-soak-harness.md`
  - Track task completion checkboxes.

## Task 1: Add the Failing Baseline Test

**Files:**
- Create: `apps/server/src/lib/collaboration/load-soak.test.ts`
- Modify: `.ai/plans/2026-06-14-cms-112-collaboration-load-soak-harness.md`

- [x] **Step 1: Create the baseline test**

Create `apps/server/src/lib/collaboration/load-soak.test.ts` with:

```typescript
import assert from "node:assert/strict";

import { test } from "bun:test";

import {
  COLLABORATION_BASELINE_PROFILE,
  runCollaborationBaselineScenario,
} from "./load-soak-test-support.js";

test("collaboration baseline load/soak scenario satisfies SPEC-007", async () => {
  const result = await runCollaborationBaselineScenario();

  assert.equal(COLLABORATION_BASELINE_PROFILE.roomCount, 4);
  assert.equal(COLLABORATION_BASELINE_PROFILE.sessionsPerRoom, 3);
  assert.equal(COLLABORATION_BASELINE_PROFILE.mutationsPerSession, 25);
  assert.equal(COLLABORATION_BASELINE_PROFILE.timeoutMs, 30_000);
  assert.equal(result.rooms.length, COLLABORATION_BASELINE_PROFILE.roomCount);
  assert.equal(result.totals.sessionCount, 12);
  assert.equal(result.totals.mutationCount, 300);
  assert.equal(result.totals.contentUpdatedEvents, 4);
  assert.equal(result.totals.versionRowsCreated, 0);
  assert.equal(
    result.activeLockCountBeforeCleanup,
    COLLABORATION_BASELINE_PROFILE.roomCount,
  );
  assert.deepEqual(
    result.targetPresenceDuring,
    result.rooms.flatMap((room) => room.expectedPresenceDuring),
  );
  assert.deepEqual(result.targetPresenceAfter, []);
  assert.ok(
    result.elapsedMs < COLLABORATION_BASELINE_PROFILE.timeoutMs,
    `baseline took ${result.elapsedMs}ms`,
  );
  assert.equal(result.redisLossRecovery.rebuiltFromPostgres, true);
  assert.equal(
    result.redisLossRecovery.recoveredMarkdown,
    result.redisLossRecovery.expectedMarkdown,
  );
  assert.deepEqual(
    result.redisLossRecovery.recoveredFrontmatter,
    result.redisLossRecovery.expectedFrontmatter,
  );
  assert.equal(result.redisLossRecovery.redisFreshAfterReopen, true);

  for (const room of result.rooms) {
    assert.equal(room.sessionCount, 3);
    assert.equal(room.mutationCount, 75);
    assert.equal(room.updateCount, 1);
    assert.equal(room.draftRevisionAfter, room.draftRevisionBefore + 1);
    assert.equal(room.finalMarkdown, room.expectedMarkdown);
    assert.deepEqual(room.finalFrontmatter, room.expectedFrontmatter);
    assert.deepEqual(
      room.convergedClientMarkdown,
      Array.from({ length: room.sessionCount }, () => room.expectedMarkdown),
    );
    assert.equal(room.redisFreshBeforeCleanup, true);
    assert.equal(room.activeLockPresentBeforeCleanup, true);
    assert.equal(room.activeLockPresentAfterCleanup, false);
    assert.equal(room.finalizedAfterCleanup, true);
    assert.equal(room.lifecycleEventCount, 1);
    assert.equal(room.versionRowsCreated, 0);
    assert.deepEqual(room.presenceDuring, room.expectedPresenceDuring);
    assert.deepEqual(room.presenceAfter, []);
  }
});
```

- [x] **Step 2: Run the focused test to verify failure**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/load-soak.test.ts
```

Expected: fail because `./load-soak-test-support.js` does not exist yet.

## Task 2: Implement the Deterministic Baseline Harness

**Files:**
- Create: `apps/server/src/lib/collaboration/load-soak-test-support.ts`
- Modify: `.ai/plans/2026-06-14-cms-112-collaboration-load-soak-harness.md`

- [x] **Step 1: Create the harness module**

Create `apps/server/src/lib/collaboration/load-soak-test-support.ts` with a deterministic harness that:

- exports `COLLABORATION_BASELINE_PROFILE` with room/session/mutation/timeout values from SPEC-007;
- creates four draft documents in one `marketing/draft` target;
- loads one runtime room per document through `onLoadDocument` before applying mutations, so all four rooms are active in the same target until the cleanup phase;
- represents three Studio sessions per room through distinct collaboration contexts and presence peers driven through `createCollaborationWebSocketTransport`;
- applies 25 body mutations per session by encoding the origin client's Yjs update and applying that update to the runtime room plus the other client documents, interleaved across the active rooms;
- calls one `onStoreDocument` flush per room;
- checks Redis freshness before disconnect cleanup;
- calls last-disconnect cleanup;
- closes presence peers through the transport close hook and verifies presence removal.

Use these public exports:

```typescript
export const COLLABORATION_BASELINE_PROFILE = {
  roomCount: 4,
  sessionsPerRoom: 3,
  mutationsPerSession: 25,
  timeoutMs: 30_000,
} as const;

export type CollaborationBaselineRoomResult = {
  documentId: string;
  sessionCount: number;
  mutationCount: number;
  draftRevisionBefore: number;
  draftRevisionAfter: number;
  expectedMarkdown: string;
  finalMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
  finalFrontmatter: Record<string, unknown>;
  convergedClientMarkdown: string[];
  redisFreshBeforeCleanup: boolean;
  activeLockPresentBeforeCleanup: boolean;
  activeLockPresentAfterCleanup: boolean;
  finalizedAfterCleanup: boolean;
  updateCount: number;
  lifecycleEventCount: number;
  versionRowsCreated: number;
  expectedPresenceDuring: CollaborationPresenceUser[];
  presenceDuring: CollaborationPresenceUser[];
  presenceAfter: CollaborationPresenceUser[];
};

export type CollaborationRedisLossRecoveryResult = {
  documentId: string;
  expectedMarkdown: string;
  recoveredMarkdown: string;
  expectedFrontmatter: Record<string, unknown>;
  recoveredFrontmatter: Record<string, unknown>;
  rebuiltFromPostgres: boolean;
  redisFreshAfterReopen: boolean;
};

export type CollaborationBaselineResult = {
  elapsedMs: number;
  rooms: CollaborationBaselineRoomResult[];
  redisLossRecovery: CollaborationRedisLossRecoveryResult;
  activeLockCountBeforeCleanup: number;
  targetPresenceDuring: CollaborationPresenceUser[];
  targetPresenceAfter: CollaborationPresenceUser[];
  totals: {
    roomCount: number;
    sessionCount: number;
    mutationCount: number;
    contentUpdatedEvents: number;
    versionRowsCreated: number;
  };
};
```

Implementation details:

- Use `performance.now()` to measure elapsed time.
- Use `createCollaborationRuntimeHooks` from `./runtime.js`.
- Use `yDocToMarkdown`, `yDocToFrontmatter`, and `yjsUpdateToYDoc` from `./runtime.js`.
- Use `createCollaborationDocumentName` for room names.
- Set active-lock heartbeat and finalized-room timers to inert deterministic fakes:

```typescript
setActiveLockHeartbeat: () => Symbol("heartbeat"),
clearActiveLockHeartbeat: () => undefined,
setFinalizedRoomLeaseTimeout: () => Symbol("finalized-room"),
clearFinalizedRoomLeaseTimeout: () => undefined,
```

- The in-memory content store must implement `CollaborationRuntimeContentStore` for multiple documents and increment `draftRevision` exactly once per `update`.
- The in-memory Redis/presence store must implement `CollaborationRuntimeRedisStore` and expose:

```typescript
activeLocks: Map<string, string>;
finalizedDocumentIds: Set<string>;
setPresence(record: CollaborationPresenceUser & { project: string; environment: string }): Promise<void>;
deletePresence(input: { project: string; environment: string; sessionId: string }): Promise<void>;
listPresence(input: { project: string; environment: string }): Promise<CollaborationPresenceUser[]>;
```

- The lifecycle fake must count `content.updated` events from active autosaves.
- The auth guard must always return `{ ok: true }`.
- The generated final Markdown for a room must include all 75 mutations so the expected persisted body is unambiguous. Build it from a heading, the initial body, and one paragraph per mutation.
- Presence assertions must compare exact target-wide and per-room payloads, including user/session identity, label, color, cursor, and `updatedAt`.
- After at least one active autosave, flush the in-memory Redis/Yjs state, reopen the same document through `onLoadDocument`, and assert the rebuilt Yjs state matches the PostgreSQL draft body/frontmatter and refreshes Redis metadata.

- [x] **Step 2: Run the focused test to verify pass**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/load-soak.test.ts
```

Expected: pass with one test.

## Task 3: Review, Gates, and Commit

**Files:**
- Modify: `.ai/plans/2026-06-14-cms-112-collaboration-load-soak-harness.md`

- [x] **Step 1: Run the relevant collaboration tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/load-soak.test.ts ./src/lib/collaboration/runtime.test.ts ./src/lib/collaboration/redis-store.test.ts
```

Expected: pass.

- [x] **Step 2: Run workspace gates**

Run:

```bash
bun run check
bun run format:check
git diff --check
bun run changeset:check
```

Expected: all pass. CMS-112 only touches server test/support files and a plan, so no new changeset should be required beyond the already committed shared changeset in this epic branch.

- [x] **Step 3: Commit the CMS-112 slice**

Run:

```bash
git add .ai/plans/2026-06-14-cms-112-collaboration-load-soak-harness.md apps/server/src/lib/collaboration/load-soak.test.ts apps/server/src/lib/collaboration/load-soak-test-support.ts
git commit -m "test(collaboration): add baseline load soak harness"
```

Expected: commit succeeds and the worktree is clean.

## Self-Review Checklist

- SPEC-007 baseline room/session/mutation counts are mirrored by named constants.
- The test asserts the 30-second timeout threshold.
- The test asserts converged client state, Redis freshness, PostgreSQL draft body/frontmatter persistence through the content-store fake, exact single draft revision increment, no version rows, content.updated events, concurrent active locks, cleanup, exact presence payloads, and presence removal.
- The harness uses no real network, Redis, PostgreSQL, timers, or sleeps.
- There are no task IDs inside `docs/specs`.
