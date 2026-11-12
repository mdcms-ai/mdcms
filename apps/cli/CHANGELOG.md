# @mdcms/cli

## 0.4.3

### Patch Changes

- d0f4b37: A document's md/mdx format now follows its body: it is mdx when it contains a component or an import/export line. The SDK renderer compiles with that format, the CLI names files after it and treats a .md/.mdx rename as the same document, and a component's load may return its module.
- f9d2990: The CLI prints mdcms commands in its guidance, mdcms status shows moves as local path to path after pull and skips unknown types like pull, mdcms push gains --yes (with --force as an alias) and per-command --help works, and mdcms mcp documents tool scopes, adds get_credentials_info, and tells the user to run mdcms login on a 401.
- Updated dependencies [d0f4b37]
  - @mdcms/shared@0.6.1

## 0.4.2

### Patch Changes

- aa22d44: mdcms login and mdcms init print the sign-in URL whenever they open the browser, and escape & in the URL when opening it through cmd on Windows.

## 0.4.1

### Patch Changes

- e9955c4: Run the CLI on Node.js without Bun, generate configs that import z from @mdcms/cli so projects need no separate zod dependency, and ask again when the project name in init is left empty.
- d9f7a5e: Push changed documents without a confirmation prompt when no terminal is attached, so scripts and agents can push edits as drafts.

## 0.4.0

### Minor Changes

- 558aa7f: Add the preview `mdcms mcp` command: a stdio MCP server that lets agent clients read the schema and read, create, update and publish documents for the configured project and environment.

## 0.3.1

### Patch Changes

- 7837930: Report active collaboration locks during push as per-document failures.
- Updated dependencies [d862750]
  - @mdcms/shared@0.6.0

## 0.3.0

### Minor Changes

- eb598b2: Add schema file field types under fieldTypes, move references to fieldTypes.reference, and expand file fields to media assets on reads.

### Patch Changes

- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [15fdaee]
- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [eb598b2]
- Updated dependencies [8d8feb9]
  - @mdcms/shared@0.5.0

## 0.2.5

### Patch Changes

- Updated dependencies [a48b9d8]
  - @mdcms/shared@0.4.0

## 0.2.4

### Patch Changes

- fe2cf74: Remove AI-generated slop (redundant comments, dead code, gratuitous casts and defensive guards). No behavior change.
- Updated dependencies [fe2cf74]
  - @mdcms/shared@0.3.1

## 0.2.3

### Patch Changes

- Updated dependencies [ec9e435]
- Updated dependencies [7bb04b7]
- Updated dependencies [50ae976]
- Updated dependencies [6409863]
  - @mdcms/shared@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [a81169a]
- Updated dependencies [98779f0]
  - @mdcms/shared@0.2.0

## 0.2.1

### Patch Changes

- 4ec96d6: Auto-load dotenv files before CLI config import, with config-root lookup, shell env precedence, and opt-out controls.

## 0.2.0

### Minor Changes

- 7e904c9: Add non-interactive mode to `mdcms init` so CI and AI-agent skills can drive setup end-to-end. New flags: `-y` / `--yes` / `--non-interactive` (fully headless), `--directory` (repeatable), `--directories` (comma-separated), `--default-locale`, `--no-import`, `--no-git-cleanup`, `--no-example-post`. Missing required inputs surface as `INIT_MISSING_INPUT` instead of hanging on a prompt. Values resolve from flag → env var → `mdcms.config.ts` → stored credential, in that order. Existing interactive behavior is unchanged.

### Patch Changes

- dfa8664: handle missing schema state in push with sync flow instead of hard error

## 0.1.5

### Patch Changes

- b295660: Add `--version` / `-V` flag to print the installed CLI version and exit without requiring config, auth, or server connectivity
- d10a004: Make default CLI logs user-friendly and move internal runtime diagnostics behind --verbose mode.
- Updated dependencies [d10a004]
  - @mdcms/shared@0.1.4

## 0.1.4

### Patch Changes

- ba9cce3: Fix localized init imports when locale is declared in frontmatter.

## 0.1.3

### Patch Changes

- 3ad2124: Preserve translation groups when mdcms init imports localized files
