import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { z } from "./index.js";

test("the package re-exports Zod so configs need no separate zod dependency", () => {
  assert.equal(typeof z.string, "function");
  assert.equal(z.string().parse("ok"), "ok");
});

test("the CLI entry point runs on Node.js", () => {
  const source = readFileSync(
    new URL("./bin/mdcms.ts", import.meta.url),
    "utf8",
  );

  assert.equal(source.split("\n")[0], "#!/usr/bin/env node");
});
