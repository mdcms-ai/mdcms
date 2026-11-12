---
name: mdcms-greenfield-init
description: Use this skill when the user wants to start a new MDCMS project from scratch with no existing Markdown content, says things like "I'm starting a new site and want to use MDCMS", "set up MDCMS in this empty repo", "I want to try MDCMS with fresh content", or when the `mdcms-setup` orchestrator detects no `.md`/`.mdx` files in the repo. Drives `mdcms init --non-interactive` with the scaffolded starter, pushes the example, and optionally proposes first real content types via `mdcms-schema-refine`.
---

# MDCMS Greenfield Init

Bootstrap MDCMS in a repo that has no content yet. `mdcms init` scaffolds a minimal starter (one content type, one example post, a valid `mdcms.config.ts`) and syncs the schema. A follow-up `mdcms push` uploads the example.

## When to use this skill

The user wants MDCMS for a new project and has no existing Markdown/MDX files to import. If the repo already has content, use **`mdcms-brownfield-init`** instead.

## Prerequisites

- Server URL (self-host with **`mdcms-self-host-setup`** if needed).
- MDCMS API key with project + schema permissions.
- Project slug and environment name.
- Node.js / npm for `npx mdcms`.

## Steps

### 1. Run init

```bash
npx mdcms init --non-interactive \
  --server-url "$MDCMS_SERVER_URL" \
  --project "$MDCMS_PROJECT" \
  --environment "$MDCMS_ENVIRONMENT" \
  --api-key "$MDCMS_API_KEY"
```

With no content on disk, init:

1. Scaffolds `content/posts/` as the managed directory.
2. Generates a `post` type with `title: z.string()` and `slug: z.string().optional()`.
3. Writes `mdcms.config.ts`.
4. Syncs the schema to the server.
5. Creates `content/posts/example.md` (a placeholder with frontmatter and a short body). Skip this last step with `--no-example-post` if the user does not want it.

If the user prefers a different starter directory, pass `--directory <path>` — the type is named after the last path segment.

### 2. Push the example to the server

`init` writes the file locally but does not import it, so `push` sees it as a new file. Check the plan first:

```bash
npx mdcms push --dry-run
```

The plan should list `content/posts/example.md` as the only new file. Then push it:

```bash
npx mdcms push --force
```

Without a terminal (as when an agent runs the command), `push` skips new files unless `--force` is passed. `--force` only skips the prompts that choose new and deleted files; it uploads every new file and applies every deletion in the plan, which is why the dry run comes first. In an interactive terminal, plain `npx mdcms push` asks which new files to upload instead.

After the push, the user can open Studio and see a real draft document.

### 3. Decide on the content model

At this point the repo has a minimal `post` type with two fields. Ask the user what their real content model looks like (blog posts with authors and tags? marketing pages? campaigns with localized variants?) and either:

- Start drafting directly in the scaffolded directory if the starter shape fits, or
- Delegate to **`mdcms-schema-refine`** to add the real types, fields, and references.

Nudge the user toward `schema-refine` if they describe more than one content kind — the scaffold is intentionally minimal, not a template.

### 4. Verify

```bash
npx mdcms status
```

Expected:

- a `Schema:` section that reads `In sync (synced <timestamp>)`
- at least one document (the example post) if `push` ran

Open Studio at `<server-url>/admin/studio` and confirm the example post appears under the `Post` type.

### 5. Commit the starter

Commit `mdcms.config.ts` and the `content/posts/example.md` scaffold if the user wants it as a starting point. If the user intends to delete the example and author real content immediately, the file can be dropped, but push again after removal so the server reflects it (`npx mdcms push --dry-run` first: the deletion only applies when confirmed in a terminal or with `--force`).

## Common follow-ups

- **More content types** → **`mdcms-schema-refine`**.
- **Render the content in the host app** → **`mdcms-sdk-integration`**.
- **Add the Studio UI to the host app** → **`mdcms-studio-embed`**.
- **Teach the user `pull`/`push` flow** → **`mdcms-content-sync-workflow`**.

## Gotchas

- The scaffolded `post` type is a placeholder. Do not encourage the user to ship real content against it without a schema review.
- `--no-example-post` still writes the config and syncs the schema, but leaves the directory empty. Only use this when the user will write their own first document immediately.
- If an `mdcms.config.ts` already exists in the repo, non-interactive mode overwrites it. If the user has a hand-written config they want to keep, back it up first.

## Related skills

- **`mdcms-self-host-setup`** — needed if the user does not yet have a backend.
- **`mdcms-schema-refine`** — the natural next step to author real content types.
- **`mdcms-setup`** — master orchestrator; this skill is phase 2 of that flow in the greenfield branch.

## Assumptions and limitations

- Requires the non-interactive flag surface on `mdcms init` (shipped with CMS-189).
- The starter schema is deliberately simple — one type, two fields. Production projects should refine it.
- Does not set up Studio embed, SDK fetching, or MDX components — those are separate skills.
