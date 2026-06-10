---
name: mdcms-content-editing
description: Use when the user wants to edit, author, update, translate, fix, or bulk-modify the actual content stored in MDCMS — phrases like "edit my content", "do something with the content", "update a post", "change the body of X", "add a section to my page", "fix typos in this article", "rename a doc", "translate this page to French", "add a new blog post", "make a new page", "bulk-edit a field across all posts", "find a doc with frontmatter X", or "I want to write a draft". For changes to *documents themselves*. Not for schema (that's `mdcms-schema-refine`), not for sync mechanics or auth (that's `mdcms-content-sync-workflow`), not for components (that's `mdcms-mdx-components`).
---

# MDCMS Content Editing

Make actual edits to MDCMS-managed Markdown/MDX documents — body, frontmatter, locales, new docs, bulk changes — and get them validated and pushed to the server. Assumes init has run and there's a working `mdcms.config.ts`.

## When to use this skill

Use whenever the change is to _a document_:

- Edit body or frontmatter of an existing post/page.
- Add a new document of an existing type.
- Translate an existing document to a new locale.
- Bulk-rename, bulk-replace, or bulk-tag documents with shell tools.
- Fix validation errors that surface during `mdcms push`.

Don't use for: adding a new content type or field (use **`mdcms-schema-refine`**), pull/push/CI mechanics or auth errors (use **`mdcms-content-sync-workflow`**), registering MDX components (use **`mdcms-mdx-components`**).

## Prerequisites

- `mdcms.config.ts` exists and the schema is in sync. If unsure, run `npx mdcms status` and resolve any drift first.
- The user is logged in for the target `(server, project, environment)`. If `mdcms status` reports `401`/unauthorized/"Not logged in", route to **`mdcms-content-sync-workflow`** Step 0 (login preflight) before continuing.
- Pull a fresh copy before editing: `npx mdcms pull`. This avoids overwriting newer Studio edits.

## Local vs Studio — pick the right surface

Editors and developers can both reach content. Pick based on the change:

| Change                                                       | Best surface           | Why                                                                       |
| ------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------- |
| Multi-line body edit, new component usage, bulk find/replace | **Local files + push** | Real diff, IDE autocompletion, grep/sed.                                  |
| Single field tweak, image swap, publish toggle               | **Studio**             | Faster, no `pull`/`push` round-trip, lower error surface.                 |
| New translation of an existing doc                           | **Local files + push** | Frontmatter consistency across locales is easier to enforce in an editor. |
| Author wants to author end-to-end (no IDE)                   | **Studio**             | Don't push them through CLI tooling.                                      |
| Validation errors blocking push                              | **Local files**        | Errors print with file paths the user can jump to.                        |

If both surfaces edit the same doc concurrently, `mdcms pull` flags it as "both modified" and asks for resolution. Don't bypass that — fix it.

## Steps

### 1. Locate the document

Documents live in the directories declared in `mdcms.config.ts` under `defineType(..., { directory })`. Each `.md`/`.mdx` file is one document. To find a specific doc:

```bash
# By slug or filename
find content -type f \( -name '*.md' -o -name '*.mdx' \) | grep -i <slug>

# By a frontmatter value
grep -rl 'title: "Hello"' content/

# By type (directory name)
ls content/posts
```

For localized types, files for each locale either share a translation group via frontmatter (e.g. `translationGroupId`) or live in locale subdirectories — check the `locales` config and existing files for the project's convention.

### 2. Edit the document

**Frontmatter** is YAML between `---` delimiters at the top. It must satisfy the type's Zod schema in `mdcms.config.ts`. Common pitfalls:

- Required fields can't be empty strings; use `field: "value"` not `field: ""`.
- Arrays use YAML list syntax (`tags: [a, b]` or block style with `-`).
- Date fields written as ISO 8601 strings (e.g. `publishedAt: 2026-04-01T10:00:00Z`).
- Reference fields (declared via `fieldTypes.reference("<type>")`) take a document id, not a file path.

**Body** is everything after the closing `---`. Markdown is parsed normally; `.mdx` files can use registered React components — see **`mdcms-mdx-components`** for the registry contract.

**Adding a new document** — create a new file in the type's directory. Either author the frontmatter by hand (read a sibling for the field shape) or let `mdcms push` walk you through the new-document prompt interactively. Either path requires the frontmatter to validate against the schema.

**Renaming a document** — `git mv` (or `mv`) the file. On `mdcms push`, the CLI detects the move via content hash and updates the server's path mapping rather than treating it as a delete+create.

### 3. Validate before pushing

Catch shape errors locally — they surface with file paths and field names:

```bash
npx mdcms push --validate --dry-run
```

`--validate` runs frontmatter against the synced schema. `--dry-run` plans the push without writing anything. If validation fails, fix the listed paths and re-run.

### 4. Push the change

```bash
npx mdcms push
```

This uploads changed, new, deleted, and renamed local docs as **draft** updates on the server. Drafts are visible in Studio and to SDK/API reads that explicitly request `draft: true` with the right server-side credentials. They are not visible to normal published-content readers until published; a host app may still choose to expose a draft preview route publicly, but that should be an explicit integration decision.

For headless / CI runs, see **`mdcms-content-sync-workflow`** for the full flag surface (`--force`, `--sync-schema`).

### 5. Publish (Studio only)

Publishing moves a draft revision to the published view that unauthenticated readers see. There is currently no `mdcms publish` CLI command — publish from Studio:

1. Open Studio (`<server-url>/admin/studio` or your host app's Studio embed).
2. Navigate to the document.
3. Use the **Publish** action.

If many docs need to be published together, do it one by one in Studio, or wait for the upcoming bulk-publish action.

### 6. Verify

```bash
npx mdcms status
```

Expected: clean status, no drift. Open the doc in Studio (or hit it via a token-gated preview route / SDK read with `draft: true`) and confirm it renders.

## Bulk edits

For find-and-replace across many docs, prefer plain shell tools — they leave a normal git diff:

```bash
# Replace a string everywhere in content/
grep -rl 'old-link' content/ | xargs sed -i '' 's/old-link/new-link/g'

# Add a frontmatter field to every post (ad-hoc — review the diff before push)
# For more complex transforms, write a small script that parses YAML rather than regexing it.
```

After a bulk edit:

1. `git diff` — sanity-check the change is what you intended.
2. `npx mdcms push --validate --dry-run` — confirm everything still validates.
3. `npx mdcms push` — apply.

For programmatic bulk authoring (e.g. an AI agent rewriting 500 posts), the same path works: edit files, validate, push. Don't hit the API directly — `push` keeps the manifest, hashes, and rename detection coherent.

## Translations

For a localized type (`localized: true` in `mdcms.config.ts`):

- A document is a _group_ across locales, identified by a translation-group id stored in frontmatter.
- Adding a new locale: copy an existing locale's file, change the locale-specific frontmatter (slug, title, body), keep the group id the same.
- Push as usual — the server links the new locale to the group.

If unsure about the project's locale-file convention (subdirectory vs filename suffix), inspect a doc that already has multiple locales before authoring the new one.

## Common gotchas

- **Schema drift mid-edit** — if `mdcms.config.ts` was changed but not synced, `push --validate` validates against stale rules. Run `mdcms status` to see drift; pass `--sync-schema` to push, or run `mdcms schema sync` first (see **`mdcms-schema-refine`**).
- **Editing in Studio while a local copy is dirty** — round-trips collide. The fix is to `pull` first, edit, then `push`. If both sides changed, the pull's "both modified" prompt is the resolution moment.
- **Untracked new files** — `mdcms push` treats files not in the manifest as candidates for new documents. In a TTY it prompts; in CI you need `--force` to upload them. Don't add `--force` blindly — it also confirms deletions.
- **Frontmatter linter doesn't run from your editor** — some IDEs don't parse the project's Zod schema. Trust `mdcms push --validate` over the IDE's hint.
- **MDX with raw JSX that isn't registered** — Studio shows it as a raw tag. Either register the component (**`mdcms-mdx-components`**) or convert to plain Markdown.
- **Deletions** — `rm content/posts/old.md` then `mdcms push` removes the doc on the server. In non-interactive runs, deletion candidates are skipped without `--force`. Use `--dry-run` first.

## Related skills

- **`mdcms-content-sync-workflow`** — owns `pull`/`push`/`status`/login mechanics. Cross-link there for auth errors, CI flag surfaces, and rotating keys.
- **`mdcms-schema-refine`** — when an edit would require a new field or type, switch to this skill.
- **`mdcms-mdx-components`** — when an edit would introduce a new component in MDX content.
- **`mdcms-sdk-integration`** — when changes need to surface in the host app and you're verifying via `cms.get`/`cms.list`.

## Assumptions and limitations

- Assumes the current MDCMS CLI surface: `init`, `login`, `logout`, `pull`, `push`, `schema sync`, `status`. There is no `mdcms create` or `mdcms publish` command — new docs are created by writing files; publishing happens in Studio.
- Bulk-edit examples target Bash + GNU/BSD `sed`. macOS `sed` requires the `''` after `-i` shown above; Linux drops it.
- Reference field shape (id vs slug) is determined by the schema's `fieldTypes.reference()` declaration. When in doubt, look at a sibling document.
- Frontmatter is YAML; if the project later moves to TOML or JSON frontmatter, this skill's syntax notes need an update.
