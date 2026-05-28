import type { JSONContent } from "@tiptap/core";
import type { StudioMountContext } from "@mdcms/shared";

export type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type VisualCompositionGroupId =
  | "Text"
  | "Layout"
  | "Media"
  | "Actions"
  | "Components";

export type VisualCompositionMarkdownNodeType =
  | "paragraph"
  | "heading"
  | "bulletList"
  | "blockquote";

export type VisualCompositionMarkdownBlock = {
  kind: "markdown";
  id: string;
  label: string;
  group: VisualCompositionGroupId;
  nodeType: VisualCompositionMarkdownNodeType;
};

export type VisualCompositionMdxComponentBlock = {
  kind: "mdx-component";
  id: string;
  label: string;
  group: VisualCompositionGroupId;
  component: MdxCatalogComponent;
};

export type VisualCompositionBlock =
  | VisualCompositionMarkdownBlock
  | VisualCompositionMdxComponentBlock;

export type VisualCompositionPaletteGroup = {
  id: VisualCompositionGroupId;
  label: VisualCompositionGroupId;
  blocks: VisualCompositionBlock[];
};

export type VisualCompositionInsertion = {
  block: VisualCompositionBlock;
  props?: Record<string, unknown>;
  position?: number;
};

export type VisualCompositionRequiredPropsResult = {
  valid: boolean;
  missing: string[];
};

export type VisualCompositionSerializedBlockPayload = {
  block: VisualCompositionBlock;
};

export type VisualCompositionInsertContent = JSONContent | JSONContent[];
