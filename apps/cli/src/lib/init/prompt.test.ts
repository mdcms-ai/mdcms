import assert from "node:assert/strict";
import { test } from "node:test";

import { createMockPrompter, createTextPromptConfig } from "./prompt.js";

test("mock prompter returns canned text responses in order", async () => {
  const prompter = createMockPrompter({ text: ["alice", "bob"] });

  assert.equal(await prompter.text("name?"), "alice");
  assert.equal(await prompter.text("name?"), "bob");
});

test("mock prompter returns canned select responses in order", async () => {
  const prompter = createMockPrompter({ select: ["ts", "js"] });

  assert.equal(
    await prompter.select("language?", [
      { label: "TypeScript", value: "ts" },
      { label: "JavaScript", value: "js" },
    ]),
    "ts",
  );
  assert.equal(
    await prompter.select("language?", [
      { label: "TypeScript", value: "ts" },
      { label: "JavaScript", value: "js" },
    ]),
    "js",
  );
});

test("mock prompter returns canned multiSelect responses in order", async () => {
  const prompter = createMockPrompter({
    multiSelect: [["a", "b"], ["c"]],
  });

  assert.deepEqual(
    await prompter.multiSelect("pick", [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
      { label: "C", value: "c" },
    ]),
    ["a", "b"],
  );
  assert.deepEqual(
    await prompter.multiSelect("pick", [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
      { label: "C", value: "c" },
    ]),
    ["c"],
  );
});

test("mock prompter returns canned confirm responses in order", async () => {
  const prompter = createMockPrompter({ confirm: [true, false] });

  assert.equal(await prompter.confirm("sure?"), true);
  assert.equal(await prompter.confirm("sure?"), false);
});

test("mock prompter throws when text responses exhausted", async () => {
  const prompter = createMockPrompter({ text: [] });

  await assert.rejects(() => prompter.text("name?"), {
    message: "No more canned text responses",
  });
});

test("mock prompter throws when select responses exhausted", async () => {
  const prompter = createMockPrompter({ select: [] });

  await assert.rejects(
    () => prompter.select("pick", [{ label: "A", value: "a" }]),
    { message: "No more canned select responses" },
  );
});

test("mock prompter throws when multiSelect responses exhausted", async () => {
  const prompter = createMockPrompter({ multiSelect: [] });

  await assert.rejects(
    () => prompter.multiSelect("pick", [{ label: "A", value: "a" }]),
    { message: "No more canned multiSelect responses" },
  );
});

test("mock prompter throws when confirm responses exhausted", async () => {
  const prompter = createMockPrompter({ confirm: [] });

  await assert.rejects(() => prompter.confirm("sure?"), {
    message: "No more canned confirm responses",
  });
});

test("text prompts without a default require a non-blank answer", () => {
  const config = createTextPromptConfig("Project name");

  assert.equal(config.required, true);
  assert.equal(typeof config.validate, "function");
  assert.notEqual(config.validate?.(""), true);
  assert.notEqual(config.validate?.("   "), true);
  assert.equal(config.validate?.("field-notes"), true);
});

test("text prompts with a default accept an empty answer", () => {
  const config = createTextPromptConfig("Environment name", "production");

  assert.equal(config.default, "production");
  assert.equal(config.required, false);
  assert.equal(config.validate, undefined);
});
