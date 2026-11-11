import { z } from "zod";
import type { AgentReadToolDefinition } from "@mdcms/shared";
import type { AgentTool } from "./types.js";
import { documentSchema, documentListEnvelopeSchema } from "./schema.js";

const summary = documentSchema
  .pick({
    documentId: true,
    path: true,
    type: true,
    locale: true,
    updatedAt: true,
    hasUnpublishedChanges: true,
  })
  .strip()
  .extend({ title: z.string().optional(), summary: z.string().optional() });
const summaries = z.object({ matches: z.array(summary), total: z.number() });

export function adaptAssistantReadTool(
  definition: AgentTool,
  execute: (input: unknown) => Promise<unknown>,
  narrowing: { registeredTypes: string[]; supportedLocales: string[] },
): AgentReadToolDefinition {
  const name = z
    .enum(["list_documents", "get_document", "get_schema"])
    .parse(definition.name);
  if (!(definition.inputSchema instanceof z.ZodObject))
    throw new Error("Read tool must have an object input schema.");
  const inputSchema =
    name === "list_documents"
      ? definition.inputSchema
          .pick({ type: true, q: true, locale: true, limit: true })
          .extend({
            type: narrowing.registeredTypes.length
              ? z.enum(narrowing.registeredTypes as [string, ...string[]])
              : z.string().min(1),
            locale: (narrowing.supportedLocales.length
              ? z.enum(narrowing.supportedLocales as [string, ...string[]])
              : z.string()
            ).optional(),
            limit: z.number().int().min(1).max(25).default(10),
          })
          .strict()
      : definition.inputSchema;
  const outputSchema =
    name === "list_documents" ? summaries : definition.outputSchema;
  return {
    name,
    title: definition.title,
    description: definition.description,
    inputSchema,
    outputSchema,
    execute: async (input) => {
      const envelope = await execute(inputSchema.parse(input));
      if (name !== "list_documents") return outputSchema.parse(envelope);
      const result = documentListEnvelopeSchema.parse(envelope);
      return summaries.parse({
        matches: result.data.map((document) => ({
          documentId: document.documentId,
          path: document.path,
          type: document.type,
          locale: document.locale,
          ...(typeof document.frontmatter.title === "string"
            ? { title: document.frontmatter.title }
            : {}),
          ...(typeof document.frontmatter.excerpt === "string"
            ? { summary: document.frontmatter.excerpt.slice(0, 200) }
            : {}),
          updatedAt: document.updatedAt,
          hasUnpublishedChanges: document.hasUnpublishedChanges,
        })),
        total: result.pagination.total,
      });
    },
  };
}
