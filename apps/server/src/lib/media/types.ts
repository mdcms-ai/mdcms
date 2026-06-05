import type { MediaAsset, MediaSettings } from "@mdcms/shared";

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
