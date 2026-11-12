# MCP Coverage, Studio and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implementation outline with interface sketches and verification cases. Production code and complete test bodies are not supplied; unchecked steps are pending implementation and validation.

**Goal:** Complete the agreed domain tool inventory and verify the end-to-end user workflow.

**Architecture:** All tool handlers remain thin adapters to existing routes. Studio uses session-only connection management; CI exercises actual MCP transport.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia, Drizzle/PostgreSQL, MCP TypeScript SDK, React.

---

Run from the repository root. Preserve unrelated working changes.
This plan does not authorize commit, push, publish, deployment or external messages.
Run focused tests after each task; parent integration owns commits and the full gate.

## Spec delta

SPEC-005/009 extend environment listing to narrowly scoped bearer credentials.
The existing role requirement remains; creation/deletion remain session-only.
SPEC-009 also requires server-derived attribution for every clone/promote target
head and newly inserted version, preserving existing target creation attribution
on overwrite and leaving dry runs without writes or events.

SPEC-015 enumerates tools, schemas and domain errors. SPEC-006 adds Connected apps
using SPEC-005 contracts. Acceptance requires coverage without weaker route auth,
Studio failure states, public setup guidance and integration evidence.
Dependencies: shared tools, OAuth/MCP and CLI bridge plans. Shared-tools Task 3a
repairs atomic restore/delete and published restore before those tools/undo ship.
Task 1b below repairs existing clone/promote authorization before registering those
remote tools. Task 1c carries authenticated attribution through their raw SQL
writes and depends on Task 1b plus the shared ContentWriteAttribution/auth helpers.
Both tasks must be complete before clone/promote integration is accepted. Thin
dispatch alone cannot satisfy these dependencies.

### Task 1: Remaining route-backed tools

Create `apps/server/src/lib/agent-tools/{versions,translations,media,environments,webhooks}.ts`
and matching `.test.ts` files; extend content.ts and registry.ts.

- [ ] Implement the remaining SPEC-015 table rows using exact existing paths:
      variants, version list/detail/restore, duplicate, delete, restore, unpublish,
      media/upload, environment clone/promote, and webhooks/deliveries. Export schemas
      with typed response envelopes from shared contracts, not untyped success blobs.
- [ ] Reuse WebhookCreateInput (url/events/secret/active), WebhookUpdateInput and
      WebhookDeliveryHistoryQuery from shared contracts/webhooks.ts. Media query uses
      uploadedBy, not mimeType. Reject unsupported input fields.
- [ ] Decode upload base64 only after encoded-length check; enforce canonical
      base64 and decoded 10 MiB/configured limit, create multipart FormData with one
      File, and dispatch internally. Do not implement URL uploads or local reads.
- [ ] Scope discovery by all prerequisite scopes. restore_document and
      restore_version are discoverable if either action scope is available, but
      execution verifies the chosen targetStatus. Expose list_environments only for environments:read plus the credential
      user's current global admin/owner role; recheck both when executing. Extend
      GET /api/v1/environments per SPEC-009 without changing create/delete auth.
- [ ] Test each tool against mounted routes, asserting output envelope and real
      side effects. Cover source/destination grants for clone/promote, dryRun with zero
      mutations, webhook SSRF rejection and secret redaction, media malformed/oversize
      rejection, translation conflict and version restoration collaboration lock.
- [ ] Run `bun test apps/server/src/lib/agent-tools` and affected domain suites.

### Task 1a: Bearer environment-list route and permission checks

Modify `apps/server/src/lib/environments-api.ts`,
`apps/server/src/lib/runtime-with-modules.ts`, `apps/server/src/lib/auth.ts`,
`apps/server/src/lib/environments-api.route.test.ts` and
`apps/server/src/lib/auth.test.ts`. Reuse EnvironmentListResponse from
`packages/shared/src/lib/contracts/environments.ts` without changing its shape.

- [ ] Add environments:read to the operation-scope registry and issuance checks.
      Permit issuance only to global admin/owner. Do not add it to login defaults
      or infer it from clone/promote. Keep separate create/delete session checks.
- [ ] Introduce a list-specific authorizer dependency alongside authorizeAdmin
      and authorizeScoped. It returns the authorized project/user context; it
      validates API-key project membership and optional tuple, or trusted OAuth
      target, then checks the current user's global admin/owner role. Filter the
      list to that project/user visibility before returning the existing envelope.
- [ ] Exercise real mounted routes: admin-owned scoped API key and scoped OAuth
      MCP list succeed; session listing remains unchanged; editor/viewer issuance
      and execution fail; removing the granting user's role invalidates listing;
      missing scope fails; cross-project/tuple routing fails. Assert exact codes
      and unchanged response schema, including definitionsStatus=missing.
- [ ] Test that metadata discovery can list another environment in the same
      project without allowing OAuth content access there. Target override still
      fails. Test create/delete with the same bearer credential still fail and
      clone/promote without their own scopes fail. Verify foreign project rows
      are never included and no operation writes any environment row.
- [ ] Run `bun test apps/server/src/lib/environments-api.route.test.ts`,
      `bun test apps/server/src/lib/auth.test.ts` and the agent-tools environment
      suite. Expected: all new positive and denial cases pass after implementation.

### Task 1b: Repair source/destination authorization for clone/promote

Modify `apps/server/src/lib/environments-api.ts`,
`apps/server/src/lib/environments-clone-promote.ts`,
`apps/server/src/lib/runtime-with-modules.ts` and their route/integration tests.
The existing authorizeScoped call checks request routing but not the separately
supplied source/destination IDs; this task must precede remote tool exposure.

- [ ] Resolve both IDs in the routed project before loading source content. Compare
      the destination ID's environment name to the authenticated routing environment.
      OAuth must match its immutable target; API keys must allow source and target
      tuples. Session/project-only REST calls use resolved destination as target.
- [ ] Pass explicit resolved source/destination authorization context to the
      environment executor. Do not make an unrestricted source-content OAuth call
      or bypass OAuth target enforcement globally to support this operation.
- [ ] Enforce SPEC-009's source-scope matrix: published clone content:read/schema:read;
      draft clone additionally content:read:draft; settings clone source schema:read
      and destination schema:write; promotion content:read:draft/schema:read always.
      includeUnpublished=false only filters never-published documents, not drafts.
- [ ] Check current user source-read and destination write/publish paths, including
      old and new paths of overwritten rows, over the exact transaction inputs.
      Run before mutation and before serializing a dry-run plan. Unauthorized rows
      fail the entire request with FORBIDDEN; no silently filtered partial copy.
- [ ] Add tests: target ID differs from authorized header/token target, source tuple
      absent from key, missing draft scope with published-but-modified source,
      missing schema scope for settings, denied source/destination path, changed
      source rows after preflight, and dryRun denial without leaking rows. Verify
      zero writes/events for every denied case. Positive published-only clone must
      copy published snapshot, not mutable head; promotion must retain its head semantics.
- [ ] Run `bun test apps/server/src/lib/environments-api.route.test.ts` and
      `bun test apps/server/src/lib/environments-clone-promote.integration.test.ts`
      with configured PostgreSQL. Record skipped database coverage explicitly.

### Task 1c: Carry attribution through clone/promote raw persistence

Modify only the relevant interfaces and paths in:

- `apps/server/src/lib/environments-api.ts`: EnvironmentScopedAuthorizer,
  EnvironmentStore.clone/promote, createDatabaseEnvironmentStore adapters and
  mountEnvironmentApiRoutes handlers.
- `apps/server/src/lib/runtime-with-modules.ts`: the authorizeScoped callback
  supplied to mountEnvironmentApiRoutes.
- `apps/server/src/lib/environments-clone-promote.ts`: CloneEnvironmentInput,
  PromoteEnvironmentInput, cloneEnvironment, promoteDocuments, createTargetDraft,
  overwriteTargetDraft and publishTargetDocument.
- `apps/server/src/lib/environments-api.route.test.ts`,
  `apps/server/src/lib/environments-api.test.ts`,
  `apps/server/src/lib/runtime-with-modules.test.ts`,
  `apps/server/src/lib/environments-clone-promote.integration.test.ts` and the
  registry environment-tool tests introduced in Task 1.

Reuse ContentWriteAttribution from `@mdcms/shared` and
attributionFromAuthorizedRequest from
`apps/server/src/lib/content-api/attribution.ts`. The attribution helper's OAuth
branch and trusted internal-channel handling are prerequisites from the OAuth and
shared-dispatch plans; do not duplicate or weaken them here.

- [ ] Change EnvironmentScopedAuthorizer from Promise<void> to return the
      AuthorizedRequest (or Task 1b's resolved authorization context containing it).
      The runtime callback currently discards authorizeRequest's result: return
      it and preserve Task 1b's source/destination authorization checks. Derive
      attribution using the same Request and authorized principal, once those
      checks succeed. Do not infer the actor from source rows or body fields.
- [ ] Add a required final store argument `context: { attribution: ContentWriteAttribution }` to clone/promote, alongside any resolved
      authorization context required by Task 1b. Update both route calls and
      createDatabaseEnvironmentStore implementations. Do not add attribution to
      the public clone/promote payload contracts or supply a default context.
- [ ] Add required attribution to the internal CloneEnvironmentInput and
      PromoteEnvironmentInput engine types. In adapters, spread the validated
      operation input first, then assign the trusted project, destination and
      attribution so client fields cannot override them. Preserve the separately
      authorized source context; attribution must not replace it.
- [ ] Remove the engine's DEFAULT_ACTOR, cloneActor and promoteActor fallbacks.
      Pass the full attribution object through createTargetDraft,
      overwriteTargetDraft and publishTargetDocument instead of actor-only input.
      Clone's direct inserts must receive it too. Genuine internal job/test callers
      explicitly pass systemAttribution or fixture attribution; request paths must
      never invoke systemAttribution to satisfy a required argument.
- [ ] On new target heads, write createdBy/updatedBy=attribution.actorId and
      createdOrigin/updatedOrigin=attribution.origin. On existing target overwrite,
      preserve createdBy/createdOrigin and update only updatedBy/updatedOrigin.
      Set publishedBy/publishedOrigin on cloned version 1 and each new promoted
      version to this operation's attribution, not the source snapshot author.
      Keep source attribution and old target version rows unchanged.
- [ ] Ensure attribution commits within the same clone/promote transaction and
      emitted lifecycle payloads use that same context. Keep dryRun free of all
      content, author/origin and event writes; failed authorization/remap/transaction
      paths must leave attribution unchanged along with the content.
- [ ] Add route/runtime tests for session studio, external API-key api and trusted
      MCP mcp channels, including OAuth's granting user/client ID. Submit body actor,
      origin and channel fields and forged internal headers; prove they cannot
      select persisted attribution. Assert denied source/destination calls never
      reach the mutation engine, even when attribution was derivable.
- [ ] Add PostgreSQL assertions for clone with and without draft inclusion, promoted
      create and overwrite, and settings-only clone. Use source and target actors
      distinct from the acting user. Verify new version authors/origins, preserved
      target creation fields (including null origin), unchanged source rows and old
      history, and no additional content attribution rows for settings-only clone.
- [ ] Snapshot content/version attribution before dryRun and before forced remap
      failure; assert exact equality afterward and zero lifecycle events. Re-run
      Task 1b's wrong-target, source-scope, tuple and path denial cases with these
      persistence assertions. A channel-only mock is not enough to prove storage.
- [ ] Run `bun test apps/server/src/lib/environments-api.route.test.ts`,
      `bun test apps/server/src/lib/environments-api.test.ts`,
      `bun test apps/server/src/lib/runtime-with-modules.test.ts` and
      `bun test apps/server/src/lib/environments-clone-promote.integration.test.ts`
      with PostgreSQL configured; run the registry environment suite after wiring.
      Report unavailable database/OAuth coverage explicitly. Implementation and
      complete test bodies remain pending; this task is an execution outline.

### Task 2: Connected apps Studio surface

Create `packages/studio/src/lib/runtime-ui/lib/oauth-connections-api.ts`,
`packages/studio/src/lib/runtime-ui/app/admin/settings-connected-apps-panel.tsx`
and corresponding tests. Modify settings-page.tsx and settings-page.test.tsx in
that same admin directory.

- [ ] Use the existing settings API transport to GET /api/v1/oauth/connections and
      DELETE /api/v1/oauth/connections/:id with explicit project and CSRF. Consume the
      shared OAuthConnection type. Do not access OAuth token storage from Studio.
- [ ] Render client name as unverified, user, environment, scopes, timestamps,
      empty/loading/error states and a revoke confirmation identifying client/target.
      Disable repeat submission while pending; remove/refetch only after success.
- [ ] Test token-mode sign-in-required state, member/admin lists, failed revoke
      retaining the row, successful revoke refreshing it, and escaped client names.
- [ ] Run `bun test packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`
      plus the new API/panel tests through the repository's existing UI test harness.
- [ ] The checked worktree does not contain apps/studio-review. Verify this again
      before implementation. If restored by another change, update its handlers,
      fixtures and tests together. Otherwise record the consumer as absent, not tested;
      do not fabricate preview coverage or create an unrelated app.

### Task 2a: Isolate the whole-stack integration harness

Spec delta: SPEC-011 requires invocation-owned stacks for health, migration and
content integration. This task is a prerequisite for Task 3 and the full CI gate.
Do not change ordinary developer Compose defaults. This plan is preparation;
container/database execution occurs only during its implementation and verification.

Create:

- `docker-compose.integration.yml`: loopback port and controlled service-environment
  overrides, using `!override` with a minimum Compose version of 2.24.4.
- `scripts/lib/integration-stack.sh`: invocation identity, private configuration,
  scoped Compose wrapper, validation, health/mapping checks and cleanup traps.
- `scripts/lib/allocate-integration-ports.mjs`: OS-assigned distinct loopback ports
  recorded once per invocation, with no static-port fallback.
- `scripts/integration-stack.test.ts`: helper/config/failure-path tests with a
  recording fake Docker executable and synthetic environment values.

Modify:

- `scripts/compose-health-check.sh`
- `scripts/migration-startup-check.sh`
- `scripts/content-api-integration-check.sh`
- `apps/server/src/lib/content-api-test-support.ts`: explicit integration opt-in
  and mandatory generated test database URL; unit discovery does not connect to
  the current fallback on port 5432.
- `apps/server/package.json`, root `package.json` and `.github/workflows/ci.yml`
  only where required to pass the explicit mode and preserve existing gate order.

- [ ] Implement the helper with a random project prefix/nonce, collision check,
      private temporary directory, generated env file and one Compose argv array
      containing explicit -p and both -f paths. Sanitize subprocess environment:
      allow needed Docker/process configuration, but discard ambient Compose
      selection, app credentials and service URLs. Use task-specific variable
      names, not HOME or other system variables. Keep raw secrets out of logs.
- [ ] Allocate all seven loopback host ports once, retain the map across down/up
      restart checks, and fail on any bind conflict. Use !override for each ports
      list and controlled service environment maps. Keep container ports fixed;
      synthetic database credentials and URLs must agree across postgres,
      db-migrate, server, healthchecks and SQL verification commands. Override
      inherited AI/provider secrets, S3 endpoints and SMTP configuration.
- [ ] Generate canonical server and public media URLs from the same saved ports.
      Use internal service DNS/ports for container dependencies. Set NODE_ENV=test,
      internal PORT=4000, a test-marked database name and synthetic bucket/credentials.
      Validate the merged Compose config before resource creation: no old default
      host mappings, wildcard bindings, external volumes/networks or unrelated mounts.
- [ ] Replace every bare Compose invocation in all three scripts with the wrapper,
      including ps, port, exec, logs, run, up, restart and cleanup. Remove initial
      cleanup/reset calls. Replace fixed host curl URLs and host-port assertions
      with the recorded mappings; fixed container-port assertions remain valid.
- [ ] Verify project/service labels, actual mapped addresses and expected server
      configuration before host health checks. Require healthy for healthchecked
      services and exit zero for migration/init jobs. Test missing containers,
      duplicate IDs, mismatched labels/mappings, unhealthy/exited states and
      init failures; none may fall through to a responsive existing listener.
- [ ] Keep persistence sentinels and migration-idempotency checks in owned volumes.
      Recreate using identical project/configuration and host ports, without volume
      deletion. Recheck mappings and sentinels; do not silently reallocate a port
      after restart or inspect another project's volume.
- [ ] Supply generated MDCMS_TEST_DATABASE_URL explicitly to content tests and
      enable an explicit integration mode. Validate test marker and verified
      loopback mapping, probe availability, and fail rather than test.skip when
      explicitly requested database coverage is unavailable. Remove automatic
      development-database fallback during ordinary unit discovery. Do not alter
      the separate OAuth-only explicit-database contract.
- [ ] Trap exit/signals after recording ownership, before startup. Cleanup must
      use the same scoped argv and delete only invocation-owned resources. Test
      startup failure, partial startup, assertion failure, interrupt, repeated
      cleanup, ownership mismatch and cleanup failure. Preserve failing test exit
      codes and report cleanup errors; successful tests plus failed cleanup fail.
- [ ] Before Docker execution, run `bash -n` on the helper and three scripts and
      `bun test scripts/integration-stack.test.ts`. Source-review all destructive
      calls and endpoints with `rg -n 'docker compose|down|prune|4000|5432|DATABASE_URL|curl'`
      over those files. Inspect fake-Docker traces to prove every command has the
      unique project/files and no ambient service URL or default-project cleanup.
      Test poisoned inherited env values and an occupied allocated port as failures.
- [ ] After implementing the isolation contract, inspect rendered config with
      synthetic values, then run `bun run compose:health`, `bun run migrate:check`
      and `bun run integration:content`. Verify actual ownership, mapped URLs,
      restart persistence and cleanup. Compare unrelated stack resource identities
      before/after read-only; do not stop, recreate or clean that stack for the test.
- [ ] Run actual `bun run ci:required` after all relevant changes. Give any Studio
      embed smoke process its own free loopback port through the documented
      MDCMS_STUDIO_EMBED_SMOKE_PORT setting, and verify that process owns its
      listener. Record exit status and which stages ran, with database cases
      executed rather than skipped. A source review or focused green test does
      not replace this full run; report unavailable stages as remaining gates.

### Task 3: Integration protocol proof

Create `apps/server/src/lib/mcp/mcp.integration.test.ts`; modify the existing
`scripts/content-api-integration-check.sh` and `.github/workflows/ci.yml` only as required to execute it.

- [ ] Use a fresh fixture project, scoped user and API key. Through a real SDK
      client initialize/list/get_schema/create/update/read/publish and verify resulting
      content and actor/channel. Test a denied path and stale hash with zero writes.
- [ ] Exercise OAuth with fixture consent and S256: redeem once, refresh, revoke,
      verify both access and refresh fail afterward. Test wrong resource and target.
      Keep fixture credentials ephemeral and omit them from logs/artifacts.
- [ ] After Task 2a, run the integration command against its owned database/services;
      CI must fail if MCP cases fail, not merely emit their output.
- [ ] Run `bun run format:check`, `bun run check`, focused unit suites and
      `bun run ci:required` before parent push. Record unavailable dependencies as gaps.

### Task 4: User documentation and public skills

Create `apps/docs/guide/mcp.mdx`; modify `apps/docs/docs.json` navigation,
`apps/docs/guide/studio/settings.mdx`, CLI README and applicable files under root
`skills/` (public skills, never the internal .ai/skills copy).

- [ ] Document local npx/stdin setup, config/credential resolution, Node baseline,
      remote OAuth URL and consent, target immutability, connection revocation, explicit
      schemaHash writes, draft/publish scope separation and local pull after changes.
- [ ] Document environments:read issuance, current admin/owner checks, project-only
      metadata discovery, immutable OAuth targets, bounded media upload,
      reported client identity and errors with recovery instructions. Never imply a
      stateless initialize name will automatically appear on later writes.
- [ ] Use illustrative domains and fixture credentials only. Check links and tool
      names against registry discovery. Update public skill examples to use new names
      and explicit schemaHash; do not keep CLI-only preview tool descriptions.
- [ ] Conduct real-agent connection checks where configured. Record client/version,
      transport and read/write/denial result separately from SDK tests. If credentials
      or clients are unavailable, report that coverage gap instead of claiming success.
- [ ] Generate any required package changesets through `bun run changeset` and hand
      parent the diff plus check results. Publication remains a separate action.
