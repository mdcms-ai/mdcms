import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { MdcmsConfig } from "@mdcms/studio";

import {
  createPreparedStudioConfigSignature,
  loadCachedPreparedStudioConfig,
  type PreparedStudioConfigCacheState,
} from "./prepared-studio-config-cache";

test("loadCachedPreparedStudioConfig reuses prepared config for the same signature", async () => {
  const cache: PreparedStudioConfigCacheState<{ value: number }> = {};
  let prepareCount = 0;
  const prepare = async () => ({ value: ++prepareCount });

  const first = await loadCachedPreparedStudioConfig({
    cache,
    signature: "same",
    prepare,
  });
  const second = await loadCachedPreparedStudioConfig({
    cache,
    signature: "same",
    prepare,
  });

  assert.equal(prepareCount, 1);
  assert.equal(first, second);
});

test("loadCachedPreparedStudioConfig shares a pending preparation for the same signature", async () => {
  const cache: PreparedStudioConfigCacheState<{ value: number }> = {};
  let prepareCount = 0;
  let resolvePrepared: (value: { value: number }) => void = () => {};
  const prepare = () => {
    prepareCount += 1;

    return new Promise<{ value: number }>((resolve) => {
      resolvePrepared = resolve;
    });
  };

  const first = loadCachedPreparedStudioConfig({
    cache,
    signature: "same",
    prepare,
  });
  const second = loadCachedPreparedStudioConfig({
    cache,
    signature: "same",
    prepare,
  });
  assert.equal(prepareCount, 1);

  resolvePrepared({ value: 1 });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, secondResult);
});

test("loadCachedPreparedStudioConfig refreshes prepared config when the signature changes", async () => {
  const cache: PreparedStudioConfigCacheState<{ value: number }> = {};
  let prepareCount = 0;
  const prepare = async () => ({ value: ++prepareCount });

  const first = await loadCachedPreparedStudioConfig({
    cache,
    signature: "before",
    prepare,
  });
  const second = await loadCachedPreparedStudioConfig({
    cache,
    signature: "after",
    prepare,
  });

  assert.equal(prepareCount, 2);
  assert.notEqual(first, second);
  assert.deepEqual(second, { value: 2 });
});

test("loadCachedPreparedStudioConfig clears failed preparations before retrying", async () => {
  const cache: PreparedStudioConfigCacheState<{ value: number }> = {};
  let prepareCount = 0;
  const prepare = async () => {
    prepareCount += 1;

    if (prepareCount === 1) {
      throw new Error("prepare failed");
    }

    return { value: prepareCount };
  };

  await assert.rejects(
    () =>
      loadCachedPreparedStudioConfig({
        cache,
        signature: "same",
        prepare,
      }),
    /prepare failed/,
  );
  const retry = await loadCachedPreparedStudioConfig({
    cache,
    signature: "same",
    prepare,
  });

  assert.equal(prepareCount, 2);
  assert.deepEqual(retry, { value: 2 });
});

test("createPreparedStudioConfigSignature changes when a configured component file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "mdcms-studio-config-cache-"));
  const componentPath = join(root, "Chart.tsx");
  const tsconfigPath = join(root, "tsconfig.json");
  writeFileSync(join(root, "mdcms.config.ts"), "export default {};\n");
  writeFileSync(tsconfigPath, "{}\n");
  writeFileSync(componentPath, "export function Chart() { return null; }\n");
  const config = {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
    components: [
      {
        name: "Chart",
        importPath: "./Chart",
        load: async () => null,
      },
    ],
  } satisfies MdcmsConfig;

  const before = createPreparedStudioConfigSignature({
    config,
    cwd: root,
    tsconfigPath,
  });
  writeFileSync(componentPath, "export function Chart() { return 'new'; }\n");
  const after = createPreparedStudioConfigSignature({
    config,
    cwd: root,
    tsconfigPath,
  });

  assert.notEqual(before, after);
});

test("createPreparedStudioConfigSignature changes when an explicit dependency file changes", () => {
  const root = mkdtempSync(join(tmpdir(), "mdcms-studio-config-cache-"));
  const dependencyPath = join(root, "registry.ts");
  writeFileSync(join(root, "mdcms.config.ts"), "export default {};\n");
  writeFileSync(dependencyPath, "export const value = 'before';\n");
  const config = {
    project: "marketing-site",
    environment: "staging",
    serverUrl: "http://localhost:4000",
  } satisfies MdcmsConfig;

  const before = createPreparedStudioConfigSignature({
    config,
    cwd: root,
    dependencyPaths: ["registry.ts"],
  });
  writeFileSync(dependencyPath, "export const value = 'after';\n");
  const after = createPreparedStudioConfigSignature({
    config,
    cwd: root,
    dependencyPaths: ["registry.ts"],
  });

  assert.notEqual(before, after);
});
