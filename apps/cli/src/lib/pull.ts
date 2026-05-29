import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ApiPaginatedEnvelope,
  ContentDocumentResponse,
} from "@mdcms/shared";
import { RuntimeError } from "@mdcms/shared";
import { stringify as stringifyYaml } from "yaml";

import type { CliCommand, CliCommandContext } from "./framework.js";
import {
  loadScopedManifest,
  resolveScopedManifestPath,
  writeScopedManifestAtomic,
  type ScopedManifest,
} from "./manifest.js";

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

type PullChangeStatus =
  | "Modified"
  | "Locally modified"
  | "Locally modified (server unchanged)"
  | "Both modified"
  | "New"
  | "Moved/Renamed"
  | "Moved/Renamed (locally modified)"
  | "Deleted on server"
  | "Skipped (unknown type)"
  | "Unchanged";

type PullChange = {
  status: PullChangeStatus;
  documentId: string;
  nextPath?: string;
  previousPath?: string;
  format?: "md" | "mdx";
  draftRevision?: number;
  publishedVersion?: number | null;
  nextContent?: string;
  nextHash?: string;
};

type PullOptions = {
  published: boolean;
  force: boolean;
  dryRun: boolean;
};

function parseBooleanFlag(args: string[], long: string): boolean {
  return args.includes(long);
}

function parsePullOptions(args: string[]): PullOptions {
  for (const token of args) {
    if (
      token === "--published" ||
      token === "--force" ||
      token === "--dry-run"
    ) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      continue;
    }

    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Unknown pull flag "${token}".`,
      statusCode: 400,
    });
  }

  return {
    published: parseBooleanFlag(args, "--published"),
    force: parseBooleanFlag(args, "--force"),
    dryRun: parseBooleanFlag(args, "--dry-run"),
  };
}

function renderPullHelp(): string {
  return [
    "Usage: mdcms pull [--published] [--force] [--dry-run]",
    "",
    "Options:",
    "  --published   Pull published snapshots instead of draft heads",
    "  --force       Skip overwrite confirmation for locally modified files",
    "  --dry-run     Show plan only (no file writes)",
    "",
  ].join("\n");
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

function renderYaml(value: Record<string, unknown>): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

function renderMarkdownDocument(input: {
  frontmatter: Record<string, unknown>;
  body: string;
}): string {
  const hasFrontmatter = Object.keys(input.frontmatter).length > 0;
  const normalizedBody = input.body.endsWith("\n")
    ? input.body
    : `${input.body}\n`;

  if (!hasFrontmatter) {
    return normalizedBody;
  }

  return `---\n${renderYaml(input.frontmatter)}\n---\n\n${normalizedBody}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
  const extension = document.format;

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

async function readHash(path: string): Promise<string | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }

  const content = await readFile(path, "utf8");
  return hashContent(content);
}

function formatRevision(change: PullChange): string {
  const draftRevision =
    typeof change.draftRevision === "number" ? change.draftRevision : "-";
  const publishedVersion =
    typeof change.publishedVersion === "number" ? change.publishedVersion : "-";
  return `draft=${draftRevision}, published=${publishedVersion}`;
}

function groupChanges(
  changes: PullChange[],
): Map<PullChangeStatus, PullChange[]> {
  const groups = new Map<PullChangeStatus, PullChange[]>();

  for (const change of changes) {
    const rows = groups.get(change.status) ?? [];
    rows.push(change);
    groups.set(change.status, rows);
  }

  return groups;
}

function printPlan(context: CliCommandContext, changes: PullChange[]): void {
  const orderedStatuses: PullChangeStatus[] = [
    "Both modified",
    "Modified",
    "Locally modified (server unchanged)",
    "New",
    "Moved/Renamed (locally modified)",
    "Moved/Renamed",
    "Deleted on server",
    "Skipped (unknown type)",
    "Unchanged",
  ];
  const groups = groupChanges(changes);

  context.stdout.write("Pull plan:\n");
  for (const status of orderedStatuses) {
    const rows = groups.get(status) ?? [];

    if (rows.length === 0) {
      continue;
    }

    context.stdout.write(`\n${status} (${rows.length})\n`);

    for (const change of rows) {
      if (
        status === "Moved/Renamed" ||
        status === "Moved/Renamed (locally modified)"
      ) {
        context.stdout.write(
          `  - ${change.previousPath} -> ${change.nextPath} (${formatRevision(change)})\n`,
        );
        continue;
      }

      if (status === "Deleted on server") {
        context.stdout.write(
          `  - ${change.previousPath} (${formatRevision(change)})\n`,
        );
        continue;
      }

      context.stdout.write(
        `  - ${change.nextPath ?? change.previousPath} (${formatRevision(change)})\n`,
      );
    }
  }

  const serverUnchanged = groups.get("Locally modified (server unchanged)");
  if (serverUnchanged && serverUnchanged.length > 0) {
    context.stdout.write(
      `\nNote: ${serverUnchanged.length} file(s) modified locally but unchanged on server. Use 'cms push' to upload your changes.\n`,
    );
  }

  const bothModified = groups.get("Both modified");
  if (bothModified && bothModified.length > 0) {
    context.stdout.write(
      `\nWarning: ${bothModified.length} file(s) modified both locally and on server. Pull will overwrite local changes.\n` +
        `Consider backing up local changes before proceeding, then re-apply after pull.\n`,
    );
  }
}

async function writeContentFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function applyPullChanges(input: {
  context: CliCommandContext;
  changes: PullChange[];
  manifestPath: string;
  manifest: ScopedManifest;
}): Promise<void> {
  for (const change of input.changes) {
    // Skip statuses that should not write files
    if (
      change.status === "Unchanged" ||
      change.status === "Locally modified (server unchanged)" ||
      change.status === "Skipped (unknown type)"
    ) {
      continue;
    }

    if (change.status === "Deleted on server") {
      if (change.previousPath) {
        await rm(join(input.context.cwd, change.previousPath), { force: true });
      }

      delete input.manifest[change.documentId];
      continue;
    }

    if (
      !change.nextPath ||
      !change.nextContent ||
      !change.nextHash ||
      !change.format
    ) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "Pull planner generated invalid apply payload.",
        statusCode: 500,
      });
    }

    await writeContentFile(
      join(input.context.cwd, change.nextPath),
      change.nextContent,
    );

    if (
      (change.status === "Moved/Renamed" ||
        change.status === "Moved/Renamed (locally modified)") &&
      change.previousPath
    ) {
      await rm(join(input.context.cwd, change.previousPath), { force: true });
    }
    input.manifest[change.documentId] = {
      path: change.nextPath,
      format: change.format,
      draftRevision: change.draftRevision ?? 0,
      publishedVersion:
        typeof change.publishedVersion === "number"
          ? change.publishedVersion
          : null,
      hash: change.nextHash,
    };
  }

  await writeScopedManifestAtomic(input.manifestPath, input.manifest);
}

async function computePullChanges(input: {
  context: CliCommandContext;
  remoteDocuments: ContentDocumentPayload[];
  manifest: ScopedManifest;
}): Promise<PullChange[]> {
  const changes: PullChange[] = [];
  const seenDocumentIds = new Set<string>();
  const skippedTypes = new Map<string, number>();

  for (const document of input.remoteDocuments) {
    seenDocumentIds.add(document.documentId);
    const nextPath = resolveLocalPathForDocument(input.context, document);

    // Issue #4: gracefully skip documents with unknown types
    if (nextPath === undefined) {
      skippedTypes.set(
        document.type,
        (skippedTypes.get(document.type) ?? 0) + 1,
      );
      changes.push({
        status: "Skipped (unknown type)",
        documentId: document.documentId,
        nextPath: document.path,
      });
      continue;
    }

    const nextContent = renderMarkdownDocument({
      frontmatter: document.frontmatter,
      body: document.body,
    });
    const nextHash = hashContent(nextContent);
    const manifestEntry = input.manifest[document.documentId];

    if (!manifestEntry) {
      changes.push({
        status: "New",
        documentId: document.documentId,
        nextPath,
        format: document.format,
        draftRevision: document.draftRevision,
        publishedVersion: document.publishedVersion,
        nextContent,
        nextHash,
      });
      continue;
    }

    const manifestPath = manifestEntry.path;
    const localHash = await readHash(join(input.context.cwd, manifestPath));
    const localModified =
      localHash !== undefined && localHash !== manifestEntry.hash;
    const remoteChanged =
      nextHash !== manifestEntry.hash ||
      document.draftRevision !== manifestEntry.draftRevision ||
      document.publishedVersion !== manifestEntry.publishedVersion;
    const pathChanged =
      manifestPath !== nextPath || manifestEntry.format !== document.format;

    // Issue #3: move/rename must also check local modification
    if (pathChanged) {
      changes.push({
        status: localModified
          ? "Moved/Renamed (locally modified)"
          : "Moved/Renamed",
        documentId: document.documentId,
        previousPath: manifestPath,
        nextPath,
        format: document.format,
        draftRevision: document.draftRevision,
        publishedVersion: document.publishedVersion,
        nextContent,
        nextHash,
      });
      continue;
    }

    // Issues #1 and #2: distinguish all four combinations
    if (localModified && remoteChanged) {
      changes.push({
        status: "Both modified",
        documentId: document.documentId,
        nextPath,
        format: document.format,
        draftRevision: document.draftRevision,
        publishedVersion: document.publishedVersion,
        nextContent,
        nextHash,
      });
      continue;
    }

    if (localModified && !remoteChanged) {
      // Server unchanged — user should push, not pull
      changes.push({
        status: "Locally modified (server unchanged)",
        documentId: document.documentId,
        nextPath,
        format: document.format,
        draftRevision: document.draftRevision,
        publishedVersion: document.publishedVersion,
        nextContent,
        nextHash,
      });
      continue;
    }

    if (remoteChanged || !localHash) {
      changes.push({
        status: "Modified",
        documentId: document.documentId,
        nextPath,
        format: document.format,
        draftRevision: document.draftRevision,
        publishedVersion: document.publishedVersion,
        nextContent,
        nextHash,
      });
      continue;
    }

    changes.push({
      status: "Unchanged",
      documentId: document.documentId,
      nextPath,
      format: document.format,
      draftRevision: document.draftRevision,
      publishedVersion: document.publishedVersion,
      nextContent,
      nextHash,
    });
  }

  for (const [documentId, manifestEntry] of Object.entries(input.manifest)) {
    if (seenDocumentIds.has(documentId)) {
      continue;
    }

    changes.push({
      status: "Deleted on server",
      documentId,
      previousPath: manifestEntry.path,
      format: manifestEntry.format,
      draftRevision: manifestEntry.draftRevision,
      publishedVersion: manifestEntry.publishedVersion,
    });
  }

  // Issue #4: print summary of skipped types
  if (skippedTypes.size > 0) {
    for (const [type, count] of skippedTypes) {
      input.context.stderr.write(
        `Warning: Skipping ${count} document(s) of type "${type}" — not defined in local config.\n`,
      );
    }
  }

  return changes;
}

export async function runPullCommand(
  context: CliCommandContext,
): Promise<number> {
  if (context.args.includes("--help") || context.args.includes("-h")) {
    context.stdout.write(renderPullHelp());
    return 0;
  }

  const options = parsePullOptions(context.args);

  const remoteDocuments = await fetchAllContent(context, {
    draft: !options.published,
  });
  const manifestPath = resolveScopedManifestPath({
    cwd: context.cwd,
    project: context.project,
    environment: context.environment,
  });
  const manifest = await loadScopedManifest(manifestPath);
  const changes = await computePullChanges({
    context,
    remoteDocuments,
    manifest,
  });

  printPlan(context, changes);

  if (options.dryRun) {
    context.stdout.write("\nDry run complete. No files changed.\n");
    return 0;
  }

  // Build confirmation prompt covering all destructive statuses
  const hasBothModified = changes.some(
    (change) => change.status === "Both modified",
  );
  const hasMovedLocallyModified = changes.some(
    (change) => change.status === "Moved/Renamed (locally modified)",
  );
  const hasDeletedOnServer = changes.some(
    (change) => change.status === "Deleted on server",
  );
  const needsConfirmation =
    hasBothModified || hasMovedLocallyModified || hasDeletedOnServer;

  if (needsConfirmation && !options.force) {
    const parts: string[] = [];
    if (hasBothModified) {
      parts.push(
        "overwrite locally modified files that also changed on server",
      );
    }
    if (hasMovedLocallyModified) {
      parts.push(
        "move/rename files with local modifications (local changes will be lost)",
      );
    }
    if (hasDeletedOnServer) {
      parts.push("delete local files removed on server");
    }

    const confirmed = await context.confirm(
      `This will ${parts.join(", and ")}. Continue?`,
    );

    if (!confirmed) {
      context.stderr.write("Pull cancelled by user.\n");
      return 1;
    }
  }

  await applyPullChanges({
    context,
    changes,
    manifestPath,
    manifest,
  });

  context.stdout.write("\nPull complete.\n");
  return 0;
}

export function createPullCommand(): CliCommand {
  return {
    name: "pull",
    description: "Pull content from MDCMS into local files.",
    run: runPullCommand,
  };
}
