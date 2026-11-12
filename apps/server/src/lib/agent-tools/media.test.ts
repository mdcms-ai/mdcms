import assert from "node:assert/strict";
import { test } from "bun:test";
import { createAgentToolRegistry } from "./registry.js";
import { authorizedTestRequest, baseEnv } from "../content-api-test-support.js";
import { createInternalDispatcher } from "./dispatcher.js";
import { createInternalServerRequestHandler } from "../server.js";
import { mountMediaApiRoutes } from "../media-api.js";
import type { MediaAsset } from "@mdcms/shared";

test("media tools use multipart routes and reject malformed and oversized encodings before writes", async () => {
  let asset: MediaAsset | undefined;
  let writes = 0;
  const id = "018f0c6d-98da-4f25-89fe-7c7ef5e8597d";
  const handler = createInternalServerRequestHandler({
    env: baseEnv,
    configureApp: (app) =>
      mountMediaApiRoutes(app, {
        authorize: async () => authorizedTestRequest,
        authorizeSettings: async () => ({ actorId: "owner" }),
        requireCsrf: async () => {},
        createMediaId: () => id,
        store: {
          getSettings: async () => ({
            media: { image: { maxUploadSizeBytes: 10 } },
          }),
          updateSettings: async (_scope, settings) => settings,
          createAsset: async (scope, input, context) =>
            (asset = {
              ...input,
              project: scope.project,
              uploadedBy: context.actorId,
              uploadedAt: new Date().toISOString(),
            }),
          listAssets: async () => ({
            assets: asset ? [asset] : [],
            pagination: {
              total: asset ? 1 : 0,
              limit: 30,
              offset: 0,
              hasMore: false,
            },
          }),
          getAsset: async () => asset,
          getAssetRecord: async () => asset && { ...asset, s3Key: "key" },
          deleteAssetMetadata: async () => {
            asset = undefined;
            return { deleted: true, id };
          },
        },
        objectStore: {
          putObject: async () => {
            writes++;
          },
          deleteObject: async () => {},
          publicUrlForKey: () => "https://cdn.example.test/image.png",
        },
      }),
  });
  const context = {
    authorization: authorizedTestRequest,
    target: { project: "p", environment: "e" },
    dispatch: createInternalDispatcher(handler, "secret", {
      request: new Request("http://localhost"),
      project: "p",
      environment: "e",
      channel: "mcp",
    }),
  };
  const registry = createAgentToolRegistry();
  for (const base64 of ["???", "Zg", "Zh==", "Zg==\n"]) {
    await assert.rejects(
      registry.execute(
        "upload_media",
        { filename: "image.png", mimeType: "image/png", base64 },
        context,
      ),
      (e: any) => e.code === "INVALID_INPUT",
    );
  }
  await assert.rejects(
    registry.execute(
      "upload_media",
      {
        filename: "image.png",
        mimeType: "image/png",
        base64: "A".repeat(4 * Math.ceil((10 * 1024 * 1024) / 3) + 4),
      },
      context,
    ),
    (e: any) => e.code === "MEDIA_UPLOAD_TOO_LARGE",
  );
  assert.equal(writes, 0);
  const uploaded = (await registry.execute(
    "upload_media",
    {
      filename: "image.png",
      mimeType: "image/png",
      base64: Buffer.from("hello").toString("base64"),
    },
    context,
  )) as any;
  assert.equal(uploaded.data.sizeBytes, 5);
  assert.equal(writes, 1);
  assert.equal(
    (
      (await registry.execute(
        "list_media",
        { uploadedBy: uploaded.data.uploadedBy },
        context,
      )) as any
    ).data.length,
    1,
  );
  assert.equal(
    ((await registry.execute("get_media", { id }, context)) as any).data.id,
    id,
  );
  await assert.rejects(
    registry.execute(
      "upload_media",
      {
        filename: "image.png",
        mimeType: "image/png",
        base64: Buffer.from("too long for configured limit").toString("base64"),
      },
      context,
    ),
    (e: any) => e.code === "MEDIA_UPLOAD_TOO_LARGE",
  );
  assert.equal(writes, 1);
  await registry.execute("delete_media", { id }, context);
  assert.equal(asset, undefined);
  await assert.rejects(
    registry.execute("list_media", { mimeType: "image/png" }, context),
  );
});

test("configured tool upload cap rejects before multipart dispatch", async () => {
  let dispatched = false;
  const registry = createAgentToolRegistry(undefined, {
    getMediaUploadLimit: async () => 2,
  });
  await assert.rejects(
    registry.execute(
      "upload_media",
      { filename: "a.txt", mimeType: "text/plain", base64: "YWJjZA==" },
      {
        authorization: authorizedTestRequest,
        target: { project: "p", environment: "e" },
        dispatch: async () => {
          dispatched = true;
          return Response.json({});
        },
      },
    ),
    (error: any) => error.code === "MEDIA_UPLOAD_TOO_LARGE",
  );
  assert.equal(dispatched, false);
});
