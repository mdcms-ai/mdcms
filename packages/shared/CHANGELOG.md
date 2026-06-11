# @mdcms/shared

## 0.5.0

### Minor Changes

- e873553: Add media asset listing contracts and Studio media library.
- e873553: Add media settings and media asset API contracts.
- 15fdaee: Add media list storage configuration metadata.
- e873553: Add bulk operation input schema and Zod capability validation.
- eb598b2: Add schema file field types under fieldTypes, move references to fieldTypes.reference, and expand file fields to media assets on reads.
- 8d8feb9: Add shared webhook configuration and payload contracts

### Patch Changes

- e873553: Add bulk content operations API and Studio controls

## 0.4.0

### Minor Changes

- a48b9d8: Add content type preview URL resolvers for Studio live preview

## 0.3.1

### Patch Changes

- fe2cf74: Remove AI-generated slop (redundant comments, dead code, gratuitous casts and defensive guards). No behavior change.

## 0.3.0

### Minor Changes

- ec9e435: Add the `delete_document` proposal kind, the `AI_UNSUPPORTED_ACTION` error code, and the request/response Zod schemas for the new `POST /api/v1/ai/chat/messages` endpoint (`aiChatMessageRequestSchema`, `aiChatMessageResponseSchema`, `aiChatAllowedActionSchema`, `aiChatAttachedSelectionSchema`, `aiChatMessageSchema`). These ship as part of CMS-226 to support the global AI assistant chat surface; the wire contract intentionally omits a `batch` proposal kind — multi-doc turns are grouped implicitly per assistant turn on the client.
- 7bb04b7: Add MDX catalog validation to Studio AI chat proposals
- 50ae976: Add built-in MDX primitives and inline style props

### Patch Changes

- 6409863: Studio: post-accept Undo on the chat-assistant Applied banner.

  After Accept succeeds, the 6-second lime banner now exposes a working
  Undo button (and a ⌘Z / Ctrl+Z shortcut scoped to the assistant
  panel). Undo routes through the new
  `POST /api/v1/ai/proposals/:proposalId/undo` endpoint, which fans out
  per proposal kind: soft-delete for `create_document`,
  restore-from-trash for `delete_document`, and a body/frontmatter
  replay for `replace_selection` / `insert_block` /
  `update_frontmatter`. A concurrent edit inside the window fails loud
  with `AI_PROPOSAL_CONFLICT`; outside the window the banner morphs to
  the quiet log line and undo is no longer offered.

  `StudioAiRouteApi` gains `undoProposal`. `StudioAiApplyResult` now
  surfaces `priorDraft` for body/frontmatter kinds so the client can
  echo the captured snapshot back. The AI audit outcome enum gains
  `undone` and `undo_failed`.

## 0.2.0

### Minor Changes

- a81169a: Add AI contract types and Zod schemas (AiProposal, AiProposalKind, AiProposalOperation, AiProposalValidation, AiTaskKind, AI_ERROR_CODES) consumed by the Studio AI provider and orchestration foundation. The orchestrator is built on the Vercel AI SDK, so future provider adapters (Anthropic, OpenAI) plug in through `@ai-sdk/*` packages without changing the public contract.
- 98779f0: Add Studio AI inline selection transforms and proposal lifecycle.

  `@mdcms/shared` exposes the new `ai.use` capability flag in
  `CurrentPrincipalCapabilities`, signalling whether the current
  principal can request AI proposals against the routed
  project/environment.

  `@mdcms/studio` exports `createStudioAiRouteApi`, `InlineAiPanel`,
  `InlineAiBubble`, and `useInlineAiTransform`, providing the client
  surface for the new `/api/v1/ai/inline-transform`,
  `/api/v1/ai/proposals/:id/apply`, and `/api/v1/ai/proposals/:id/reject`
  endpoints. The bubble renders a floating "Ask AI" trigger anchored at
  the editor selection; opening it shows a popover with the action list
  and Accept / Reject / Try again controls, and accept routes the
  proposal through the apply endpoint so the editor draft is updated
  through normal content draft mutation semantics.

  Inline transforms are scoped to selection-anchored copy edits per
  SPEC-014: rewrite, shorten, expand, change_tone, fix_grammar,
  improve_clarity. Frontmatter (SEO) suggestions and MDX component
  insertion live on other surfaces (the document properties panel and
  the slash menu / chat respectively).

## 0.1.5

### Patch Changes

- 82b5fbd: Reduce the Studio runtime bundle size by keeping Node-side MDX prop extraction out of the browser runtime and emitting optimized production runtime assets.

## 0.1.4

### Patch Changes

- d10a004: Make default CLI logs user-friendly and move internal runtime diagnostics behind --verbose mode.

## 0.1.3

### Patch Changes

- 0143cf5: Group localized Studio content lists by translation group.
