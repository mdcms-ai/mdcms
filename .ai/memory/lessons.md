# Lessons

Append a new entry whenever you discover a non-obvious pitfall. Lead with the rule, then a `Why:` line, then a `How to apply:` line. Keep entries one short paragraph each — link to a commit or PR for full context if needed.

Entries are reverse-chronological (newest first).

---

## 2026-11-10 — give the pty a real size when scripting the CLI wizard

**Rule:** When driving interactive CLI commands (`mdcms init`, `push`) through a scripted pty such as `expect`, set a terminal size first (`set stty_init "rows 40 columns 140"`) and guard the run with a hard `kill -9` watchdog.
**Why:** A pty with zero columns makes the `ora` spinner compute an infinite line count and loop forever clearing lines. The process ignores SIGTERM in that loop and grows until the machine runs out of memory.
**How to apply:** Never spawn the wizard under a pty without an explicit size; if a scripted run stalls at a spinner line, kill it with `kill -9` immediately instead of waiting.

## 2026-11-10 — compose images must come from a maintained registry source

**Rule:** Reference third-party Compose images that still publish to a registry, and re-pull them from a clean cache when touching the stack.
**Why:** `minio/minio` and `minio/mc` stopped being pullable from Docker Hub and Quay, so `docker compose up` failed on every machine without a cached copy while passing locally for anyone who had one.
**How to apply:** When a Compose service image changes or a self-hosting bug is reported, run `docker manifest inspect <image>` for each third-party image before assuming the stack boots for new users.

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

## 2026-11-11: distinguish store contracts when migrating callers

**Rule:** Identify the owning store contract before updating calls to common methods such as `create`, `update`, and `restore`.
**Why:** Content, environment, and webhook stores use the same method names but accept different authorization metadata.
**How to apply:** Scope edits by the concrete store type, preserve existing actor semantics outside that contract, and typecheck all affected callers.

- Validate agent-tool response schemas against mounted domain routes, including database-backed fixtures.
  Why: Handwritten fixtures can accidentally add fields that the actual response omits, hiding incompatible envelope or nested schema definitions.
  How to apply: Parse successful registry and adapted Assistant outputs with their advertised schemas and include a real runtime integration case.

## OAuth transactional authorization

**Rule:** Reuse the active PostgreSQL transaction for current-grant checks during token issuance and refresh.
**Why:** Opening another pooled connection while holding transaction locks can exhaust the pool and deadlock concurrent exchanges.
**How to apply:** Pass the transaction into authorization reads and verify exchange and refresh with a one-connection pool. Commit replay revocation before returning an OAuth error.

## 2026-11-12: preserve released migration indices across branches

**Rule:** Keep released Drizzle migrations and regenerate unpublished schema deltas against the current released snapshot.
**Why:** Independent branches can allocate the same migration index with different snapshots; combining those journals can skip or misapply schema changes.
**How to apply:** Preserve the released migration and snapshot, regenerate the unpublished delta from the merged schema, then verify both a fresh database and legacy-data preservation.

## CLI config reload and protocol output

**Rule:** Reload local config dependencies and reserve MCP stdout before evaluating config modules.
**Why:** Cache-busting only the entry URL leaves imported schemas stale. Config side effects run before command execution and can corrupt stdio JSON-RPC.
**How to apply:** Test extensionless TypeScript imports and dependency-only edits in a packed Node process; capture a dedicated protocol writer before routing config console and direct stdout/stderr writes through a shared credential-sanitizing sink, only for MCP. Preserve stream callbacks and backpressure, and restore routing on every exit.

## 2026-11-12: compare dates with drizzle operators, not raw `sql`

**Rule:** Use drizzle operators (`lt`, `gt`, `eq`) for `Date` values; do not interpolate a `Date` into a raw `sql` template.
**Why:** With the postgres.js driver, a `Date` interpolated into `sql` is sent as its `toString()` form and the query fails at runtime, while the same comparison through `lt(column, date)` is serialized correctly. Typecheck does not catch it.
**How to apply:** In server queries, reach for `like`/`lt`/`gt` and friends first; reserve raw `sql` for expressions drizzle has no operator for, and pass dates as ISO strings there.

## 2026-11-12: exempt server-rendered pages from the Studio origin check

**Rule:** A page the server renders and whose form posts back to itself must be excluded in `isStudioBrowserRoute`, like the CLI login pages.
**Why:** The origin check allows same-origin requests by comparing `Origin` with `new URL(request.url).origin`. Behind a proxy (Railway), `request.url` is the internal `http://` address while the browser sends the public `https://` origin, so the form post is rejected with `FORBIDDEN_ORIGIN`. Local tests pass because there both origins match.
**How to apply:** When adding a server-hosted HTML flow under a Studio browser route prefix, add its path to the exclusions and cover it with a test whose request URL differs from the `Origin` header.

## 2026-11-12: preserve authentication across internal dispatch

**Rule:** Forward header-based Studio sessions without ambient cookies.
**Why:** Dropping the session header can make an internal request authenticate as a different cookie session.
**How to apply:** Test header-only requests and conflicting header/cookie identities through both reads and writes.

## 2026-11-12: verify advertised tools through real domain routes

**Rule:** Match tool-required fields to the domain contract and exercise a real HTTP mutation.
**Why:** Discovery and schema-only tests cannot establish that advertised arguments reach a valid domain operation.
**How to apply:** Assert omission fails before dispatch and cover the explicit valid payload through the SDK, including persisted actor and origin.

## 2026-11-12: authorize references before remap diagnostics

**Rule:** Check reference paths before reporting environment-transfer remap failures.
**Why:** Remap diagnostics can reveal documents outside the caller’s current grants.
**How to apply:** Load current grants through the active transaction and reject unauthorized source, destination and reference paths before exposing a plan or writing content.

## 2026-11-12: align fixture clocks across integration boundaries

**Rule:** Anchor fake token clocks to the current time when a real runtime validates the same tokens.
**Why:** A fixed historical fixture date eventually produces expired credentials at the wall-clock boundary.
**How to apply:** Start from the current clock, advance explicit relative intervals for expiry assertions and perform real-runtime authentication before those advances.
