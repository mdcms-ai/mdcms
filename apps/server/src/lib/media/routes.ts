import { randomUUID } from "node:crypto";

import {
  RuntimeError,
  parseMediaSettingsInput,
  resolveRequestTargetRouting,
} from "@mdcms/shared";

import {
  actorFromAuthorizedRequest,
  type AuthorizationRequirement,
  type AuthorizedRequest,
} from "../auth.js";
import { executeWithRuntimeErrorsHandled } from "../http-utils.js";
import type { WebhookEventDispatcher } from "../webhooks-api.js";

import { parseMediaId } from "./ids.js";
import { createMediaObjectKey } from "./object-store.js";
import type {
  MediaActorContext,
  MediaMetadataStore,
  MediaObjectStore,
  MediaScope,
} from "./types.js";

export type MediaRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => MediaRouteApp;
  post?: (path: string, handler: (ctx: any) => unknown) => MediaRouteApp;
  put?: (path: string, handler: (ctx: any) => unknown) => MediaRouteApp;
  delete?: (path: string, handler: (ctx: any) => unknown) => MediaRouteApp;
};

export type MediaRequestAuthorizer = (
  request: Request,
  requirement: AuthorizationRequirement,
) => Promise<AuthorizedRequest>;

export type MediaSettingsAuthorizer = (
  request: Request,
) => Promise<MediaActorContext>;

export type MountMediaApiRoutesOptions = {
  store: MediaMetadataStore;
  objectStore?: MediaObjectStore;
  authorize: MediaRequestAuthorizer;
  authorizeSettings: MediaSettingsAuthorizer;
  requireCsrf: (request: Request) => Promise<void>;
  lifecycleEvents?: Pick<WebhookEventDispatcher, "emitMediaUploaded">;
  createMediaId?: () => string;
};

type UploadedFile = {
  name?: string;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

type UploadParts = {
  file: UploadedFile;
};

function createInvalidInputError(
  message: string,
  details?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    ...(details ? { details } : {}),
  });
}

function createMissingRoutingError(scope: {
  project?: string;
  environment?: string;
}): RuntimeError {
  return new RuntimeError({
    code: "MISSING_TARGET_ROUTING",
    message: "Both project and environment are required for media endpoints.",
    statusCode: 400,
    details: {
      project: scope.project ?? null,
      environment: scope.environment ?? null,
    },
  });
}

function createStorageUnavailableError(): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_STORAGE_UNAVAILABLE",
    message: "Media object storage is not configured.",
    statusCode: 503,
  });
}

function createMediaUploadTooLargeError(input: {
  limitBytes: number;
  sizeBytes: number;
}): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_UPLOAD_TOO_LARGE",
    message: "Media upload exceeds the configured image size limit.",
    statusCode: 413,
    details: {
      limitBytes: input.limitBytes,
      sizeBytes: input.sizeBytes,
    },
  });
}

function createMediaNotFoundError(id: string): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "Media asset not found.",
    statusCode: 404,
    details: { id },
  });
}

function createMetadataWriteFailedError(
  cleanupAttempted: boolean,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_METADATA_WRITE_FAILED",
    message: "Failed to persist media metadata.",
    statusCode: 500,
    details: { cleanupAttempted },
  });
}

function createMetadataDeleteFailedError(): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_METADATA_DELETE_FAILED",
    message: "Failed to delete media metadata.",
    statusCode: 500,
  });
}

function pickMediaScope(request: Request): MediaScope {
  const scope = resolveRequestTargetRouting(request);

  if (!scope.project || !scope.environment) {
    throw createMissingRoutingError(scope);
  }

  return {
    project: scope.project,
    environment: scope.environment,
  };
}

function requireObjectStore(
  objectStore: MediaObjectStore | undefined,
): MediaObjectStore {
  if (!objectStore) {
    throw createStorageUnavailableError();
  }

  return objectStore;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function normalizeFileValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  return [value];
}

function collectUploadPart(
  state: {
    files: UploadedFile[];
    extraFields: string[];
    invalidFile: boolean;
  },
  name: string,
  value: unknown,
): void {
  if (name !== "file") {
    state.extraFields.push(name);
    return;
  }

  for (const entry of normalizeFileValues(value)) {
    if (!isUploadedFile(entry)) {
      state.invalidFile = true;
      continue;
    }

    state.files.push(entry);
  }
}

async function formDataFromRequest(request: Request): Promise<FormData> {
  try {
    return await request.clone().formData();
  } catch {
    throw createInvalidInputError(
      "Media upload requires valid multipart form data.",
      { field: "body" },
    );
  }
}

async function parseUploadParts(
  request: Request,
  body: unknown,
): Promise<UploadParts> {
  const state = {
    files: [] as UploadedFile[],
    extraFields: [] as string[],
    invalidFile: false,
  };

  if (body instanceof FormData) {
    for (const [name, value] of body.entries()) {
      collectUploadPart(state, name, value);
    }
  } else if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body)
  ) {
    for (const [name, value] of Object.entries(body)) {
      collectUploadPart(state, name, value);
    }
  } else {
    const formData = await formDataFromRequest(request);

    for (const [name, value] of formData.entries()) {
      collectUploadPart(state, name, value);
    }
  }

  if (state.extraFields.length > 0) {
    throw createInvalidInputError(
      "Media upload accepts only the required file field.",
      { fields: state.extraFields },
    );
  }

  if (state.invalidFile || state.files.length !== 1) {
    throw createInvalidInputError(
      "Media upload requires exactly one file field.",
      { field: "file" },
    );
  }

  return {
    file: state.files[0] as UploadedFile,
  };
}

async function readUploadFile(file: UploadedFile): Promise<{
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}> {
  const filename = file.name?.trim() || "upload";
  const mimeType = file.type || "application/octet-stream";
  const bytes = new Uint8Array(await file.arrayBuffer());

  return {
    filename,
    mimeType,
    bytes,
  };
}

export function mountMediaApiRoutes(
  app: unknown,
  options: MountMediaApiRoutesOptions,
): void {
  const mediaApp = app as MediaRouteApp;

  mediaApp.get?.("/api/v1/media/settings", ({ request }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickMediaScope(request);
      await options.authorizeSettings(request);

      return { data: await options.store.getSettings(scope) };
    });
  });

  mediaApp.put?.("/api/v1/media/settings", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickMediaScope(request);
      await options.requireCsrf(request);
      const actor = await options.authorizeSettings(request);
      const input = parseMediaSettingsInput(body ?? {});

      return {
        data: await options.store.updateSettings(scope, input, {
          actorId: actor.actorId,
        }),
      };
    });
  });

  mediaApp.post?.("/api/v1/media/upload", ({ request, body }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickMediaScope(request);
      await options.requireCsrf(request);
      const authorized = await options.authorize(request, {
        requiredScope: "media:upload",
        project: scope.project,
        environment: scope.environment,
      });
      const objectStore = requireObjectStore(options.objectStore);
      const actor = actorFromAuthorizedRequest(authorized);
      const { file } = await parseUploadParts(request, body);
      const upload = await readUploadFile(file);
      const settings = await options.store.getSettings(scope);
      const limitBytes = settings.media.image.maxUploadSizeBytes;

      if (
        upload.mimeType.startsWith("image/") &&
        limitBytes !== null &&
        upload.bytes.byteLength > limitBytes
      ) {
        throw createMediaUploadTooLargeError({
          limitBytes,
          sizeBytes: upload.bytes.byteLength,
        });
      }

      const id = options.createMediaId?.() ?? randomUUID();
      const mediaId = parseMediaId(id);
      const s3Key = createMediaObjectKey({
        project: scope.project,
        mediaId,
        filename: upload.filename,
      });
      const url = objectStore.publicUrlForKey(s3Key);

      await objectStore.putObject({
        key: s3Key,
        body: upload.bytes,
        contentType: upload.mimeType,
      });

      let asset;

      try {
        asset = await options.store.createAsset(
          scope,
          {
            id: mediaId,
            filename: upload.filename,
            mimeType: upload.mimeType,
            sizeBytes: upload.bytes.byteLength,
            s3Key,
            url,
          },
          { actorId: actor.id },
        );
      } catch {
        let cleanupAttempted = false;

        try {
          cleanupAttempted = true;
          await objectStore.deleteObject({ key: s3Key });
        } catch {
          // Best-effort cleanup must not mask the deterministic metadata error.
        }

        throw createMetadataWriteFailedError(cleanupAttempted);
      }

      void options.lifecycleEvents
        ?.emitMediaUploaded({
          scope,
          media: {
            id: asset.id,
            filename: asset.filename,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            url: asset.url,
          },
          actor,
        })
        .catch(() => {
          // Side effects are fire-and-forget from the mutation caller's
          // perspective; sink failures must not fail the committed upload.
        });

      return { data: asset };
    });
  });

  mediaApp.get?.("/api/v1/media/:id", ({ request, params }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickMediaScope(request);
      const mediaId = parseMediaId(params.id);
      await options.authorize(request, {
        requiredScope: "media:read",
        project: scope.project,
        environment: scope.environment,
      });
      const asset = await options.store.getAsset(scope, mediaId);

      if (!asset) {
        throw createMediaNotFoundError(mediaId);
      }

      return { data: asset };
    });
  });

  mediaApp.delete?.("/api/v1/media/:id", ({ request, params }: any) => {
    return executeWithRuntimeErrorsHandled(request, async () => {
      const scope = pickMediaScope(request);
      const mediaId = parseMediaId(params.id);
      await options.requireCsrf(request);
      await options.authorize(request, {
        requiredScope: "media:delete",
        project: scope.project,
        environment: scope.environment,
      });
      const objectStore = requireObjectStore(options.objectStore);
      const asset = await options.store.getAssetRecord(scope, mediaId);

      if (!asset) {
        throw createMediaNotFoundError(mediaId);
      }

      await objectStore.deleteObject({ key: asset.s3Key });

      try {
        return {
          data: await options.store.deleteAssetMetadata(scope, mediaId),
        };
      } catch {
        throw createMetadataDeleteFailedError();
      }
    });
  });
}
