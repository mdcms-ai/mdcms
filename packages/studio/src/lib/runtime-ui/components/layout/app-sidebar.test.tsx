import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StudioNavigationProvider } from "../../navigation.js";
import { resolveStudioHref } from "../../navigation-paths.js";
import {
  matchStudioRoute,
  stripStudioBasePath,
  extractStudioRouteParams,
} from "../../../remote-studio-routing.js";
import { AppSidebar } from "./app-sidebar.js";

function renderSidebar(input?: {
  canReadSchema?: boolean;
  pathname?: string;
  basePath?: string;
}): string {
  return renderToStaticMarkup(
    createElement(
      StudioNavigationProvider,
      {
        value: {
          pathname: input?.pathname ?? "/admin",
          params: {},
          basePath: input?.basePath,
          push: () => {},
          replace: () => {},
          back: () => {},
        },
      },
      createElement(AppSidebar, {
        canReadSchema: input?.canReadSchema ?? true,
        collapsed: false,
        onToggle: () => {},
      }),
    ),
  );
}

test("AppSidebar shows the Schema route when schema.read is allowed", () => {
  const markup = renderSidebar({
    canReadSchema: true,
  });

  assert.match(markup, /href="\/admin\/schema"/);
});

test("AppSidebar hides the Schema route when schema.read is not allowed", () => {
  const markup = renderSidebar({
    canReadSchema: false,
  });

  assert.doesNotMatch(markup, /href="\/admin\/schema"/);
});

test("AppSidebar keeps review deployment links scoped to the active scenario base path", () => {
  const markup = renderSidebar({
    canReadSchema: true,
    pathname: "/review/editor/admin/schema",
    basePath: "/review/editor/admin",
  });

  assert.match(markup, /href="\/review\/editor\/admin\/schema"/);
  assert.doesNotMatch(markup, /href="\/admin\/schema"/);
  // Active row carries data-active="true" — a semantic marker the test
  // can anchor on without relying on a tailwind utility class. Match the
  // <a> tag with both attributes regardless of attribute order.
  assert.match(
    markup,
    /<a[^>]*\bhref="\/review\/editor\/admin\/schema"[^>]*\bdata-active="true"|<a[^>]*\bdata-active="true"[^>]*\bhref="\/review\/editor\/admin\/schema"/,
  );
});

function renderSidebarWithCapabilities(caps: {
  canReadSchema: boolean;
  canManageUsers: boolean;
  canManageSettings: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(
      StudioNavigationProvider,
      {
        value: {
          pathname: "/admin",
          params: {},
          push: () => {},
          replace: () => {},
          back: () => {},
        },
      },
      createElement(AppSidebar, {
        ...caps,
        collapsed: false,
        onToggle: () => {},
      }),
    ),
  );
}

test("AppSidebar shows Users route when users.manage is allowed", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: true,
    canManageSettings: true,
  });

  assert.match(markup, /href="\/admin\/users"/);
});

test("AppSidebar hides Environments route when admin-only capabilities are unavailable", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: false,
    canManageSettings: false,
  });

  assert.doesNotMatch(markup, /href="\/admin\/environments"/);
});

test("AppSidebar shows Environments route when admin-only capabilities are available", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: true,
    canManageSettings: false,
  });

  assert.match(markup, /href="\/admin\/environments"/);
});

test("AppSidebar shows Environments route when only settings.manage is allowed", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: false,
    canManageSettings: true,
  });

  assert.match(markup, /href="\/admin\/environments"/);
});

test("AppSidebar hides Users route when users.manage is not allowed", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: false,
    canManageSettings: true,
  });

  assert.doesNotMatch(markup, /href="\/admin\/users"/);
});

test("AppSidebar shows Settings route when settings.manage is allowed", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: true,
    canManageSettings: true,
  });

  assert.match(markup, /href="\/admin\/settings"/);
});

test("AppSidebar hides Settings route when settings.manage is not allowed", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: true,
    canManageSettings: false,
  });

  assert.doesNotMatch(markup, /href="\/admin\/settings"/);
});

test("AppSidebar does not render online presence section", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: true,
    canManageUsers: true,
    canManageSettings: true,
  });

  assert.doesNotMatch(markup, /Online now/i);
});

test("members can reach Connected apps without other settings", () => {
  const markup = renderSidebarWithCapabilities({
    canReadSchema: false,
    canManageUsers: false,
    canManageSettings: false,
  });
  assert.match(markup, /href="\/settings\/connected-apps"/);
  assert.doesNotMatch(markup, /href="\/admin\/settings"/);
});

for (const basePath of ["/admin", "/cms", "/"]) {
  test(`Connected apps resolves and matches its route at ${basePath}`, () => {
    const expectedHref = resolveStudioHref(
      basePath,
      "/settings/connected-apps",
    );
    const markup = renderSidebar({ basePath, pathname: expectedHref });
    const link = markup
      .match(/<a\b[^>]*>[^]*?Connected apps[^]*?<\/a>/g)
      ?.find((candidate) => candidate.includes(`href="${expectedHref}"`));
    assert.ok(link, "Connected apps link resolves within the mount");
    const anchor = [...markup.matchAll(/<a\b[^>]*>/g)]
      .map(([tag]) => tag)
      .find((tag) => tag.includes(`href="${expectedHref}"`));
    assert.ok(anchor?.includes('data-active="true"'));
    const internalPath = stripStudioBasePath(expectedHref, basePath);
    const route = matchStudioRoute(internalPath, [
      { id: "settings.section", path: "/settings/:tab" },
    ]);
    assert.equal(route?.id, "settings.section");
    assert.deepEqual(extractStudioRouteParams(internalPath, route), {
      tab: "connected-apps",
    });
    const inactive = renderSidebar({
      basePath,
      pathname: resolveStudioHref(basePath, "/settings"),
    });
    const inactiveAnchor = [...inactive.matchAll(/<a\b[^>]*>/g)]
      .map(([tag]) => tag)
      .find((tag) => tag.includes(`href="${expectedHref}"`));
    assert.ok(inactiveAnchor && !inactiveAnchor.includes('data-active="true"'));
  });
}
