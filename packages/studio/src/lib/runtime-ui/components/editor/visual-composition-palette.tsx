"use client";

import type { DragEvent } from "react";

import {
  Box,
  Heading2,
  Image as ImageIcon,
  Link as LinkIcon,
  List,
  Pilcrow,
  Puzzle,
  Quote,
  Search,
} from "lucide-react";

import { cn } from "../../lib/utils.js";
import type {
  VisualCompositionBlock,
  VisualCompositionGroupId,
  VisualCompositionPaletteGroup,
} from "./visual-composition-types.js";

export const VISUAL_COMPOSITION_DRAG_MIME = "application/x-mdcms-visual-block";

export type VisualCompositionPaletteProps = {
  groups: readonly VisualCompositionPaletteGroup[];
  query: string;
  readOnly?: boolean;
  onQueryChange: (query: string) => void;
  onInsert: (block: VisualCompositionBlock) => void;
};

export function VisualCompositionPalette({
  groups,
  query,
  readOnly = false,
  onQueryChange,
  onInsert,
}: VisualCompositionPaletteProps) {
  const visibleGroups = getFilteredPaletteGroups(groups, query);

  return (
    <aside
      data-mdcms-visual-palette="true"
      className="hidden w-64 shrink-0 border-r border-border bg-card lg:flex lg:flex-col"
    >
      <div className="border-b border-border p-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
          Blocks
        </div>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-foreground-muted">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search blocks"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-muted"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visibleGroups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-foreground-muted">
            No blocks match the current filter.
          </p>
        ) : (
          <div className="space-y-3">
            {visibleGroups.map((group) => (
              <section
                key={group.id}
                data-mdcms-visual-palette-group={group.id}
                className="space-y-1"
              >
                <div className="px-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.blocks.map((block) => (
                    <VisualCompositionPaletteItem
                      key={block.id}
                      block={block}
                      readOnly={readOnly}
                      onInsert={onInsert}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function VisualCompositionPaletteItem({
  block,
  readOnly,
  onInsert,
}: {
  block: VisualCompositionBlock;
  readOnly: boolean;
  onInsert: (block: VisualCompositionBlock) => void;
}) {
  const description =
    block.kind === "mdx-component" ? block.component.description : undefined;

  return (
    <button
      type="button"
      disabled={readOnly}
      draggable={!readOnly}
      data-mdcms-visual-palette-item={block.id}
      data-mdcms-visual-palette-kind={block.kind}
      onDragStart={(event) => writeVisualCompositionDragPayload(event, block)}
      onClick={() => onInsert(block)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition-colors",
        "text-foreground hover:bg-accent-subtle",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-background-subtle text-foreground-muted group-hover:bg-background group-hover:text-primary">
        {resolveBlockIcon(block)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">
          {block.label}
        </span>
        <span className="block truncate font-mono text-[10px] text-foreground-muted">
          {description ?? describeBlockKind(block.group)}
        </span>
      </span>
    </button>
  );
}

export function writeVisualCompositionDragPayload(
  event: DragEvent<HTMLElement>,
  block: VisualCompositionBlock,
): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(
    VISUAL_COMPOSITION_DRAG_MIME,
    JSON.stringify({ block }),
  );
}

export function readVisualCompositionDragPayload(
  event: DragEvent<HTMLElement>,
): VisualCompositionBlock | null {
  const raw = event.dataTransfer.getData(VISUAL_COMPOSITION_DRAG_MIME);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { block?: VisualCompositionBlock };
    return parsed.block ?? null;
  } catch {
    return null;
  }
}

function getFilteredPaletteGroups(
  groups: readonly VisualCompositionPaletteGroup[],
  query: string,
): VisualCompositionPaletteGroup[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return groups.filter((group) => group.blocks.length > 0);
  }

  return groups.flatMap((group) => {
    const blocks = group.blocks.filter((block) =>
      getPaletteSearchText(group.id, block).includes(normalizedQuery),
    );

    return blocks.length > 0 ? [{ ...group, blocks }] : [];
  });
}

function getPaletteSearchText(
  groupId: VisualCompositionGroupId,
  block: VisualCompositionBlock,
): string {
  const description =
    block.kind === "mdx-component" ? block.component.description : "";

  return [groupId, block.label, description ?? ""].join(" ").toLowerCase();
}

function resolveBlockIcon(block: VisualCompositionBlock) {
  if (block.kind === "mdx-component") {
    switch (block.component.name) {
      case "Box":
        return <Box className="size-4" aria-hidden />;
      case "Image":
        return <ImageIcon className="size-4" aria-hidden />;
      case "Link":
        return <LinkIcon className="size-4" aria-hidden />;
      default:
        return <Puzzle className="size-4" aria-hidden />;
    }
  }

  switch (block.nodeType) {
    case "paragraph":
      return <Pilcrow className="size-4" aria-hidden />;
    case "heading":
      return <Heading2 className="size-4" aria-hidden />;
    case "bulletList":
      return <List className="size-4" aria-hidden />;
    case "blockquote":
      return <Quote className="size-4" aria-hidden />;
  }
}

function describeBlockKind(group: VisualCompositionGroupId): string {
  switch (group) {
    case "Text":
      return "Markdown";
    case "Layout":
    case "Media":
    case "Actions":
      return "Built-in";
    case "Components":
      return "Component";
  }
}
