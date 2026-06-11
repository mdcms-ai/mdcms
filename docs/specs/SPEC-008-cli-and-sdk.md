---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-11
---

# SPEC-008 CLI and SDK

This is the live canonical document under `docs/`.

## SDK

### Design Goals

- Thin wrapper around the REST API
- Framework-agnostic (works in any React-based setup)
- Explicit project/environment routing on every request
- Handles pagination, error handling, and response parsing deterministically
- No codegen step required for SDK read operations

### Usage

```typescript
import { createClient } from "@mdcms/sdk";

const cms = createClient({
  serverUrl: "http://localhost:4000",
  apiKey: process.env.MDCMS_API_KEY,
  project: "marketing-site",
  environment: "production",
});

// Fetch by document ID (preferred)
const postById = await cms.get("BlogPost", { id: "uuid", locale: "en" });

// Fetch by slug (legacy-compatible)
const post = await cms.get("BlogPost", { slug: "hello-world", locale: "en" });

// List documents
const posts = await cms.list("BlogPost", {
  locale: "en",
  published: true,
  limit: 10,
  sort: "createdAt",
  order: "desc",
});

// Get with reference resolution
const postWithAuthor = await cms.get("BlogPost", {
  slug: "hello-world",
  resolve: ["author"], // Resolves the Author reference inline
});
```

The SDK follows the same reference-resolution contract documented in SPEC-003. Resolution is shallow-only, unresolved references become `null`, and the response may include a top-level `resolveErrors` map keyed by the full field path (for example `frontmatter.author`) so callers can inspect why a referenced document could not be materialized. The `resolve` query values express field paths relative to `frontmatter` (e.g., `resolve=author` or `resolve=hero.author`), so callers should not prefix them with `frontmatter.`.

### SDK Contract

- `createClient` stores the server URL, API key, and default target routing (`project`, `environment`) for subsequent requests.
- The SDK is read-focused in v1 and exposes `get` and `list`. Reference expansion is configured through the `resolve` option on those methods; it is not a separate SDK method.
- `get(type, input)` accepts either `id` or `slug`. `id` is preferred; `slug` remains available for legacy-compatible lookups.
- `get` and `list` both accept an explicit `locale` parameter, plus optional `project` and `environment` overrides that take precedence over the client defaults for that call only.
- The SDK sends explicit target routing with `X-MDCMS-Project` and `X-MDCMS-Environment` on every request rather than relying on ambient runtime state.
- `list(type, input)` maps to the content list query contract owned by SPEC-003, including pagination (`limit`, `offset`), sorting (`sort`, `order`), draft reads, and the supported filter fields.
- SDK content reads use the Content API default expanded schema file-field response shape defined in SPEC-003 unless the caller sets `fileFields: "raw"` on the SDK read input. In expanded mode, schema file field IDs are replaced in frontmatter with media asset metadata, including `id`, `url`, `mimeType`, `sizeBytes`, and thumbnails when the media record has them. The `fileFields: "raw"` SDK read input sends `fileFields=raw` to the Content API for `get` and `list` reads so responses preserve the original media asset IDs. CLI pull/push authoring flows request `fileFields=raw` for local file serialization.
- The SDK parses the shared API envelopes directly: single-document reads unwrap `{ data }`, list reads unwrap `{ data, pagination }`, and document payloads preserve any `resolveErrors` map returned by the API.
- API error responses are surfaced through a deterministic SDK error type parsed from the shared error envelope. Transport failures, malformed success payloads, and client misconfiguration use a separate client-side error type so callers can distinguish backend errors from local failures.

### React Rendering Subpath

`@mdcms/sdk/react` is an optional server-side rendering helper for React
applications. It does not add an HTTP endpoint and does not change the
framework-agnostic default `@mdcms/sdk` export.

```typescript
import { createClient } from "@mdcms/sdk";
import { createMdcmsRenderer } from "@mdcms/sdk/react";
import config from "../mdcms.config";

const cms = createClient({
  serverUrl: "http://localhost:4000",
  apiKey: process.env.MDCMS_API_KEY,
  project: "marketing-site",
  environment: "production",
});
const renderer = createMdcmsRenderer(config);

const document = await cms.get("page", { slug: "about", locale: "en" });
const body = await renderer.render(document);
```

- The subpath exports `createMdcmsRenderer(config, options?)`, `renderMdcmsContent(document, { config, ...options })`, and `MdcmsRendererError`.
- Rendering is server-only and returns `Promise<React.ReactNode>`.
- The renderer uses `document.format` and `document.body` from `ContentDocumentResponse` as input.
- Registered MDX components are loaded from `mdcms.config.ts` via `config.components[*].load`; callers do not pass a separate component map.
- Component loader results are cached per renderer instance.
- MDX `import` and `export` syntax is unsupported. Components must be registered in `mdcms.config.ts` instead.
- Browser usage, component load failures, unsupported MDX ESM syntax, and MDX compile/render failures surface as deterministic `MdcmsRendererError` codes.
- The renderer executes trusted MDCMS-authored MDX on the server. It is not a browser-side compiler and is not a sandbox for untrusted arbitrary user input.

### Type Safety and Schema Metadata

- A schema fetched at runtime can support introspection or future runtime validation, but it does not provide compile-time TypeScript inference on its own.
- The read client defined here does not fetch schema during initialization or before content reads.
- Schema-aware write helpers, schema hash pinning, and any automatic schema refresh behavior are deferred until they are specified as a separate contract.

---

## CLI

### Commands

| Command                      | Description                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `cms init`                   | Interactive wizard (or non-interactive CI mode) to set up MDCMS in a project |
| `cms login`                  | Authenticate via browser-based OAuth/email login                             |
| `cms logout`                 | Clear stored credentials                                                     |
| `cms pull`                   | Download all content from CMS to local `.md`/`.mdx` files                    |
| `cms push`                   | Upload local `.md`/`.mdx` files to CMS                                       |
| `cms push --validate`        | Validate content against schema before pushing                               |
| `cms push --sync-schema`     | Allow push to sync schema in non-interactive mode on drift (ignored in TTY)  |
| `cms schema sync`            | Sync `mdcms.config.ts` schema to the server registry                         |
| `cms migrate`                | Generate and apply content migrations for schema changes                     |
| `cms status`                 | Show content drift and schema drift (local vs server)                        |
| `cms action list`            | List available backend actions from `/actions` (with permissions metadata).  |
| `cms action run <actionId>`  | Execute a command/query action via the generic action runner.                |
| `cms <module-defined alias>` | Optional local alias mapped to `actionId` by bundled module CLI surface.     |

All commands that interact with server content resolve a target `(project, environment)` from config defaults and allow per-run overrides via `--project` and `--environment`.

### Global Options

| Flag                   | Description                                              | Requires Config/Auth |
| ---------------------- | -------------------------------------------------------- | -------------------- |
| `--project <slug>`     | Override target project                                  | No                   |
| `--environment <name>` | Override target environment                              | No                   |
| `--api-key <token>`    | API key for headless/CI auth                             | No                   |
| `--config <path>`      | Config file path (default: `mdcms.config.ts`)            | No                   |
| `--server-url <url>`   | Override server URL                                      | No                   |
| `--no-env-file`        | Disable automatic `.env*` file loading for this run      | No                   |
| `-V`, `--version`      | Print installed CLI version (`mdcms/<version>`) and exit | No                   |
| `-h`, `--help`         | Show help and exit                                       | No                   |

`--version` exits immediately with code 0 and does not require a config file, authentication, or server connectivity. Output format is `mdcms/<semver>` (e.g. `mdcms/0.1.4`), suitable for scripting and troubleshooting.

### Environment File Loading

At process startup, the CLI auto-loads `.env*` files before importing `mdcms.config.ts` so config files may read `process.env` directly. Auto-loading is enabled by default for every command, including `cms login`, and may be disabled with `--no-env-file` or `MDCMS_DOTENV=0`.

The env root is the directory containing the resolved `mdcms.config.{ts,js,mjs}` file. With `--config <path>`, the explicit config file path defines the env root. Without `--config`, the CLI searches upward from the current working directory for the nearest `mdcms.config.ts`, `mdcms.config.js`, or `mdcms.config.mjs`; if none exists, it falls back to the current working directory so config-optional commands still get local env defaults.

The CLI uses `NODE_ENV` only as the dotenv file selector, sometimes called the dotenv mode, and defaults it to `development` when unset. This is separate from the MDCMS `environment` target such as `staging` or `production`; `MDCMS_ENVIRONMENT` selects CMS content, while `NODE_ENV` selects files like `.env.production`. Higher-precedence files override lower-precedence files, but variables that already exist in the shell environment always win over file values:

| Precedence | File                    | Loaded when            |
| ---------- | ----------------------- | ---------------------- |
| 1          | `.env.{NODE_ENV}.local` | Always, if present     |
| 2          | `.env.local`            | Unless `NODE_ENV=test` |
| 3          | `.env.{NODE_ENV}`       | Always, if present     |
| 4          | `.env`                  | Always, if present     |

Malformed or unreadable env files are non-fatal. The CLI writes a warning to stderr and continues using shell-only environment values.

CLI extensibility in v1 is intentionally action-based: aliases, formatters, and preflight hooks are allowed; arbitrary command-tree injection is out of scope.

### `cms init` — Interactive Wizard and Non-Interactive Mode

The setup wizard uses `@inquirer/prompts` for the interactive TUI by default. A non-interactive mode is supported for CI and AI-agent driven setup: the same 13 steps run end-to-end, but every prompt is answered from flags, env vars, or config and any missing required input causes a clear `INIT_MISSING_INPUT` error instead of hanging on a prompt.

#### Init-specific flags

| Flag                               | Description                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-y`, `--yes`, `--non-interactive` | Enable non-interactive mode. Auto-accept every confirm, skip every select/text prompt, fail loud on any missing required value.                                     |
| `--directory <dir>`                | Managed content directory. Repeatable. Each value must match an existing directory when content is found, or is used as the scaffold target when no content exists. |
| `--directories <a,b,c>`            | Same as repeated `--directory`, comma-separated.                                                                                                                    |
| `--default-locale <locale>`        | Preset default locale. Must be one of the locales detected from content. Skips the confirm/select for default locale.                                               |
| `--no-import`                      | Skip the initial content import step, even if matching files are found.                                                                                             |
| `--no-git-cleanup`                 | Skip the `.gitignore` update and the tracked-file untrack step.                                                                                                     |
| `--no-example-post`                | When the repo has no content files, still generate `mdcms.config.ts` and scaffold the starter type, but do not write the `example.md` file.                         |
| `-h`, `--help`                     | Show help.                                                                                                                                                          |

Global flags also contribute to non-interactive resolution (`--server-url`, `--project`, `--environment`, `--api-key`) alongside env vars `MDCMS_SERVER_URL`, `MDCMS_PROJECT`, `MDCMS_ENVIRONMENT`, `MDCMS_API_KEY`.

#### Value resolution order

For each required input the wizard resolves (first match wins):

1. Global flag (e.g. `--server-url`).
2. Env var (e.g. `MDCMS_SERVER_URL`).
3. Existing `mdcms.config.ts` field (if present).
4. Stored credential store entry (API key only).
5. Interactive prompt (skipped in non-interactive mode; missing value raises `INIT_MISSING_INPUT`).

Environment name falls back to `"production"` in non-interactive mode when not otherwise provided.

In non-interactive mode, `mdcms.config.ts` that already exists is overwritten implicitly (the mode acts as an auto-yes for all confirms). The intent is that automated setup can be re-run idempotently.

The setup wizard still walks through:

1. **Server URL** — Prompt for the MDCMS server URL + health check (`GET /healthz`).
2. **Project + environment names** — Prompt for project name and environment name (default: `"production"`). These are collected before authentication so the login challenge can scope the API key to `(project, environment)`.
3. **Authentication** — Open browser for login via OAuth flow. The login challenge includes the project and environment from step 2. Scopes: `projects:read`, `projects:write`, `schema:read`, `schema:write`, `content:read`, `content:read:draft`, `content:write`, `content:delete`. The resulting API key has `contextAllowlist: [{project, environment}]`.
4. **Project creation** — `POST /api/v1/projects` with the project name from step 2. Slug is auto-generated from name; a default "production" environment is created automatically. If the server returns `409` (project already exists), the wizard exits with an error.
5. **Environment creation** — If the environment already exists in the project-create response, the wizard skips creation; otherwise `POST /api/v1/projects/:slug/environments`.
6. **Directory scanning** — Scan the project for directories containing `.md`/`.mdx` files and collect locale hints from frontmatter, filename suffixes, and locale folder segments. Root-level files (no parent directory) are excluded.
7. **Directory selection** — Let the developer choose which directories to manage. If no content files are found, the wizard prompts for a content directory name, scaffolds a type with `title` and `slug` fields, and creates an example post (`example.md`).
8. **Schema inference** — Analyze existing frontmatter across files to suggest schema types/fields and infer per-type localization mode (`localized: false` when no locale evidence exists, `localized: true` when two or more distinct locales are detected).
9. **Schema + locale confirmation** — Present inferred schema and locale mapping plan, let developer adjust. Locale detection precedence is `frontmatter > filename suffix > folder segment`; frontmatter keys checked are `locale`, `lang`, and `language`.
10. **Config generation** — Generate `mdcms.config.ts` with the confirmed schema, server URL, and settings. If localized types are present, generate `locales.default`, `locales.supported`, and persisted remaps in `locales.aliases`. The wizard recommends `locales.default` as the most frequently detected locale and prompts for confirmation/override.
11. **Schema sync** — Sync schema to server via `PUT /api/v1/schema`. Persist the server-returned `schemaHash` to `.mdcms/schema/<project>.<environment>.json`. Skipped if no content types are defined.
12. **Initial import** — Push all selected content to the CMS server with explicit `locale` and `content_format` per document. For localized types, the wizard creates one seed locale document per derived translation group, then creates remaining locale siblings as variants of that seed so they share a single `translation_group_id`. On `409` path conflict, the wizard falls back to `PUT` (update) using the `conflictDocumentId` from the error response. Manifest entries are written to `.mdcms/manifests/<project>.<environment>.json` on success.
13. **Gitignore + untracking update** — Add managed content directories to `.gitignore` and explicitly remove already tracked managed content files from the Git index (`git rm -r --cached <dir>`), so they are no longer tracked.

After the credential exchange, the wizard stores the API key in the credential store (keyed by `serverUrl`, `project`, `environment`) for use by subsequent commands.

If the selected managed directories are inside a Git repository and contain tracked files, the wizard must:

- Detect tracked files under each selected managed directory.
- Prompt before mutating the Git index.
- Run `git rm -r --cached <dir>` (or equivalent per-file commands) so files remain on disk but are no longer tracked.
- Print a clear post-step summary (what was untracked) and the follow-up commit guidance.

#### Brownfield Locale Detection and Remapping Algorithm

For each candidate file discovered during `cms init`:

1. Parse locale candidates from frontmatter keys (`locale`, `lang`, `language`), filename suffix, and folder segment.
2. Apply precedence `frontmatter > filename suffix > folder segment`.
3. Normalize the chosen candidate by trimming whitespace, replacing `_` with `-`, and applying canonical BCP 47 casing.
4. If the normalized locale is valid, use it directly.
5. If unresolved/invalid, prompt for remap: either map to an existing canonical locale or add a new supported locale.
6. Persist successful remaps to `locales.aliases` in generated `mdcms.config.ts`.
7. Infer per-type localization mode:
   - No multi-locale evidence => `localized: false`.
   - Two or more distinct locales => `localized: true`.
8. For localized types, files with no locale marker are imported as default-locale variants and reported as warnings.
9. Build translation groups from normalized base paths before initial import. Base-path normalization is derived from the filesystem path and strips locale markers from suffix/folder forms even when frontmatter provides the canonical locale value for the document.
10. During initial import, create one seed locale document per derived translation group and create remaining locale siblings as variants of that seed, so localized brownfield imports surface as one logical document with multiple translations in Studio.

#### Brownfield Verification Scenarios

`cms init` behavior must be validated against:

1. Single-locale brownfield with no locale markers (infers non-localized type).
2. Multi-locale suffix patterns such as `about.en.md` + `about.fr.mdx`.
3. Folder locale patterns such as `content/pages/fr/about.md`.
4. Frontmatter locale overriding conflicting suffix/folder hints.
5. Non-canonical tags (`en_us`, `EN-us`, legacy aliases) requiring normalization/remap.
6. Localized types where some files lack locale markers (default-locale assignment + warning).
7. Mixed projects containing both localized and non-localized types.
8. Pull/push roundtrip that preserves `.md` vs `.mdx`.
9. Reserved token collision prevention (`__mdcms_default__` forbidden in explicit supported/alias targets).
10. Clone/promote remap correctness using `translation_group_id + locale` in implicit single-locale mode.

### `cms pull`

- Downloads the latest **draft state** from the CMS as `.md`/`.mdx` files into the filesystem (draft-first default).
- Pull preserves extension from server `content_format` (`md` or `mdx`).
- Always syncs the full content tree (no selective path filtering).
- **Plan-first:** Before writing anything, the CLI compares local files against the server state and prints a summary of all changes that will be applied. `cms pull --dry-run` prints the plan and exits without writing.

#### Change Categories

The pull plan classifies each document into one of the following categories:

| Category                                | Meaning                                                                          | Action                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Both modified**                       | Local file changed AND server draft revision advanced since last sync.           | Overwrites local file (requires confirmation).                                            |
| **Modified**                            | Server draft revision advanced but local file matches the manifest hash.         | Overwrites local file (no confirmation needed).                                           |
| **Locally modified (server unchanged)** | Local file differs from manifest hash but server draft revision has not changed. | Skipped — file is not written. Guidance printed: "Use `cms push` to upload your changes." |
| **New**                                 | Document exists on server but has no manifest entry.                             | Written to disk.                                                                          |
| **Moved/Renamed (locally modified)**    | Server path/format changed AND local file at the old path was edited.            | Old file deleted, new file written (requires confirmation).                               |
| **Moved/Renamed**                       | Server path/format changed, local file unmodified.                               | Old file deleted, new file written.                                                       |
| **Deleted on server**                   | Manifest entry exists but document is absent from server response.               | Local file deleted (requires confirmation).                                               |
| **Skipped (unknown type)**              | Document type is not defined in local config.                                    | Skipped with a warning to stderr.                                                         |
| **Unchanged**                           | Hash, draft revision, and published version all match.                           | No action.                                                                                |

#### Plan Output Example

```text
$ cms pull

Pull plan:

Both modified (1)
  - pages/about.en.md (draft=8, published=-)

Modified (2)
  - blog/hello-world.en.md (draft=15, published=3)
  - blog/getting-started.en.md (draft=5, published=-)

Locally modified (server unchanged) (1)
  - pages/faq.en.md (draft=2, published=-)

New (1)
  - blog/new-post.en.md (draft=1, published=-)

Moved/Renamed (1)
  - blog/old-slug.en.md -> blog/new-slug.en.md (draft=9, published=-)

Deleted on server (1)
  - blog/deprecated-post.en.md (draft=3, published=-)

Unchanged (42)
  - (not listed individually)

Note: 1 file(s) modified locally but unchanged on server. Use 'cms push' to upload your changes.

Warning: 1 file(s) modified both locally and on server. Pull will overwrite local changes.
Consider backing up local changes before proceeding, then re-apply after pull.

This will overwrite locally modified files that also changed on server, and delete local files removed on server. Continue? [y/N]
```

#### Confirmation Logic

- Pull requires confirmation when any of the following categories are present: **Both modified**, **Moved/Renamed (locally modified)**, or **Deleted on server**.
- If none of these destructive categories are present, pull proceeds automatically.
- `cms pull --force` skips the confirmation prompt.

#### Change Detection

- **Locally modified detection:** The CLI hashes each local file and compares it against the `hash` recorded in the manifest. If the local file has been edited since the last pull/push, it is flagged as locally modified.
- **Remote change detection:** Compares the server's `draftRevision` and `publishedVersion` against the manifest, plus a content hash comparison.
- **Detects moves/renames:** Compares the manifest's `document_id` → `{ path, format }` mapping against the server. If a document's path and/or format changed (renamed slug, moved folder, or `.md`/`.mdx` extension change), the old local file is deleted and the new file is written at the new deterministic path. If the old file was locally modified, the change is flagged as **Moved/Renamed (locally modified)**.
- **Detects deletions:** If a document in the manifest is absent from the server response, the corresponding local file is removed.
- **Unknown types:** Documents whose type is not defined in the local config are skipped with a warning to stderr summarizing the count per type.
- Records draft revision, published version, content format, and content hash for each document in a scoped manifest (`.mdcms/manifests/<project>.<environment>.json`).
- The manifest maps `document_id` → `{ path, format, draftRevision, publishedVersion, hash }` and is used by `cms push` for optimistic concurrency checks and by `cms pull` for local modification detection. The manifest is not committed to git.
- `cms pull --published` is available when developers want published snapshots instead of drafts.

#### Local File Mapping Contract (Strict)

- Localized types use deterministic paths: `<document.path>.<locale>.<ext>` (for example: `blog/hello-world.fr.mdx`).
- Non-localized types use deterministic paths: `<document.path>.<ext>` (for example: `pages/about.md`).
- `<ext>` is always `md` or `mdx` and is sourced from `documents.content_format`.
- The file body stores the mutable head markdown/MDX content from `documents.body`.
- Frontmatter stores schema fields only (no transport metadata such as revision/version tokens).
- Transport metadata (`document_id`, `format`, `draftRevision`, `publishedVersion`, content hash) lives only in `.mdcms/manifests/<project>.<environment>.json`.
- `cms pull` must delete stale local paths when server-side `path`, `locale`, or `content_format` changes (or soft-delete) are detected.

### `cms push`

- Uploads changed, new, and deleted local `.md`/`.mdx` files to the CMS server as draft updates (publish is explicit and separate).
- `cms push` derives `content_format` from file extension (`.md` => `md`, `.mdx` => `mdx`) and rejects unsupported extensions with a deterministic error.
- For known documents, identity is resolved from manifest `document_id`; file path is treated as mutable state that can rename/move without changing document identity.
- Sends the base draft revision token and latest published version (from the manifest) with each document.
- Change detection is hash-based against `.mdcms/manifests/<project>.<environment>.json`; unchanged documents are skipped and not sent.
- If a manifest entry has a missing/empty hash, that document is treated as changed and the hash is repaired on successful push.

#### New file detection

- After processing manifest entries, `cms push` scans all `contentDirectories` (from `mdcms.config.ts`) recursively for `.md`/`.mdx` files whose relative paths are not present in the manifest.
- Each untracked file is mapped to a content type via the type directory config (`pickTypeConfigForPath`). Files that cannot be mapped are skipped with a warning.
- In interactive mode, untracked files are presented as a checkbox selection ("Select new files to upload:"). Only selected files are created on the server via `POST /api/v1/content`.
- On successful creation, a new manifest entry is added keyed by the server-returned `documentId`.

#### Deleted file detection

- During manifest iteration, if a tracked file is missing on disk (ENOENT), it is collected as a deletion candidate instead of causing a hard error.
- In interactive mode, deletion candidates are presented as a checkbox selection ("Select files to delete from server:"). Only selected files are soft-deleted on the server via `DELETE /api/v1/content/:documentId`.
- On successful deletion (or if the server returns 404, meaning it was already deleted), the manifest entry is removed.

#### Interactive selection and `--force`

- Without `--force`, two separate checkbox prompts are shown (if applicable): one for new files, one for deletions. A final confirmation prompt summarizes the total action ("Push N changed, N new, N to delete?").
- With `--force`, all new files are auto-selected for upload, all deletions are auto-selected for removal, and all confirmation prompts are skipped. This is the recommended mode for CI/scripted usage.
- In non-TTY environments without `--force`, checkbox prompts return empty selections (no new files uploaded, no deletions performed). Changed manifest-tracked files are still pushed normally. A hint is printed: "Run with --force to include new/deleted files in non-interactive mode."

#### Update fallback on 404

When a `PUT` update returns `404` (document was deleted on the server but the manifest still references it), `cms push` falls back to `POST` to recreate the document under a new `documentId`. The old manifest entry is replaced by the newly created one. This avoids hard failures when the server-side state has diverged.

#### Manifest flush

The manifest is flushed atomically (via `writeScopedManifestAtomic`) after each successful individual operation (update, create, or delete) rather than once at the end. This ensures that a crash or network failure mid-push does not lose track of documents that were already successfully synced.

#### Schema and validation

- **Schema preflight:** Before any content writes, `cms push` calls `GET /api/v1/schema` and compares the server's current `schemaHash` for the target `(project, environment)` against the hash computed from the local config. On drift in interactive mode (TTY), push prints a rich diff (added / modified / deleted types with names) and prompts once to sync. Acceptance triggers an inline schema sync (same code path as `cms schema sync`, sharing the `performSchemaSync` helper) and continues with content writes in the same invocation; decline exits 1 with zero content writes. In non-interactive mode push fails closed with `SCHEMA_DRIFT` unless `--sync-schema` is supplied. With `--sync-schema`, push runs sync first and aborts the whole push if sync fails. In TTY mode `--sync-schema` is silently ignored — the prompt always wins so the user sees the drift before approving.
- **Schema hash requirement:** Before sending content mutation requests whose endpoint contract requires schema validation, `cms push` reads the schema hash from `.mdcms/schema/<project>.<environment>.json` (see SPEC-004 "Local Schema State File"). The common validated mutations are create requests, update requests, and bulk `move` operations that modify content paths; the server endpoint contract determines the final required set. If the file does not exist, the same interactive/non-interactive flow as schema drift applies: in TTY mode push prompts once to sync schema from the server; in non-interactive mode push fails closed unless `--sync-schema` is supplied. If sync succeeds the local state file is created and push continues; if sync fails or is declined, push exits 1 with zero content writes. The hash is sent as `x-mdcms-schema-hash` on create/update requests and on any bulk `move` operations that `cms push` performs.
- **Schema mismatch handling:** With preflight active, the per-doc `SCHEMA_HASH_MISMATCH` (`409`) path covers race conditions only — a concurrent sync changed the server hash between preflight and content writes. Failed documents are reported with reason code `schema_hash_mismatch`; the exit summary directs the developer to re-run `cms push` rather than `cms schema sync`, since the local state may already be fresh. Other documents in the same push run continue (partial success).
- **Path conflict handling:** If the server returns `CONTENT_PATH_CONFLICT` (`409`) for a document (update, create, or new-file), that document is reported as failed with reason code `content_path_conflict`. The exit summary directs the developer to run `cms pull` to re-sync the manifest.
- **Active collaboration handling:** If the server returns `DOCUMENT_COLLABORATION_ACTIVE` (`409`) for a known document, that document is reported as failed with reason code `collaboration_active`. Other documents in the same push run continue. The exit summary tells the developer to wait for the active Studio collaboration session to close before retrying the locked document.
- **Draft optimistic concurrency:** If the server's current `draft_revision` differs from the base draft revision in the manifest, the push is **rejected** for that document with reason code `stale_draft_revision`. The developer must `cms pull` first, then re-apply their changes.
- On success, the server updates `documents`, increments `draft_revision`, and does not create new `document_versions` rows.
- Optional `--validate` flag runs schema validation locally before pushing. Validation covers both changed and selected new documents. Because preflight has already normalized local vs server schema state (or aborted), the old "local schema differs from last synced" warning inside `--validate` is no longer needed.

### `cms schema sync`

`cms schema sync` synchronizes the current `mdcms.config.ts` schema to the server for a specific `(project, environment)` target.

- Parses `mdcms.config.ts` and resolves per-environment overlays.
- Builds schema payload (types + fields, excluding MDX component registrations and prop metadata).
- Uploads raw schema snapshot + resolved environment schema via `PUT /api/v1/schema`.
- Validates schema compatibility at sync time; incompatibilities produce actionable error output.
- Does not mutate content rows.
- On success, persists the server-returned `schemaHash` to `.mdcms/schema/<project>.<environment>.json` using atomic file writes (see SPEC-004 "Local Schema State File"). This file is read by `cms push` and future SDK write methods to satisfy the `x-mdcms-schema-hash` write gate.
- Supports `--project` and `--environment` overrides; defaults from config.

### `cms status`

`cms status` compares local content and schema state against the server and reports drift.

#### Content Drift

Fetches all draft documents from the server and compares against the local manifest and file hashes. Each document is classified into one of these drift categories:

| Category               | Meaning                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| **Modified on server** | Server `draftRevision` advanced; local file matches manifest hash. |
| **Modified locally**   | Local file hash differs from manifest; server revision unchanged.  |
| **Both modified**      | Both local file and server revision have changed since last sync.  |
| **New on server**      | Document exists on server but has no manifest entry.               |
| **Deleted on server**  | Manifest entry exists but document is absent from server.          |
| **Moved/Renamed**      | Server path differs from manifest path for the same `documentId`.  |
| **Unchanged**          | Hash, draft revision, and published version all match.             |

#### Schema Drift

Reads the local schema state file (`.mdcms/schema/<project>.<environment>.json`) and compares the stored `schemaHash` against a freshly computed hash from the current `mdcms.config.ts`. Reports one of:

- **In sync** — local schema matches last synced hash, with `syncedAt` timestamp.
- **Drifted** — local schema differs; guidance to run `cms schema sync`.
- **No state** — no schema state file found; guidance for fresh-clone setup (`cms schema sync && cms pull`).

#### Exit Code

Returns exit code `1` if any content drift or schema drift is detected; `0` if everything is in sync.

### `cms migrate`

Handles content migrations when the schema changes (e.g., a new required field is added):

1. `cms migrate` — Detects schema differences between the current config and the server's stored schema. Generates a migration file in the project's `migrations/` directory.
2. The migration file contains a function that receives each document individually and returns the migrated version. This allows per-document logic (not just a global default).
3. Developer reviews and optionally edits the migration file.
4. `cms migrate --apply` — Runs the migration, updates drafts, and auto-publishes migrated results (new version rows for affected documents).
5. Migration execution remains self-contained in MVP; external webhook fan-out is deferred to the Post-MVP webhook system.

**Example migration file:**

```typescript
// migrations/20260212_add_author_field.ts
import type { Migration } from "@mdcms/cli";

export const migration: Migration = {
  type: "BlogPost",
  description: "Add required author field to BlogPost",
  up: (document) => ({
    ...document,
    frontmatter: {
      ...document.frontmatter,
      // Custom logic per document — not a single global default
      author: inferAuthorFromContent(document.body) ?? "default-author-id",
    },
  }),
};
```

### Authentication

- `cms login` starts a browser-based authorization code flow via `/api/v1/auth/cli/login/*`. It requires a config file (`mdcms.config.ts`) so that `project` and `environment` are known.
- CLI starts a local loopback callback listener (`127.0.0.1`) and exchanges a one-time code for an API key scoped to `(serverUrl, project, environment)`. Both `project` and `environment` are required in the login challenge.
- After obtaining the key, `cms login` verifies the project exists on the server (`GET /api/v1/projects`). If the project does not exist, the key is revoked (`POST /api/v1/auth/api-keys/self/revoke`) and the command exits with an error directing the user to run `cms init`.
- The credential store is keyed by server URL, project, and environment and supports one active profile per tuple.
- In interactive mode, credentials are stored in the OS credential store when available (fallback to `~/.mdcms/credentials.json` with `0600` permissions).
- Login-generated API keys request scopes: `projects:read`, `projects:write`, `schema:read`, `schema:write`, `content:read`, `content:read:draft`, `content:write`, `content:delete`. The server filters these to the subset permitted by the session's effective role. **MVP limitation:** CLI operations (`push`, `pull`, `init`) require `schema:write` and `projects:write` which are only available to Admin and Owner roles. Editor and Viewer users cannot use the CLI until role-aware scope narrowing is implemented.
- CLI auth precedence is: `--api-key` > `MDCMS_API_KEY` > stored profile.
- On success, `cms login` prints a confirmation message and outputs the API key as `MDCMS_DEMO_API_KEY` for convenience (e.g., demo app requests).
- `cms logout` always clears the local profile for the current tuple and performs best-effort remote self-revoke of the active API key.

### Action Runner and Alias Resolution

- `cms action list` reads the backend action catalog and shows only actions visible to the caller.
- `cms action run <actionId>` resolves request/response schema refs, validates input, and executes the backend action endpoint.
- Module-provided aliases are compile-time local mappings (`alias` -> `actionId`), not remotely downloaded code.
- Output formatters are optional and keyed by `actionId` or response schema; formatter failures fall back to raw JSON output.
- Preflight hooks run before execution for local checks (config/target/auth presence) and cannot bypass backend authorization.

---
