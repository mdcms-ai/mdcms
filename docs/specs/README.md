# MDCMS Spec Catalog

This catalog owns the live product and subsystem specifications for MDCMS. Contracts remain spec-owned in v1; there is no separate contracts catalog.

## Ownership Rules

- Each live behavior or contract has one owning spec under `docs/specs/`.
- If multiple specs mention the same behavior or contract, the owner named in this catalog wins and non-owning mentions are informative only.
- Each owning spec is authoritative for the endpoint contracts it owns.
- Within an owning spec, the endpoint contract table is normative; if surrounding prose in the same spec conflicts with the contract table, the contract table wins.
- ADRs under `docs/adrs/` capture the decision rationale but do not replace the owning spec for normative behavior.
- `SPEC-005` owns the shared HTTP contract template used by all endpoint tables.

## Spec Catalog

| ID       | Title                                                                                                  | Owns                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| SPEC-001 | [Platform Overview and Scope](./SPEC-001-platform-overview-and-scope.md)                               | Overview, product scope, and MVP/Post-MVP summary                                                    |
| SPEC-002 | [System Architecture and Extensibility](./SPEC-002-system-architecture-and-extensibility.md)           | Architecture, module model, action catalog, package structure, and extensibility endpoints           |
| SPEC-003 | [Content Storage, Versioning, and Migrations](./SPEC-003-content-storage-versioning-and-migrations.md) | Content storage model, content API, version history, conflict handling, and migrations               |
| SPEC-004 | [Schema System and Sync](./SPEC-004-schema-system-and-sync.md)                                         | Schema definitions, overlays, sync behavior, and schema registry endpoints                           |
| SPEC-005 | [Auth, Authorization, and Request Routing](./SPEC-005-auth-authorization-and-request-routing.md)       | Shared HTTP boundary, auth, request routing, authorization scoping, and auth-related endpoints       |
| SPEC-006 | [Studio Runtime and UI](./SPEC-006-studio-runtime-and-ui.md)                                           | Studio delivery contract, embedding model, UI behavior, project switching, and runtime endpoints     |
| SPEC-007 | [Editor, MDX, and Collaboration](./SPEC-007-editor-mdx-and-collaboration.md)                           | Editor engine, MDX component system, and collaboration endpoints/architecture                        |
| SPEC-008 | [CLI and SDK](./SPEC-008-cli-and-sdk.md)                                                               | SDK behavior plus CLI workflows and action runner                                                    |
| SPEC-009 | [i18n and Environments](./SPEC-009-i18n-and-environments.md)                                           | Localization, project/environment hierarchy, environment model, and environment management endpoints |
| SPEC-010 | [Media, Webhooks, Search, and Integrations](./SPEC-010-media-webhooks-search-and-integrations.md)      | Media management, webhooks, and search                                                               |
| SPEC-011 | [Local Development and Operations](./SPEC-011-local-development-and-operations.md)                     | Docker Compose stack and local developer workflow                                                    |
| SPEC-013 | [Mintlify Documentation Site](./SPEC-013-mintlify-docs-site.md)                                        | `apps/docs` documentation site: design system mapping, information architecture, and page inventory  |
| SPEC-014 | [AI-Assisted Studio Editing](./SPEC-014-ai-assisted-studio-editing.md)                                 | In-product Studio AI assistance, inline AI transforms, document chat, proposal lifecycle, and safety |
