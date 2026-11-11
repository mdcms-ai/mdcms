# CLI MCP Bridge and Node Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan status:** Implementation outline with interface sketches and verification cases. Production code and complete test bodies are not supplied; unchecked steps are pending implementation and validation.

**Goal:** Relay the server registry over stdio with local schema sync and a Node-compatible executable.

**Architecture:** Keep CLI config and credentials local. Use the SDK client transport for remote operations, with a single local sync_schema tool.

**Tech Stack:** Bun, TypeScript, Zod 4, Elysia, Drizzle/PostgreSQL, MCP TypeScript SDK, React.

---

Run commands from the repository root. Preserve unrelated working changes.
This plan does not authorize commit, push, publish, deployment or external messages.
Run focused tests after each task; parent integration owns commits and the full gate.

## Spec delta

SPEC-008 replaces local content executors with a bridge; SPEC-015 owns remote
schemas and explicit schemaHash inputs. Acceptance is a packed CLI running without
Bun and protocol-only stdout. Dependencies: remote MCP and shared registry.

### Task 1: Bridge transport

Modify `apps/cli/src/lib/mcp.ts` and `mcp.test.ts`. Preserve McpServerDeps config,
fetcher and credential injection where useful, and the existing CLI command
registration through framework.ts.

- [ ] Replace local get/create/update/publish executors with SDK Client plus
      StreamableHTTPClientTransport to the configured /api/v1/mcp URL. Pass resolved
      API key and explicit project/environment headers. Initialize using downstream
      clientInfo; repeat it in each tools/call metadata per SPEC-015.
- [ ] Use low-level request handlers for tools/list and tools/call so input/output
      schemas, annotations, pagination, structuredContent and error results survive
      unchanged. Keep the upstream transport lifetime tied to downstream stdio.
- [ ] Append only sync_schema to discovery. Reject a remote collision with that
      name; do not silently replace a remote tool. Reuse performSchemaSync and
      loadCliConfig for the local executor. Do not inject local schema hashes into
      remote arguments or refresh hashes automatically.
- [ ] Tests must initialize through an actual in-memory/stdio SDK transport,
      inspect advertised tools, call a remote tool and sync_schema, and verify target
      headers, metadata, unchanged errors and pagination. Simulate upstream list
      failure and lost mutation response: neither may become success or a retry.
- [ ] Run `bun test apps/cli/src/lib/mcp.test.ts`.

### Task 2: Node entry and runtime dependency audit

Modify `apps/cli/src/bin/mdcms.ts`, `apps/cli/scripts/build.ts`,
`apps/cli/package.json`, and runtime files identified by the audit below.
Add `apps/cli/scripts/node-mcp-smoke.mjs`.

- [ ] Change the executable header to:

```js
#!/usr/bin/env node
```

- [ ] Inspect `rg -n 'Bun\.|bun:|env bun' apps/cli/src packages/modules` and follow
      reachable imports from the built bin. Replace runtime Bun.file/write/spawn with
      node:fs/promises and node:child_process equivalents preserving exit/error behavior.
      Keep build-time Bun.build; it already targets node. Load TypeScript config using
      a Node-capable loader if the tested Node baseline cannot load existing configs.
- [ ] Set engines.node to the baseline actually tested. Preserve @mdcms/source,
      import/default conditional exports and the bundled private modules behavior.
- [ ] Build and pack the package into a temporary fixture. Install the tarball and
      dependencies, remove Bun from fixture PATH, spawn the package bin with Node,
      initialize MCP, list/call tools against the test server, close stdin and assert
      exit 0. Parse every stdout line as JSON-RPC; stderr contains no credential.
- [ ] Run schema sync from a TypeScript config in that Node-only fixture. A help
      command alone is insufficient evidence for MCP/config compatibility.

### Task 3: Docs and release metadata

Modify CLI README/help and the public MCP usage docs with the new hash inputs and
bridge requirements. Use SPEC-008's npx example.

- [ ] Run `bun test apps/cli/src/lib/mcp.test.ts`, the Node smoke, and
      `bun run check`. Keep the exact tested Node version in the result record.
- [ ] Create the CLI changeset using `bun run changeset`; include shared only if
      its public surface changed. Do not hand-write a changeset or publish a package.
- [ ] Hand the parent packed-artifact evidence and any real-client check gaps.
