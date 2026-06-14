# Project brief

## What MDCMS is

A collaborative CMS built around Markdown/MDX for React-based frameworks. The database is the source of truth (not the filesystem). Editors work in a browser-based Studio, developers work with local `.md`/`.mdx` files synced via CLI, and consumer applications fetch via SDK or REST. All three surfaces share the same data layer, validation, permissions, and version history.

## Why it exists

Existing headless CMSes force one of two compromises: filesystem-based tools (Contentlayer, MDX bundlers) lose multi-user collaboration and permissions; database-first tools (Sanity, Contentful, Strapi) lose the developer-friendly file editing flow. MDCMS keeps both — the database is canonical, but the local file experience is real, not a sync hack.

## Who it's for

- **Developers** building React/Next.js/Remix sites who want to edit content in their editor and ship it through git-like workflows.
- **Editors** in those teams who need a real GUI for content work — Studio is for them.
- **AI agents** that want a typed, scoped HTTP API to read and write content without scraping a UI.

The core thesis is that **none of the three should block the others**. An editor publishing a page and an agent rewriting 500 posts at once go through the same validation, the same permissions, and the same version history.

## Core architecture

- **`apps/server`** is the canonical source of truth. Elysia + PostgreSQL + Drizzle. Every read/write hits this.
- **`apps/cli`** owns push/pull/sync — file ↔ database reconciliation, auth via loopback OAuth flow.
- **`packages/studio`** is an embeddable React component the host app mounts at a catch-all route.
- **`packages/sdk`** is a thin read-only client.
- **`packages/shared`** holds Zod contracts and types every other package imports.
- **`packages/modules`** is the first-party module registry — both server-side (`installedModules`) and CLI-side discovery is deterministic and ordered.

## Current collaboration scope

- Real-time multi-user collaboration via CRDTs is in scope for Studio document
  rooms. Redis holds ephemeral Yjs state and presence heartbeats; PostgreSQL
  remains the durable draft source through server-owned collaboration autosave
  and final save.
- MCP integration for agent-driven content operations — upcoming.
- Multiple spaces (team-scoped content organization) — upcoming.

## Current product surfaces

- Live preview exists as real host-route preview: models expose `resolvePreviewUrl` in `mdcms.config.ts`, Studio mints a short-lived `mdcms_preview_token`, and host preview routes verify that token before private draft reads. Fully real-time postMessage/CRDT preview updates are separate future work.
