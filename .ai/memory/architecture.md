# System patterns

Architecture invariants and key technical decisions. Update when one changes.

## Source of truth

- **Database is canonical**, not the filesystem. The server is the only thing that owns truth.
- The CLI's local files are a working copy. Pull/push reconciles against the server, not vice versa.
- Schema (content types + fields) lives in the server's schema registry. The local `mdcms.config.ts` is the developer's authoring surface; `schema sync` reconciles it to the registry.
- Collaboration Redis state is ephemeral. Yjs state and presence make active
  editing fast, but PostgreSQL remains the durable draft recovery point through
  collaboration autosave/final save.

## Module system

- First-party modules live under `packages/modules/<module-id>/`.
- Each module ships `manifest.ts`, `server/index.ts`, `cli/index.ts`. Some also ship `studio/index.tsx`.
- The `installedModules` registry in `packages/modules/src/index.ts` is **deterministic and sorted by `manifest.id`**. Don't introduce ordering coupling.
- Server and CLI each have their own `module-loader.ts`. Both auto-mount at startup.
- Cross-module dependencies go through declared interfaces in `@mdcms/shared`, never direct imports between module packages.

## Package boundaries (hard rules)

- `@mdcms/shared` exports types, validators, pure utilities. **No runtime side effects, no HTTP, no DB.**
- `@mdcms/sdk` is read-only. Bearer-token client. **No write methods.** It may verify MDCMS preview tokens and fetch the matching draft document, but it must not mint tokens.
- `@mdcms/sdk/react` is the SDK's server-only React rendering subpath. It renders fetched Markdown/MDX bodies and loads custom components from `mdcms.config.ts`; keep React/MDX concerns out of the default `@mdcms/sdk` export.
- `@mdcms/cli` owns push/pull/sync logic and the loopback OAuth flow.
- `@mdcms/studio` runs inside the host app's process — embedded React component, not a separate page.
- `@mdcms/server` is the only thing that talks to the database.

## Conditional exports

Every package uses `@mdcms/source` as a custom condition pointing to TypeScript source for development. `import` and `default` point to `dist/` for production. **Don't break this convention** — dev-time source imports rely on it.

## Validation

- All inputs validated with **Zod 4** at module boundaries.
- Content schemas use **Standard Schema** for ecosystem interop.
- No double-validation; once a value is parsed, downstream code trusts the type.

## Tests

- **`*.test.ts`** — unit tests, co-located with source.
- **`*.contract.test.ts`** — Drizzle schema validated against actual SQL migrations. Catches drift between ORM definitions and migration outputs.
- **Integration:** `bun run integration` runs Docker health + migration check.
- **CI gate:** `bun run ci:required`.

## Studio review app

`apps/studio-review` is a maintained internal consumer of Studio + backend contracts, used to keep preview mocks aligned. Whenever a contract changes, update `apps/studio-review` handlers/fixtures/tests in the same commit. Don't let it drift.

## Standalone specs

Files under `docs/specs/` are **standalone canonical product documentation**. No task IDs, no external planning references, no "this task" language. Spec rationale either stays self-contained or moves to an ADR.

## Multi-tenant boundaries

- **Project** is the isolation unit. Every persistable entity carries `project_id`.
- **Environment** is a state within a project (e.g. `draft`, `prod`). Reads default to the published environment unless explicit.
- Tenant scoping is enforced at the route layer — every authenticated request resolves a project context before reaching domain code.

## Live preview

- Preview route mapping belongs on the content type in `mdcms.config.ts` via `resolvePreviewUrl(document)`, not in frontmatter conventions or hardcoded Studio routes.
- The server mints short-lived preview JWTs from persisted draft state at `POST /api/v1/content/:documentId/preview-token`. Tokens are signed with `MDCMS_PREVIEW_TOKEN_SECRET` and are not API keys.
- Private host preview routes verify `mdcms_preview_token` with `@mdcms/sdk` before calling draft reads. Public draft preview routes are allowed when intentional, but `?preview=true` alone is only a mode flag.
