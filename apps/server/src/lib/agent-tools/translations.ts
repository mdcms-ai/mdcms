import { z } from "zod";
import { type TranslationVariantsResponse } from "@mdcms/shared";
import { dispatchJson, validateAgentDocument } from "./content.js";
import { documentEnvelopeSchema } from "./schema.js";
import { defineAgentTool } from "./types.js";
const text = z.string().min(1);
export const translationEnvelopeSchema = z.object({
  data: z.array(
    z.object({
      documentId: text,
      locale: text,
      path: text,
      publishedVersion: z.number().nullable(),
      hasUnpublishedChanges: z.boolean(),
    }),
  ),
}) satisfies z.ZodType<TranslationVariantsResponse>;
export const translationTools = [
  defineAgentTool({
    name: "list_translations",
    title: "List translations",
    description: "Read the document's locale variants.",
    requiredScopes: ["content:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.strictObject({ documentId: text }),
    outputSchema: translationEnvelopeSchema,
    execute: ({ documentId }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: `/api/v1/content/${encodeURIComponent(documentId)}/variants`,
      }),
  }),
  defineAgentTool({
    name: "create_translation",
    title: "Create translation",
    description: "Create a new locale variant using the pinned schema hash.",
    requiredScopes: ["schema:read", "content:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: z.strictObject({
      sourceDocumentId: text,
      type: text,
      path: text,
      locale: text,
      frontmatter: z.record(z.string(), z.unknown()),
      body: z.string(),
      format: z.enum(["md", "mdx"]).optional(),
      schemaHash: text,
    }),
    outputSchema: documentEnvelopeSchema,
    execute: async ({ schemaHash, ...body }, { dispatch }) => {
      await validateAgentDocument(
        dispatch,
        { ...body, format: body.format ?? "md" },
        schemaHash,
      );
      return dispatchJson(dispatch, {
        method: "POST",
        path: "/api/v1/content",
        body,
        schemaHash,
        query: { fileFields: "raw" },
      });
    },
  }),
];
