import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ImageNodeFrame } from "./image-node-view.js";

test("ImageNodeFrame shows change and delete controls for a selected writable image", () => {
  const markup = renderToStaticMarkup(
    createElement(ImageNodeFrame, {
      src: "https://cdn.example.com/hero.png",
      alt: "Hero image",
      selected: true,
      readOnly: false,
      onChangeImage: () => {},
      onDeleteImage: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-image-node="true"/);
  assert.match(markup, /data-mdcms-image-node-selected="true"/);
  assert.match(markup, /src="https:\/\/cdn\.example\.com\/hero\.png"/);
  assert.match(markup, /alt="Hero image"/);
  assert.match(markup, /aria-label="Change image"/);
  assert.match(markup, /aria-label="Delete image"/);
});

test("ImageNodeFrame hides contextual controls when the image is read-only", () => {
  const markup = renderToStaticMarkup(
    createElement(ImageNodeFrame, {
      src: "https://cdn.example.com/hero.png",
      alt: "Hero image",
      selected: true,
      readOnly: true,
      onChangeImage: () => {},
      onDeleteImage: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-image-node="true"/);
  assert.doesNotMatch(markup, /aria-label="Change image"/);
  assert.doesNotMatch(markup, /aria-label="Delete image"/);
});

test("ImageNodeFrame hides contextual controls when the image is not selected", () => {
  const markup = renderToStaticMarkup(
    createElement(ImageNodeFrame, {
      src: "https://cdn.example.com/hero.png",
      alt: "Hero image",
      selected: false,
      readOnly: false,
      onChangeImage: () => {},
      onDeleteImage: () => {},
    }),
  );

  assert.match(markup, /data-mdcms-image-node="true"/);
  assert.doesNotMatch(markup, /aria-label="Change image"/);
  assert.doesNotMatch(markup, /aria-label="Delete image"/);
});
