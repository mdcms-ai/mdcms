import type {
  MediaAsset,
  MediaAssetCategory,
  MediaSettings,
} from "@mdcms/shared";

export type MediaScope = {
  project: string;
  environment: string;
};

export type MediaActorContext = {
  actorId: string;
};

export type CreateMediaAssetInput = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  url: string;
};

export type MediaAssetRecord = MediaAsset & {
  s3Key: string;
};

export type MediaAssetListSort = "uploadedAt" | "filename" | "sizeBytes";

export type MediaAssetListOrder = "asc" | "desc";

export type MediaAssetListQuery = {
  q?: string;
  category?: MediaAssetCategory;
  uploadedBy?: string;
  uploadedFrom?: Date;
  uploadedTo?: Date;
  sort: MediaAssetListSort;
  order: MediaAssetListOrder;
  limit: number;
  offset: number;
};

export type MediaAssetListResult = {
  assets: MediaAsset[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

export type MediaMetadataStore = {
  getSettings(scope: MediaScope): Promise<MediaSettings>;
  updateSettings(
    scope: MediaScope,
    input: MediaSettings,
    context: MediaActorContext,
  ): Promise<MediaSettings>;
  createAsset(
    scope: MediaScope,
    input: CreateMediaAssetInput,
    context: MediaActorContext,
  ): Promise<MediaAsset>;
  listAssets(
    scope: MediaScope,
    query: MediaAssetListQuery,
  ): Promise<MediaAssetListResult>;
  getAsset(scope: MediaScope, id: string): Promise<MediaAsset | undefined>;
  getAssetRecord(
    scope: MediaScope,
    id: string,
  ): Promise<MediaAssetRecord | undefined>;
  deleteAssetMetadata(
    scope: MediaScope,
    id: string,
  ): Promise<{ deleted: true; id: string }>;
};

export type MediaObjectStore = {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  deleteObject(input: { key: string }): Promise<void>;
  publicUrlForKey(key: string): string;
};
