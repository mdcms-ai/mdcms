import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AssistantMarkdown,
  copyCodeToClipboard,
  downloadCodeBlock,
} from "./assistant-markdown.js";

test("AssistantMarkdown renders fenced code blocks with Studio-owned controls", () => {
  const markup = renderToStaticMarkup(
    createElement(AssistantMarkdown, {
      streaming: false,
      text: [
        "Here is the current article text:",
        "",
        "```markdown",
        "# About this demo",
        "",
        "<HomeHero></HomeHero>",
        "```",
      ].join("\n"),
    }),
  );

  assert.match(markup, /data-mdcms-assistant-code-block/);
  assert.match(markup, /aria-label="Download code block"/);
  assert.match(markup, /aria-label="Copy code block"/);
  assert.doesNotMatch(markup, /data-streamdown="code-block"/);
  assert.doesNotMatch(markup, /before:content-\[counter\(line\)\]/);
});

test("copyCodeToClipboard writes code through the browser Clipboard API", async () => {
  const copied: string[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });

  try {
    await copyCodeToClipboard("# About\n\n<HomeHero />");
  } finally {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  }

  assert.deepEqual(copied, ["# About\n\n<HomeHero />"]);
});

test("downloadCodeBlock creates and clicks a language-specific download link", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const appended: unknown[] = [];
  const removed: unknown[] = [];
  const clicked: string[] = [];
  const anchor = {
    download: "",
    href: "",
    click() {
      clicked.push(this.download);
    },
  };

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {
        appendChild(node: unknown) {
          appended.push(node);
        },
        removeChild(node: unknown) {
          removed.push(node);
        },
      },
      createElement(tagName: string) {
        assert.equal(tagName, "a");
        return anchor;
      },
    },
  });

  try {
    downloadCodeBlock("# About", "markdown");
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }

  assert.equal(anchor.download, "code-block.md");
  assert.deepEqual(clicked, ["code-block.md"]);
  assert.deepEqual(appended, [anchor]);
  assert.deepEqual(removed, [anchor]);
});
