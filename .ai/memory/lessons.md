# Lessons

Append a new entry whenever you discover a non-obvious pitfall. Lead with the rule, then a `Why:` line, then a `How to apply:` line. Keep entries one short paragraph each — link to a commit or PR for full context if needed.

Entries are reverse-chronological (newest first).

---

## 2026-05-22 — reject invalid chat proposals at collection time

**Rule:** Chat proposal tools must only collect proposals whose validation status is `valid`; invalid tool output should be returned to the model as a rejected tool result with the correction budget.
**Why:** Studio renders whatever lands in the chat proposal collector as an actionable proposal card, so collecting invalid proposals makes `VALID`/apply semantics drift and exposes cards the user cannot successfully accept.
**How to apply:** When adding or changing a chat `propose_*` tool, route it through the shared queue helper and test both the tool result and the collected proposal list.

## 2026-05-18 — keep Studio CSRF bootstrap stable

**Rule:** Session bootstrap must reuse an existing `mdcms_csrf` cookie instead of rotating it on every `/api/v1/auth/session` call.
**Why:** Studio has multiple route clients that cache bootstrap tokens; rotating the cookie in one client makes another client's cached header mismatch the browser cookie and surfaces `FORBIDDEN: Valid CSRF token is required...` during assistant apply/reject flows.
**How to apply:** When changing auth/session behavior, preserve the double-submit invariant by returning and refreshing the current cookie token when present; only generate a new CSRF token when the readable cookie is missing.

## 2026-05-18 — register cross-rail Studio context upward

**Rule:** When a Studio page needs to feed state into a docked global surface such as the assistant rail, register that state upward through the owning provider instead of relying on React context from the page subtree.
**Why:** Context only flows downward; a provider mounted inside the document page cannot be read by the assistant provider or rail mounted as siblings/ancestors, so active-document state silently resolves to `null`.
**How to apply:** For route-local state consumed by global chrome, expose a provider-level registration hook with cleanup, then let sibling surfaces read the provider-owned snapshot.

## 2026-05-18 — alias Next dev source packages narrowly

**Rule:** In `apps/studio-example`, prefer exact Webpack aliases for local MDCMS workspace packages over adding `@mdcms/source` to global condition resolution.
**Why:** Global condition names affect every package Webpack resolves, including third-party packages such as `zod`, and can make clean Docker dev builds resolve unexpected package export branches.
**How to apply:** When the example app needs unbuilt workspace packages, alias only the required `@mdcms/*` package entrypoints to source files and keep extension aliases for NodeNext `.js` imports in TypeScript source.

## 2026-05-18 — list local workspace packages in Next transpilePackages

**Rule:** When the Studio example imports local `@mdcms/*` workspace packages from app routes, include those packages in `next.config.mjs` `transpilePackages`.
**Why:** Bun installs workspace links under each workspace's own `node_modules`, and Next/Webpack can fail to resolve or transpile packages imported through `mdcms.config.ts` unless the app declares them explicitly.
**How to apply:** For new direct or server-route imports from local MDCMS workspaces in `apps/studio-example`, update `transpilePackages` and add/adjust a config test before relying on `bun run compose:dev`.

## 2026-05-01 — rerun loopback CLI tests outside the sandbox

**Rule:** Treat loopback listener failures on port `0` in CLI tests as a likely sandbox artifact before debugging login code.
**Why:** `bun test --cwd apps/cli ./src` can fail `loopback callback returns styled HTML success page` with `Failed to start server. Is port 0 in use?` under Codex sandboxing, while the same targeted test passes outside the sandbox.
**How to apply:** When a CLI test that binds `127.0.0.1` fails with a port-bind error, rerun the targeted test with sandbox escalation before attributing the failure to product code.
