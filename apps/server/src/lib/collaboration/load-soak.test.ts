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
  assert.deepEqual(result.rooms.map((room) => room.type).sort(), [
    "author",
    "campaign",
    "page",
    "post",
  ]);
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
