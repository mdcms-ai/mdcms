---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-06-09
---

# SPEC-001 Platform Overview and Scope

This is the live canonical document under `docs/`.

## Overview

MDCMS is an open-source CMS built around Markdown and MDX files. It takes any arbitrary nested folder structure of Markdown files — including brownfield projects — and makes every file editable through a collaborative CMS interface.

**Core principle:** The database is the source of truth, not the filesystem. Content files are `.gitignore`d, and developers sync content via CLI commands (`cms pull` / `cms push`). In repositories where those files were previously committed, they must also be removed from Git tracking (`git rm --cached`) while keeping them in the working tree.

**Target audience:** Development teams using React-based frameworks (Next.js, Gatsby, Remix, etc.) that rely on Markdown/MDX for content.

**License:** MIT

---

## Scope Summary

This section keeps only the product-scope split for the live product definition.

### MVP

- Schema-based content modeling with explicit schema sync.
- TipTap-based Markdown/MDX editing without real-time collaboration.
- REST API with explicit project/environment routing, draft writes, and publish-as-version semantics.
- SDK, CLI, and Studio as the primary operator surfaces.
- Draft/publish workflow, version history, permissions, and authentication.
- Internationalization, content environments, multi-project support, and reference fields.
- Baseline media upload, media library browsing, and project-scoped media metadata.
- MDX component system and first-party extensibility foundation.

### Post-MVP

- AI integration (`High`) and AI-assisted CMS migration (`High`).
- SEO analysis (`Medium`), scheduled publishing (`Medium`), and comprehensive audit log (`Medium`).
- Advanced media organization, image transformations, CDN controls, asset governance, real-time collaboration (`Medium`), presence awareness (`Medium`), webhooks (`Medium`), full-text search (`Medium`), and bulk operations (`Medium`).
- Schema-aware API filtering (`Low`), third-party plugin sandboxing (`Low`), cursor-based pagination (`Low`), and side-by-side translation view (`Low`).
- Organizations (`Deferred`), multi-tenant SaaS (`Deferred`), and white-label branding (`Deferred`).
