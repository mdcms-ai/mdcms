import type { ParsedMdcmsConfig } from "@mdcms/shared";
import { RuntimeError } from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";

import type { CliCommand, CliCommandContext } from "./framework.js";
import { writeSchemaState } from "./schema-state.js";

export type PerformSchemaSyncInput = {
  config: ParsedMdcmsConfig;
  serverUrl: string;
  project: string;
  environment: string;
  apiKey?: string;
  cwd: string;
  fetcher: typeof fetch;
};

export type PerformSchemaSyncResult =
  | {
      outcome: "success";
      schemaHash: string;
      syncedAt: string;
      affectedTypes: string[];
    }
  | {
      outcome: "failure";
      errorCode: string;
      message: string;
      details?: Record<string, unknown>;
    };

export async function performSchemaSync(
  input: PerformSchemaSyncInput,
): Promise<PerformSchemaSyncResult> {
  const { config, serverUrl, project, environment, apiKey, cwd, fetcher } =
    input;

  const payload = buildSchemaSyncPayload(config, environment);

  if (Object.keys(payload.resolvedSchema).length === 0) {
    return {
      outcome: "failure",
      errorCode: "NO_TYPES_DEFINED",
      message:
        "Refusing to sync an empty schema. Define at least one type in mdcms.config.ts before syncing.",
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-mdcms-project": project,
    "x-mdcms-environment": environment,
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await fetcher(`${serverUrl}/api/v1/schema`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { code?: string; message?: string; details?: Record<string, unknown> }
      | undefined;

    return {
      outcome: "failure",
      errorCode: body?.code ?? "SCHEMA_SYNC_FAILED",
      message: body?.message ?? `Server responded with ${response.status}`,
      details: body?.details,
    };
  }

  const result = (await response.json().catch(() => undefined)) as
    | { data?: unknown }
    | undefined;

  const data = isRecord(result?.data)
    ? (result!.data as Record<string, unknown>)
    : undefined;
  const schemaHash = data?.schemaHash;
  const syncedAt = data?.syncedAt;
  const affectedTypesRaw = data?.affectedTypes;

  if (
    typeof schemaHash !== "string" ||
    schemaHash.length === 0 ||
    typeof syncedAt !== "string" ||
    syncedAt.length === 0 ||
    !Array.isArray(affectedTypesRaw) ||
    !affectedTypesRaw.every((entry) => typeof entry === "string")
  ) {
    return {
      outcome: "failure",
      errorCode: "SCHEMA_SYNC_FAILED",
      message: "Unexpected response from server.",
    };
  }

  const affectedTypes = affectedTypesRaw as string[];

  await writeSchemaState(
    { cwd, project, environment },
    {
      schemaHash,
      syncedAt,
      serverUrl,
    },
  );

  return {
    outcome: "success",
    schemaHash,
    syncedAt,
    affectedTypes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runSchemaSync(context: CliCommandContext): Promise<number> {
  const {
    config,
    serverUrl: rawServerUrl,
    project,
    environment,
    apiKey,
    fetcher,
    stdout,
    stderr,
    cwd,
  } = context;
  const serverUrl = rawServerUrl!;

  const types = config.types ?? [];
  if (types.length === 0) {
    throw new RuntimeError({
      code: "NO_TYPES_DEFINED",
      message:
        `No content types defined in mdcms.config.ts.\n` +
        `Define at least one type before syncing schema, e.g.:\n\n` +
        `  const post = defineType("post", {\n` +
        `    directory: "content/posts",\n` +
        `    fields: { title: z.string() },\n` +
        `  });\n\n` +
        `Then pass it to defineConfig: types: [post]`,
      statusCode: 400,
    });
  }

  const result = await performSchemaSync({
    config: config as ParsedMdcmsConfig,
    serverUrl,
    project,
    environment,
    apiKey,
    cwd,
    fetcher,
  });

  if (result.outcome === "failure") {
    stderr.write(`${result.errorCode}: ${result.message}\n`);

    if (result.details) {
      stderr.write(`Details: ${JSON.stringify(result.details)}\n`);
    }

    return 1;
  }

  stdout.write(`Schema synced (hash: ${result.schemaHash.slice(0, 12)})\n`);

  if (result.affectedTypes.length > 0) {
    stdout.write(`Affected types: ${result.affectedTypes.join(", ")}\n`);
  }

  return 0;
}

export function createSchemaSyncCommand(): CliCommand {
  return {
    name: "schema sync",
    description: "Upload local schema to the server",
    run: runSchemaSync,
  };
}
