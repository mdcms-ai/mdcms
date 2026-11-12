import { z } from "zod";
import { RuntimeError, type AgentReadToolDefinition } from "@mdcms/shared";
import type { FindEntriesResult, GetEntryResult } from "./chat-tools.js";
export type TestReadBackends = {
  findEntriesBackend?: (input: {
    type: string;
    q?: string;
    locale?: string;
    limit?: number;
  }) => Promise<FindEntriesResult>;
  getEntryBackend?: (input: {
    documentId: string;
  }) => Promise<GetEntryResult | undefined>;
};
export function createTestReadTools(
  backends: TestReadBackends,
): AgentReadToolDefinition[] {
  const result: AgentReadToolDefinition[] = [];
  const list = z.strictObject({
    type: z.string(),
    q: z.string().optional(),
    locale: z.string().optional(),
    limit: z.number().optional(),
  });
  if (backends.findEntriesBackend)
    result.push({
      name: "list_documents",
      title: "List documents",
      description: "Find document summaries.",
      inputSchema: list,
      outputSchema: z.unknown(),
      execute: (input) => backends.findEntriesBackend!(list.parse(input)),
    });
  const get = z.strictObject({ documentId: z.string() });
  if (backends.getEntryBackend)
    result.push({
      name: "get_document",
      title: "Get document",
      description: "Read a document.",
      inputSchema: get,
      outputSchema: z.unknown(),
      execute: async (input) => {
        const document = await backends.getEntryBackend!(get.parse(input));
        if (!document)
          throw new RuntimeError({
            code: "NOT_FOUND",
            message: "Document not found.",
            statusCode: 404,
          });
        return document;
      },
    });
  return result;
}
