"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentDocumentResponse } from "@mdcms/shared";
import { Check, ChevronsUpDown, X } from "lucide-react";

import type { StudioContentListApi } from "../../../content-list-api.js";
import { cn } from "../../lib/utils.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";

const SEARCH_DEBOUNCE_MS = 200;
const PRELOAD_LIMIT = 100;
const SERVER_SEARCH_LIMIT = 20;
const VISIBLE_LIMIT = 50;
const LABEL_FIELDS = ["name", "title", "label"] as const;

export type ReferenceOption = {
  documentId: string;
  label: string;
  path: string;
};

/**
 * Human-readable label for a referenced document: its `name`, `title` or
 * `label` frontmatter value, falling back to the file name of its path.
 */
export function toReferenceOption(
  document: Pick<
    ContentDocumentResponse,
    "documentId" | "path" | "frontmatter"
  >,
): ReferenceOption {
  const label =
    LABEL_FIELDS.map((field) => document.frontmatter[field]).find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ) ??
    document.path.split("/").pop() ??
    document.path;

  return { documentId: document.documentId, label, path: document.path };
}

/**
 * Options whose label or path contains `query` (case-insensitive), in their
 * original order. An empty query keeps every option.
 */
export function filterReferenceOptions(
  options: readonly ReferenceOption[],
  query: string,
): ReferenceOption[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [...options];
  }

  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.path.toLowerCase().includes(needle),
  );
}

type SearchState =
  | { status: "idle" | "loading" }
  | { status: "ready"; options: ReferenceOption[]; hasMore: boolean }
  | { status: "error"; message: string };

export type ReferenceFieldPickerProps = {
  inputId: string;
  value: string | undefined;
  targetType: string;
  canUnset: boolean;
  readOnly: boolean;
  contentListApi: StudioContentListApi | null;
  onChange: (documentId: string) => void;
  onUnset: () => void;
};

/**
 * Searchable picker for a `reference` field. Lists documents of the target
 * type (including unpublished drafts) and stores the chosen `documentId`.
 */
export function ReferenceFieldPicker({
  inputId,
  value,
  targetType,
  canUnset,
  readOnly,
  contentListApi,
  onChange,
  onUnset,
}: ReferenceFieldPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [knownOptions, setKnownOptions] = useState<
    Record<string, ReferenceOption>
  >({});
  const requestRef = useRef(0);

  const remember = (options: ReferenceOption[]) =>
    setKnownOptions((current) => {
      const next = { ...current };
      for (const option of options) next[option.documentId] = option;
      return next;
    });

  // Resolve the label of the current value once, so the closed picker shows
  // a name instead of a document id.
  useEffect(() => {
    if (!value || knownOptions[value] || !contentListApi) return;

    let cancelled = false;
    void contentListApi
      .list({ type: targetType, draft: true, limit: PRELOAD_LIMIT })
      .then((result) => {
        if (!cancelled) remember(result.data.map(toReferenceOption));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [contentListApi, knownOptions, targetType, value]);

  // Load the first documents of the target type when the picker opens; typed
  // text filters them locally.
  useEffect(() => {
    if (!open || !contentListApi) return;

    const requestId = ++requestRef.current;
    setSearch({ status: "loading" });
    void contentListApi
      .list({ type: targetType, draft: true, limit: PRELOAD_LIMIT })
      .then((result) => {
        if (requestId !== requestRef.current) return;
        const options = result.data.map(toReferenceOption);
        remember(options);
        setSearch({
          status: "ready",
          options,
          hasMore: result.pagination.hasMore,
        });
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        setSearch({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : `Could not load ${targetType} documents.`,
        });
      });
  }, [contentListApi, open, targetType]);

  // When there are more documents than were loaded, also ask the server's
  // search for the typed text and merge its matches.
  const [serverMatches, setServerMatches] = useState<ReferenceOption[]>([]);
  const canSearchServer =
    open &&
    search.status === "ready" &&
    search.hasMore &&
    Boolean(query.trim());

  useEffect(() => {
    if (!canSearchServer || !contentListApi) {
      setServerMatches([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void contentListApi
        .list({
          type: targetType,
          draft: true,
          limit: SERVER_SEARCH_LIMIT,
          q: query.trim(),
        })
        .then((result) => {
          if (cancelled) return;
          const options = result.data.map(toReferenceOption);
          remember(options);
          setServerMatches(options);
        })
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canSearchServer, contentListApi, query, targetType]);

  const selected = value ? knownOptions[value] : undefined;
  const triggerLabel = value
    ? (selected?.label ?? value)
    : `Select ${targetType}…`;
  const disabled = readOnly || contentListApi === null;

  const options = useMemo(() => {
    if (search.status !== "ready") return [];

    const local = filterReferenceOptions(search.options, query);
    const seen = new Set(local.map((option) => option.documentId));
    const merged = [
      ...local,
      ...serverMatches.filter((option) => !seen.has(option.documentId)),
    ];

    return merged.slice(0, VISIBLE_LIMIT);
  }, [query, search, serverMatches]);

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <div className="flex items-center gap-1.5">
        <PopoverTrigger asChild>
          <button
            id={inputId}
            type="button"
            disabled={disabled}
            data-mdcms-reference-picker={targetType}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              !value && "text-foreground-muted",
            )}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        {value && canUnset && !disabled ? (
          <button
            type="button"
            aria-label={`Clear ${targetType}`}
            className="rounded p-1 text-foreground-muted hover:text-foreground"
            onClick={onUnset}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          autoFocus
          value={query}
          placeholder={`Search ${targetType}…`}
          aria-label={`Search ${targetType}`}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div role="listbox" className="mt-2 max-h-64 overflow-y-auto">
          {search.status === "loading" ? (
            <p className="px-2 py-1.5 text-xs text-foreground-muted">
              Loading…
            </p>
          ) : null}
          {search.status === "error" ? (
            <p className="px-2 py-1.5 text-xs text-destructive">
              {search.message}
            </p>
          ) : null}
          {search.status === "ready" && options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-foreground-muted">
              {query.trim()
                ? `No ${targetType} matches "${query.trim()}".`
                : `No ${targetType} documents yet.`}
            </p>
          ) : null}
          {options.map((option) => (
            <button
              key={option.documentId}
              type="button"
              role="option"
              aria-selected={option.documentId === value}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onChange(option.documentId);
                setOpen(false);
                setQuery("");
              }}
            >
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                <span className="block truncate font-mono text-[10px] text-foreground-muted">
                  {option.path}
                </span>
              </span>
              {option.documentId === value ? (
                <Check className="h-3.5 w-3.5 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
