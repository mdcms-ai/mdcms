"use client";

import { useEffect, useRef } from "react";

import type { StudioMountContext } from "@mdcms/shared";

import { isMdxComponentVisibleInInsertUi } from "./mdx-component-catalog.js";
import { cn } from "../../lib/utils.js";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type MdxComponentPickerProps = {
  components: readonly MdxCatalogComponent[];
  query?: string;
  forbidden?: boolean;
  onSelect: (component: MdxCatalogComponent) => void;
  /** Currently highlighted item — wired to keyboard arrow navigation. */
  highlightedIndex?: number;
  /** Notifies the host so mouse hover keeps the keyboard cursor in sync. */
  onHighlightedIndexChange?: (index: number) => void;
};

export function MdxComponentPicker({
  components,
  query = "",
  forbidden = false,
  onSelect,
  highlightedIndex,
  onHighlightedIndexChange,
}: MdxComponentPickerProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const visibleComponents = components.filter(isMdxComponentVisibleInInsertUi);

  // Scroll the highlighted row into view when the user arrows past the
  // visible area of a tall component catalog. Declared before the empty-
  // catalog early return so hooks always fire in the same order.
  useEffect(() => {
    if (highlightedIndex === undefined) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(
      `[data-mdcms-mdx-picker-item-index="${highlightedIndex}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  if (visibleComponents.length === 0) {
    return (
      <section
        data-mdcms-mdx-picker="catalog"
        data-mdcms-mdx-picker-state="empty"
        className="rounded-md border border-border bg-card p-3 text-sm text-foreground-muted shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]"
      >
        No local MDX components registered.
      </section>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filteredComponents = visibleComponents.filter((component) => {
    if (normalizedQuery.length === 0) {
      return true;
    }

    return [component.name, component.description ?? ""].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    );
  });

  return (
    <section
      data-mdcms-mdx-picker="catalog"
      className="rounded-md border border-border bg-card p-1.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]"
    >
      <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        Mdx components
      </div>

      {forbidden ? (
        <p
          data-mdcms-mdx-picker-state="forbidden"
          className="px-2 py-1 font-mono text-[11px] text-foreground-muted"
        >
          Component insertion is unavailable in read-only mode.
        </p>
      ) : null}

      {filteredComponents.length === 0 ? (
        <p
          data-mdcms-mdx-picker-state="filtered-empty"
          className="px-2 py-1 font-mono text-[11px] text-foreground-muted"
        >
          No components match the current filter.
        </p>
      ) : (
        <div ref={listRef} className="flex flex-col gap-0.5">
          {filteredComponents.map((component, index) => {
            const initial = (component.name[0] ?? "?").toUpperCase();
            const isHighlighted =
              highlightedIndex !== undefined
                ? highlightedIndex === index
                : index === 0;

            return (
              <button
                key={component.name}
                type="button"
                disabled={forbidden}
                data-mdcms-mdx-picker-item={component.name}
                data-mdcms-mdx-picker-item-index={index}
                data-mdcms-mdx-picker-item-active={
                  isHighlighted ? "true" : "false"
                }
                onMouseEnter={() => onHighlightedIndexChange?.(index)}
                onClick={() => {
                  if (!forbidden) {
                    onSelect(component);
                  }
                }}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-sm p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  isHighlighted
                    ? "bg-blue-100 text-foreground"
                    : "text-foreground hover:bg-accent-subtle",
                )}
              >
                <span
                  className={cn(
                    "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-sm font-mono text-[11px] font-bold",
                    isHighlighted
                      ? "bg-card text-primary"
                      : "bg-code-bg text-foreground-muted group-hover:bg-card group-hover:text-primary",
                  )}
                >
                  {initial}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {component.name}
                  </span>
                  {component.description ? (
                    <span className="block truncate font-mono text-[10px] text-foreground-muted">
                      {component.description}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
