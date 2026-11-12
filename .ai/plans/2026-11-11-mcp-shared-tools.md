# Shared Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implemented and validated by the combined CI gate. External agent-host acceptance is unavailable because no client connection is configured.

**Goal:** Use one authorized route implementation for MCP and Assistant operations.

**Architecture:** The server owns the registry and a private in-process dispatcher. Shared owns pure validation and dependency contracts; core.ai receives host-injected interfaces.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia, Drizzle/PostgreSQL, MCP TypeScript SDK, React.

---

Run commands from the repository root. Preserve unrelated working changes.
This plan does not authorize commit, push, publish, deployment or external messages.
Run focused tests after each task; parent integration owns commits and the full gate.

## Spec delta

SPEC-015 defines dispatch trust, tool contracts and results. SPEC-014 requires
injected registry reads and route-backed apply/undo with complete revalidation.
Acceptance depends on per-user grants, schema/revision gates, collaboration guards
and events remaining identical to external requests. SPEC-003 adds atomic
expectedDraftRevision preconditions to delete/restore and makes published restore
semantics explicit. Task 3a must land before Task 4's undo dispatch is considered
safe; the existing route/store implementation does not yet provide these guarantees.

### Task 1: Extract pure frontmatter validation

Files: move pure validation from `apps/cli/src/lib/validate.ts` to
`packages/shared/src/lib/frontmatter-validation.ts`; export from
`packages/shared/src/index.ts`. Keep CLI candidate/file orchestration in place.
Tests: `packages/shared/src/lib/frontmatter-validation.test.ts`, existing
`apps/cli/src/lib/validate.test.ts`.

- [x] Preserve this exact public signature and errors/warnings semantics:

```ts
export type ValidationResult = { errors: string[]; warnings: string[] };
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  typeSnapshot: SchemaRegistryTypeSnapshot,
): ValidationResult;
```

- [x] Copy existing field-validation cases before moving implementation. Add
      parity coverage for nested objects, nullable fields, required defaults,
      references, arrays and unknown-field warnings. Keep fixture snapshots from the
      existing CLI tests; no schema behavior change belongs in this extraction.
- [x] Run `bun test apps/cli/src/lib/validate.test.ts` before and after extraction.
      Run `bun test packages/shared/src/lib/frontmatter-validation.test.ts`; both pass.
- [x] Replace CLI import with the shared export; remove duplicate field validators.

### Task 2: Private dispatcher and external-ingress boundary

Create `apps/server/src/lib/agent-tools/dispatcher.ts` and
`apps/server/src/lib/agent-tools/dispatcher.test.ts`. Modify
`apps/server/src/lib/server.ts`, `apps/server/src/lib/runtime-with-modules.ts` and
`apps/server/src/lib/auth.ts`. Reuse ServerRequestHandler and the existing
AuthorizedRequest, AuthorizationRequirement and createServerRequestHandler APIs.

- [x] Define the new interface explicitly:

```ts
export type AgentDispatch = (input: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  schemaHash?: string;
}) => Promise<Response>;
export type AgentRequestContext = {
  request: Request;
  project: string;
  environment: string;
  channel: "mcp" | "studio_ai";
  declared?: string;
};
```

- [x] Implement `createInternalDispatcher(handler, secret, context)` returning
      AgentDispatch. Restrict paths to registered domain families, forbid absolute
      URLs/query target overrides, forward only Authorization or cookie/CSRF, inject
      target and trusted channel, and serialize body as JSON. Upload uses a separate
      FormData branch added with media tools. Never invoke fetch for dispatch.
- [x] Generate the secret once per runtime. Keep external wrapper and internal
      handler distinct. Strip all internal headers in the external wrapper, then pass
      the sanitized Request to the normal handler. Internal dispatcher calls the
      handler directly. Validate secret before trusting channel or allowing OAuth on
      a domain route. Do not export the secret through module deps or responses.
- [x] Add tests that assert external forged mcp/studio_ai headers cannot affect
      attribution; ordinary sessions still require CSRF; path-denied content stays
      denied internally; forwarded credentials are identical to the caller's.
- [x] Run `bun test apps/server/src/lib/agent-tools/dispatcher.test.ts` and existing
      `bun test apps/server/src/lib/auth-actor.test.ts`. Expected pass, including
      negative cases with zero writes/events.

### Task 3: Registry core, content, schema and validation

Create `apps/server/src/lib/agent-tools/{types,registry,content,schema}.ts` and
`apps/server/src/lib/agent-tools/registry.test.ts`. Reuse route contracts under
`packages/shared/src/lib/contracts/`, route response shaping under
`apps/server/src/lib/content-api/`, and the current CLI mcp input behavior as a
migration reference, not a second executor.

- [x] Define AgentTool with name/title/description, Zod input/output schemas,
      annotations, required scopes and execute(input, context). Context contains an
      AgentDispatch, immutable target and authorized principal. Reject duplicate
      registrations. Scope filtering returns a deterministic name-sorted list.
- [x] Implement list_documents/get_document/get_schema by dispatching GET requests
      in SPEC-015. Implement create/update/publish using the same routes. Pass explicit
      schemaHash; update reads draftRevision, merges frontmatter and sends that exact
      revision. Do not swallow domain errors or retry stale writes.
- [x] Reuse validateFrontmatter and the parser in
      `packages/modules/core.ai/src/server/validate-proposal.ts` through a pure shared
      extraction if needed. Keep catalog validation dependent on a supplied catalog.
- [x] Test the registry against mounted content routes with scoped principals.
      Assert resulting document/version and event, not only dispatcher invocation.
      Required failures: removed grant, denied path move, wrong hash, changed draft,
      invalid frontmatter/MDX, active collaboration room. Assert no write on failure.
- [x] Run `bun test apps/server/src/lib/agent-tools/registry.test.ts` and
      `bun test apps/server/src/lib/content-api.test.ts`.

### Task 3a: Repair delete/restore store transitions before Assistant migration

Modify `apps/server/src/lib/content-api/{types,parsing,routes,database-store,in-memory-store}.ts`,
`apps/server/src/lib/content-api.test.ts`,
`apps/server/src/lib/content-api/database-store.test.ts` and
`apps/server/src/lib/content-api.integration.test.ts`. Coordinate with attribution
changes: extend their operation options, preserve actor/origin and never replace
those edits with an older signature.

- [x] Add optional expectedDraftRevision to delete/restore operation options and
      restore targetStatus (default draft). Parse DELETE query precondition and
      restore JSON precondition/status. Reject invalid preconditions with INVALID_INPUT.
      Select content:write for draft restore, content:publish for published restore.
- [x] Implement the precondition under the same transaction/row lock as mutation.
      Include project/environment/document/revision in the guarded update. Increment
      revision once per transition; check preconditions before any no-op shortcut.
      If no row updates, distinguish missing row from stale revision and return
      STALE_DRAFT_REVISION with expected/current values. In-memory store must agree.
- [x] Repair restore, which currently ignores targetStatus and restores directly.
      Draft restore clears publishedVersion and marks unpublished changes without
      adding history. Published restore appends a new immutable version, assigns
      publishedVersion, clears unpublished changes and updates published search in
      the transaction. Preserve path uniqueness and collaboration guards.
- [x] Emit restored once after success; published restore also emits published once.
      Record current actor/origin on head and new version. Rollback and stale paths
      emit neither event. Do not implement published restore as two independent
      restore/publish requests with an intervening race.
- [x] Add tests with content:publish-only credential proving actual published state,
      new version, search result and event; the same credential cannot draft-restore.
      Test default draft restore and invalid targetStatus explicitly.
- [x] Add a deterministic race test: read undo revision R, commit another edit or
      state transition to R+1, then attempt delete/restore with R. Assert 409, the
      competing state unchanged, no version append and zero events. Also run two
      concurrent transitions with the same R against PostgreSQL: at most one wins.
- [x] Run `bun test apps/server/src/lib/content-api.test.ts`, store tests and
      PostgreSQL integration cases directly with `MDCMS_TEST_DATABASE_URL` set to
      the dedicated verification database. In-memory tests alone do not establish
      atomic database behavior.
- [x] Run `scripts/content-api-integration-check.sh` in an isolated Compose
      environment during integration verification. This wrapper unconditionally
      removes Compose volumes before and after execution, so it was not run
      against the existing development stack.

### Task 4: Assistant dependency migration and apply/undo

Modify `packages/modules/core.ai/src/server/{index,routes,chat-tools,apply}.ts`,
`apps/server/src/lib/runtime-with-modules.ts`, and
`packages/modules/core.ai/src/server/{chat-tools,apply,routes}.test.ts`.

- [x] Replace MountAiRoutesOptions listEntries/getEntry callbacks with injected
      adapted list_documents/get_document/get_schema tools bound to the current
      request. Preserve proposal tools and component-reference tooling. Update prompt
      vocabulary and CHAT_TOOL_PROMPT_TEMPLATE_ID. Do not add server imports.
- [x] Replace mutation implementations behind AiApplyContentStore in the host
      with request-bound dispatcher adapters, or rename the interface to reflect
      route execution in the same change. Preserve the existing applyAiProposal and
      applyAiProposalUndo input/result contracts for Studio consumers.
- [x] At apply, resolve server-trusted proposal, check ownership/target/expiry and
      status, authorize again, load live content/schema, validate resulting
      frontmatter/MDX and check expected revision. Preserve the unique originalText
      replacement exception. Browser validation flags must not skip these checks.
- [x] At undo, enforce the existing window and require the server-trusted
      postApplyDraftRevision. Dispatch create undo as DELETE query
      expectedDraftRevision, delete undo as restore JSON expectedDraftRevision plus
      targetStatus=draft, and edit undo as PUT draftRevision. Task 3a's transactional
      check is mandatory; an earlier read cannot enforce this guarantee.
      Map STALE_DRAFT_REVISION to AI_PROPOSAL_CONFLICT without successful undo audit.
      Preserve the published-document delete restriction and collaboration behavior.
- [x] Add browser-returned expired/invalid proposal tests, changed-grant tests,
      stale undo tests and successful lifecycle-event attribution assertions. Run
      `bun test packages/modules/core.ai/src/server` and
      `bun test apps/server/src/lib/runtime-with-modules.test.ts`.

## Completion evidence

- [x] Bound trusted proposal retention and capacity, retain minimal undo data,
      prune consumed/expired payloads, and dispose the unreferenced cleanup timer
      on runtime shutdown. Verify fake-clock expiry, capacity and reservations.

- [x] No registry or Assistant mutation path reaches content store directly.
- [x] Module boundary typechecks without server imports.
- [x] Generate shared/modules changesets via `bun run changeset` when required.
- [x] Record actual tests and remaining integration gaps for integration review.

## Publication race safety

- [x] Derive internal requireUnpublished only from verified studio_ai authorization.
- [x] Check it under delete's row lock after revision validation; map DOCUMENT_PUBLISHED to AI_PROPOSAL_CONFLICT for Assistant callers.
- [x] Re-read the active head under publish's transaction lock so publication cannot act on a pre-delete snapshot.
- [x] Verify publish-before-delete and delete-before-publish orderings in PostgreSQL and the in-memory store. Preserve publication revision semantics.

## Verification evidence

- Focused shared-tools suite: 421 tests passed across 24 files, including database
  transitions, content integration, registry/dispatcher, host runtime, core.ai,
  CLI validation and shared validation. PostgreSQL used only the dedicated
  verification database selected through `MDCMS_TEST_DATABASE_URL`.
- `bun run check --parallel=1 --skip-nx-cache`: all eight projects built and
  typechecked successfully.
- `bun run format:check` and `git diff --check`: passed.
- Restore results carry an internal committed-transition discriminator. Live
  no-ops and concurrent followers emit no restore/publish events or cache writes.
- Rejection ignores optional browser bodies and enforces trusted identity,
  ownership, target, status and `content:write`. Domain service failures preserve
  known public codes/statuses; unexpected failures expose generic internal errors.
- The shared changeset was generated through the Changesets CLI. Modules are
  private. The combined CI gate includes isolated Compose startup/migration checks and
  PostgreSQL assertions. Mounted Studio interaction tests use intercepted API responses.

## Combined validation

- `bun run ci:required` passed with Bun 1.3.11, `NX_PARALLEL=1` and
  `NX_SKIP_NX_CACHE=true`, including Studio embedding and isolated Compose
  health, restart persistence, migration and content/MCP/OAuth integration.
- Unit discovery passed 2,280 package tests and 20 harness tests. Database-only
  cases are opt-in; mandatory integration passed 349 database tests, the real
  HTTP MCP lifecycle and 23 OAuth/protocol checks. The external MCP case is
  skipped in the OAuth-only command because it runs in the full-stack command.
- Chromium exercised OAuth Allow/Deny callbacks and JavaScript-disabled login.
  Four mounted Connected apps browser tests covered revoke failure/success,
  pending protection and identity/target changes using intercepted API responses.
- Packed CLI smoke passed on Node 24.11.1 and 26.13.1. Published-package
  changesets were generated through the Changesets CLI; no package was published.
- `apps/studio-review` is absent. No external agent host is configured, so
  ChatGPT, Claude and Cursor acceptance remains untested.
