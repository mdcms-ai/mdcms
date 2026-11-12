import { access, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { ScopedManifest } from "./manifest.js";

export type UntrackedFile = {
  path: string;
};

async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return results;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkDirectory(fullPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/** The same path with the other Markdown extension (`.md` <-> `.mdx`). */
export function swapMarkdownExtension(path: string): string | undefined {
  if (/\.mdx$/i.test(path)) {
    return path.replace(/\.mdx$/i, ".md");
  }

  if (/\.md$/i.test(path)) {
    return path.replace(/\.md$/i, ".mdx");
  }

  return undefined;
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The current local path of a tracked document: its manifest path, or that
 * path with the other Markdown extension when the file was renamed between
 * `.md` and `.mdx`. Such a rename is the same document, not a delete plus a
 * new file. Returns `undefined` when neither file exists.
 */
export async function resolveTrackedFilePath(
  cwd: string,
  manifestPath: string,
): Promise<string | undefined> {
  if (await fileExists(join(cwd, manifestPath))) {
    return manifestPath;
  }

  const swapped = swapMarkdownExtension(manifestPath);

  if (swapped && (await fileExists(join(cwd, swapped)))) {
    return swapped;
  }

  return undefined;
}

export async function discoverUntrackedFiles(input: {
  cwd: string;
  contentDirectories: string[];
  manifest: ScopedManifest;
  /** Local paths already matched to tracked documents (renamed files). */
  claimedPaths?: Iterable<string>;
}): Promise<UntrackedFile[]> {
  const trackedPaths = new Set([
    ...Object.values(input.manifest).map((entry) => entry.path),
    ...(input.claimedPaths ?? []),
  ]);

  const untracked: UntrackedFile[] = [];

  for (const dir of input.contentDirectories) {
    const absoluteDir = join(input.cwd, dir);
    const files = await walkDirectory(absoluteDir);

    for (const absolutePath of files) {
      const relativePath = relative(input.cwd, absolutePath)
        .split(sep)
        .join("/");

      if (!trackedPaths.has(relativePath)) {
        untracked.push({ path: relativePath });
      }
    }
  }

  return untracked.sort((a, b) => a.path.localeCompare(b.path));
}
