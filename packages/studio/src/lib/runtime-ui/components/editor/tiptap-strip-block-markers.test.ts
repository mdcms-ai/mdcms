import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { stripBlockMarkers } from "./tiptap-editor-utils.js";

describe("stripBlockMarkers — guards plain-text apply against stray markdown", () => {
  test("strips bullet markers from each line", () => {
    assert.equal(stripBlockMarkers("- one\n- two\n- three"), "one\ntwo\nthree");
  });

  test("strips asterisk and plus bullet markers", () => {
    assert.equal(stripBlockMarkers("* one\n+ two"), "one\ntwo");
  });

  test("strips ordered-list markers", () => {
    assert.equal(stripBlockMarkers("1. first\n2. second"), "first\nsecond");
  });

  test("strips heading markers", () => {
    assert.equal(stripBlockMarkers("# title\n## sub"), "title\nsub");
  });

  test("strips blockquote markers", () => {
    assert.equal(stripBlockMarkers("> quoted\n> line two"), "quoted\nline two");
  });

  test("leaves plain text untouched", () => {
    assert.equal(
      stripBlockMarkers("hello world\nfoo bar"),
      "hello world\nfoo bar",
    );
  });

  test("preserves leading whitespace that isn't a marker", () => {
    // Whitespace-prefixed text without a marker is preserved.
    assert.equal(stripBlockMarkers("    hello"), "    hello");
  });

  test("only strips the leading marker, not later markers in the line", () => {
    assert.equal(stripBlockMarkers("- buy a - sign"), "buy a - sign");
  });
});
