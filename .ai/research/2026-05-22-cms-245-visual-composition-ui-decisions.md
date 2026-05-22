# CMS-245 Visual Composition UI Decision Log

This draft records UI decisions made during brainstorming. Manual decisions were
chosen directly in conversation. Offline recommended decisions were filled in
after the user asked to proceed with recommended choices so the design could be
completed without losing momentum.

## Manual Decisions

1. The visual composition UI is canvas-first. Editors should be able to compose
   and edit MDX document structure visually without needing to author raw MDX.

2. V1 targets full drag-and-drop support for document composition.

3. Drag-and-drop uses a document-flow builder model, not a freeform absolute
   positioning model. Editors drag blocks into visible before, after, and inside
   drop targets. Persisted output remains normal Markdown/MDX document order.

4. Markdown blocks participate in drag-and-drop. Headings, paragraphs, lists,
   quotes, MDX components, MDCMS built-ins, and host components are all document
   blocks that can be reordered.

5. Normal editing flows should avoid invalid nodes. The drag-and-drop editor
   should collect required props before committing a new node, or insert only
   components with safe defaults. AI apply and CLI/manual Markdown validation
   should reject invalid MDX before persistence.

6. Invalid/incomplete block UI exists only as a defensive fallback. If invalid
   content appears anyway, Studio keeps the block selectable and renders a
   partial preview with warning chrome plus repair prompts in the inspector.

7. Any wrapper component whose catalog exposes rich-text `children` can receive
   child drops. This is not limited to `Box`.

8. Child drop zones are overlaid on the rendered preview for wrapper components.
   V1 does not introduce named slot contracts.

9. V1 supports only the default `children` drop zone. Named slots are deferred.

10. `Text` and `Link` are inline editing surfaces in V1. They accept text and
    inline formatting edits, but they are not structural drop containers for
    headings, lists, boxes, images, or other block-level content.

11. Drop targets are contextual. Handles and drop zones stay subtle by default
    and become prominent during drag or block hover/focus.

12. Desktop V1 has a persistent left block palette as the source for draggable
    blocks.

13. The palette is organized by user-facing categories with subtle provenance
    indicators where useful. Editors should see concepts like Text, Layout,
    Media, Actions, and Components rather than internal ownership boundaries.

14. V1 palette contains only atomic blocks/components. Saved compositions and
    reusable templates are deferred.

15. Style editing uses grouped visual controls plus an advanced object fallback.

16. The Layout style group includes a Figma-style flex and grid editor for base
    inline styles. Responsive variants are deferred.

17. The selected-block inspector is one continuous panel: required props and
    validation issues first, component props next, style groups next, and the
    advanced object editor last.

18. Canvas selection uses single click to select a block and double click to
    edit text/content inside the block. This avoids accidental text edits while
    arranging page structure.

19. Selected blocks show minimal persistent chrome by default. The fuller
    on-canvas action toolbar appears on hover or focus.

20. The V1 on-canvas toolbar includes drag, add before, add after, add inside
    when valid, duplicate, delete, wrap, unwrap, move up, and move down. V1 does
    not include convert-block-type.

21. Invalid toolbar actions are hidden, not shown disabled. For example, an
    inline-only or void block does not show add-inside actions.

22. Invalid drop targets do not appear. If a drop target is visible, dropping
    there must be valid according to the document schema and component catalog.

23. V1 does not support multi-select block operations.

24. V1 drag/drop is mouse-first. Keyboard-accessible reorder and nesting
    controls are deferred.

25. V1 visual composition controls are desktop-only. Narrow screens keep
    content editing available but hide the drag/drop builder controls.

26. The visual composition UI does not expose a first-class Source mode. Manual
    MDX editing can exist elsewhere, but this UI is the normal editor surface.

27. Unsupported MDX follows the same defensive fallback rule as invalid blocks:
    the visual editor must keep it visible as a selectable locked/unsupported
    block with preview/error chrome and instructions to repair it outside the
    visual surface. It must not hide unsupported content or auto-normalize it.

28. Visual composition edits follow the same Studio editing and save model as
    normal body text edits. Drag, drop, reorder, prop, text, and style changes
    update local editor state, participate in the same dirty-state/recovery
    behavior as text edits, and are persisted through the same save action. No
    separate autosave or composition-specific persistence mechanism is
    introduced.

29. Visual composition mutations participate in the normal editor undo/redo
    stack. Drag, drop, reorder, duplicate, delete, wrap, unwrap, prop edits,
    style edits, and text edits must be undoable like other body edits.

30. AI remains a separate chat/proposal flow in V1. The visual editor does not
    expose AI-generated draggable blocks or a second proposal lifecycle.
    Accepted AI changes are rendered by the visual editor like any other body
    change.

31. Visual editing may continue while AI proposals are visible. Studio does not
    dismiss, auto-reject, or rebase open proposals when the editor changes
    content. Existing apply validation handles staleness: if the document state
    changed such that a proposal is no longer applicable, accepting it fails
    through the normal proposal conflict/validation path.

32. If local edits happen while AI proposals are visible, Studio shows a light
    stale-risk indicator on affected/open proposals. Accept remains available;
    apply-time validation remains authoritative.

33. AI proposal previews are read-only review artifacts. Drag/drop and visual
    editing do not modify proposal preview content. Once accepted, proposal
    content becomes normal editor content and can be edited visually.

34. The visual canvas uses hybrid preview fidelity. Valid components use the
    host-rendered preview bridge where possible. Studio-owned generic shells
    handle loading, invalid, unsupported, and preview-error states.

35. The visual canvas is an editor surface, not an exact public-page preview.
    It may add selection chrome, artificial spacing, handles, and drop zones to
    improve editing clarity. Exact public rendering remains the job of preview
    routes or dedicated preview surfaces.

36. Canvas block labels and provenance badges are contextual. They appear on
    hover or selection, not permanently on every block.

37. The V1 wrap action is specifically "Wrap in Box." It does not wrap in
    arbitrary host wrapper components.

38. The V1 unwrap action applies to any wrapper component with children. It
    removes the wrapper and lifts its children into the wrapper's parent.

39. Duplicate creates an exact copy of the selected block subtree, preserving
    props, style, content, and children.

40. Delete is immediate and relies on the normal undo/redo stack for recovery.
    V1 does not show delete confirmation dialogs for blocks.

## Offline Recommended Decisions

41. Dragging a palette block with required props opens a small insertion
    configuration dialog before committing the node. The node is inserted only
    after required props are valid. Canceling the dialog leaves the document
    unchanged. Blocks/components with safe defaults insert immediately.

42. If a component provides a custom props editor, the insertion dialog uses
    that editor. Otherwise it uses the generated prop form from catalog
    metadata.

43. Default V1 palette categories and ordering are:
    - Text: Paragraph, Heading, List, Quote
    - Layout: Box
    - Media: Image
    - Actions: Link
    - Components: host-registered components

44. The palette includes search/filtering. Search matches block/component name,
    description, and category.

45. Dense Markdown text blocks expose a left-gutter drag handle on hover or
    selection. Clicking the block selects it; dragging starts from the handle,
    not from arbitrary text content.

46. Host wrapper components use a default child-drop overlay over the component
    body/children area. V1 does not require hosts to map exact internal DOM
    slots. If the host preview is complex, Studio still presents one default
    children drop zone for the wrapper.

47. Preview loading states use Studio-owned shells. A block remains selectable
    while its host-rendered preview is loading or has failed.

48. The visual style groups are:
    - Required/component props
    - Spacing
    - Color
    - Typography
    - Layout
    - Advanced style object

49. Spacing controls edit flat inline style keys such as `padding`, individual
    padding sides, `margin`, individual margin sides, and `gap` where valid.

50. Color controls edit flat inline style keys such as `color` and
    `backgroundColor` with swatches/color inputs plus raw value entry.

51. Typography controls edit flat inline style keys such as `fontSize`,
    `fontWeight`, `lineHeight`, and `textAlign`.

52. The Figma-style Layout control edits base inline flex/grid keys only:
    `display`, `flexDirection`, `alignItems`, `justifyContent`, `gap`,
    `flexWrap`, `gridTemplateColumns`, `gridTemplateRows`, `gridAutoFlow`,
    `columnGap`, and `rowGap`.

53. The advanced style object editor remains available for any valid flat
    string/number style key not covered by visual controls.

54. The visual editor should preserve unknown-but-valid style keys. Editing
    known visual controls must not drop unrelated keys in the advanced object.

55. V1 does not add touch drag/drop. Mobile or touch-optimized composition is a
    later interaction design.

## Open Decisions

- None for the current V1 design draft. Remaining details should be handled as
  implementation-level choices unless they change the product contract above.
