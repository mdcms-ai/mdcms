import assert from "node:assert/strict";
import { test } from "bun:test";

import type { MediaAsset } from "@mdcms/shared";

import {
  createMediaAssetsInsertContent,
  createMediaAssetsMarkdown,
  formatMediaAssetMarkdown,
} from "./media-markdown-insertion.js";
import { serializeDocumentToMarkdown } from "../../../markdown-pipeline.js";

function createMediaAsset(asset: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "media_1",
    project: "default",
    filename: "asset.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    url: "https://cdn.example.com/asset.png",
    uploadedBy: "user_1",
    uploadedAt: "2026-06-06T12:00:00.000Z",
    ...asset,
  };
}

test("formatMediaAssetMarkdown creates image syntax and escapes label characters", () => {
  const asset = createMediaAsset({
    filename: String.raw`Hero [draft]\v2.png`,
    mimeType: "image/png",
    url: "https://cdn.example.com/hero.png",
  });

  assert.equal(
    formatMediaAssetMarkdown(asset),
    String.raw`![Hero \[draft\]\\v2.png](https://cdn.example.com/hero.png)`,
  );
});

test("formatMediaAssetMarkdown creates link syntax for non-image assets", () => {
  const asset = createMediaAsset({
    filename: "brief.pdf",
    mimeType: "application/pdf",
    url: "https://cdn.example.com/brief.pdf",
  });

  assert.equal(
    formatMediaAssetMarkdown(asset),
    "[brief.pdf](https://cdn.example.com/brief.pdf)",
  );
});

test("formatMediaAssetMarkdown falls back to media for blank filenames", () => {
  const asset = createMediaAsset({
    filename: "   ",
    mimeType: "application/pdf",
    url: "https://cdn.example.com/download",
  });

  assert.equal(
    formatMediaAssetMarkdown(asset),
    "[media](https://cdn.example.com/download)",
  );
});

test("createMediaAssetsMarkdown joins assets in order with blank lines", () => {
  const markdown = createMediaAssetsMarkdown([
    createMediaAsset({
      id: "media_1",
      filename: "hero.png",
      mimeType: "image/png",
      url: "https://cdn.example.com/hero.png",
    }),
    createMediaAsset({
      id: "media_2",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      url: "https://cdn.example.com/brief.pdf",
    }),
  ]);

  assert.equal(
    markdown,
    [
      "![hero.png](https://cdn.example.com/hero.png)",
      "",
      "[brief.pdf](https://cdn.example.com/brief.pdf)",
    ].join("\n"),
  );
});

test("createMediaAssetsInsertContent returns TipTap content parsed from generated Markdown", () => {
  const content = createMediaAssetsInsertContent([
    createMediaAsset({
      filename: "hero.png",
      mimeType: "image/png",
      url: "https://cdn.example.com/hero.png",
    }),
  ]);

  assert.ok(Array.isArray(content));
  assert.ok(content.length > 0);
});

test("formatMediaAssetMarkdown keeps destination-sensitive URL characters parse-safe", () => {
  const asset = createMediaAsset({
    filename: "brief.pdf",
    mimeType: "application/pdf",
    url: "https://cdn.example.com/assets)/project brief.pdf",
  });

  assert.equal(
    formatMediaAssetMarkdown(asset),
    "[brief.pdf](https://cdn.example.com/assets%29/project%20brief.pdf)",
  );
});

test("createMediaAssetsInsertContent preserves encoded hrefs after markdown parsing", () => {
  const content = createMediaAssetsInsertContent([
    createMediaAsset({
      filename: "brief.pdf",
      mimeType: "application/pdf",
      url: "https://cdn.example.com/assets)/project brief.pdf",
    }),
  ]);
  const paragraph = content[0];
  const textNode = paragraph?.content?.[0];
  const linkMark = textNode?.marks?.find((mark) => mark.type === "link");

  assert.equal(
    linkMark?.attrs?.href,
    "https://cdn.example.com/assets%29/project%20brief.pdf",
  );
  assert.equal(
    serializeDocumentToMarkdown({ type: "doc", content }),
    "[brief.pdf](https://cdn.example.com/assets%29/project%20brief.pdf)",
  );
});
