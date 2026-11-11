# Shared Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implementation outline with interface sketches and verification cases. Production code and complete test bodies are not supplied; unchecked steps are pending implementation and validation.

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

- [ ] Preserve this exact public signature and errors/warnings semantics:

```ts
export type ValidationResult = { errors: string[]; warnings: string[] };
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  typeSnapshot: SchemaRegistryTypeSnapshot,
): ValidationResult;
```

- [ ] Copy existing field-validation cases before moving implementation. Add
      parity coverage for nested objects, nullable fields, required defaults,
      references, arrays and unknown-field warnings. Keep fixture snapshots from the
      existing CLI tests; no schema behavior change belongs in this extraction.
- [ ] Run `bun test apps/cli/src/lib/validate.test.ts` before and after extraction.
      Run `bun test packages/shared/src/lib/frontmatter-validation.test.ts`; both pass.
- [ ] Replace CLI import with the shared export; remove duplicate field validators.

### Task 2: Private dispatcher and external-ingress boundary

Create `apps/server/src/lib/agent-tools/dispatcher.ts` and
`apps/server/src/lib/agent-tools/dispatcher.test.ts`. Modify
`apps/server/src/lib/server.ts`, `apps/server/src/lib/runtime-with-modules.ts` and
`apps/server/src/lib/auth.ts`. Reuse ServerRequestHandler and the existing
AuthorizedRequest, AuthorizationRequirement and createServerRequestHandler APIs.

- [ ] Define the new interface explicitly:

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

- [ ] Implement `createInternalDispatcher(handler, secret, context)` returning
      AgentDispatch. Restrict paths to registered domain families, forbid absolute
      URLs/query target overrides, forward only Authorization or cookie/CSRF, inject
      target and trusted channel, and serialize body as JSON. Upload uses a separate
      FormData branch added with media tools. Never invoke fetch for dispatch.
- [ ] Generate the secret once per runtime. Keep external wrapper and internal
      handler distinct. Strip all internal headers in the external wrapper, then pass
      the sanitized Request to the normal handler. Internal dispatcher calls the
      handler directly. Validate secret before trusting channel or allowing OAuth on
      a domain route. Do not export the secret through module deps or responses.
- [ ] Add tests that assert external forged mcp/studio_ai headers cannot affect
      attribution; ordinary sessions still require CSRF; path-denied content stays
      denied internally; forwarded credentials are identical to the caller's.
- [ ] Run `bun test apps/server/src/lib/agent-tools/dispatcher.test.ts` and existing
      `bun test apps/server/src/lib/auth-actor.test.ts`. Expected pass, including
      negative cases with zero writes/events.

### Task 3: Registry core, content, schema and validation

Create `apps/server/src/lib/agent-tools/{types,registry,content,schema}.ts` and
`apps/server/src/lib/agent-tools/registry.test.ts`. Reuse route contracts under
`packages/shared/src/lib/contracts/`, route response shaping under
`apps/server/src/lib/content-api/`, and the current CLI mcp input behavior as a
migration reference, not a second executor.

- [ ] Define AgentTool with name/title/description, Zod input/output schemas,
      annotations, required scopes and execute(input, context). Context contains an
      AgentDispatch, immutable target and authorized principal. Reject duplicate
      registrations. Scope filtering returns a deterministic name-sorted list.
- [ ] Implement list_documents/get_document/get_schema by dispatching GET requests
      in SPEC-015. Implement create/update/publish using the same routes. Pass explicit
      schemaHash; update reads draftRevision, merges frontmatter and sends that exact
      revision. Do not swallow domain errors or retry stale writes.
- [ ] Reuse validateFrontmatter and the parser in
      `packages/modules/core.ai/src/server/validate-proposal.ts` through a pure shared
      extraction if needed. Keep catalog validation dependent on a supplied catalog.
- [ ] Test the registry against mounted content routes with scoped principals.
      Assert resulting document/version and event, not only dispatcher invocation.
      Required failures: removed grant, denied path move, wrong hash, changed draft,
      invalid frontmatter/MDX, active collaboration room. Assert no write on failure.
- [ ] Run `bun test apps/server/src/lib/agent-tools/registry.test.ts` and
      `bun test apps/server/src/lib/content-api.test.ts`.

### Task 3a: Repair delete/restore store transitions before Assistant migration

Modify `apps/server/src/lib/content-api/{types,parsing,routes,database-store,in-memory-store}.ts`,
`apps/server/src/lib/content-api.test.ts`,
`apps/server/src/lib/content-api/database-store.test.ts` and
`apps/server/src/lib/content-api.integration.test.ts`. Coordinate with attribution
changes: extend their operation options, preserve actor/origin and never replace
those edits with an older signature.

- [ ] Add optional expectedDraftRevision to delete/restore operation options and
      restore targetStatus (default draft). Parse DELETE query precondition and
      restore JSON precondition/status. Reject invalid preconditions with INVALID_INPUT.
      Select content:write for draft restore, content:publish for published restore.
- [ ] Implement the precondition under the same transaction/row lock as mutation.
      Include project/environment/document/revision in the guarded update. Increment
      revision once per transition; check preconditions before any no-op shortcut.
      If no row updates, distinguish missing row from stale revision and return
      STALE_DRAFT_REVISION with expected/current values. In-memory store must agree.
- [ ] Repair restore, which currently ignores targetStatus and restores directly.
      Draft restore clears publishedVersion and marks unpublished changes without
      adding history. Published restore appends a new immutable version, assigns
      publishedVersion, clears unpublished changes and updates published search in
      the transaction. Preserve path uniqueness and collaboration guards.
- [ ] Emit restored once after success; published restore also emits published once.
      Record current actor/origin on head and new version. Rollback and stale paths
      emit neither event. Do not implement published restore as two independent
      restore/publish requests with an intervening race.
- [ ] Add tests with content:publish-only credential proving actual published state,
      new version, search result and event; the same credential cannot draft-restore.
      Test default draft restore and invalid targetStatus explicitly.
- [ ] Add a deterministic race test: read undo revision R, commit another edit or
      state transition to R+1, then attempt delete/restore with R. Assert 409, the
      competing state unchanged, no version append and zero events. Also run two
      concurrent transitions with the same R against PostgreSQL: at most one wins.
- [ ] Run `bun test apps/server/src/lib/content-api.test.ts` and the store tests;
      run the PostgreSQL integration case through `scripts/content-api-integration-check.sh`.
      In-memory tests alone do not establish atomic database behavior.

### Task 4: Assistant dependency migration and apply/undo

Modify `packages/modules/core.ai/src/server/{index,routes,chat-tools,apply}.ts`,
`apps/server/src/lib/runtime-with-modules.ts`, and
`packages/modules/core.ai/src/server/{chat-tools,apply,routes}.test.ts`.

- [ ] Replace MountAiRoutesOptions listEntries/getEntry callbacks with injected
      adapted list_documents/get_document/get_schema tools bound to the current
      request. Preserve proposal tools and component-reference tooling. Update prompt
      vocabulary and CHAT_TOOL_PROMPT_TEMPLATE_ID. Do not add server imports.
- [ ] Replace mutation implementations behind AiApplyContentStore in the host
      with request-bound dispatcher adapters, or rename the interface to reflect
      route execution in the same change. Preserve the existing applyAiProposal and
      applyAiProposalUndo input/result contracts for Studio consumers.
- [ ] At apply, resolve server-trusted proposal, check ownership/target/expiry and
      status, authorize again, load live content/schema, validate resulting
      frontmatter/MDX and check expected revision. Preserve the unique originalText
      replacement exception. Browser validation flags must not skip these checks.
- [ ] At undo, enforce the existing window and require the server-trusted
      postApplyDraftRevision. Dispatch create undo as DELETE query
      expectedDraftRevision, delete undo as restore JSON expectedDraftRevision plus
      targetStatus=draft, and edit undo as PUT draftRevision. Task 3a's transactional
      check is mandatory; an earlier read cannot enforce this guarantee.
      Map STALE_DRAFT_REVISION to AI_PROPOSAL_CONFLICT without successful undo audit.
      Preserve the published-document delete restriction and collaboration behavior.
- [ ] Add browser-returned expired/invalid proposal tests, changed-grant tests,
      stale undo tests and successful lifecycle-event attribution assertions. Run
      `bun test packages/modules/core.ai/src/server` and
      `bun test apps/server/src/lib/runtime-with-modules.test.ts`.

## Completion evidence

- [ ] No registry or Assistant mutation path reaches content store directly.
- [ ] Module boundary typechecks without server imports.
- [ ] Generate shared/modules changesets via `bun run changeset` when required.
- [ ] Record actual tests and remaining integration gaps for the parent.
