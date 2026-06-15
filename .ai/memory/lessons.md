# Lessons

Append a new entry whenever you discover a non-obvious pitfall. Lead with the rule, then a `Why:` line, then a `How to apply:` line. Keep entries one short paragraph each — link to a commit or PR for full context if needed.

Entries are reverse-chronological (newest first).

---

## 2026-06-15 — treat blank provider URL env as absent

**Rule:** AI provider wrappers must normalize blank provider-specific base URL env values to the provider default before constructing SDK clients.
**Why:** Docker Compose can pass `ANTHROPIC_BASE_URL=` as an empty environment variable; `@ai-sdk/anthropic` treats that as an explicit override, builds `/messages`, and Bun fails with `fetch() URL is invalid` before any provider request is sent.
**How to apply:** When adding provider SDK wrappers, trim optional URL overrides and pass an explicit default endpoint when the override is blank; add a regression that sets the SDK's own env var to `""`.

## 2026-06-15 — normalize session actor ids before DB writes

**Rule:** Collaboration and session-backed write paths must not pass Better Auth session user ids directly into `documents.updated_by`.
**Why:** Better Auth user ids are not guaranteed to be PostgreSQL UUIDs, while `documents.updated_by` is a UUID column; DB-backed collaboration autosave can fail even though in-memory tests pass.
**How to apply:** When persisting content from session identity, preserve the real actor in lifecycle events but coerce the DB `updatedBy` value to a valid UUID or the neutral content-store actor.

## 2026-06-06 — patch the active worktree by absolute path

**Rule:** When editing from a feature worktree, pass absolute worktree paths to `apply_patch` instead of relying on the thread root.
**Why:** Codex tool calls can default to the original checkout even while shell commands run from the worktree, so a spec patch can land in the wrong checkout and require manual reversal.
**How to apply:** Before applying patches in a worktree-backed task, confirm `pwd` and use `/absolute/worktree/path/...` in patch headers for every edited file.

## 2026-06-04 — preserve webhook sink results through wrappers

**Rule:** Webhook delivery wrappers must return the wrapped sink result after logging or instrumentation.
**Why:** The delivery worker records status codes from the sink return value; a wrapper that only awaits the sink silently turns successful attempts into `statusCode: null` history rows.
**How to apply:** When adding logging, tracing, or metrics around `WebhookDeliverySink`, capture `const result = await sink(delivery)`, perform side effects, then `return result`; add worker or composition coverage when new metadata is persisted from sink results.

## 2026-06-14 — use single-address loopback in Postgres availability probes

**Rule:** Test helpers that make short-lived Postgres availability probes should use `127.0.0.1` instead of `localhost`.
**Why:** Bun can leave a delayed multi-address `node:net` connect-timeout callback behind after a `localhost` probe is closed, which makes later unrelated tests fail with `TypeError: null is not an object (evaluating 'context')`.
**How to apply:** When adding database probe URLs to test support, prefer an explicit IPv4 loopback address unless the test is specifically covering hostname resolution behavior.

## 2026-06-03 — inject deterministic DNS in webhook target tests

**Rule:** Webhook route and dispatcher tests that exercise target validation must inject a deterministic target-address resolver instead of relying on real DNS.
**Why:** The SSRF guard resolves hostnames before persistence and delivery; sandboxed or offline test environments can make public example domains fail resolution, which causes delivery validation to skip otherwise valid webhook fixtures.
**How to apply:** When adding webhook tests with non-literal hosts, pass `resolveTargetAddresses` with explicit public or private fixture IPs and assert the resulting error code/details or delivery selection.

## 2026-06-02 — split lowercase MDX text elements by HTML semantics

**Rule:** Studio's MDX parser must not assume `mdxJsxTextElement` means inline editable text; first classify lowercase tags by HTML semantics and split block-like tags out of paragraph buffers.
**Why:** mdast can represent standalone lowercase tags such as `<p>` and `<h2>` inside an intrinsic wrapper as `mdxJsxTextElement` children of a paragraph, so treating every lowercase text element as literal text leaks raw JSX into the Studio canvas.
**How to apply:** When changing MDX parsing, add regression coverage for lowercase block tags inside wrappers and inline tags such as `<span style={{...}}>...</span>` inside heading/text content, then assert no raw JSX source remains in the parsed TipTap JSON.

## 2026-05-28 — parse AI-generated MDX before marking proposals valid

**Rule:** AI proposal validation must run generated body MDX through the Studio MDX parser family, not only scan component tags or props.
**Why:** JSX string attributes do not treat `\'` as a safe escape inside single-quoted MDX attributes, so JSON-looking prop strings can pass ad hoc catalog validation while crashing Studio during document parse.
**How to apply:** For every proposal operation that writes body text (`create_document.body`, `insert_block.bodyMdx`, `replace_selection.replacementText`), validate with micromark/mdast MDX parsing before returning `valid`; use entities such as `&apos;` or JSX expression props for apostrophes inside single-quoted attributes.

## 2026-05-22 — keep model-visible MDX body text raw

**Rule:** Active draft body and selected markdown sent to the AI model must preserve literal MDX syntax such as `<Box>` and `<Text>`; bound it with explicit content markers instead of XML entity escaping it.
**Why:** If the prompt shows `&lt;Box&gt;`, the model can copy escaped entities back into proposal operations, producing invalid or visibly broken MDX suggestions.
**How to apply:** When changing chat prompt serialization, keep prompt-control sections escaped but assert that active body and selection content contain literal MDX tags in tests.

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
