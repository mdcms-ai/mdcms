import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RuntimeError,
  type EnvironmentDefinitionsMeta,
  type EnvironmentSummary,
} from "@mdcms/shared";

import { ThemeProvider } from "../../adapters/next-themes.js";
import { StudioMountInfoProvider } from "./mount-info-context.js";
import { StudioSessionProvider } from "./session-context.js";
import {
  EnvironmentManagementPageView,
  type EnvironmentManagementState,
} from "./environments-page.js";
import {
  PROMOTE_DEFAULT_STATE,
  type EnvironmentPromoteState,
  resolveDeleteFailureState,
} from "./environments-page-state.js";

function createEnvironmentSummary(
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  return {
    id: "env-production",
    project: "marketing-site",
    name: "production",
    extends: null,
    isDefault: true,
    createdAt: "2026-03-19T10:00:00.000Z",
    ...overrides,
  };
}

function renderMarkup(
  state: EnvironmentManagementState,
  props: Partial<Parameters<typeof EnvironmentManagementPageView>[0]> = {},
): string {
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
          createElement(EnvironmentManagementPageView, {
            state,
            ...props,
          }),
        ),
      ),
    ),
  );
}

function createDefinitionsMeta(
  overrides: Partial<EnvironmentDefinitionsMeta> = {},
): EnvironmentDefinitionsMeta {
  return {
    definitionsStatus: "ready",
    configSnapshotHash: "sha256:abc123",
    syncedAt: "2026-03-19T10:00:00.000Z",
    ...overrides,
  };
}

test("EnvironmentManagementPageView renders loading and empty states deterministically", () => {
  const loadingMarkup = renderMarkup({
    status: "loading",
    project: "marketing-site",
    message: "Loading environments.",
  });
  const emptyMarkup = renderMarkup({
    status: "ready",
    project: "marketing-site",
    environments: [],
    definitionsMeta: createDefinitionsMeta(),
  });

  assert.match(loadingMarkup, /class="min-h-screen"/);
  assert.match(loadingMarkup, /sticky top-0/);
  assert.match(loadingMarkup, /data-mdcms-environments-page-state="loading"/);
  assert.match(loadingMarkup, /Loading environments/i);
  assert.match(emptyMarkup, /data-mdcms-environments-page-state="empty"/);
  assert.match(emptyMarkup, /No environments were returned/i);
  assert.match(emptyMarkup, /New environment/);
});

test("EnvironmentManagementPageView surfaces the definitions strip with hash and syncedAt", () => {
  const markup = renderMarkup({
    status: "ready",
    project: "marketing-site",
    environments: [createEnvironmentSummary()],
    definitionsMeta: createDefinitionsMeta(),
  });

  assert.match(markup, /data-mdcms-environments-definitions-strip/);
  assert.match(markup, /data-mdcms-environments-definitions-status="ready"/);
  assert.match(markup, /sha256:abc123/);
  assert.match(markup, /2026-03-19T10:00:00.000Z/);
});

test("EnvironmentManagementPageView renders lineage rail and management table with row actions", () => {
  const markup = renderMarkup({
    status: "ready",
    project: "marketing-site",
    environments: [
      createEnvironmentSummary({ createdAt: "2026-03-19T10:00:00.000Z" }),
      createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
        createdAt: "2026-03-20T11:30:45.000Z",
      }),
    ],
    definitionsMeta: createDefinitionsMeta(),
  });

  assert.match(markup, /data-mdcms-environments-page-state="ready"/);
  // Lineage rail surfaces both nodes.
  assert.match(markup, /data-mdcms-environments-lineage-node="production"/);
  assert.match(markup, /data-mdcms-environments-lineage-node="staging"/);
  // Lineage marks the default/root chip and renders the extends arrow.
  assert.match(markup, /Default/);
  assert.match(markup, /Root/);
  assert.match(markup, /← production/);
  // Table marker, row markers, and per-row actions.
  assert.match(markup, /data-mdcms-environments-table/);
  assert.match(markup, /data-mdcms-environment-row="production"/);
  assert.match(markup, /data-mdcms-environment-row="staging"/);
  assert.match(markup, /data-mdcms-environment-promote-action="production"/);
  assert.match(markup, /data-mdcms-environment-clone-action="production"/);
  assert.match(markup, /data-mdcms-environment-promote-action="staging"/);
  assert.match(markup, /data-mdcms-environment-clone-action="staging"/);
  assert.match(markup, /2026-03-19T10:00:00.000Z/);
  assert.match(markup, /2026-03-20T11:30:45.000Z/);
  // Default row's delete button is disabled.
  assert.match(markup, /Default environment cannot be deleted/);
  // Extends chip appears on the non-default row.
  assert.match(markup, /extends production/);
});

test("EnvironmentManagementPageView renders the promote drawer in the configure stage", () => {
  const promoteState: EnvironmentPromoteState = {
    ...PROMOTE_DEFAULT_STATE,
    sourceEnvironmentId: "env-production",
    targetEnvironmentId: "env-staging",
    documents: [
      {
        documentId: "doc-1",
        translationGroupId: "tg-1",
        project: "marketing-site",
        environment: "production",
        path: "blog/welcome",
        type: "BlogPost",
        locale: "en",
        format: "md",
        isDeleted: false,
        hasUnpublishedChanges: true,
        version: 4,
        publishedVersion: 3,
        draftRevision: 1,
        frontmatter: {},
        body: "",
        createdBy: "system",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedBy: "system",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    ],
    selectedDocumentIds: ["doc-1"],
  };

  const markup = renderMarkup(
    {
      status: "ready",
      project: "marketing-site",
      environments: [
        createEnvironmentSummary(),
        createEnvironmentSummary({
          id: "env-staging",
          name: "staging",
          extends: "production",
          isDefault: false,
        }),
      ],
      definitionsMeta: createDefinitionsMeta(),
    },
    {
      promoteTarget: createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
      }),
      promoteState,
    },
  );

  assert.match(markup, /data-mdcms-environment-drawer="promote"/);
  assert.match(markup, /data-mdcms-environment-promote-stepper="configure"/);
  assert.match(markup, /data-mdcms-environment-promote-source/);
  assert.match(markup, /data-mdcms-environment-promote-target/);
  assert.match(markup, /Promote production .{0,5}.{0,5} staging/);
  assert.match(markup, /1 selected/);
  assert.match(markup, /data-mdcms-environment-promote-document-row="doc-1"/);
  assert.match(markup, /Preview as dry-run/);
  assert.match(markup, /Include unpublished/);
});

test("EnvironmentManagementPageView surfaces failing promote flows inside the drawer", () => {
  const promoteState: EnvironmentPromoteState = {
    ...PROMOTE_DEFAULT_STATE,
    sourceEnvironmentId: "env-production",
    targetEnvironmentId: "env-staging",
    documentsError: "Failed to load source environment documents.",
    stage: "preview",
    preview: {
      status: "error",
      message: "Promote preview failed.",
      remapDetails: {
        sourceDocumentId: "doc-1",
        fieldPath: "frontmatter.author",
        translationGroupId: "tg-author",
        locale: "en",
      },
    },
    executeError: "Promote execution failed.",
  };

  const markup = renderMarkup(
    {
      status: "ready",
      project: "marketing-site",
      environments: [
        createEnvironmentSummary(),
        createEnvironmentSummary({
          id: "env-staging",
          name: "staging",
          extends: "production",
          isDefault: false,
        }),
      ],
      definitionsMeta: createDefinitionsMeta(),
    },
    {
      promoteTarget: createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
      }),
      promoteState,
    },
  );

  // Drawer is mounted and the stepper has advanced to the preview stage so
  // the error surface is visible.
  assert.match(markup, /data-mdcms-environment-drawer="promote"/);
  assert.match(markup, /data-mdcms-environment-promote-stepper="preview"/);
  // Preview-error block renders the message + remap details.
  assert.match(markup, /data-mdcms-environment-promote-preview-error/);
  assert.match(markup, /Promote preview failed\./);
  assert.match(markup, /frontmatter\.author/);
});

test("EnvironmentManagementPageView surfaces document-load failures in the promote drawer", () => {
  const promoteState: EnvironmentPromoteState = {
    ...PROMOTE_DEFAULT_STATE,
    sourceEnvironmentId: "env-production",
    targetEnvironmentId: "env-staging",
    documentsError: "Failed to load source environment documents.",
  };

  const markup = renderMarkup(
    {
      status: "ready",
      project: "marketing-site",
      environments: [
        createEnvironmentSummary(),
        createEnvironmentSummary({
          id: "env-staging",
          name: "staging",
          extends: "production",
          isDefault: false,
        }),
      ],
      definitionsMeta: createDefinitionsMeta(),
    },
    {
      promoteTarget: createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
      }),
      promoteState,
    },
  );

  assert.match(markup, /data-mdcms-environment-promote-documents-error/);
  assert.match(markup, /Failed to load source environment documents\./);
  assert.doesNotMatch(markup, /No documents in source environment\./);
});

test("EnvironmentManagementPageView renders the clone drawer with the contract toggles", () => {
  const markup = renderMarkup(
    {
      status: "ready",
      project: "marketing-site",
      environments: [
        createEnvironmentSummary(),
        createEnvironmentSummary({
          id: "env-staging",
          name: "staging",
          extends: "production",
          isDefault: false,
        }),
      ],
      definitionsMeta: createDefinitionsMeta(),
    },
    {
      cloneTarget: createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
      }),
    },
  );

  assert.match(markup, /data-mdcms-environment-drawer="clone"/);
  assert.match(markup, /data-mdcms-environment-clone-dialog="staging"/);
  assert.match(markup, /Source environment/);
  assert.match(markup, /Include content/);
  assert.match(markup, /Include settings/);
  assert.match(markup, /Include drafts/);
  assert.match(markup, /Preserve paths/);
  assert.match(markup, /Run clone/);
});

test("EnvironmentManagementPageView renders forbidden and error states", () => {
  const forbiddenMarkup = renderMarkup({
    status: "forbidden",
    project: "marketing-site",
    message: "Forbidden.",
  });
  const errorMarkup = renderMarkup({
    status: "error",
    project: "marketing-site",
    message: "Environment request failed.",
  });

  assert.match(
    forbiddenMarkup,
    /data-mdcms-environments-page-state="forbidden"/,
  );
  assert.match(errorMarkup, /data-mdcms-environments-page-state="error"/);
});

test("EnvironmentManagementPageView keeps delete conflicts inside the modal", () => {
  const markup = renderMarkup(
    {
      status: "ready",
      project: "marketing-site",
      environments: [
        createEnvironmentSummary(),
        createEnvironmentSummary({
          id: "env-staging",
          name: "staging",
          extends: "production",
          isDefault: false,
        }),
      ],
      definitionsMeta: createDefinitionsMeta(),
    },
    {
      deleteTarget: createEnvironmentSummary({
        id: "env-staging",
        name: "staging",
        extends: "production",
        isDefault: false,
      }),
      deleteError:
        'Environment "staging" cannot be deleted while content or schema state still exists.',
    },
  );

  assert.match(markup, /data-mdcms-delete-error/);
  assert.match(markup, /Delete environment/);
  assert.match(
    markup,
    /Environment &quot;staging&quot; cannot be deleted while content or schema state still exists\./,
  );
  assert.doesNotMatch(markup, /data-mdcms-page-action-error/);
});

test("EnvironmentManagementPageView disables creation when synced definitions are missing", () => {
  const markup = renderMarkup({
    status: "ready",
    project: "marketing-site",
    environments: [createEnvironmentSummary()],
    definitionsMeta: { definitionsStatus: "missing" },
  });

  assert.match(
    markup,
    /Environment management requires a successful cms schema sync/i,
  );
  assert.match(markup, /New environment/);
  assert.match(markup, /disabled=""/);
});

test("resolveDeleteFailureState reloads after not-found delete failures", () => {
  const notFound = resolveDeleteFailureState(
    new RuntimeError({
      code: "NOT_FOUND",
      message: "Environment not found.",
      statusCode: 404,
    }),
  );
  const conflict = resolveDeleteFailureState(
    new RuntimeError({
      code: "CONFLICT",
      message: "Environment is not empty.",
      statusCode: 409,
    }),
  );

  assert.deepEqual(notFound, {
    message: "Environment not found.",
    shouldCloseDialog: true,
    shouldReload: true,
    renderInDialog: false,
  });
  assert.deepEqual(conflict, {
    message: "Environment is not empty.",
    shouldCloseDialog: false,
    shouldReload: false,
    renderInDialog: true,
  });
});
