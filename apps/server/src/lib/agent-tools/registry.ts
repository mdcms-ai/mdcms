import { RuntimeError } from "@mdcms/shared";
import type { AuthorizedRequest } from "../auth.js";
import type { AgentTool, AgentToolContext } from "./types.js";
import { contentTools } from "./content.js";
import { toAgentToolFailure } from "./errors.js";

function permitted(tool: AgentTool, authorization: AuthorizedRequest): boolean {
  return (
    authorization.principal.type === "session" ||
    tool.requiredScopes.every(
      (scope) =>
        authorization.principal.type === "api_key" &&
        authorization.principal.scopes.includes(scope),
    )
  );
}

export function createAgentToolRegistry(
  initial: readonly AgentTool[] = contentTools,
) {
  const tools = new Map<string, AgentTool>();
  const register = (tool: AgentTool) => {
    if (tools.has(tool.name))
      throw new Error(`Duplicate agent tool: ${tool.name}`);
    tools.set(tool.name, tool);
  };
  initial.forEach(register);
  const execute = async (
    name: string,
    input: unknown,
    context: AgentToolContext,
  ): Promise<unknown> => {
    const tool = tools.get(name);
    if (!tool)
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Unknown tool.",
        statusCode: 400,
      });
    if (!permitted(tool, context.authorization))
      throw new RuntimeError({
        code: "FORBIDDEN",
        message: "Required tool scope is missing.",
        statusCode: 403,
      });
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success)
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Invalid tool input.",
        statusCode: 400,
        details: { issues: parsed.error.issues },
      });
    return tool.outputSchema.parse(await tool.execute(parsed.data, context));
  };
  return {
    register,
    execute,
    list: (authorization: AuthorizedRequest) =>
      [...tools.values()]
        .filter((tool) => permitted(tool, authorization))
        .sort((a, b) => a.name.localeCompare(b.name)),
    async call(name: string, input: unknown, context: AgentToolContext) {
      try {
        const envelope = await execute(name, input, context);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          isError: false,
        };
      } catch (error) {
        const failure = toAgentToolFailure(error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          isError: true,
        };
      }
    },
  };
}
