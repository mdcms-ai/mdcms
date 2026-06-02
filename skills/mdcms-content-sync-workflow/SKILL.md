---
name: mdcms-content-sync-workflow
description: Use when the user runs day-to-day MDCMS CLI operations — `mdcms pull`, `mdcms push`, `mdcms status`, `mdcms login`, `mdcms logout` — or asks "how do I keep my local markdown in sync with MDCMS", "how do I push changes", "how do I publish from the CLI", "rotate the API key", "what's the draft vs publish flow", "add MDCMS to CI / GitHub Actions". Also triggers on auth-failure symptoms — "I'm getting 401 / unauthorized / 'not logged in' from the CLI", "MDCMS_API_KEY isn't working", "credentials missing", "mdcms login first". Operational usage after init — not for first-time setup.
---

# MDCMS Content Sync Workflow

Operate the local↔server content loop day-to-day: pulling fresh content, pushing edits, logging in/rotating keys, and automating publishes in CI. Assumes **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** already ran.

## When to use this skill

Anything operational: syncing content, managing credentials, automating publishing. Not for first-time setup (that's brownfield/greenfield init), not for schema changes (that's `mdcms-schema-refine`).

## Core mental model

- **Drafts** live on the server and in local working copies. Editing locally + `mdcms push` updates the draft on the server. Editing in Studio writes directly to the server draft. Draft reads require an explicit `draft: true` API/SDK request and appropriate credentials. Host apps can intentionally expose draft preview routes, but private previews should verify a Studio preview token, host session, or equivalent server-side gate first.
- **Publishing** is a separate explicit action (via Studio or the CLI's publish surface when applicable). Published documents are what unauthenticated readers of the host app see.
- **Manifest** — MDCMS tracks per-`(project, environment)` document state in `.mdcms/manifests/<project>.<environment>.json`. The CLI uses it for hash-based change detection. It's not committed; each developer has their own.

## Step 0 — make sure the user is logged in

**Always preflight authentication before any pull/push/status/publish.** Every authenticated CLI command resolves credentials in this order: `--api-key` flag → `MDCMS_API_KEY` env var → stored credential keyed by `(serverUrl, project, environment)`. The first non-empty wins. If none resolves, the CLI exits with an auth error and the user needs to log in.

Quick check:

```bash
npx mdcms status
```

- Exit 0 with a normal status report → credentials are fine, proceed.
- Exit non-zero with `401`, `unauthorized`, `Not logged in`, `No credential found`, or a prompt for an API key → not logged in for this `(serverUrl, project, environment)` tuple.

If the user is not logged in, route based on context:

- **Interactive dev (a real terminal)** — run `npx mdcms login`. It opens a browser, completes an OAuth-style login, and persists an API key in the OS credential store (keychain / libsecret / credential manager). After login, retry the original command.
- **Non-interactive (CI, container, no TTY)** — `mdcms login` will fail with no browser. Get an API key from Studio → Settings → API Keys (scope it to the target `(project, environment)`), then export `MDCMS_API_KEY` (and `MDCMS_SERVER_URL` / `MDCMS_PROJECT` / `MDCMS_ENVIRONMENT` if not already set) before running the CLI.
- **Wrong project/environment selected** — credentials are scoped to a tuple. Logging in for `staging` won't authorize a command targeting `production`. Check `mdcms.config.ts` and the `--project` / `--environment` flags or env vars; log in again with the right tuple if needed.

Don't paper over an auth failure with `--force`, `--yes`, or retry loops. Fix credentials first.

## Daily loop

### Pull the latest drafts

```bash
npx mdcms pull
```

Compares local files against the server and applies the plan. Destructive cases (both local and server changed, deletions, renames) prompt for confirmation. Non-destructive cases apply automatically. For headless runs: `mdcms pull --force` skips the confirmation.

Scope: pull always fetches every document the user's credentials can see. There is no path-based filter.

### Push local edits

```bash
npx mdcms push
```

Uploads changed, new, and deleted local `.md`/`.mdx` files to the server as draft updates. Untracked files (not yet in the manifest) are presented interactively as new content candidates. Headless: pass all answers via flags (see the CLI's `push --help` for the current surface).

Useful add-ons:

- `mdcms push --validate` — validate against the synced schema before pushing.
- `mdcms push --sync-schema` — in non-interactive mode, proactively sync schema drift instead of failing.

### Status check

```bash
npx mdcms status
```

Shows content drift and schema drift for the current `(project, environment)`. Use this before bigger workflows (before starting editing, before CI cut) to confirm the baseline.

## Credentials

### Initial login (interactive)

```bash
npx mdcms login
```

Opens a browser for OAuth-style login against the MDCMS server. On success, stores an API key in the OS credential store (keychain on macOS, libsecret on Linux, credential manager on Windows), keyed by `(serverUrl, project, environment)`.

The CLI resolves keys in this order for every authenticated command: `--api-key` flag → `MDCMS_API_KEY` env var → stored credential. The first non-empty wins.

### Logout

```bash
npx mdcms logout
```

Clears the stored credential for the current or specified tuple.

### Rotating an API key

1. In Studio → Settings → API Keys, create a new key with the same scopes.
2. Re-login with it:

   ```bash
   MDCMS_API_KEY="<new-key>" npx mdcms status   # quick sanity check
   ```

   or run `mdcms login` again to rebind.

3. Revoke the old key in Studio once all consumers have switched.

Treat keys as secrets. Do not commit them. Environment-scoped keys (created per `(project, environment)`) make blast radius small on rotation.

## CI automation

### Pushing on merge (GitHub Actions)

```yaml
# .github/workflows/mdcms-push.yml
name: MDCMS push
on:
  push:
    branches: [main]
    paths:
      - "content/**"
      - "mdcms.config.ts"

jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: MDCMS push
        env:
          MDCMS_SERVER_URL: ${{ vars.MDCMS_SERVER_URL }}
          MDCMS_PROJECT: ${{ vars.MDCMS_PROJECT }}
          MDCMS_ENVIRONMENT: ${{ vars.MDCMS_ENVIRONMENT }}
          MDCMS_API_KEY: ${{ secrets.MDCMS_API_KEY }}
        run: npx mdcms push --validate --force --sync-schema
```

Notes:

- `--force` is required in non-interactive CI. Without it, `push` skips **new** and **deleted** file candidates (they would otherwise be confirmed via an interactive prompt) and only the changed-in-place documents are uploaded — the CI job would look green while the server drifts silently.
- `--sync-schema` lets push apply schema drift in the same run. Without it, a change to `mdcms.config.ts` causes push to fail closed when the local schema differs from the server.
- `--validate` checks frontmatter against the local schema before any API write, so CI catches shape errors before contacting the server.
- Scope the MDCMS API key to the single environment this workflow touches (e.g., `staging`). A separate key pushes to `production` via a manual workflow or a protected environment.
- `paths` filter avoids noisy runs when only app code changes.
- Never echo the API key in logs. GitHub masks secrets but logging them explicitly can defeat that.

### Scheduled pull (optional)

Only needed if the repo treats the filesystem as a mirror (e.g., for static-site build caching). Most consumers fetch via SDK at build/request time and do not need a scheduled `pull`.

## Gotchas

- **Manifest is per-machine** — don't commit `.mdcms/manifests/`. It contains server state that's meaningless to other developers.
- **Hash drift** — if a local file was edited without a `mdcms push`, then someone edited the same document in Studio, both sides diverge. `mdcms pull` classifies this as "both modified" and requires confirmation to overwrite.
- **Deletions need an interactive confirm or `--force`** — `mdcms push` has no dedicated deletion flag. When a tracked file is missing on disk, push treats it as a deletion candidate and prompts before removing it on the server. In non-interactive mode (no TTY, or in CI), deletion candidates are **skipped** unless `--force` is passed. The full push flag surface is `--force`, `--dry-run`, `--validate`, `--published`, `--sync-schema`. Use `--dry-run` first if you want to see the plan without writes; use `--force` only when you're sure a local `rm` should cascade.
- **Schema drift blocks push** — if `mdcms.config.ts` changes locally but schema sync didn't run, push fails closed. Either run `mdcms schema sync` first, or pass `--sync-schema` so push applies the schema in the same run.
- **Multi-environment confusion** — the credential store keys by `(server, project, environment)`. Switching between `staging` and `production` with different keys is fine; forgetting which one is active is where accidents happen. Use `--environment` explicitly in CI.

## Related skills

- **`mdcms-brownfield-init`** / **`mdcms-greenfield-init`** — produce the project state this skill operates on.
- **`mdcms-schema-refine`** — when schema drift blocks a push, that's the owner.
- **`mdcms-setup`** — this skill is Phase 7 of the master orchestrator.

## Assumptions and limitations

- Flag surfaces match the current CLI contract. When in doubt, run `mdcms <command> --help` and trust it over this skill.
- CI example targets GitHub Actions; other CIs follow the same pattern — checkout, install, set env, run `mdcms push`.
- Publish automation (from draft to published) depends on whether the repo wants publishing in CI or exclusively via Studio. This skill does not pick that for the user.
- Does not cover webhooks-driven revalidation of the host app — that is an MDCMS Post-MVP feature.
