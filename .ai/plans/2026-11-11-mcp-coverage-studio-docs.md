# MCP Coverage, Studio and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implementation outline with interface sketches and verification cases. Production code and complete test bodies are not supplied; unchecked steps are pending implementation and validation.

**Goal:** Complete the agreed domain tool inventory and verify the end-to-end user workflow.

**Architecture:** All tool handlers remain thin adapters to existing routes. Studio uses session-only connection management; CI exercises actual MCP transport.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia, Drizzle/PostgreSQL, MCP TypeScript SDK, React.

---

Run commands from the repository root. Preserve unrelated working changes.
This plan does not authorize commit, push, publish, deployment or external messages.
Run focused tests after each task; parent integration owns commits and the full gate.

## Spec delta

SPEC-005/009 extend environment listing to narrowly scoped bearer credentials.
The existing role requirement remains; creation/deletion remain session-only.

SPEC-015 enumerates tools, schemas and domain errors. SPEC-006 adds Connected apps
using SPEC-005 contracts. Acceptance requires coverage without weaker route auth,
Studio failure states, public setup guidance and integration evidence.
Dependencies: shared tools, OAuth/MCP and CLI bridge plans. Shared-tools Task 3a
repairs atomic restore/delete and published restore before those tools/undo ship.
Task 1b below repairs existing clone/promote authorization before registering those
remote tools. Thin dispatch alone cannot satisfy either dependency.

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

### Task 3: Integration protocol proof

Create `apps/server/src/lib/mcp/mcp.integration.test.ts`; modify the existing
`scripts/content-api-integration-check.sh` and `.github/workflows/ci.yml` only as required to execute it.

- [ ] Use a fresh fixture project, scoped user and API key. Through a real SDK
      client initialize/list/get_schema/create/update/read/publish and verify resulting
      content and actor/channel. Test a denied path and stale hash with zero writes.
- [ ] Exercise OAuth with fixture consent and S256: redeem once, refresh, revoke,
      verify both access and refresh fail afterward. Test wrong resource and target.
      Keep fixture credentials ephemeral and omit them from logs/artifacts.
- [ ] Run the integration command locally against the required database/services;
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
