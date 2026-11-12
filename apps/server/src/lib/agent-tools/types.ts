import type { z } from "zod";
import type { AuthorizedRequest, ApiKeyOperationScope } from "../auth.js";
import type { AgentDispatch } from "./dispatcher.js";

export type AgentToolContext = {
  dispatch: AgentDispatch;
  target: Readonly<{ project: string; environment: string }>;
  authorization: AuthorizedRequest;
};
export type AgentTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  requiredScopes: readonly ApiKeyOperationScope[];
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  execute(input: unknown, context: AgentToolContext): Promise<unknown>;
};

/** Preserve input inference while validating the complete output at the registry boundary. */
export function defineAgentTool<I extends z.ZodType, O extends z.ZodType>(
  definition: Omit<AgentTool, "inputSchema" | "outputSchema" | "execute"> & {
    inputSchema: I;
    outputSchema: O;
    execute(input: z.output<I>, context: AgentToolContext): Promise<unknown>;
  },
): AgentTool {
  return {
    ...definition,
    // The registry validates input and output once. This cast erases only the
    // heterogeneous registry entry's input type after that validated boundary.
    execute: (input, context) =>
      definition.execute(input as z.output<I>, context),
  };
}
