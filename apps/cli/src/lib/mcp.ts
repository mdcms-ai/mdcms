import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  IMPLICIT_DEFAULT_LOCALE,
  type ParsedMdcmsConfig,
  type SchemaRegistryTypeSnapshot,
} from "@mdcms/shared";
import { z } from "zod";

import { loadCliConfig } from "./config.js";
import { DEFAULT_CLI_LOGIN_SCOPES } from "./login.js";
import type {
  CliCommand,
  CliCommandContext,
  LoadCliConfig,
} from "./framework.js";
import { readSchemaState } from "./schema-state.js";
import { performSchemaSync } from "./schema-sync.js";
import { validateFrontmatter } from "./validate.js";

/**
 * `mdcms mcp` exposes one `(project, environment)` target to MCP clients over
 * stdio. Tools call the same content and schema endpoints as the other CLI
 * commands, so scopes, the schema hash write gate, and draft revision checks
 * apply to agents exactly as they do to `push`.
 */

export type McpServerDeps = {
  serverUrl: string;
  project: string;
  environment: string;
  apiKey: string;
  cwd: string;
  configPath: string;
  /** Default locale for localized types; absent when the config declares none. */
  defaultLocale?: string;
  fetcher: typeof fetch;
  loadConfig?: LoadCliConfig;
  version?: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ToolErrorDetails = Record<string, unknown>;

class ToolError extends Error {
  readonly code: string;
  readonly details?: ToolErrorDetails;

  constructor(code: string, message: string, details?: ToolErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type RemoteDocument = Record<string, unknown> & {
  documentId: string;
  type: string;
  path: string;
  locale: string;
  format: string;
  draftRevision: number;
  frontmatter: Record<string, unknown>;
  body: string;
};

type RemoteSchemaType = {
  type: string;
  directory: string;
  localized: boolean;
  resolvedSchema: SchemaRegistryTypeSnapshot;
};

type RemoteSchema = {
  types: RemoteSchemaType[];
  schemaHash: string | null;
  syncedAt: string | null;
};

/**
 * Documents of non-localized types are stored under one fixed locale. This
 * matches the locale `push` assigns, so both write paths address the same
 * document identity.
 */
const NON_LOCALIZED_DOCUMENT_LOCALE = "en";

/**
 * API key scopes each tool needs on the server. Scopes do not imply one
 * another, so tools that read the synced schema before writing list
 * `schema:read` as well. `get_credentials_info` only needs a valid key.
 */
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

type McpToolName = keyof typeof MCP_TOOL_SCOPES;

function describeScopes(tool: McpToolName): string {
  const scopes: readonly string[] = MCP_TOOL_SCOPES[tool];

  return scopes.length === 0
    ? "Needs any valid API key for this target."
    : `Needs an API key with ${scopes.join(", ")}.`;
}

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

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSuccess(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function toFailure(error: unknown): ToolResult {
  const payload =
    error instanceof ToolError
      ? {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        }
      : {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

async function runTool(handler: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return toSuccess(await handler());
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * The key is read once when the server starts, so a rejected key stays
 * rejected until the user stores a new one and the client restarts the server.
 */
const UNAUTHORIZED_GUIDANCE =
  "The MDCMS server rejected the API key this MCP server started with (401). Run `mdcms login` to store a new key for this target, or set MDCMS_API_KEY, then restart the MCP server.";

function createUnauthorizedError(payload: unknown): ToolError {
  const code =
    isRecord(payload) && typeof payload.code === "string"
      ? payload.code
      : "UNAUTHORIZED";
  const serverMessage =
    isRecord(payload) && typeof payload.message === "string"
      ? payload.message
      : undefined;

  return new ToolError(code, UNAUTHORIZED_GUIDANCE, {
    status: 401,
    ...(serverMessage ? { serverMessage } : {}),
  });
}

function createApiClient(deps: McpServerDeps) {
  const baseUrl = deps.serverUrl.replace(/\/+$/, "");

  async function request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      schemaHash?: string;
    } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.apiKey}`,
      "x-mdcms-project": deps.project,
      "x-mdcms-environment": deps.environment,
    };

    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (init.schemaHash) {
      headers["x-mdcms-schema-hash"] = init.schemaHash;
    }

    let response: Response;

    try {
      response = await deps.fetcher(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      throw new ToolError(
        "SERVER_UNREACHABLE",
        `Could not reach the MDCMS server at ${baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const payload = (await response.json().catch(() => undefined)) as unknown;

    if (response.status === 401) {
      throw createUnauthorizedError(payload);
    }

    if (!response.ok) {
      if (isRecord(payload) && typeof payload.code === "string") {
        throw new ToolError(
          payload.code,
          typeof payload.message === "string"
            ? payload.message
            : `Server responded with ${response.status}.`,
          isRecord(payload.details) ? payload.details : undefined,
        );
      }

      throw new ToolError(
        "REQUEST_FAILED",
        `Server responded with ${response.status}.`,
        { status: response.status },
      );
    }

    return payload;
  }

  return { request };
}

function readData(payload: unknown): unknown {
  if (!isRecord(payload) || !("data" in payload)) {
    throw new ToolError(
      "REQUEST_FAILED",
      "Unexpected response from the MDCMS server.",
    );
  }

  return payload.data;
}

function readDocument(payload: unknown): RemoteDocument {
  const data = readData(payload);

  if (
    !isRecord(data) ||
    typeof data.documentId !== "string" ||
    typeof data.type !== "string" ||
    typeof data.path !== "string" ||
    typeof data.draftRevision !== "number" ||
    !isRecord(data.frontmatter)
  ) {
    throw new ToolError(
      "REQUEST_FAILED",
      "Unexpected document response from the MDCMS server.",
    );
  }

  return data as RemoteDocument;
}

function readSchema(payload: unknown): RemoteSchema {
  const data = readData(payload);

  if (!isRecord(data) || !Array.isArray(data.types)) {
    throw new ToolError(
      "REQUEST_FAILED",
      "Unexpected schema response from the MDCMS server.",
    );
  }

  return {
    types: data.types as RemoteSchemaType[],
    schemaHash: typeof data.schemaHash === "string" ? data.schemaHash : null,
    syncedAt: typeof data.syncedAt === "string" ? data.syncedAt : null,
  };
}

function toDocumentStatus(document: Record<string, unknown>) {
  return {
    documentId: document.documentId,
    type: document.type,
    path: document.path,
    locale: document.locale,
    format: document.format,
    draftRevision: document.draftRevision,
    publishedVersion: document.publishedVersion ?? null,
    hasUnpublishedChanges: document.hasUnpublishedChanges,
    updatedAt: document.updatedAt,
  };
}

function toDocumentSummary(document: Record<string, unknown>) {
  return {
    ...toDocumentStatus(document),
    frontmatter: document.frontmatter,
  };
}

function toDocumentDetail(document: Record<string, unknown>) {
  return {
    ...toDocumentSummary(document),
    body: document.body,
  };
}

function mergeFrontmatter(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

export function createMdcmsMcpServer(deps: McpServerDeps): McpServer {
  const api = createApiClient(deps);
  const loadConfig = deps.loadConfig ?? loadCliConfig;
  const target = `${deps.project}/${deps.environment}`;

  async function fetchSchema(): Promise<RemoteSchema> {
    return readSchema(await api.request("/api/v1/schema"));
  }

  async function requireSchemaHash(): Promise<string> {
    const state = await readSchemaState({
      cwd: deps.cwd,
      project: deps.project,
      environment: deps.environment,
    });

    if (!state) {
      throw new ToolError(
        "SCHEMA_STATE_MISSING",
        "No local schema state found for this target. Call sync_schema (or run `mdcms schema sync`) before writing content.",
      );
    }

    return state.schemaHash;
  }

  async function requireValidFrontmatter(input: {
    typeName: string;
    frontmatter: Record<string, unknown>;
  }): Promise<{ schemaType: RemoteSchemaType; warnings: string[] }> {
    const schema = await fetchSchema();
    const schemaType = schema.types.find(
      (entry) => entry.type === input.typeName,
    );

    if (!schemaType) {
      throw new ToolError(
        "UNKNOWN_TYPE",
        `Content type "${input.typeName}" is not in the synced schema for ${target}.`,
        { knownTypes: schema.types.map((entry) => entry.type) },
      );
    }

    const { errors, warnings } = validateFrontmatter(
      input.frontmatter,
      schemaType.resolvedSchema,
    );

    if (errors.length > 0) {
      throw new ToolError(
        "INVALID_FRONTMATTER",
        `Frontmatter does not match the schema for type "${input.typeName}". Nothing was written.`,
        { errors, warnings },
      );
    }

    return { schemaType, warnings };
  }

  const server = new McpServer({
    name: "mdcms",
    version: deps.version ?? "0.0.0",
  });

  server.registerTool(
    "get_credentials_info",
    {
      title: "Get credentials info",
      description: `Report the server and target (${target}) this MCP server uses, what its API key is allowed to do there, and which tools that key can run. Call this first when a tool fails with FORBIDDEN or UNAUTHORIZED. ${describeScopes("get_credentials_info")}`,
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(async () => {
        const data = readData(await api.request("/api/v1/me/capabilities"));

        if (!isRecord(data) || !isRecord(data.capabilities)) {
          throw new ToolError(
            "REQUEST_FAILED",
            "Unexpected capabilities response from the MDCMS server.",
          );
        }

        const capabilities = data.capabilities as Record<
          string,
          Record<string, boolean>
        >;
        const grantedScopes = Object.entries(SCOPE_CAPABILITY)
          .filter(([, granted]) => granted(capabilities))
          .map(([scope]) => scope);
        const tools = Object.fromEntries(
          (Object.keys(MCP_TOOL_SCOPES) as McpToolName[]).map((tool) => {
            const requiredScopes: readonly string[] = MCP_TOOL_SCOPES[tool];

            return [
              tool,
              {
                requiredScopes,
                allowed: requiredScopes.every((scope) =>
                  grantedScopes.includes(scope),
                ),
              },
            ];
          }),
        );

        return {
          serverUrl: deps.serverUrl,
          project: deps.project,
          environment: deps.environment,
          grantedScopes,
          capabilities,
          tools,
          ...(grantedScopes.includes("content:publish")
            ? {}
            : { publishing: PUBLISH_KEY_GUIDANCE }),
        };
      }),
  );

  server.registerTool(
    "get_schema",
    {
      title: "Get schema",
      description: `Return the content types and fields synced for ${target}. Call this before creating or updating documents so frontmatter matches the schema. ${describeScopes("get_schema")}`,
      annotations: { readOnlyHint: true },
    },
    () =>
      runTool(async () => {
        const schema = await fetchSchema();

        return {
          project: deps.project,
          environment: deps.environment,
          schemaHash: schema.schemaHash,
          syncedAt: schema.syncedAt,
          types: schema.types.map((entry) => ({
            type: entry.type,
            directory: entry.directory,
            localized: entry.localized,
            fields: entry.resolvedSchema.fields,
          })),
        };
      }),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: `List draft documents in ${target} with frontmatter and status, without bodies. Page through results with limit and offset. ${describeScopes("list_documents")}`,
      inputSchema: {
        type: z.string().min(1).optional().describe("Content type name"),
        locale: z.string().min(1).optional(),
        q: z.string().min(1).optional().describe("Text search"),
        published: z
          .boolean()
          .optional()
          .describe("Only documents that have (or lack) a published version"),
        hasUnpublishedChanges: z.boolean().optional(),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      runTool(async () => {
        const query = new URLSearchParams({ draft: "true" });

        if (input.type) query.set("type", input.type);
        if (input.locale) query.set("locale", input.locale);
        if (input.q) query.set("q", input.q);
        if (input.published !== undefined) {
          query.set("published", String(input.published));
        }
        if (input.hasUnpublishedChanges !== undefined) {
          query.set(
            "hasUnpublishedChanges",
            String(input.hasUnpublishedChanges),
          );
        }
        query.set("limit", String(input.limit ?? DEFAULT_LIST_LIMIT));
        query.set("offset", String(input.offset ?? 0));

        const payload = await api.request(`/api/v1/content?${query}`);
        const data = readData(payload);

        if (!Array.isArray(data)) {
          throw new ToolError(
            "REQUEST_FAILED",
            "Unexpected list response from the MDCMS server.",
          );
        }

        return {
          documents: data.filter(isRecord).map(toDocumentSummary),
          pagination: isRecord(payload) ? payload.pagination : undefined,
        };
      }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description: `Return one draft document from ${target}, including its Markdown body. ${describeScopes("get_document")}`,
      inputSchema: {
        documentId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      runTool(async () => {
        const document = readDocument(
          await api.request(
            `/api/v1/content/${encodeURIComponent(input.documentId)}?draft=true`,
          ),
        );

        return toDocumentDetail(document);
      }),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create document",
      description: `Create a draft document in ${target}. Frontmatter is validated against the synced schema first. The path must be "<type directory>/<slug>" without a file extension. The document is not published. ${describeScopes("create_document")}`,
      inputSchema: {
        type: z.string().min(1).describe("Content type name"),
        path: z
          .string()
          .min(1)
          .describe('Document path, for example "content/posts/my-post"'),
        frontmatter: z.record(z.string(), z.unknown()),
        body: z.string().describe("Markdown or MDX body"),
        locale: z
          .string()
          .min(1)
          .optional()
          .describe("Locale for localized types; ignored otherwise"),
        format: z.enum(["md", "mdx"]).optional(),
      },
    },
    (input) =>
      runTool(async () => {
        const schemaHash = await requireSchemaHash();
        const { schemaType, warnings } = await requireValidFrontmatter({
          typeName: input.type,
          frontmatter: input.frontmatter,
        });
        const directory = schemaType.directory.replace(/\/+$/, "");

        if (!input.path.startsWith(`${directory}/`)) {
          throw new ToolError(
            "INVALID_INPUT",
            `Documents of type "${input.type}" must use a path inside "${directory}/".`,
            { path: input.path, directory },
          );
        }

        const locale = schemaType.localized
          ? (input.locale ?? deps.defaultLocale)
          : NON_LOCALIZED_DOCUMENT_LOCALE;

        if (!locale) {
          throw new ToolError(
            "INVALID_INPUT",
            `Type "${input.type}" is localized. Provide "locale".`,
          );
        }

        const document = readDocument(
          await api.request("/api/v1/content", {
            method: "POST",
            schemaHash,
            body: {
              type: input.type,
              path: input.path,
              locale,
              format: input.format ?? "md",
              frontmatter: input.frontmatter,
              body: input.body,
            },
          }),
        );

        return {
          created: toDocumentSummary(document),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }),
  );

  server.registerTool(
    "update_document",
    {
      title: "Update document",
      description: `Update a draft document in ${target}. "frontmatter" is a patch: listed keys are merged over the stored frontmatter and a null value removes a key. "body" replaces the whole body. The merged frontmatter is validated against the synced schema before anything is written. The document is not published. ${describeScopes("update_document")}`,
      inputSchema: {
        documentId: z.string().min(1),
        frontmatter: z.record(z.string(), z.unknown()).optional(),
        body: z.string().optional(),
      },
    },
    (input) =>
      runTool(async () => {
        if (input.frontmatter === undefined && input.body === undefined) {
          throw new ToolError(
            "INVALID_INPUT",
            'Provide "frontmatter", "body", or both.',
          );
        }

        const schemaHash = await requireSchemaHash();
        const documentPath = `/api/v1/content/${encodeURIComponent(input.documentId)}`;
        const current = readDocument(
          await api.request(`${documentPath}?draft=true`),
        );
        const frontmatter = mergeFrontmatter(
          current.frontmatter,
          input.frontmatter ?? {},
        );
        const { warnings } = await requireValidFrontmatter({
          typeName: current.type,
          frontmatter,
        });

        const document = readDocument(
          await api.request(documentPath, {
            method: "PUT",
            schemaHash,
            body: {
              frontmatter,
              ...(input.body !== undefined ? { body: input.body } : {}),
              draftRevision: current.draftRevision,
            },
          }),
        );

        return {
          updated: toDocumentSummary(document),
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }),
  );

  server.registerTool(
    "publish_document",
    {
      title: "Publish document",
      description: `Publish the current draft of a document in ${target} as a new immutable version. ${describeScopes("publish_document")} ${PUBLISH_KEY_GUIDANCE}`,
      inputSchema: {
        documentId: z.string().min(1),
        changeSummary: z.string().min(1).optional(),
      },
    },
    (input) =>
      runTool(async () => {
        const document = readDocument(
          await api.request(
            `/api/v1/content/${encodeURIComponent(input.documentId)}/publish`,
            {
              method: "POST",
              body: input.changeSummary
                ? { changeSummary: input.changeSummary }
                : {},
            },
          ),
        );

        return { published: toDocumentStatus(document) };
      }),
  );

  server.registerTool(
    "sync_schema",
    {
      title: "Sync schema",
      description: `Reload mdcms.config.ts from disk and sync its schema to ${target}, the same as \`mdcms schema sync\`. Call this after editing content types or fields in mdcms.config.ts. ${describeScopes("sync_schema")}`,
    },
    () =>
      runTool(async () => {
        let config: ParsedMdcmsConfig;

        try {
          const loaded = await loadConfig({
            cwd: deps.cwd,
            configPath: deps.configPath,
          });
          config = loaded.config as ParsedMdcmsConfig;
        } catch (error) {
          throw new ToolError(
            "CONFIG_LOAD_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }

        let result: Awaited<ReturnType<typeof performSchemaSync>>;

        try {
          result = await performSchemaSync({
            config,
            serverUrl: deps.serverUrl,
            project: deps.project,
            environment: deps.environment,
            apiKey: deps.apiKey,
            cwd: deps.cwd,
            fetcher: deps.fetcher,
          });
        } catch (error) {
          throw new ToolError(
            "SERVER_UNREACHABLE",
            `Could not reach the MDCMS server at ${deps.serverUrl}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        if (result.outcome === "failure") {
          if (result.errorCode === "UNAUTHORIZED") {
            throw createUnauthorizedError({
              code: result.errorCode,
              message: result.message,
            });
          }

          throw new ToolError(result.errorCode, result.message, result.details);
        }

        return {
          schemaHash: result.schemaHash,
          syncedAt: result.syncedAt,
          affectedTypes: result.affectedTypes,
        };
      }),
  );

  return server;
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
    "Run a Model Context Protocol server over stdio (preview).",
    "",
    "Tools and the API key scopes they need:",
    ...(Object.keys(MCP_TOOL_SCOPES) as McpToolName[]).map((tool) => {
      const scopes: readonly string[] = MCP_TOOL_SCOPES[tool];
      return `  ${tool.padEnd(22)}${scopes.length > 0 ? scopes.join(", ") : "(any valid key)"}`;
    }),
    "",
    "Register it with an MCP client from your project root, for example:",
    "  claude mcp add mdcms -- npx mdcms mcp",
    "",
    "Credentials resolve like other commands: --api-key, MDCMS_API_KEY,",
    "or the profile stored by `mdcms login` or `mdcms init`. That stored key",
    "has these scopes:",
    `  ${DEFAULT_CLI_LOGIN_SCOPES.join(", ")}`,
    "It does not include content:publish, so publish_document fails with it.",
    "To publish, create a key with content:publish in Studio (Settings) and",
    "pass it with MDCMS_API_KEY or --api-key.",
    "",
    "Call get_credentials_info to see what the active key can do.",
    "",
  ].join("\n");
}

/**
 * stdout carries protocol messages only, so console output that would
 * normally land there (runtime logger info/debug lines) is sent to stderr for
 * the lifetime of the server.
 */
function routeConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
  };

  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
  };
}

export type McpCommandOptions = {
  createTransport?: () => Transport;
  version?: string;
};

export function createMcpCommand(options: McpCommandOptions = {}): CliCommand {
  return {
    name: "mcp",
    description: "Run an MCP server over stdio for AI agents (preview)",
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

      const restoreConsole = routeConsoleToStderr();

      try {
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
        });
        const closed = new Promise<void>((resolve) => {
          server.server.onclose = () => resolve();
        });
        let transport: Transport;

        if (options.createTransport) {
          transport = options.createTransport();
        } else {
          transport = new StdioServerTransport();
          // The stdio transport does not observe end-of-input, so the client
          // closing stdin is translated into a server close here.
          const closeOnEnd = () => {
            void server.close();
          };
          process.stdin.once("end", closeOnEnd);
          process.stdin.once("close", closeOnEnd);
        }

        await server.connect(transport);
        context.stderr.write(
          `mdcms mcp: serving ${context.project}/${context.environment} at ${context.serverUrl}\n`,
        );
        await closed;

        return 0;
      } finally {
        restoreConsole();
      }
    },
  };
}
