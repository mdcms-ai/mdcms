# CMS-245 Visual Composition UI Design

Date: 2026-05-22

## Goal

Design the first visual editor for MDX composition in Studio. Editors should be
able to compose, arrange, and style document-owned content visually without
needing to author raw MDX, while MDCMS still persists normal Markdown/MDX and
keeps host React components code-owned.

This design builds on the already implemented Option B foundation: MDX children
as nested document content, built-in MDX components, inline `style` props,
catalog validation, Studio/SDK rendering support, and AI/manual MDX capability.

## Scope

V1 includes:

- Canvas-first document editing.
- Document-flow drag/drop for Markdown blocks, built-ins, and host components.
- Persistent left block palette on desktop.
- Contextual drop targets for before, after, and valid child positions.
- Right-side selected-block inspector for props and style editing.
- Figma-style base flex/grid controls backed by flat inline styles.
- Defensive fallback UI for invalid, unsupported, loading, and preview-error
  blocks.

V1 excludes:

- Freeform absolute-position design canvas.
- Named slots.
- Saved compositions/templates.
- First-class source mode in this UI.
- Keyboard reorder/nesting controls.
- Touch/mobile drag/drop.
- Responsive style variants.
- Hover/focus/pseudo-state styling.
- CSS generation, custom CSS, selectors, `className`, or JavaScript props.

## Layout

The desktop editor uses three regions:

1. **Left palette**: draggable blocks grouped by editor-facing categories.
2. **Center canvas**: visual document-flow editor with contextual chrome.
3. **Right inspector**: selected-block props, validation, style controls, and
   advanced style object editing.

The canvas is an editor surface, not an exact public page preview. It may add
artificial spacing, selection outlines, labels, handles, and drop zones. Exact
public rendering remains the job of preview routes or dedicated preview
surfaces.

On narrow screens, visual composition controls are hidden. The document remains
editable through the existing non-builder editing surface; mobile/touch
composition is deferred.

## Palette

The palette contains atomic blocks only. Saved templates and reusable
compositions are deferred.

Default V1 categories:

- **Text**: Paragraph, Heading, List, Quote
- **Layout**: Box
- **Media**: Image
- **Actions**: Link
- **Components**: host-registered components

The palette uses user-facing categories, not implementation ownership as the
primary navigation. Subtle provenance indicators may distinguish Markdown,
MDCMS built-ins, and host components where useful.

The palette includes search/filtering across block/component name, description,
and category. Built-ins that were hidden from the old slash/toolbar insertion
menus are intentionally visible here because this is the dedicated visual
composition UI.

## Canvas Interaction

The editor uses a document-flow builder model. Drag/drop changes the normal
document tree order; it does not write layout coordinates.

All document blocks participate in drag/drop:

- headings
- paragraphs
- lists
- quotes
- MDX component blocks
- MDCMS built-ins
- host components

Single click selects a block. Double click edits text/content inside it. Dense
text blocks show a left-gutter drag handle on hover or selection so arranging
does not conflict with text selection.

Selected blocks show minimal persistent chrome. A fuller toolbar appears on
hover or focus. The V1 toolbar includes:

- drag
- add before
- add after
- add inside when valid
- duplicate
- delete
- wrap in Box
- unwrap
- move up
- move down

The toolbar does not include convert-block-type. Invalid actions are hidden,
not disabled.

Delete is immediate and relies on normal undo/redo. Duplicate creates an exact
copy of the selected block subtree, including props, style, content, and
children.

## Drop Targets

Drop targets are contextual. Handles and drop zones remain subtle until the
user hovers/selects a block or begins dragging.

Visible drop targets are always valid. Invalid parent/child targets simply do
not appear.

Before and after drop targets appear for valid sibling positions. Inside drop
targets appear only for wrappers that accept rich-text `children`.

Any wrapper component whose catalog exposes rich-text `children` can receive
child drops. This is not limited to `Box`.

`Text` and `Link` are inline editing surfaces in V1. They accept text and inline
formatting edits, but not structural block drops.

Child drop zones are overlaid on rendered previews for wrapper components. V1
supports only the default `children` zone. Named slots are deferred. Host
wrapper components receive one default child-drop overlay over the component
body/children area; Studio does not require host components to map exact
internal DOM slots in V1.

## Insertion

The editor should avoid creating invalid nodes in normal flows.

Dragging a palette block with required props opens a small insertion
configuration dialog before committing the node. The node is inserted only when
required props are valid. Cancel leaves the document unchanged.

Blocks/components with safe defaults insert immediately.

If a component provides a custom props editor, the insertion dialog uses it.
Otherwise it uses the generated prop form from catalog metadata.

This means invalid/incomplete block UI is defensive fallback only, not the
normal creation path.

## Inspector

The selected-block inspector is one continuous panel:

1. Required props and validation issues
2. Component props
3. Style groups
4. Advanced style object editor

The inspector should not hide validation problems behind tabs. Collapsible
groups are acceptable, but required missing fields and current errors stay
visible near the top.

Normal component props use the existing generated/custom props editor paths.
Style editing is shown only for components whose catalog exposes a `style` prop
or built-ins that support style.

## Style Editing

Style editing persists to the existing first-class flat inline `style` prop.
The UI does not introduce a design-token system or custom CSS runtime.

Style groups:

- **Spacing**: `padding`, individual padding sides, `margin`, individual margin
  sides, and `gap` where valid.
- **Color**: `color`, `backgroundColor`, swatches/color inputs, and raw value
  entry.
- **Typography**: `fontSize`, `fontWeight`, `lineHeight`, `textAlign`.
- **Layout**: Figma-style flex/grid controls.
- **Advanced style object**: flat string/number style keys not covered by
  visual controls.

The Layout group supports base flex/grid editing:

- `display`
- `flexDirection`
- `alignItems`
- `justifyContent`
- `gap`
- `flexWrap`
- `gridTemplateColumns`
- `gridTemplateRows`
- `gridAutoFlow`
- `columnGap`
- `rowGap`

The editor must preserve unknown-but-valid style keys. Changing one visual
control must not drop unrelated keys from the advanced object.

Responsive variants and pseudo states are out of scope.

## Preview Fidelity

The visual canvas uses hybrid fidelity.

Valid components use the host-rendered preview bridge where possible. Studio
owns generic shells for:

- loading previews
- invalid content
- unsupported MDX
- preview render errors

Preview loading/error shells remain selectable so the user can inspect, move,
delete, or repair the block.

Host-rendered previews are embedded inside Studio selection/drop chrome. The
editor chrome is responsible for selection, drag handles, drop zones, labels,
and repair UI.

Canvas block labels and provenance badges appear on hover or selection, not
permanently on every block.

## Unsupported And Invalid Content

AI apply, CLI push, manual Markdown validation, and visual insertion flows
should prevent invalid MDX from being persisted in normal use.

If invalid or unsupported content appears anyway, Studio must keep it visible
as a selectable fallback block. It must not hide content or auto-normalize risky
MDX.

Fallback blocks show partial preview when possible, warning chrome, and repair
guidance in the inspector.

## AI Proposal Interaction

AI remains a separate chat/proposal flow in V1. The visual editor does not
expose AI-generated draggable blocks or a second proposal lifecycle.

Visual editing may continue while AI proposals are visible. Studio does not
dismiss, auto-reject, or rebase open proposals when content changes.

If local edits happen while proposals are open, Studio shows a light stale-risk
indicator. Accept remains available. Existing apply validation remains
authoritative; stale or no-longer-applicable proposals fail through the normal
proposal conflict/validation path.

AI proposal previews are read-only review artifacts. Drag/drop and visual
editing apply only to actual editor content. Once accepted, proposal content is
normal document content and can be edited visually.

## Persistence And Undo

Visual composition edits use the same Studio editing/save model as normal body
text edits. Drag, drop, reorder, prop edits, style edits, and text edits update
local editor state, participate in the same dirty-state/recovery behavior, and
persist through the same save action.

No separate autosave or composition-specific persistence mechanism is
introduced.

All visual composition mutations participate in the normal editor undo/redo
stack:

- drag
- drop
- reorder
- duplicate
- delete
- wrap
- unwrap
- prop edits
- style edits
- text edits

## Accessibility And Deferred Input Modes

V1 is mouse-first for drag/drop. Keyboard-accessible reorder/nesting controls
are deferred.

The implementation should still preserve basic focus management and avoid
trapping focus in custom chrome, but full keyboard composition parity is not
part of V1.

Touch/mobile drag/drop is also deferred.

## Testing Expectations

Coverage should prove:

- palette categories include Markdown blocks, built-ins, and host components
- built-ins are visible in the visual palette while remaining hidden from the
  old insertion surfaces
- required-prop insertion does not commit invalid nodes
- drag/drop creates valid Markdown/MDX order and nesting
- invalid drop targets are not exposed
- `Text` and `Link` do not accept block drops
- wrappers with rich-text `children` accept child drops
- wrap creates `Box`
- unwrap lifts children for any wrapper
- duplicate preserves block subtree
- delete and structural edits participate in undo/redo
- style visual controls update flat inline style keys
- advanced style editing preserves unsupported valid keys
- unsupported/invalid MDX remains visible as fallback UI
- open AI proposals are not dismissed or rebased by visual edits
- stale-risk indicators appear after local edits while proposals are visible

## Decision Log

The detailed decision log is
`.ai/research/2026-05-22-cms-245-visual-composition-ui-decisions.md`.
