import { z } from "zod";
import {
  RuntimeError,
  type MediaAsset,
  type MediaAssetListResponse,
} from "@mdcms/shared";
import { dispatchJson } from "./content.js";
import { defineAgentTool } from "./types.js";
const text = z.string().min(1);
export const mediaAssetSchema = z.object({
  id: text,
  project: text,
  filename: text,
  mimeType: text,
  sizeBytes: z.number().int().nonnegative(),
  url: text,
  uploadedBy: text,
  uploadedAt: text,
}) satisfies z.ZodType<MediaAsset>;
export const mediaListSchema = z.object({
  data: z.array(mediaAssetSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  }),
  storage: z.object({ objectStorageConfigured: z.boolean() }),
}) satisfies z.ZodType<MediaAssetListResponse>;
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const mediaTools = [
  defineAgentTool({
    name: "list_media",
    title: "List media",
    description: "List uploaded media and storage status.",
    requiredScopes: ["media:read"],
    annotations: read,
    inputSchema: z.strictObject({
      q: z.string().optional(),
      category: z
        .enum(["image", "video", "audio", "document", "archive", "other"])
        .optional(),
      uploadedBy: text.optional(),
      uploadedFrom: text.optional(),
      uploadedTo: text.optional(),
      sort: z.enum(["uploadedAt", "filename", "sizeBytes"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    outputSchema: mediaListSchema,
    execute: (input, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: "/api/v1/media",
        query: Object.fromEntries(
          Object.entries(input).map(([k, v]) => [k, String(v)]),
        ),
      }),
  }),
  defineAgentTool({
    name: "get_media",
    title: "Get media",
    description: "Read uploaded media metadata.",
    requiredScopes: ["media:read"],
    annotations: read,
    inputSchema: z.strictObject({ id: text }),
    outputSchema: z.object({ data: mediaAssetSchema }),
    execute: ({ id }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: `/api/v1/media/${encodeURIComponent(id)}`,
      }),
  }),
  defineAgentTool({
    name: "delete_media",
    title: "Delete media",
    description: "Delete uploaded media.",
    requiredScopes: ["media:delete"],
    annotations: write,
    inputSchema: z.strictObject({ id: text }),
    outputSchema: z.object({
      data: z.object({ deleted: z.literal(true), id: text }),
    }),
    execute: ({ id }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "DELETE",
        path: `/api/v1/media/${encodeURIComponent(id)}`,
      }),
  }),
  defineAgentTool({
    name: "upload_media",
    title: "Upload media",
    description:
      "Upload a canonical base64 file through the multipart media route.",
    requiredScopes: ["media:upload"],
    annotations: { ...write, destructiveHint: false },
    inputSchema: z.strictObject({
      filename: text,
      mimeType: text,
      base64: z.string(),
    }),
    outputSchema: z.object({ data: mediaAssetSchema }),
    execute: async (
      { filename, mimeType, base64 },
      { dispatch, getMediaUploadLimit },
    ) => {
      const tooLarge = () =>
        new RuntimeError({
          code: "MEDIA_UPLOAD_TOO_LARGE",
          message: "Media upload exceeds the tool size limit.",
          statusCode: 413,
        });
      const configuredLimit = await getMediaUploadLimit?.();
      const limit = Math.min(
        MAX_UPLOAD_BYTES,
        configuredLimit ?? MAX_UPLOAD_BYTES,
      );
      if (base64.length > 4 * Math.ceil(limit / 3)) throw tooLarge();
      if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: "Canonical base64 is required.",
          statusCode: 400,
        });
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length > limit) throw tooLarge();
      if (bytes.toString("base64") !== base64)
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message: "Canonical base64 is required.",
          statusCode: 400,
        });
      const body = new FormData();
      body.set("file", new File([bytes], filename, { type: mimeType }));
      return dispatchJson(dispatch, {
        method: "POST",
        path: "/api/v1/media/upload",
        body,
      });
    },
  }),
];
