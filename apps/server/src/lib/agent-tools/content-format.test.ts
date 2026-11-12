import assert from "node:assert/strict";
import { test } from "bun:test";
import { validateAgentDocument, contentTools } from "./content.js";
import { translationTools } from "./translations.js";
import type { AgentDispatch } from "./dispatcher.js";

const dispatch: AgentDispatch = async () =>
  Response.json({
    data: {
      schemaHash: "hash",
      syncedAt: null,
      types: [
        {
          type: "Note",
          directory: "notes",
          localized: true,
          schemaHash: "hash",
          syncedAt: "2026-01-01T00:00:00Z",
          resolvedSchema: {
            type: "Note",
            directory: "notes",
            localized: true,
            fields: {},
          },
        },
      ],
    },
  });

test("agent validation infers MDX from the body regardless of compatibility format", async () => {
  for (const format of [undefined, "md", "mdx", "legacy", null, 42]) {
    await assert.rejects(
      validateAgentDocument(
        dispatch,
        {
          type: "Note",
          frontmatter: {},
          body: "<Callout>",
          format,
        },
        "hash",
      ),
      (error: any) => error.code === "INVALID_MDX",
    );
    await validateAgentDocument(
      dispatch,
      {
        type: "Note",
        frontmatter: {},
        body: "Plain {unfinished",
        format,
      },
      "hash",
    );
    await validateAgentDocument(
      dispatch,
      {
        type: "Note",
        frontmatter: {},
        body: "<Callout />",
        format,
      },
      "hash",
    );
  }
});

test("create and translation schemas accept ignored compatibility format values", () => {
  for (const tool of [...contentTools, ...translationTools].filter(
    (tool) =>
      tool.name === "create_document" || tool.name === "create_translation",
  )) {
    for (const format of [undefined, "md", "mdx", "legacy", null, 42, {}]) {
      const result = tool.inputSchema.safeParse({
        type: "Note",
        path: "notes/one",
        locale: "en",
        frontmatter: {},
        body: "hello",
        schemaHash: "hash",
        format,
        ...(tool.name === "create_translation"
          ? { sourceDocumentId: "source" }
          : {}),
      });
      assert.equal(result.success, true);
    }
  }
});
