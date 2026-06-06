import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  RuntimeError,
  type Logger,
  type MediaAsset,
  type MediaSettings,
} from "@mdcms/shared";

import type { AuthorizationRequirement, AuthorizedRequest } from "./auth.js";
import {
  mountMediaApiRoutes,
  type MountMediaApiRoutesOptions,
} from "./media-api.js";
import type {
  CreateMediaAssetInput,
  MediaActorContext,
  MediaAssetRecord,
  MediaAssetListQuery,
  MediaAssetListResult,
  MediaMetadataStore,
  MediaObjectStore,
} from "./media/types.js";
import { createServerRequestHandler } from "./server.js";
import type { WebhookEventDispatcher } from "./webhooks-api.js";

const baseEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
} as NodeJS.ProcessEnv;

const scopeHeaders = {
  "x-mdcms-project": "marketing-site",
  "x-mdcms-environment": "production",
};

const mediaId = "018f0c6d-98da-4f25-89fe-7c7ef5e8597d";
const uploadedAt = "2026-06-05T12:00:00.000Z";

const noopLogger: Logger = {
  child() {
    return noopLogger;
  },
  log() {},
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

function createAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: mediaId,
    project: "marketing-site",
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 11,
    url: "https://cdn.example.com/projects/marketing-site/media/hero.png",
    uploadedBy: "user-1",
    uploadedAt,
    ...overrides,
  };
}

function createAssetRecord(
  overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
  return {
    ...createAsset(),
    s3Key: `projects/marketing-site/media/${mediaId}/hero.png`,
    ...overrides,
  };
}

function createSettings(
  maxUploadSizeBytes: number | null = null,
): MediaSettings {
  return {
    media: {
      image: {
        maxUploadSizeBytes,
      },
    },
  };
}

function createListResult(
  assets: MediaAsset[] = [createAsset()],
  pagination: MediaAssetListResult["pagination"] = {
    total: assets.length,
    limit: 30,
    offset: 0,
    hasMore: false,
  },
): MediaAssetListResult {
  return {
    assets,
    pagination,
  };
}

function createAuthorizedRequest(): AuthorizedRequest {
  return {
    mode: "session",
    principal: {
      type: "session",
      session: {
        id: "session-1",
        userId: "user-1",
        email: "editor@example.com",
        issuedAt: "2026-06-05T11:00:00.000Z",
        expiresAt: "2026-06-05T13:00:00.000Z",
      },
    },
  };
}

function fail(label: string) {
  return async (): Promise<never> => {
    throw new Error(`stub ${label} not configured for this test`);
  };
}

function createStubStore(
  overrides: Partial<MediaMetadataStore> = {},
): MediaMetadataStore {
  return {
    getSettings: overrides.getSettings ?? (async () => createSettings()),
    updateSettings:
      overrides.updateSettings ??
      (fail("updateSettings") as MediaMetadataStore["updateSettings"]),
    createAsset:
      overrides.createAsset ??
      (fail("createAsset") as MediaMetadataStore["createAsset"]),
    listAssets:
      overrides.listAssets ??
      (fail("listAssets") as MediaMetadataStore["listAssets"]),
    getAsset:
      overrides.getAsset ??
      (fail("getAsset") as MediaMetadataStore["getAsset"]),
    getAssetRecord:
      overrides.getAssetRecord ??
      (fail("getAssetRecord") as MediaMetadataStore["getAssetRecord"]),
    deleteAssetMetadata:
      overrides.deleteAssetMetadata ??
      (fail(
        "deleteAssetMetadata",
      ) as MediaMetadataStore["deleteAssetMetadata"]),
  };
}

function createStubObjectStore(
  overrides: Partial<MediaObjectStore> = {},
): MediaObjectStore {
  return {
    putObject:
      overrides.putObject ??
      (fail("putObject") as MediaObjectStore["putObject"]),
    deleteObject:
      overrides.deleteObject ??
      (fail("deleteObject") as MediaObjectStore["deleteObject"]),
    publicUrlForKey:
      overrides.publicUrlForKey ?? ((key) => `https://cdn.example.com/${key}`),
  };
}

function createStubLifecycleEvents(
  overrides: Partial<WebhookEventDispatcher> = {},
): WebhookEventDispatcher {
  return {
    emitContentEvent: async () => undefined,
    emitMediaUploaded: async () => undefined,
    drainDeliveries: async () => undefined,
    ...overrides,
  };
}

type TestRouteOptions = Omit<
  Partial<MountMediaApiRoutesOptions>,
  "objectStore"
> & {
  objectStore?: MediaObjectStore | null;
};

function createTestRoutes(options: TestRouteOptions = {}) {
  return createServerRequestHandler({
    env: baseEnv,
    logger: noopLogger,
    configureApp: (app) => {
      mountMediaApiRoutes(app, {
        store: options.store ?? createStubStore(),
        objectStore:
          options.objectStore === null
            ? undefined
            : (options.objectStore ?? createStubObjectStore()),
        authorize: options.authorize ?? (async () => createAuthorizedRequest()),
        authorizeSettings:
          options.authorizeSettings ?? (async () => ({ actorId: "user-1" })),
        requireCsrf: options.requireCsrf ?? (async () => undefined),
        lifecycleEvents: options.lifecycleEvents ?? createStubLifecycleEvents(),
        createMediaId: options.createMediaId ?? (() => mediaId),
      });
    },
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("media upload stores the object, persists metadata, emits lifecycle event, and requires media upload authorization", async () => {
  let authorization: AuthorizationRequirement | undefined;
  let putObjectInput:
    | { key: string; bodyText: string; contentType: string }
    | undefined;
  let createAssetInput: CreateMediaAssetInput | undefined;
  let createAssetContext: MediaActorContext | undefined;
  let emitted:
    | Parameters<WebhookEventDispatcher["emitMediaUploaded"]>[0]
    | undefined;

  const handler = createTestRoutes({
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return createAuthorizedRequest();
    },
    objectStore: createStubObjectStore({
      async putObject(input) {
        putObjectInput = {
          key: input.key,
          bodyText: new TextDecoder().decode(input.body),
          contentType: input.contentType,
        };
      },
    }),
    store: createStubStore({
      async createAsset(scope, input, context) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        createAssetInput = input;
        createAssetContext = context;
        return createAsset({
          id: input.id,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          url: input.url,
          uploadedBy: context.actorId,
        });
      },
    }),
    lifecycleEvents: createStubLifecycleEvents({
      async emitMediaUploaded(input) {
        emitted = input;
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = (await response.json()) as { data: MediaAsset };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "media:upload",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(putObjectInput, {
    key: `projects/marketing-site/media/${mediaId}/hero.png`,
    bodyText: "image-bytes",
    contentType: "image/png",
  });
  assert.deepEqual(createAssetInput, {
    id: mediaId,
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 11,
    s3Key: `projects/marketing-site/media/${mediaId}/hero.png`,
    url: `https://cdn.example.com/projects/marketing-site/media/${mediaId}/hero.png`,
  });
  assert.deepEqual(createAssetContext, { actorId: "user-1" });
  assert.deepEqual(emitted, {
    scope: {
      project: "marketing-site",
      environment: "production",
    },
    media: {
      id: mediaId,
      filename: "hero.png",
      mimeType: "image/png",
      sizeBytes: 11,
      url: `https://cdn.example.com/projects/marketing-site/media/${mediaId}/hero.png`,
    },
    actor: {
      id: "user-1",
      email: "editor@example.com",
    },
  });
  assert.deepEqual(body.data, {
    id: mediaId,
    project: "marketing-site",
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 11,
    url: `https://cdn.example.com/projects/marketing-site/media/${mediaId}/hero.png`,
    uploadedBy: "user-1",
    uploadedAt,
  });
});

test("media upload succeeds when lifecycle dispatch rejects after metadata persistence", async () => {
  let putObjectCalls = 0;
  let createAssetCalls = 0;
  let lifecycleCalls = 0;
  const createdAsset = createAsset({
    url: `https://cdn.example.com/projects/marketing-site/media/${mediaId}/hero.png`,
  });
  const handler = createTestRoutes({
    objectStore: createStubObjectStore({
      async putObject() {
        putObjectCalls += 1;
      },
    }),
    store: createStubStore({
      async createAsset() {
        createAssetCalls += 1;
        return createdAsset;
      },
    }),
    lifecycleEvents: createStubLifecycleEvents({
      async emitMediaUploaded() {
        lifecycleCalls += 1;
        throw new Error("webhook dispatch failed");
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = (await response.json()) as { data: MediaAsset };

  assert.equal(response.status, 200);
  assert.deepEqual(body.data, createdAsset);
  assert.equal(putObjectCalls, 1);
  assert.equal(createAssetCalls, 1);
  assert.equal(lifecycleCalls, 1);
});

test("media upload falls back to upload for whitespace-only filenames", async () => {
  const expectedKey = `projects/marketing-site/media/${mediaId}/upload`;
  let putObjectKey: string | undefined;
  let createAssetInput: CreateMediaAssetInput | undefined;
  const handler = createTestRoutes({
    objectStore: createStubObjectStore({
      async putObject(input) {
        putObjectKey = input.key;
      },
    }),
    store: createStubStore({
      async createAsset(_scope, input, context) {
        createAssetInput = input;
        return createAsset({
          id: input.id,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          url: input.url,
          uploadedBy: context.actorId,
        });
      },
    }),
  });
  const formData = new FormData();
  formData.set("file", new File(["image-bytes"], "   ", { type: "image/png" }));

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = (await response.json()) as { data: MediaAsset };

  assert.equal(response.status, 200);
  assert.equal(putObjectKey, expectedKey);
  assert.equal(createAssetInput?.id, mediaId);
  assert.equal(createAssetInput?.filename, "upload");
  assert.equal(createAssetInput?.sizeBytes, 11);
  assert.equal(createAssetInput?.s3Key, expectedKey);
  assert.equal(createAssetInput?.url, `https://cdn.example.com/${expectedKey}`);
  assert.equal(body.data.filename, "upload");
  assert.equal(body.data.url, `https://cdn.example.com/${expectedKey}`);
});

test("media upload rejects oversized images before object storage writes", async () => {
  let putObjectCalls = 0;
  let createAssetCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async getSettings() {
        return createSettings(2);
      },
      async createAsset() {
        createAssetCalls += 1;
        return createAsset();
      },
    }),
    objectStore: createStubObjectStore({
      async putObject() {
        putObjectCalls += 1;
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 413);
  assert.equal(body.code, "MEDIA_UPLOAD_TOO_LARGE");
  assert.deepEqual(body.details, {
    limitBytes: 2,
    sizeBytes: 11,
  });
  assert.equal(putObjectCalls, 0);
  assert.equal(createAssetCalls, 0);
});

test("media upload accepts non-image files over the image upload cap", async () => {
  let putObjectCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async getSettings() {
        return createSettings(1);
      },
      async createAsset(_scope, input, context) {
        return createAsset({
          id: input.id,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          url: input.url,
          uploadedBy: context.actorId,
        });
      },
    }),
    objectStore: createStubObjectStore({
      async putObject() {
        putObjectCalls += 1;
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["plain text"], "notes.pdf", { type: "application/pdf" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = (await response.json()) as { data: MediaAsset };

  assert.equal(response.status, 200);
  assert.equal(putObjectCalls, 1);
  assert.equal(body.data.mimeType, "application/pdf");
  assert.equal(body.data.sizeBytes, 10);
});

test("media upload maps metadata persistence failures after object writes and attempts object cleanup", async () => {
  const calls: string[] = [];
  const key = `projects/marketing-site/media/${mediaId}/hero.png`;
  const handler = createTestRoutes({
    store: createStubStore({
      async createAsset() {
        calls.push("create-asset");
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Database insert failed.",
          statusCode: 500,
        });
      },
    }),
    objectStore: createStubObjectStore({
      async putObject(input) {
        calls.push("put-object");
        assert.equal(input.key, key);
      },
      async deleteObject(input) {
        calls.push("delete-object");
        assert.deepEqual(input, { key });
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 500);
  assert.equal(body.code, "MEDIA_METADATA_WRITE_FAILED");
  assert.deepEqual(body.details, { cleanupAttempted: true });
  assert.deepEqual(calls, ["put-object", "create-asset", "delete-object"]);
});

test("media upload still reports metadata persistence failure when best-effort cleanup fails", async () => {
  const calls: string[] = [];
  const key = `projects/marketing-site/media/${mediaId}/hero.png`;
  const handler = createTestRoutes({
    store: createStubStore({
      async createAsset() {
        calls.push("create-asset");
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Database insert failed.",
          statusCode: 500,
        });
      },
    }),
    objectStore: createStubObjectStore({
      async putObject() {
        calls.push("put-object");
      },
      async deleteObject(input) {
        calls.push("delete-object");
        assert.deepEqual(input, { key });
        throw new RuntimeError({
          code: "MEDIA_OBJECT_DELETE_FAILED",
          message: "Cleanup failed.",
          statusCode: 502,
        });
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 500);
  assert.equal(body.code, "MEDIA_METADATA_WRITE_FAILED");
  assert.deepEqual(body.details, { cleanupAttempted: true });
  assert.deepEqual(calls, ["put-object", "create-asset", "delete-object"]);
});

test("media upload rejects extra application form fields", async () => {
  let putObjectCalls = 0;
  let createAssetCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async createAsset() {
        createAssetCalls += 1;
        return createAsset();
      },
    }),
    objectStore: createStubObjectStore({
      async putObject() {
        putObjectCalls += 1;
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );
  formData.set("project", "body-project");
  formData.set("environment", "body-environment");
  formData.set("s3Key", "client/key");
  formData.set("url", "https://example.com/client.png");

  const response = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 400);
  assert.equal(body.code, "INVALID_INPUT");
  assert.equal(putObjectCalls, 0);
  assert.equal(createAssetCalls, 0);
});

test("media list returns asset metadata, requires media read authorization, and does not require object storage", async () => {
  let authorization: AuthorizationRequirement | undefined;
  let listScope: { project: string; environment: string } | undefined;
  let listQuery: MediaAssetListQuery | undefined;
  const listedAsset = createAsset({ filename: "library-hero.png" });
  const handler = createTestRoutes({
    objectStore: null,
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return createAuthorizedRequest();
    },
    store: createStubStore({
      async listAssets(scope, query) {
        listScope = scope;
        listQuery = query;
        return createListResult([listedAsset]);
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/media", {
      headers: scopeHeaders,
    }),
  );
  const body = (await response.json()) as {
    data: MediaAsset[];
    pagination: MediaAssetListResult["pagination"];
  };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "media:read",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(listScope, {
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(listQuery, {
    sort: "uploadedAt",
    order: "desc",
    limit: 30,
    offset: 0,
  });
  assert.deepEqual(body, {
    data: [listedAsset],
    pagination: {
      total: 1,
      limit: 30,
      offset: 0,
      hasMore: false,
    },
  });
});

test("media list trims filename search and forwards parsed filters, sort, order, and pagination", async () => {
  let listQuery: MediaAssetListQuery | undefined;
  const handler = createTestRoutes({
    store: createStubStore({
      async listAssets(_scope, query) {
        listQuery = query;
        return createListResult([], {
          total: 0,
          limit: query.limit,
          offset: query.offset,
          hasMore: false,
        });
      },
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/v1/media?q=%20Hero%20&category=document&uploadedBy=user_2&uploadedFrom=2026-06-01&uploadedTo=2026-06-05&sort=filename&order=asc&limit=25&offset=50",
      {
        headers: scopeHeaders,
      },
    ),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(listQuery, {
    q: "Hero",
    category: "document",
    uploadedBy: "user_2",
    uploadedFrom: new Date("2026-06-01T00:00:00.000Z"),
    uploadedTo: new Date("2026-06-05T00:00:00.000Z"),
    sort: "filename",
    order: "asc",
    limit: 25,
    offset: 50,
  });
});

test("media list rejects malformed query parameters with INVALID_QUERY_PARAM", async () => {
  const cases = [
    "category=font",
    "category=",
    "uploadedFrom=not-a-date",
    "uploadedFrom=",
    "uploadedTo=2026-02-30",
    "uploadedFrom=2026-06-10&uploadedTo=2026-06-05",
    "sort=createdAt",
    "sort=",
    "order=newest",
    "limit=0",
    "limit=101",
    "limit=10.5",
    "limit=",
    "offset=-1",
    "offset=1.5",
    "uploadedBy=",
    "foo=bar",
    "limit=30&limit=0",
    "category=image&category=font",
  ];

  for (const query of cases) {
    let listCalls = 0;
    const handler = createTestRoutes({
      store: createStubStore({
        async listAssets() {
          listCalls += 1;
          return createListResult();
        },
      }),
    });

    const response = await handler(
      new Request(`http://localhost/api/v1/media?${query}`, {
        headers: scopeHeaders,
      }),
    );
    const body = await readJson(response);

    assert.equal(response.status, 400, query);
    assert.equal(body.code, "INVALID_QUERY_PARAM", query);
    assert.equal(listCalls, 0, query);
  }
});

test("media list requires explicit target routing", async () => {
  let listCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async listAssets() {
        listCalls += 1;
        return createListResult();
      },
    }),
  });

  const response = await handler(new Request("http://localhost/api/v1/media"));
  const body = await readJson(response);

  assert.equal(response.status, 400);
  assert.equal(body.code, "MISSING_TARGET_ROUTING");
  assert.equal(listCalls, 0);
});

test("media get returns asset metadata and requires media read authorization", async () => {
  let authorization: AuthorizationRequirement | undefined;
  const handler = createTestRoutes({
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return createAuthorizedRequest();
    },
    store: createStubStore({
      async getAsset(scope, id) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        assert.equal(id, mediaId);
        return createAsset();
      },
    }),
  });

  const response = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`, {
      headers: scopeHeaders,
    }),
  );
  const body = (await response.json()) as { data: MediaAsset };

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "media:read",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(body.data, createAsset());
});

test("media delete deletes the object before metadata and requires media delete authorization", async () => {
  let authorization: AuthorizationRequirement | undefined;
  const calls: string[] = [];
  const handler = createTestRoutes({
    authorize: async (_request, requirement) => {
      authorization = requirement;
      return createAuthorizedRequest();
    },
    store: createStubStore({
      async getAssetRecord(scope, id) {
        calls.push("get-record");
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        assert.equal(id, mediaId);
        return createAssetRecord();
      },
      async deleteAssetMetadata(scope, id) {
        calls.push("delete-metadata");
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        assert.equal(id, mediaId);
        return { deleted: true, id };
      },
    }),
    objectStore: createStubObjectStore({
      async deleteObject(input) {
        calls.push("delete-object");
        assert.deepEqual(input, {
          key: `projects/marketing-site/media/${mediaId}/hero.png`,
        });
      },
    }),
  });

  const response = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.deepEqual(authorization, {
    requiredScope: "media:delete",
    project: "marketing-site",
    environment: "production",
  });
  assert.deepEqual(calls, ["get-record", "delete-object", "delete-metadata"]);
  assert.deepEqual(body, {
    data: {
      deleted: true,
      id: mediaId,
    },
  });
});

test("media delete leaves metadata in place when object deletion fails", async () => {
  let deleteMetadataCalls = 0;
  const handler = createTestRoutes({
    store: createStubStore({
      async getAssetRecord() {
        return createAssetRecord();
      },
      async deleteAssetMetadata() {
        deleteMetadataCalls += 1;
        return { deleted: true, id: mediaId };
      },
    }),
    objectStore: createStubObjectStore({
      async deleteObject() {
        throw new RuntimeError({
          code: "MEDIA_OBJECT_DELETE_FAILED",
          message: "Failed to delete media object.",
          statusCode: 502,
        });
      },
    }),
  });

  const response = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 502);
  assert.equal(body.code, "MEDIA_OBJECT_DELETE_FAILED");
  assert.equal(deleteMetadataCalls, 0);
});

test("media delete maps metadata deletion failures after object deletion", async () => {
  const calls: string[] = [];
  const handler = createTestRoutes({
    store: createStubStore({
      async getAssetRecord() {
        calls.push("get-record");
        return createAssetRecord();
      },
      async deleteAssetMetadata() {
        calls.push("delete-metadata");
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Database delete failed.",
          statusCode: 500,
        });
      },
    }),
    objectStore: createStubObjectStore({
      async deleteObject(input) {
        calls.push("delete-object");
        assert.deepEqual(input, {
          key: `projects/marketing-site/media/${mediaId}/hero.png`,
        });
      },
    }),
  });

  const response = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const body = await readJson(response);

  assert.equal(response.status, 500);
  assert.equal(body.code, "MEDIA_METADATA_DELETE_FAILED");
  assert.deepEqual(calls, ["get-record", "delete-object", "delete-metadata"]);
});

test("media settings routes read and update settings with scoped authorization and CSRF", async () => {
  const authorizationCalls: AuthorizationRequirement[] = [];
  let settingsAuthorizationCalls = 0;
  let csrfCalls = 0;
  let updateContext: MediaActorContext | undefined;
  let updateInput: MediaSettings | undefined;
  const handler = createTestRoutes({
    authorize: async (_request, requirement) => {
      authorizationCalls.push(requirement);
      return createAuthorizedRequest();
    },
    authorizeSettings: async () => {
      settingsAuthorizationCalls += 1;
      return { actorId: "admin-1" };
    },
    requireCsrf: async () => {
      csrfCalls += 1;
    },
    store: createStubStore({
      async getSettings(scope) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        return createSettings(4096);
      },
      async updateSettings(scope, input, context) {
        assert.deepEqual(scope, {
          project: "marketing-site",
          environment: "production",
        });
        updateInput = input;
        updateContext = context;
        return input;
      },
    }),
  });

  const getResponse = await handler(
    new Request("http://localhost/api/v1/media/settings", {
      headers: scopeHeaders,
    }),
  );
  const getBody = (await getResponse.json()) as { data: MediaSettings };
  const putResponse = await handler(
    new Request("http://localhost/api/v1/media/settings", {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(createSettings(8192)),
    }),
  );
  const putBody = (await putResponse.json()) as { data: MediaSettings };

  assert.equal(getResponse.status, 200);
  assert.equal(putResponse.status, 200);
  assert.deepEqual(getBody.data, createSettings(4096));
  assert.deepEqual(putBody.data, createSettings(8192));
  assert.deepEqual(updateInput, createSettings(8192));
  assert.deepEqual(updateContext, { actorId: "admin-1" });
  assert.equal(csrfCalls, 1);
  assert.equal(settingsAuthorizationCalls, 2);
  assert.deepEqual(authorizationCalls, []);
});

test("media settings routes reject non-admin sessions before reading or updating settings", async () => {
  let getSettingsCalls = 0;
  let updateSettingsCalls = 0;
  const handler = createTestRoutes({
    authorize: async () => {
      throw new Error("media operation authorizer must not guard settings");
    },
    authorizeSettings: async () => {
      throw new RuntimeError({
        code: "FORBIDDEN",
        message: "Admin privileges are required.",
        statusCode: 403,
      });
    },
    store: createStubStore({
      async getSettings() {
        getSettingsCalls += 1;
        return createSettings();
      },
      async updateSettings() {
        updateSettingsCalls += 1;
        return createSettings();
      },
    }),
  });

  const getResponse = await handler(
    new Request("http://localhost/api/v1/media/settings", {
      headers: scopeHeaders,
    }),
  );
  const getBody = await readJson(getResponse);
  const putResponse = await handler(
    new Request("http://localhost/api/v1/media/settings", {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(createSettings()),
    }),
  );
  const putBody = await readJson(putResponse);

  assert.equal(getResponse.status, 403);
  assert.equal(getBody.code, "FORBIDDEN");
  assert.equal(putResponse.status, 403);
  assert.equal(putBody.code, "FORBIDDEN");
  assert.equal(getSettingsCalls, 0);
  assert.equal(updateSettingsCalls, 0);
});

test("media settings update treats omitted image upload limit as unlimited", async () => {
  let updateInput: MediaSettings | undefined;
  const handler = createTestRoutes({
    authorizeSettings: async () => ({ actorId: "admin-1" }),
    store: createStubStore({
      async updateSettings(_scope, input) {
        updateInput = input;
        return input;
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/v1/media/settings", {
      method: "PUT",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({ media: { image: {} } }),
    }),
  );
  const body = (await response.json()) as { data: MediaSettings };

  assert.equal(response.status, 200);
  assert.deepEqual(updateInput, createSettings(null));
  assert.deepEqual(body.data, createSettings(null));
});

test("media upload and delete return storage unavailable when no object store is configured", async () => {
  const handler = createTestRoutes({
    objectStore: null,
    store: createStubStore({
      async getAssetRecord() {
        return createAssetRecord();
      },
    }),
  });
  const formData = new FormData();
  formData.set(
    "file",
    new File(["image-bytes"], "hero.png", { type: "image/png" }),
  );

  const uploadResponse = await handler(
    new Request("http://localhost/api/v1/media/upload", {
      method: "POST",
      headers: scopeHeaders,
      body: formData,
    }),
  );
  const uploadBody = await readJson(uploadResponse);
  const deleteResponse = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`, {
      method: "DELETE",
      headers: scopeHeaders,
    }),
  );
  const deleteBody = await readJson(deleteResponse);

  assert.equal(uploadResponse.status, 503);
  assert.equal(uploadBody.code, "MEDIA_STORAGE_UNAVAILABLE");
  assert.equal(deleteResponse.status, 503);
  assert.equal(deleteBody.code, "MEDIA_STORAGE_UNAVAILABLE");
});

test("media routes require explicit target routing", async () => {
  const handler = createTestRoutes({
    store: createStubStore({
      async getAsset() {
        return createAsset();
      },
    }),
  });

  const response = await handler(
    new Request(`http://localhost/api/v1/media/${mediaId}`),
  );
  const body = await readJson(response);

  assert.equal(response.status, 400);
  assert.equal(body.code, "MISSING_TARGET_ROUTING");
});
