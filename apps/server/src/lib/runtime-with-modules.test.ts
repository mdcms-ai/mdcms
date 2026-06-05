import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

import {
  RuntimeError,
  assertStudioBootstrapManifest,
  createConsoleLogger,
  type MdcmsModulePackage,
  type StudioBootstrapReadyResponse,
} from "@mdcms/shared";

import { buildServerModuleLoadReport } from "./module-loader.js";
import {
  createRuntimeMediaObjectStore,
  createServerRequestHandlerWithModules,
  prepareServerRequestHandlerWithModules,
} from "./runtime-with-modules.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "1.0.0",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://test:test@localhost:5432/mdcms_test",
} as NodeJS.ProcessEnv;

const envWithoutAppVersion = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://test:test@localhost:5432/mdcms_test",
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "trace",
  sink: () => undefined,
});

async function withTempDir<T>(
  prefix: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createServerModule(
  id: string,
  options: {
    dependsOn?: string[];
    actions?: Array<{ id: string; path: string }>;
    onMount?: (deps: Record<string, unknown>) => void;
  } = {},
): MdcmsModulePackage<unknown, Record<string, unknown>> {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: "1",
      minCoreVersion: "0.0.1",
      dependsOn: options.dependsOn,
    },
    server: {
      mount: (_app, deps) => {
        options.onMount?.(deps);
      },
      actions: (options.actions ?? []).map((action) => ({
        id: action.id,
        kind: "query",
        method: "GET",
        path: action.path,
        permissions: ["content:read"],
      })),
    },
  };
}

test("createServerRequestHandlerWithModules surfaces module actions in /api/v1/actions", async () => {
  const { handler, moduleLoadReport, dbConnection } =
    createServerRequestHandlerWithModules({
      env,
      logger,
    });

  try {
    const response = await handler(
      new Request("http://localhost/api/v1/actions"),
    );
    const body = (await response.json()) as Array<{ id: string }>;

    assert.equal(response.status, 200);
    assert.equal(moduleLoadReport.loadedModuleIds.length > 0, true);
    assert.deepEqual(
      body.map((entry) => entry.id),
      ["core.system.ping", "domain.content.preview"],
    );
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules mounts server module routes", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });

  try {
    const coreResponse = await handler(
      new Request("http://localhost/api/v1/modules/core-system/ping"),
    );
    const coreBody = (await coreResponse.json()) as Record<string, unknown>;

    assert.equal(coreResponse.status, 200);
    assert.equal(coreBody.moduleId, "core.system");

    const contentResponse = await handler(
      new Request("http://localhost/api/v1/modules/domain-content/preview"),
    );
    const contentBody = (await contentResponse.json()) as Record<
      string,
      unknown
    >;

    assert.equal(contentResponse.status, 200);
    assert.equal(contentBody.moduleId, "domain.content");
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules mounts media routes before auth and DB work", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });

  try {
    const response = await handler(
      new Request("http://localhost/api/v1/media/settings"),
    );
    const body = (await response.json()) as { code: string };

    assert.equal(response.status, 400);
    assert.equal(body.code, "MISSING_TARGET_ROUTING");
  } finally {
    await dbConnection.close();
  }
});

test("createRuntimeMediaObjectStore uses endpoint-derived public URLs when public base URL is omitted", () => {
  assert.equal(createRuntimeMediaObjectStore({}), undefined);
  assert.equal(
    createRuntimeMediaObjectStore({
      S3_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY: "minioadmin",
      S3_SECRET_KEY: "minioadmin",
    }),
    undefined,
  );

  const store = createRuntimeMediaObjectStore({
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    S3_BUCKET: "mdcms-media",
  });

  assert.equal(
    store?.publicUrlForKey("projects/marketing-site/media/id/hero.png"),
    "http://localhost:9000/mdcms-media/projects/marketing-site/media/id/hero.png",
  );
});

test("createServerRequestHandlerWithModules loads bundled modules when APP_VERSION is unset", async () => {
  const { moduleLoadReport, dbConnection } =
    createServerRequestHandlerWithModules({
      env: envWithoutAppVersion,
      logger,
    });

  try {
    assert.deepEqual(moduleLoadReport.loadedModuleIds, [
      "core.ai",
      "core.system",
      "domain.content",
    ]);
  } finally {
    await dbConnection.close();
  }
});

test("createServerRequestHandlerWithModules fails before module mount on invalid bootstrap", () => {
  let mounted = false;

  const invalidModule = createServerModule("broken", {
    dependsOn: ["missing.core"],
    onMount: () => {
      mounted = true;
    },
  });

  assert.throws(
    () =>
      createServerRequestHandlerWithModules({
        env,
        logger,
        moduleLoadReport: buildServerModuleLoadReport([invalidModule], {
          coreVersion: "1.0.0",
          logger,
        }),
      }),
    (error) => {
      assert.equal(error instanceof RuntimeError, true);

      if (!(error instanceof RuntimeError)) {
        return false;
      }

      assert.equal(error.code, "INVALID_MODULE_BOOTSTRAP");
      const details = error.details as
        | { violations?: Array<{ code: string }> }
        | undefined;
      const violationCodes = (details?.violations ?? []).map(
        (entry) => entry.code,
      );
      assert.deepEqual(violationCodes, ["MISSING_DEPENDENCY"]);

      return true;
    },
  );

  assert.equal(mounted, false);
});

test("createServerRequestHandlerWithModules passes explicit composition-root deps to module mount", async () => {
  let capturedDeps: Record<string, unknown> | undefined;

  const dependencyProbe = createServerModule("dep.probe", {
    onMount: (deps) => {
      capturedDeps = deps;
    },
  });

  const moduleLoadReport = buildServerModuleLoadReport([dependencyProbe], {
    coreVersion: "1.0.0",
    logger,
  });

  const moduleDeps = {
    customService: "probe",
  };

  const { dbConnection, dal } = createServerRequestHandlerWithModules({
    env,
    logger,
    moduleLoadReport,
    moduleDeps,
  });

  try {
    assert.equal(capturedDeps !== undefined, true);

    if (!capturedDeps) {
      return;
    }

    assert.equal(capturedDeps.customService, "probe");
    assert.equal(capturedDeps.dal, dal);
  } finally {
    await dbConnection.close();
  }
});

test("prepareServerRequestHandlerWithModules publishes module actions and studio runtime endpoints together", async () => {
  await withTempDir("runtime-with-modules-", async (directory) => {
    const sourceFile = join(directory, "remote.ts");
    const outDir = join(directory, "studio-dist");
    await writeFile(
      sourceFile,
      "export const mount = (_container: unknown, _ctx: unknown) => () => {};\n",
      "utf8",
    );

    const { handler, dbConnection } =
      await prepareServerRequestHandlerWithModules({
        env,
        logger,
        studioRuntimeOptions: {
          sourceFile,
          outDir,
          studioVersion: "1.0.0",
        },
      });

    try {
      const actionsResponse = await handler(
        new Request("http://localhost/api/v1/actions"),
      );
      const actionsBody = (await actionsResponse.json()) as Array<{
        id: string;
      }>;

      assert.equal(actionsResponse.status, 200);
      assert.deepEqual(
        actionsBody.map((entry) => entry.id),
        ["core.system.ping", "domain.content.preview"],
      );

      const probeResponse = await handler(
        new Request("http://localhost/api/v1/modules/core-system/ping"),
      );

      assert.equal(probeResponse.status, 200);

      const bootstrapResponse = await handler(
        new Request("http://localhost/api/v1/studio/bootstrap"),
      );
      const bootstrapBody =
        (await bootstrapResponse.json()) as StudioBootstrapReadyResponse;

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.data.status, "ready");
      assert.equal(bootstrapBody.data.source, "active");
      assertStudioBootstrapManifest(
        bootstrapBody.data.manifest,
        "bootstrap.data.manifest",
      );
      assert.equal(bootstrapBody.data.manifest.mode, "module");

      const retryBootstrapResponse = await handler(
        new Request(
          "http://localhost/api/v1/studio/bootstrap?rejectedBuildId=" +
            bootstrapBody.data.manifest.buildId +
            "&rejectionReason=integrity",
        ),
      );
      const retryBootstrapBody =
        (await retryBootstrapResponse.json()) as Record<string, unknown>;

      assert.equal(retryBootstrapResponse.status, 503);
      assert.equal(retryBootstrapBody.code, "STUDIO_RUNTIME_UNAVAILABLE");

      const assetResponse = await handler(
        new Request(`http://localhost${bootstrapBody.data.manifest.entryUrl}`),
      );
      const assetBody = await assetResponse.text();

      assert.equal(assetResponse.status, 200);
      assert.equal(
        assetResponse.headers.get("content-type"),
        "text/javascript; charset=utf-8",
      );
      assert.equal(assetBody.length > 0, true);
    } finally {
      await dbConnection.close();
    }
  });
});
