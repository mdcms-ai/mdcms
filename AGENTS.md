# MDCMS

## Vision

MDCMS is a Markdown-first headless CMS where the database holds the content but developers work with local files. You pull content down, edit with whatever tools you like, and push it back. The editing experience feels like a filesystem, without the problems that come with actually storing content in one.

Three interfaces share the same data layer: a CLI for developers, an embeddable Studio for editors, and a REST API that AI agents and applications consume directly. The goal is that nobody blocks anyone else. An editor publishing a page and an agent rewriting 500 posts at once go through the same validation, the same permissions, and the same version history.

## Direction

The module system is how MDCMS gets extended. Server actions, CLI commands, and Studio UI surfaces all hook in through the same module contract. Community contributions should follow this pattern rather than patching core code.

Upcoming work is focused on live preview (real-time content rendering in the consumer frontend), MCP integration (Model Context Protocol for agent-driven content operations; a preview stdio server ships in the CLI as `mdcms mcp`), multiple spaces (team-scoped content organization), and real-time collaboration (multi-user editing via CRDTs).

## Repository layout

| Path                  | What it is                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/server`         | Elysia HTTP server, the backend for everything                                                  |
| `apps/cli`            | CLI binary (`mdcms`) for push/pull/sync workflows                                               |
| `apps/studio-example` | Next.js app that embeds the Studio component                                                    |
| `apps/studio-review`  | Internal contract-consumer for preview mocks; kept in sync with contracts                       |
| `packages/shared`     | Contracts, types, and schema utilities used everywhere                                          |
| `packages/sdk`        | Client SDK for reading content from applications                                                |
| `packages/studio`     | The embeddable React Studio component                                                           |
| `packages/modules`    | First-party module registry                                                                     |
| `skills/`             | Public MDCMS skills pack (`skills.sh`-distributable) for users adopting MDCMS in their projects |

Bun workspaces, Nx for task orchestration. Run `bun install` at the root.

## Tech Stack

- **Runtime**: Bun (with `bun test` as the test runner)
- **Build orchestration**: Nx 22.5 with `@nx/js/typescript` plugin
- **TypeScript**: 5.9, strict mode, `nodenext` module resolution, `composite` projects
- **Backend**: Elysia, Drizzle ORM + `postgres.js`, PostgreSQL 16
- **Validation**: Zod 4
- **Infrastructure**: Docker Compose (postgres, redis, minio, mailhog)
- **Custom import condition**: `@mdcms/source` for dev-time source imports

## Canonical planning docs

- Docs entrypoint: `docs/README.md`
- Live canonical specs: `docs/specs/README.md`
- Architecture decisions and rationale: `docs/adrs/README.md`

Read these before proposing changes to the areas they cover. The owning spec under `docs/specs/` and the linked issue are the source of truth for scope and acceptance criteria.

## Architecture patterns

**Package boundary rules**: Shared contracts/types go in `@mdcms/shared`. Each app owns its runtime concerns. Avoid circular dependencies between packages.

**Module system**: First-party modules live in `packages/modules/<module-id>/` with a standard structure (`manifest.ts`, `server/index.ts`, `cli/index.ts`). The `installedModules` registry in `packages/modules/src/index.ts` is deterministic and sorted by `manifest.id`. Server and CLI each have their own `module-loader.ts` that mounts module surfaces at startup.

**Exports pattern**: Every package uses conditional exports with `@mdcms/source` pointing to TypeScript source for dev, and `import`/`default` pointing to `dist/` for production.

**Contract tests**: Files named `*.contract.test.ts` validate Drizzle schema against actual SQL migrations. Regular unit tests are `*.test.ts` co-located with source.

**Studio review app sync**: Treat `apps/studio-review` as a maintained repo-internal consumer of Studio and backend contracts. When a change updates any contract that the review app consumes, update the owning spec plus the review app handlers, fixtures, runtime wiring, and tests in the same change so preview mocks stay aligned.

## Commands

All commands run from workspace root.

```bash
bun install                          # Install dependencies
bun run build                        # Build all packages (Nx)
bun run typecheck                    # Typecheck all packages (Nx)
bun run check                        # Build + typecheck combined
bun run format                       # Prettier format all
bun run format:check                 # Prettier check (CI gate)
bun run unit                         # Run all unit tests (bun test via Nx)
bun run integration                  # Docker health + migration check
bun run ci:required                  # Full CI gate: quality + unit + integration
```

Run a single package's tests:

```bash
bun test --cwd apps/server ./src                    # All server tests
bun test --cwd apps/server ./src/lib/health.test.ts # Single test file
bun test --cwd packages/shared ./src                # All shared tests
```

Database operations:

```bash
bun run --cwd apps/server db:generate  # Generate migrations from schema changes
bun run --cwd apps/server db:migrate   # Apply migrations
```

Dev server:

```bash
docker compose up -d --build           # Start infrastructure (postgres, redis, minio, mailhog)
bun --cwd apps/server run start        # Start dev server on port 4000
```

## Working in this repo

- Branch from `main`: `feat/`, `fix/`, `chore/`, `refactor/` prefixes
- Conventional commits: `type(scope): message`
- Run `bun run ci:required` locally before pushing — CI will run the same gate on the PR.
- Full documentation at [docs.mdcms.ai](https://docs.mdcms.ai)

## AI agent infrastructure

The `.ai/` directory at the repo root holds the team's shared AI-agent-facing artifacts. It's a team operating environment, not session state — read it for product knowledge and accumulated learnings, not for "what is someone working on right now" (that's the issue tracker).

```text
.ai/
├── LANGUAGE.md              # Project vocabulary — use these names, don't coin new ones
├── plans/                   # Implementation plans (committed; populated as new work happens)
├── research/                # Research artifacts (date-prefixed)
├── memory/                  # Team product memory (see .ai/memory/README.md)
│   ├── product.md           # Vision, audience, scope
│   ├── architecture.md      # System patterns, invariants, hard rules
│   ├── stack.md             # Runtime, deps, infrastructure
│   ├── lessons.md           # Append-only dev-time pitfalls
│   ├── topics/              # Cross-cutting domain knowledge (auth, sync, multi-tenancy, …)
│   ├── integrations/        # External systems (Docker, CI)
│   └── initiatives/         # One file per major team effort
└── skills/                  # Vendored superpowers + project-local skills
```

**Rules for agents working in this repo:**

1. **Use `.ai/LANGUAGE.md` for naming.** Don't invent synonyms for existing terms.
2. **Read the relevant `.ai/memory/` file before non-trivial work** — `architecture.md` for invariants, `product.md` for product context, `initiatives/` for whether your work fits an active effort. Volatile state ("what's happening right now") lives in the issue tracker, not here.
3. **Append to `.ai/memory/lessons.md` when you hit a non-obvious pitfall.** One short entry; lead with the rule, then `Why:` and `How to apply:` lines.
4. **Plans live in `.ai/plans/`.** Use the superpowers `writing-plans` and `executing-plans` skills to write and run them. Plans are committed.
5. **Research goes in `.ai/research/`.** Date-prefixed filename (`YYYY-MM-DD-topic.md`).
6. **Major efforts get an initiative file** in `.ai/memory/initiatives/` (see that folder's README for the format). Update it on milestones; mark `Status: completed` when wrapping.
7. **Skills are auto-discovered** by Claude Code, Codex, and Cursor via symlinks (`.claude/skills`, `.agents/skills`, `.cursor/skills` all point to `../.ai/skills`). These are POSIX-style symlinks; on Windows they may not check out correctly without developer mode or `core.symlinks=true`. If skill discovery fails on a Windows clone, replace each symlink with a directory junction or a recursive copy of `.ai/skills/` as a fallback.
8. **Published package changes require a changeset.** If your change touches `src/**` or `package.json` in a published package, create the changeset with `bun run changeset` before opening or updating the PR. Never create or edit `.changeset/*.md` files manually; always go through the Changesets CLI. Some packages mix npm-published code with backend-served runtime code (see `@mdcms/studio` and CMS-219); those declare runtime-only `src/` paths in a sibling `.changeset-gate.json` file, and edits confined to those paths skip the gate without a release.

The vendored superpowers in `.ai/skills/` is the canonical copy used by every supported agent in this repo. The globally installed `superpowers` plugin is disabled at the project level via `.claude/settings.json` to prevent duplicate skill registration.

**Don't confuse `.ai/skills/` with the top-level `skills/` directory.** They serve opposite audiences:

- `.ai/skills/` — **internal**, dev-time skills for people working ON MDCMS (vendored superpowers).
- `skills/` (root) — **public**, distributable skills for people USING MDCMS in their own projects (installed via `skills.sh`).

## Task workflow

For any implementation task:

1. Find the task in the issue tracker and extract scope, acceptance criteria, and dependencies.
2. Inspect full context from `docs/specs/README.md`, the owning spec under `docs/specs/`, and the linked issue, not only the single task block, to understand upstream and downstream constraints. Skim `.ai/memory/architecture.md` for invariants and `.ai/memory/initiatives/` for whether the work fits an active effort.
3. Map the task to affected packages and files.
4. Ship only what is in scope for that task.
5. While implementing in-scope work, shape code so future planned work fits cleanly and avoid short-term designs that block planned architecture.
6. Document new public contracts and operator workflows at point of use, including README updates, inline comments, CLI help, and API docs, as required by the task's acceptance criteria.
7. Run validations before finalizing.
8. If the task touched architecture, the stack, an integration, or an active initiative, update the relevant `.ai/memory/` file in the same change. If you discovered a non-obvious pitfall, append to `.ai/memory/lessons.md`.

If requirements conflict between an issue and the owning spec under `docs/specs/`, call it out explicitly and prefer the stricter interpretation until clarified.

## Spec-first enforcement

For every new implementation request that changes behavior, endpoint contracts, or public interfaces:

1. Verify first that the intended behavior is explicitly specified in the owning spec under `docs/specs/`.
2. If behavior is missing, ambiguous, or contradictory:
   - stop implementation,
   - send a spec-first nudge,
   - resume only after the spec is updated or confirmed.
3. Do not treat README notes or inferred code behavior as a substitute for spec.
4. If an issue and owning spec conflict, call it out and prefer the stricter interpretation until clarified.
5. Specs under `docs/specs/` must be standalone product documentation. Do not reference task IDs, issue numbers, or other external planning context inside spec content. If a spec needs rationale, keep it self-contained or use an ADR.

### Mandatory spec-first nudge template

Use this exact message template whenever scope is not fully specified:

`Spec-first gate: this behavior/endpoint is not fully specified in the owning spec under docs/specs yet. Please update that spec (or confirm exact contract changes) first, then I will implement strictly against that spec delta.`

### Pre-implementation spec coverage checklist

Before writing code, confirm:

1. Endpoint or behavior exists in the owning spec under `docs/specs/`.
2. Auth mode and required scopes are defined.
3. Required routing context such as `project` and `environment` is defined where relevant.
4. Request and success response contracts are defined.
5. Deterministic error codes and statuses are defined.
6. CLI and operator workflow notes are defined where applicable.

### Required spec delta summary

For each task, provide a short `spec delta` summary before implementation planning or execution:

1. What changed in the owning spec under `docs/specs/`.
2. Which endpoint, contract, or behavior is affected.
3. Which acceptance criteria depend on this spec delta.

### Standalone spec rule

Hard rule:

1. Treat every file under `docs/specs/` as standalone canonical product documentation.
2. Do not write task identifiers like `CMS-40`, `CMS-79`, or any other issue/task references inside specs.
3. Do not refer to issue trackers, "this task", or similar planning context inside specs.
4. If implementation planning context matters, keep it in ADRs, plans, or the issue tracker, not in `docs/specs/`.

## Package boundary rules

- Place shared contracts and cross-cutting types in `@mdcms/shared`.
- CLI concerns live in `@mdcms/cli`.
- `@mdcms/sdk` houses the consumer-facing read client.
- Studio embedding and runtime-loader concerns belong to `@mdcms/studio`.
- Backend runtime and API concerns stay in `@mdcms/server`.

When moving code across packages, preserve clear ownership and avoid circular dependencies.

## Contract and compatibility rules

- Keep TypeScript module settings aligned with existing workspace config such as `nodenext` and project references.
- Keep package export conventions intact unless the task requires change.
- Treat `apps/studio-review` as a maintained repo-internal compatibility consumer of Studio and backend contracts. If a change affects any contract consumed by the review app, update the owning spec, the review app handlers, fixtures, runtime wiring, and the relevant review tests in the same change so preview mocks do not drift.

Any new public API surface must include minimal usage docs and, where applicable, typed contracts.

## Linting and formatting policy

- Prettier is enabled and should be used.
- Do not add or require lint targets or config unless the active task explicitly includes lint baseline work.

## Commit and change hygiene

- Make focused, task-scoped commits.
- Don't include unrelated local folders or tooling artifacts. `.gitignore` enforces what stays local.
- Follow conventional commit message format: `type(scope): message`.
- If the change touches published package source or manifests, run `bun run changeset` and commit the generated changeset. Do not hand-write changeset files.

Before commit, ensure:

1. `bun run format:check` passes.
2. `bun run check` passes.
3. Task-specific verification steps for the change are satisfied.
