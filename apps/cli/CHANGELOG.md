# @mdcms/cli

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
