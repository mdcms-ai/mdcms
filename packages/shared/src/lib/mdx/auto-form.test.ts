import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "../runtime/error.js";
import { createMdxAutoFormFields } from "./auto-form.js";

test("createMdxAutoFormFields maps extracted props to default controls in order", () => {
  const kindOptions = ["bar", "line"];
  const fields = createMdxAutoFormFields({
    title: { type: "string", required: true },
    website: { type: "string", required: false, format: "url" },
    count: { type: "number", required: true },
    published: { type: "boolean", required: false },
    kind: { type: "enum", required: true, values: kindOptions },
    tags: { type: "array", required: false, items: "string" },
    data: { type: "array", required: true, items: "number" },
    publishedAt: { type: "date", required: false },
    children: { type: "rich-text", required: true },
    style: { type: "style", required: false },
    options: { type: "json", required: false },
  });

  assert.deepEqual(fields, [
    { name: "title", control: "text", required: true },
    { name: "website", control: "url", required: false },
    { name: "count", control: "number", required: true },
    { name: "published", control: "boolean", required: false },
    {
      name: "kind",
      control: "select",
      required: true,
      options: ["bar", "line"],
    },
    { name: "tags", control: "string-list", required: false },
    { name: "data", control: "number-list", required: true },
    { name: "publishedAt", control: "date", required: false },
    { name: "children", control: "rich-text", required: true },
    { name: "style", control: "style", required: false },
  ]);

  const selectField = fields.find((field) => field.name === "kind");
  assert.notEqual(selectField, undefined);
  assert.equal(selectField?.control, "select");
  assert.notStrictEqual(selectField?.options, kindOptions);
});

test("createMdxAutoFormFields applies supported widget overrides deterministically", () => {
  const fields = createMdxAutoFormFields(
    {
      accent: { type: "string", required: false },
      body: { type: "string", required: true },
      rating: { type: "number", required: true },
      imageRef: { type: "string", required: false },
      variant: { type: "string", required: true },
      options: { type: "json", required: false },
      hiddenProp: { type: "boolean", required: false },
    },
    {
      accent: { widget: "color-picker" },
      body: { widget: "textarea" },
      rating: { widget: "slider", min: 0, max: 10, step: 2 },
      imageRef: { widget: "image" },
      variant: {
        widget: "select",
        options: ["primary", { label: "Secondary", value: "secondary" }],
      },
      options: { widget: "json" },
      hiddenProp: { widget: "hidden" },
    },
  );

  assert.deepEqual(fields, [
    { name: "accent", control: "color-picker", required: false },
    { name: "body", control: "textarea", required: true },
    {
      name: "rating",
      control: "slider",
      required: true,
      min: 0,
      max: 10,
      step: 2,
    },
    { name: "imageRef", control: "image", required: false },
    {
      name: "variant",
      control: "select",
      required: true,
      options: ["primary", { label: "Secondary", value: "secondary" }],
    },
    { name: "options", control: "json", required: false },
  ]);
});

test("createMdxAutoFormFields rejects incompatible prop hints", () => {
  assert.throws(
    () =>
      createMdxAutoFormFields(
        {
          title: { type: "string", required: true },
        },
        {
          title: { widget: "slider", min: 0, max: 10 },
        },
      ),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_CONFIG" &&
      error.message.includes("title"),
  );

  assert.deepEqual(
    createMdxAutoFormFields(
      {
        title: { type: "string", required: true },
      },
      {
        missing: { widget: "hidden" },
      },
    ),
    [{ name: "title", control: "text", required: true }],
  );
});

test("createMdxAutoFormFields returns an empty list for missing or hidden-only props", () => {
  assert.deepEqual(createMdxAutoFormFields(undefined), []);
  assert.deepEqual(createMdxAutoFormFields({}), []);
  assert.deepEqual(
    createMdxAutoFormFields({
      options: { type: "json", required: false },
    }),
    [],
  );
  assert.deepEqual(
    createMdxAutoFormFields(
      {
        hiddenProp: { type: "boolean", required: false },
      },
      {
        hiddenProp: { widget: "hidden" },
      },
    ),
    [],
  );
});
