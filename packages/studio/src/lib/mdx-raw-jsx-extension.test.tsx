import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  renderRawMdxJsxPreview,
  tokenizeMdxRawJsxBlock,
} from "./mdx-raw-jsx-extension.js";
import { MdxRawJsxNodeView } from "./runtime-ui/components/editor/mdx-raw-jsx-node-view.js";

test("renderRawMdxJsxPreview renders intrinsic form JSX as inert HTML", () => {
  const html = renderRawMdxJsxPreview(
    [
      '<form name="contact" method="POST" netlify>',
      "<label>",
      "Name<br />",
      '<input type="text" name="name" required style={{ width: "100%" }} />',
      "</label>",
      '<button type="submit" style={{ padding: "0.75rem 1.5rem", backgroundColor: "#0070f3", color: "#fff" }}>',
      "Send Message",
      "</button>",
      "</form>",
    ].join("\n"),
  );

  assert.match(html, /<form name="contact" method="POST" netlify="">/);
  assert.match(html, /<label>\s*Name<br \/>/);
  assert.match(
    html,
    /<input type="text" name="name" required="" style="width:100%" \/>/,
  );
  assert.match(
    html,
    /<button type="submit" style="padding:0.75rem 1.5rem;background-color:#0070f3;color:#fff">/,
  );
  assert.match(html, /Send Message/);
  assert.doesNotMatch(html, /style=\{\{/);
});

test("renderRawMdxJsxPreview removes unsafe raw JSX preview vectors", () => {
  const html = renderRawMdxJsxPreview(
    [
      '<div onclick="alert(1)" style={{ backgroundImage: "url(javascript:alert(1))", color: "red" }}>',
      '<script>alert("script")</script>',
      "<style>body { background: url(javascript:alert(1)); }</style>",
      '<a href="javascript:alert(1)">Bad link</a>',
      '<img src="javascript:alert(1)" onerror="alert(1)" />',
      '<button type="button" style={{ color: "blue" }}>Safe</button>',
      "</div>",
    ].join("\n"),
  );

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /alert\(/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /background-image/i);
  assert.match(html, /<a>Bad link<\/a>/);
  assert.match(html, /<img \/>/);
  assert.match(html, /<button type="button" style="color:blue">Safe<\/button>/);
});

test("tokenizeMdxRawJsxBlock closes quoted attributes after even backslashes", () => {
  const source = '<div title="value\\\\">Text</div>';

  assert.deepEqual(tokenizeMdxRawJsxBlock(source), {
    raw: source,
    source,
  });
});

test("MdxRawJsxNodeView renders the raw JSX island as non-editable preview HTML", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxRawJsxNodeView, {
      node: {
        attrs: {
          source: [
            '<form name="contact">',
            '<input type="text" name="name" required />',
            "</form>",
          ].join("\n"),
        },
      },
    } as never),
  );

  assert.match(markup, /data-mdcms-mdx-raw-jsx/);
  assert.match(markup, /contentEditable="false"/);
  assert.match(markup, /<form name="contact">/);
  assert.match(markup, /<input type="text" name="name" required="" \/>/);
});

test("MdxRawJsxNodeView injects sanitized raw JSX preview HTML", () => {
  const markup = renderToStaticMarkup(
    createElement(MdxRawJsxNodeView, {
      node: {
        attrs: {
          source: [
            '<img src="javascript:alert(1)" onerror="alert(1)" />',
            '<script>alert("script")</script>',
          ].join("\n"),
        },
      },
    } as never),
  );

  assert.match(markup, /data-mdcms-mdx-raw-jsx/);
  assert.match(markup, /<img \/>/);
  assert.doesNotMatch(markup, /javascript:/i);
  assert.doesNotMatch(markup, /onerror/i);
  assert.doesNotMatch(markup, /<script/i);
});
