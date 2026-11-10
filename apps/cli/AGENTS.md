# @mdcms/cli

## What this is

The command-line interface for syncing content between local files and the MDCMS server. The core mental model: content lives in the database, but developers pull it to local `.md`/`.mdx` files, edit with their preferred tools, and push changes back. The CLI handles change detection, conflict resolution, and schema synchronization.

Commands: `init`, `login`, `logout`, `push`, `pull`, `schema sync`, `status`, `mcp` (preview stdio MCP server for agent clients). Auth uses a loopback OAuth flow (RFC 8252): the CLI runs a localhost listener, the user authorizes in the browser, and the redirect carries a one-time code that the CLI exchanges for an API key stored locally.

## Boundaries

- Does not render or serve content. That's the SDK's job.
- Does not provide a visual editing interface. That's Studio.
- Does not run the server. It connects to a running MDCMS server via HTTP.
- Schema definitions come from the user's `mdcms.config.ts`, not from the CLI itself.

## Relevant specs

- `docs/specs/SPEC-008-cli-and-sdk.md`
- `docs/specs/SPEC-004-schema-system-and-sync.md`
- `docs/adrs/ADR-006-schema-hash-pinning-for-write-clients.md`

## Dev

```bash
bun --conditions @mdcms/source apps/cli/src/bin/mdcms.ts <command>
```
