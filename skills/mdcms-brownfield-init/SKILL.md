---
name: mdcms-brownfield-init
description: Use this skill when the user wants to import an existing Markdown or MDX project into MDCMS, says things like "I have a bunch of markdown files and I want MDCMS to manage them", "import my existing blog into MDCMS", "adopt MDCMS for this repo's content", or when the `mdcms-setup` orchestrator has detected the repo has pre-existing `.md`/`.mdx` files. Drives `mdcms init --non-interactive` against the existing content, then verifies the inferred schema.
---

# MDCMS Brownfield Init

Onboard an existing repository whose content already lives as `.md`/`.mdx` files on disk. `mdcms init` is the one-shot command that creates `mdcms.config.ts`, infers a schema from the existing files, syncs that schema to the server, and imports the files as draft documents.

## When to use this skill

The user has:

- an MDCMS backend reachable (if not, run **`mdcms-self-host-setup`** first), and
- a repo with Markdown/MDX content they want MDCMS to manage.

Do not use this skill for empty repos — use **`mdcms-greenfield-init`** instead.

## Prerequisites

- Server URL (e.g. `http://localhost:4000`).
- An MDCMS API key with permission to create projects/environments and sync schema. Create one via Studio → Settings → API Keys, or use the demo key from `docker-compose.dev.yml` for local development.
- A project slug and environment name (defaults to `production` if omitted).
- Node.js / npm — the CLI is `npx mdcms` (or `bun x mdcms`).

## Steps

### 1. Discover the content directories

```bash
find . -type f \( -name '*.md' -o -name '*.mdx' \) \
  -not -path '*/node_modules/*' -not -path '*/.*' \
  | awk -F/ '{print $2"/"$3}' | sort -u
```

List the top two directory levels (for example `content/posts`, `docs/blog`). Confirm with the user which of these MDCMS should manage. Those become `--directory` values in step 3.

### 2. Prepare the non-interactive flags

Collect these inputs up front. If any are missing and the user wants headless, stop and ask:

| Flag            | Value                                          |
| --------------- | ---------------------------------------------- |
| `--server-url`  | MDCMS API base URL                             |
| `--project`     | slug to create on the server (e.g. `my-site`)  |
| `--environment` | environment name (default `production`)        |
| `--api-key`     | token with project create + schema sync scopes |
| `--directory`   | one per managed directory, repeatable          |

Alternatively, set the corresponding env vars (`MDCMS_SERVER_URL`, `MDCMS_PROJECT`, `MDCMS_ENVIRONMENT`, `MDCMS_API_KEY`) and omit the flags.

### 3. Run init

```bash
npx mdcms init --non-interactive \
  --server-url "$MDCMS_SERVER_URL" \
  --project "$MDCMS_PROJECT" \
  --environment "$MDCMS_ENVIRONMENT" \
  --api-key "$MDCMS_API_KEY" \
  --directory content/posts \
  --directory content/pages
```

What this does in one shot:

1. Pings `/healthz`.
2. Creates the project on the server via `POST /api/v1/projects`. If a project with the same slug already exists, the server returns HTTP 409 and `init` exits with a non-zero status — the wizard does not attach to existing projects. See [Attaching to an existing project](#attaching-to-an-existing-project) below.
3. Creates the environment if the just-created project does not already have it. If the project-create response reports the environment already exists (common for the auto-created `production`), init skips environment creation.
4. Stores the API key in the credential store, scoped to `(server, project, environment)`.
5. Scans each `--directory` for `.md`/`.mdx` files, infers types from frontmatter, detects locale patterns in filenames/folders.
6. Writes `mdcms.config.ts` to the repo root.
7. Syncs the inferred schema to the server (`PUT /api/v1/schema`).
8. Imports every discovered file as a draft document. Documents that already exist at the same `(type, path, locale)` are updated in place (PUT fallback on 409).
9. Adds the managed directories to `.gitignore` and untracks any tracked files in them (so the server becomes the source of truth).

### Attaching to an existing project

If the target server already has a project with the slug passed to `--project`, `mdcms init` exits with a 409-driven error and does not modify anything. Options:

- **Pick a different slug** — rerun with `--project <new-slug>`; this creates a fresh project.
- **Use the existing project manually** — hand-author `mdcms.config.ts` pointing at the existing `(project, environment)` tuple, run `mdcms login` to capture a scoped API key, then use `mdcms pull` to fetch the server's state into the repo. `init` is not the right tool for attaching; it's for first-time creation.

### 4. Verify the inferred schema

Open the generated `mdcms.config.ts` and walk it with the user:

- Each `defineType` entry names a type (e.g. `post`, `page`) and lists inferred fields as Zod validators.
- Fields inferred as `z.string()` from frontmatter values are the common case. Check that required vs optional is right and that arrays are typed as `z.array(z.string())` (or whatever element type actually appeared).
- `localized: true` appears only when two or more locales were detected. Confirm the inferred default locale is right.

If the inferred schema is wrong or incomplete (a field got typed as `z.unknown()`, a type is missing, two types should cross-reference), delegate to **`mdcms-schema-refine`**.

### 5. Verify the server state

```bash
npx mdcms status
```

You should see:

- a `Schema:` section that reads `In sync (synced <timestamp>)`
- content documents equal to the import count reported by `init`

Open Studio (`<server-url>/admin/studio`) and navigate to the imported type — the content should appear there.

### 6. Commit the config

Commit `mdcms.config.ts` and the updates to `.gitignore`. The files that got untracked stay on disk for anyone still doing local edits but the server is now authoritative.

## Common gotchas

- **Files with no frontmatter**: those get imported but with an empty schema-driven frontmatter. Add fields later via `mdcms-schema-refine` if that matters.
- **Non-BCP47 locale tags in filenames** (e.g. `en_us`): init normalizes them and records the mapping under `locales.aliases`. Confirm the mapping is what the user wants.
- **Conflicting path + locale combos**: init falls back to an update if a document already exists with the same `(type, path, locale)` identity. Review the import log for any warnings.
- **Pre-existing `mdcms.config.ts`**: the non-interactive flag implies yes-to-overwrite. If the user does not want to lose the current config, back it up first.

## Related skills

- Needs a server from **`mdcms-self-host-setup`** if the user is self-hosting.
- Delegate to **`mdcms-schema-refine`** when inferred types are wrong.
- Continue with **`mdcms-studio-embed`**, **`mdcms-sdk-integration`**, or **`mdcms-content-sync-workflow`** depending on what the user wants next — **`mdcms-setup`** orchestrates that decision.

## Assumptions and limitations

- Requires the non-interactive flag surface on `mdcms init` (shipped with CMS-189).
- Inferred schema is a starting point, not a final answer. Plan on at least one `schema-refine` pass for production use.
- `init` makes `.gitignore` changes; review the diff before committing so any existing ignore lines are preserved.
- Does not cover manual schema authoring from scratch — that path is greenfield + `mdcms-schema-refine`.
