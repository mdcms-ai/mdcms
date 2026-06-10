# @mdcms/shared

## What this is

The contracts layer that every other package imports. This is where content types are defined (`defineConfig`, `defineType`, `fieldTypes`), where API response envelopes are typed, and where schema validation logic lives. If something needs to be understood by both the server and the CLI (or the SDK, or Studio), it belongs here.

Zod is the validation layer. Content schemas use Standard Schema for interoperability.

## Boundaries

- No runtime behavior. This package exports types, validators, and pure utility functions.
- Does not make HTTP requests or access databases.
- Does not contain UI components or CLI commands.
- Changes here affect every other package. Treat the public API as a contract.

## Relevant specs

- `docs/specs/SPEC-004-schema-system-and-sync.md`
- `docs/specs/SPEC-001-platform-overview-and-scope.md`

## Dev

```bash
bun nx test shared
```
