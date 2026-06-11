# @mdcms/studio

## 0.5.0

### Minor Changes

- eb598b2: Add schema file field types under fieldTypes, move references to fieldTypes.reference, and expand file fields to media assets on reads.

### Patch Changes

- e873553: Add media asset listing contracts and Studio media library.
- e873553: Add Studio media upload settings UI.
- e873553: Add media settings and media asset API contracts.
- e873553: Add Studio editor media upload insertion.
- e873553: Add bulk content operations API and Studio controls
- e873553: Add bulk operation input schema and Zod capability validation.
- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [15fdaee]
- Updated dependencies [e873553]
- Updated dependencies [e873553]
- Updated dependencies [eb598b2]
- Updated dependencies [8d8feb9]
  - @mdcms/shared@0.5.0

## 0.4.0

### Minor Changes

- a48b9d8: Add content type preview URL resolvers for Studio live preview

### Patch Changes

- Updated dependencies [a48b9d8]
  - @mdcms/shared@0.4.0

## 0.3.2

### Patch Changes

- f32f438: Fix Studio rendering for lowercase intrinsic MDX text elements

## 0.3.1

### Patch Changes

- fe2cf74: Remove AI-generated slop (redundant comments, dead code, gratuitous casts and defensive guards). No behavior change.
- 89ccd9e: Render lowercase MDX/HTML elements as structured Studio blocks.
- Updated dependencies [fe2cf74]
  - @mdcms/shared@0.3.1

## 0.3.0

### Minor Changes

- ec9e435: Add the chat surface client APIs that pair with `POST /api/v1/ai/chat/messages` and the new content-list endpoint used by the assistant's `@`-mention picker. New public surface on `@mdcms/studio`:
  - `StudioAiRouteApi.chatMessage(input)` and the `StudioAiChatMessageRequest` / `StudioAiChatMessageResult` / `StudioAiChatMessage` / `StudioAiChatAttachedSelection` / `StudioAiChatAllowedAction` types.
  - `StudioAiProposal` extended with the `delete_document` kind (new `StudioAiProposalOperation` variant with `path` + optional `reason`).
  - `StudioDocumentRouteApi.listContent({ q?, type?, limit?, offset?, signal? })` returning the standard `ApiPaginatedEnvelope<ContentDocumentResponse>` shape.

- f9c445d: Add streaming + markdown rendering to the chat surface client APIs.
  - `StudioAiRouteApi.chatMessageStream(input)` opens an SSE connection against `POST /api/v1/ai/chat/messages/stream` and returns an `AsyncIterable<StudioAiChatStreamEvent>` that yields `text-delta`, `done`, and `error` events as the model produces them.
  - New `StudioAiChatStreamEvent` discriminated-union export covers the wire-shape of each SSE event the client can observe.
  - New runtime dependency on `streamdown` (v2.5.0). The chat panel now uses it under the hood to render assistant prose as markdown — headings, fenced code (shiki highlighting), GFM tables, task lists, links, etc. Streaming-aware: `parseIncompleteMarkdown` keeps mid-stream chunks from leaking unclosed `**`/```` fences while a token batch is in flight.

- 7bb04b7: Add MDX catalog validation to Studio AI chat proposals
- 50ae976: Add built-in MDX primitives and inline style props
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

### Patch Changes

- 0ba1039: Preserve raw lowercase MDX islands in Studio previews.
- 4052b90: Clean up `react-doctor` warnings in `@mdcms/studio`: score 66 → 84.

  Internal-only changes; no behaviour changes to the published surface. Highlights:
  - Workspace `tsconfig.base.json` bumped to ES2023 to unblock `Array.prototype.toSorted`.
  - Mechanical sweeps: `toSorted` over `[...arr].sort()`, `flatMap` over `map().filter()`, ES2023 length-check shape, hoisted `EMPTY_BREADCRUMBS`, SVG `d` decimals truncated to two places, label `htmlFor`/id associations, redundant `role="navigation"` removed, `Promise.all` for independent awaits, `gap-y` over `space-y` on flex children, action-named button labels.
  - React 19: `useContext(X)` migrated to `use(X)` across context modules.
  - `proposal-card.tsx`: removed prop-mirroring `useState`/`useEffect` pattern; the reject panel now opens via local override `OR rejecting` prop, eliminating the stale first-render.
  - `settings-page.tsx`: API-keys table renders dates through a `formatClientDate` helper and a client-mounted `ApiKeyStatusBadge` to avoid SSR/CSR locale + clock hydration mismatches. `api-key-create-dialog.tsx`: `min` date attr is now set after mount.
  - Render-in-render extractions: `ContentCardGrid`/`ContentTypeCard`, `RetryButton`, `SchemaKindChip`/`SchemaConstraintFlags`, `ReadyMdxPropsEditor`/`AutoFormFieldControl`, `RouteContent`, `RowActions` (content/[type]), `TrashRowActions`.
  - Login page: SSO state collapsed into a single discriminated-union state to remove the cascading two-`setState` effect.
  - `studio-component.tsx` and `mdx-component-node-view.tsx`: documented the two intentional `dangerouslySetInnerHTML` sites inline.
  - Added `packages/studio/knip.json` describing the two-tier runtime bundling so knip stops false-flagging `runtime-ui/**` as unused.

  API rename inside the package: `renderReadyMdxPropsEditor` → `ReadyMdxPropsEditor` (the prior name was not exported from `src/index.ts`, so consumers outside the package are unaffected).

- 24d19d2: Use the MDX parser stack for Studio markdown parsing
- 14193e3: Harden raw JSX previews and assistant request ownership
- Updated dependencies [ec9e435]
- Updated dependencies [7bb04b7]
- Updated dependencies [50ae976]
- Updated dependencies [6409863]
  - @mdcms/shared@0.3.0

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [a81169a]
- Updated dependencies [98779f0]
  - @mdcms/shared@0.2.0

## 0.1.6

### Patch Changes

- 82b5fbd: Reduce the Studio runtime bundle size by keeping Node-side MDX prop extraction out of the browser runtime and emitting optimized production runtime assets.
- Updated dependencies [82b5fbd]
  - @mdcms/shared@0.1.5

## 0.1.5

### Patch Changes

- e77088f: Add a System/Light/Dark theme picker in the admin header, default the Studio theme to System so it follows the OS preference, and theme the bootstrap loading shell (`Loading Studio`) so it resolves from `localStorage` + `prefers-color-scheme` instead of always rendering light. `StudioShellFrame` gains an optional `shellTheme` prop (defaulted to `"light"`, non-breaking).

## 0.1.4

### Patch Changes

- c800ac8: Visual refresh for Studio runtime bundle loading screen
- 38932fc: Clarify wrapper MDX component editing in Studio and align bundled examples with the current Callout prop contract.
- a1bae03: Preserve the missing-token Studio error state and add follow-up token auth coverage.
- Updated dependencies [d10a004]
  - @mdcms/shared@0.1.4

## 0.1.3

### Patch Changes

- 0143cf5: Group localized Studio content lists by translation group.
- Updated dependencies [0143cf5]
  - @mdcms/shared@0.1.3
