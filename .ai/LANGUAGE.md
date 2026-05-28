# MDCMS vocabulary

Use these terms exactly. Do not coin synonyms. If a needed concept is missing, add it here in the same change that introduces it to the code.

## Domain terms

| Term             | Meaning                                                                            | Don't say                   |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------- |
| **Document**     | A single piece of editable content (a row in `documents`)                          | entry, item, record, post   |
| **Content type** | A schema definition for documents (e.g. `BlogPost`)                                | model, collection, kind     |
| **Field**        | A typed property on a content type                                                 | column, attribute, property |
| **Reference**    | A field whose value points to another document                                     | relation, link, fk          |
| **Project**      | A top-level isolation boundary (a tenant)                                          | workspace, org, site        |
| **Environment**  | A named state within a project (e.g. `draft`, `prod`)                              | branch, stage               |
| **Locale**       | A language/region pair on a translatable document                                  | language, i18n target       |
| **Schema**       | The combined typed surface (content types + fields) for a project                  | config, definition          |
| **Module**       | A first-party or third-party extension that mounts server, CLI, or Studio surfaces | plugin, addon, extension    |
| **Manifest**     | A module's declaration file (`manifest.ts`)                                        | descriptor, config          |

## Operations

| Term            | Meaning                                                              | Don't say                        |
| --------------- | -------------------------------------------------------------------- | -------------------------------- |
| **Pull**        | Fetch documents from server to local files (CLI direction)           | download, sync down, fetch       |
| **Push**        | Upload local file changes to server                                  | upload, sync up, deploy          |
| **Sync**        | Two-sided reconciliation (push + pull with conflict resolution)      | use only when actually two-sided |
| **Publish**     | Move a draft document to the published environment                   | release, ship                    |
| **Schema sync** | Reconcile local `mdcms.config.ts` schema with server schema registry | schema migrate, schema deploy    |

## Authorization

| Term                    | Meaning                                                                               | Don't say                           |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| **API key**             | Long-lived bearer token for non-interactive clients                                   | token, secret                       |
| **Session**             | Browser-based interactive auth                                                        | cookie, login                       |
| **Loopback OAuth flow** | CLI's browser-based auth handoff using OAuth2 with a localhost callback (`127.0.0.1`) | device flow, OAuth flow, login flow |
| **Scope**               | A permission claim attached to a key or session                                       | permission, role, capability        |

## Codebase shape

| Term                          | Meaning                                                               | Don't say                                                 |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| **Workspace**                 | A Bun + Nx package in the monorepo                                    | project (overloaded), package (use only for npm packages) |
| **`@mdcms/source` condition** | Custom export condition that resolves to TypeScript source for dev    | source export, dev export                                 |
| **Studio**                    | The embeddable React component (`@mdcms/studio`)                      | admin UI, dashboard, panel                                |
| **Studio review**             | `apps/studio-review` — internal contract-consumer for preview mocks   | studio test, review app                                   |
| **Built-in MDX component**    | MDCMS-provided MDX component auto-injected into the local MDX catalog | primitive, basic component                                |

## Forbidden

- "Entry" — always use **document**.
- "Workspace" when referring to **project** — they're different concepts. ("Workspace" is fine when referring to a Bun + Nx package in the monorepo.)
- "Plugin" when referring to a first-party **module** — modules are first-class. (Third-party concepts that genuinely call themselves plugins, e.g. TipTap plugins, can keep that name.)
- "Device flow" for the CLI auth handoff — it is a **loopback OAuth flow** (RFC 8252), not RFC 8628 device authorization grant.
