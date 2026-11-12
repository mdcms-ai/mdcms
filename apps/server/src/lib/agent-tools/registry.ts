import { RuntimeError } from "@mdcms/shared";
import type { AuthorizedRequest } from "../auth.js";
import type { AgentTool, AgentToolContext } from "./types.js";
import { environmentTools } from "./environments.js";
import { mediaTools } from "./media.js";
import { webhookTools } from "./webhooks.js";
import { versionTools } from "./versions.js";
import { translationTools } from "./translations.js";
import { contentTools } from "./content.js";
import { toAgentToolFailure } from "./errors.js";

function permitted(tool: AgentTool, authorization: AuthorizedRequest): boolean {
  if (tool.requiresGlobalAdmin && !authorization.globalAdmin) return false;
  return (
    authorization.principal.type === "session" ||
    (tool.requiredScopes.every(
      (scope) =>
        authorization.principal.type !== "session" &&
        authorization.principal.scopes.includes(scope),
    ) &&
      (!tool.anyOfScopes ||
        tool.anyOfScopes.some(
          (scope) =>
            authorization.principal.type !== "session" &&
            authorization.principal.scopes.includes(scope),
        )))
  );
}

export function createAgentToolRegistry(
  initial: readonly AgentTool[] = [
    ...contentTools,
    ...versionTools,
    ...translationTools,
    ...webhookTools,
    ...mediaTools,
    ...environmentTools,
  ],
  options: {
    getMediaUploadLimit?: (
      target: AgentToolContext["target"],
    ) => Promise<number | null>;
  } = {},
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
    validated = false,
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
    const parsed = validated
      ? { success: true as const, data: input }
      : tool.inputSchema.safeParse(input);
    if (!parsed.success)
      throw new RuntimeError({
        code: "INVALID_INPUT",
        message: "Invalid tool input.",
        statusCode: 400,
        details: { issues: parsed.error.issues },
      });
    if (
      tool.executionScopes &&
      !permitted(
        { ...tool, requiredScopes: tool.executionScopes(parsed.data) },
        context.authorization,
      )
    )
      throw new RuntimeError({
        code: "FORBIDDEN",
        message: "Required action scope is missing.",
        statusCode: 403,
      });
    return tool.outputSchema.parse(
      await tool.execute(parsed.data, {
        ...context,
        getMediaUploadLimit: options.getMediaUploadLimit
          ? () => options.getMediaUploadLimit!(context.target)
          : context.getMediaUploadLimit,
      }),
    );
  };
  const call = async (
    name: string,
    input: unknown,
    context: AgentToolContext,
    validated = false,
  ) => {
    try {
      const envelope = await execute(name, input, context, validated);
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
  };
  return {
    register,
    execute,
    get: (name: string) => tools.get(name),
    list: (authorization: AuthorizedRequest) =>
      [...tools.values()]
        .filter((tool) => permitted(tool, authorization))
        .sort((a, b) => a.name.localeCompare(b.name)),
    call,
    callValidated: (name: string, input: unknown, context: AgentToolContext) =>
      call(name, input, context, true),
  };
}
