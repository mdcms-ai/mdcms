import type { z } from "zod";

/** Host-adapted registry reads injected into the Assistant without server imports. */
export type AgentReadToolDefinition = {
  name: "list_documents" | "get_document" | "get_schema";
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute(input: Record<string, unknown>): Promise<unknown>;
};
