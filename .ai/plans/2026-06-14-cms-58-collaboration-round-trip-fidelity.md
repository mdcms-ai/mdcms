# CMS-58 Collaboration Round-Trip Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic CI coverage proving Studio collaboration bodies and frontmatter fixtures round-trip without phantom edits.

**Architecture:** Keep the suite fixture-driven and colocated with Studio runtime editor tests because Studio consumes the `@mdcms/editor-core` markdown pipeline and owns frontmatter/property UI state. Assert byte-for-byte stability only for the canonical markdown/MDX shape the Studio serializer produces; do not attempt to preserve arbitrary hand-authored JSX whitespace or prop formatting outside the current schema-produced contract.

**Tech Stack:** Bun test, TypeScript, Studio markdown pipeline re-export, TipTap editor-core serialization, Studio content document state helpers.

---

## Spec Delta

No new spec delta is required for CMS-58. `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` already defines:

- `serialize(parse(markdown)) === markdown` for schema-produced content.
- CI coverage across Markdown/MDX bodies, frontmatter fields supported by Studio properties, MDX component nodes with props, nested component children, native image/link serialization, and collapsed MDX component UI state.

Affected behavior:

- Studio/editor serialization regression coverage only.
- No endpoint, auth mode, routing context, request contract, success response, or deterministic API error change.

Acceptance criteria covered:

1. `serialize(parse(markdown)) === markdown` passes for every configured fixture type in the new suite.
2. Primary and edge UI serialization states are covered through collapsed MDX component state and frontmatter property fixtures.
3. The operator/public workflow is the existing CI test command; no new workflow docs are needed beyond the spec and test names.

## File Structure

- Create `packages/studio/src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts`
  - Own the CMS-58 fixture matrix.
  - Import `roundTripMarkdown` from `../../../markdown-pipeline.js`.
  - Import `cloneFrontmatter`, `areJsonValuesEqual`, `getPropertyDescriptors`, and `type ContentDocumentPageReadyState` from `../../pages/content-document-page-state.js`.
  - Import `type SchemaRegistryFieldSnapshot` from `@mdcms/shared`.
- No production files should change unless one of the canonical fixtures fails and exposes a real serializer defect.
- Changes under `packages/studio/src/lib/runtime-ui/**` are exempted by `packages/studio/.changeset-gate.json`, which lists that runtime-only, backend-served source as unpublished. Changes outside that documented exception in published package `src/**` still require a changeset.

## Task 1: Fixture-Driven Body Idempotency

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts`

- [x] **Step 1: Add the fixture matrix test**

Create the file with:

```typescript
import assert from "node:assert/strict";

import { test } from "bun:test";

import { roundTripMarkdown } from "../../../markdown-pipeline.js";

type CollaborationRoundTripFixture = {
  type: string;
  body: string;
};

const BODY_FIXTURES: CollaborationRoundTripFixture[] = [
  {
    type: "Article",
    body: [
      "# Product Update",
      "",
      "Intro with [docs](https://docs.example.com).",
      "",
      "![Hero image](https://cdn.example.com/hero.png)",
      "",
      "- [ ] Draft",
      "- [x] Published",
      "",
      "```ts",
      "const value = 42;",
      "```",
    ].join("\n"),
  },
  {
    type: "MarketingPage",
    body: [
      '<Hero title="Launch" image={{"src":"https://cdn.example.com/hero.png"}} />',
      "",
      '<Callout type="warning">',
      "This is **important** content.",
      "",
      '<Button href="/start">',
      "Start",
      "</Button>",
      "</Callout>",
    ].join("\n"),
  },
  {
    type: "LandingPage",
    body: [
      '<section style={{"backgroundColor":"#fff"}}>',
      "<h2>",
      'Title with <span style={{"color":"#2563eb"}}>accent</span>',
      "</h2>",
      "</section>",
    ].join("\n"),
  },
];

test("collaboration body fixtures round-trip byte-for-byte", () => {
  for (const fixture of BODY_FIXTURES) {
    assert.equal(
      roundTripMarkdown(fixture.body).markdown,
      fixture.body,
      `${fixture.type} body must not produce a phantom collaboration diff`,
    );
  }
});
```

- [x] **Step 2: Run the focused test**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts
```

Expected: pass if current canonical serialization is already correct. If it fails, inspect the diff. Only change production serialization when the fixture is already in the canonical Studio-produced form above.

## Task 2: Frontmatter Fixture Coverage

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts`

- [x] **Step 1: Add frontmatter/schema fixtures**

Append:

```typescript
import {
  createEmptyCurrentPrincipalCapabilities,
  type SchemaRegistryFieldSnapshot,
} from "@mdcms/shared";
import {
  areJsonValuesEqual,
  cloneFrontmatter,
  getPropertyDescriptors,
  type ContentDocumentPageReadyState,
} from "../../pages/content-document-page-state.js";

type FrontmatterFixture = {
  type: string;
  frontmatter: Record<string, unknown>;
  fields: Record<string, SchemaRegistryFieldSnapshot>;
  editableFields: string[];
  unsupportedFields: string[];
};

const FRONTMATTER_FIXTURES: FrontmatterFixture[] = [
  {
    type: "Article",
    frontmatter: {
      title: "Product Update",
      priority: 3,
      featured: true,
      heroImage: "media_hero",
      status: "published",
    },
    fields: {
      title: { kind: "string", required: true, nullable: false },
      priority: { kind: "number", required: false, nullable: true },
      featured: { kind: "boolean", required: false, nullable: false },
      heroImage: {
        kind: "file",
        required: false,
        nullable: true,
        file: {
          preset: "image",
          accept: ["image/png", "image/jpeg"],
          emptyStringAsUnset: true,
        },
      },
      status: {
        kind: "string",
        required: false,
        nullable: true,
        options: ["draft", "review", "published"],
      },
    },
    editableFields: ["title", "priority", "featured", "heroImage", "status"],
    unsupportedFields: [],
  },
  {
    type: "LandingPage",
    frontmatter: {
      seo: { title: "Launch", description: "Ship the new page." },
      tags: ["launch", "product"],
    },
    fields: {
      seo: {
        kind: "object",
        required: false,
        nullable: false,
        fields: {
          title: { kind: "string", required: true, nullable: false },
          description: { kind: "string", required: false, nullable: true },
        },
      },
      tags: {
        kind: "array",
        required: false,
        nullable: false,
        item: { kind: "string", required: true, nullable: false },
      },
    },
    editableFields: [],
    unsupportedFields: ["seo", "tags"],
  },
];

function createFixtureReadyState(
  fixture: FrontmatterFixture,
): ContentDocumentPageReadyState {
  return {
    status: "ready",
    typeId: fixture.type,
    typeLabel: fixture.type,
    documentId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    route: {
      project: "marketing",
      initialEnvironment: "draft",
      write: { canWrite: true, schemaHash: "schema-hash" },
    },
    schemaState: {
      status: "ready",
      project: "marketing",
      environment: "draft",
      localSchemaHash: "schema-hash",
      serverSchemaHash: "schema-hash",
      isMismatch: false,
      hasLocalSyncPayload: true,
      canSync: true,
      capabilities: {
        ...createEmptyCurrentPrincipalCapabilities(),
        content: {
          read: true,
          readDraft: true,
          write: true,
          publish: true,
          unpublish: true,
          delete: true,
        },
        schema: { read: true, write: true },
        media: { read: true, upload: true, delete: true },
        ai: { use: true },
      },
      entries: [
        {
          type: fixture.type,
          directory: "content",
          localized: false,
          schemaHash: "schema-hash",
          syncedAt: "2026-06-14T10:00:00.000Z",
          resolvedSchema: {
            type: fixture.type,
            directory: "content",
            localized: false,
            fields: fixture.fields,
          },
        },
      ],
      reload: async () => {
        throw new Error("not used");
      },
      sync: async () => {
        throw new Error("not used");
      },
    },
    document: {
      documentId: "11111111-1111-4111-8111-111111111111",
      type: fixture.type,
      locale: "en",
      path: "content/example",
      format: "mdx",
      frontmatter: fixture.frontmatter,
      body: "",
      publishedVersion: null,
      hasUnpublishedChanges: true,
      draftRevision: 1,
      updatedAt: "2026-06-14T10:00:00.000Z",
    },
    draftBody: "",
    draftFrontmatter: cloneFrontmatter(fixture.frontmatter),
    saveState: "saved",
    canWrite: true,
    canAi: true,
    canReadMedia: true,
    canUploadMedia: true,
    publishDialogOpen: false,
    publishChangeSummary: "",
    publishState: "idle",
    restoreVersionState: "idle",
    versionHistory: { status: "ready", versions: [] },
    selectedComparison: {},
    versionDiff: { status: "idle" },
    translationVariants: [],
    localized: false,
    variantsFetchFailed: false,
  };
}
```

- [x] **Step 2: Add frontmatter assertions**

Append:

```typescript
test("collaboration frontmatter fixtures preserve supported values", () => {
  for (const fixture of FRONTMATTER_FIXTURES) {
    const cloned = cloneFrontmatter(fixture.frontmatter);
    assert.notEqual(cloned, fixture.frontmatter);
    assert.equal(
      areJsonValuesEqual(cloned, fixture.frontmatter),
      true,
      `${fixture.type} frontmatter clone must preserve JSON values`,
    );

    const descriptors = getPropertyDescriptors(createFixtureReadyState(fixture));
    const editable = descriptors
      .filter((descriptor) => descriptor.status === "editable")
      .map((descriptor) => descriptor.fieldName)
      .sort();
    const unsupported = descriptors
      .filter((descriptor) => descriptor.status === "unsupported")
      .map((descriptor) => descriptor.fieldName)
      .sort();

    assert.deepEqual(editable, fixture.editableFields.sort());
    assert.deepEqual(unsupported, fixture.unsupportedFields.sort());
  }
});
```

- [x] **Step 3: Run the focused test**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts
```

Expected: pass.

## Task 3: Collapsed MDX UI State Regression

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts`

- [x] **Step 1: Add collapsed-state serialization and read-only affordance assertions**

Append:

```typescript
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocumentEditor } from "../../../document-editor.js";
import { extractMarkdownFromEditor } from "../../../markdown-pipeline.js";
import { MdxComponentCollapseProvider } from "./mdx-component-collapse.js";
import { MdxComponentNodeView } from "./mdx-component-node-view.js";
import {
  nextMdxComponentCollapseSnapshot,
  toggleMdxComponentCollapseSnapshot,
  type MdxComponentCollapseSnapshot,
} from "./mdx-component-collapse-state.js";
import { TipTapEditor } from "./tiptap-editor.js";

function extractMarkdownFromSaveEditor(body: string): string {
  const editor = createDocumentEditor({ content: body });

  try {
    return extractMarkdownFromEditor(editor);
  } finally {
    editor.destroy();
  }
}

function renderMdxNodeViewSavePathUnderCollapse(props: {
  body: string;
  snapshot: MdxComponentCollapseSnapshot;
}): {
  state: MdxComponentCollapseSnapshot["globalState"];
  markup: string;
  markdown: string;
} {
  const editor = createDocumentEditor({ content: props.body });

  try {
    const CalloutPreview = (previewProps: { children?: ReactNode }) =>
      createElement("aside", null, previewProps.children);
    const markup = renderToStaticMarkup(
      createElement(
        MdxComponentCollapseProvider,
        { snapshot: props.snapshot },
        createElement(MdxComponentNodeView, {
          node: {
            attrs: {
              componentName: "Callout",
              isVoid: false,
              props: { type: "warning" },
            },
          },
          selected: false,
          readOnly: false,
          forbidden: false,
          context: {
            hostBridge: {
              resolveComponent: () => CalloutPreview,
              renderMdxPreview: () => () => {},
            },
            mdx: {
              catalog: { components: [] },
            },
          },
          editor,
          getPos: () => 1,
          deleteNode: () => {},
        } as never),
      ),
    );

    return {
      state: props.snapshot.globalState,
      markup,
      markdown: extractMarkdownFromEditor(editor),
    };
  } finally {
    editor.destroy();
  }
}

function getCollapseToolbarButtonMarkup(markup: string): string {
  const match = markup.match(
    /<button(?=[^>]*title="Collapse all components")[\s\S]*?<\/button>/,
  );

  assert.ok(match?.[0], "expected the Collapse all toolbar button to render");

  return match[0];
}

test("collapsed MDX component UI state does not affect serialization", () => {
  const body = [
    '<Callout type="warning">',
    "Keep this **body** stable.",
    "",
    '<Button href="/start">',
    "Start",
    "</Button>",
    "</Callout>",
  ].join("\n");
  const initial: MdxComponentCollapseSnapshot = {
    globalState: null,
    generation: 0,
  };
  const collapsed = toggleMdxComponentCollapseSnapshot(initial);
  const expanded = nextMdxComponentCollapseSnapshot(collapsed, "expanded");

  assert.equal(collapsed.globalState, "collapsed");
  assert.equal(expanded.globalState, "expanded");

  const collapsedResult = renderMdxNodeViewSavePathUnderCollapse({
    body,
    snapshot: collapsed,
  });
  const expandedResult = renderMdxNodeViewSavePathUnderCollapse({
    body,
    snapshot: expanded,
  });

  assert.deepEqual(
    [
      { state: collapsedResult.state, markdown: collapsedResult.markdown },
      { state: expandedResult.state, markdown: expandedResult.markdown },
    ],
    [
      { state: "collapsed", markdown: body },
      { state: "expanded", markdown: body },
    ],
  );
  assert.match(
    collapsedResult.markup,
    /data-mdcms-mdx-component-collapsed="true"/,
  );
  assert.match(
    collapsedResult.markup,
    /<div(?=[^>]*data-node-view-content)(?=[^>]*data-mdcms-mdx-editable-slot="Callout")[^>]*>/,
  );
  assert.match(
    expandedResult.markup,
    /data-mdcms-mdx-component-collapsed="false"/,
  );
  assert.match(
    expandedResult.markup,
    /<div(?=[^>]*data-node-view-content)(?=[^>]*data-mdcms-mdx-editable-slot="Callout")[^>]*>/,
  );
});

test("collapse all remains available in read-only and forbidden modes", () => {
  const initialContent = [
    '<Callout type="warning">',
    "Read-only reviewers can still collapse this block.",
    "</Callout>",
  ].join("\n");
  const readOnlyButton = getCollapseToolbarButtonMarkup(
    renderToStaticMarkup(
      createElement(TipTapEditor, {
        initialContent,
        readOnly: true,
      }),
    ),
  );
  const forbiddenButton = getCollapseToolbarButtonMarkup(
    renderToStaticMarkup(
      createElement(TipTapEditor, {
        initialContent,
        forbidden: true,
      }),
    ),
  );

  assert.doesNotMatch(readOnlyButton, /\sdisabled(?:=""|\s|>)/);
  assert.doesNotMatch(forbiddenButton, /\sdisabled(?:=""|\s|>)/);
});
```

- [x] **Step 2: Run the focused test**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts
```

Expected: pass.

## Task 4: Ticket Verification and Commit

**Files:**
- Modify: `.ai/plans/2026-06-14-cms-58-collaboration-round-trip-fidelity.md`
- Possibly create a CLI-generated changeset only if production or non-runtime published package source changes are introduced.

- [x] **Step 1: Run focused CMS-58 tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts ./src/lib/markdown-pipeline.test.ts
```

Expected: pass.

- [x] **Step 2: Run workspace gates**

Run:

```bash
bun run check
bun run format:check
git diff --check
bun run changeset:check
```

Expected: all pass. If `changeset:check` fails because a production published package file changed, generate a changeset with `bun run changeset`; do not hand-write `.changeset/*.md`.

- [x] **Step 3: Commit the CMS-58 slice**

Run:

```bash
git add .ai/plans/2026-06-14-cms-58-collaboration-round-trip-fidelity.md packages/studio/src/lib/runtime-ui/components/editor/collaboration-round-trip-fidelity.test.ts
git commit -m "test(collaboration): add round-trip fidelity fixtures"
```

Expected: commit succeeds and worktree is clean.
