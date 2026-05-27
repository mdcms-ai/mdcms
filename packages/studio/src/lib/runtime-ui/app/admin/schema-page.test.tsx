import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createEmptyCurrentPrincipalCapabilities,
  type StudioMountContext,
} from "@mdcms/shared";
import { ThemeProvider } from "../../adapters/next-themes.js";
import { StudioNavigationProvider } from "../../navigation.js";
import { StudioMountInfoProvider } from "./mount-info-context.js";
import { StudioSessionProvider } from "./session-context.js";
import {
  createStudioSchemaLoadingState,
  type StudioSchemaReadyState,
  type StudioSchemaState,
} from "../../../schema-state.js";
import { SchemaPageView } from "./schema-page.js";
import { createSchemaPageLoadInput } from "./schema-page-state.js";

function createReadyState(
  overrides: Partial<StudioSchemaReadyState> = {},
): StudioSchemaReadyState {
  return {
    status: "ready",
    project: "marketing-site",
    environment: "staging",
    localSchemaHash: "local-hash",
    serverSchemaHash: "server-hash",
    isMismatch: false,
    hasLocalSyncPayload: false,
    canSync: false,
    capabilities: createEmptyCurrentPrincipalCapabilities(),
    entries: [],
    reload: async () => createReadyState(),
    sync: async () => createReadyState(),
    ...overrides,
  };
}

function renderMarkup(state: StudioSchemaState): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(
        StudioSessionProvider,
        {
          value: { status: "unauthenticated" },
        },
        createElement(
          StudioMountInfoProvider,
          {
            value: {
              project: "marketing-site",
              environment: "staging",
              setEnvironment: () => {},
              apiBaseUrl: "http://localhost:4000",
              auth: { mode: "cookie" },
              environments: [],
              hostBridge: null,
            },
          },
          createElement(
            StudioNavigationProvider,
            {
              value: {
                pathname: "/schema",
                params: {},
                basePath: "/admin",
                push: () => {},
                replace: () => {},
                back: () => {},
              },
            },
            createElement(SchemaPageView, {
              state,
            }),
          ),
        ),
      ),
    ),
  );
}

test("createSchemaPageLoadInput maps the mounted project and environment", () => {
  const context: StudioMountContext = {
    apiBaseUrl: "https://cms.example.com",
    basePath: "/admin",
    auth: { mode: "token", token: "mdcms_key_test" },
    hostBridge: {
      version: "1",
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    documentRoute: {
      project: "marketing-site",
      initialEnvironment: "staging",
      write: {
        canWrite: false,
        message: "Schema sync required before Studio can write drafts.",
      },
    },
  };

  assert.deepEqual(createSchemaPageLoadInput(context), {
    config: {
      project: "marketing-site",
      environment: "staging",
      serverUrl: "https://cms.example.com",
    },
    auth: { mode: "token", token: "mdcms_key_test" },
  });
});

test("SchemaPageView renders the loading state deterministically", () => {
  const markup = renderMarkup(createStudioSchemaLoadingState());

  assert.match(markup, /class="min-h-screen"/);
  assert.match(markup, /sticky top-0/);
  assert.match(markup, /p-6 space-y-6|space-y-6 p-6/);
  assert.match(markup, /data-mdcms-schema-page-state="loading"/);
  assert.match(markup, /Loading schema state/i);
  assert.match(markup, /Schema/i);
});

test("SchemaPageView renders an empty read-only browser state", () => {
  const markup = renderMarkup(createReadyState());

  assert.match(markup, /data-mdcms-schema-page-state="empty"/);
  assert.match(markup, /Schema definitions are managed in code/i);
  assert.match(markup, /No synced schema is available/i);
  assert.match(markup, /cms schema sync/i);
  assert.match(markup, /marketing-site/);
  assert.match(markup, /staging/);
});

test("SchemaPageView renders live schema entries with simple constraint metadata", () => {
  const markup = renderMarkup(
    createReadyState({
      entries: [
        {
          type: "BlogPost",
          directory: "content/blog",
          localized: true,
          schemaHash: "server-hash",
          syncedAt: "2026-03-31T12:00:00.000Z",
          resolvedSchema: {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
            fields: {
              author: {
                kind: "string",
                required: true,
                nullable: false,
                reference: {
                  targetType: "Author",
                },
              },
              title: {
                kind: "string",
                required: true,
                nullable: false,
                checks: [
                  {
                    kind: "min_length",
                    minimum: 1,
                  },
                ],
              },
              status: {
                kind: "enum",
                required: true,
                nullable: false,
                options: ["draft", "published"],
                checks: [
                  {
                    kind: "enum",
                    values: ["draft", "published"],
                  },
                ],
              },
              tags: {
                kind: "array",
                required: false,
                nullable: false,
                default: [],
                item: {
                  kind: "string",
                  required: true,
                  nullable: false,
                },
              },
            },
          },
        },
      ],
    }),
  );

  assert.match(markup, /data-mdcms-schema-page-state="ready"/);
  assert.match(markup, /READ-ONLY IN STUDIO/);
  assert.match(markup, /mdcms schema sync/);
  assert.match(markup, /data-mdcms-schema-entry-type="BlogPost"/);
  assert.match(markup, /content\/blog/);
  assert.match(markup, /i18n/);
  assert.match(markup, /data-mdcms-schema-field-name="author"/);
  assert.match(markup, /data-mdcms-schema-field-kind="string"/);
  assert.match(markup, /reference: Author/);
  assert.match(markup, /data-mdcms-schema-field-name="title"/);
  assert.match(markup, /min_length: 1/);
  assert.match(markup, /data-mdcms-schema-field-name="status"/);
  assert.match(markup, /options: draft, published/);
  assert.doesNotMatch(markup, /checks: 1/);
  assert.match(markup, /data-mdcms-schema-field-name="tags"/);
  assert.match(markup, /default: \[\]/);
  assert.match(markup, /item: string/);
  assert.doesNotMatch(markup, /Schema Builder/);
  assert.doesNotMatch(markup, /edit/i);
});

test("SchemaPageView renders forbidden and error states", () => {
  const forbiddenMarkup = renderMarkup({
    status: "forbidden",
    project: "marketing-site",
    environment: "staging",
    message: "Forbidden.",
  });
  const errorMarkup = renderMarkup({
    status: "error",
    project: "marketing-site",
    environment: "staging",
    message: "Failed to load schema state.",
  });

  assert.match(forbiddenMarkup, /data-mdcms-schema-page-state="forbidden"/);
  assert.match(forbiddenMarkup, /Forbidden\./);
  assert.match(errorMarkup, /data-mdcms-schema-page-state="error"/);
  assert.match(errorMarkup, /Failed to load schema state\./);
});

test("SchemaPageView remains descriptive-only even when schema sync capability exists", () => {
  const markup = renderMarkup(
    createReadyState({
      canSync: true,
      hasLocalSyncPayload: true,
      capabilities: {
        ...createEmptyCurrentPrincipalCapabilities(),
        schema: {
          read: true,
          write: true,
        },
      },
      entries: [
        {
          type: "BlogPost",
          directory: "content/blog",
          localized: false,
          schemaHash: "server-hash",
          syncedAt: "2026-03-31T12:00:00.000Z",
          resolvedSchema: {
            type: "BlogPost",
            directory: "content/blog",
            localized: false,
            fields: {},
          },
        },
      ],
    }),
  );

  assert.match(markup, /Read-only/i);
  assert.doesNotMatch(markup, /Sync Schema/);
  assert.doesNotMatch(markup, /Edit schema/i);
  assert.doesNotMatch(markup, /Schema Builder/i);
});

test("SchemaPageView renders shared sync metadata once for the whole page", () => {
  const markup = renderMarkup(
    createReadyState({
      entries: [
        {
          type: "Author",
          directory: "content/authors",
          localized: false,
          schemaHash: "server-hash",
          syncedAt: "2026-03-31T12:00:00.000Z",
          resolvedSchema: {
            type: "Author",
            directory: "content/authors",
            localized: false,
            fields: {},
          },
        },
        {
          type: "BlogPost",
          directory: "content/blog",
          localized: true,
          schemaHash: "server-hash",
          syncedAt: "2026-03-31T12:00:00.000Z",
          resolvedSchema: {
            type: "BlogPost",
            directory: "content/blog",
            localized: true,
            fields: {},
          },
        },
      ],
    }),
  );

  // Global sync metadata appears once in the registry strip, plus once in
  // the active type's detail meta — never per type card. Two entries (Author
  // + BlogPost) must not multiply the page-level summary.
  assert.equal(markup.match(/schemaHash/g)?.length ?? 0, 2);
  assert.equal(markup.match(/syncedAt/g)?.length ?? 0, 1);
  // The split-pane shows the active type's detail (Author by default —
  // sorted alphabetically) and lists every type in the left rail.
  assert.match(markup, /data-mdcms-schema-entry-type="Author"/);
  assert.match(markup, />Author</);
  assert.match(markup, />BlogPost</);
});
