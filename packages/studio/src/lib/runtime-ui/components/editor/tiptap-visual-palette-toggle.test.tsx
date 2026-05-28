import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { StudioMountContext } from "@mdcms/shared";

import { TipTapEditor } from "./tiptap-editor.js";

function createContext(): StudioMountContext {
  return {
    apiBaseUrl: "https://cms.example.com",
    basePath: "/admin",
    auth: {
      mode: "cookie",
    },
    hostBridge: {
      version: "1",
      resolveComponent: () => null,
      renderMdxPreview: () => () => {},
    },
    mdx: {
      catalog: {
        components: [
          {
            name: "Hero",
            importPath: "@/components/Hero",
            description: "Marketing hero",
          },
        ],
      },
      resolvePropsEditor: async () => null,
    },
  };
}

test("TipTapEditor starts with the visual composition palette collapsed behind the Insert Component button", () => {
  const markup = renderToStaticMarkup(
    createElement(TipTapEditor, {
      context: createContext(),
      initialContent: "# Launch Notes",
    }),
  );

  assert.match(markup, /data-mdcms-visual-composition-layout="true"/);
  assert.match(markup, /data-mdcms-visual-composition-palette-state="closed"/);
  assert.match(markup, /data-mdcms-visual-palette-toggle="true"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /data-mdcms-visual-palette="true"/);
  assert.doesNotMatch(markup, /data-mdcms-mdx-picker-source="toolbar"/);
});
