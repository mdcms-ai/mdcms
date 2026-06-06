import type { MediaAsset } from "@mdcms/shared";
import type { JSONContent } from "@tiptap/core";

import { parseMarkdownToDocument } from "../../../markdown-pipeline.js";

function createMarkdownLabel(filename: string): string {
  const label = filename.trim().length > 0 ? filename : "media";

  return label.replace(/[\\[\]]/g, "\\$&");
}

function createMarkdownDestination(url: string): string {
  return url.replace(
    /[\s()<>\\]/g,
    (value) =>
      `%${value.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

export function formatMediaAssetMarkdown(asset: MediaAsset): string {
  const label = createMarkdownLabel(asset.filename);
  const destination = createMarkdownDestination(asset.url);

  if (asset.mimeType.startsWith("image/")) {
    return `![${label}](${destination})`;
  }

  return `[${label}](${destination})`;
}

export function createMediaAssetsMarkdown(
  assets: readonly MediaAsset[],
): string {
  return assets.map(formatMediaAssetMarkdown).join("\n\n");
}

export function createMediaAssetsInsertContent(
  assets: readonly MediaAsset[],
): JSONContent[] {
  return (
    parseMarkdownToDocument(createMediaAssetsMarkdown(assets)).content ?? []
  );
}
