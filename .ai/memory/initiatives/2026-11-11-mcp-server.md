# MCP server and shared agent tools

**Status:** completed

## Goal

Agents can do everything a person can do in Studio through the Model Context
Protocol, both locally (`mdcms mcp` over stdio) and remotely (Streamable HTTP
with OAuth 2.1). The Studio Assistant and MCP run on one server-hosted tool
registry, and every content change records the real user and the client that
made it.

## Why

The CLI and the public skills pack covered file-based agent work, but agents
increasingly connect to tools through MCP, including hosted clients that
cannot run the CLI. Keeping the Assistant and MCP on separate tool code would
double the work and let their permission and validation rules drift.

## Scope

In:

- Change attribution derived from authentication, with a change origin.
- A content service and tool registry shared by HTTP routes, the Assistant
  and MCP.
- A remote MCP endpoint and an OAuth 2.1 authorization server.
- The CLI stdio bridge, a Node-compatible CLI entry point, and release metadata.
- Tools for every Studio and Assistant operation, docs, skills pack updates,
  CI end-to-end coverage, and verification with real agent clients.

Out:

- An activity log of draft edits.
- Backfilling historical actors.

## Key decisions

- Design: `.ai/research/2026-11-11-mcp-and-shared-tools-design.md`.
- Tools live on the server; the CLI bridges stdio to the server instead of
  reimplementing tools.
- Assistant writes stay proposals; MCP writes execute directly.
- Attribution records the last change and each publish, with a verified
  channel and an optional client-declared name.

- ContentStore writes require authentication-derived `ContentWriteAttribution`.
  HTTP content routes, collaboration, Assistant apply/undo, and seeding persist
  actor IDs and change origins. The CLI declares its name and version; Studio
  displays the last editor and publication authors with their channels.
- Environment clone/promote attribution belongs to the shared content-service
  integration alongside its source/destination authorization checks.

- Shared frontmatter validation and MDX syntax parsing are exported from shared.
  The server registry supplies content/schema tools and injects adapted read
  definitions into the Assistant. Apply/undo use request-bound domain-route
  execution, server-owned proposal/undo records, and per-proposal reservations.
- Trusted proposals have bounded retention and capacity. Minimal undo snapshots
  are removed after consumption or expiry; idle cleanup is disposed on shutdown.
- Delete/restore preconditions and restore-to-published transitions are atomic
  in PostgreSQL.

- Remote MCP now mounts the shared registry through per-request stateless SDK
  transports. PostgreSQL-backed OAuth supports registration, session-bound consent,
  explicit downscoping, PKCE code exchange, refresh rotation/replay revocation and
  session-managed connections. Current user/path grants constrain every dispatch.
- OAuth integration verification uses an isolated ephemeral database; ordinary
  unit discovery does not connect to storage for these cases. The CLI bridge and Connected apps use these server contracts.

- CLI stdio relays the remote registry with downstream client metadata and an immutable connection. Local schema sync reloads config without retargeting credentials. Packed verification covers Node 24.11.1 and 26.13.1, including extensionless TypeScript imports, dependency-only schema reloads, config console output isolation and clean stdin shutdown.

## Completed integration

- The registry exposes 27 remote tools across content, schema, translations,
  versions, media, environments and webhooks. The CLI adds local `sync_schema`.
- Clone/promote checks source and destination scopes, tuples and paths inside
  the transaction, persists authenticated attribution and rejects promotion into
  an active collaboration room without committing partial changes.
- Connected apps supports session-owned grants and project-admin visibility,
  confirmed revocation, target/session cache separation and custom Studio mounts.
- The combined CI gate passed with invocation-owned test stacks. Packed Node
  24.11.1/26.13.1 and Chromium regressions passed. Ordinary unit discovery never
  selects the development database automatically.
- External agent-host acceptance was unavailable; no ChatGPT, Claude or Cursor
  connection is claimed. Publication and deployment remain separate operations.
