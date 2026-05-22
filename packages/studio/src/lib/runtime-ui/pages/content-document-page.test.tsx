import assert from "node:assert/strict";

import { test } from "bun:test";
import {
  RuntimeError,
  type SchemaRegistryEntry,
  type StudioMountContext,
  createEmptyCurrentPrincipalCapabilities,
} from "@mdcms/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioDocumentShell } from "../../document-shell.js";
import { StudioNavigationProvider } from "../navigation.js";
import {
  applyFailedDraftSaveToReadyState,
  applyAssistantProposalDocumentToReadyState,
  applySuccessfulPublishToReadyState,
  applySuccessfulDraftSaveToReadyState,
  applySchemaStateToReadyState,
  ContentDocumentPageView,
  createContentDocumentRouteRequestToken,
  createContentDocumentPageState,
  filterLocaleOptions,
  loadContentDocumentPageState,
  loadContentDocumentVersionDiff,
  matchesContentDocumentRouteRequestToken,
  parseSelectedComparisonVersionValue,
  publishContentDocumentReadyState,
  reloadSchemaStateForGuard,
  resolveActiveDocumentRouteContext,
  reduceContentDocumentPageReadyState,
  saveContentDocumentReadyState,
  SidebarInfoTab,
  syncSchemaStateForGuard,
} from "./content-document-page.js";

function createReadyShell(
  overrides: Partial<StudioDocumentShell["data"]> = {},
): StudioDocumentShell {
  const { draftRevision = 8, ...dataOverrides } = overrides;
  return {
    state: "ready",
    type: "BlogPost",
    documentId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    data: {
      documentId: "11111111-1111-4111-8111-111111111111",
      type: "BlogPost",
      locale: "en",
      path: "blog/launch-notes",
      format: "mdx",
      frontmatter: {
        title: "Launch Notes",
      },
      body: "# Launch Notes",
      updatedAt: "2026-03-27T12:00:00.000Z",
      hasUnpublishedChanges: true,
      publishedVersion: 5,
      draftRevision,
      ...dataOverrides,
    },
  };
}

function createErrorShell(
  errorCode: StudioDocumentShell["errorCode"],
  errorMessage = "Route failed",
): StudioDocumentShell {
  return {
    state: "error",
    type: "BlogPost",
    documentId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    errorCode,
    errorMessage,
  };
}

function renderPageMarkup(
  state: Parameters<typeof ContentDocumentPageView>[0]["state"],
  props: Partial<
    Omit<Parameters<typeof ContentDocumentPageView>[0], "state">
  > = {},
): string {
  return renderToStaticMarkup(
    createElement(
      StudioNavigationProvider,
      {
        value: {
          pathname:
            "/admin/content/BlogPost/11111111-1111-4111-8111-111111111111",
          params: {
            type: "BlogPost",
            documentId: "11111111-1111-4111-8111-111111111111",
          },
          push: () => {},
          replace: () => {},
          back: () => {},
        },
      },
      createElement(ContentDocumentPageView, {
        state,
        ...props,
      }),
    ),
  );
}

function renderInfoTabMarkup(
  state: ReturnType<typeof createReadyState>,
): string {
  return renderToStaticMarkup(createElement(SidebarInfoTab, { state }));
}

function createReadyState(
  overrides: Partial<
    Extract<
      ReturnType<typeof createContentDocumentPageState>,
      { status: "ready" }
    >
  > = {},
) {
  const state = createContentDocumentPageState({
    shell: createReadyShell(),
    typeId: "BlogPost",
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  });

  if (state.status !== "ready") {
    throw new Error("expected ready state");
  }

  return {
    ...state,
    ...overrides,
  };
}

type ReadySchemaState = Extract<
  NonNullable<ReturnType<typeof createReadyState>["schemaState"]>,
  { status: "ready" }
>;

function createReadySchemaState(
  overrides: Partial<ReadySchemaState> = {},
): ReadySchemaState {
  return {
    status: "ready" as const,
    project: "marketing-site",
    environment: "staging",
    localSchemaHash: "local-hash",
    serverSchemaHash: "local-hash",
    isMismatch: false,
    hasLocalSyncPayload: true,
    canSync: true,
    capabilities: {
      ...createEmptyCurrentPrincipalCapabilities(),
      schema: {
        read: true,
        write: true,
      },
    },
    entries: [],
    reload: async (): Promise<ReadySchemaState> =>
      createReadySchemaState(overrides),
    sync: async (): Promise<ReadySchemaState> =>
      createReadySchemaState(overrides),
    ...overrides,
  };
}

function createSchemaEntry(
  fields: SchemaRegistryEntry["resolvedSchema"]["fields"],
): SchemaRegistryEntry {
  return {
    type: "BlogPost",
    directory: "content/blog",
    localized: true,
    schemaHash: "local-hash",
    syncedAt: "2026-03-27T12:00:00.000Z",
    resolvedSchema: {
      type: "BlogPost",
      directory: "content/blog",
      localized: true,
      fields,
    },
  };
}

function createRouteContext(canWrite = true) {
  return {
    project: "marketing-site",
    initialEnvironment: "staging",
    write: canWrite
      ? {
          canWrite: true as const,
          schemaHash: "schema-hash",
        }
      : {
          canWrite: false as const,
          message: "Schema sync required before Studio can write drafts.",
        },
  };
}

function createMountContext(canWrite = true) {
  return {
    apiBaseUrl: "https://cms.example.com",
    basePath: "/admin",
    auth: {
      mode: "cookie" as const,
    },
    hostBridge: {
      version: "1" as const,
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    documentRoute: createRouteContext(canWrite),
  };
}

function createMdxMountContext(): StudioMountContext {
  return {
    ...createMountContext(),
    mdx: {
      catalog: {
        components: [
          {
            name: "PricingTable",
            importPath: "@/components/mdx/PricingTable",
            propsEditor: "@/components/mdx/PricingTable.editor",
          },
        ],
      },
      resolvePropsEditor: async () => null,
    },
  };
}

function createVersionSummary(
  version: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    translationGroupId: "22222222-2222-4222-8222-222222222222",
    project: "marketing-site",
    environment: "staging",
    version,
    path: "blog/launch-notes",
    type: "BlogPost",
    locale: "en",
    format: "mdx" as const,
    publishedAt: `2026-03-0${version}T10:00:00.000Z`,
    publishedBy: `33333333-3333-4333-8333-33333333333${version}`,
    ...overrides,
  };
}

function createVersionDocument(
  version: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...createVersionSummary(version),
    frontmatter: {
      title: `Launch Notes v${version}`,
    },
    body: `# Launch Notes\nVersion ${version}`,
    ...overrides,
  };
}

function createDocumentResponse(overrides: Record<string, unknown> = {}) {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    translationGroupId: "22222222-2222-4222-8222-222222222222",
    project: "marketing-site",
    environment: "staging",
    path: "blog/launch-notes",
    type: "BlogPost",
    locale: "en",
    format: "mdx" as const,
    isDeleted: false,
    hasUnpublishedChanges: true,
    version: 5,
    publishedVersion: 5,
    draftRevision: 8,
    frontmatter: {
      title: "Launch Notes",
    },
    body: "# Launch Notes",
    createdBy: "33333333-3333-4333-8333-333333333331",
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedBy: "33333333-3333-4333-8333-333333333331",
    updatedAt: "2026-03-27T12:00:00.000Z",
    ...overrides,
  };
}

test("createContentDocumentPageState maps shell loading and error states into view states", () => {
  const loading = createContentDocumentPageState({
    shell: {
      state: "loading",
      type: "BlogPost",
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
    },
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  });
  const forbidden = createContentDocumentPageState({
    shell: createErrorShell("FORBIDDEN", "Forbidden"),
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  });
  const notFound = createContentDocumentPageState({
    shell: createErrorShell("NOT_FOUND", "Document not found"),
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  });
  const genericError = createContentDocumentPageState({
    shell: createErrorShell("DOCUMENT_LOAD_FAILED", "Draft load failed"),
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: true,
        schemaHash: "schema-hash",
      },
    },
  });

  assert.equal(loading.status, "loading");
  assert.equal(forbidden.status, "forbidden");
  assert.equal(notFound.status, "not-found");
  assert.equal(genericError.status, "error");
});

test("ContentDocumentPageView renders document route loading and failure states", () => {
  const loadingMarkup = renderPageMarkup(
    createContentDocumentPageState({
      shell: {
        state: "loading",
        type: "BlogPost",
        documentId: "11111111-1111-4111-8111-111111111111",
        locale: "en",
      },
      typeLabel: "Blog post",
      documentRoute: {
        project: "marketing-site",
        initialEnvironment: "staging",
        write: {
          canWrite: true,
          schemaHash: "schema-hash",
        },
      },
    }),
  );
  const forbiddenMarkup = renderPageMarkup(
    createContentDocumentPageState({
      shell: createErrorShell("FORBIDDEN", "Forbidden"),
      typeLabel: "Blog post",
      documentRoute: {
        project: "marketing-site",
        initialEnvironment: "staging",
        write: {
          canWrite: true,
          schemaHash: "schema-hash",
        },
      },
    }),
  );
  const notFoundMarkup = renderPageMarkup(
    createContentDocumentPageState({
      shell: createErrorShell("NOT_FOUND", "Document not found"),
      typeLabel: "Blog post",
      documentRoute: {
        project: "marketing-site",
        initialEnvironment: "staging",
        write: {
          canWrite: true,
          schemaHash: "schema-hash",
        },
      },
    }),
  );
  const errorMarkup = renderPageMarkup(
    createContentDocumentPageState({
      shell: createErrorShell("DOCUMENT_LOAD_FAILED", "Draft load failed"),
      typeLabel: "Blog post",
      documentRoute: {
        project: "marketing-site",
        initialEnvironment: "staging",
        write: {
          canWrite: true,
          schemaHash: "schema-hash",
        },
      },
    }),
  );

  assert.match(loadingMarkup, /data-mdcms-document-state="loading"/);
  assert.match(loadingMarkup, /Loading document draft/);
  assert.doesNotMatch(loadingMarkup, />Draft</);
  assert.doesNotMatch(loadingMarkup, />Publish</);
  assert.match(forbiddenMarkup, /data-mdcms-document-state="forbidden"/);
  assert.match(
    forbiddenMarkup,
    /You do not have access to this document draft/,
  );
  assert.doesNotMatch(forbiddenMarkup, />Draft</);
  assert.match(notFoundMarkup, /data-mdcms-document-state="not-found"/);
  assert.match(notFoundMarkup, /Document not found/);
  assert.doesNotMatch(notFoundMarkup, />Draft</);
  assert.match(errorMarkup, /data-mdcms-document-state="error"/);
  assert.match(errorMarkup, /Draft load failed/);
  assert.doesNotMatch(errorMarkup, />Draft</);
});

test("ContentDocumentPageView renders guarded schema mismatch recovery controls", () => {
  const markup = renderPageMarkup({
    ...createReadyState(),
    canWrite: false,
    writeMessage:
      "Schema changes detected. Studio is read-only until schema sync resolves the mismatch.",
    schemaState: createReadySchemaState({
      serverSchemaHash: "server-hash",
      isMismatch: true,
    }),
  } as unknown as Parameters<typeof ContentDocumentPageView>[0]["state"]);

  assert.match(markup, /Schema changes detected/);
  assert.match(markup, /data-mdcms-schema-recovery-state="mismatch"/);
  assert.match(markup, /Local schema hash/);
  assert.match(markup, /local-hash/);
  assert.match(markup, /Server schema hash/);
  assert.match(markup, /server-hash/);
  assert.match(markup, /Sync Schema/);
});

test("ContentDocumentPageView keeps the dedicated Component tab hidden until an MDX component is selected", () => {
  const state = createReadyState();
  state.schemaState = createReadySchemaState({
    entries: [
      createSchemaEntry({
        title: {
          kind: "string",
          required: true,
          nullable: false,
        },
      }),
    ],
  });
  state.document.frontmatter = {
    title: "Launch Notes",
  };
  state.draftFrontmatter = {
    ...state.document.frontmatter,
  };

  const markup = renderPageMarkup(state, {
    context: createMdxMountContext(),
    sidebarOpen: true,
  });

  assert.doesNotMatch(markup, /data-mdcms-sidebar-tab="component"/);
  assert.match(markup, /data-mdcms-property-field="title"/);
  assert.doesNotMatch(markup, /data-mdcms-mdx-props-panel="PricingTable"/);
});

test("ContentDocumentPageView starts with the right document sidebar collapsed by default", () => {
  const markup = renderPageMarkup(createReadyState());

  assert.match(markup, /data-mdcms-document-properties-handle="true"/);
  assert.doesNotMatch(
    markup,
    /data-mdcms-document-properties-overlay="docked"/,
  );
  assert.doesNotMatch(
    markup,
    /data-mdcms-document-properties-overlay="slide-over"/,
  );
});

test("ContentDocumentPageView renders the active MDX component props panel in a dedicated Component tab", () => {
  const state = createReadyState();
  state.schemaState = createReadySchemaState({
    entries: [
      createSchemaEntry({
        title: {
          kind: "string",
          required: true,
          nullable: false,
        },
      }),
    ],
  });
  state.document.frontmatter = {
    title: "Launch Notes",
  };
  state.draftFrontmatter = {
    ...state.document.frontmatter,
  };

  const markup = renderPageMarkup(state, {
    context: createMdxMountContext(),
    sidebarOpen: true,
    activeMdxComponent: {
      component: createMdxMountContext().mdx!.catalog.components[0]!,
      componentName: "PricingTable",
      isVoid: true,
      props: {},
      readOnly: false,
      forbidden: false,
      onPropsChange: () => {},
    },
  });

  assert.match(markup, /data-mdcms-sidebar-tab="component"/);
  assert.match(markup, /data-mdcms-mdx-props-panel="PricingTable"/);
  assert.match(markup, /MDX component props/);
  assert.doesNotMatch(markup, /data-mdcms-property-field="title"/);
});

test("loadContentDocumentPageState applies the schema mismatch guard before returning the ready document state", async () => {
  const next = await loadContentDocumentPageState({
    context: createMountContext(),
    typeId: "BlogPost",
    typeLabel: "Blog post",
    documentId: "11111111-1111-4111-8111-111111111111",
    loadDocumentShell: async () => createReadyShell(),
    loadSchemaState: async () =>
      createReadySchemaState({
        serverSchemaHash: "server-hash",
        isMismatch: true,
        reload: async () =>
          createReadySchemaState({
            serverSchemaHash: "server-hash",
            isMismatch: true,
          }),
        sync: async () =>
          createReadySchemaState({
            serverSchemaHash: "server-hash",
            isMismatch: false,
          }),
      }),
    createRouteApi: () => ({
      listVersions: async () => ({
        data: [createVersionSummary(3), createVersionSummary(1)],
        pagination: {
          total: 2,
          limit: 20,
          offset: 0,
          hasMore: false,
        },
      }),
      listVariants: async () => ({ data: [] }),
    }),
  } as any);

  assert.equal(next.status, "ready");
  if (next.status !== "ready") {
    throw new Error("expected ready state");
  }

  assert.equal(next.canWrite, false);
  assert.match(
    next.writeMessage ?? "",
    /Schema changes detected\. Studio is read-only until schema sync resolves the mismatch\./,
  );
  assert.equal((next as any).schemaState?.isMismatch, true);
  assert.equal(next.versionHistory.status, "ready");
});

test("reloadSchemaStateForGuard logs and returns undefined when schema reload fails", async () => {
  const logged: unknown[] = [];
  const next = await reloadSchemaStateForGuard(
    {
      ...createReadyState(),
      schemaState: createReadySchemaState({
        reload: async () => {
          throw new Error("reload failed");
        },
      }),
    },
    (...args) => {
      logged.push(args);
    },
  );

  assert.equal(next, undefined);
  assert.equal(logged.length, 1);
  assert.equal((logged[0] as unknown[])[0], "reloadSchemaStateForGuard failed");
  assert.equal(((logged[0] as unknown[])[1] as Error).message, "reload failed");
});

test("syncSchemaStateForGuard logs and returns undefined when schema sync fails", async () => {
  const logged: unknown[] = [];
  const next = await syncSchemaStateForGuard(
    createReadySchemaState({
      sync: async () => {
        throw new Error("sync failed");
      },
    }),
    (...args) => {
      logged.push(args);
    },
  );

  assert.equal(next, undefined);
  assert.equal(logged.length, 1);
  assert.equal((logged[0] as unknown[])[0], "syncSchemaStateForGuard failed");
  assert.equal(((logged[0] as unknown[])[1] as Error).message, "sync failed");
});

test("applySchemaStateToReadyState keeps the current draft visible when schema sync fails", () => {
  const initial = createReadyState();
  const next = applySchemaStateToReadyState({
    state: initial,
    schemaState: createReadySchemaState({
      serverSchemaHash: "server-hash",
      isMismatch: true,
      syncError: "Forbidden.",
    }) as any,
  });

  assert.equal(next.document.body, initial.document.body);
  assert.equal(next.draftBody, initial.draftBody);
  assert.equal(next.canWrite, false);
  assert.match(
    next.writeMessage ?? "",
    /Schema changes detected\. Studio is read-only until schema sync resolves the mismatch\./,
  );
  if (next.schemaState?.status !== "ready") {
    throw new Error("expected ready schema state");
  }

  assert.equal(next.schemaState.syncError, "Forbidden.");
});

test("reduceContentDocumentPageReadyState moves draft edits through unsaved, saving, and saved", () => {
  const initial = createReadyState();

  const unsaved = reduceContentDocumentPageReadyState(initial, {
    type: "draftChanged",
    body: "# Launch Notes\nUpdated",
  });
  const saving = reduceContentDocumentPageReadyState(unsaved, {
    type: "saveStarted",
  });
  const saved = reduceContentDocumentPageReadyState(saving, {
    type: "saveSucceeded",
    updatedAt: "2026-03-27T12:05:00.000Z",
  });

  assert.equal(unsaved.saveState, "unsaved");
  assert.equal(saving.saveState, "saving");
  assert.equal(saved.saveState, "saved");
  assert.equal(saved.document.updatedAt, "2026-03-27T12:05:00.000Z");
  assert.equal(saved.draftBody, "# Launch Notes\nUpdated");
});

test("createContentDocumentPageState keeps routed frontmatter and format in ready state", () => {
  const state = createContentDocumentPageState({
    shell: createReadyShell({
      format: "md",
      frontmatter: {
        title: "Launch Notes",
        seo: {
          slug: "launch-notes",
        },
      },
    }),
    typeLabel: "Blog post",
    documentRoute: createRouteContext(),
  });

  assert.equal(state.status, "ready");
  if (state.status !== "ready") {
    throw new Error("expected ready state");
  }

  assert.equal(state.document.format, "md");
  assert.deepEqual(state.document.frontmatter, {
    title: "Launch Notes",
    seo: {
      slug: "launch-notes",
    },
  });
  assert.deepEqual(state.draftFrontmatter, {
    title: "Launch Notes",
    seo: {
      slug: "launch-notes",
    },
  });
});

test("reduceContentDocumentPageReadyState marks frontmatter edits as unsaved and updates the draft frontmatter", () => {
  const initial = createReadyState();

  const next = reduceContentDocumentPageReadyState(initial, {
    type: "frontmatterFieldChanged",
    fieldName: "title",
    value: "Updated Launch Notes",
  });

  assert.equal(next.saveState, "unsaved");
  assert.deepEqual(next.draftFrontmatter, {
    title: "Updated Launch Notes",
  });
  assert.deepEqual(initial.document.frontmatter, {
    title: "Launch Notes",
  });
});

test("reduceContentDocumentPageReadyState keeps the unsaved draft body and surfaces mutation feedback on save failure", () => {
  const initial = createReadyState();

  const unsaved = reduceContentDocumentPageReadyState(initial, {
    type: "draftChanged",
    body: "# Launch Notes\nUnsaved",
  });
  const failed = reduceContentDocumentPageReadyState(unsaved, {
    type: "saveFailed",
    message: "Draft update failed.",
  });

  assert.equal(failed.saveState, "unsaved");
  assert.equal(failed.draftBody, "# Launch Notes\nUnsaved");
  assert.equal(failed.mutationError, "Draft update failed.");
});

test("applySuccessfulDraftSaveToReadyState preserves newer unsaved edits when an earlier save resolves", () => {
  const initial = createReadyState();
  const saving = reduceContentDocumentPageReadyState(
    reduceContentDocumentPageReadyState(initial, {
      type: "draftChanged",
      body: "# Launch Notes\nSaved edit",
    }),
    {
      type: "saveStarted",
    },
  );
  const withNewerEdit = reduceContentDocumentPageReadyState(saving, {
    type: "draftChanged",
    body: "# Launch Notes\nNewer edit",
  });

  const next = applySuccessfulDraftSaveToReadyState({
    state: withNewerEdit,
    requestBody: "# Launch Notes\nSaved edit",
    updatedAt: "2026-03-27T12:06:00.000Z",
  });

  assert.equal(next.document.body, "# Launch Notes\nSaved edit");
  assert.equal(next.draftBody, "# Launch Notes\nNewer edit");
  assert.equal(next.saveState, "unsaved");
  assert.equal(next.mutationError, undefined);
});

test("applyAssistantProposalDocumentToReadyState adopts the assistant-applied draft as saved", () => {
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "draftChanged",
    body: "# Launch Notes\nLocal edit",
  });

  const next = applyAssistantProposalDocumentToReadyState({
    state: initial,
    document: createDocumentResponse({
      body: "# Launch Notes\nAssistant edit",
      frontmatter: {
        title: "Assistant Launch Notes",
      },
      draftRevision: 9,
      updatedAt: "2026-03-27T12:07:00.000Z",
    }),
  });

  assert.equal(next.draftBody, "# Launch Notes\nAssistant edit");
  assert.deepEqual(next.draftFrontmatter, {
    title: "Assistant Launch Notes",
  });
  assert.equal(next.document.body, "# Launch Notes\nAssistant edit");
  assert.equal(next.document.draftRevision, 9);
  assert.equal(next.saveState, "saved");
  assert.equal(next.mutationError, undefined);
});

test("loadContentDocumentPageState loads the routed draft and version history", async () => {
  const shellCalls: Array<Record<string, unknown>> = [];
  const versionCalls: Array<Record<string, unknown>> = [];

  const next = await loadContentDocumentPageState({
    context: createMountContext(),
    typeId: "BlogPost",
    typeLabel: "Blog post",
    documentId: "11111111-1111-4111-8111-111111111111",
    loadDocumentShell: async (config, target, options) => {
      shellCalls.push({
        project: config.project,
        environment: config.environment,
        serverUrl: config.serverUrl,
        type: target.type,
        documentId: target.documentId,
        authMode: options?.auth?.mode,
      });

      return createReadyShell();
    },
    createRouteApi: () => ({
      listVersions: async (input) => {
        versionCalls.push(input as Record<string, unknown>);

        return {
          data: [createVersionSummary(3), createVersionSummary(1)],
          pagination: {
            total: 2,
            limit: 20,
            offset: 0,
            hasMore: false,
          },
        };
      },
      listVariants: async () => ({ data: [] }),
    }),
  });

  assert.equal(shellCalls[0]?.project, "marketing-site");
  assert.equal(shellCalls[0]?.environment, "staging");
  assert.equal(shellCalls[0]?.type, "BlogPost");
  assert.equal(
    versionCalls[0]?.documentId,
    "11111111-1111-4111-8111-111111111111",
  );

  if (next.status !== "ready") {
    throw new Error("expected ready state");
  }

  assert.equal(next.versionHistory.status, "ready");
  assert.deepEqual(
    next.versionHistory.versions.map((version) => version.version),
    [3, 1],
  );
  assert.deepEqual(next.selectedComparison, {
    leftVersion: 1,
    rightVersion: 3,
  });
});

test("saveContentDocumentReadyState persists routed draft updates through the content mutation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "draftChanged",
    body: "# Launch Notes\nUpdated",
  });

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async (input) => {
        calls.push(input as Record<string, unknown>);

        return createDocumentResponse({
          body: "# Launch Notes\nUpdated",
          hasUnpublishedChanges: true,
          draftRevision: 9,
          updatedAt: "2026-03-27T12:05:00.000Z",
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(calls[0]?.documentId, initial.documentId);
  assert.equal(calls[0]?.locale, initial.document.locale);
  assert.equal(calls[0]?.schemaHash, "schema-hash");
  assert.deepEqual(calls[0]?.payload, {
    body: "# Launch Notes\nUpdated",
    frontmatter: {
      title: "Launch Notes",
    },
  });
  assert.equal(next.saveState, "saved");
  assert.equal(next.document.body, "# Launch Notes\nUpdated");
  assert.equal(next.document.draftRevision, 9);
  assert.equal(next.document.updatedAt, "2026-03-27T12:05:00.000Z");
});

test("saveContentDocumentReadyState persists draft frontmatter changes and preserves unsupported values", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const initial = reduceContentDocumentPageReadyState(
    createReadyState({
      document: {
        ...createReadyState().document,
        frontmatter: {
          title: "Launch Notes",
          seo: {
            slug: "launch-notes",
          },
        },
      },
      draftFrontmatter: {
        title: "Launch Notes",
        seo: {
          slug: "launch-notes",
        },
      },
    }),
    {
      type: "frontmatterFieldChanged",
      fieldName: "title",
      value: "Updated Launch Notes",
    },
  );

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async (input) => {
        calls.push(input as Record<string, unknown>);

        return createDocumentResponse({
          frontmatter: {
            title: "Updated Launch Notes",
            seo: {
              slug: "launch-notes",
            },
          },
          updatedAt: "2026-03-27T12:05:00.000Z",
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.deepEqual(calls[0]?.payload, {
    body: "# Launch Notes",
    frontmatter: {
      title: "Updated Launch Notes",
      seo: {
        slug: "launch-notes",
      },
    },
  });
  assert.deepEqual(next.document.frontmatter, {
    title: "Updated Launch Notes",
    seo: {
      slug: "launch-notes",
    },
  });
  assert.deepEqual(next.draftFrontmatter, {
    title: "Updated Launch Notes",
    seo: {
      slug: "launch-notes",
    },
  });
});

test("saveContentDocumentReadyState applies the normalized body returned by the server", async () => {
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "draftChanged",
    body: "  # Launch Notes  ",
  });

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () =>
        createDocumentResponse({
          body: "# Launch Notes",
          hasUnpublishedChanges: true,
          updatedAt: "2026-03-27T12:05:30.000Z",
        }),
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(next.document.body, "# Launch Notes");
  assert.equal(next.draftBody, "# Launch Notes");
  assert.equal(next.saveState, "saved");
});

test("saveContentDocumentReadyState keeps the unsaved draft when the routed update returns a validation failure", async () => {
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "draftChanged",
    body: "# Launch Notes\nInvalid",
  });

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () => {
        throw new RuntimeError({
          code: "VALIDATION_ERROR",
          message: "Path must be unique.",
          statusCode: 400,
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(next.saveState, "unsaved");
  assert.equal(next.draftBody, "# Launch Notes\nInvalid");
  assert.equal(next.document.body, "# Launch Notes");
  assert.equal(next.mutationError, "Path must be unique.");
});

test("saveContentDocumentReadyState anchors mapped frontmatter validation failures to the field state", async () => {
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "frontmatterFieldChanged",
    fieldName: "author",
    value: "not-a-valid-reference",
  });

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () => {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            'Field "frontmatter.author" must reference an "Author" document.',
          statusCode: 400,
          details: {
            field: "frontmatter.author",
          },
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(next.mutationError, undefined);
  assert.deepEqual(next.fieldErrors, {
    author: 'Field "frontmatter.author" must reference an "Author" document.',
  });
  assert.equal(next.saveState, "unsaved");
});

test("saveContentDocumentReadyState surfaces forbidden routed draft updates without pretending the draft persisted", async () => {
  const initial = reduceContentDocumentPageReadyState(createReadyState(), {
    type: "draftChanged",
    body: "# Launch Notes\nForbidden",
  });

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () => {
        throw new RuntimeError({
          code: "FORBIDDEN",
          message: "You do not have permission to update this draft.",
          statusCode: 403,
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(next.saveState, "unsaved");
  assert.equal(next.draftBody, "# Launch Notes\nForbidden");
  assert.equal(next.document.body, "# Launch Notes");
  assert.equal(
    next.mutationError,
    "You do not have permission to update this draft.",
  );
});

test("saveContentDocumentReadyState maps schema hash mismatches into guarded recovery instead of a generic save error", async () => {
  const initial = reduceContentDocumentPageReadyState(
    {
      ...createReadyState(),
      schemaState: createReadySchemaState({
        reload: async () =>
          createReadySchemaState({
            serverSchemaHash: "server-hash",
            isMismatch: true,
          }),
      }),
    },
    {
      type: "draftChanged",
      body: "# Launch Notes\nSchema changed",
    },
  );

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () => {
        throw new RuntimeError({
          code: "SCHEMA_HASH_MISMATCH",
          message: "Schema hash mismatch.",
          statusCode: 409,
        });
      },
    },
    route: createRouteContext(),
    state: initial,
  });

  assert.equal(next.canWrite, false);
  assert.equal(next.mutationError, undefined);
  assert.equal(next.saveState, "unsaved");
  assert.match(
    next.writeMessage ?? "",
    /Schema changes detected\. Studio is read-only until schema sync resolves the mismatch\./,
  );
  if (next.schemaState?.status !== "ready") {
    throw new Error("expected ready schema recovery state");
  }
  assert.equal(next.schemaState.isMismatch, true);
  assert.equal(next.schemaState.serverSchemaHash, "server-hash");
});

test("publishContentDocumentReadyState submits optional change summary and refreshes version history", async () => {
  const initial = createReadyState();
  const publishCalls: Array<Record<string, unknown>> = [];
  const listCalls: Array<Record<string, unknown>> = [];

  const next = await publishContentDocumentReadyState({
    api: {
      publish: async (input) => {
        publishCalls.push(input as Record<string, unknown>);

        return createDocumentResponse({
          hasUnpublishedChanges: false,
          publishedVersion: 6,
          version: 6,
          updatedAt: "2026-03-27T12:10:00.000Z",
        });
      },
      listVersions: async (input) => {
        listCalls.push(input as Record<string, unknown>);

        return {
          data: [
            createVersionSummary(6, {
              changeSummary: "Ready for launch.",
            }),
            createVersionSummary(5),
          ],
          pagination: {
            total: 2,
            limit: 20,
            offset: 0,
            hasMore: false,
          },
        };
      },
    },
    state: initial,
    changeSummary: "Ready for launch.",
  });

  assert.equal(publishCalls[0]?.documentId, initial.documentId);
  assert.equal(publishCalls[0]?.locale, initial.locale);
  assert.equal(publishCalls[0]?.changeSummary, "Ready for launch.");
  assert.equal(listCalls[0]?.documentId, initial.documentId);
  assert.equal(next.document.publishedVersion, 6);
  assert.equal(next.document.hasUnpublishedChanges, false);
  assert.equal(next.versionHistory.status, "ready");
  assert.deepEqual(
    next.versionHistory.versions.map((version) => version.version),
    [6, 5],
  );
});

test("publishContentDocumentReadyState keeps the published draft state when version history refresh fails", async () => {
  const initial = createReadyState();

  const next = await publishContentDocumentReadyState({
    api: {
      publish: async () =>
        createDocumentResponse({
          hasUnpublishedChanges: false,
          publishedVersion: 6,
          version: 6,
          updatedAt: "2026-03-27T12:10:00.000Z",
        }),
      listVersions: async () => {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Version history temporarily unavailable.",
          statusCode: 500,
        });
      },
    },
    state: initial,
    changeSummary: "Ready for launch.",
  });

  assert.equal(next.document.publishedVersion, 6);
  assert.equal(next.document.hasUnpublishedChanges, false);
  assert.equal(next.publishDialogOpen, false);
  assert.equal(next.publishError, undefined);
  assert.deepEqual(next.selectedComparison, {});
  assert.deepEqual(next.versionDiff, {
    status: "idle",
  });

  if (next.versionHistory.status !== "error") {
    throw new Error("expected version history refresh error state");
  }

  assert.equal(
    next.versionHistory.message,
    "Version history temporarily unavailable.",
  );
});

test("publishContentDocumentReadyState maps SCHEMA_NOT_SYNCED into guarded recovery instead of a generic publish error", async () => {
  const initial = {
    ...createReadyState(),
    schemaState: createReadySchemaState({
      reload: async () =>
        createReadySchemaState({
          serverSchemaHash: undefined,
          entries: [],
        }),
    }),
  };

  const next = await publishContentDocumentReadyState({
    api: {
      publish: async () => {
        throw new RuntimeError({
          code: "SCHEMA_NOT_SYNCED",
          message: "Schema must be synced before content writes.",
          statusCode: 409,
        });
      },
      listVersions: async () => ({
        data: [],
        pagination: {
          total: 0,
          limit: 20,
          offset: 0,
          hasMore: false,
        },
      }),
    },
    state: initial,
    changeSummary: "Blocked by schema sync.",
  });

  assert.equal(next.canWrite, false);
  assert.equal(next.publishError, undefined);
  assert.equal(next.publishState, "idle");
  assert.equal(next.publishDialogOpen, false);
  assert.match(
    next.writeMessage ?? "",
    /Schema changes detected\. Studio is read-only until schema sync resolves the mismatch\./,
  );
  if (next.schemaState?.status !== "ready") {
    throw new Error("expected ready schema recovery state");
  }
  assert.equal(next.schemaState.serverSchemaHash, undefined);
  assert.deepEqual(next.schemaState.entries, []);
});

test("applySuccessfulPublishToReadyState preserves newer local edits made while publish was in flight", () => {
  const requestState = createReadyState();
  const currentState = reduceContentDocumentPageReadyState(requestState, {
    type: "draftChanged",
    body: "# Launch Notes\nNewer local edit",
  });
  const publishedState = {
    ...requestState,
    document: {
      ...requestState.document,
      hasUnpublishedChanges: false,
      publishedVersion: 6,
      updatedAt: "2026-03-27T12:12:00.000Z",
    },
    publishDialogOpen: false,
    publishChangeSummary: "",
    publishState: "idle" as const,
    publishError: undefined,
    versionHistory: {
      status: "ready" as const,
      versions: [createVersionSummary(6), createVersionSummary(5)],
    },
    selectedComparison: {
      leftVersion: 5,
      rightVersion: 6,
    },
    versionDiff: {
      status: "idle" as const,
    },
  };

  const next = applySuccessfulPublishToReadyState({
    state: currentState,
    requestBody: requestState.draftBody,
    publishedState,
  });

  assert.equal(next.document.publishedVersion, 6);
  assert.equal(next.document.body, requestState.document.body);
  assert.equal(next.draftBody, "# Launch Notes\nNewer local edit");
  assert.equal(next.saveState, "unsaved");
  assert.equal(next.publishDialogOpen, false);
  assert.deepEqual(next.selectedComparison, {
    leftVersion: 5,
    rightVersion: 6,
  });
});

test("applyFailedDraftSaveToReadyState keeps the same draft eligible for autosave retry", async () => {
  const requestBody = "# Launch Notes\nRetry me";
  const saving = reduceContentDocumentPageReadyState(
    reduceContentDocumentPageReadyState(createReadyState(), {
      type: "draftChanged",
      body: requestBody,
    }),
    {
      type: "saveStarted",
    },
  );
  const failed = applyFailedDraftSaveToReadyState({
    state: saving,
    requestBody,
    message: "Temporary save failure.",
  });
  let saveCalls = 0;

  const next = await saveContentDocumentReadyState({
    api: {
      updateDraft: async () => {
        saveCalls += 1;

        return createDocumentResponse({
          body: requestBody,
          hasUnpublishedChanges: true,
          updatedAt: "2026-03-27T12:11:00.000Z",
        });
      },
    },
    route: createRouteContext(),
    state: failed,
  });

  assert.equal(failed.saveState, "unsaved");
  assert.equal(failed.saveRequestBody, undefined);
  assert.equal(saveCalls, 1);
  assert.equal(next.saveState, "saved");
  assert.equal(next.document.body, requestBody);
});

test("applySuccessfulDraftSaveToReadyState prefers the persisted body returned by the server", () => {
  const saving = reduceContentDocumentPageReadyState(
    reduceContentDocumentPageReadyState(createReadyState(), {
      type: "draftChanged",
      body: "  # Launch Notes  ",
    }),
    {
      type: "saveStarted",
    },
  );

  const next = applySuccessfulDraftSaveToReadyState({
    state: saving,
    requestBody: "  # Launch Notes  ",
    persistedBody: "# Launch Notes",
    updatedAt: "2026-03-27T12:06:00.000Z",
  } as Parameters<typeof applySuccessfulDraftSaveToReadyState>[0] & {
    persistedBody: string;
  });

  assert.equal(next.document.body, "# Launch Notes");
  assert.equal(next.draftBody, "# Launch Notes");
  assert.equal(next.saveState, "saved");
});

test("applySuccessfulDraftSaveToReadyState records the server draft revision", () => {
  const saving = reduceContentDocumentPageReadyState(
    reduceContentDocumentPageReadyState(createReadyState(), {
      type: "draftChanged",
      body: "# Launch Notes\nUpdated",
    }),
    {
      type: "saveStarted",
    },
  );

  const next = applySuccessfulDraftSaveToReadyState({
    state: saving,
    requestBody: "# Launch Notes\nUpdated",
    updatedAt: "2026-03-27T12:06:00.000Z",
    draftRevision: 12,
  });

  assert.equal(next.document.draftRevision, 12);
});

test("parseSelectedComparisonVersionValue clears the selection for an empty placeholder value", () => {
  assert.equal(parseSelectedComparisonVersionValue(""), undefined);
  assert.equal(parseSelectedComparisonVersionValue("3"), 3);
});

test("loadContentDocumentVersionDiff compares any two selected versions", async () => {
  const calls: number[] = [];

  const diff = await loadContentDocumentVersionDiff({
    api: {
      getVersion: async ({ version }) => {
        calls.push(version);

        if (version === 1) {
          return createVersionDocument(1);
        }

        return createVersionDocument(3, {
          path: "blog/launch-notes-updated",
          frontmatter: {
            title: "Launch Notes v3",
            summary: "Published update",
          },
          body: "# Launch Notes\nVersion 3\nAdded line",
        });
      },
    },
    documentId: "11111111-1111-4111-8111-111111111111",
    locale: "en",
    leftVersion: 1,
    rightVersion: 3,
  });

  assert.deepEqual(calls, [1, 3]);
  assert.equal(diff.leftVersion, 1);
  assert.equal(diff.rightVersion, 3);
  assert.equal(diff.path.changed, true);
  assert.equal(diff.body.changed, true);
});

test("loadContentDocumentPageState seeds arbitrary version comparison and diff selection against routed version APIs", async () => {
  const calls: number[] = [];

  const loaded = await loadContentDocumentPageState({
    context: createMountContext(),
    typeId: "BlogPost",
    typeLabel: "Blog post",
    documentId: "11111111-1111-4111-8111-111111111111",
    loadDocumentShell: async () => createReadyShell(),
    createRouteApi: () => ({
      listVersions: async () => ({
        data: [createVersionSummary(3), createVersionSummary(1)],
        pagination: {
          total: 2,
          limit: 20,
          offset: 0,
          hasMore: false,
        },
      }),
      listVariants: async () => ({ data: [] }),
    }),
  });

  if (loaded.status !== "ready") {
    throw new Error("expected ready state");
  }

  const diff = await loadContentDocumentVersionDiff({
    api: {
      getVersion: async ({ version }) => {
        calls.push(version);

        if (version === 1) {
          return createVersionDocument(1);
        }

        return createVersionDocument(3, {
          path: "blog/launch-notes-updated",
          frontmatter: {
            title: "Launch Notes v3",
          },
          body: "# Launch Notes\nVersion 3\nAdded line",
        });
      },
    },
    documentId: loaded.documentId,
    locale: loaded.document.locale,
    leftVersion: loaded.selectedComparison.leftVersion ?? 0,
    rightVersion: loaded.selectedComparison.rightVersion ?? 0,
  });

  assert.deepEqual(calls, [1, 3]);
  assert.equal(diff.leftVersion, 1);
  assert.equal(diff.rightVersion, 3);
});

test("ContentDocumentPageView renders tabbed sidebar in info, properties, history order", () => {
  const ready = createReadyState();
  const readyMarkup = renderPageMarkup(
    {
      ...ready,
      publishDialogOpen: true,
      publishChangeSummary: "Ready for launch.",
      versionHistory: {
        status: "ready",
        versions: [
          createVersionSummary(3, {
            changeSummary: "Ready for launch.",
          }),
          createVersionSummary(1, {
            changeSummary: "Initial publish.",
          }),
        ],
      },
      versionDiff: {
        status: "ready",
        diff: {
          leftVersion: 1,
          rightVersion: 3,
          path: {
            before: "blog/launch-notes",
            after: "blog/launch-notes-updated",
            changed: true,
          },
          frontmatter: {
            changed: true,
            changes: [
              {
                path: "title",
                before: "Launch Notes v1",
                after: "Launch Notes v3",
              },
            ],
          },
          body: {
            changed: true,
            lines: [
              {
                leftLineNumber: 1,
                rightLineNumber: 1,
                leftText: "# Launch Notes",
                rightText: "# Launch Notes",
                status: "unchanged" as const,
              },
              {
                leftLineNumber: 2,
                rightLineNumber: 2,
                leftText: "Version 1",
                rightText: "Version 3",
                status: "changed" as const,
              },
            ],
          },
        },
      },
      selectedComparison: {
        leftVersion: 1,
        rightVersion: 3,
      },
    },
    { sidebarOpen: true },
  );

  // The sidebar exposes four tabs (Info, Properties, optional Component,
  // History). Properties is the default — Info is shown via its tab.
  const infoIndex = readyMarkup.indexOf(">Info<");
  const propertiesIndex = readyMarkup.indexOf(">Properties<");
  const historyIndex = readyMarkup.indexOf(">History<");

  assert.ok(infoIndex >= 0, "expected Info tab label");
  assert.ok(propertiesIndex >= 0, "expected Properties tab label");
  assert.ok(historyIndex >= 0, "expected History tab label");
  assert.ok(
    infoIndex < propertiesIndex && propertiesIndex < historyIndex,
    "expected Info, Properties, History tab order",
  );
  assert.match(readyMarkup, /Info/);
  assert.match(readyMarkup, /Properties/);
  assert.match(readyMarkup, /History/);
  assert.match(readyMarkup, /Publish document/);
  // Legacy sidebar copy stays out.
  assert.doesNotMatch(readyMarkup, /Document workflow/);
  assert.doesNotMatch(readyMarkup, /This page loads the routed draft/);
  assert.doesNotMatch(readyMarkup, />Unpublish</);
  assert.doesNotMatch(readyMarkup, /Move \/ Rename/);
  assert.doesNotMatch(readyMarkup, /View published version/);
  assert.doesNotMatch(readyMarkup, /Route status/);
});

test("SidebarInfoTab renders the document system metadata outside Properties", () => {
  const state = createReadyState({
    document: {
      ...createReadyState().document,
      hasUnpublishedChanges: false,
      publishedVersion: 1,
      path: "content/posts/hello-mdcms",
      updatedAt: "2026-04-10T10:00:00.000Z",
    },
  });

  const markup = renderInfoTabMarkup(state);

  // The redesigned Info block renders mono key/value rows under a single
  // "Document" section header. Keys are lowercase mono labels (status,
  // type, locale, publishedVersion, updatedAt, path).
  assert.match(markup, />Document</);
  assert.match(markup, />status</);
  assert.match(markup, />Published</);
  assert.match(markup, />publishedVersion</);
  assert.match(markup, />v1</);
  assert.match(markup, />locale</);
  assert.match(markup, />en</);
  assert.match(markup, />updatedAt</);
  assert.match(markup, />path</);
  assert.match(markup, /content\/posts\/hello-mdcms/);
  assert.doesNotMatch(markup, /data-mdcms-property-field=/);
});

test("SidebarInfoTab derives truthful document status badges from live document state", () => {
  const changedMarkup = renderInfoTabMarkup(createReadyState());
  const publishedMarkup = renderInfoTabMarkup({
    ...createReadyState(),
    document: {
      ...createReadyState().document,
      hasUnpublishedChanges: false,
      publishedVersion: 5,
    },
  });
  const draftMarkup = renderInfoTabMarkup({
    ...createReadyState(),
    document: {
      ...createReadyState().document,
      hasUnpublishedChanges: true,
      publishedVersion: null,
    },
  });

  assert.match(changedMarkup, />Changed</);
  assert.doesNotMatch(changedMarkup, />Published</);
  assert.match(publishedMarkup, />Published</);
  assert.doesNotMatch(publishedMarkup, />Changed</);
  assert.match(draftMarkup, />Draft</);
  assert.doesNotMatch(draftMarkup, />Published</);
});

test("ContentDocumentPageView folds the unpublished-changes signal into the Publish button", () => {
  const changedMarkup = renderPageMarkup(createReadyState());
  const publishedMarkup = renderPageMarkup({
    ...createReadyState(),
    document: {
      ...createReadyState().document,
      hasUnpublishedChanges: false,
      publishedVersion: 5,
    },
  });

  // The standalone "UNPUBLISHED CHANGES" pill was retired; the Publish
  // button itself carries the signal via a data attribute and an inline
  // "unpublished" badge.
  assert.doesNotMatch(changedMarkup, /UNPUBLISHED CHANGES/);
  assert.match(changedMarkup, /data-mdcms-document-unpublished-changes="true"/);
  assert.match(changedMarkup, />unpublished</);
  assert.doesNotMatch(
    publishedMarkup,
    /data-mdcms-document-unpublished-changes="true"/,
  );
  assert.doesNotMatch(publishedMarkup, />unpublished</);
});

test("ContentDocumentPageView blocks writes when the local schema hash capability is unavailable", () => {
  const state = createContentDocumentPageState({
    shell: createReadyShell(),
    typeLabel: "Blog post",
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: false,
        message: "Schema sync required before Studio can write drafts.",
      },
    },
  });

  if (state.status !== "ready") {
    throw new Error("expected ready state");
  }

  const markup = renderPageMarkup(state, { sidebarOpen: true });

  assert.equal(state.canWrite, false);
  assert.match(markup, /data-mdcms-document-write-state="blocked"/);
  assert.match(markup, /Schema sync required before Studio can write drafts\./);
});

test("ContentDocumentPageView renders environment-specific field badges inline with editable fields", () => {
  const state = createReadyState();
  state.schemaState = createReadySchemaState({
    entries: [
      createSchemaEntry({
        featured: {
          kind: "boolean",
          required: true,
          nullable: false,
        },
        abTestVariant: {
          kind: "string",
          required: false,
          nullable: false,
        },
      }),
    ],
  });
  state.document.frontmatter = {
    featured: false,
    abTestVariant: "variant-a",
  };
  state.draftFrontmatter = {
    ...state.document.frontmatter,
  };
  state.route.environmentFieldTargets = {
    [state.typeId]: {
      featured: ["staging"],
      abTestVariant: ["preview", "staging"],
    },
  };

  const markup = renderPageMarkup(state, { sidebarOpen: true });

  assert.match(markup, /data-mdcms-property-field="featured"/);
  assert.match(markup, /data-mdcms-property-type="boolean"/);
  assert.match(markup, />featured</);
  assert.match(markup, /staging/);
  assert.match(markup, /data-mdcms-property-field="abTestVariant"/);
  assert.match(markup, /data-mdcms-property-type="string"/);
  assert.match(markup, />abTestVariant</);
  assert.match(markup, /preview, staging/);
});

test("ContentDocumentPageView renders schema-driven property controls and unsupported fallback rows", () => {
  const state = createReadyState();
  state.schemaState = createReadySchemaState({
    entries: [
      createSchemaEntry({
        title: {
          kind: "string",
          required: true,
          nullable: false,
        },
        views: {
          kind: "number",
          required: false,
          nullable: false,
        },
        published: {
          kind: "boolean",
          required: true,
          nullable: false,
        },
        status: {
          kind: "enum",
          required: true,
          nullable: false,
          options: ["draft", "published"],
        },
        metadata: {
          kind: "object",
          required: false,
          nullable: false,
          fields: {
            slug: {
              kind: "string",
              required: true,
              nullable: false,
            },
          },
        },
        featured: {
          kind: "boolean",
          required: true,
          nullable: false,
        },
      }),
    ],
  });
  state.route.environmentFieldTargets = {
    [state.typeId]: {
      featured: ["staging"],
    },
  };
  state.document.frontmatter = {
    title: "Launch Notes",
    views: 42,
    published: true,
    status: "draft",
    metadata: {
      slug: "launch-notes",
    },
    featured: false,
  };
  state.draftFrontmatter = {
    ...state.document.frontmatter,
  };

  const markup = renderPageMarkup(state, { sidebarOpen: true });

  assert.match(markup, /data-mdcms-property-field="title"/);
  assert.match(markup, /data-mdcms-property-type="string"/);
  assert.match(markup, /data-mdcms-property-editor="string"/);
  assert.match(markup, /data-mdcms-property-field="views"/);
  assert.match(markup, /data-mdcms-property-type="number"/);
  assert.match(markup, /data-mdcms-property-editor="number"/);
  assert.match(markup, /data-mdcms-property-field="published"/);
  assert.match(markup, /data-mdcms-property-type="boolean"/);
  assert.match(markup, /data-mdcms-property-editor="boolean"/);
  assert.match(markup, /data-mdcms-property-field="status"/);
  assert.match(markup, /data-mdcms-property-type="enum"/);
  assert.match(markup, /data-mdcms-property-editor="select"/);
  assert.match(markup, /data-mdcms-property-field="metadata"/);
  assert.match(markup, /data-mdcms-property-type="object"/);
  assert.match(markup, /Not editable yet/);
  assert.match(markup, /data-mdcms-property-field="featured"/);
  assert.match(markup, /staging/);
  assert.match(markup, />string</);
  assert.match(markup, />number</);
  assert.match(markup, />boolean</);
  assert.match(markup, />enum</);
  assert.match(markup, />object</);
});

test("resolveActiveDocumentRouteContext switches write metadata with the selected environment", () => {
  const route = {
    ...createRouteContext(true),
    writeByEnvironment: {
      production: {
        canWrite: true as const,
        schemaHash: "production-schema-hash",
      },
      staging: {
        canWrite: true as const,
        schemaHash: "staging-schema-hash",
      },
    },
  };

  const activeRoute = resolveActiveDocumentRouteContext(route, "production");

  assert.equal(activeRoute.initialEnvironment, "production");
  assert.deepEqual(activeRoute.write, {
    canWrite: true,
    schemaHash: "production-schema-hash",
  });
});

test("document route request tokens reject stale async results after an environment switch", () => {
  const requestToken = createContentDocumentRouteRequestToken({
    documentId: "11111111-1111-4111-8111-111111111111",
    route: createRouteContext(true),
  });
  const switchedRoute = resolveActiveDocumentRouteContext(
    {
      ...createRouteContext(true),
      writeByEnvironment: {
        production: {
          canWrite: true as const,
          schemaHash: "production-schema-hash",
        },
        staging: {
          canWrite: true as const,
          schemaHash: "staging-schema-hash",
        },
      },
    },
    "production",
  );

  assert.equal(
    matchesContentDocumentRouteRequestToken(requestToken, {
      documentId: "11111111-1111-4111-8111-111111111111",
      route: createRouteContext(true),
    }),
    true,
  );
  assert.equal(
    matchesContentDocumentRouteRequestToken(requestToken, {
      documentId: "11111111-1111-4111-8111-111111111111",
      route: switchedRoute,
    }),
    false,
  );
});

test("locale switcher renders for localized type with supportedLocales", () => {
  const state = createReadyState();
  state.localized = true;
  state.route.supportedLocales = ["en", "fr", "de"];
  state.translationVariants = [
    {
      documentId: "11111111-1111-4111-8111-111111111111",
      locale: "en",
      path: "blog/launch-notes",
      publishedVersion: 5,
      hasUnpublishedChanges: true,
    },
  ];

  const html = renderPageMarkup(state);
  // The Select trigger renders when localized + supportedLocales are set.
  // SelectContent uses a Radix Portal so options don't appear in SSR output.
  assert.ok(
    html.includes('data-slot="select-trigger"'),
    "should render the locale select trigger",
  );
});

test("locale switcher does not render for non-localized types", () => {
  const state = createReadyState();
  state.localized = false;

  const html = renderPageMarkup(state);
  // The switcher guard checks state.localized — no Select should render
  assert.ok(
    !html.includes('data-slot="select-trigger"'),
    "should not render locale select when type is not localized",
  );
});

test("locale switcher does not render without supportedLocales", () => {
  const state = createReadyState();
  state.localized = true;
  // supportedLocales not set on route

  const html = renderPageMarkup(state);
  assert.ok(
    !html.includes('data-slot="select-trigger"'),
    "should not render locale select when supportedLocales is undefined",
  );
});

test("variant creation prompt renders when variantCreation state is set", () => {
  const state = createReadyState();
  state.localized = true;
  state.route.supportedLocales = ["en", "fr"];
  state.variantCreation = {
    targetLocale: "fr",
    sourceDocumentId: "11111111-1111-4111-8111-111111111111",
    sourceLocale: "en",
    status: "idle",
  };

  const html = renderPageMarkup(state);
  assert.ok(html.includes("No fr variant exists yet"));
  assert.ok(html.includes("Create empty"));
  assert.ok(html.includes("Pre-fill from en"));
});

test("variant creation prompt shows error when present", () => {
  const state = createReadyState();
  state.localized = true;
  state.route.supportedLocales = ["en", "fr"];
  state.variantCreation = {
    targetLocale: "fr",
    sourceDocumentId: "11111111-1111-4111-8111-111111111111",
    sourceLocale: "en",
    status: "idle",
    error: "TRANSLATION_VARIANT_CONFLICT",
  };

  const html = renderPageMarkup(state);
  assert.ok(html.includes("TRANSLATION_VARIANT_CONFLICT"));
});

test("filterLocaleOptions hides missing locales for read-only users", () => {
  const result = filterLocaleOptions({
    supportedLocales: ["en", "fr", "de"],
    translationVariants: [
      {
        documentId: "11111111-1111-4111-8111-111111111111",
        locale: "en",
        path: "blog/launch-notes",
        publishedVersion: 5,
        hasUnpublishedChanges: true,
      },
    ],
    canWrite: false,
    variantsFetchFailed: false,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].locale, "en");
  assert.equal(result[0].hasVariant, true);
});

test("filterLocaleOptions hides missing locales when variants fetch failed", () => {
  const result = filterLocaleOptions({
    supportedLocales: ["en", "fr", "de"],
    translationVariants: [
      {
        documentId: "11111111-1111-4111-8111-111111111111",
        locale: "en",
        path: "blog/launch-notes",
        publishedVersion: 5,
        hasUnpublishedChanges: true,
      },
    ],
    canWrite: true,
    variantsFetchFailed: true,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].locale, "en");
});

test("filterLocaleOptions shows missing locales with + prefix for writable users", () => {
  const result = filterLocaleOptions({
    supportedLocales: ["en", "fr", "de"],
    translationVariants: [
      {
        documentId: "11111111-1111-4111-8111-111111111111",
        locale: "en",
        path: "blog/launch-notes",
        publishedVersion: 5,
        hasUnpublishedChanges: true,
      },
    ],
    canWrite: true,
    variantsFetchFailed: false,
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].hasVariant, true);
  assert.equal(result[1].hasVariant, false);
  assert.equal(result[2].hasVariant, false);
});

test("locale switcher stays selectable when listVariants returns sibling-only", () => {
  const state = createReadyState();
  state.localized = true;
  state.route.supportedLocales = ["en", "fr"];
  // Only the sibling locale is in translationVariants — the current
  // locale "en" was filtered out (e.g., by RBAC path filtering).
  state.translationVariants = [
    {
      documentId: "22222222-2222-4222-8222-222222222222",
      locale: "fr",
      path: "blog/launch-notes",
      publishedVersion: null,
      hasUnpublishedChanges: false,
    },
  ];

  const html = renderPageMarkup(state);
  // The Select trigger should still render
  assert.ok(
    html.includes('data-slot="select-trigger"'),
    "locale select trigger should render even when current locale is not in variants",
  );
  // The current locale (en) should be the selected value
  assert.ok(
    html.includes("en"),
    "current locale should appear as the selected value",
  );
});

test("variant creation buttons show creating state", () => {
  const state = createReadyState();
  state.localized = true;
  state.route.supportedLocales = ["en", "fr"];
  state.variantCreation = {
    targetLocale: "fr",
    sourceDocumentId: "11111111-1111-4111-8111-111111111111",
    sourceLocale: "en",
    status: "creating",
  };

  const html = renderPageMarkup(state);
  assert.ok(html.includes("Creating..."));
  // The creating button has a disabled="" attribute in the rendered HTML
  assert.ok(html.includes('disabled=""'));
});
