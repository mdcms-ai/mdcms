import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import type { MediaAsset } from "@mdcms/shared";
import { Search, Upload } from "lucide-react";

import type {
  StudioMediaLibraryApi,
  StudioMediaLibraryListQuery,
} from "../../lib/media-library-api.js";
import type { StudioMediaUploadApi } from "../../lib/media-upload-api.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";

export type FileFieldPreset = "image" | "video" | "file";

export type FileFieldMetadata = {
  preset: FileFieldPreset;
  accept: string[];
  emptyStringAsUnset?: boolean;
};

type FileFieldAssetState =
  | { status: "idle" }
  | { status: "loading"; id: string }
  | { status: "ready"; id: string; asset: MediaAsset }
  | { status: "error"; id: string; message: string };

type FileFieldPickerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; assets: MediaAsset[] }
  | { status: "error"; message: string };

type MediaFieldOperationGuard = {
  startUpload: () => number;
  finishUpload: (token: number) => void;
  invalidate: () => void;
  isCurrentUpload: (token: number) => boolean;
  isUploadActive: () => boolean;
};

export type MediaFieldControlProps = {
  fieldName: string;
  value: string | null | undefined;
  file: FileFieldMetadata;
  canUnset: boolean;
  readOnly: boolean;
  canReadMedia: boolean;
  canUploadMedia: boolean;
  mediaLibraryApi: Pick<StudioMediaLibraryApi, "get" | "list"> | null;
  mediaUploadApi: StudioMediaUploadApi | null;
  onChange: (value: string | null | undefined) => void;
  onUnset: () => void;
};

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function matchesAcceptRule(mimeType: string, accept: string): boolean {
  const normalizedAccept = normalizeMimeType(accept);

  if (!normalizedAccept.includes("/")) {
    return false;
  }

  if (normalizedAccept.endsWith("/*")) {
    return mimeType.startsWith(`${normalizedAccept.slice(0, -1)}`);
  }

  return mimeType === normalizedAccept;
}

export function mediaAssetMatchesFileField(
  asset: Pick<MediaAsset, "mimeType">,
  file: Pick<FileFieldMetadata, "preset" | "accept">,
): boolean {
  const mimeType = normalizeMimeType(asset.mimeType);

  if (file.preset === "image" && !mimeType.startsWith("image/")) {
    return false;
  }

  if (file.preset === "video" && !mimeType.startsWith("video/")) {
    return false;
  }

  if (file.accept.length === 0) {
    return true;
  }

  return file.accept.some((accept) => matchesAcceptRule(mimeType, accept));
}

export function resolveFileFieldMediaListQuery(
  preset: FileFieldPreset,
): StudioMediaLibraryListQuery {
  return {
    ...(preset === "image" || preset === "video" ? { category: preset } : {}),
    sort: "uploadedAt",
    order: "desc",
    limit: 24,
  };
}

export async function listMatchingMediaAssets(input: {
  list: StudioMediaLibraryApi["list"];
  file: Pick<FileFieldMetadata, "preset" | "accept">;
  desiredCount?: number;
  pageSize?: number;
}): Promise<MediaAsset[]> {
  const pageSize = input.pageSize ?? 24;
  const desiredCount = input.desiredCount ?? pageSize;
  const matches: MediaAsset[] = [];
  let offset = 0;

  while (matches.length < desiredCount) {
    const response = await input.list({
      ...resolveFileFieldMediaListQuery(input.file.preset),
      limit: pageSize,
      offset,
    });

    matches.push(
      ...response.data.filter((asset) =>
        mediaAssetMatchesFileField(asset, input.file),
      ),
    );

    if (!response.pagination.hasMore) {
      break;
    }

    offset = response.pagination.offset + response.pagination.limit;
  }

  return matches.slice(0, desiredCount);
}

export function createMediaFieldOperationGuard(): MediaFieldOperationGuard {
  let generation = 0;
  let activeUpload: number | undefined;

  return {
    startUpload() {
      generation += 1;
      activeUpload = generation;
      return generation;
    },
    finishUpload(token) {
      if (activeUpload === token) {
        activeUpload = undefined;
      }
    },
    invalidate() {
      generation += 1;
      activeUpload = undefined;
    },
    isCurrentUpload(token) {
      return activeUpload === token && generation === token;
    },
    isUploadActive() {
      return activeUpload !== undefined;
    },
  };
}

function resolveFileInputAccept(file: FileFieldMetadata): string | undefined {
  if (file.accept.length > 0) {
    return file.accept.join(",");
  }

  if (file.preset === "image") {
    return "image/*";
  }

  if (file.preset === "video") {
    return "video/*";
  }

  return undefined;
}

function formatMediaError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function formatUploadedAssetMismatch(file: FileFieldMetadata): string {
  if (file.accept.length > 0) {
    return `Uploaded asset does not match ${file.accept.join(", ")}.`;
  }

  if (file.preset === "image") {
    return "Uploaded asset must be an image.";
  }

  if (file.preset === "video") {
    return "Uploaded asset must be a video.";
  }

  return "Uploaded asset is not valid for this field.";
}

export function FileFieldAssetPreview({ asset }: { asset: MediaAsset }) {
  const mimeType = normalizeMimeType(asset.mimeType);

  if (mimeType.startsWith("image/")) {
    return (
      <img
        src={asset.url}
        alt=""
        className="max-h-28 w-full rounded border border-border object-cover"
      />
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <video
        src={asset.url}
        controls
        preload="metadata"
        className="max-h-32 w-full rounded border border-border"
      />
    );
  }

  return (
    <div className="rounded border border-border bg-muted/40 px-3 py-2">
      <div className="truncate text-xs font-medium text-foreground">
        {asset.filename}
      </div>
      <div className="truncate font-mono text-[10px] text-foreground-muted">
        {asset.mimeType}
      </div>
    </div>
  );
}

export function FileFieldSelectedAssetView({ asset }: { asset: MediaAsset }) {
  return (
    <div className="flex flex-col gap-2">
      <FileFieldAssetPreview asset={asset} />
      <div className="truncate text-xs text-foreground">{asset.filename}</div>
    </div>
  );
}

export function FileFieldUploadFeedback({
  uploadProgress,
  localError,
}: {
  uploadProgress?: number;
  localError?: string;
}) {
  return (
    <>
      {uploadProgress !== undefined ? (
        <div
          role="status"
          aria-live="polite"
          className="text-[11px] text-foreground-muted"
        >
          Uploading {uploadProgress}%
        </div>
      ) : null}
      {localError ? (
        <div
          role="alert"
          aria-live="assertive"
          className="text-[11px] text-destructive"
        >
          {localError}
        </div>
      ) : null}
    </>
  );
}

export function MediaFieldControl({
  fieldName,
  value,
  file,
  canUnset,
  readOnly,
  canReadMedia,
  canUploadMedia,
  mediaLibraryApi,
  mediaUploadApi,
  onChange,
  onUnset,
}: MediaFieldControlProps) {
  const selectedAssetId =
    typeof value === "string" && value.length > 0 ? value : undefined;
  const canBrowse = !readOnly && canReadMedia && mediaLibraryApi !== null;
  const canUpload = !readOnly && canUploadMedia && mediaUploadApi !== null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const operationGuard = useMemo(() => createMediaFieldOperationGuard(), []);
  const [assetState, setAssetState] = useState<FileFieldAssetState>({
    status: "idle",
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerState, setPickerState] = useState<FileFieldPickerState>({
    status: "idle",
  });
  const [localError, setLocalError] = useState<string | undefined>();
  const [uploadProgress, setUploadProgress] = useState<number | undefined>();
  const acceptAttribute = useMemo(() => resolveFileInputAccept(file), [file]);
  const acceptKey = file.accept.join("\u0000");

  useEffect(() => {
    if (!selectedAssetId || !canReadMedia || mediaLibraryApi === null) {
      setAssetState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setAssetState({ status: "loading", id: selectedAssetId });

    void mediaLibraryApi
      .get(selectedAssetId)
      .then((asset) => {
        if (!cancelled) {
          setAssetState({ status: "ready", id: selectedAssetId, asset });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAssetState({
            status: "error",
            id: selectedAssetId,
            message: formatMediaError(
              error,
              "Media asset could not be loaded.",
            ),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canReadMedia, mediaLibraryApi, selectedAssetId]);

  useEffect(() => {
    if (!pickerOpen || !canBrowse || mediaLibraryApi === null) {
      return;
    }

    let cancelled = false;
    setPickerState({ status: "loading" });

    void listMatchingMediaAssets({
      list: (query) => mediaLibraryApi.list(query),
      file,
    })
      .then((assets) => {
        if (!cancelled) {
          setPickerState({
            status: "ready",
            assets,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPickerState({
            status: "error",
            message: formatMediaError(error, "Media library could not load."),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [acceptKey, canBrowse, file, mediaLibraryApi, pickerOpen]);

  const selectAsset = (asset: MediaAsset) => {
    operationGuard.invalidate();
    setUploadProgress(undefined);

    if (!mediaAssetMatchesFileField(asset, file)) {
      setLocalError(formatUploadedAssetMismatch(file));
      return;
    }

    setLocalError(undefined);
    onChange(asset.id);
    setPickerOpen(false);
  };

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const uploadFile = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (
      !uploadFile ||
      !canUpload ||
      mediaUploadApi === null ||
      operationGuard.isUploadActive()
    ) {
      return;
    }

    const uploadToken = operationGuard.startUpload();
    setLocalError(undefined);
    setUploadProgress(0);

    try {
      const asset = await mediaUploadApi.upload(uploadFile, {
        onProgress: (progress) => {
          if (
            progress.total > 0 &&
            operationGuard.isCurrentUpload(uploadToken)
          ) {
            setUploadProgress(
              Math.min(
                100,
                Math.round((progress.loaded / progress.total) * 100),
              ),
            );
          }
        },
      });

      if (!operationGuard.isCurrentUpload(uploadToken)) {
        return;
      }

      if (!mediaAssetMatchesFileField(asset, file)) {
        setLocalError(formatUploadedAssetMismatch(file));
        return;
      }

      onChange(asset.id);
    } catch (error) {
      if (operationGuard.isCurrentUpload(uploadToken)) {
        setLocalError(formatMediaError(error, "Media upload failed."));
      }
    } finally {
      if (operationGuard.isCurrentUpload(uploadToken)) {
        operationGuard.finishUpload(uploadToken);
        setUploadProgress(undefined);
      } else {
        operationGuard.finishUpload(uploadToken);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded border border-border bg-muted/30 p-2">
        {assetState.status === "ready" ? (
          <FileFieldSelectedAssetView asset={assetState.asset} />
        ) : selectedAssetId ? (
          <div className="break-all font-mono text-[11px] text-foreground">
            {selectedAssetId}
          </div>
        ) : (
          <div className="text-xs text-foreground-muted">No asset selected</div>
        )}
        {assetState.status === "loading" ? (
          <div className="mt-1 text-[11px] text-foreground-muted">
            Loading asset...
          </div>
        ) : null}
        {assetState.status === "error" ? (
          <div className="mt-1 text-[11px] text-destructive">
            {assetState.message}
          </div>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-2">
          {canBrowse ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              <Search className="size-3" aria-hidden />
              Browse media
            </Button>
          ) : null}

          {canUpload ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept={acceptAttribute}
                className="hidden"
                onChange={uploadFile}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={uploadProgress !== undefined}
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="size-3" aria-hidden />
                Upload media
              </Button>
            </>
          ) : null}

          {canUnset && selectedAssetId ? (
            <button
              type="button"
              aria-label={`Unset ${fieldName}`}
              className="text-xs text-foreground-muted hover:text-foreground"
              onClick={() => {
                operationGuard.invalidate();
                setUploadProgress(undefined);
                onUnset();
              }}
            >
              Unset
            </button>
          ) : null}
        </div>
      ) : null}

      <FileFieldUploadFeedback
        uploadProgress={uploadProgress}
        localError={localError}
      />

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select media</DialogTitle>
            <DialogDescription>
              Choose an existing asset for {fieldName}.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto">
            {pickerState.status === "loading" ? (
              <div className="text-sm text-foreground-muted">
                Loading media assets...
              </div>
            ) : null}
            {pickerState.status === "error" ? (
              <div className="text-sm text-destructive">
                {pickerState.message}
              </div>
            ) : null}
            {pickerState.status === "ready" &&
            pickerState.assets.length === 0 ? (
              <div className="text-sm text-foreground-muted">
                No matching media assets.
              </div>
            ) : null}
            {pickerState.status === "ready" && pickerState.assets.length > 0 ? (
              <div className="grid gap-2">
                {pickerState.assets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className="rounded border border-border p-2 text-left hover:bg-muted"
                    onClick={() => selectAsset(asset)}
                  >
                    <div className="truncate text-xs font-medium text-foreground">
                      {asset.filename}
                    </div>
                    <div className="truncate font-mono text-[10px] text-foreground-muted">
                      {asset.mimeType}
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
