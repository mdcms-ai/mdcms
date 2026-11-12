import { z } from "zod";
import {
  ContentChangeOriginSchema,
  type ContentVersionSummaryResponse,
  type ContentVersionDocumentResponse,
} from "@mdcms/shared";
import { dispatchJson, restoreScopes } from "./content.js";
import { documentEnvelopeSchema, documentSchema } from "./schema.js";
import { defineAgentTool } from "./types.js";
const text = z.string().min(1);
export const versionSchema = z.object({
  documentId: text,
  translationGroupId: text,
  project: text,
  environment: text,
  version: z.number().int().positive(),
  path: text,
  type: text,
  locale: text,
  format: z.enum(["md", "mdx"]),
  publishedAt: text,
  publishedBy: text,
  publishedOrigin: ContentChangeOriginSchema.optional(),
  changeSummary: z.string().optional(),
}) satisfies z.ZodType<ContentVersionSummaryResponse>;
export const versionDocumentSchema = versionSchema.extend({
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  resolveErrors: documentSchema.shape.resolveErrors,
}) satisfies z.ZodType<ContentVersionDocumentResponse>;
const users = z
  .record(z.string(), z.object({ name: z.string(), email: z.string() }))
  .optional();
export const versionTools = [
  defineAgentTool({
    name: "list_versions",
    title: "List versions",
    description: "Read published version history.",
    requiredScopes: ["content:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.strictObject({
      documentId: text,
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    outputSchema: z.object({
      data: z.array(versionSchema),
      users,
      pagination: z.object({
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        hasMore: z.boolean(),
      }),
    }),
    execute: ({ documentId, ...query }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: `/api/v1/content/${encodeURIComponent(documentId)}/versions`,
        query: Object.fromEntries(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        ),
      }),
  }),
  defineAgentTool({
    name: "get_version",
    title: "Get version",
    description: "Read a published version.",
    requiredScopes: ["content:read"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.strictObject({
      documentId: text,
      version: z.number().int().positive(),
    }),
    outputSchema: z.object({ data: versionDocumentSchema, users }),
    execute: ({ documentId, version }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: `/api/v1/content/${encodeURIComponent(documentId)}/versions/${version}`,
        query: { fileFields: "raw" },
      }),
  }),
  defineAgentTool({
    name: "restore_version",
    title: "Restore version",
    description: "Restore a published version through the content route.",
    requiredScopes: [],
    anyOfScopes: ["content:write", "content:publish"],
    executionScopes: restoreScopes,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    inputSchema: z.strictObject({
      documentId: text,
      version: z.number().int().positive(),
      targetStatus: z.enum(["draft", "published"]).optional(),
    }),
    outputSchema: documentEnvelopeSchema,
    execute: ({ documentId, version, targetStatus }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "POST",
        path: `/api/v1/content/${encodeURIComponent(documentId)}/versions/${version}/restore`,
        body: { targetStatus },
        query: { fileFields: "raw" },
      }),
  }),
];
