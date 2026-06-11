import assert from "node:assert/strict";
import { test } from "bun:test";

import type {
  ActionCatalogItem,
  StudioBootstrapManifest,
  StudioBootstrapReadyResponse,
} from "@mdcms/shared";

import { createServerRequestHandler } from "./server.js";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

const actionCatalog: ActionCatalogItem[] = [
  {
    id: "content.publish",
    kind: "command",
    method: "POST",
    path: "/api/v1/content/:id/publish",
    permissions: ["content:publish"],
    requestSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
    },
    responseSchema: {
      type: "object",
      properties: {
        published: { type: "boolean" },
      },
    },
  },
  {
    id: "content.list",
    kind: "query",
    method: "GET",
    path: "/api/v1/content",
    permissions: ["content:read"],
    studio: {
      visible: true,
      label: "List content",
    },
    cli: {
      visible: true,
      inputMode: "json",
    },
  },
];

test("createServerRequestHandler returns process health for GET /healthz", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    startedAtMs: Date.parse("2026-02-20T00:00:00.000Z"),
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(new Request("http://localhost/healthz"));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "mdcms-server");
  assert.equal(body.version, "9.9.9");
  assert.equal(body.uptimeSeconds, 10);
});

test("unknown routes return a NOT_FOUND error envelope", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(new Request("http://localhost/missing"));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.status, "error");
  assert.equal(body.code, "NOT_FOUND");
});

test("health handler failures are normalized to INTERNAL_ERROR envelopes", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    healthCheck: () => {
      throw new Error("health check failed");
    },
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(new Request("http://localhost/healthz"));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 500);
  assert.equal(body.status, "error");
  assert.equal(body.code, "INTERNAL_ERROR");
});

test("GET /api/v1/actions returns deterministic action catalog payload", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    actions: actionCatalog,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(
    new Request("http://localhost/api/v1/actions"),
  );
  const body = (await response.json()) as ActionCatalogItem[];

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.map((action) => action.id),
    ["content.list", "content.publish"],
  );
  assert.deepEqual(body[1]?.requestSchema, actionCatalog[0]?.requestSchema);
  assert.deepEqual(body[1]?.responseSchema, actionCatalog[0]?.responseSchema);
});

test("GET /api/v1/actions/:id returns one action definition", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    actions: actionCatalog,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(
    new Request("http://localhost/api/v1/actions/content.publish"),
  );
  const body = (await response.json()) as ActionCatalogItem;

  assert.equal(response.status, 200);
  assert.equal(body.id, "content.publish");
  assert.equal(body.kind, "command");
});

test("action visibility policy filters list and hides detail responses", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    actions: actionCatalog,
    isActionVisible: ({ action }) => action.id !== "content.publish",
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });

  const listResponse = await handler(
    new Request("http://localhost/api/v1/actions"),
  );
  const listBody = (await listResponse.json()) as ActionCatalogItem[];

  assert.equal(listResponse.status, 200);
  assert.deepEqual(
    listBody.map((action) => action.id),
    ["content.list"],
  );

  const detailResponse = await handler(
    new Request("http://localhost/api/v1/actions/content.publish"),
  );
  const detailBody = (await detailResponse.json()) as Record<string, unknown>;

  assert.equal(detailResponse.status, 404);
  assert.equal(detailBody.code, "NOT_FOUND");
});

test("hidden actions remain server-authoritative when forced against a protected route", async () => {
  const secureAction: ActionCatalogItem = {
    id: "content.secure-publish",
    kind: "command",
    method: "POST",
    path: "/api/v1/protected/secure-publish",
    permissions: ["content:publish"],
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    actions: [...actionCatalog, secureAction],
    isActionVisible: ({ action }) => action.id !== secureAction.id,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    configureApp: (app) => {
      const serverApp = app as {
        post?: (
          path: string,
          handler: (context: { request: Request }) => Response,
        ) => unknown;
      };

      serverApp.post?.("/api/v1/protected/secure-publish", ({ request }) => {
        if (request.headers.get("x-test-actor") !== "authorized") {
          return new Response(
            JSON.stringify({
              status: "error",
              code: "FORBIDDEN",
              message: "Forbidden.",
            }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(
          JSON.stringify({
            data: { ok: true },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });
    },
  });

  const listResponse = await handler(
    new Request("http://localhost/api/v1/actions"),
  );
  const listBody = (await listResponse.json()) as ActionCatalogItem[];
  assert.equal(
    listBody.some((action) => action.id === secureAction.id),
    false,
  );

  const detailResponse = await handler(
    new Request(`http://localhost/api/v1/actions/${secureAction.id}`),
  );
  const detailBody = (await detailResponse.json()) as Record<string, unknown>;
  assert.equal(detailResponse.status, 404);
  assert.equal(detailBody.code, "NOT_FOUND");

  const forcedUnauthorizedResponse = await handler(
    new Request("http://localhost/api/v1/protected/secure-publish", {
      method: "POST",
    }),
  );
  const forcedUnauthorizedBody =
    (await forcedUnauthorizedResponse.json()) as Record<string, unknown>;
  assert.equal(forcedUnauthorizedResponse.status, 403);
  assert.equal(forcedUnauthorizedBody.code, "FORBIDDEN");

  const forcedAuthorizedResponse = await handler(
    new Request("http://localhost/api/v1/protected/secure-publish", {
      method: "POST",
      headers: {
        "x-test-actor": "authorized",
      },
    }),
  );
  const forcedAuthorizedBody = (await forcedAuthorizedResponse.json()) as {
    data: { ok: boolean };
  };
  assert.equal(forcedAuthorizedResponse.status, 200);
  assert.equal(forcedAuthorizedBody.data.ok, true);
});

test("unprefixed /actions path is rejected to enforce /api/v1 base path", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    actions: actionCatalog,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });
  const response = await handler(new Request("http://localhost/actions"));
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.code, "NOT_FOUND");
});

test("GET /api/v1/studio/bootstrap returns a ready payload for the active runtime build", async () => {
  const manifest: StudioBootstrapManifest = {
    apiVersion: "1",
    studioVersion: "1.2.3",
    mode: "module",
    entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
    integritySha256: "abc123",
    signature: "signature",
    keyId: "key-1",
    buildId: "build-123",
    minStudioPackageVersion: "0.0.1",
    minHostBridgeVersion: "1.0.0",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest,
      getAsset: async () => undefined,
    },
  });
  const response = await handler(
    new Request("http://localhost/api/v1/studio/bootstrap"),
  );
  const body = (await response.json()) as StudioBootstrapReadyResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.status, "ready");
  assert.equal(body.data.source, "active");
  assert.equal(body.data.manifest.mode, "module");
  assert.equal(body.data.manifest.buildId, "build-123");
});

test("GET /api/v1/studio/bootstrap returns a fallback ready payload when the active build is rejected", async () => {
  const activeManifest: StudioBootstrapManifest = {
    apiVersion: "1",
    studioVersion: "1.2.3",
    mode: "module",
    entryUrl: "/api/v1/studio/assets/build-active/runtime.mjs",
    integritySha256: "abc123",
    signature: "signature",
    keyId: "key-1",
    buildId: "build-active",
    minStudioPackageVersion: "0.0.1",
    minHostBridgeVersion: "1.0.0",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const fallbackManifest: StudioBootstrapManifest = {
    ...activeManifest,
    entryUrl: "/api/v1/studio/assets/build-safe/runtime.mjs",
    buildId: "build-safe",
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      active: {
        buildId: "build-active",
        entryFile: "runtime.mjs",
        manifest: activeManifest,
        getAsset: async () => undefined,
      },
      lastKnownGood: {
        buildId: "build-safe",
        entryFile: "runtime.mjs",
        manifest: fallbackManifest,
        getAsset: async () => undefined,
      },
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/bootstrap?rejectedBuildId=build-active&rejectionReason=integrity",
    ),
  );
  const body = (await response.json()) as StudioBootstrapReadyResponse;

  assert.equal(response.status, 200);
  assert.equal(body.data.status, "ready");
  assert.equal(body.data.source, "lastKnownGood");
  assert.equal(body.data.manifest.buildId, "build-safe");
  assert.deepEqual(body.data.recovery, {
    rejectedBuildId: "build-active",
    rejectionReason: "integrity",
  });
});

test("GET /api/v1/studio/bootstrap rejects malformed recovery query parameters", async () => {
  const manifest: StudioBootstrapManifest = {
    apiVersion: "1",
    studioVersion: "1.2.3",
    mode: "module",
    entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
    integritySha256: "abc123",
    signature: "signature",
    keyId: "key-1",
    buildId: "build-123",
    minStudioPackageVersion: "0.0.1",
    minHostBridgeVersion: "1.0.0",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest,
      getAsset: async () => undefined,
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/bootstrap?rejectedBuildId=build-123",
    ),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_QUERY_PARAM");
});

test("GET /api/v1/studio/bootstrap returns STUDIO_RUNTIME_DISABLED when the operator kill switch is enabled", async () => {
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_RUNTIME_DISABLED: "true",
    },
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/bootstrap"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 503);
  assert.equal(body.code, "STUDIO_RUNTIME_DISABLED");
});

test("GET /api/v1/studio/bootstrap returns STUDIO_RUNTIME_UNAVAILABLE when no safe runtime exists", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/bootstrap"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 503);
  assert.equal(body.code, "STUDIO_RUNTIME_UNAVAILABLE");
});

test("GET /api/v1/studio/bootstrap echoes CORS headers for allowlisted Studio origins", async () => {
  const manifest: StudioBootstrapManifest = {
    apiVersion: "1",
    studioVersion: "1.2.3",
    mode: "module",
    entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
    integritySha256: "abc123",
    signature: "signature",
    keyId: "key-1",
    buildId: "build-123",
    minStudioPackageVersion: "0.0.1",
    minHostBridgeVersion: "1.0.0",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest,
      getAsset: async () => undefined,
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/bootstrap", {
      headers: {
        origin: "http://localhost:4173",
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:4173",
  );
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.equal(response.headers.get("vary"), "Origin");
});

test("OPTIONS Studio preflight returns 204 for allowlisted origin", async () => {
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:4173",
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,x-mdcms-project,x-mdcms-environment,x-mdcms-csrf-token",
      },
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:4173",
  );
  assert.equal(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  assert.match(
    response.headers.get("access-control-allow-headers") ?? "",
    /X-MDCMS-CSRF-Token/i,
  );
});

test("GET /api/v1/actions rejects disallowed Studio origins", async () => {
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    actions: actionCatalog,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/actions", {
      headers: {
        origin: "http://localhost:9999",
      },
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN_ORIGIN");
});

test("GET /api/v1/auth/cli/login/authorize is not governed by Studio origins", async () => {
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_ALLOWED_ORIGINS: "http://localhost:4173",
    },
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    configureApp: (app) => {
      const serverApp = app as {
        get?: (path: string, handler: () => Response) => unknown;
      };

      serverApp.get?.(
        "/api/v1/auth/cli/login/authorize",
        () => new Response("cli authorize", { status: 200 }),
      );
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/auth/cli/login/authorize", {
      headers: {
        origin: "http://localhost:9999",
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "cli authorize");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("GET /api/v1/studio/assets/:buildId/* returns runtime asset when present", async () => {
  const encoder = new TextEncoder();
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest: {
        apiVersion: "1",
        studioVersion: "1.2.3",
        mode: "module",
        entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
        integritySha256: "abc123",
        signature: "signature",
        keyId: "key-1",
        buildId: "build-123",
        minStudioPackageVersion: "0.0.1",
        minHostBridgeVersion: "1.0.0",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      getAsset: async ({ buildId, assetPath }) =>
        buildId === "build-123" && assetPath === "runtime.mjs"
          ? {
              absolutePath: "/tmp/runtime.mjs",
              contentType: "text/javascript; charset=utf-8",
              body: encoder.encode("export const ok = true;\n"),
            }
          : undefined,
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/assets/build-123/runtime.mjs"),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(body, "export const ok = true;\n");
});

test("GET /api/v1/studio/assets/:buildId/* serves fallback assets when lastKnownGood is selected", async () => {
  const encoder = new TextEncoder();
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      active: {
        buildId: "build-active",
        entryFile: "runtime.mjs",
        manifest: {
          apiVersion: "1",
          studioVersion: "1.2.3",
          mode: "module",
          entryUrl: "/api/v1/studio/assets/build-active/runtime.mjs",
          integritySha256: "abc123",
          signature: "signature",
          keyId: "key-1",
          buildId: "build-active",
          minStudioPackageVersion: "0.0.1",
          minHostBridgeVersion: "1.0.0",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        getAsset: async () => undefined,
      },
      lastKnownGood: {
        buildId: "build-safe",
        entryFile: "runtime.mjs",
        manifest: {
          apiVersion: "1",
          studioVersion: "1.2.3",
          mode: "module",
          entryUrl: "/api/v1/studio/assets/build-safe/runtime.mjs",
          integritySha256: "safe123",
          signature: "signature",
          keyId: "key-1",
          buildId: "build-safe",
          minStudioPackageVersion: "0.0.1",
          minHostBridgeVersion: "1.0.0",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        getAsset: async ({ buildId, assetPath }) =>
          buildId === "build-safe" && assetPath === "runtime.mjs"
            ? {
                absolutePath: "/tmp/runtime.mjs",
                contentType: "text/javascript; charset=utf-8",
                body: encoder.encode("export const safe = true;\n"),
              }
            : undefined,
      },
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/assets/build-safe/runtime.mjs"),
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body, "export const safe = true;\n");
});

test("GET /api/v1/studio/assets/:buildId/* returns NOT_FOUND envelope for unknown build id", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest: {
        apiVersion: "1",
        studioVersion: "1.2.3",
        mode: "module",
        entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
        integritySha256: "abc123",
        signature: "signature",
        keyId: "key-1",
        buildId: "build-123",
        minStudioPackageVersion: "0.0.1",
        minHostBridgeVersion: "1.0.0",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      getAsset: async () => undefined,
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/assets/build-999/runtime.mjs"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.code, "NOT_FOUND");
});

test("GET /api/v1/studio/assets/:buildId/* returns NOT_FOUND envelope for missing asset", async () => {
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-123",
      entryFile: "runtime.mjs",
      manifest: {
        apiVersion: "1",
        studioVersion: "1.2.3",
        mode: "module",
        entryUrl: "/api/v1/studio/assets/build-123/runtime.mjs",
        integritySha256: "abc123",
        signature: "signature",
        keyId: "key-1",
        buildId: "build-123",
        minStudioPackageVersion: "0.0.1",
        minHostBridgeVersion: "1.0.0",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      getAsset: async () => undefined,
    },
  });

  const response = await handler(
    new Request("http://localhost/api/v1/studio/assets/build-123/missing.mjs"),
  );
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 404);
  assert.equal(body.code, "NOT_FOUND");
});

function makeCompressibleAssetHandler(env: NodeJS.ProcessEnv = baseEnv) {
  const encoder = new TextEncoder();
  const sampleBody = encoder.encode(
    "// mdcms studio runtime test\n".repeat(2000),
  );
  return {
    sampleBody,
    handler: createServerRequestHandler({
      env,
      now: () => new Date("2026-02-20T00:00:10.000Z"),
      studioRuntimePublication: {
        buildId: "build-perf",
        entryFile: "runtime.mjs",
        manifest: {
          apiVersion: "1",
          studioVersion: "1.2.3",
          mode: "module",
          entryUrl: "/api/v1/studio/assets/build-perf/runtime.mjs",
          integritySha256: "abc123",
          signature: "signature",
          keyId: "key-1",
          buildId: "build-perf",
          minStudioPackageVersion: "0.0.1",
          minHostBridgeVersion: "1.0.0",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        getAsset: async ({ buildId, assetPath }) =>
          buildId === "build-perf" && assetPath === "runtime.mjs"
            ? {
                absolutePath: "/tmp/runtime.mjs",
                contentType: "text/javascript; charset=utf-8",
                body: sampleBody,
              }
            : undefined,
      },
    }),
  };
}

test("Studio asset response negotiates brotli when MDCMS_HTTP_COMPRESS is on (default)", async () => {
  const { sampleBody, handler } = makeCompressibleAssetHandler();
  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-perf/runtime.mjs",
      { headers: { "accept-encoding": "br, gzip" } },
    ),
  );
  const buffer = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), "br");
  assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.ok(
    buffer.byteLength < sampleBody.byteLength,
    "compressed payload should be smaller than identity body",
  );
});

test("Studio asset response negotiates a supported encoding when client sends Accept-Encoding: *", async () => {
  const { handler } = makeCompressibleAssetHandler();
  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-perf/runtime.mjs",
      { headers: { "accept-encoding": "*" } },
    ),
  );

  assert.equal(response.status, 200);
  // Wildcard should pick the best supported encoding (brotli ahead of gzip).
  assert.equal(response.headers.get("content-encoding"), "br");
});

test("Studio asset response respects explicit q=0 over a wildcard fallback", async () => {
  const { handler } = makeCompressibleAssetHandler();
  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-perf/runtime.mjs",
      { headers: { "accept-encoding": "br;q=0, *" } },
    ),
  );

  assert.equal(response.status, 200);
  // br is explicitly disallowed; * still permits gzip.
  assert.equal(response.headers.get("content-encoding"), "gzip");
});

test("Studio asset response falls back to gzip when client rejects brotli via q=0", async () => {
  const { handler } = makeCompressibleAssetHandler();
  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-perf/runtime.mjs",
      { headers: { "accept-encoding": "br;q=0, gzip;q=1" } },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), "gzip");
});

test("Studio asset response stays identity when MDCMS_HTTP_COMPRESS=false", async () => {
  const { sampleBody, handler } = makeCompressibleAssetHandler({
    ...baseEnv,
    MDCMS_HTTP_COMPRESS: "false",
  } as NodeJS.ProcessEnv);
  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-perf/runtime.mjs",
      { headers: { "accept-encoding": "br, gzip" } },
    ),
  );
  const buffer = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(buffer.byteLength, sampleBody.byteLength);
});

test("Studio asset response is marked immutably cacheable", async () => {
  const encoder = new TextEncoder();
  const handler = createServerRequestHandler({
    env: baseEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-cache",
      entryFile: "runtime.mjs",
      manifest: {
        apiVersion: "1",
        studioVersion: "1.2.3",
        mode: "module",
        entryUrl: "/api/v1/studio/assets/build-cache/runtime.mjs",
        integritySha256: "abc123",
        signature: "signature",
        keyId: "key-1",
        buildId: "build-cache",
        minStudioPackageVersion: "0.0.1",
        minHostBridgeVersion: "1.0.0",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      getAsset: async ({ buildId, assetPath }) =>
        buildId === "build-cache" && assetPath === "runtime.mjs"
          ? {
              absolutePath: "/tmp/runtime.mjs",
              contentType: "text/javascript; charset=utf-8",
              body: encoder.encode("export const ok = true;\n"),
            }
          : undefined,
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-cache/runtime.mjs",
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  // The asset route always advertises Vary: Accept-Encoding so downstream
  // caches keep encodings separate, even on responses that happen to be
  // identity (e.g. body below the compression threshold like this 24-byte
  // body, or no client Accept-Encoding header).
  assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.equal(response.headers.get("content-encoding"), null);
});

test("CORS-origin Vary merges with the asset route's Accept-Encoding signal", async () => {
  // The studio asset route emits Vary: Accept-Encoding; the CORS layer adds
  // Vary: Origin via appendResponseHeaders. The merge must preserve both
  // tokens — this is what the appendResponseHeaders Vary-merge fix is for.
  const encoder = new TextEncoder();
  const handler = createServerRequestHandler({
    env: {
      ...baseEnv,
      MDCMS_STUDIO_ALLOWED_ORIGINS: "https://demo.example",
    } as NodeJS.ProcessEnv,
    now: () => new Date("2026-02-20T00:00:10.000Z"),
    studioRuntimePublication: {
      buildId: "build-cors",
      entryFile: "runtime.mjs",
      manifest: {
        apiVersion: "1",
        studioVersion: "1.2.3",
        mode: "module",
        entryUrl: "/api/v1/studio/assets/build-cors/runtime.mjs",
        integritySha256: "abc123",
        signature: "signature",
        keyId: "key-1",
        buildId: "build-cors",
        minStudioPackageVersion: "0.0.1",
        minHostBridgeVersion: "1.0.0",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      getAsset: async ({ buildId, assetPath }) =>
        buildId === "build-cors" && assetPath === "runtime.mjs"
          ? {
              absolutePath: "/tmp/runtime.mjs",
              contentType: "text/javascript; charset=utf-8",
              body: encoder.encode("export const ok = true;\n"),
            }
          : undefined,
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/studio/assets/build-cors/runtime.mjs",
      {
        headers: { origin: "https://demo.example" },
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://demo.example",
  );
  const vary = (response.headers.get("vary") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .sort();
  assert.deepEqual(vary, ["accept-encoding", "origin"]);
});
