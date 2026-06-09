"use client";

import type { MouseEvent } from "react";

import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewWrapper } from "@tiptap/react";

import { Image as ImageIcon, Trash2 } from "lucide-react";

import { cn } from "../../lib/utils.js";

type ImageNodeFrameProps = {
  src: string;
  alt: string;
  title?: string | null;
  selected?: boolean;
  readOnly?: boolean;
  onChangeImage?: () => void;
  onDeleteImage?: () => void;
};

function preventImageChromeButtonMouseDown(
  event: MouseEvent<HTMLButtonElement>,
) {
  event.preventDefault();
}

function getNodePosition(getPos: ReactNodeViewProps["getPos"]): number | null {
  const position = getPos();

  return typeof position === "number" ? position : null;
}

export function ImageNodeFrame({
  src,
  alt,
  title,
  selected = false,
  readOnly = false,
  onChangeImage,
  onDeleteImage,
}: ImageNodeFrameProps) {
  const showControls =
    selected &&
    !readOnly &&
    (onChangeImage !== undefined || onDeleteImage !== undefined);

  return (
    <div
      data-mdcms-image-node="true"
      data-mdcms-image-node-selected={selected ? "true" : "false"}
      className={cn(
        "group/image-node relative my-4 block max-w-full",
        selected && "z-[1]",
      )}
    >
      <img src={src} alt={alt} title={title ?? undefined} draggable={false} />

      {showControls ? (
        <div
          className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm backdrop-blur"
          contentEditable={false}
          suppressContentEditableWarning
        >
          {onChangeImage ? (
            <button
              type="button"
              aria-label="Change image"
              title="Change image"
              onMouseDown={preventImageChromeButtonMouseDown}
              onClick={onChangeImage}
              className="inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium text-foreground-muted hover:bg-accent-subtle hover:text-foreground"
            >
              <ImageIcon className="size-3.5" />
              <span>Change image</span>
            </button>
          ) : null}
          {onDeleteImage ? (
            <button
              type="button"
              aria-label="Delete image"
              title="Delete image"
              onMouseDown={preventImageChromeButtonMouseDown}
              onClick={onDeleteImage}
              className="inline-flex size-7 items-center justify-center rounded text-foreground-muted hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ImageNodeView(
  props: ReactNodeViewProps & {
    readOnly?: boolean;
    onChangeImage?: (position: number) => void;
    onDeleteImage?: (position: number) => void;
  },
) {
  const src =
    typeof props.node.attrs.src === "string" ? props.node.attrs.src : "";
  const alt =
    typeof props.node.attrs.alt === "string" ? props.node.attrs.alt : "";
  const title =
    typeof props.node.attrs.title === "string" ? props.node.attrs.title : null;
  const readOnly = props.readOnly ?? !props.editor.isEditable;

  return (
    <NodeViewWrapper as="div" data-mdcms-image-node-wrapper="true">
      <ImageNodeFrame
        src={src}
        alt={alt}
        title={title}
        selected={props.selected}
        readOnly={readOnly}
        onChangeImage={
          props.onChangeImage
            ? () => {
                const position = getNodePosition(props.getPos);
                if (position !== null) {
                  props.onChangeImage?.(position);
                }
              }
            : undefined
        }
        onDeleteImage={
          props.onDeleteImage
            ? () => {
                const position = getNodePosition(props.getPos);
                if (position !== null) {
                  props.onDeleteImage?.(position);
                }
              }
            : undefined
        }
      />
    </NodeViewWrapper>
  );
}
