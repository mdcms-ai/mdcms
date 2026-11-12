import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
  ParsedMdcmsConfig,
} from "@mdcms/shared";
import { RuntimeError, inferContentFormat } from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";

import { readSchemaState } from "./schema-state.js";

import type { CliCommand, CliCommandContext } from "./framework.js";
import {
  loadScopedManifest,
  resolveScopedManifestPath,
  type ScopedManifest,
} from "./manifest.js";
import { hashContent } from "./push.js";
import { resolveTrackedFilePath } from "./discover.js";

type ContentDocumentPayload = Pick<
  ContentDocumentResponse,
  | "documentId"
  | "type"
  | "locale"
  | "path"
  | "format"
  | "frontmatter"
  | "body"
  | "draftRevision"
  | "publishedVersion"
>;

type DriftCategory =
  | "modified_on_server"
  | "modified_locally"
  | "both_modified"
  | "new_on_server"
  | "deleted_on_server"
  | "moved_renamed"
  | "unchanged";

type DriftEntry = {
  category: DriftCategory;
  documentId: string;
  localPath?: string;
  serverPath?: string;
  manifestRevision?: number;
  serverRevision?: number;
};

export function renderStatusHelp(): string {
  return [
    "Usage: mdcms status",
    "",
    "Show sync status comparing local content versions against the server.",
    "",
    "Options:",
    "  -h, --help   Show this help text",
    "",
  ].join("\n");
}

function toRequestHeaders(context: CliCommandContext): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "x-mdcms-project": context.project,
    "x-mdcms-environment": context.environment,
  });

  if (context.apiKey) {
    headers.set("authorization", `Bearer ${context.apiKey}`);
  }

  return headers;
}

function encodeScopeQuery(input: {
  project: string;
  environment: string;
  draft: boolean;
  limit: number;
  offset: number;
}): string {
  const query = new URLSearchParams();
  query.set("project", input.project);
  query.set("environment", input.environment);
  query.set("draft", input.draft ? "true" : "false");
  query.set("limit", String(input.limit));
  query.set("offset", String(input.offset));
  return query.toString();
}

async function fetchContentPage(
  context: CliCommandContext,
  input: {
    draft: boolean;
    offset: number;
    limit: number;
  },
): Promise<{
  data: ContentDocumentPayload[];
  pagination: {
    hasMore: boolean;
    offset: number;
    limit: number;
    total: number;
  };
}> {
  const query = encodeScopeQuery({
    project: context.project,
    environment: context.environment,
    draft: input.draft,
    limit: input.limit,
    offset: input.offset,
  });
  const response = await context.fetcher(
    `${context.serverUrl}/api/v1/content?${query}`,
    {
      method: "GET",
      headers: toRequestHeaders(context),
    },
  );

  const body = (await response.json().catch(() => undefined)) as
    | ({
        code?: string;
        message?: string;
      } & Partial<ApiPaginatedEnvelope<ContentDocumentPayload>>)
    | undefined;

  if (!response.ok) {
    throw new RuntimeError({
      code: body?.code ?? "REMOTE_ERROR",
      message: body?.message ?? `Content request failed (${response.status}).`,
      statusCode: response.status,
    });
  }

  if (!body?.data || !body.pagination) {
    throw new RuntimeError({
      code: "REMOTE_ERROR",
      message: "Content API response is missing data/pagination payload.",
      statusCode: 502,
    });
  }

  return {
    data: body.data,
    pagination: body.pagination,
  };
}

async function fetchAllContent(
  context: CliCommandContext,
  input: { draft: boolean },
): Promise<ContentDocumentPayload[]> {
  const rows: ContentDocumentPayload[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const page = await fetchContentPage(context, {
      draft: input.draft,
      offset,
      limit,
    });
    rows.push(...page.data);

    if (!page.pagination.hasMore) {
      break;
    }

    offset = page.pagination.offset + page.pagination.limit;
  }

  return rows;
}

/**
 * The local path `pull` would write for a remote document, or `undefined` when
 * the document's type is not in the local config. `pull` skips such documents,
 * so status skips them too instead of failing.
 */
function resolveLocalPathForDocument(
  context: CliCommandContext,
  document: ContentDocumentPayload,
): string | undefined {
  const typeConfig = context.config.types?.find(
    (entry) => entry.name === document.type,
  );

  if (!typeConfig) {
    return undefined;
  }

  const basePath = document.path.replace(/^\/+/, "");
  // The local extension follows the body, as the server's format does.
  const extension = inferContentFormat(document.body);

  if (typeConfig.localized) {
    const locale = document.locale.trim();

    if (!locale) {
      throw new RuntimeError({
        code: "INVALID_REMOTE_DOCUMENT",
        message: `Remote document "${document.documentId}" is missing locale for localized type "${document.type}".`,
        statusCode: 400,
      });
    }

    return `${basePath}.${locale}.${extension}`;
  }

  return `${basePath}.${extension}`;
}

async function readLocalFileHash(
  absolutePath: string,
): Promise<string | undefined> {
  try {
    const content = await readFile(absolutePath, "utf8");
    return hashContent(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function computeDriftAsync(input: {
  context: CliCommandContext;
  serverDocuments: ContentDocumentPayload[];
  manifest: ScopedManifest;
}): Promise<DriftEntry[]> {
  const entries: DriftEntry[] = [];
  const seenDocumentIds = new Set<string>();
  const skippedTypes = new Map<string, number>();

  for (const serverDoc of input.serverDocuments) {
    seenDocumentIds.add(serverDoc.documentId);
    const serverLocalPath = resolveLocalPathForDocument(
      input.context,
      serverDoc,
    );

    if (serverLocalPath === undefined) {
      skippedTypes.set(
        serverDoc.type,
        (skippedTypes.get(serverDoc.type) ?? 0) + 1,
      );
      continue;
    }

    const manifestEntry = input.manifest[serverDoc.documentId];

    if (!manifestEntry) {
      entries.push({
        category: "new_on_server",
        documentId: serverDoc.documentId,
        serverPath: serverLocalPath,
        serverRevision: serverDoc.draftRevision,
      });
      continue;
    }

    const manifestPath = manifestEntry.path;
    // A file renamed between .md and .mdx is still this document.
    const localPath =
      (await resolveTrackedFilePath(input.context.cwd, manifestPath)) ??
      manifestPath;

    // `pull` would write the document somewhere other than where it is now.
    // A local .md/.mdx rename that already matches the server path is not a
    // pending move; it is classified as a local change below.
    const pathChanged =
      manifestPath !== serverLocalPath && localPath !== serverLocalPath;

    if (pathChanged) {
      entries.push({
        category: "moved_renamed",
        documentId: serverDoc.documentId,
        localPath,
        serverPath: serverLocalPath,
        manifestRevision: manifestEntry.draftRevision,
        serverRevision: serverDoc.draftRevision,
      });
      continue;
    }
    const localFileHash = await readLocalFileHash(
      join(input.context.cwd, localPath),
    );
    // An unpushed .md/.mdx rename is a local change even with equal content.
    const localModified =
      localPath !== manifestPath ||
      (localFileHash !== undefined && localFileHash !== manifestEntry.hash);

    const serverModified =
      serverDoc.draftRevision !== manifestEntry.draftRevision;

    if (localModified && serverModified) {
      entries.push({
        category: "both_modified",
        documentId: serverDoc.documentId,
        localPath,
        manifestRevision: manifestEntry.draftRevision,
        serverRevision: serverDoc.draftRevision,
      });
    } else if (serverModified) {
      entries.push({
        category: "modified_on_server",
        documentId: serverDoc.documentId,
        localPath,
        manifestRevision: manifestEntry.draftRevision,
        serverRevision: serverDoc.draftRevision,
      });
    } else if (localModified) {
      entries.push({
        category: "modified_locally",
        documentId: serverDoc.documentId,
        localPath,
        manifestRevision: manifestEntry.draftRevision,
      });
    } else {
      entries.push({
        category: "unchanged",
        documentId: serverDoc.documentId,
        localPath,
      });
    }
  }

  for (const [documentId, manifestEntry] of Object.entries(input.manifest)) {
    if (seenDocumentIds.has(documentId)) {
      continue;
    }

    entries.push({
      category: "deleted_on_server",
      documentId,
      localPath: manifestEntry.path,
      manifestRevision: manifestEntry.draftRevision,
    });
  }

  for (const [type, count] of skippedTypes) {
    input.context.stderr.write(
      `Warning: Skipping ${count} document(s) of type "${type}" (not defined in local config).\n`,
    );
  }

  return entries;
}

const CATEGORY_LABELS: Record<DriftCategory, string> = {
  modified_on_server: "Modified on server",
  modified_locally: "Modified locally",
  both_modified: "Both modified",
  new_on_server: "New on server",
  deleted_on_server: "Deleted on server",
  moved_renamed: "Moved/Renamed",
  unchanged: "Unchanged",
};

const DISPLAY_ORDER: DriftCategory[] = [
  "modified_on_server",
  "modified_locally",
  "both_modified",
  "new_on_server",
  "deleted_on_server",
  "moved_renamed",
  "unchanged",
];

function groupByCategory(
  entries: DriftEntry[],
): Map<DriftCategory, DriftEntry[]> {
  const groups = new Map<DriftCategory, DriftEntry[]>();

  for (const entry of entries) {
    const rows = groups.get(entry.category) ?? [];
    rows.push(entry);
    groups.set(entry.category, rows);
  }

  return groups;
}

function formatEntryDetail(entry: DriftEntry): string {
  const path = entry.localPath ?? entry.serverPath ?? entry.documentId;

  switch (entry.category) {
    case "modified_on_server":
      return `    ${path}${padRevisionInfo(`(local: r${entry.manifestRevision}, server: r${entry.serverRevision})`)}`;
    case "modified_locally":
      return `    ${path}${padRevisionInfo(`(local file differs from r${entry.manifestRevision})`)}`;
    case "both_modified":
      return `    ${path}${padRevisionInfo(`(local: r${entry.manifestRevision}, server: r${entry.serverRevision})`)}`;
    case "new_on_server":
      return `    ${path}${padRevisionInfo(`(server: r${entry.serverRevision})`)}`;
    case "deleted_on_server":
      return `    ${path}`;
    case "moved_renamed":
      return `    ${entry.localPath} -> ${entry.serverPath}${padRevisionInfo(describeMove(entry))}`;
    default:
      return `    ${path}`;
  }
}

/**
 * Moves read "current local path -> path after pull". When only the extension
 * differs, the server inferred a different format from the body.
 */
function describeMove(entry: DriftEntry): string {
  const extension = /\.(md|mdx)$/i;
  const localBase = entry.localPath?.replace(extension, "");
  const serverBase = entry.serverPath?.replace(extension, "");
  const format = entry.serverPath?.match(extension)?.[1]?.toLowerCase();

  if (localBase === serverBase && format) {
    return `(the server stores this body as ${format}; mdcms pull will rename the local file)`;
  }

  return "(mdcms pull will move the local file)";
}

function padRevisionInfo(info: string): string {
  return `       ${info}`;
}

function renderDriftReport(
  context: CliCommandContext,
  entries: DriftEntry[],
): void {
  const groups = groupByCategory(entries);

  context.stdout.write("\nContent:\n");

  for (const category of DISPLAY_ORDER) {
    const rows = groups.get(category) ?? [];

    if (rows.length === 0) {
      continue;
    }

    if (category === "unchanged") {
      context.stdout.write(`\n  Unchanged: ${rows.length} files\n`);
      continue;
    }

    const label = CATEGORY_LABELS[category];
    const legend =
      category === "moved_renamed"
        ? " local path -> path after mdcms pull"
        : "";
    context.stdout.write(`\n  ${label} (${rows.length}):${legend}\n`);

    for (const entry of rows) {
      context.stdout.write(`${formatEntryDetail(entry)}\n`);
    }
  }
}

type SchemaDriftStatus = "in_sync" | "drifted" | "no_state";

async function detectSchemaDrift(
  context: CliCommandContext,
): Promise<{ status: SchemaDriftStatus; syncedAt?: string }> {
  const state = await readSchemaState({
    cwd: context.cwd,
    project: context.project,
    environment: context.environment,
  });

  if (!state) {
    return { status: "no_state" };
  }

  let currentHash: string;
  try {
    currentHash = buildSchemaSyncPayload(
      context.config as ParsedMdcmsConfig,
      context.environment,
    ).schemaHash;
  } catch {
    return { status: "no_state" };
  }

  if (currentHash === state.schemaHash) {
    return { status: "in_sync", syncedAt: state.syncedAt };
  }

  return { status: "drifted" };
}

function renderSchemaReport(
  context: CliCommandContext,
  result: { status: SchemaDriftStatus; syncedAt?: string },
): void {
  context.stdout.write("\nSchema:\n");

  switch (result.status) {
    case "in_sync":
      context.stdout.write(`  In sync (synced ${result.syncedAt})\n`);
      break;
    case "drifted":
      context.stdout.write(
        "  Local schema differs from last sync. Run `mdcms schema sync`.\n",
      );
      break;
    case "no_state":
      context.stdout.write(
        "  No synced schema found.\n" +
          "  If you just cloned this repo, run: mdcms schema sync && mdcms pull\n",
      );
      break;
  }
}

export async function runStatusCommand(
  context: CliCommandContext,
): Promise<number> {
  if (context.args.includes("--help") || context.args.includes("-h")) {
    context.stdout.write(renderStatusHelp());
    return 0;
  }

  context.stdout.write(
    `Fetching content from ${context.serverUrl} (${context.environment})...\n`,
  );
  context.stdout.write(`Project: ${context.project}\n`);

  const serverDocuments = await fetchAllContent(context, { draft: true });

  const manifestPath = resolveScopedManifestPath({
    cwd: context.cwd,
    project: context.project,
    environment: context.environment,
  });
  const manifest = await loadScopedManifest(manifestPath);

  const driftEntries = await computeDriftAsync({
    context,
    serverDocuments,
    manifest,
  });

  renderDriftReport(context, driftEntries);

  const schemaDrift = await detectSchemaDrift(context);
  renderSchemaReport(context, schemaDrift);

  const hasContentDrift = driftEntries.some(
    (entry) => entry.category !== "unchanged",
  );
  const hasSchemaDrift = schemaDrift.status !== "in_sync";

  return hasContentDrift || hasSchemaDrift ? 1 : 0;
}

export function createStatusCommand(): CliCommand {
  return {
    name: "status",
    description: "Show sync status (local vs server versions)",
    renderHelp: renderStatusHelp,
    run: runStatusCommand,
  };
}
