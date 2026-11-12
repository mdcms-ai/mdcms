# Initiatives

A file per major team effort — active and completed. Initiatives are bigger than tasks (which live in the issue tracker) and longer-running than features. Examples: a multi-quarter platform migration, an open-source release, a customer-driven SLA push.

## File format

`YYYY-MM-DD-kebab-case-name.md` for the start date.

Each file has these sections:

- **Status:** `active` | `completed` | `paused` | `abandoned`
- **Goal** — one paragraph, what success looks like
- **Why** — the constraint or opportunity that drove this
- **Scope** — in / out, with explicit "out" list
- **Key decisions** — bullets, with cross-refs to ADRs/specs/PRs
- **Outcome** (added when status moves off `active`) — what actually shipped, what lessons came out

Keep each file under ~200 lines. If it grows beyond that, split it into a parent + sub-initiatives.

## Active

- [MCP server and shared agent tools](2026-11-11-mcp-server.md)

## Completed

(none yet)

## Why initiatives instead of just commits + Jira

Jira tickets are scoped tasks. Commits are atomic changes. Neither captures the **why** of a multi-week / multi-month effort, the **scope boundary** that prevents drift, or the **outcomes** in a queryable form. A future agent (or new team member) asking "why did MDCMS adopt X?" gets a better answer from an initiative file than from twenty Jira tickets and forty commits.
