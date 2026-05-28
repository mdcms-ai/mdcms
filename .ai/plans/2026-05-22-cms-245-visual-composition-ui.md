# Visual Composition UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first desktop visual composition UI for Studio MDX documents.

**Architecture:** Keep TipTap/Markdown/MDX as the source of truth. Add a visual composition layer around the existing editor: a desktop palette, palette insertion/drop commands, selected-block toolbar actions, required-prop insertion dialog, and a style inspector that edits existing flat `style` props. Persisted output remains normal Markdown/MDX through the current serialization path.

**Tech Stack:** React 19, TipTap 3.7, ProseMirror transactions/plugins, Bun tests, existing Studio UI components.

---

## Spec Delta

- `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` now defines the desktop visual composition surface, palette, valid drop rules, insertion rules, structural actions, persistence/undo behavior, fallback behavior, and visual style editing.
- `docs/specs/SPEC-006-studio-runtime-and-ui.md` now allows the document editor shell to expose a desktop left palette and defines the `Component` sidebar tab as the continuous selected-block inspector.
- Acceptance criteria covered by this delta: visual primitive/component insertion, nested children editing, MDX persistence, registered component children, validation/fallback behavior, visual styling, and same-save-model persistence.

## File Map

- Modify `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-catalog.ts`
  - Add visual palette block definitions.
  - Add required-prop helpers and component insert defaults.
  - Keep legacy insert UI filtering unchanged.
- Create `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-types.ts`
  - Shared visual block, insertion, drop, and style types.
- Create `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.ts`
  - Pure TipTap/ProseMirror helpers for creating JSON content, inserting at positions, moving nodes, wrapping in `Box`, unwrapping wrappers, duplicating, deleting, and validating required props.
- Create `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-palette.tsx`
  - Desktop left palette grouped into Text, Layout, Media, Actions, Components.
  - Supports search, click insert, and drag payload creation.
- Create `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-insertion-dialog.tsx`
  - Required prop gate before inserting components with required props.
  - Reuses `MdxPropsEditorHost`.
- Create `packages/studio/src/lib/runtime-ui/components/editor/visual-style-inspector.tsx`
  - Spacing/color/typography/layout controls plus advanced style object editor.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/mdx-props-panel.tsx`
  - Turn the current component props panel into the selected-block inspector.
  - Show props first and style controls when the component exposes `style`.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-node-view.tsx`
  - Add contextual toolbar actions and child-drop visual affordances for wrappers.
  - Keep existing collapse and preview behavior.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
  - Render left palette on desktop.
  - Wire click/drag palette insertion and required-prop pending insertion.
  - Wire structural actions to existing editor state and `onChange`.
  - Keep old slash/toolbar component menu hiding built-ins.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
  - Keep the same save model; no separate persistence path.
- Add/modify tests under `packages/studio/src/lib/runtime-ui/components/editor/*.test.tsx` and `*.test.ts`
  - Cover palette categories, built-in visibility, required-prop gate, insertion serialization, style updates, wrapper rules, and legacy insert filtering.

## Task 1: Palette Model And Pure Commands

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-catalog.ts`
- Create: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-types.ts`
- Create: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.ts`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.test.ts`

- [ ] **Step 1: Write failing tests for palette categories and required props**

Run: `bun test packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.test.ts`

Expected: fails because the new module does not exist.

- [ ] **Step 2: Implement shared visual block types and palette resolution**

Create the visual block union for Markdown blocks and MDX component blocks. Add a resolver that returns Text, Layout, Media, Actions, and Components groups, with `Box`, `Image`, and `Link` visible in the visual palette and hidden from the legacy picker.

- [ ] **Step 3: Implement required-prop and insert-content helpers**

Required props are extracted from component metadata, excluding `children`. `Text` and `Box` insert immediately. `Image` requires `src` and `alt`; `Link` requires `href`.

- [ ] **Step 4: Implement pure TipTap command helpers**

Implement commands for:

- insert block/component content at the current selection or a given document position
- duplicate selected MDX component node
- delete selected MDX component node
- move selected MDX component node up/down among siblings
- wrap selected block in `Box`
- unwrap selected wrapper by lifting children
- patch selected component props, including `style`

- [ ] **Step 5: Run command tests**

Run: `bun test packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.test.ts`

Expected: passes.

## Task 2: Visual Palette And Insertion Dialog

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-palette.tsx`
- Create: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-insertion-dialog.tsx`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-palette.test.tsx`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-insertion-dialog.test.tsx`

- [ ] **Step 1: Write failing render tests**

Verify that the palette renders the expected categories, exposes built-ins, keeps host components in Components, filters by search, and marks items as draggable. Verify that the insertion dialog blocks submit until required props are present.

- [ ] **Step 2: Implement palette UI**

Use a compact desktop panel with category headers, search, icon buttons, and draggable block rows. Drags set an `application/x-mdcms-visual-block` payload; click insertion uses the same pending insertion path.

- [ ] **Step 3: Implement required-prop insertion dialog**

Use `MdxPropsEditorHost` with controlled local props. Submit inserts only when required props validate. Cancel leaves editor state unchanged.

- [ ] **Step 4: Run UI tests**

Run: `bun test packages/studio/src/lib/runtime-ui/components/editor/visual-composition-palette.test.tsx packages/studio/src/lib/runtime-ui/components/editor/visual-composition-insertion-dialog.test.tsx`

Expected: passes.

## Task 3: Editor Integration

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-node-view.tsx`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-node-view.test.tsx`

- [ ] **Step 1: Write failing integration tests**

Verify that:

- the visual palette includes built-ins while the legacy slash/toolbar picker still hides them
- clicking a safe-default block inserts it and emits markdown
- required-prop components open the pending insertion dialog before insertion
- wrapper components expose an inside drop affordance
- `Text` and `Link` do not expose block child drop affordances

- [ ] **Step 2: Render the desktop visual composition shell**

Wrap the editor body in a two-column desktop composition layout: hidden left palette on narrow screens, center editor canvas, existing right sidebar unchanged.

- [ ] **Step 3: Wire insertion**

Palette clicks and drops call the same insert path. If required props are missing, store a pending insertion with the target position and open the insertion dialog. Successful insert selects the new MDX component when applicable and emits markdown through the existing `onChange` path.

- [ ] **Step 4: Wire structural actions on MDX node views**

Add toolbar callbacks for duplicate, delete, wrap in `Box`, unwrap, move up, and move down where valid. Keep invalid actions hidden.

- [ ] **Step 5: Run editor tests**

Run: `bun test packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts packages/studio/src/lib/runtime-ui/components/editor/mdx-component-node-view.test.tsx`

Expected: passes.

## Task 4: Style Inspector

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/editor/visual-style-inspector.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-props-panel.tsx`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/visual-style-inspector.test.tsx`
- Test: `packages/studio/src/lib/runtime-ui/components/editor/mdx-props-panel.test.tsx`

- [ ] **Step 1: Write failing style tests**

Verify visual controls update flat style keys, preserve unrelated valid keys, hide style controls for components without `style`, and keep advanced JSON edits flat.

- [ ] **Step 2: Implement visual style controls**

Implement spacing, color, typography, layout, and advanced object groups. All controls patch only `props.style`.

- [ ] **Step 3: Integrate style inspector into component panel**

Show validation/props first, style groups second, advanced style object last. Keep the existing custom/generated props editor path intact.

- [ ] **Step 4: Run style tests**

Run: `bun test packages/studio/src/lib/runtime-ui/components/editor/visual-style-inspector.test.tsx packages/studio/src/lib/runtime-ui/components/editor/mdx-props-panel.test.tsx`

Expected: passes.

## Task 5: Verification And Commit

**Files:**
- Modify the files changed by Tasks 1-4 after test or typecheck feedback
  identifies a concrete issue in those files.
- Add changeset only if the changeset gate requires it for the touched published package paths.

- [ ] **Step 1: Run focused Studio tests**

Run: `bun test packages/studio/src`

Expected: all Studio tests pass.

- [ ] **Step 2: Run workspace check**

Run: `bun run check`

Expected: build and typecheck pass.

- [ ] **Step 3: Run formatting checks**

Run focused Prettier checks on touched files. Note that full `bun run format:check` may still fail on unrelated untracked files already present in the workspace.

- [ ] **Step 4: Inspect changeset gate**

Run: `bun run changeset:check`

Expected: either no changeset required or Changesets CLI creates the required release note.

- [ ] **Step 5: Commit**

Commit the implementation with a conventional commit after tests pass.
