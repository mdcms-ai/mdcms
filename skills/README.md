# MDCMS Skills Pack

Installable AI-agent skills that walk developers through adding MDCMS to a project — from bringing up a self-hosted backend to day-to-day `pull`/`push` automation.

The pack is designed to be installed into any agent environment supported by [skills.sh](https://skills.sh): Claude Code, Cursor, Gemini CLI, Codex, Copilot, OpenCode, and 40+ others.

## Install

The install URL ends in `/skills` so skills.sh only sees the public MDCMS pack — internal repo skills under `.ai/skills/` are not surfaced to consumers.

```bash
# Browse available skills
npx skills add mdcms-ai/mdcms/skills --list

# Install all skills into the current project
npx skills add mdcms-ai/mdcms/skills

# Target a specific agent (default: prompt for agent)
npx skills add mdcms-ai/mdcms/skills -a claude-code

# Install globally (~/.<agent>/skills) so every project sees them
npx skills add mdcms-ai/mdcms/skills -g

# Non-interactive (CI / scripted install)
npx skills add mdcms-ai/mdcms/skills -y
```

The pack is installed into whichever agent directories the user selects (`~/.claude/skills/`, `~/.cursor/skills/`, etc.). All skills work best together because the master skill delegates to each of the focused skills by slug. Installing the whole pack is recommended.

See the [skills.sh CLI reference](https://github.com/vercel-labs/skills) for more options (`--copy`, `--skill`, `--agent`, update/remove commands).

## Skills at a glance

| Skill                                                                   | Purpose                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`mdcms-setup`](./mdcms-setup/SKILL.md)                                 | **Master orchestrator.** Detects repo state and routes to the right focused skill for each phase. Start here. |
| [`mdcms-self-host-setup`](./mdcms-self-host-setup/SKILL.md)             | Stand up the MDCMS backend via Docker Compose. Env, first boot, admin bootstrap.                              |
| [`mdcms-brownfield-init`](./mdcms-brownfield-init/SKILL.md)             | Import an existing Markdown/MDX repo into MDCMS via `mdcms init --non-interactive`.                           |
| [`mdcms-greenfield-init`](./mdcms-greenfield-init/SKILL.md)             | Bootstrap MDCMS in an empty repo with a scaffolded starter.                                                   |
| [`mdcms-schema-refine`](./mdcms-schema-refine/SKILL.md)                 | Add/edit content types, fields, references; `mdcms schema sync`.                                              |
| [`mdcms-studio-embed`](./mdcms-studio-embed/SKILL.md)                   | Mount `<Studio />` at a catch-all route inside the user's host app.                                           |
| [`mdcms-sdk-integration`](./mdcms-sdk-integration/SKILL.md)             | Fetch content in the host app via `@mdcms/sdk`; drafts vs published; SSR.                                     |
| [`mdcms-mdx-components`](./mdcms-mdx-components/SKILL.md)               | Register custom MDX components so Studio preview and host SSR match.                                          |
| [`mdcms-content-editing`](./mdcms-content-editing/SKILL.md)             | Edit, author, translate, and bulk-modify documents. Local vs Studio; validation; new docs; renames.           |
| [`mdcms-content-sync-workflow`](./mdcms-content-sync-workflow/SKILL.md) | Day-to-day `pull`/`push`/login; key rotation; CI automation for publishing.                                   |

## How the skills flow

`mdcms-setup` orchestrates first-time onboarding (the flowchart below). After setup, two skills handle ongoing day-to-day work and trigger directly from common phrasings:

- **`mdcms-content-editing`** — "edit my content", "update a post", "add a page", "translate this", "bulk-edit the tags".
- **`mdcms-content-sync-workflow`** — "push my changes", "pull from MDCMS", "I'm getting 401", "rotate the API key", "add MDCMS to CI".

### Setup flow

```mermaid
flowchart TD
    Start([User: set up MDCMS]) --> Master
    Master[<b>mdcms-setup</b><br/>master — detects state, routes]

    Master --> Q1{Running MDCMS<br/>server reachable?}
    Q1 -- "No" --> SelfHost[<b>mdcms-self-host-setup</b>]
    Q1 -- "Yes / skip" --> Q2
    SelfHost --> Q2

    Q2{Existing Markdown/MDX<br/>content in repo?}
    Q2 -- "Yes — brownfield" --> Brown[<b>mdcms-brownfield-init</b>]
    Q2 -- "No — greenfield" --> Green[<b>mdcms-greenfield-init</b>]

    Brown --> BSchemaQ{Inferred schema<br/>correct?}
    BSchemaQ -- "No / extend" --> BSchema[<b>mdcms-schema-refine</b>]
    BSchemaQ -- "Yes" --> BSDKQ
    BSchema --> BSDKQ
    BSDKQ{Existing code fetches<br/>content from files?}
    BSDKQ -- "Yes" --> BSDK[<b>mdcms-sdk-integration</b><br/>replace file fetching]
    BSDKQ -- "No" --> Converge
    BSDK --> Converge

    Green --> GSchema[<b>mdcms-schema-refine</b><br/>author first models]
    GSchema --> GSDK[<b>mdcms-sdk-integration</b><br/>write new fetching]
    GSDK --> Converge

    Converge[paths converge]

    Converge --> EmbedQ{Want visual editor<br/>in host app?}
    EmbedQ -- "Yes" --> Embed[<b>mdcms-studio-embed</b>]
    EmbedQ -- "No" --> MDXQ
    Embed --> MDXQ

    MDXQ{Custom MDX<br/>components?}
    MDXQ -- "Yes" --> MDX[<b>mdcms-mdx-components</b>]
    MDXQ -- "No" --> Sync
    MDX --> Sync

    Sync[<b>mdcms-content-sync-workflow</b>]
    Sync --> Done([MDCMS integrated])
```

## Assumptions and limitations

- Assumes the current MDCMS CLI contract. The `mdcms init --non-interactive` surface is required and ships with MDCMS `0.1.x+`.
- Skills carry complete code for the Studio embed, MDX component registration and SDK fetching. The code matches the types of the `@mdcms/*` packages released from the same repository state; with older packages, update them or follow the installed types.
- No assumption is made about the user's host framework beyond "React-based". Examples use Next.js App Router because it is the most common target; adapt for Remix, Astro, Vite, etc.
- The pack does not bundle an MCP server, hooks, or subagents. Claude Code users wanting `/slash` command shortcuts or MCP-backed integrations should install the pack alongside any project-specific `.claude/` config.

## Distribution conventions

- Each skill is a directory under this pack named `<slug>/`, containing a single `SKILL.md` with YAML frontmatter (`name`, `description`) and a markdown body.
- Skill slugs are stable and used for cross-references. Renaming a skill is a breaking change for consumers of the pack.
- New skills should follow the patterns already in this pack: pushy description, prerequisites, numbered steps, verification, gotchas, related skills, and a final assumptions/limitations note.

## Updating / removing

```bash
# Update all installed skills to their latest version
npx skills update

# Remove one
npx skills remove mdcms-setup

# Remove everything from this pack
npx skills remove --all --skill 'mdcms-*'
```

See `npx skills --help` for the full command surface.
