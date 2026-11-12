# Push / pull sync

## What it is

The CLI's file ↔ database reconciliation. The database is canonical (server-side); local `.md`/`.mdx` files are a working copy. The two operations are deliberately one-directional:

- **`mdcms pull`** — fetch documents from the server to local files. Overwrites local with server state for the targeted scope.
- **`mdcms push`** — upload local file changes back to the server. Conflict-checked against the server's current state via document version headers.

The full CLI command set is `init`, `login`, `logout`, `pull`, `push`, `schema sync`, `status` (registered in `apps/cli/src/lib/framework.ts`).

## How it works

### Pull

1. CLI authenticates with the stored API key from the credential store.
2. CLI requests document set scoped to project + environment + locale + content-type filters.
3. Server returns documents with their current version metadata.
4. CLI writes `.md`/`.mdx` files to the configured local directory (`mdcms.config.ts` `contentDir`).
5. Each file's frontmatter carries metadata: id, version, environment, locale, references.

### Push

1. CLI scans local files in `contentDir`.
2. For each changed file, CLI sends the request with version-tracking headers:
   - `x-mdcms-project` and `x-mdcms-environment` for routing context
   - `x-mdcms-schema-hash` to pin against the schema the file was authored under
   - `x-mdcms-draft-revision` and `x-mdcms-published-version` to detect server-side drift since the last pull
3. Server validates against the current schema, applies edits, returns the new version.
4. CLI updates local cache to the new version.
5. If the server's version moved since the last pull, the request is rejected as a conflict; CLI surfaces a structured conflict and stops. User resolves manually.

### Status

`mdcms status` shows pending local changes and known conflicts without writing anything.

## Guarantees / invariants

- **Database is the source of truth.** Pull overwrites local; push commits to server with version checks.
- **No silent merge.** Conflicts halt push; resolution is explicit.
- **Schema-checked at push.** The `x-mdcms-schema-hash` header pins the request against the schema the file was authored under (see ADR-006). Server rejects pushes against stale schemas before any partial write.
- **Environment + locale isolation.** Pull/push are scoped — pulling `prod` never overwrites `draft` and vice versa.

- **Format follows the body.** `md` vs `mdx` is not chosen by the file extension or stored by users: `inferContentFormat(body)` in `@mdcms/shared` decides it (a capitalized JSX element or an `import`/`export` line outside code makes it `mdx`). Push sends that format, the server recomputes it on every write and in responses, and pull names files after it. A tracked file renamed between `.md` and `.mdx` is matched to its document by `resolveTrackedFilePath` in `apps/cli/src/lib/discover.ts`, so it is never a delete plus a create.

## Cross-refs

- Spec: `docs/specs/SPEC-008-cli-and-sdk.md`, `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`
- ADR: `docs/adrs/ADR-006-schema-hash-pinning-for-write-clients.md`
- Per-package: `apps/cli/AGENTS.md`
- Implementation: `apps/cli/src/lib/push.ts`, `apps/cli/src/lib/pull.ts`, `apps/cli/src/lib/framework.ts`
- Related: [`schema-sync.md`](schema-sync.md) for the schema-side equivalent flow

## What this is _not_

- Not a CRDT or real-time collab system — that's Post-MVP.
- Not git. Doesn't track history client-side beyond the last-pull cache. Server holds the version history.
- Not symmetric — pull and push are one-way each. There's no "merge" command.
