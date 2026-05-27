import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { buildStudioRuntimeArtifacts } from "./build-runtime.js";

const DEFAULT_POLL_INTERVAL_MS = 750;

function resolveStudioProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function collectFileEntries(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectFileEntries(absolutePath);
      }

      if (entry.isFile()) {
        return [absolutePath];
      }

      return [];
    }),
  );

  return files.flat();
}

async function createSourceSignature(sourceRoot: string): Promise<string> {
  const files = await collectFileEntries(sourceRoot);
  const rows = await Promise.all(
    files.map(async (filePath) => {
      const metadata = await stat(filePath);
      return `${relative(sourceRoot, filePath)}:${metadata.size}:${metadata.mtimeMs}`;
    }),
  );

  rows.sort();
  return rows.join("|");
}

async function rebuildRuntime(reason: string): Promise<void> {
  const build = await buildStudioRuntimeArtifacts();
  console.info(
    `[studio-runtime-watch] rebuilt (${reason}) ${build.entryFile} (${build.buildId})`,
  );
}

async function main(): Promise<void> {
  const projectRoot = resolveStudioProjectRoot();
  const sourceRoot = join(projectRoot, "src");
  const intervalMs = Number.parseInt(
    process.env.MDCMS_STUDIO_RUNTIME_WATCH_INTERVAL_MS ?? "",
    10,
  );
  const pollIntervalMs = Number.isFinite(intervalMs)
    ? Math.max(intervalMs, 100)
    : DEFAULT_POLL_INTERVAL_MS;
  let previousSignature = await createSourceSignature(sourceRoot);

  console.info(
    `[studio-runtime-watch] polling ${sourceRoot} every ${pollIntervalMs}ms`,
  );

  while (true) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- this is an intentional polling loop, not independent parallel work.
    await sleep(pollIntervalMs);

    let nextSignature: string;
    try {
      nextSignature = await createSourceSignature(sourceRoot);
    } catch (error) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(
        `[studio-runtime-watch] failed to scan source tree: ${message}`,
      );
      continue;
    }

    if (nextSignature === previousSignature) {
      continue;
    }

    previousSignature = nextSignature;

    try {
      await rebuildRuntime("source change");
    } catch (error) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`[studio-runtime-watch] build failed: ${message}`);
    }
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[studio-runtime-watch] fatal error: ${message}`);
  process.exitCode = 1;
});
