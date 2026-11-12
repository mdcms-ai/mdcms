# AI Integration and MCP Scope Decision Memo

Date: 2026-05-01
Status: Superseded for MCP by `2026-11-11-mcp-and-shared-tools-design.md`. The Studio AI baseline this memo prioritized has shipped.

## Decision

Defer MCP for now. MDCMS already has a public skills pack plus CLI workflows
that cover the highest-value external coding-agent use cases: setup, schema
refinement, document edits, validation, pull, push, and CI automation. MCP may
still become useful later, but it adds protocol, auth, approval, audit, routing,
and tool-filtering complexity before the in-product AI foundation exists.

Focus the next AI work on Studio:

- Inline selection transforms modeled after Apple Intelligence and Notion AI.
- Inline accept/reject/try-again controls at the edited content.
- Document-scoped chat that can propose edits to the current draft and propose
  new draft documents.
- Structured proposals rather than direct model writes.
- MDX component grounding so AI cannot hallucinate unavailable components or
  invalid props.
- SEO and copy-improvement workflows that produce inspectable draft edits.

The canonical product contract is now
`docs/specs/SPEC-014-ai-assisted-studio-editing.md`.

## Current Setup Review

The public skills pack remains the right external-agent baseline:

- `mdcms-content-editing` directs agents to edit local files, validate, and push
  rather than calling the API directly, because `push` preserves manifests,
  hashes, and rename detection.
- `mdcms-content-sync-workflow` covers login, credential precedence,
  pull/push/status, CI automation, `--force`, `--validate`, and `--sync-schema`.
- The skills pack explicitly does not bundle an MCP server, hooks, or subagents.

Local repo state still confirms there is no MDCMS MCP implementation. That is
intentional for the current product direction.

## Deferred Areas to Track

Track these explicitly so they are not forgotten:

1. External-agent MCP integration after the Studio AI baseline.
2. AI-assisted CMS migration workflows after the proposal/audit/eval foundation.
3. AI autocomplete or ghost-text authoring after inline transforms prove useful.
4. AI-assisted schema, environment, or project administration after document
   editing is stable.

## Follow-Up Ticket Shape

Immediate Studio AI work:

1. Studio AI provider and orchestration foundation.
2. Inline Studio AI selection transforms.
3. AI proposal lifecycle and draft apply contracts.
4. Document-scoped Studio AI chat for draft create/edit proposals.
5. MDX component grounding and validation for AI proposals.
6. Studio AI SEO and copy-improvement workflows.
7. Studio AI safety, audit, and evaluation coverage.

Deferred research:

1. Revisit external-agent MCP after Studio AI baseline.
2. Research AI-assisted CMS migration workflows.
3. Research AI autocomplete and ghost-text authoring.

## Sources

Local:

- `docs/specs/SPEC-014-ai-assisted-studio-editing.md`
- `docs/specs/SPEC-001-platform-overview-and-scope.md`
- `docs/specs/SPEC-002-system-architecture-and-extensibility.md`
- `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`
- `docs/specs/SPEC-005-auth-authorization-and-request-routing.md`
- `docs/specs/SPEC-008-cli-and-sdk.md`
- `skills/README.md`
- `skills/mdcms-content-editing/SKILL.md`
- `skills/mdcms-content-sync-workflow/SKILL.md`
- `.ai/memory/product.md`
- `.ai/memory/stack.md`

External context used during the original research pass:

- Model Context Protocol docs: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP Tools spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Anthropic MCP announcement: https://www.anthropic.com/news/model-context-protocol
- Anthropic, Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, Writing effective tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Claude Code MCP docs: https://docs.anthropic.com/en/docs/claude-code/mcp
- OpenAI MCP/connectors docs: https://platform.openai.com/docs/guides/tools-remote-mcp
- OpenAI Codex announcement: https://openai.com/index/introducing-codex/
- ReAct paper: https://arxiv.org/abs/2210.03629
- Toolformer paper: https://arxiv.org/abs/2302.04761
- ToolLLM paper: https://arxiv.org/abs/2307.16789
- SWE-agent paper: https://arxiv.org/abs/2405.15793
