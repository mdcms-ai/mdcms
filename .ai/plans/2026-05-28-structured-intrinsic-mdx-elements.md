# Structured Intrinsic MDX Elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse lowercase intrinsic MDX/HTML as structured Studio blocks so native wrappers do not hide registered child components.

**Architecture:** Add a `mdxIntrinsicElement` TipTap node beside `mdxComponent` and keep `mdxRawJsx` only as the unsupported fallback. The MDX AST parser will convert lowercase elements into intrinsic nodes when attributes are representable, the runtime editor will render them with block chrome, and the Markdown serializer will emit lowercase HTML tags.

**Tech Stack:** Bun, TypeScript, TipTap 3, MDX mdast parser, React node views.

---

### Task 1: Parser Contract Tests

**Files:**
- Modify: `packages/studio/src/lib/markdown-pipeline.test.ts`

- [ ] **Step 1: Add a failing test for lowercase wrappers containing components**

Add a test that parses:

```mdx
<div style={{display: "flex", gap: "2rem"}}>
  <Hero headlineLead="AI-native CMS for" />
  <FeatureGrid headingLead="Built for teams that" />
</div>
```

Expected JSON shape:

```ts
assert.equal(parsed.content?.[0]?.type, "mdxIntrinsicElement");
assert.equal(parsed.content?.[0]?.attrs?.tagName, "div");
assert.equal(parsed.content?.[0]?.content?.[0]?.type, "mdxComponent");
assert.equal(parsed.content?.[0]?.content?.[0]?.attrs?.componentName, "Hero");
assert.equal(parsed.content?.[0]?.content?.[1]?.type, "mdxComponent");
assert.equal(
  parsed.content?.[0]?.content?.[1]?.attrs?.componentName,
  "FeatureGrid",
);
```

- [ ] **Step 2: Add round-trip coverage for native form elements**

Add a test that round-trips:

```mdx
<form name="contact">
<label>
Name
<input type="text" name="name" required />
</label>
<button type="submit">Send</button>
</form>
```

Expected: `roundTripMarkdown(source).markdown` contains `<form`, `<label>`, `<input`, and `<button`, and does not contain `mdxRawJsx`.

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
bun test packages/studio/src/lib/markdown-pipeline.test.ts
```

Expected: the new intrinsic-element tests fail because lowercase elements still parse as `mdxRawJsx`.

### Task 2: Intrinsic Node Extension

**Files:**
- Create: `packages/studio/src/lib/mdx-intrinsic-element-extension.ts`
- Modify: `packages/studio/src/lib/editor-extensions.ts`

- [ ] **Step 1: Implement `MdxIntrinsicElementExtension`**

Create a TipTap node named `mdxIntrinsicElement` with:

```ts
group: "block";
content: "block*";
isolating: true;
selectable: true;
draggable: true;
```

Attributes:

```ts
tagName: { default: "" };
props: { default: {} };
isVoid: { default: false };
```

Markdown rendering should serialize:

```mdx
<tagName prop="value" />
```

for void nodes and:

```mdx
<tagName prop="value">
children
</tagName>
```

for wrapper nodes, using the existing `serializeMdxJsxAttributes` helper.

- [ ] **Step 2: Register the extension**

Update `createEditorExtensions` so it includes `MdxIntrinsicElementExtension` before `MdxRawJsxExtension` and exposes an override slot like the existing `mdxComponent` and `mdxRawJsx` slots.

- [ ] **Step 3: Run the focused tests**

Run:

```bash
bun test packages/studio/src/lib/markdown-pipeline.test.ts
```

Expected: tests still fail until the parser converts lowercase AST nodes to the new node type.

### Task 3: Parser Conversion

**Files:**
- Modify: `packages/studio/src/lib/mdx-markdown-parser.ts`

- [ ] **Step 1: Convert lowercase MDX AST elements to intrinsic nodes**

Change the non-uppercase branch in `convertMdxJsxElementNode` so lowercase element names with parseable attributes return:

```ts
{
  type: "mdxIntrinsicElement",
  attrs: {
    tagName: name,
    props,
    isVoid,
  },
  content,
}
```

Continue returning `mdxRawJsx` when attribute parsing fails or the name is neither uppercase nor lowercase intrinsic syntax.

- [ ] **Step 2: Preserve void semantics**

Treat MDX self-closing syntax and known HTML void elements as void. Void intrinsic nodes must not carry parsed children.

- [ ] **Step 3: Run the focused tests**

Run:

```bash
bun test packages/studio/src/lib/markdown-pipeline.test.ts
```

Expected: parser and round-trip tests pass.

### Task 4: Runtime Editor Rendering

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/editor/mdx-intrinsic-element-node-view.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-node-view.tsx`

- [ ] **Step 1: Add an intrinsic node view**

Render intrinsic nodes with the existing `MdxComponentNodeFrame`, using the label `tagName`, the same collapse/duplicate/delete chrome, and `NodeViewContent` for non-void children.

- [ ] **Step 2: Render parseable intrinsic HTML as inert native preview**

For non-void intrinsic elements, wrap the editable content in `createElement(tagName, safeProps, editableSlot)` when safe to do so. For void elements, render `createElement(tagName, safeProps)` inside a `contentEditable={false}` preview surface.

- [ ] **Step 3: Register the node view**

Update `TipTapEditor` so `mdxIntrinsicElement` uses `ReactNodeViewRenderer(MdxIntrinsicElementNodeView)`.

- [ ] **Step 4: Run runtime UI tests affected by component node views**

Run:

```bash
bun test packages/studio/src/lib/runtime-ui/components/editor/mdx-component-collapse.test.tsx packages/studio/src/lib/runtime-ui/components/editor/mdx-component-selection.test.ts packages/studio/src/lib/markdown-pipeline.test.ts
```

Expected: tests pass.

### Task 5: Selection and Props Panel

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-component-selection.ts`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/mdx-props-panel.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/visual-composition-commands.ts`

- [ ] **Step 1: Generalize selected block metadata**

Allow `getSelectedMdxComponent` and `updateSelectedMdxComponentProps` to work with `mdxIntrinsicElement` nodes by returning a selection with `kind: "component" | "intrinsic"`.

- [ ] **Step 2: Show intrinsic props in the side panel**

Update `MdxPropsPanel` so intrinsic selections show the lowercase tag name and a `VisualStyleInspector`-compatible style editor when the `style` prop exists or can be added. Avoid the unregistered component warning for intrinsic nodes.

- [ ] **Step 3: Keep existing component commands scoped**

Only `mdxComponent` nodes should use catalog-only operations such as wrap-in-Box and host component validation. Intrinsic nodes may support duplicate/delete/collapse, but not catalog validation.

- [ ] **Step 4: Run targeted selection and panel tests**

Run:

```bash
bun test packages/studio/src/lib/runtime-ui/components/editor/mdx-component-selection.test.ts packages/studio/src/lib/runtime-ui/components/editor/visual-style-inspector.test.ts packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: tests pass after updating expectations for intrinsic selections.

### Task 6: Changeset, Quality, Commit, Push

**Files:**
- Create via CLI: `.changeset/*.md`

- [ ] **Step 1: Create a changeset**

Run:

```bash
bun run changeset
```

Select `@mdcms/studio`, patch release, and describe the Studio intrinsic HTML editor support.

- [ ] **Step 2: Run validation**

Run:

```bash
bun run format:check
bun run check
bun test packages/studio/src/lib/markdown-pipeline.test.ts
```

Expected: all commands pass.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add docs/specs/SPEC-007-editor-mdx-and-collaboration.md docs/specs/SPEC-014-ai-assisted-studio-editing.md .ai/research/2026-05-28-structured-intrinsic-mdx-elements-design.md .ai/plans/2026-05-28-structured-intrinsic-mdx-elements.md packages/studio/src .changeset
git commit -m "feat(studio): structure intrinsic mdx elements"
git push -u origin codex/structured-intrinsic-mdx-elements
```

Expected: branch is pushed with the spec, implementation, tests, and changeset.
