import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const css = readFileSync(
  fileURLToPath(new URL("./site.css", import.meta.url)),
  "utf8",
);

function ruleBody(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));

  assert.ok(match, `Expected ${selector} rule to exist`);
  return match[1] ?? "";
}

test("home hero uses a full-width single-column layout", () => {
  const landingHero = ruleBody(".landing-hero");

  assert.match(landingHero, /display:\s*block;/);
  assert.doesNotMatch(landingHero, /grid-template-columns/);
});
