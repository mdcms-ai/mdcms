import assert from "node:assert/strict";
import { test } from "bun:test";

import { getPickerOffscreenHintLeft } from "./inline-ai-offscreen-hint-position.js";

test("getPickerOffscreenHintLeft centers on surface when available", () => {
  assert.equal(
    getPickerOffscreenHintLeft({ left: 120, width: 640 }, 1440),
    440,
  );
});

test("getPickerOffscreenHintLeft falls back to viewport width", () => {
  assert.equal(getPickerOffscreenHintLeft(undefined, 1440), 720);
});
