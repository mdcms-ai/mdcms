# CMS-115 Redis-Loss Recovery Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm CMS-115 Redis-loss recovery validation without duplicating the deterministic harness already added for the collaboration baseline.

**Architecture:** Use the SPEC-007 collaboration load/soak harness as the validation artifact for Redis-loss autosave durability. Keep the CMS-114 backup/restore drill dependency out of this epic branch because it belongs to the separate operations hardening epic.

**Tech Stack:** Bun test, TypeScript, Yjs, collaboration runtime hooks, in-memory Redis/content test doubles.

---

## Spec Delta Summary

- No `docs/specs` change is required for CMS-115.
- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` defines deterministic Redis-loss validation for collaboration autosave durability.
- `docs/specs/SPEC-011-local-development-and-operations.md` documents the operator-facing Redis-loss recovery drill, including the expectation that PostgreSQL is the durable recovery point and Redis presence/cache state is ephemeral.
- Affected behavior: the deterministic collaboration baseline test persists an active autosave, flushes the in-memory Redis/Yjs state, reopens the same document room, and asserts the rebuilt Yjs state comes from the PostgreSQL draft head.
- Acceptance criteria covered:
  - AC1: Redis flush/restart recoverability from the database head is covered by `redisLossRecovery` in the CMS-112 harness.
  - AC2: data and API integrity are covered by assertions for PostgreSQL body/frontmatter, exact single draft revision increment, no version rows, fresh Redis metadata after reopen, and cleanup.
  - AC3: no new public contract or operator workflow is introduced by CMS-115 in this branch; the existing operator workflow remains documented in SPEC-011.

## Dependency Decision

CMS-115 lists CMS-54 and CMS-114 as dependencies. CMS-54 is implemented in this branch. CMS-114 is still `To Do` and belongs to the separate CMS-154 Security & Release Hardening epic.

This branch therefore implements the deterministic product validation required by SPEC-007 and records that the operational drill prerequisite remains outside the CMS-155 collaboration scope. Do not add a second Redis-loss test solely to mirror the ticket number; the CMS-112 harness already exercises the required runtime behavior.

## File Structure

- Existing: `apps/server/src/lib/collaboration/load-soak-test-support.ts`
  - Owns `redisLossRecovery`, including the post-autosave Redis flush, room reopen, PostgreSQL rebuild assertion, and Redis metadata freshness assertion.
- Existing: `apps/server/src/lib/collaboration/load-soak.test.ts`
  - Asserts `redisLossRecovery.rebuiltFromPostgres`, recovered Markdown/frontmatter equality, and fresh Redis state after reopen.
- Existing: `docs/specs/SPEC-011-local-development-and-operations.md`
  - Documents the operator-facing Redis-loss recovery drill.
- Create: `.ai/plans/2026-06-14-cms-115-redis-loss-recovery-validation.md`
  - Records the CMS-115 scope mapping and dependency decision.

## Task 1: Confirm Scope and Dependency State

**Files:**
- Create: `.ai/plans/2026-06-14-cms-115-redis-loss-recovery-validation.md`

- [x] **Step 1: Read the ticket**

Read CMS-115 from Jira.

Observed scope:

```text
Summary: Redis-loss recovery validation for autosave durability
Dependencies: CMS-54, CMS-114
Acceptance Criteria:
1. Redis flush/restart preserves recoverability from DB head.
2. Data and API behavior is internally consistent and does not violate scope/integrity guarantees.
3. Any newly introduced public contract or operator workflow in this task is documented at the point of use.
```

- [x] **Step 2: Read the external dependency**

Read CMS-114 from Jira.

Observed state:

```text
Summary: Backup/restore drills and runbook for Postgres/Redis/MinIO
Status: To Do
Parent: CMS-154 Security & Release Hardening
```

- [x] **Step 3: Confirm owning specs**

Read:

```bash
sed -n '870,914p' docs/specs/SPEC-007-editor-mdx-and-collaboration.md
sed -n '208,236p' docs/specs/SPEC-011-local-development-and-operations.md
```

Expected:
- SPEC-007 defines the deterministic collaboration Redis-loss validation harness.
- SPEC-011 defines the operator Redis-loss recovery drill.

## Task 2: Map CMS-115 to the Implemented Validation Artifact

**Files:**
- Existing: `apps/server/src/lib/collaboration/load-soak-test-support.ts`
- Existing: `apps/server/src/lib/collaboration/load-soak.test.ts`
- Create: `.ai/plans/2026-06-14-cms-115-redis-loss-recovery-validation.md`

- [x] **Step 1: Verify CMS-112 harness covers CMS-115 runtime behavior**

Inspect `runCollaborationBaselineScenario` and confirm it:

```text
1. Persists at least one active autosave to the content store.
2. Flushes volatile Redis/Yjs state through `flushVolatileCollaborationState`.
3. Reopens the same document room through `onLoadDocument`.
4. Serializes the recovered Y.Doc.
5. Asserts the recovered Markdown/frontmatter match the PostgreSQL draft head.
6. Asserts Redis is fresh after reopen.
```

- [x] **Step 2: Verify test assertions**

Inspect `load-soak.test.ts` and confirm it asserts:

```text
result.redisLossRecovery.rebuiltFromPostgres === true
result.redisLossRecovery.recoveredMarkdown === result.redisLossRecovery.expectedMarkdown
result.redisLossRecovery.recoveredFrontmatter deep-equals expectedFrontmatter
result.redisLossRecovery.redisFreshAfterReopen === true
```

- [x] **Step 3: Avoid duplicate coverage**

Decision:

```text
No additional runtime test is required for CMS-115 in this branch because the CMS-112 deterministic harness is the stronger coverage path required by SPEC-007.
```

## Task 3: Verification and Commit

**Files:**
- Create: `.ai/plans/2026-06-14-cms-115-redis-loss-recovery-validation.md`

- [x] **Step 1: Use CMS-112 verification as the runtime evidence**

Runtime verification already completed for the harness commit:

```bash
bun test --cwd apps/server ./src/lib/collaboration/load-soak.test.ts ./src/lib/collaboration/runtime.test.ts ./src/lib/collaboration/redis-store.test.ts
bun run check
bun run format:check
git diff --check
bun run changeset:check
```

Expected: all pass.

- [x] **Step 2: Commit the CMS-115 decision record**

Run:

```bash
git add .ai/plans/2026-06-14-cms-115-redis-loss-recovery-validation.md
git commit -m "docs(collaboration): record redis loss validation scope"
```

Expected: commit succeeds and the worktree is clean.

## Self-Review Checklist

- CMS-115 behavior is explicitly mapped to the committed SPEC-007 harness.
- CMS-114 remains identified as an external dependency under CMS-154.
- No duplicate runtime test is introduced.
- No task identifiers are written inside `docs/specs`.
- No new public contract or operator workflow is introduced.
