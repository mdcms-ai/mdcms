import { Elysia } from "elysia";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  parseDeclaredClient,
  RuntimeError,
  serializeError,
} from "@mdcms/shared";
import type { AuthService } from "../auth.js";
import type { createAgentToolRegistry } from "../agent-tools/registry.js";
import type { AgentDispatch } from "../agent-tools/dispatcher.js";

type Registry = ReturnType<typeof createAgentToolRegistry>;
export type McpRouteOptions = {
  origin: string;
  version: string;
  registry: Registry;
  authenticate: AuthService["authenticateMcp"];
  dispatch: (
    request: Request,
    target: { project: string; environment: string },
    declared?: string,
  ) => AgentDispatch;
};
export function mountMcpRoutes(app: unknown, options: McpRouteOptions) {
  (app as Elysia).all(
    "/api/v1/mcp",
    async ({ request }) => {
      let authenticated: Awaited<ReturnType<AuthService["authenticateMcp"]>>;
      try {
        authenticated = await options.authenticate(request);
      } catch (error) {
        const failure =
          error instanceof RuntimeError && error.statusCode < 500
            ? error
            : new RuntimeError({
                code: "INTERNAL_ERROR",
                message: "Internal server error.",
                statusCode: 500,
              });
        const status = failure.statusCode ?? 500;
        const challenge = `Bearer resource_metadata="${options.origin}/.well-known/oauth-protected-resource/api/v1/mcp"${status === 403 ? ', error="insufficient_scope"' : ""}`;
        return Response.json(serializeError(failure), {
          status,
          headers: {
            "cache-control": "no-store",
            ...([401, 403].includes(status)
              ? { "www-authenticate": challenge }
              : {}),
          },
        });
      }
      if (request.method !== "POST")
        return new Response(null, {
          status: 405,
          headers: { allow: "POST", "cache-control": "no-store" },
        });
      const server = new Server(
        { name: "mdcms", version: options.version },
        { capabilities: { tools: {} } },
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: options.registry
          .list(authenticated.authorization)
          .map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: z.toJSONSchema(
              tool.inputSchema,
            ) as Tool["inputSchema"],
            outputSchema: z.toJSONSchema(
              tool.outputSchema,
            ) as Tool["outputSchema"],
            annotations: tool.annotations,
          })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        const tool = options.registry.get(call.params.name);
        if (!tool) throw new McpError(ErrorCode.InvalidParams, "Unknown tool.");
        const parsed = tool.inputSchema.safeParse(call.params.arguments ?? {});
        if (!parsed.success)
          throw new McpError(ErrorCode.InvalidParams, "Invalid arguments.");
        const info = call.params._meta?.["ai.mdcms/clientInfo"];
        let declared: string | undefined;
        if (
          info &&
          typeof info === "object" &&
          "name" in info &&
          "version" in info &&
          typeof info.name === "string" &&
          typeof info.version === "string" &&
          info.name.trim().length > 0 &&
          info.version.trim().length > 0
        )
          declared = parseDeclaredClient(
            `${info.name.trim()}/${info.version.trim()}`,
          );
        return options.registry.callValidated(tool.name, parsed.data, {
          authorization: authenticated.authorization,
          target: authenticated.target,
          dispatch: options.dispatch(request, authenticated.target, declared),
        });
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request);
      } finally {
        await server.close();
        await transport.close();
      }
    },
    { parse: "none" },
  );
}
