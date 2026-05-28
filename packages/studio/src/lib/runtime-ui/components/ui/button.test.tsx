import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Button } from "./button.js";

test("Button default variant uses primary foreground text color", () => {
  const markup = renderToStaticMarkup(
    createElement(Button, null, "New Document"),
  );

  assert.match(markup, /text-primary-foreground/);
});
