import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { discoverUntrackedFiles } from "./discover.js";

import type { ContentDocumentResponse } from "@mdcms/shared";
import {
  RuntimeError,
  serializeResolvedEnvironmentSchema,
  validateSchemaRegistryListResponse,
  type ParsedMdcmsConfig,
} from "@mdcms/shared";
import { buildSchemaSyncPayload } from "@mdcms/shared/server";
import { parse as parseYaml } from "yaml";
import { readSchemaState } from "./schema-state.js";
import {
  computeSchemaDiff,
  hashSchemaTypeSnapshot,
  type SchemaDiff,
} from "./schema-diff.js";
import { performSchemaSync } from "./schema-sync.js";
import {
  validateCandidates,
  type DocumentValidationResult,
} from "./validate.js";

import type { CliContentTypeConfig } from "./config.js";
import type { CliCommand, CliCommandContext } from "./framework.js";
import {
  loadScopedManifest,
  resolveScopedManifestPath,
  writeScopedManifestAtomic,
  type ScopedManifest,
  type ScopedManifestEntry,
} from "./manifest.js";

type PushOptions = {
  force: boolean;
  published: boolean;
  validate: boolean;
  dryRun: boolean;
  syncSchema: boolean;
};

type PushCandidate = {
  documentId: string;
  manifestEntry: ScopedManifestEntry;
  format: "md" | "mdx";
  frontmatter: Record<string, unknown>;
  body: string;
  hash: string;
};

type DeletionCandidate = {
  documentId: string;
  path: string;
  format: "md" | "mdx";
  draftRevision: number;
  publishedVersion: number | null;
};

type NewFileCandidate = {
  path: string;
  format: "md" | "mdx";
  frontmatter: Record<string, unknown>;
  body: string;
  hash: string;
  resolvedType: string;
  resolvedLocale: string;
  resolvedPath: string;
};

type PushPlan = {
  changedCandidates: PushCandidate[];
  newCandidates: NewFileCandidate[];
  deletionCandidates: DeletionCandidate[];
  trackedCount: number;
  unchangedCount: number;
};

type PushResult = {
  status: "updated" | "created" | "deleted" | "failed";
  documentId: string;
  nextDocumentId?: string;
  path: string;
  message: string;
  reasonCode?: string;
};

type ContentDocumentPayload = Pick<
  ContentDocumentResponse,
  | "documentId"
  | "type"
  | "locale"
  | "path"
  | "format"
  | "draftRevision"
  | "publishedVersion"
>;

export function parsePushOptions(args: string[]): PushOptions {
  for (const token of args) {
    if (
      token === "--published" ||
      token === "--force" ||
      token === "--validate" ||
      token === "--dry-run" ||
      token === "--sync-schema"
    ) {
      continue;
    }

    if (token === "--help" || token === "-h") {
      continue;
    }

    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Unknown push flag "${token}".`,
      statusCode: 400,
    });
  }

  return {
    force: args.includes("--force"),
    published: args.includes("--published"),
    validate: args.includes("--validate"),
    dryRun: args.includes("--dry-run"),
    syncSchema: args.includes("--sync-schema"),
  };
}

export function renderPushHelp(): string {
  return [
    "Usage: mdcms push [--force] [--dry-run] [--validate] [--published] [--sync-schema]",
    "",
    "Upload local markdown files to CMS as draft content.",
    "",
    "Behavior:",
    "  - Changed manifest-tracked files are updated on the server.",
    "  - New local files (in content directories, not yet tracked) are",
    "    detected and offered for upload via interactive selection.",
    "  - Locally-deleted files (in manifest but missing on disk) are",
    "    detected and offered for server-side deletion via interactive selection.",
    "  - Before any content writes, push runs a schema preflight: it compares",
    "    the local config's schema hash against the server. On drift in",
    "    interactive mode, push prompts once to sync. In non-interactive mode,",
    "    push fails closed unless --sync-schema is supplied.",
    "",
    "Options:",
    "  --force         Skip all prompts; auto-select all new/deleted files",
    "  --dry-run       Show push plan only (no API writes)",
    "  --validate      Validate frontmatter against local schema before pushing",
    "  --sync-schema   In non-interactive mode, allow push to sync schema before",
    "                  content writes if drift is detected. In interactive mode,",
    "                  this flag is ignored — drift always triggers a prompt.",
    "  --published     Reserved for future behavior (unsupported in demo mode)",
    "",
  ].join("\n");
}

function toRequestHeaders(
  context: CliCommandContext,
  schemaHash: string,
): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "x-mdcms-project": context.project,
    "x-mdcms-environment": context.environment,
    "x-mdcms-schema-hash": schemaHash,
  });

  if (context.apiKey) {
    headers.set("authorization", `Bearer ${context.apiKey}`);
  }

  return headers;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function parseFileFormat(path: string): "md" | "mdx" {
  const extension = extname(path).toLowerCase();

  if (extension === ".md") {
    return "md";
  }

  if (extension === ".mdx") {
    return "mdx";
  }

  throw new RuntimeError({
    code: "UNSUPPORTED_EXTENSION",
    message: `Only .md and .mdx files are supported for push. Received: "${path}".`,
    statusCode: 400,
    details: { path },
  });
}

export function parseMarkdownDocument(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (!frontmatterMatch) {
    throw new RuntimeError({
      code: "INVALID_LOCAL_DOCUMENT",
      message: "Frontmatter block is not closed with a terminating --- line.",
      statusCode: 400,
    });
  }

  const rawFrontmatter = frontmatterMatch[1] ?? "";
  const parsed = parseYaml(rawFrontmatter);

  if (parsed === null || parsed === undefined) {
    return {
      frontmatter: {},
      body: content.slice(frontmatterMatch[0].length),
    };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeError({
      code: "INVALID_LOCAL_DOCUMENT",
      message:
        "Frontmatter must resolve to an object map (arrays/scalars are not supported).",
      statusCode: 400,
    });
  }

  return {
    frontmatter: parsed as Record<string, unknown>,
    body: content.slice(frontmatterMatch[0].length),
  };
}

function normalizeDirectory(directory: string | undefined): string {
  if (!directory) {
    return "";
  }

  return directory.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function pickTypeConfigForPath(
  typeConfigs: readonly CliContentTypeConfig[],
  pathWithoutExtension: string,
): CliContentTypeConfig {
  let selected: CliContentTypeConfig | undefined;
  let selectedScore = -1;

  for (const typeConfig of typeConfigs) {
    const directory = normalizeDirectory(typeConfig.directory);

    if (directory.length === 0) {
      if (selectedScore < 0) {
        selected = typeConfig;
        selectedScore = 0;
      }
      continue;
    }

    if (
      pathWithoutExtension === directory ||
      pathWithoutExtension.startsWith(`${directory}/`)
    ) {
      if (directory.length > selectedScore) {
        selected = typeConfig;
        selectedScore = directory.length;
      }
    }
  }

  if (!selected) {
    throw new RuntimeError({
      code: "TYPE_MAPPING_MISSING",
      message: `Could not map local path "${pathWithoutExtension}" to a configured content type directory.`,
      statusCode: 400,
      details: {
        path: pathWithoutExtension,
      },
    });
  }

  return selected;
}

export function resolveCreatePayload(input: {
  path: string;
  format: "md" | "mdx";
  types: readonly CliContentTypeConfig[];
}): {
  type: string;
  path: string;
  locale: string;
} {
  const pathWithoutExtension = input.path.replace(/\.(md|mdx)$/i, "");

  if (pathWithoutExtension === input.path) {
    throw new RuntimeError({
      code: "UNSUPPORTED_EXTENSION",
      message: `Only .md and .mdx files are supported for push. Received: "${input.path}".`,
      statusCode: 400,
      details: { path: input.path },
    });
  }

  const typeConfig = pickTypeConfigForPath(input.types, pathWithoutExtension);

  if (typeConfig.localized) {
    const localeDelimiter = pathWithoutExtension.lastIndexOf(".");

    if (
      localeDelimiter <= 0 ||
      localeDelimiter >= pathWithoutExtension.length - 1
    ) {
      throw new RuntimeError({
        code: "INVALID_LOCAL_DOCUMENT",
        message: `Localized type "${typeConfig.name}" requires local file names in <path>.<locale>.${input.format} form.`,
        statusCode: 400,
        details: {
          type: typeConfig.name,
          path: input.path,
        },
      });
    }

    return {
      type: typeConfig.name,
      path: pathWithoutExtension.slice(0, localeDelimiter),
      locale: pathWithoutExtension.slice(localeDelimiter + 1),
    };
  }

  return {
    type: typeConfig.name,
    path: pathWithoutExtension,
    locale: "en",
  };
}

function parseRemoteDocument(body: unknown): ContentDocumentPayload {
  const payload = body as {
    data?: {
      documentId?: unknown;
      type?: unknown;
      locale?: unknown;
      path?: unknown;
      format?: unknown;
      draftRevision?: unknown;
      publishedVersion?: unknown;
    };
  };

  const data = payload?.data;

  if (!data || typeof data !== "object") {
    throw new RuntimeError({
      code: "REMOTE_ERROR",
      message: 'Server response is missing "data" payload.',
      statusCode: 502,
    });
  }

  if (
    typeof data.documentId !== "string" ||
    typeof data.type !== "string" ||
    typeof data.locale !== "string" ||
    typeof data.path !== "string" ||
    (data.format !== "md" && data.format !== "mdx") ||
    typeof data.draftRevision !== "number" ||
    !Number.isInteger(data.draftRevision) ||
    data.draftRevision < 0 ||
    !(
      data.publishedVersion === null ||
      (typeof data.publishedVersion === "number" &&
        Number.isInteger(data.publishedVersion) &&
        data.publishedVersion >= 0)
    )
  ) {
    throw new RuntimeError({
      code: "REMOTE_ERROR",
      message:
        "Server response does not match expected document payload shape.",
      statusCode: 502,
    });
  }

  return {
    documentId: data.documentId,
    type: data.type,
    locale: data.locale,
    path: data.path,
    format: data.format,
    draftRevision: data.draftRevision,
    publishedVersion: data.publishedVersion,
  };
}

function parseRemoteError(
  body: unknown,
  fallbackStatus: number,
): {
  code: string;
  message: string;
  statusCode: number;
} {
  const payload = body as { code?: unknown; message?: unknown };

  return {
    code: typeof payload?.code === "string" ? payload.code : "REMOTE_ERROR",
    message:
      typeof payload?.message === "string"
        ? payload.message
        : `Server request failed (${fallbackStatus}).`,
    statusCode: fallbackStatus,
  };
}

async function updateExistingDocument(
  context: CliCommandContext,
  candidate: PushCandidate,
  schemaHash: string,
): Promise<
  | {
      kind: "updated";
      remote: ContentDocumentPayload;
    }
  | {
      kind: "missing";
    }
  | {
      kind: "stale";
      code: string;
      message: string;
    }
  | {
      kind: "schema_mismatch";
      code: string;
      message: string;
    }
  | {
      kind: "path_conflict";
      code: string;
      message: string;
    }
> {
  const response = await context.fetcher(
    `${context.serverUrl}/api/v1/content/${candidate.documentId}?fileFields=raw`,
    {
      method: "PUT",
      headers: toRequestHeaders(context, schemaHash),
      body: JSON.stringify({
        format: candidate.format,
        frontmatter: candidate.frontmatter,
        body: candidate.body,
        draftRevision: candidate.manifestEntry.draftRevision,
        publishedVersion: candidate.manifestEntry.publishedVersion,
      }),
    },
  );

  const body = (await response.json().catch(() => undefined)) as unknown;

  if (response.ok) {
    return {
      kind: "updated",
      remote: parseRemoteDocument(body),
    };
  }

  if (response.status === 404) {
    return { kind: "missing" };
  }

  const remoteError = parseRemoteError(body, response.status);

  if (response.status === 409 && remoteError.code === "STALE_DRAFT_REVISION") {
    return {
      kind: "stale",
      code: remoteError.code,
      message: remoteError.message,
    };
  }

  if (response.status === 409 && remoteError.code === "SCHEMA_HASH_MISMATCH") {
    return {
      kind: "schema_mismatch",
      code: remoteError.code,
      message: remoteError.message,
    };
  }

  if (response.status === 409 && remoteError.code === "CONTENT_PATH_CONFLICT") {
    return {
      kind: "path_conflict",
      code: remoteError.code,
      message: `Path conflict for "${candidate.manifestEntry.path}". The manifest references a stale document ID. Run 'cms pull' to re-sync.`,
    };
  }

  throw new RuntimeError({
    code: remoteError.code,
    message: remoteError.message,
    statusCode: remoteError.statusCode,
  });
}

async function createDocumentFromLocalFile(
  context: CliCommandContext,
  candidate: PushCandidate,
  schemaHash: string,
): Promise<
  | { kind: "created"; remote: ContentDocumentPayload }
  | { kind: "schema_mismatch"; code: string; message: string }
  | { kind: "path_conflict"; code: string; message: string }
> {
  const types = context.config.types ?? [];

  if (types.length === 0) {
    throw new RuntimeError({
      code: "TYPE_MAPPING_MISSING",
      message:
        "Config must define at least one content type mapping to recreate missing documents.",
      statusCode: 400,
    });
  }

  const createTarget = resolveCreatePayload({
    path: candidate.manifestEntry.path,
    format: candidate.format,
    types,
  });

  const response = await context.fetcher(
    `${context.serverUrl}/api/v1/content?fileFields=raw`,
    {
      method: "POST",
      headers: toRequestHeaders(context, schemaHash),
      body: JSON.stringify({
        type: createTarget.type,
        path: createTarget.path,
        locale: createTarget.locale,
        format: candidate.format,
        frontmatter: candidate.frontmatter,
        body: candidate.body,
      }),
    },
  );

  const body = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    const remoteError = parseRemoteError(body, response.status);

    if (
      response.status === 409 &&
      remoteError.code === "SCHEMA_HASH_MISMATCH"
    ) {
      return {
        kind: "schema_mismatch",
        code: remoteError.code,
        message: remoteError.message,
      };
    }

    if (
      response.status === 409 &&
      remoteError.code === "CONTENT_PATH_CONFLICT"
    ) {
      return {
        kind: "path_conflict",
        code: remoteError.code,
        message: `Path "${createTarget.path}" already exists on server under a different document ID. Run 'cms pull' to re-sync your manifest.`,
      };
    }

    throw new RuntimeError({
      code: remoteError.code,
      message: remoteError.message,
      statusCode: remoteError.statusCode,
    });
  }

  return { kind: "created", remote: parseRemoteDocument(body) };
}

async function createNewDocument(
  context: CliCommandContext,
  candidate: NewFileCandidate,
  schemaHash: string,
): Promise<
  | { kind: "created"; remote: ContentDocumentPayload }
  | { kind: "schema_mismatch"; code: string; message: string }
  | { kind: "path_conflict"; code: string; message: string }
> {
  const response = await context.fetcher(
    `${context.serverUrl}/api/v1/content?fileFields=raw`,
    {
      method: "POST",
      headers: toRequestHeaders(context, schemaHash),
      body: JSON.stringify({
        type: candidate.resolvedType,
        path: candidate.resolvedPath,
        locale: candidate.resolvedLocale,
        format: candidate.format,
        frontmatter: candidate.frontmatter,
        body: candidate.body,
      }),
    },
  );

  const body = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    const remoteError = parseRemoteError(body, response.status);

    if (
      response.status === 409 &&
      remoteError.code === "SCHEMA_HASH_MISMATCH"
    ) {
      return {
        kind: "schema_mismatch",
        code: remoteError.code,
        message: remoteError.message,
      };
    }

    // Issue #10: handle path conflict with actionable message
    if (
      response.status === 409 &&
      remoteError.code === "CONTENT_PATH_CONFLICT"
    ) {
      return {
        kind: "path_conflict",
        code: remoteError.code,
        message: `Path "${candidate.resolvedPath}" already exists on server. Run 'cms pull' to sync, then resolve the duplicate.`,
      };
    }

    throw new RuntimeError({
      code: remoteError.code,
      message: remoteError.message,
      statusCode: remoteError.statusCode,
    });
  }

  return { kind: "created", remote: parseRemoteDocument(body) };
}

async function deleteDocument(
  context: CliCommandContext,
  candidate: DeletionCandidate,
  schemaHash: string,
): Promise<
  { kind: "deleted" } | { kind: "already_gone" } | { kind: "conflict" }
> {
  const headers = toRequestHeaders(context, schemaHash);
  headers.set("x-mdcms-draft-revision", String(candidate.draftRevision));
  if (candidate.publishedVersion !== null) {
    headers.set(
      "x-mdcms-published-version",
      String(candidate.publishedVersion),
    );
  }
  const response = await context.fetcher(
    `${context.serverUrl}/api/v1/content/${candidate.documentId}`,
    {
      method: "DELETE",
      headers,
    },
  );

  if (response.ok) {
    return { kind: "deleted" };
  }

  if (response.status === 404) {
    return { kind: "already_gone" };
  }

  if (response.status === 409) {
    return { kind: "conflict" };
  }

  const body = (await response.json().catch(() => undefined)) as unknown;
  const remoteError = parseRemoteError(body, response.status);

  throw new RuntimeError({
    code: remoteError.code,
    message: remoteError.message,
    statusCode: remoteError.statusCode,
  });
}

function printPushPlan(
  context: CliCommandContext,
  candidates: PushCandidate[],
  newCandidates: NewFileCandidate[],
  deletionCandidates: DeletionCandidate[],
  summary: {
    trackedCount: number;
    unchangedCount: number;
  },
): void {
  context.stdout.write(
    `Push plan for ${context.project}/${context.environment} (${candidates.length} changed / ${summary.trackedCount} tracked document(s)):\n`,
  );

  if (candidates.length > 0) {
    context.stdout.write("  Changed:\n");
    for (const candidate of candidates) {
      context.stdout.write(
        `    - ${candidate.documentId} -> ${candidate.manifestEntry.path} (${candidate.format})\n`,
      );
    }
  }

  if (newCandidates.length > 0) {
    context.stdout.write("  New (untracked):\n");
    for (const candidate of newCandidates) {
      context.stdout.write(
        `    - ${candidate.path} (${candidate.resolvedType})\n`,
      );
    }
  }

  if (deletionCandidates.length > 0) {
    context.stdout.write("  Deleted (missing locally):\n");
    for (const candidate of deletionCandidates) {
      context.stdout.write(
        `    - ${candidate.documentId} -> ${candidate.path}\n`,
      );
    }
  }

  context.stdout.write(`Unchanged (skipped): ${summary.unchangedCount}\n`);
}

function printValidationResults(
  context: CliCommandContext,
  results: DocumentValidationResult[],
): void {
  context.stdout.write(
    `Validating ${results.length} document(s) against local schema...\n`,
  );

  for (const result of results) {
    if (result.errors.length === 0 && result.warnings.length === 0) {
      context.stdout.write(`  v ${result.path}\n`);
      continue;
    }

    if (result.errors.length > 0) {
      context.stderr.write(`  x ${result.path}\n`);
    } else {
      context.stdout.write(`  ~ ${result.path}\n`);
    }

    for (const error of result.errors) {
      context.stderr.write(`    - ${error}\n`);
    }
    for (const warning of result.warnings) {
      context.stdout.write(`    - [warn] ${warning}\n`);
    }
  }
}

function printPushResults(
  context: CliCommandContext,
  results: PushResult[],
): void {
  context.stdout.write("Push results:\n");

  for (const result of results) {
    const idLabel =
      result.nextDocumentId && result.nextDocumentId !== result.documentId
        ? `${result.documentId} -> ${result.nextDocumentId}`
        : result.documentId;

    context.stdout.write(
      `  - [${result.status.toUpperCase()}] ${idLabel} (${result.path}) ${result.message}\n`,
    );
  }

  const staleCount = results.filter(
    (r) => r.reasonCode === "stale_draft_revision",
  ).length;

  if (staleCount > 0) {
    context.stdout.write(
      `\nSome documents were rejected as stale. Run 'cms pull' to get the latest drafts, then re-apply your local changes.\n`,
    );
  }

  const schemaMismatchCount = results.filter(
    (r) => r.reasonCode === "schema_hash_mismatch",
  ).length;

  if (schemaMismatchCount > 0) {
    context.stdout.write(
      `\nSome documents were rejected: schema changed during push (server schema hash now differs from preflight check). Another sync may have happened concurrently.\nRe-run: cms push\n`,
    );
  }

  const pathConflictCount = results.filter(
    (r) => r.reasonCode === "content_path_conflict",
  ).length;

  if (pathConflictCount > 0) {
    context.stdout.write(
      `\nSome documents were rejected due to path conflicts. Run 'cms pull' to sync with server, then resolve duplicates.\n`,
    );
  }
}

async function buildPushPlan(
  context: CliCommandContext,
  manifest: ScopedManifest,
): Promise<PushPlan> {
  const changedCandidates: PushCandidate[] = [];
  const deletionCandidates: DeletionCandidate[] = [];
  let trackedCount = 0;
  let unchangedCount = 0;
  const orderedDocumentIds = Object.keys(manifest).sort((left, right) =>
    left.localeCompare(right),
  );

  for (const documentId of orderedDocumentIds) {
    const manifestEntry = manifest[documentId];

    if (!manifestEntry) {
      continue;
    }
    trackedCount += 1;

    const format = parseFileFormat(manifestEntry.path);
    const absolutePath = join(context.cwd, manifestEntry.path);
    const raw = await readFile(absolutePath, "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    });

    if (raw === null) {
      deletionCandidates.push({
        documentId,
        path: manifestEntry.path,
        format: manifestEntry.format,
        draftRevision: manifestEntry.draftRevision,
        publishedVersion: manifestEntry.publishedVersion,
      });
      continue;
    }

    const currentHash = hashContent(raw);
    const manifestHash = manifestEntry.hash.trim();
    const isChanged = manifestHash.length === 0 || manifestHash !== currentHash;

    if (!isChanged) {
      unchangedCount += 1;
      continue;
    }

    const parsed = parseMarkdownDocument(raw);

    changedCandidates.push({
      documentId,
      manifestEntry,
      format,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      hash: currentHash,
    });
  }

  const contentDirectories = context.config.contentDirectories ?? [];
  const newCandidates: NewFileCandidate[] = [];

  if (contentDirectories.length > 0) {
    const untrackedFiles = await discoverUntrackedFiles({
      cwd: context.cwd,
      contentDirectories,
      manifest,
    });

    const types = context.config.types ?? [];

    for (const file of untrackedFiles) {
      const format = parseFileFormat(file.path);
      const absolutePath = join(context.cwd, file.path);
      const raw = await readFile(absolutePath, "utf8");
      const currentHash = hashContent(raw);
      const parsed = parseMarkdownDocument(raw);

      try {
        const resolved = resolveCreatePayload({
          path: file.path,
          format,
          types,
        });

        newCandidates.push({
          path: file.path,
          format,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          hash: currentHash,
          resolvedType: resolved.type,
          resolvedLocale: resolved.locale,
          resolvedPath: resolved.path,
        });
      } catch (error) {
        if (
          error instanceof RuntimeError &&
          error.code === "TYPE_MAPPING_MISSING"
        ) {
          const dir = file.path.split("/").slice(0, -1).join("/");
          context.stderr.write(
            `Warning: skipping "${file.path}" — no content type maps to directory "${dir}".\n` +
              `  Define a type with this directory in mdcms.config.ts, e.g.:\n` +
              `  defineType("myType", { directory: "${dir}", fields: { ... } })\n\n`,
          );
        } else {
          throw error;
        }
      }
    }
  }

  return {
    changedCandidates,
    newCandidates,
    deletionCandidates,
    trackedCount,
    unchangedCount,
  };
}

async function applyPush(
  context: CliCommandContext,
  manifestPath: string,
  manifest: ScopedManifest,
  candidates: PushCandidate[],
  newCandidates: NewFileCandidate[],
  deletionCandidates: DeletionCandidate[],
  schemaHash: string,
): Promise<{ results: PushResult[]; failures: number }> {
  const nextManifest: ScopedManifest = { ...manifest };
  const results: PushResult[] = [];
  let failures = 0;
  let manifestDirty = false;

  // Helper: flush manifest after each successful operation (issue #6)
  async function flushManifest(): Promise<void> {
    if (manifestDirty) {
      await writeScopedManifestAtomic(manifestPath, nextManifest);
      manifestDirty = false;
    }
  }

  // Phase 1: Update changed documents
  for (const candidate of candidates) {
    try {
      const updateResult = await updateExistingDocument(
        context,
        candidate,
        schemaHash,
      );

      if (updateResult.kind === "updated") {
        nextManifest[candidate.documentId] = {
          path: candidate.manifestEntry.path,
          format: candidate.format,
          draftRevision: updateResult.remote.draftRevision,
          publishedVersion: updateResult.remote.publishedVersion,
          hash: candidate.hash,
        };
        manifestDirty = true;
        await flushManifest();

        results.push({
          status: "updated",
          documentId: candidate.documentId,
          path: candidate.manifestEntry.path,
          message: `(draft=${updateResult.remote.draftRevision}, published=${updateResult.remote.publishedVersion ?? "-"})`,
        });

        continue;
      }

      if (updateResult.kind === "stale") {
        failures += 1;
        results.push({
          status: "failed",
          documentId: candidate.documentId,
          path: candidate.manifestEntry.path,
          message: `${updateResult.code}: ${updateResult.message}`,
          reasonCode: updateResult.code.toLowerCase(),
        });
        continue;
      }

      if (updateResult.kind === "schema_mismatch") {
        failures += 1;
        results.push({
          status: "failed",
          documentId: candidate.documentId,
          path: candidate.manifestEntry.path,
          message: `${updateResult.code}: ${updateResult.message}`,
          reasonCode: updateResult.code.toLowerCase(),
        });
        continue;
      }

      if (updateResult.kind === "path_conflict") {
        failures += 1;
        results.push({
          status: "failed",
          documentId: candidate.documentId,
          path: candidate.manifestEntry.path,
          message: `${updateResult.code}: ${updateResult.message}`,
          reasonCode: updateResult.code.toLowerCase(),
        });
        continue;
      }

      const createResult = await createDocumentFromLocalFile(
        context,
        candidate,
        schemaHash,
      );

      if (
        createResult.kind === "schema_mismatch" ||
        createResult.kind === "path_conflict"
      ) {
        failures += 1;
        results.push({
          status: "failed",
          documentId: candidate.documentId,
          path: candidate.manifestEntry.path,
          message: `${createResult.code}: ${createResult.message}`,
          reasonCode: createResult.code.toLowerCase(),
        });
        continue;
      }

      const created = createResult.remote;
      delete nextManifest[candidate.documentId];
      nextManifest[created.documentId] = {
        path: candidate.manifestEntry.path,
        format: candidate.format,
        draftRevision: created.draftRevision,
        publishedVersion: created.publishedVersion,
        hash: candidate.hash,
      };
      manifestDirty = true;
      await flushManifest();

      results.push({
        status: "created",
        documentId: candidate.documentId,
        nextDocumentId: created.documentId,
        path: candidate.manifestEntry.path,
        message: `(draft=${created.draftRevision}, published=${created.publishedVersion ?? "-"})`,
      });
    } catch (error) {
      failures += 1;
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : new RuntimeError({
              code: "INTERNAL_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Unexpected push failure.",
              statusCode: 500,
            });

      results.push({
        status: "failed",
        documentId: candidate.documentId,
        path: candidate.manifestEntry.path,
        message: `${runtimeError.code}: ${runtimeError.message}`,
      });
    }
  }

  // Phase 2: Create new documents
  for (const candidate of newCandidates) {
    try {
      const createResult = await createNewDocument(
        context,
        candidate,
        schemaHash,
      );

      if (
        createResult.kind === "schema_mismatch" ||
        createResult.kind === "path_conflict"
      ) {
        failures += 1;
        results.push({
          status: "failed",
          documentId: "(new)",
          path: candidate.path,
          message: `${createResult.code}: ${createResult.message}`,
          reasonCode: createResult.code.toLowerCase(),
        });
        continue;
      }

      const created = createResult.remote;
      nextManifest[created.documentId] = {
        path: candidate.path,
        format: candidate.format,
        draftRevision: created.draftRevision,
        publishedVersion: created.publishedVersion,
        hash: candidate.hash,
      };
      manifestDirty = true;
      await flushManifest();

      results.push({
        status: "created",
        documentId: created.documentId,
        path: candidate.path,
        message: `(draft=${created.draftRevision}, published=${created.publishedVersion ?? "-"})`,
      });
    } catch (error) {
      failures += 1;
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : new RuntimeError({
              code: "INTERNAL_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Unexpected create failure.",
              statusCode: 500,
            });

      results.push({
        status: "failed",
        documentId: "(new)",
        path: candidate.path,
        message: `${runtimeError.code}: ${runtimeError.message}`,
      });
    }
  }

  // Phase 3: Delete documents
  for (const candidate of deletionCandidates) {
    try {
      const deleteResult = await deleteDocument(context, candidate, schemaHash);

      if (deleteResult.kind === "conflict") {
        failures += 1;
        results.push({
          status: "failed",
          documentId: candidate.documentId,
          path: candidate.path,
          message:
            "Conflict: document was modified on the server since last pull. Run `mdcms pull` first.",
        });
        continue;
      }

      delete nextManifest[candidate.documentId];
      manifestDirty = true;
      await flushManifest();

      results.push({
        status: "deleted",
        documentId: candidate.documentId,
        path: candidate.path,
        message:
          deleteResult.kind === "already_gone"
            ? "(already deleted on server)"
            : "(soft-deleted)",
      });
    } catch (error) {
      failures += 1;
      const runtimeError =
        error instanceof RuntimeError
          ? error
          : new RuntimeError({
              code: "INTERNAL_ERROR",
              message:
                error instanceof Error
                  ? error.message
                  : "Unexpected delete failure.",
              statusCode: 500,
            });

      results.push({
        status: "failed",
        documentId: candidate.documentId,
        path: candidate.path,
        message: `${runtimeError.code}: ${runtimeError.message}`,
      });
    }
  }

  // Final flush in case any trailing writes
  await flushManifest();

  return {
    results,
    failures,
  };
}

type PreflightResult =
  | { outcome: "ok" }
  | { outcome: "abort"; exitCode: number };

function renderDriftSummary(input: {
  localHash: string;
  serverHash: string | null;
  diff: SchemaDiff;
}): string {
  const lines: string[] = [];
  lines.push("Schema drift detected:");
  lines.push(`  Local hash:  ${input.localHash.slice(0, 12)}...`);
  lines.push(
    `  Server hash: ${(input.serverHash ?? "null").toString().slice(0, 12)}...`,
  );
  lines.push("");
  if (
    input.diff.added.length ||
    input.diff.removed.length ||
    input.diff.modified.length
  ) {
    lines.push("Changes:");
    for (const name of input.diff.modified)
      lines.push(`  ~ ${name} (modified)`);
    for (const name of input.diff.added) lines.push(`  + ${name} (new)`);
    for (const name of input.diff.removed)
      lines.push(`  - ${name} (will be removed from server)`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

async function runSchemaPreflight(
  context: CliCommandContext,
  options: PushOptions,
): Promise<PreflightResult> {
  const headers: Record<string, string> = {
    "x-mdcms-project": context.project,
    "x-mdcms-environment": context.environment,
  };
  if (context.apiKey) {
    headers.authorization = `Bearer ${context.apiKey}`;
  }

  let response: Response;
  try {
    response = await context.fetcher(`${context.serverUrl}/api/v1/schema`, {
      method: "GET",
      headers,
    });
  } catch (error) {
    context.stderr.write(
      `SCHEMA_PREFLIGHT_FAILED: Network error fetching /api/v1/schema: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return { outcome: "abort", exitCode: 1 };
  }

  if (!response.ok) {
    context.stderr.write(
      `SCHEMA_PREFLIGHT_FAILED: GET /api/v1/schema returned ${response.status}.\n`,
    );
    return { outcome: "abort", exitCode: 1 };
  }

  const rawBody = (await response.json().catch(() => undefined)) as
    | { data?: unknown }
    | undefined;

  let serverList;
  try {
    serverList = validateSchemaRegistryListResponse(
      "GET /api/v1/schema",
      rawBody?.data,
    );
  } catch (error) {
    context.stderr.write(
      `SCHEMA_PREFLIGHT_FAILED: Invalid response from /api/v1/schema: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return { outcome: "abort", exitCode: 1 };
  }

  const localPayload = buildSchemaSyncPayload(
    context.config as ParsedMdcmsConfig,
    context.environment,
  );

  if (serverList.schemaHash === localPayload.schemaHash) {
    return { outcome: "ok" };
  }

  // Drift detected. Compute per-type diff using deterministic snapshot hash.
  const localHashesByType: Record<string, { schemaHash: string }> = {};
  for (const [typeName, snapshot] of Object.entries(
    localPayload.resolvedSchema,
  )) {
    localHashesByType[typeName] = {
      schemaHash: hashSchemaTypeSnapshot(snapshot),
    };
  }
  const serverHashesByType = serverList.types.map((entry) => ({
    type: entry.type,
    schemaHash: hashSchemaTypeSnapshot(entry.resolvedSchema),
  }));
  const diff = computeSchemaDiff(localHashesByType, serverHashesByType);

  const isInteractive = process.stdin.isTTY === true;

  const runSyncInline = async (): Promise<PreflightResult> => {
    if (options.dryRun) {
      context.stdout.write(
        `Dry run: skipping schema sync (local hash ${localPayload.schemaHash.slice(0, 12)}...).\n`,
      );
      return { outcome: "ok" };
    }

    const syncResult = await performSchemaSync({
      config: context.config as ParsedMdcmsConfig,
      serverUrl: context.serverUrl,
      project: context.project,
      environment: context.environment,
      apiKey: context.apiKey,
      cwd: context.cwd,
      fetcher: context.fetcher,
    });

    if (syncResult.outcome === "failure") {
      context.stderr.write(`${syncResult.errorCode}: ${syncResult.message}\n`);
      return { outcome: "abort", exitCode: 1 };
    }

    context.stdout.write(
      `Schema synced (hash: ${syncResult.schemaHash.slice(0, 12)}...)\n`,
    );
    return { outcome: "ok" };
  };

  if (isInteractive) {
    context.stdout.write(
      renderDriftSummary({
        localHash: localPayload.schemaHash,
        serverHash: serverList.schemaHash,
        diff,
      }),
    );

    if (options.dryRun) {
      context.stdout.write(
        "Dry run: schema drift detected but no sync will be attempted.\n",
      );
      return { outcome: "ok" };
    }

    const accepted = await context.confirm(
      "Sync schema to server before pushing content?",
    );

    if (!accepted) {
      context.stdout.write("Sync declined. No content writes performed.\n");
      return { outcome: "abort", exitCode: 1 };
    }

    return runSyncInline();
  }

  if (!options.syncSchema) {
    context.stderr.write(
      `SCHEMA_DRIFT: Local schema differs from server schema for ${context.project}/${context.environment}.\n` +
        `  Local hash:  ${localPayload.schemaHash.slice(0, 12)}...\n` +
        `  Server hash: ${(serverList.schemaHash ?? "null")
          .toString()
          .slice(0, 12)}...\n\n` +
        `To sync schema as part of this push, re-run with --sync-schema.\n` +
        `To sync explicitly without push, run: mdcms schema sync\n`,
    );
    return { outcome: "abort", exitCode: 1 };
  }

  return runSyncInline();
}

export async function runPushCommand(
  context: CliCommandContext,
): Promise<number> {
  if (context.args.includes("--help") || context.args.includes("-h")) {
    context.stdout.write(renderPushHelp());
    return 0;
  }

  const options = parsePushOptions(context.args);

  if (options.published) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Flag "--published" is reserved and not supported for push yet.',
      statusCode: 400,
    });
  }

  const initialSchemaState = await readSchemaState({
    cwd: context.cwd,
    project: context.project,
    environment: context.environment,
  });

  const preflight = await runSchemaPreflight(context, options);
  if (preflight.outcome === "abort") {
    return preflight.exitCode;
  }

  const manifestPath = resolveScopedManifestPath({
    cwd: context.cwd,
    project: context.project,
    environment: context.environment,
  });
  const manifest = await loadScopedManifest(manifestPath);
  const pushPlan = await buildPushPlan(context, manifest);

  const hasAnything =
    pushPlan.trackedCount > 0 || pushPlan.newCandidates.length > 0;

  if (!hasAnything) {
    const contentDirs = context.config.contentDirectories ?? [];
    const types = context.config.types ?? [];

    if (contentDirs.length === 0) {
      context.stderr.write(
        `No content directories configured in mdcms.config.ts.\n` +
          `Add directories to scan, e.g.:\n\n` +
          `  contentDirectories: ["content/posts"]\n\n`,
      );
    } else if (types.length === 0) {
      context.stderr.write(
        `No content types defined in mdcms.config.ts.\n` +
          `Define at least one type that maps to your content directory, e.g.:\n\n` +
          `  const post = defineType("post", {\n` +
          `    directory: "content/posts",\n` +
          `    fields: { title: z.string() },\n` +
          `  });\n\n` +
          `Then pass it to defineConfig: types: [post]\n\n`,
      );
    } else {
      context.stdout.write(
        `No documents found for ${context.project}/${context.environment}.\n`,
      );
    }
    return 0;
  }

  printPushPlan(
    context,
    pushPlan.changedCandidates,
    pushPlan.newCandidates,
    pushPlan.deletionCandidates,
    {
      trackedCount: pushPlan.trackedCount,
      unchangedCount: pushPlan.unchangedCount,
    },
  );

  if (options.dryRun) {
    context.stdout.write("Dry run complete. No changes were pushed.\n");
    return 0;
  }

  // Interactive selection for new files
  // Issue #8: in non-interactive mode without --force, skip new/deleted but still push changed
  let selectedNewCandidates: NewFileCandidate[] = [];
  if (pushPlan.newCandidates.length > 0) {
    if (options.force) {
      selectedNewCandidates = pushPlan.newCandidates;
    } else {
      const selectedPaths = await context.multiSelect(
        "Select new files to upload:",
        pushPlan.newCandidates.map((c) => ({
          label: `${c.path} (${c.resolvedType})`,
          value: c.path,
        })),
      );
      selectedNewCandidates = pushPlan.newCandidates.filter((c) =>
        selectedPaths.includes(c.path),
      );

      if (selectedPaths.length === 0 && pushPlan.newCandidates.length > 0) {
        context.stdout.write(
          `Hint: ${pushPlan.newCandidates.length} new file(s) skipped. Use --force to include them in non-interactive mode.\n`,
        );
      }
    }
  }

  // Interactive selection for deletions
  let selectedDeletionCandidates: DeletionCandidate[] = [];
  if (pushPlan.deletionCandidates.length > 0) {
    if (options.force) {
      selectedDeletionCandidates = pushPlan.deletionCandidates;
    } else {
      const selectedIds = await context.multiSelect(
        "Select files to delete from server:",
        pushPlan.deletionCandidates.map((c) => ({
          label: `${c.path} (${c.documentId})`,
          value: c.documentId,
        })),
      );
      selectedDeletionCandidates = pushPlan.deletionCandidates.filter((c) =>
        selectedIds.includes(c.documentId),
      );

      if (selectedIds.length === 0 && pushPlan.deletionCandidates.length > 0) {
        context.stdout.write(
          `Hint: ${pushPlan.deletionCandidates.length} deletion(s) skipped. Use --force to include them in non-interactive mode.\n`,
        );
      }
    }
  }

  if (options.validate) {
    const resolvedSchema = serializeResolvedEnvironmentSchema(
      context.config as ParsedMdcmsConfig,
      context.environment,
    );

    const changedValidationCandidates = pushPlan.changedCandidates.map(
      (candidate) => {
        const pathWithoutExtension = candidate.manifestEntry.path.replace(
          /\.(md|mdx)$/i,
          "",
        );
        const typeConfig = pickTypeConfigForPath(
          context.config.types ?? [],
          pathWithoutExtension,
        );
        return {
          path: candidate.manifestEntry.path,
          typeName: typeConfig.name,
          frontmatter: candidate.frontmatter,
        };
      },
    );

    const newValidationCandidates = selectedNewCandidates.map((candidate) => ({
      path: candidate.path,
      typeName: candidate.resolvedType,
      frontmatter: candidate.frontmatter,
    }));

    const validationResults = validateCandidates(
      [...changedValidationCandidates, ...newValidationCandidates],
      resolvedSchema,
    );
    printValidationResults(context, validationResults);

    const totalErrors = validationResults.reduce(
      (sum, r) => sum + r.errors.length,
      0,
    );
    const failedDocs = validationResults.filter(
      (r) => r.errors.length > 0,
    ).length;

    if (totalErrors > 0) {
      context.stderr.write(
        `\nValidation failed: ${totalErrors} error(s) in ${failedDocs} document(s).\n`,
      );
      return 1;
    }

    context.stdout.write("Validation passed.\n");
  }

  const hasWork =
    pushPlan.changedCandidates.length > 0 ||
    selectedNewCandidates.length > 0 ||
    selectedDeletionCandidates.length > 0;

  if (!hasWork) {
    context.stdout.write(
      `No changes to push for ${context.project}/${context.environment}.\n`,
    );
    return 0;
  }

  // Issue #8: in non-interactive mode, auto-confirm changed files (already tracked)
  // but still require --force for new/deleted. Only block if nothing to do.
  if (!options.force) {
    const parts: string[] = [];
    if (pushPlan.changedCandidates.length > 0) {
      parts.push(`${pushPlan.changedCandidates.length} changed`);
    }
    if (selectedNewCandidates.length > 0) {
      parts.push(`${selectedNewCandidates.length} new`);
    }
    if (selectedDeletionCandidates.length > 0) {
      parts.push(`${selectedDeletionCandidates.length} to delete`);
    }
    const confirmed = await context.confirm(
      `Push ${parts.join(", ")} document(s) to ${context.project}/${context.environment}?`,
    );

    if (!confirmed) {
      throw new RuntimeError({
        code: "PUSH_CANCELLED",
        message: "Push cancelled by user.",
        statusCode: 400,
      });
    }
  }

  // Preflight or the missing-state flow may sync schema and update the local
  // state file. Re-read immediately before writes so requests carry the fresh
  // hash, while dry-run/no-work paths never require local schema state.
  let schemaState =
    (await readSchemaState({
      cwd: context.cwd,
      project: context.project,
      environment: context.environment,
    })) ?? initialSchemaState;

  if (!schemaState) {
    const isInteractive = process.stdin.isTTY === true;

    if (isInteractive) {
      context.stdout.write(
        `No local schema state found for ${context.project}/${context.environment}.\n`,
      );
      const accepted = await context.confirm(
        "Sync schema from server before pushing content?",
      );
      if (!accepted) {
        context.stdout.write("Sync declined. No content writes performed.\n");
        return 1;
      }
    }

    if (isInteractive || options.syncSchema) {
      const syncResult = await performSchemaSync({
        config: context.config as ParsedMdcmsConfig,
        serverUrl: context.serverUrl,
        project: context.project,
        environment: context.environment,
        apiKey: context.apiKey,
        cwd: context.cwd,
        fetcher: context.fetcher,
      });

      if (syncResult.outcome === "failure") {
        context.stderr.write(
          `${syncResult.errorCode}: ${syncResult.message}\n`,
        );
        return 1;
      }

      context.stdout.write(
        `Schema synced (hash: ${syncResult.schemaHash.slice(0, 12)}...)\n`,
      );

      schemaState = await readSchemaState({
        cwd: context.cwd,
        project: context.project,
        environment: context.environment,
      });
    }
  }

  if (!schemaState) {
    throw new RuntimeError({
      code: "SCHEMA_STATE_MISSING",
      message:
        `No local schema state found for ${context.project}/${context.environment}.\n` +
        `To sync schema as part of this push, re-run with --sync-schema.\n` +
        `To sync explicitly without push, run: mdcms schema sync`,
      statusCode: 400,
    });
  }

  const { results, failures } = await applyPush(
    context,
    manifestPath,
    manifest,
    pushPlan.changedCandidates,
    selectedNewCandidates,
    selectedDeletionCandidates,
    schemaState.schemaHash,
  );
  printPushResults(context, results);

  return failures > 0 ? 1 : 0;
}

export function createPushCommand(): CliCommand {
  return {
    name: "push",
    description: "Upload local markdown files to CMS draft content",
    run: runPushCommand,
  };
}
