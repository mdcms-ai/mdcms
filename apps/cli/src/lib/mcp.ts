import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { IMPLICIT_DEFAULT_LOCALE, type ParsedMdcmsConfig } from "@mdcms/shared";
import { DEFAULT_CLI_LOGIN_SCOPES } from "./login.js";
import { loadCliConfig } from "./config.js";
import type {
  CliCommand,
  CliCommandContext,
  LoadCliConfig,
} from "./framework.js";
import { performSchemaSync } from "./schema-sync.js";

export const MCP_TOOL_SCOPES = {
  get_credentials_info: [],
  get_schema: ["schema:read"],
  list_documents: ["content:read:draft"],
  get_document: ["content:read:draft"],
  create_document: ["schema:read", "content:write"],
  update_document: ["schema:read", "content:read:draft", "content:write"],
  publish_document: ["content:publish"],
  sync_schema: ["schema:write"],
} as const satisfies Record<string, readonly string[]>;

const PUBLISH_KEY_GUIDANCE =
  "Keys stored by `mdcms login` or `mdcms init` do not include content:publish. To publish, create an API key with content:publish in Studio (Settings) and pass it with MDCMS_API_KEY or --api-key.";

/** Maps an API key scope to the matching flag in `/api/v1/me/capabilities`. */
const SCOPE_CAPABILITY: Record<
  string,
  (capabilities: Record<string, Record<string, boolean>>) => boolean
> = {
  "schema:read": (c) => c.schema?.read === true,
  "schema:write": (c) => c.schema?.write === true,
  "content:read": (c) => c.content?.read === true,
  "content:read:draft": (c) => c.content?.readDraft === true,
  "content:write": (c) => c.content?.write === true,
  "content:publish": (c) => c.content?.publish === true,
  "content:delete": (c) => c.content?.delete === true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapabilities(
  value: unknown,
): value is Record<string, Record<string, boolean>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (group) =>
        isRecord(group) &&
        Object.values(group).every((flag) => typeof flag === "boolean"),
    )
  );
}

const UNAUTHORIZED_GUIDANCE =
  "The MDCMS server rejected the API key this MCP server started with (401). Run `mdcms login` to store a new key for this target, or set MDCMS_API_KEY, then restart the MCP server.";

export type McpServerDeps = {
  serverUrl: string;
  project: string;
  environment: string;
  apiKey: string;
  cwd: string;
  configPath: string;
  defaultLocale?: string;
  fetcher: typeof fetch;
  loadConfig?: LoadCliConfig;
  version?: string;
  onUnauthorized?: () => void;
  onFatalTransportError?: () => void;
};

const localTool = {
  name: "sync_schema",
  description:
    "Reload local mdcms.config.ts and sync schema to the originally resolved target. Needs schema:write.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

const credentialsTool = {
  name: "get_credentials_info",
  description:
    "Read target capabilities and common content/schema tool scope requirements. Any valid key; allowed flags do not guarantee path access. Remote discovery is authoritative.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};
const localTools = [localTool, credentialsTool];

export function createMdcmsMcpServer(input: McpServerDeps) {
  const deps = { ...input };
  const endpoint = new URL(`${deps.serverUrl.replace(/\/+$/, "")}/api/v1/mcp`);
  if (endpoint.username || endpoint.password)
    throw new Error("MCP server URL must not contain credentials.");
  const server = new Server(
    { name: "mdcms", version: deps.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );
  let upstream: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let closed = false;
  const safeFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (target.origin !== endpoint.origin)
      throw new Error("MCP target changed.");
    const response = await deps.fetcher(url, { ...init, redirect: "error" });
    if (response.status === 401) deps.onUnauthorized?.();
    return response;
  }) as typeof fetch;
  function redact(value: unknown): unknown {
    if (typeof value === "string")
      return (
        deps.apiKey ? value.split(deps.apiKey).join("[redacted]") : value
      ).replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [redacted]");
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, redact(v)]),
      );
    return value;
  }
  async function remote() {
    if (closed) throw new Error("Bridge closed.");
    if (!connecting) {
      connecting = (async () => {
        const identity = server.getClientVersion();
        if (!identity) throw new Error("Client initialization required.");
        upstream = new Client(identity);
        upstream.onclose = () => {
          if (!closed) deps.onFatalTransportError?.();
        };
        const transport = new StreamableHTTPClientTransport(endpoint, {
          fetch: safeFetch,
          requestInit: {
            headers: {
              authorization: `Bearer ${deps.apiKey}`,
              "x-mdcms-project": deps.project,
              "x-mdcms-environment": deps.environment,
            },
            redirect: "error",
          },
        });
        // Transport errors also cover background HTTP/notification failures.
        // Application JSON-RPC errors arrive as responses, not this event.
        transport.onerror = () => {
          if (!closed) deps.onFatalTransportError?.();
        };
        await upstream.connect(transport);
        if (closed) {
          await upstream.close();
          throw new Error("Bridge closed.");
        }
        return upstream;
      })();
    }
    return connecting;
  }
  async function requestRemote<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // MCP application errors are valid responses. Aborted calls and local
      // tool failures do not invalidate the upstream connection.
      if (!closed && !signal.aborted && !(error instanceof McpError)) {
        deps.onFatalTransportError?.();
      }
      throw error;
    }
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof McpError) {
        // The SDK adds this prefix when decoding the wire error. The server
        // serializes Error.message directly, so remove exactly that one prefix.
        const prefix = `MCP error ${error.code}: `;
        const message = error.message.startsWith(prefix)
          ? error.message.slice(prefix.length)
          : error.message;
        throw Object.assign(new Error(String(redact(message))), {
          code: error.code,
          data: redact(error.data),
        });
      }
      throw new McpError(
        ErrorCode.InternalError,
        "MDCMS upstream request failed. Its outcome may be unknown; no retry was attempted.",
      );
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    guarded(async () => {
      const client = await remote();
      const result = await requestRemote(
        () =>
          client.request(request, ListToolsResultSchema, {
            signal: extra.signal,
          }),
        extra.signal,
      );
      if (
        result.tools.some((tool) =>
          localTools.some((local) => tool.name === local.name),
        )
      )
        throw new McpError(
          ErrorCode.InternalError,
          "Remote registry collides with a local tool.",
        );
      return {
        ...result,
        tools: result.nextCursor
          ? result.tools
          : [...result.tools, ...localTools],
      };
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    guarded(async () => {
      if (request.params.name === credentialsTool.name) {
        if (Object.keys(request.params.arguments ?? {}).length)
          throw new McpError(
            ErrorCode.InvalidParams,
            "get_credentials_info accepts no arguments.",
          );
        const failure = (code: string, message: string, details?: unknown) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(redact({ code, message, details })),
            },
          ],
          isError: true,
        });
        let response: Response;
        try {
          response = await safeFetch(
            new URL(
              "api/v1/me/capabilities",
              `${deps.serverUrl.replace(/\/+$/, "")}/`,
            ),
            {
              headers: {
                authorization: `Bearer ${deps.apiKey}`,
                "x-mdcms-project": deps.project,
                "x-mdcms-environment": deps.environment,
              },
              signal: extra.signal,
            },
          );
        } catch {
          return failure(
            "SERVER_UNREACHABLE",
            "Could not reach the MDCMS server.",
          );
        }
        const raw: unknown = await response.json().catch(() => undefined);
        const payload = isRecord(raw) ? raw : undefined;
        if (response.status === 401)
          return failure(
            typeof payload?.code === "string" ? payload.code : "UNAUTHORIZED",
            UNAUTHORIZED_GUIDANCE,
            {
              status: 401,
              ...(typeof payload?.message === "string"
                ? { serverMessage: payload.message }
                : {}),
            },
          );
        if (!response.ok)
          return failure(
            typeof payload?.code === "string" ? payload.code : "REQUEST_FAILED",
            typeof payload?.message === "string"
              ? payload.message
              : "Capabilities request failed.",
            payload?.details ?? { status: response.status },
          );
        const capabilities = isRecord(payload?.data)
          ? payload.data.capabilities
          : undefined;
        if (!isCapabilities(capabilities))
          return failure(
            "REQUEST_FAILED",
            "Unexpected capabilities response from the MDCMS server.",
          );
        const grantedScopes = Object.entries(SCOPE_CAPABILITY)
          .filter(([, granted]) => granted(capabilities))
          .map(([scope]) => scope);
        const tools = Object.fromEntries(
          Object.entries(MCP_TOOL_SCOPES).map(([name, requiredScopes]) => [
            name,
            {
              requiredScopes,
              allowed: requiredScopes.every((scope) =>
                grantedScopes.includes(scope),
              ),
            },
          ]),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                redact({
                  serverUrl: deps.serverUrl,
                  project: deps.project,
                  environment: deps.environment,
                  grantedScopes,
                  capabilities,
                  tools,
                  ...(grantedScopes.includes("content:publish")
                    ? {}
                    : { publishing: PUBLISH_KEY_GUIDANCE }),
                }),
              ),
            },
          ],
          isError: false,
        };
      }
      if (request.params.name !== localTool.name) {
        const client = await remote();
        return requestRemote(
          () =>
            client.request(
              {
                ...request,
                params: {
                  ...request.params,
                  _meta: {
                    ...request.params._meta,
                    "ai.mdcms/clientInfo": server.getClientVersion(),
                  },
                },
              },
              CallToolResultSchema,
              { signal: extra.signal },
            ),
          extra.signal,
        );
      }
      if (Object.keys(request.params.arguments ?? {}).length)
        throw new McpError(
          ErrorCode.InvalidParams,
          "sync_schema accepts no arguments.",
        );
      let loaded: Awaited<ReturnType<LoadCliConfig>>;
      try {
        loaded = await (deps.loadConfig ?? loadCliConfig)({
          cwd: deps.cwd,
          configPath: deps.configPath,
        });
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code: "CONFIG_LOAD_FAILED",
                message: "Could not reload the local MDCMS config.",
              }),
            },
          ],
          isError: true,
        };
      }
      const result = await performSchemaSync({
        config: loaded.config as ParsedMdcmsConfig,
        serverUrl: deps.serverUrl,
        project: deps.project,
        environment: deps.environment,
        apiKey: deps.apiKey,
        cwd: deps.cwd,
        fetcher: ((url, init) =>
          safeFetch(url, { ...init, signal: extra.signal })) as typeof fetch,
      });
      const payload =
        result.outcome === "success"
          ? {
              schemaHash: result.schemaHash,
              syncedAt: result.syncedAt,
              affectedTypes: result.affectedTypes,
            }
          : {
              code: result.errorCode,
              message:
                result.errorCode === "UNAUTHORIZED"
                  ? UNAUTHORIZED_GUIDANCE
                  : redact(result.message),
              details:
                result.errorCode === "UNAUTHORIZED"
                  ? { status: 401, serverMessage: redact(result.message) }
                  : redact(result.details),
            };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        isError: result.outcome === "failure",
      };
    }),
  );
  return {
    server,
    initializeUpstream: remote,
    connect: (transport: Transport) => server.connect(transport),
    close: async () => {
      if (closed) return;
      closed = true;
      await upstream?.close();
      await server.close();
    },
  };
}

function resolveDefaultLocale(configured: string | undefined) {
  return configured && configured !== IMPLICIT_DEFAULT_LOCALE
    ? configured
    : undefined;
}

function renderMcpHelp(): string {
  return [
    "Usage: mdcms mcp",
    "",
    "Run a Model Context Protocol server over stdio through the remote tool registry.",
    "",
    "Tools: server registry plus local sync_schema and get_credentials_info.",
    "Common content/schema tool scope requirements (not the complete remote inventory):",
    ...Object.entries(MCP_TOOL_SCOPES).map(
      ([name, scopes]) =>
        `  ${name}: ${scopes.length ? scopes.join(", ") : "(any valid key)"}`,
    ),
    "Remote discovery and execution enforce current permissions and path grants.",
    `Login/init key scopes: ${DEFAULT_CLI_LOGIN_SCOPES.join(", ")}`,
    PUBLISH_KEY_GUIDANCE,
    "Call get_credentials_info to inspect the active key's capabilities.",
    "Write tools require explicit schemaHash inputs from get_schema.",
    "",
    "Register it with an MCP client from your project root, for example:",
    "  claude mcp add mdcms -- npx mdcms mcp",
    "",
    "Credentials resolve like other commands: --api-key, MDCMS_API_KEY,",
    "or the profile stored by `mdcms login`.",
    "",
  ].join("\n");
}

export type McpCommandOptions = {
  createTransport?: () => Transport;
  version?: string;
};

export function createMcpCommand(options: McpCommandOptions = {}): CliCommand {
  return {
    name: "mcp",
    description: "Run an MCP server over stdio for AI agents",
    renderHelp: renderMcpHelp,
    run: async (context: CliCommandContext): Promise<number> => {
      if (context.args.includes("--help") || context.args.includes("-h")) {
        context.stdout.write(renderMcpHelp());
        return 0;
      }

      if (!context.apiKey) {
        context.stderr.write(
          "MISSING_CREDENTIALS: No API key found for this target. Run `mdcms login` or set MDCMS_API_KEY, then start the MCP server again.\n",
        );
        return 1;
      }

      let removeStdinListeners = () => {};

      try {
        let exitCode = 0;
        let gracefulShutdown = false;
        let failed = false;
        const failTransport = () => {
          if (gracefulShutdown || failed) return;
          failed = true;
          exitCode = 1;
          context.stderr.write(
            "MCP_CONNECTION_FAILED: Check server availability, target and credentials. A mutation may have an unknown outcome; inspect server state before retrying.\n",
          );
          // Let the SDK send the failing RPC response before closing stdio.
          setImmediate(() => {
            void server.close();
          });
        };
        const server = createMdcmsMcpServer({
          serverUrl: context.serverUrl,
          project: context.project,
          environment: context.environment,
          apiKey: context.apiKey,
          cwd: context.cwd,
          configPath: context.configPath,
          defaultLocale: resolveDefaultLocale(context.config.locales?.default),
          fetcher: context.fetcher,
          version: options.version,
          onFatalTransportError: failTransport,
          onUnauthorized: () =>
            context.stderr.write(`UNAUTHORIZED: ${UNAUTHORIZED_GUIDANCE}\n`),
        });
        server.server.oninitialized = () => {
          void server.initializeUpstream().catch(failTransport);
        };
        const closed = new Promise<void>((resolve) => {
          server.server.onclose = () => {
            gracefulShutdown = true;
            void server.close().finally(resolve);
          };
        });
        let transport: Transport;

        if (options.createTransport) {
          transport = options.createTransport();
        } else {
          transport = new StdioServerTransport(
            process.stdin,
            context.protocolOutput ?? process.stdout,
          );
          // The stdio transport does not observe end-of-input, so the client
          // closing stdin is translated into a server close here.
          const closeOnEnd = () => {
            gracefulShutdown = true;
            void server.close();
          };
          process.stdin.once("end", closeOnEnd);
          process.stdin.once("close", closeOnEnd);
          removeStdinListeners = () => {
            process.stdin.off("end", closeOnEnd);
            process.stdin.off("close", closeOnEnd);
          };
        }

        await server.connect(transport);
        context.stderr.write("mdcms mcp: bridge ready.\n");
        await closed;

        return exitCode;
      } catch {
        context.stderr.write(
          "MCP_START_FAILED: Could not start the MCP bridge. Check configuration and transport.\n",
        );
        return 1;
      } finally {
        removeStdinListeners();
      }
    },
  };
}
