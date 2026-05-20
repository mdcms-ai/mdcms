import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ContentDocumentResponse, MdcmsConfig } from "@mdcms/shared";

import {
  MdcmsRendererError,
  createMdcmsRenderer,
  renderMdcmsContent,
} from "./react.js";

function createDocument(
  overrides: Partial<ContentDocumentResponse> = {},
): ContentDocumentResponse {
  return {
    documentId: "11111111-1111-1111-1111-111111111111",
    translationGroupId: "22222222-2222-2222-2222-222222222222",
    project: "marketing-site",
    environment: "production",
    path: "blog/hello-world.mdx",
    type: "post",
    locale: "en",
    format: "mdx",
    isDeleted: false,
    hasUnpublishedChanges: false,
    version: 3,
    publishedVersion: 3,
    draftRevision: 5,
    frontmatter: {
      title: "Hello World",
      slug: "hello-world",
    },
    body: "# Hello world",
    createdBy: "33333333-3333-3333-3333-333333333333",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedBy: "33333333-3333-3333-3333-333333333333",
    updatedAt: "2026-03-26T12:00:00.000Z",
    ...overrides,
  };
}

function createConfig(overrides: Partial<MdcmsConfig> = {}): MdcmsConfig {
  return {
    project: "marketing-site",
    serverUrl: "http://localhost:4000",
    environment: "production",
    ...overrides,
  };
}

test("renderMdcmsContent renders Markdown documents to React nodes", async () => {
  const node = await renderMdcmsContent(
    createDocument({
      format: "md",
      body: "# Hello\n\nThis is **rendered** content.",
    }),
    {
      config: createConfig(),
    },
  );

  assert.equal(
    renderToStaticMarkup(createElement("article", null, node)),
    "<article><h1>Hello</h1>\n<p>This is <strong>rendered</strong> content.</p></article>",
  );
});

test("createMdcmsRenderer renders MDX components loaded from config and caches loaders", async () => {
  let loadCount = 0;
  const config = createConfig({
    components: [
      {
        name: "Callout",
        importPath: "./components/Callout",
        load: async () => {
          loadCount += 1;
          return function Callout(props: {
            tone?: string;
            children?: ReactNode;
          }) {
            return createElement(
              "aside",
              { "data-tone": props.tone ?? "info" },
              props.children,
            );
          };
        },
      },
    ],
  });
  const renderer = createMdcmsRenderer(config);
  const document = createDocument({
    body: '<Callout tone="warning">Nested **copy**</Callout>',
  });

  const first = await renderer.render(document);
  const second = await renderer.render(document);

  assert.equal(loadCount, 1);
  assert.equal(
    renderToStaticMarkup(createElement("article", null, first)),
    '<article><aside data-tone="warning">Nested <strong>copy</strong></aside></article>',
  );
  assert.equal(
    renderToStaticMarkup(createElement("article", null, second)),
    '<article><aside data-tone="warning">Nested <strong>copy</strong></aside></article>',
  );
});

test("createMdcmsRenderer renders built-in MDX components without host registration", async () => {
  const renderer = createMdcmsRenderer(createConfig());
  const document = createDocument({
    body: '<Box style={{padding: "16px", marginTop: 4}}><Text style={{color: "red"}}>Hello</Text><Image src="/hero.png" alt="Hero" style={{width: "100%"}} /><Link href="/about" style={{textDecoration: "none"}}>About</Link></Box>',
  });

  const node = await renderer.render(document);
  const markup = renderToStaticMarkup(createElement("article", null, node));

  assert.match(markup, /<article>/);
  assert.match(markup, /<div style="[^"]*padding:16px/);
  assert.match(markup, /margin-top:4px/);
  assert.match(markup, /<span style="[^"]*color:red[^"]*">Hello<\/span>/);
  assert.match(markup, /<img src="\/hero\.png" alt="Hero"/);
  assert.match(markup, /width:100%/);
  assert.match(
    markup,
    /<a href="\/about" style="[^"]*text-decoration:none[^"]*">About<\/a>/,
  );
});

test("renderMdcmsContent rejects browser-like usage", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });

  try {
    await assert.rejects(
      () =>
        renderMdcmsContent(createDocument(), {
          config: createConfig(),
        }),
      (error: unknown) => {
        assert.equal(error instanceof MdcmsRendererError, true);
        assert.equal(
          (error as MdcmsRendererError).code,
          "MDCMS_RENDERER_SERVER_ONLY",
        );
        return true;
      },
    );
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("createMdcmsRenderer surfaces component load failures deterministically", async () => {
  const renderer = createMdcmsRenderer(
    createConfig({
      components: [
        {
          name: "Broken",
          importPath: "./components/Broken",
          load: async () => {
            throw new Error("boom");
          },
        },
      ],
    }),
  );

  await assert.rejects(
    () => renderer.render(createDocument({ body: "<Broken />" })),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsRendererError, true);
      const rendererError = error as MdcmsRendererError;
      assert.equal(rendererError.code, "MDCMS_RENDERER_COMPONENT_LOAD_FAILED");
      assert.equal(rendererError.details?.componentName, "Broken");
      return true;
    },
  );
});

test("renderMdcmsContent rejects MDX import and export syntax", async () => {
  await assert.rejects(
    () =>
      renderMdcmsContent(
        createDocument({
          body: 'import Thing from "./Thing"\n\n# Hello',
        }),
        {
          config: createConfig(),
        },
      ),
    (error: unknown) => {
      assert.equal(error instanceof MdcmsRendererError, true);
      assert.equal(
        (error as MdcmsRendererError).code,
        "MDCMS_RENDERER_UNSUPPORTED_MDX_ESM",
      );
      return true;
    },
  );
});
