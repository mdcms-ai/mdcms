import assert from "node:assert/strict";

import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RuntimeLink,
  StudioNavigationProvider,
  useRouter,
} from "./navigation.js";
import { resolveStudioHref } from "./navigation-paths.js";

test("resolveStudioHref keeps scenario-scoped review paths when links target /admin", () => {
  assert.equal(
    resolveStudioHref("/review/editor/admin", "/admin/content"),
    "/review/editor/admin/content",
  );
  assert.equal(
    resolveStudioHref("/review/editor/admin", "/content"),
    "/review/editor/admin/content",
  );
  assert.equal(
    resolveStudioHref("/review/editor/admin", "/review/editor/admin/content"),
    "/review/editor/admin/content",
  );
  assert.equal(resolveStudioHref("/admin", "/admin/content"), "/admin/content");
});

test("RuntimeLink renders scenario-scoped hrefs for review deployments", () => {
  const markup = renderToStaticMarkup(
    createElement(
      StudioNavigationProvider,
      {
        value: {
          pathname: "/review/editor/admin",
          params: {},
          basePath: "/review/editor/admin",
          push: () => {},
          replace: () => {},
          back: () => {},
        },
      },
      createElement(RuntimeLink, { href: "/admin/schema" }, "Schema"),
    ),
  );

  assert.match(markup, /href="\/review\/editor\/admin\/schema"/);
  assert.doesNotMatch(markup, /href="\/admin\/schema"/);
});

test("useRouter normalizes /admin pushes through the active base path", () => {
  let capturedRouter: ReturnType<typeof useRouter> | undefined;
  const pushed: string[] = [];
  const replaced: string[] = [];

  function CaptureRouter() {
    capturedRouter = useRouter();
    return null;
  }

  renderToStaticMarkup(
    createElement(
      StudioNavigationProvider,
      {
        value: {
          pathname: "/review/editor/admin",
          params: {},
          basePath: "/review/editor/admin",
          push: (href) => pushed.push(href),
          replace: (href) => replaced.push(href),
          back: () => {},
        },
      },
      createElement(CaptureRouter),
    ),
  );

  if (!capturedRouter) {
    throw new Error("expected router to be captured");
  }

  capturedRouter.push("/admin/content/post");
  capturedRouter.replace("/schema");

  assert.deepEqual(pushed, ["/review/editor/admin/content/post"]);
  assert.deepEqual(replaced, ["/review/editor/admin/schema"]);
});
