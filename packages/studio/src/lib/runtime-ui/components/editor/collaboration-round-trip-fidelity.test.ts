import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createEmptyCurrentPrincipalCapabilities,
  type SchemaRegistryFieldSnapshot,
} from "@mdcms/shared";

import { createDocumentEditor } from "../../../document-editor.js";
import {
  extractMarkdownFromEditor,
  roundTripMarkdown,
} from "../../../markdown-pipeline.js";
import {
  areJsonValuesEqual,
  cloneFrontmatter,
  getPropertyDescriptors,
  type ContentDocumentPageReadyState,
} from "../../pages/content-document-page-state.js";
import { MdxComponentCollapseProvider } from "./mdx-component-collapse.js";
import { MdxComponentNodeView } from "./mdx-component-node-view.js";
import {
  nextMdxComponentCollapseSnapshot,
  toggleMdxComponentCollapseSnapshot,
  type MdxComponentCollapseSnapshot,
} from "./mdx-component-collapse-state.js";
import { TipTapEditor } from "./tiptap-editor.js";

type CollaborationRoundTripFixture = {
  type: string;
  body: string;
};

const BODY_FIXTURES: CollaborationRoundTripFixture[] = [
  {
    type: "post",
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
    type: "page",
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
    type: "campaign",
    body: [
      '<section style={{"backgroundColor":"#fff"}}>',
      "<h2>",
      'Title with <span style={{"color":"#2563eb"}}>accent</span>',
      "</h2>",
      "</section>",
    ].join("\n"),
  },
  {
    type: "author",
    body: ["# Ada Lovelace", "", "Author profile copy."].join("\n"),
  },
];

type FrontmatterFixture = {
  type: string;
  frontmatter: Record<string, unknown>;
  fields: Record<string, SchemaRegistryFieldSnapshot>;
  editableFields: string[];
  unsupportedFields: string[];
};

const FRONTMATTER_FIXTURES: FrontmatterFixture[] = [
  {
    type: "post",
    frontmatter: {
      title: "Product Update",
      slug: "product-update",
      featured: true,
      abTestVariant: "control",
      author: "11111111-1111-4111-8111-111111111111",
    },
    fields: {
      title: { kind: "string", required: true, nullable: false },
      slug: { kind: "string", required: true, nullable: false },
      featured: { kind: "boolean", required: false, nullable: false },
      abTestVariant: {
        kind: "string",
        required: false,
        nullable: true,
      },
      author: {
        kind: "string",
        required: false,
        nullable: true,
        reference: { targetType: "author" },
      },
    },
    editableFields: ["abTestVariant", "author", "featured", "slug", "title"],
    unsupportedFields: [],
  },
  {
    type: "author",
    frontmatter: {
      name: "Ada Lovelace",
    },
    fields: {
      name: { kind: "string", required: true, nullable: false },
    },
    editableFields: ["name"],
    unsupportedFields: [],
  },
  {
    type: "page",
    frontmatter: {
      title: "Launch",
    },
    fields: {
      title: { kind: "string", required: true, nullable: false },
    },
    editableFields: ["title"],
    unsupportedFields: [],
  },
  {
    type: "campaign",
    frontmatter: {
      title: "Summer Campaign",
      slug: "summer-campaign",
      summary: "Localized launch copy.",
    },
    fields: {
      title: {
        kind: "string",
        required: true,
        nullable: false,
      },
      slug: {
        kind: "string",
        required: true,
        nullable: false,
      },
      summary: {
        kind: "string",
        required: true,
        nullable: false,
      },
    },
    editableFields: ["slug", "summary", "title"],
    unsupportedFields: [],
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
    publishUnsavedPromptOpen: false,
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

test("collaboration body fixtures round-trip byte-for-byte", () => {
  assert.deepEqual(BODY_FIXTURES.map((fixture) => fixture.type).sort(), [
    "author",
    "campaign",
    "page",
    "post",
  ]);

  for (const fixture of BODY_FIXTURES) {
    assert.equal(
      roundTripMarkdown(fixture.body).markdown,
      fixture.body,
      `${fixture.type} body must not produce a phantom collaboration diff`,
    );
    assert.equal(
      extractMarkdownFromSaveEditor(fixture.body),
      fixture.body,
      `${fixture.type} editor save path must not produce a phantom collaboration diff`,
    );
  }
});

test("collaboration frontmatter fixtures preserve supported values", () => {
  assert.deepEqual(FRONTMATTER_FIXTURES.map((fixture) => fixture.type).sort(), [
    "author",
    "campaign",
    "page",
    "post",
  ]);

  for (const fixture of FRONTMATTER_FIXTURES) {
    const cloned = cloneFrontmatter(fixture.frontmatter);
    assert.notEqual(cloned, fixture.frontmatter);
    assert.equal(
      areJsonValuesEqual(cloned, fixture.frontmatter),
      true,
      `${fixture.type} frontmatter clone must preserve JSON values`,
    );

    const descriptors = getPropertyDescriptors(
      createFixtureReadyState(fixture),
    );
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
