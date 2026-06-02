---
status: live
canonical: true
created: 2026-05-01
last_updated: 2026-05-22
---

# SPEC-014 AI-Assisted Studio Editing

This spec owns in-product AI assistance for Studio document authoring and
editing. It does not define external-agent MCP integration, AI-assisted
migrations, or schema authoring automation.

## Product Scope

AI assistance in Studio is a bounded editing aid. It helps users create and
revise draft documents while preserving MDCMS's existing content invariants:
schema validation, MDX component validation, explicit draft writes, optimistic
concurrency, authorization, and normal publish separation.

The first product scope includes:

- Inline AI transforms for selected editor content.
- A global AI assistant surface that can propose draft document edits, create
  new draft documents, and propose draft document deletions across the
  caller's authorized routing context.
- Copy-improvement workflows such as rewrite, shorten, expand, change tone, fix
  grammar, and improve clarity.
- SEO-improvement workflows that produce actionable frontmatter edits, surfaced
  from the document properties panel rather than the inline editor.
- MDX-aware generation that can use only registered components and valid props,
  invoked from the editor slash menu, the toolbar Insert Component affordance,
  or document chat.

The first product scope excludes:

- Autocomplete or ghost-text generation while typing.
- External-agent MCP integration.
- AI-assisted migrations and import transforms.
- Schema, environment, project, role, or provider configuration changes through
  chat.
- Publish, unpublish, restore, or environment promotion actions through AI.
  Document deletion is permitted as a structured proposal that the user must
  explicitly accept (see the `delete_document` proposal kind below); other
  destructive lifecycle actions remain out of scope.

## User Experience

### Inline Selection Transforms

Users can select text in the editor and invoke an AI action from an inline
editor affordance. Supported actions are scoped to **selection-anchored copy
edits** that rewrite the selected text in place: rewrite, shorten, expand,
change tone, fix grammar, and improve clarity.

The selection is treated as **markdown**, not plain text. When the user selects
content that spans block-level structure (bullet lists, ordered lists,
headings, blockquotes, multiple paragraphs), Studio sends the markdown
serialization of the selected slice and the model's replacement is interpreted
as markdown. Block structure is preserved on apply and on reject. Plain prose
selections degenerate into trivial markdown (no special tokens) without a
separate code path.

Other AI workflows do not belong in the inline panel:

- **Frontmatter (SEO) edits** are surfaced from the document properties panel,
  not from an editor selection. The underlying `seo_improvement` task is reused
  there.
- **MDX component insertion** is a block-level operation reachable from the
  editor's slash menu, the toolbar's Insert Component affordance, and from
  document chat. It is not a transform of the current selection.

The result renders inline at the selection location as a proposed replacement,
not as a committed draft write. The proposed replacement has visible controls:

- `Accept` applies the proposal to the local editor state and then persists the
  accepted proposal through the proposal apply endpoint; Studio updates local
  editor state from the successful draft response.
- `Reject` discards the proposal and keeps the original selection.
- `Try again` requests a replacement using the same action and current context.

Inline proposals must stay anchored near the source selection. Studio must not
move selection-based proposals into a separate suggestion queue.

### Global Assistant

Studio provides a persistent, global AI assistant surface for authoring
assistance. The assistant is not scoped to a single document: it crosses
documents within the caller's project and environment, persists conversation
history across navigation, and may attach more than one document to a thread.

The assistant is allowed to answer questions about any document the caller can
read, propose edits to draft documents, propose new draft documents of existing
content types, and propose deletions of draft or unpublished documents. A
single assistant turn may produce multiple related proposals across multiple
documents; the Studio surface groups them implicitly per assistant turn under a
shared Accept all / Reject all footer and applies each child via the
per-proposal apply route. Multi-document turns are best-effort: a partial
failure leaves successfully-applied children in place and reports the per-child
errors to the user.

The assistant is not a general administration console. It cannot change
schemas, environments, projects, roles, API keys, modules, provider settings,
or publish state. Publish, unpublish, restore, and environment promotion
remain out of scope. Document deletion is in scope only via the
`delete_document` proposal kind, which is mediated by the same accept/reject
lifecycle as every other proposal kind.

The assistant surface presents:

- A persistent right-side rail that can expand into a fullscreen workspace
  while the editor remains visible behind the chat in the rail state and is
  hidden in the fullscreen state.
- In rail state, the assistant width is user-resizable from its left edge. The
  rail defaults to 420px, is bounded to a usable range, and Studio reserves the
  same width on the main editor area so content does not slide underneath the
  chat. The chosen rail width is persisted with the assistant's local thread
  state for the active project and environment. Fullscreen mode ignores the
  rail width and continues to occupy the available Studio workspace.
- A thread list with conversation persistence across navigation.
- A composer that auto-attaches the active document and any current editor
  selection as removable context chips.
- While a chat turn is pending, the composer remains editable so the user can
  draft the next message. Studio must block sending that draft until the
  pending turn completes or is stopped; the pending affordance remains Stop,
  not Send.
- If the provider or model fails after the streaming response has opened, the
  server must send a terminal SSE `error` event, emit a non-success audit record
  for the turn, and Studio must render that error in the assistant thread. A
  stream failure must never be audited or displayed as a succeeded turn.
- One proposal card per generated proposal, rendered inline in the assistant
  thread next to the model turn that produced it.

When a current editor selection is attached to a chat turn, Studio serializes
the selection with the same markdown rules as inline transforms. Complete block
selections include their markdown markers (for example list bullets); partial
in-block selections remain plain text. Selection edit proposals are anchored to
this server-trusted attached selection, not to a model-recreated copy of the
selected text.

When the assistant proposes a content change, Studio renders the change as a
draft proposal with explicit accept/reject controls. The proposal card shows
the target document path, locale, kind chip, and a unified diff: removed lines
(`−`) above added lines (`+`), with insert/create proposals rendered as a
single-sided `+N / −0` diff. Single-suggestion turns expand the diff by
default; multi-proposal turns collapse all rows by default and let the user
expand individual rows inline. Create-document proposals additionally show
frontmatter and a body preview when present.

Chat-generated proposals that fail validation are auto-rejected by the server
before they are returned to Studio. The assistant receives the validation
errors as a tool result and gets one correction attempt in the same chat turn.
If the correction also fails validation, Studio receives no actionable proposal
card for that failed change; the assistant should explain the failure in text.

Inline-transform proposals that fail validation show the diff plus a list of
validation errors below it and disable Accept until the user retries or edits
manually.

While a chat turn is pending, Studio shows bounded progress events streamed
from the server. These events may say that the model is thinking, name the
tool it is calling, report whether a proposal tool queued or rejected a
proposal, and show per-step token usage when the provider reports it. Progress
events must not expose hidden chain-of-thought or raw tool arguments; they are
status summaries only.

During a pending streaming turn, Studio renders assistant text and progress
events in the same chronological order in which the stream emits them. A run of
progress events that occurs between two assistant text runs is rendered between
those text runs, not gathered below the whole assistant message. When later
assistant text or proposal content appears after a progress run, Studio
auto-collapses that earlier run into a summary row that names the number of
tool calls or progress updates and can be expanded to inspect the individual
status rows. The current trailing progress run remains expanded while the
pending turn is still active.

Rejecting a proposal does not silently discard the model's turn. Reject opens
an inline feedback textarea on the card; the user types what should change and
submits. Studio sends the original proposal id, the user's feedback, and the
prior assistant turn back to the chat endpoint, which generates a new proposal
and replaces the rejected card. There is no per-card "Try again" button.

### Proposal Handling

AI output is always mediated through proposals:

1. User invokes an inline action or sends a document chat message.
2. Server creates one or more proposals.
3. Studio renders the proposal with validation status and accept/reject
   controls.
4. User explicitly accepts a proposal.
5. Server applies the accepted proposal as a draft write if validation passes
   and the proposal still has an unambiguous live target. For
   `replace_selection`, a changed draft revision is not by itself a conflict:
   apply may proceed when the operation's `originalText` still appears exactly
   once in the current draft body. Proposal kinds without an exact source-text
   replacement anchor continue to require the live draft revision to match the
   proposal's base revision.
6. Studio reconciles local editor state from the accepted draft response.

Rejecting a proposal has no content side effects. Proposals expire after a short
server-defined lifetime and may also become stale when a draft revision changes.

### Post-Accept Undo Window

After a proposal is successfully applied, Studio offers a bounded undo window
and keeps the accepted proposal available as an expandable, read-only history
detail. The window is the only opportunity to revert an applied proposal
through the AI surface; once it expires, restore must go through the normal
version history and trash endpoints.

Window behaviour:

- The window is **6 seconds** long, opens when the apply endpoint returns
  success, and is per-proposal (each accepted proposal opens its own window).
- During the window, Studio renders an `Applied` banner with a visible
  countdown and an `Undo` affordance above the read-only applied-change
  details. Accept and reject controls are removed after apply.
- Hovering the banner pauses the countdown. Hiding the tab pauses the
  countdown. Reloading the page inside the window resumes the remaining time;
  reloading after the window expires lands directly in the past-tense
  log-line state.
- The keyboard shortcut `⌘Z` on macOS or `Ctrl+Z` on other platforms triggers
  undo on the most recent still-open window when focus is inside the assistant
  panel. Outside the assistant panel the shortcut falls through to the
  surrounding editor or browser default.
- When the window expires, the banner morphs into a quiet past-tense log line,
  the undo affordance is no longer offered, and the applied-change details
  remain expandable for chat history review.

Undo is routed through a single dedicated endpoint
`POST /api/v1/ai/proposals/:proposalId/undo` that the client invokes with
the proposal body, the post-apply `documentId`, and any per-kind payload
returned in the apply response. The server fans out to the appropriate
content-store mutation, enforces the per-kind authorization scope, and
emits the paired audit record. This keeps audit emission in one place and
removes any reliance on the client coordinating multiple round trips.

Undo by proposal kind:

| Kind                                                      | Server-side action invoked through the undo endpoint                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_document`                                         | Soft-delete the newly created document (same mutation as `DELETE /api/v1/content/:documentId`).                                                |
| `delete_document`                                         | Restore the soft-deleted document (same mutation as `POST /api/v1/content/:documentId/restore` with `targetStatus=draft`).                     |
| `replace_selection`, `insert_block`, `update_frontmatter` | Replay the pre-apply draft snapshot (same mutation as `PUT /api/v1/content/:documentId`) using the `priorDraft` payload returned by the apply. |

To make body/frontmatter undo possible without storing state server-side,
the apply endpoint captures the pre-apply draft state at the moment of
write and returns it on the success response as
`priorDraft: { body, frontmatter }` for the three edit kinds. The client
echoes that payload back on the undo call.

Undo authorization mirrors the action being reverted:

- `create_document` undo requires `content:delete`.
- `delete_document` undo requires `content:write` (the existing restore
  authorization).
- Edit-kind undo requires `content:write`.

Undo emits its own audit record with `outcome: undone` referencing the
original proposal id and target `documentId`. Apply and undo therefore form a
paired audit trail.

Concurrent edits within the undo window are handled by failing loud: if the
draft revision has advanced past the post-apply revision the apply produced,
the undo request returns `AI_PROPOSAL_CONFLICT` (`409`) and the banner shows
an inline error. The user retains the option to restore through normal
version history.

Out of scope for this window:

- Persisting an undo affordance beyond the 6-second window. Recovery after
  the window goes through the content API restore endpoints defined in
  `SPEC-003`.
- Partial undo of multi-proposal turns. Each accepted child opens its own
  independent undo window.

## Context Model

The server, not the browser, owns AI context assembly. Browser requests provide
the user intent, selected text or target document, and optional action
parameters. The server resolves target-scoped context using the caller's
authorization.

Allowed context:

- Current draft document body and frontmatter when the caller can read drafts.
- Current content type schema and field metadata.
- Current locale and path.
- Selected text or block range.
- Nearby editor context needed to produce a coherent replacement.
- Registered MDX component catalog metadata supplied through the Studio host
  bridge and normalized into serializable component names, prop schemas, prop
  hints, built-in provenance, and child-content rules. The catalog includes
  MDCMS built-ins (`Box`, `Text`, `Image`, `Link`) even when the host app does
  not register them.
- Action-specific instructions for copy, SEO, MDX component insertion, or
  document creation workflows.

The active draft body and attached selection are serialized to the model as
raw markdown/MDX bounded by explicit content markers. MDCMS does not entity
escape `<`, `>`, or `&` inside those content blocks, because the model must be
able to copy exact MDX component syntax back into proposal operations.
Prompt-control content such as the current user message, conversation history,
project knowledge, and referenced-document excerpts remains escaped or
summarized so document text cannot create new prompt sections.

Disallowed context:

- Documents outside the caller's project/environment routing context.
- Drafts the caller cannot read.
- Provider secrets, API keys, session cookies, or credential-store values.
- Unbounded repository source code.
- Schema or environment mutation authority.

## Structured Proposals

AI providers must not return unstructured final content directly into the draft.
The orchestration layer converts model output into structured proposal objects.

```typescript
export type AiProposalKind =
  | "replace_selection"
  | "insert_block"
  | "update_frontmatter"
  | "create_document"
  | "delete_document";

// NOTE — historical `batch` kind retired: multi-document turns return
// N individual proposals on one assistant message. The Studio chat
// surface groups them implicitly per assistant turn (one shared Reject
// all / Accept all (N) footer scoped to that message). Apply / reject
// stay per-proposal — the client iterates over the message's
// `proposals[]` and calls the existing single-proposal apply route
// once per child. Multi-document atomicity is therefore best-effort:
// partial-failure recovery is the caller's responsibility.

export type AiProposal = {
  proposalId: string;
  kind: AiProposalKind;
  project: string;
  environment: string;
  documentId?: string;
  baseDraftRevision?: number;
  type: string;
  locale: string;
  summary: string;
  operations: AiProposalOperation[];
  validation: AiProposalValidation;
  expiresAt: string;
};

export type AiProposalOperation =
  | {
      op: "replace_selection";
      selectionId: string;
      // Markdown serialization of the original selection slice. Apply
      // matches this against the persisted draft body (which is also
      // markdown), so the two must round-trip through the same
      // serializer.
      originalText: string;
      // Markdown the model returns as the replacement. May contain
      // block-level structure (lists, headings, paragraphs) when the
      // original selection did, in which case structure is preserved.
      replacementText: string;
    }
  | {
      op: "insert_block";
      afterSelectionId?: string;
      bodyMdx: string;
    }
  | {
      op: "update_frontmatter";
      patch: Record<string, unknown>;
    }
  | {
      op: "create_document";
      path: string;
      format: "md" | "mdx";
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | {
      op: "delete_document";
      // The path is included for symmetry with `create_document`; the
      // server resolves it against `documentId` and rejects mismatches.
      path: string;
      // Free-text rationale produced by the model. Surfaced in the
      // proposal card and recorded in the audit event but never used
      // for authorization.
      reason?: string;
    };

export type AiProposalValidation =
  | { status: "valid"; checks?: { label: string; ok: true }[] }
  | {
      status: "invalid";
      errors: {
        code: string;
        message: string;
        path?: string;
      }[];
    };
```

Multi-document turns: there is no `batch` wire kind. When an assistant
message produces N proposals (`proposals.length > 1`), each is a standalone
single-operation proposal. The client groups them under a shared
`Reject all / Accept all (N)` footer and applies each child via the
per-proposal apply route. Validation, expiry, and conflict semantics are
per-child; there is no all-or-nothing transactional apply.

The `delete_document` kind targets a single draft or unpublished document
identified by `documentId`. Deletion proposals must not target documents that
have a published version; published documents must first be unpublished
through the normal content endpoints (publishing remains outside AI scope).
Validation surfaces inbound link checks, published-version checks, and any
project-level deletion guards as `validation.checks` entries on success or
as `validation.errors` on failure.

The implementation may store proposals server-side or encode them in signed
proposal tokens, but clients must treat proposal identifiers as opaque.

## Model Grounding

The chat assistant grounds the model in real project data via three layers:

**System prompt context (injected per turn):**

- Content type catalog (names + per-type schema with field kinds, required flags, reference targets, enum options).
- Supported locales for the project.
- Current user identity (name + id).

**Tools (model-callable lookups):**

- `find_entries({ type, query?, locale?, limit? })` — search documents by type. The
  `type` parameter is enum-constrained to the project's registered content types,
  so the model cannot query for types that don't exist.
- `get_entry({ documentId })` — fetch full body + frontmatter for a specific doc.
- `get_component_reference({ componentName })` — fetch a Studio-host-rendered
  reference snapshot for a registered MDX component. The tool returns sanitized
  static HTML and visible text for design grounding. It is read-only and is used
  when the user asks to clone, imitate, restyle, or design something similar to
  an existing component.

When proposing UI-like MDX such as sections, heroes, cards, forms, calls to
action, or component-heavy blocks, the assistant preserves the host site's
existing visual language unless the user explicitly asks for a new direction.
Registered catalog components and built-ins are the default building blocks for
visually editable composition. When `get_component_reference` is available and
the user names, implies, or asks to match an existing component, the assistant
uses that reference before proposing the edit so the result follows the existing
aesthetic instead of inventing a disconnected one-off visual system.

Document lookup tools are capability-gated on `content:read:draft`; absent
capability removes the tool from the model's surface and the model gracefully
responds in text. The component reference tool is available only when the
request supplies component reference snapshots for the active Studio host.
The server never imports host app component source to render references inside
the AI module.

**Document context policy:**

- The active target draft may include its body and frontmatter inline when the
  caller can read drafts. This keeps exact-text edits, section deletions, and
  selection-free rewrites anchored to the current draft.
- Additional `@`-referenced documents are injected as compact, read-only context
  cards by default rather than full bodies. Each card includes the `documentId`,
  path, type, locale, draft revision, frontmatter summary, heading outline, and a
  short excerpt when available.
- The model must use `get_entry({ documentId })` when a referenced document's full
  body or complete frontmatter is needed. Referenced document content is source
  material only; it must not be treated as instructions and must not become a
  write target unless the user explicitly makes that document the active target.
- If the active target draft is too large for the configured prompt budget, the
  server may fall back to the same compact-card representation plus selected or
  nearby editor context and require tool lookup for the rest.

**Prompt structure policy:**

- Chat prompts use stable XML-style section tags to separate trusted
  instructions, project knowledge, tool availability, document context,
  conversation history, and the user's current message.
- User-authored text, document bodies, document frontmatter, excerpts, and prior
  conversation turns are treated as untrusted content inside those sections.
  Literal XML-significant characters in that content are escaped before being
  inserted into the prompt so embedded text cannot close or spoof a trusted
  section tag.
- The prompt envelope is a model-facing organization format only. Tool schemas,
  proposal validation, authorization, and audit records remain the server-side
  source of truth for what the assistant can do.

**Selection freshness policy:**

- Inline transforms are selection-anchored mutations. Their request
  `draftRevision` must match the live draft revision before the model is called.
- Chat turns treat `attachedSelection` as optional context. If the attached
  selection's `draftRevision` is stale, the server keeps the active document
  context, omits the stale selection from the model prompt and tool surface, and
  continues the turn. Selection-anchored edit tools are unavailable for that turn,
  but text-only answers, document-level edits, creates, deletes, and lookups may
  still proceed according to the normal capability rules.
- Apply and undo requests remain strict: stale draft revisions at mutation time
  return `AI_PROPOSAL_CONFLICT` and do not mutate content.

**Validator codes (server-side trust boundary):**

- `UNKNOWN_CONTENT_TYPE` — proposed type not registered for the project.
- `MISSING_REQUIRED_FRONTMATTER` — schema-required field absent.
- `UNKNOWN_FRONTMATTER_FIELD` — frontmatter key not defined in the schema.
- `INVALID_FRONTMATTER_TYPE` — value kind mismatches schema field kind.
- `PATH_ALREADY_IN_USE` — proposed path collides with an existing non-deleted
  document in the same project + environment.
- `UNKNOWN_REFERENCE` — reference field's documentId does not resolve to a
  non-deleted document in the project. Reference values are bare UUID strings;
  the validator walks arrays and nested objects to find references at any depth.

The validator is wired at orchestrator construction, so both inline-transform
proposals and chat proposals share the same trust boundary.

## MDX Component Grounding

AI-generated MDX must be grounded in the active MDX component catalog.

Rules:

- Generated component names must exist in the active catalog.
- Generated props must validate against the component's extracted prop metadata
  and any author-provided prop hints.
- Required props must be present.
- Unknown props are rejected unless the component metadata explicitly permits
  passthrough props.
- Wrapper components must follow their declared child-content rules.
- Studio must show validation failures before the user can accept a proposal.
- Built-in components marked with `builtIn: true` are valid output. The flag
  does not create different validation semantics; it only distinguishes
  MDCMS-provided components from host-registered components for Studio
  discoverability.
- Lowercase intrinsic MDX/HTML elements are valid MDX output. They are not
  catalog components, so the catalog validator does not require them to be
  registered. When Studio can parse their attributes, they render as structured
  intrinsic element blocks with editable children rather than raw HTML preview
  text. The assistant should prefer catalog components and built-ins when the
  user asks for common visual composition, and use raw intrinsic HTML only when
  the requested result needs native HTML semantics such as forms or inputs.
- Inline styles are valid only through first-class `style` props. Style values
  must be flat objects whose values are strings or numbers.

The chat request carries the active catalog as a serializable `mdxCatalog`
snapshot. The server uses that snapshot as validation input for proposals in
the same turn; it must not persist the catalog as backend-owned project state.

Invalid MDX proposals are never silently repaired on apply. The user may request
another proposal or edit manually.

Valid inline style example:

```mdx
<Box style={{ padding: "24px", backgroundColor: "#fff" }}>Content</Box>
```

AI must not generate `className`, CSS strings, nested style objects, hover
styles, responsive breakpoints, selectors, event handlers, or JavaScript
functions in MDX props.

## SEO Assistance

SEO assistance is a document-editing workflow, not a separate search or
analytics product in this spec.

The first SEO workflow may inspect and propose edits for:

- title and description-style fields when present in the content type schema
- headings
- intro clarity
- excerpt quality
- keyword/topic coverage provided by the user
- internal link opportunities when linkable context is explicitly available

SEO suggestions that change content follow the same proposal lifecycle as other
AI edits. SEO scoring may be shown as supporting context, but score changes
must not be the only success signal; proposed edits must remain inspectable.

## Authorization and Safety

AI endpoints require explicit project/environment routing and obey the shared
HTTP boundary in `SPEC-005`.

Minimum scopes:

- Generating proposals for an existing draft requires `ai:use` and
  `content:read:draft`.
- Generating a new-document proposal requires `ai:use` and schema visibility for
  the requested content type.
- Generating a delete-document proposal requires `ai:use` and
  `content:read:draft` for the target document; the chat turn is rejected
  before any model call if the caller lacks `content:delete`.
- Applying an edit proposal requires `content:write`.
- Applying a create-document proposal requires `content:write`.
- Applying a delete-document proposal requires `content:delete` and verifies
  the target has no published version.
- Multi-document turns return N independent proposals on one assistant
  message; the client applies each via the per-proposal apply route, so each
  child carries its own scope check. There is no batch-level transaction.

AI endpoints must not grant publish authority. Accepted AI edits update drafts
only. Publishing remains owned by the content publish endpoints.

All AI write application paths must:

- verify the caller is still authorized at apply time
- verify the proposal has not expired
- verify the proposal target still matches the expected draft revision
- validate content against the current synced schema
- validate generated MDX before writing
- write through the same draft mutation semantics as normal content updates
- produce an audit event that identifies the human actor, target document,
  proposal kind, accepted/rejected outcome, model/provider metadata, and
  validation result

## Endpoint Contracts

This table is normative and follows the shared contract template in `SPEC-005`.

| Method | Endpoint                                  | Auth mode          | Required scope                                                                       | Target routing                  | Request schema                                                                                                                                                                                                                                                                                                                    | Success response schema                                                                                                                       | Errors                                                                                                                                                                                                                                                                                                                     |
| ------ | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/ai/inline-transform`             | session_or_api_key | `ai:use`, `content:read:draft`                                                       | required: `project_environment` | JSON: `{ documentId, draftRevision, selectionId, selectedText, action, instruction?, tone? }` — `selectedText` is the **markdown** serialization of the selected slice (block-level structure preserved).                                                                                                                         | `200` `{ data: { proposals: AiProposal[] } }`                                                                                                 | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `AI_DISABLED` (`403`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `AI_CONTEXT_TOO_LARGE` (`413`), `AI_RATE_LIMITED` (`429`), `AI_PROVIDER_UNAVAILABLE` (`503`)                                        |
| POST   | `/api/v1/ai/chat/messages`                | session_or_api_key | `ai:use`, `content:read:draft` for read/edit operations                              | required: `project_environment` | JSON: `{ message, conversationId?, attachedDocumentIds?: string[], attachedSelection?: { documentId, draftRevision, selectionId, text }, rejectedProposalId?: string, rejectionFeedback?: string, allowedActions?: ("answer" \| "edit_document" \| "create_document" \| "delete_document")[], mdxCatalog?: MdxComponentCatalog }` | `200` `{ data: { conversationId, message, proposals? } }`                                                                                     | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `AI_DISABLED` (`403`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `AI_UNSUPPORTED_ACTION` (`400`), `AI_CONTEXT_TOO_LARGE` (`413`), `AI_RATE_LIMITED` (`429`), `AI_PROVIDER_UNAVAILABLE` (`503`)       |
| POST   | `/api/v1/ai/proposals/:proposalId/apply`  | session_or_api_key | `content:write`; `content:delete` when the proposal targets a `delete_document` kind | required: `project_environment` | path `proposalId`, JSON: `{ draftRevision?, schemaHash, clientSelectionState? }`                                                                                                                                                                                                                                                  | `200` `{ data: { proposal: AiProposal, documents: ContentDocument[], priorDraft?: { body: string, frontmatter: Record<string, unknown> } } }` | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `AI_PROPOSAL_EXPIRED` (`410`), `AI_PROPOSAL_CONFLICT` (`409`), `AI_OUTPUT_INVALID` (`422`), `SCHEMA_HASH_REQUIRED` (`400`), `SCHEMA_HASH_MISMATCH` (`409`) |
| POST   | `/api/v1/ai/proposals/:proposalId/reject` | session_or_api_key | `content:write`                                                                      | required: `project_environment` | path `proposalId`, JSON body optional and ignored                                                                                                                                                                                                                                                                                 | `200` `{ data: { proposal: AiProposal } }`                                                                                                    | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `AI_PROPOSAL_EXPIRED` (`410`), `AI_PROPOSAL_CONFLICT` (`409`)                                                                                              |
| POST   | `/api/v1/ai/proposals/:proposalId/undo`   | session_or_api_key | mirrors the action being reverted (see "Post-Accept Undo Window")                    | required: `project_environment` | path `proposalId`, JSON: `{ proposal: AiProposal, documentId: string, schemaHash: string, priorDraft?: { body: string, frontmatter: Record<string, unknown> }, postApplyDraftRevision?: number }`                                                                                                                                 | `200` `{ data: { proposal: AiProposal, document: ContentDocument } }`                                                                         | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`), `AI_PROPOSAL_CONFLICT` (`409`), `SCHEMA_HASH_MISMATCH` (`409`)                                                                                             |

`action` for inline transforms is an enum of selection-anchored copy edits:

- `rewrite`
- `shorten`
- `expand`
- `change_tone`
- `fix_grammar`
- `improve_clarity`

SEO frontmatter assistance and MDX component insertion are not part of this
endpoint. SEO suggestions are produced server-side by the `seo_improvement`
task and surfaced through the document properties panel. MDX component
insertion is handled by the editor slash menu and the global assistant chat
surface.

`allowedActions` for `/api/v1/ai/chat/messages` constrain the assistant's
proposal output. The default set is the full enum:

- `answer` — text-only response with no proposals
- `edit_document` — `replace_selection`, `insert_block`, `update_frontmatter`
  proposals that target an existing document the caller can read
- `create_document` — `create_document` proposals against a content type the
  caller can see in the schema
- `delete_document` — `delete_document` proposals against draft or
  unpublished documents the caller has `content:delete` for

Multi-document turns are not modeled as a dedicated `allowedActions` value
or wire kind. A single assistant message may return more than one proposal
(`proposals: AiProposal[]`); the Studio chat surface groups them implicitly
per assistant turn and the client applies each child via the per-proposal
apply route.

The chat response always echoes the `conversationId` so the client can persist
threads across navigation. When `rejectedProposalId` and `rejectionFeedback`
are supplied, the server treats the message as a regenerate-with-feedback
turn: it loads the prior proposal, applies the user's feedback, and emits a
fresh proposal that supersedes the rejected one. There is no separate
"try again" endpoint — regeneration is a chat turn.

The `apply` endpoint applies a single proposal. It returns the affected
document in `documents` (a single-element array). Multi-document turns are
applied one child at a time; the client iterates over the assistant
message's `proposals[]` and calls apply per child. The `reject` endpoint is
unchanged and still discards a single proposal id.

## Provider and Orchestration Requirements

AI provider credentials are server-side only. Studio never receives provider API
keys or raw provider request payloads.

Provider selection is an operator-controlled server startup concern. The server
reads `AI_PROVIDER` and normalizes it case-insensitively:

- missing, empty, or `disabled` disables AI and endpoints return or render
  `AI_DISABLED`
- `echo` enables the deterministic local/test provider
- `groq` enables the Groq AI SDK provider and requires `GROQ_API_KEY`
- `anthropic` enables the Anthropic AI SDK provider and requires
  `ANTHROPIC_API_KEY`

`AI_MODEL` overrides the provider's default model when set. When `AI_MODEL` is
absent, the direct Anthropic provider defaults to `claude-sonnet-4-6`, and the
Groq provider uses its server-defined default. Provider-specific base URL
overrides are server-only operator settings: `GROQ_BASE_URL` for Groq and
`ANTHROPIC_BASE_URL` for Anthropic. Missing or blank required provider
credentials must fail deterministically as `AI_PROVIDER_UNAVAILABLE`.

The orchestration layer must support task-specific prompt templates or
equivalent workflow definitions for at least:

- copy improvement
- SEO improvement
- MDX component insertion
- current-document editing through chat
- new-document draft creation through chat

The implementation may use specialized subagents, but subagents are not a
product contract. The product contract is the validated proposal output and the
human accept/reject workflow.

## Observability and Evaluation

AI operations must be auditable without storing unnecessary secrets.

Audit records include:

- actor id
- project and environment
- document id when applicable
- proposal id
- proposal kind
- action name or chat allowed action
- accepted, rejected, expired, undone, or failed outcome (the `undone` outcome
  is emitted on the post-accept undo path defined under
  "Post-Accept Undo Window" and references the original apply audit record's
  proposal id)
- provider and model identifier
- prompt template or workflow identifier
- validation status
- token/cost metadata when available

Regression coverage must include:

- hallucinated MDX component names are rejected
- invalid component props are rejected
- stale draft revisions cannot be applied
- prompt-injection attempts cannot trigger publish, schema, environment, or
  project changes
- generated frontmatter is schema-validated before writing
- rejected proposals do not mutate content
- accepted proposals write drafts only
- post-accept undo invoked inside the 6-second window reverts the apply
  through the proposal-kind-specific mechanism defined under
  "Post-Accept Undo Window" and emits an `undone` audit record
- post-accept undo invoked after a concurrent edit fails with
  `AI_PROPOSAL_CONFLICT` and does not mutate content

## Deferred Follow-Up Areas

The following areas are intentionally deferred but should remain tracked:

- External-agent MCP integration for Codex, Claude Code, Cursor, ChatGPT, and
  other agent clients.
- AI-assisted migration workflows for imports, schema mapping, transforms, and
  dry-run reports.
- Autocomplete or ghost-text authoring while the user types.
- AI-assisted schema design and environment/project administration.
