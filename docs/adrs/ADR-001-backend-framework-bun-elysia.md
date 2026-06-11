---
status: accepted
canonical: true
created: 2026-03-11
last_updated: 2026-06-11
---

# ADR-001 Backend Framework: Bun + Elysia

This is the live canonical document under `docs/`.

## Context

The backend framework decision had to satisfy Bun-native performance goals, Elysia compatibility, better-auth integration, PostgreSQL/Drizzle support, and a viable path for the in-process collaboration transport.

## Decision

- Use Bun as the runtime and Elysia as the HTTP framework.
- Use better-auth for authentication, mounted through Elysia integration points.
- Use Drizzle ORM with `postgres.js` as the primary PostgreSQL path.

## Rationale

- Bun + Elysia gives the cleanest Bun-native stack for the planned monorepo and Docker-based deployment model.
- better-auth has working Elysia integration and a strong TypeScript ecosystem position, despite some Bun install friction around `better-sqlite3`.
- `postgres.js` is the best current balance of Bun support, pooling stability, and ORM compatibility. Bun.SQL remains a future optimization path rather than the default.

## Collaboration Caveat

Real-time collaboration remains the main transport-sensitive area. Hocuspocus is the collaboration server, but Bun deployment should use a Bun-compatible `crossws` bridge instead of depending on Node-oriented WebSocket assumptions. This keeps the collaboration runtime in-process with the API server while preserving a transport adapter boundary around WebSocket handling.

## Consequences

- Monitor Bun long-running process stability and native dependency compilation friction in CI/CD and Docker images.
- Keep WebSocket/collaboration work behind a narrow bridge so Bun transport details do not leak into editor or persistence code.
- Preserve a clean driver abstraction so the PostgreSQL adapter can be revisited later.

## Related Specs

- `docs/specs/SPEC-002-system-architecture-and-extensibility.md`
- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md`
- `docs/specs/SPEC-011-local-development-and-operations.md`
