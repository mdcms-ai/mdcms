"use client";

import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from "@floating-ui/react-dom";
import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import type { StudioMountContext } from "@mdcms/shared";
import {
  EditorContent,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Fragment, Slice } from "@tiptap/pm/model";

import {
  Bold,
  ChevronsDownUp,
  ChevronsUpDown,
  Code,
  CornerDownLeft,
  ExternalLink,
  FileCode,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListTodo,
  ListOrdered,
  Minus,
  Puzzle,
  Quote,
  Redo,
  Strikethrough,
  Table2,
  Trash2,
  Underline as UnderlineIcon,
  Undo,
} from "lucide-react";
import { createEditorExtensions } from "../../../editor-extensions.js";
import {
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
  serializeDocumentToMarkdown,
} from "../../../markdown-pipeline.js";
import { MdxComponentExtension } from "../../../mdx-component-extension.js";
import { CodeBlockWithNodeView } from "./code-block-node-view.js";
import {
  MdxComponentCollapseProvider,
  useMdxComponentCollapseController,
} from "./mdx-component-collapse.js";
import { createEditorToolbarLayout } from "./editor-toolbar.js";
import { MdxComponentNodeView } from "./mdx-component-node-view.js";
import {
  createMdxComponentInsertContent,
  isMdxComponentVisibleInInsertUi,
} from "./mdx-component-catalog.js";
import { MdxComponentPicker } from "./mdx-component-picker.js";
import { type MdxPropsPanelSelection } from "./mdx-props-panel.js";
import {
  createPublishedMdxComponentSelectionSnapshot,
  hasPublishedMdxComponentSelectionChanged,
  type PublishedMdxComponentSelectionSnapshot,
} from "./mdx-component-panel-selection.js";
import {
  getSelectedMdxComponent,
  selectAdjacentMdxComponent,
  updateSelectedMdxComponentProps,
} from "./mdx-component-selection.js";
import {
  createSlashPickerVirtualReference,
  getMdxComponentSlashTrigger,
  getSlashTriggerCoords,
  replaceSlashTriggerWithMdxComponent,
  type MdxComponentSlashTrigger,
  type SlashTriggerCoords,
} from "./mdx-component-slash.js";
import { Button } from "../ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Separator } from "../ui/separator.js";
import { cn } from "../../lib/utils.js";

export interface TipTapEditorHandle {
  setContent: (markdown: string) => void;
  /**
   * Returns the markdown serialization of the document slice between
   * `from` and `to`, plus the mode the caller should use when
   * applying the AI's reply.
   *
   * - `mode: "markdown"` — the slice spans complete blocks
   *   (`openStart` and `openEnd` are 0). Block-level structure
   *   (lists, headings, paragraphs) is preserved by serializing the
   *   slice through the markdown pipeline. The replacement should be
   *   parsed as markdown and inserted as nodes.
   * - `mode: "text"` — the selection starts or ends mid-block, so
   *   it can't be expressed as standalone markdown without
   *   inventing parent structure. Returns plain text via
   *   `textBetween` and the replacement should be applied as plain
   *   text so the surrounding block structure (the parent list
   *   item, heading, etc.) is preserved by NOT being mutated.
   *
   * Returns `null` if the editor is unmounted or the range is
   * invalid.
   */
  getSelectionMarkdown: (input: { from: number; to: number }) => {
    text: string;
    mode: "markdown" | "text";
  } | null;
  /**
   * Replace a text range with the given replacement text and return
   * the resulting range + anchor rect. Used by the inline AI flow to
   * stage a proposal preview directly in the editor before the user
   * accepts or rejects it.
   *
   * Returns `null` if the editor is unmounted, the range is invalid,
   * or the document text at `[from, to)` no longer matches
   * `expectedText` (set when the caller wants to abort if the user
   * has typed in the meantime).
   */
  applyInlinePreview: (input: {
    from: number;
    to: number;
    replacementText: string;
    expectedText?: string;
    /**
     * Determines how the replacement is inserted:
     *
     * - `"markdown"` — `replacementText` is parsed via the markdown
     *   pipeline and inserted as block nodes. Used when the original
     *   selection spanned complete blocks.
     * - `"text"` — `replacementText` is inserted as inline plain
     *   text, so the surrounding block structure (lists, headings)
     *   is preserved.
     *
     * Defaults to `"text"` for safety — markdown parsing of a
     * mid-block range can spawn nested lists.
     */
    mode?: "markdown" | "text";
  }) => {
    previewFrom: number;
    previewTo: number;
    anchorRect: TipTapEditorAnchorRect;
    /**
     * Restores the original document slice (including block-level
     * structure such as bullet lists or headings) at the previewed
     * range. The slice was captured before the preview was applied,
     * so reverting recovers formatting — not just the plain text.
     * Returns `null` if the editor is unmounted.
     */
    revert: () => { anchorRect: TipTapEditorAnchorRect } | null;
  } | null;
}

export type TipTapEditorAnchorRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TipTapEditorSelectionInfo = {
  /** Stable id derived from the current selection range. */
  selectionId: string;
  /** Plain text inside the selection. */
  text: string;
  /**
   * AI-facing serialization of the same range. Whole-block selections
   * preserve markdown structure such as list markers; mid-block
   * selections remain plain text.
   */
  serializedText: string;
  /** How `serializedText` was produced and should be interpreted. */
  serializationMode: "markdown" | "text";
  /** ProseMirror document positions for the selection range. */
  from: number;
  to: number;
  /**
   * Viewport-relative rect for the selection's start/end coordinates.
   * Consumers can pass this to floating-ui (or use it directly) to
   * anchor a popover near the selection. `top` and `bottom` come from
   * `view.coordsAtPos(from)` and `view.coordsAtPos(to)` so multi-line
   * selections produce a rect that covers both ends.
   */
  anchorRect: TipTapEditorAnchorRect;
};

interface TipTapEditorProps {
  initialContent?: string;
  onChange?: (content: string) => void;
  placeholder?: string;
  context?: StudioMountContext;
  readOnly?: boolean;
  forbidden?: boolean;
  onActiveMdxComponentChange?: (
    selection: MdxPropsPanelSelection | null,
  ) => void;
  /**
   * Notifies callers when the user's plain-text selection changes.
   * Fires with `null` when the selection is empty or collapsed.
   * Used by the inline AI affordance to drive selection-anchored
   * transforms.
   */
  onSelectionTextChange?: (selection: TipTapEditorSelectionInfo | null) => void;
  /**
   * Renders ABOVE the editable surface inside the scrollable canvas area —
   * for the document path chip, frontmatter mono row, and any
   * status/error banners the page wants centered with the doc body.
   */
  canvasHeader?: ReactNode;
}

const defaultContent = `
# Hello World

This is a sample markdown document created in MDCMS Studio.

<Callout tone="warning">
This is **important** nested markdown content inside an MDX wrapper component.

- First point
- Second point
</Callout>

## Getting Started

Continue writing your content here...
`;

type ToolbarButtonProps = {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
};

type TipTapEditorInstance = NonNullable<ReturnType<typeof useEditor>>;

export type TipTapEditorSerializedSelection = {
  text: string;
  mode: "markdown" | "text";
};

const ZERO_ANCHOR_RECT: TipTapEditorAnchorRect = {
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
};

function rectForRange(
  editor: TipTapEditorInstance,
  from: number,
  to: number,
): TipTapEditorAnchorRect {
  try {
    const fromCoords = editor.view.coordsAtPos(from);
    const toCoords = editor.view.coordsAtPos(to);
    const top = Math.min(fromCoords.top, toCoords.top);
    const bottom = Math.max(fromCoords.bottom, toCoords.bottom);
    const left = Math.min(fromCoords.left, toCoords.left);
    const right = Math.max(fromCoords.right, toCoords.right);
    return {
      top,
      left,
      right,
      bottom,
      width: Math.max(right - left, 0),
      height: Math.max(bottom - top, 0),
    };
  } catch {
    return ZERO_ANCHOR_RECT;
  }
}

/**
 * Strip leading markdown block markers (`-`, `*`, `1.`, `>`, `#`)
 * from each line so a model that ignores the "plain text in/out"
 * instruction doesn't end up writing literal `- ` into a list item.
 * Multi-line text is collapsed onto single newlines that ProseMirror's
 * plain-text insert handles as soft breaks within the surrounding
 * block.
 *
 * Exported for testing.
 */
export function stripBlockMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*([-*+])\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*#{1,6}\s+/, ""),
    )
    .join("\n");
}

export function getSelectionMarkdownForAi(
  editor: TipTapEditorInstance,
  input: { from: number; to: number },
): TipTapEditorSerializedSelection | null {
  const docSize = editor.state.doc.content.size;
  if (input.from < 0 || input.to > docSize || input.from > input.to) {
    return null;
  }
  if (input.from === input.to) {
    return { text: "", mode: "text" };
  }

  // Decide markdown vs text by whether the cut is at a clean block
  // boundary, NOT by the slice's open depth. Whole-bullet selections
  // still have openStart/openEnd > 0 because the cuts are inside a
  // paragraph inside a listItem inside a bulletList, but parentOffset
  // alignment means markdown round-trips cleanly.
  const $from = editor.state.doc.resolve(input.from);
  const $to = editor.state.doc.resolve(input.to);
  const fromAtParentStart = $from.parentOffset === 0;
  const toAtParentEnd = $to.parentOffset === $to.parent.content.size;
  const isWholeBlockCut = fromAtParentStart && toAtParentEnd;

  if (!isWholeBlockCut) {
    return {
      text: editor.state.doc.textBetween(input.from, input.to, "\n", "\n"),
      mode: "text",
    };
  }

  const slice = editor.state.doc.slice(input.from, input.to, true);
  const fragmentJson = slice.content.toJSON() as
    | Array<Record<string, unknown>>
    | undefined;
  return {
    text: serializeDocumentToMarkdown({
      type: "doc",
      content: fragmentJson ?? [],
    }),
    mode: "markdown",
  };
}

function ToolbarButton({
  children,
  label,
  active = false,
  disabled = false,
  className,
  onClick,
}: ToolbarButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "h-[30px] w-[30px] rounded-sm border-0 px-0 font-mono text-[13px] text-foreground-muted hover:bg-accent-subtle hover:text-foreground",
        active &&
          "bg-blue-100 text-primary hover:bg-blue-100 hover:text-primary",
        className,
      )}
    >
      {children}
    </Button>
  );
}

export function createTipTapEditorDependencies(input: {
  placeholder: string;
  hostBridge: StudioMountContext["hostBridge"] | undefined;
  readOnly: boolean;
  forbidden: boolean;
}) {
  // The editor must survive parent rerenders so nested MDX child editing stays
  // in one TipTap document/autosave session. Callback identity is intentionally
  // excluded from the recreation key, but node views must still refresh when
  // the host bridge or editor access mode changes.
  return [input.placeholder, input.hostBridge, input.readOnly, input.forbidden];
}

export function resolveSlashPickerCoordsForEditor(input: {
  editor: {
    view: Parameters<typeof getSlashTriggerCoords>[0];
  };
  trigger: MdxComponentSlashTrigger;
  container: Parameters<typeof getSlashTriggerCoords>[2];
}): SlashTriggerCoords | null {
  try {
    return getSlashTriggerCoords(
      input.editor.view,
      input.trigger,
      input.container,
    );
  } catch {
    return null;
  }
}

export const TipTapEditor = forwardRef<TipTapEditorHandle, TipTapEditorProps>(
  function TipTapEditor(
    {
      initialContent = defaultContent,
      onChange,
      placeholder = "Start writing, or press / for commands...",
      context,
      readOnly = false,
      forbidden = false,
      onActiveMdxComponentChange,
      onSelectionTextChange,
      canvasHeader,
    },
    ref,
  ) {
    const toolbar = createEditorToolbarLayout();
    const catalogComponents = context?.mdx?.catalog.components ?? [];
    const insertableCatalogComponents = useMemo(
      () => catalogComponents.filter(isMdxComponentVisibleInInsertUi),
      [catalogComponents],
    );
    const isEditorReadOnly = readOnly || forbidden;
    const collapseController = useMdxComponentCollapseController();
    const [pickerSource, setPickerSource] = useState<
      "toolbar" | "slash" | null
    >(null);
    const [slashTrigger, setSlashTrigger] =
      useState<MdxComponentSlashTrigger | null>(null);
    const [slashPickerCoords, setSlashPickerCoords] =
      useState<SlashTriggerCoords | null>(null);
    const [slashHighlightIndex, setSlashHighlightIndex] = useState(0);
    const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
    const [linkInputValue, setLinkInputValue] = useState("");
    // While the user drags an MDX component handle, the browser's default
    // pointer behavior would let the cursor paint a text selection over
    // sibling block content as it sweeps across the editor. Track the drag
    // explicitly so we can pin `user-select: none` on the editor and run an
    // auto-scroll loop while the canvas pane is the scrollable ancestor.
    const [isMdxDragging, setIsMdxDragging] = useState(false);
    const editorWrapperRef = useRef<HTMLDivElement | null>(null);
    const pickerSourceRef = useRef(pickerSource);
    pickerSourceRef.current = pickerSource;
    const slashPickerOpen =
      pickerSource === "slash" &&
      slashTrigger !== null &&
      slashPickerCoords !== null;

    // Filter the MDX catalog by the current slash trigger query so the
    // picker, the highlight cursor, and the keyboard handler all walk the
    // exact same list. The filtering rule must match
    // MdxComponentPicker's internal filter so what the user sees is what
    // Enter inserts.
    const filteredSlashComponents = useMemo(() => {
      if (!slashTrigger) return insertableCatalogComponents;
      const normalizedQuery = slashTrigger.query.trim().toLowerCase();
      if (normalizedQuery.length === 0) return insertableCatalogComponents;
      return insertableCatalogComponents.filter((component) =>
        [component.name, component.description ?? ""].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
      );
    }, [insertableCatalogComponents, slashTrigger]);

    // Refs so the editor's prosemirror handleKeyDown — which is captured
    // once when the editor is created — can read the latest filtered list,
    // highlighted index, and picker visibility flags without a stale
    // closure on each keystroke.
    const filteredSlashComponentsRef = useRef(filteredSlashComponents);
    filteredSlashComponentsRef.current = filteredSlashComponents;
    const slashHighlightIndexRef = useRef(slashHighlightIndex);
    slashHighlightIndexRef.current = slashHighlightIndex;
    const slashTriggerRef = useRef(slashTrigger);
    slashTriggerRef.current = slashTrigger;
    const slashPickerCoordsRef = useRef(slashPickerCoords);
    slashPickerCoordsRef.current = slashPickerCoords;
    const insertSelectedComponentRef = useRef<
      ((component: (typeof catalogComponents)[number]) => void) | null
    >(null);

    // Reset / clamp the highlight when the filtered list changes (the user
    // typed more characters and items dropped out, or the list emptied).
    useEffect(() => {
      if (!slashPickerOpen) return;
      setSlashHighlightIndex((current) => {
        if (filteredSlashComponents.length === 0) return 0;
        if (current >= filteredSlashComponents.length) {
          return filteredSlashComponents.length - 1;
        }
        return current;
      });
    }, [filteredSlashComponents, slashPickerOpen]);

    // Reset to 0 each time the picker opens fresh.
    useEffect(() => {
      if (!slashPickerOpen) {
        setSlashHighlightIndex(0);
      }
    }, [slashPickerOpen]);
    const {
      refs: floatingRefs,
      floatingStyles,
      update: updateFloating,
    } = useFloating({
      open: slashPickerOpen,
      placement: "bottom-start",
      strategy: "fixed",
      whileElementsMounted: autoUpdate,
      middleware: [
        offset(8),
        flip({
          padding: 12,
          boundary:
            editorWrapperRef.current?.closest(
              '[data-mdcms-editor-pane="canvas"]',
            ) ?? undefined,
        }),
        shift({
          padding: 12,
          boundary:
            editorWrapperRef.current?.closest(
              '[data-mdcms-editor-pane="canvas"]',
            ) ?? undefined,
        }),
        size({
          padding: 12,
          boundary:
            editorWrapperRef.current?.closest(
              '[data-mdcms-editor-pane="canvas"]',
            ) ?? undefined,
          apply({ availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              maxHeight: `${Math.max(availableHeight, 0)}px`,
            });
          },
        }),
      ],
    });
    const lastPublishedSelectionRef =
      useRef<PublishedMdxComponentSelectionSnapshot | null>(null);
    const lastEmittedMarkdownRef = useRef<string | null>(null);
    // Serializing the whole doc to markdown on every keystroke was heavy
    // enough to make the caret visibly lag during fast typing. Keep an
    // immediate emitter for single-shot user actions (prop edits, component
    // inserts) and a scheduled variant for the high-frequency `onUpdate`
    // path that only serializes after typing pauses.
    const markdownEmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const emitMarkdownNow = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        if (markdownEmitTimerRef.current !== null) {
          clearTimeout(markdownEmitTimerRef.current);
          markdownEmitTimerRef.current = null;
        }

        const nextMarkdown = extractMarkdownFromEditor(nextEditor);

        if (nextMarkdown === lastEmittedMarkdownRef.current) {
          return;
        }

        lastEmittedMarkdownRef.current = nextMarkdown;
        onChange?.(nextMarkdown);
      },
    );
    const handleEditorUpdate = emitMarkdownNow;
    const scheduleMarkdownEmission = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        if (markdownEmitTimerRef.current !== null) {
          clearTimeout(markdownEmitTimerRef.current);
        }

        markdownEmitTimerRef.current = setTimeout(() => {
          markdownEmitTimerRef.current = null;
          emitMarkdownNow(nextEditor);
        }, 150);
      },
    );
    useEffect(
      () => () => {
        if (markdownEmitTimerRef.current !== null) {
          clearTimeout(markdownEmitTimerRef.current);
          markdownEmitTimerRef.current = null;
        }
      },
      [],
    );

    // The props-panel publisher is allowed to lag the caret by a frame —
    // it only drives a side-panel update, never the editor's own DOM —
    // so defer it off the keystroke's critical path.
    const auxSelectionFrameRef = useRef<number | null>(null);
    const lastPublishedTextSelectionRef = useRef<string | null>(null);
    const publishTextSelection = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        if (!onSelectionTextChange) {
          return;
        }

        const { from, to, empty } = nextEditor.state.selection;

        if (empty || from === to) {
          if (lastPublishedTextSelectionRef.current !== null) {
            lastPublishedTextSelectionRef.current = null;
            onSelectionTextChange(null);
          }
          return;
        }

        const text = nextEditor.state.doc.textBetween(from, to, "\n", "\n");
        const serializedSelection = getSelectionMarkdownForAi(nextEditor, {
          from,
          to,
        }) ?? { text, mode: "text" as const };

        if (text.trim().length === 0) {
          if (lastPublishedTextSelectionRef.current !== null) {
            lastPublishedTextSelectionRef.current = null;
            onSelectionTextChange(null);
          }
          return;
        }

        // ProseMirror's coordsAtPos throws if positions slip during a
        // transaction; rectForRange catches that and returns a zero
        // rect, and the consumer repositions on the next tick.
        const anchorRect = rectForRange(nextEditor, from, to);

        // The selection id is derived from the range bounds + text so a
        // moved-but-identical selection still re-uses the same id and
        // the AI proposal stays anchored across `Try again` calls.
        const selectionId = `sel:${from}-${to}`;
        const fingerprint = `${selectionId}::${text}::${serializedSelection.text}::${anchorRect.top}::${anchorRect.left}::${anchorRect.bottom}::${anchorRect.right}`;

        if (lastPublishedTextSelectionRef.current === fingerprint) {
          return;
        }

        lastPublishedTextSelectionRef.current = fingerprint;
        onSelectionTextChange({
          selectionId,
          text,
          serializedText: serializedSelection.text,
          serializationMode: serializedSelection.mode,
          from,
          to,
          anchorRect,
        });
      },
    );
    const scheduleAuxSelectionUpdate = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        if (auxSelectionFrameRef.current !== null) {
          cancelAnimationFrame(auxSelectionFrameRef.current);
        }
        auxSelectionFrameRef.current = requestAnimationFrame(() => {
          auxSelectionFrameRef.current = null;
          publishSelectedMdxComponent(nextEditor);
          publishTextSelection(nextEditor);
        });
      },
    );
    useEffect(
      () => () => {
        if (auxSelectionFrameRef.current !== null) {
          cancelAnimationFrame(auxSelectionFrameRef.current);
          auxSelectionFrameRef.current = null;
        }
      },
      [],
    );
    const syncSlashTrigger = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        const nextTrigger = getMdxComponentSlashTrigger(nextEditor);

        setSlashTrigger(nextTrigger);
        setPickerSource((currentSource) => {
          if (currentSource === "toolbar") {
            return currentSource;
          }

          if (nextTrigger) {
            return "slash";
          }

          return currentSource === "slash" ? null : currentSource;
        });

        if (nextTrigger && editorWrapperRef.current) {
          setSlashPickerCoords(
            resolveSlashPickerCoordsForEditor({
              editor: nextEditor,
              trigger: nextTrigger,
              container: editorWrapperRef.current,
            }),
          );
        } else {
          setSlashPickerCoords(null);
        }
      },
    );
    const publishSelectedMdxComponent = useEffectEvent(
      (nextEditor: TipTapEditorInstance) => {
        if (!onActiveMdxComponentChange) {
          lastPublishedSelectionRef.current = null;
          return;
        }

        const selected = getSelectedMdxComponent(nextEditor, catalogComponents);

        if (!selected) {
          if (lastPublishedSelectionRef.current === null) {
            return;
          }

          lastPublishedSelectionRef.current = null;
          onActiveMdxComponentChange(null);
          return;
        }

        const nextSnapshot = createPublishedMdxComponentSelectionSnapshot({
          selected,
          readOnly,
          forbidden,
        });

        if (
          !hasPublishedMdxComponentSelectionChanged(
            lastPublishedSelectionRef.current,
            nextSnapshot,
          )
        ) {
          return;
        }

        lastPublishedSelectionRef.current = nextSnapshot;

        onActiveMdxComponentChange({
          ...selected,
          readOnly,
          forbidden,
          onPropsChange: (patch) => {
            if (
              updateSelectedMdxComponentProps(
                nextEditor,
                catalogComponents,
                patch,
                {
                  readOnly,
                  forbidden,
                },
              )
            ) {
              publishSelectedMdxComponent(nextEditor);
              handleEditorUpdate(nextEditor);
            }
          },
        });
      },
    );
    const editor = useEditor(
      {
        content: initialContent,
        contentType: "markdown",
        editable: !isEditorReadOnly,
        immediatelyRender: false,
        // Leaving `shouldRerenderOnTransaction` at its default (`false`) is
        // essential: every keystroke dispatches a ProseMirror transaction, and
        // re-rendering the whole React tree on each one caused the caret to
        // lag behind during fast typing (especially Shift+Enter spam). The
        // toolbar stays reactive via `useEditorState` below, which subscribes
        // only to the handful of mark/node-active flags it actually reads.
        extensions: createEditorExtensions({
          codeBlock: CodeBlockWithNodeView,
          mdxComponent: MdxComponentExtension.extend({
            addNodeView() {
              const NodeView = (props: ReactNodeViewProps) => (
                <MdxComponentNodeView
                  {...props}
                  context={context}
                  readOnly={readOnly}
                  forbidden={forbidden}
                />
              );

              return ReactNodeViewRenderer(NodeView);
            },
          }),
        }),
        editorProps: {
          attributes: {
            // Padding lives on `.ProseMirror` itself rather than the outer
            // wrapper so the entire visible editor surface — including the
            // gutter above the first block and below the last — emits
            // dragover events that prosemirror-dropcursor binds to. Without
            // this, the cursor near the document edges falls in wrapper
            // dead space and the drop indicator (and the drop itself)
            // silently no-ops, so users dragging an MDX block to the very
            // top of the document saw nothing happen.
            // Padding is supplied by the canvas wrapper (`max-w-[880px]
            // px-6 lg:px-12 ...`) so the dashed frontmatter row above the
            // editor body and the body itself land on the same horizontal
            // edges. Vertical padding stays here so the gutter above the
            // first block and below the last keeps emitting dragover
            // events for prosemirror-dropcursor.
            class:
              "prose max-w-none prose-p:leading-relaxed focus:outline-none py-4 min-h-[400px]",
            "data-placeholder": placeholder,
          },
          handleKeyDown: (_view, event) => {
            // The slash picker is only "visible" when the source flag, the
            // active trigger, and the resolved float coords are all set. A
            // stale `pickerSource === "slash"` between the close-flow's
            // batched setStates is not enough to claim keystrokes.
            const slashPickerVisible =
              pickerSourceRef.current === "slash" &&
              slashTriggerRef.current !== null &&
              slashPickerCoordsRef.current !== null;
            if (slashPickerVisible) {
              if (event.key === "Escape") {
                setPickerSource(null);
                setSlashTrigger(null);
                setSlashPickerCoords(null);
                return true;
              }
              const items = filteredSlashComponentsRef.current;
              if (event.key === "ArrowDown") {
                if (items.length === 0) return false;
                setSlashHighlightIndex(
                  (slashHighlightIndexRef.current + 1) % items.length,
                );
                return true;
              }
              if (event.key === "ArrowUp") {
                if (items.length === 0) return false;
                setSlashHighlightIndex(
                  (slashHighlightIndexRef.current - 1 + items.length) %
                    items.length,
                );
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                if (items.length === 0) return false;
                const item = items[slashHighlightIndexRef.current];
                if (!item || !insertSelectedComponentRef.current) return false;
                insertSelectedComponentRef.current(item);
                return true;
              }
            }
            return false;
          },
        },
        onUpdate({ editor }) {
          // Typing/deleting always moves the caret, so `onSelectionUpdate`
          // already fires for the same transaction. Running the aux updates
          // here too just doubles the per-keystroke sync work. Markdown
          // emission is the only thing unique to content changes.
          scheduleMarkdownEmission(editor);
        },
        onSelectionUpdate({ editor }) {
          syncSlashTrigger(editor);
          scheduleAuxSelectionUpdate(editor);
        },
        onBlur({ editor }) {
          // Blur is typically the user switching away to save or navigate —
          // flush any pending debounced markdown emission now so the host app
          // sees the latest content immediately.
          emitMarkdownNow(editor);
        },
      },
      createTipTapEditorDependencies({
        placeholder,
        hostBridge: context?.hostBridge,
        readOnly,
        forbidden,
      }),
    );

    // Seed the emitted markdown ref once the editor initializes so the
    // first focus/click does not produce a spurious onChange.
    useEffect(() => {
      if (!editor) {
        return;
      }

      if (lastEmittedMarkdownRef.current === null) {
        lastEmittedMarkdownRef.current = extractMarkdownFromEditor(editor);
      }
    }, [editor]);

    // Imperative content setter — callers use ref.current.setContent()
    // instead of changing a content prop. This avoids the flushSync
    // lifecycle conflict entirely because setContent runs from event
    // handlers, not from effects.
    useImperativeHandle(
      ref,
      () => ({
        setContent(markdown: string) {
          if (!editor || editor.isDestroyed) {
            return;
          }

          const currentMarkdown = extractMarkdownFromEditor(editor);

          if (currentMarkdown === markdown) {
            lastEmittedMarkdownRef.current = currentMarkdown;
            return;
          }

          // Any pending debounced emission from prior typing would fire with
          // stale content relative to the doc we're about to load — drop it.
          if (markdownEmitTimerRef.current !== null) {
            clearTimeout(markdownEmitTimerRef.current);
            markdownEmitTimerRef.current = null;
          }

          // Suppress onUpdate so programmatic syncs (version preview,
          // back-to-draft, post-save rehydration) don't trigger onChange
          // and accidentally mark the draft as unsaved / arm autosave.
          editor.commands.setContent(markdown, {
            contentType: "markdown",
            emitUpdate: false,
          });
          lastEmittedMarkdownRef.current = extractMarkdownFromEditor(editor);

          // Refresh derived UI state that onUpdate would normally handle,
          // since we suppressed the update event above.
          publishSelectedMdxComponent(editor);
          syncSlashTrigger(editor);
        },
        getSelectionMarkdown(input) {
          if (!editor || editor.isDestroyed) {
            return null;
          }
          return getSelectionMarkdownForAi(editor, input);
        },
        applyInlinePreview(input) {
          if (!editor || editor.isDestroyed) {
            return null;
          }

          const docSize = editor.state.doc.content.size;

          if (input.from < 0 || input.to > docSize || input.from >= input.to) {
            return null;
          }

          // Bail when the user has typed in the previewed range since
          // the AI request started. The caller can fall back to
          // showing the proposal in the popover instead.
          if (typeof input.expectedText === "string") {
            const live = editor.state.doc.textBetween(
              input.from,
              input.to,
              "\n",
              "\n",
            );
            if (live !== input.expectedText) {
              return null;
            }
          }

          // Capture the original ProseMirror slice (with block-level
          // structure intact: bullet items, headings, paragraphs)
          // BEFORE we mutate the document. On reject we replace the
          // previewed range with this slice so formatting comes back,
          // not just the plain text.
          const originalSlice = editor.state.doc.slice(
            input.from,
            input.to,
            true,
          );

          const previewFrom = input.from;
          const sizeBefore = editor.state.doc.content.size;
          const mode = input.mode ?? "text";

          if (mode === "markdown") {
            // Parse the AI's reply via the same markdown pipeline the
            // editor uses, then build a ProseMirror Slice whose open
            // depths MATCH the original cut. tr.replace fits the slice
            // into the same structural context — so a whole-bullet
            // selection's replacement splices listItems into the
            // existing list instead of nesting a new bulletList inside
            // it (the symptom that merged two bullets into one).
            const parsedDoc = parseMarkdownToDocument(input.replacementText);
            const parsedFragment = Fragment.fromJSON(
              editor.schema,
              (parsedDoc.content ?? []) as Array<Record<string, unknown>>,
            );
            const newSlice = new Slice(
              parsedFragment,
              originalSlice.openStart,
              originalSlice.openEnd,
            );
            const tr = editor.state.tr.replace(input.from, input.to, newSlice);
            editor.view.dispatch(tr);
            editor.commands.focus();
          } else {
            // Plain-text mode — insert as inline content so the
            // surrounding block structure (the parent list item,
            // heading, paragraph) is preserved. We strip any leading
            // markdown block markers the model may have added back so
            // they don't end up as literal text in a list item.
            const sanitized = stripBlockMarkers(input.replacementText);
            editor
              .chain()
              .focus()
              .insertContentAt({ from: input.from, to: input.to }, sanitized)
              .run();
          }

          const sizeAfter = editor.state.doc.content.size;
          // Replaced range was (input.to - input.from); the inserted
          // content's contribution is sizeAfter - sizeBefore + (input.to - input.from).
          const previewTo =
            input.from + (sizeAfter - sizeBefore) + (input.to - input.from);

          editor
            .chain()
            .focus()
            .setTextSelection({ from: previewFrom, to: previewTo })
            .run();

          const revert = () => {
            if (!editor || editor.isDestroyed) {
              return null;
            }
            const liveDocSize = editor.state.doc.content.size;
            if (previewFrom < 0 || previewTo > liveDocSize) {
              return null;
            }
            const tr = editor.state.tr.replace(
              previewFrom,
              previewTo,
              originalSlice,
            );
            // The slice may carry open node boundaries (e.g. when the
            // selection started mid-list-item), so the resulting
            // document size depends on what the slice contributes.
            // Compute the restored end from the resulting mapping.
            const restoredTo = tr.mapping.map(previewTo);
            editor.view.dispatch(tr);
            editor
              .chain()
              .focus()
              .setTextSelection({ from: previewFrom, to: restoredTo })
              .run();
            return {
              anchorRect: rectForRange(editor, previewFrom, restoredTo),
            };
          };

          return {
            previewFrom,
            previewTo,
            anchorRect: rectForRange(editor, previewFrom, previewTo),
            revert,
          };
        },
      }),
      [editor],
    );

    useEffect(() => {
      if (!editor) {
        return;
      }

      editor.setEditable(!isEditorReadOnly);
      publishSelectedMdxComponent(editor);
      syncSlashTrigger(editor);
    }, [catalogComponents, editor, forbidden, isEditorReadOnly, readOnly]);

    // Drag lifecycle for MDX component handles. Listening at the wrapper
    // catches dragstart only when it originates from a `[data-drag-handle]`
    // inside an MDX node view (Tiptap routes pointer-down on the handle into
    // a ProseMirror node drag). dragend / drop are listened on the document
    // because the events fire wherever the pointer lands, which can be
    // outside the editor wrapper for cancelled drags.
    useEffect(() => {
      const wrapper = editorWrapperRef.current;
      if (!wrapper) {
        return;
      }

      const onDragStart = (event: DragEvent) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest("[data-drag-handle]")) {
          return;
        }
        setIsMdxDragging(true);
      };

      const stopDragging = () => setIsMdxDragging(false);

      wrapper.addEventListener("dragstart", onDragStart);
      document.addEventListener("dragend", stopDragging);
      document.addEventListener("drop", stopDragging);

      return () => {
        wrapper.removeEventListener("dragstart", onDragStart);
        document.removeEventListener("dragend", stopDragging);
        document.removeEventListener("drop", stopDragging);
      };
    }, []);

    // Auto-scroll the canvas pane while a drag is in flight so the user can
    // reorder past the visible viewport. The scroll target is the nearest
    // `[data-mdcms-editor-pane="canvas"]` ancestor; if there is none (e.g.
    // tests, embedded preview) the effect no-ops. dragover fires
    // continuously while the pointer moves, so we record the latest Y and
    // let a rAF loop convert proximity-to-edge into scroll velocity.
    useEffect(() => {
      if (!isMdxDragging) {
        return;
      }

      const wrapper = editorWrapperRef.current;
      if (!wrapper) {
        return;
      }

      const scrollContainer = wrapper.closest(
        '[data-mdcms-editor-pane="canvas"]',
      ) as HTMLElement | null;

      if (!scrollContainer) {
        return;
      }

      const SCROLL_ZONE_PX = 72;
      const MAX_SCROLL_PER_FRAME = 18;
      let pointerY: number | null = null;
      let rafId: number | null = null;

      const onDragOver = (event: DragEvent) => {
        pointerY = event.clientY;
      };

      const tick = () => {
        if (pointerY !== null) {
          const rect = scrollContainer.getBoundingClientRect();
          const distanceFromTop = pointerY - rect.top;
          const distanceFromBottom = rect.bottom - pointerY;

          if (distanceFromTop >= 0 && distanceFromTop < SCROLL_ZONE_PX) {
            const speed =
              MAX_SCROLL_PER_FRAME * (1 - distanceFromTop / SCROLL_ZONE_PX);
            scrollContainer.scrollTop -= speed;
          } else if (
            distanceFromBottom >= 0 &&
            distanceFromBottom < SCROLL_ZONE_PX
          ) {
            const speed =
              MAX_SCROLL_PER_FRAME * (1 - distanceFromBottom / SCROLL_ZONE_PX);
            scrollContainer.scrollTop += speed;
          }
        }
        rafId = requestAnimationFrame(tick);
      };

      document.addEventListener("dragover", onDragOver);
      rafId = requestAnimationFrame(tick);

      return () => {
        document.removeEventListener("dragover", onDragOver);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [isMdxDragging]);

    useEffect(() => {
      if (!slashPickerOpen || !slashPickerCoords || !editor || !slashTrigger) {
        floatingRefs.setReference(null);
        return;
      }

      const editorWrapper = editorWrapperRef.current;

      if (!editorWrapper) {
        floatingRefs.setReference(null);
        return;
      }

      const contextElement = editorWrapper;

      floatingRefs.setReference(
        createSlashPickerVirtualReference({
          getAnchor: () =>
            resolveSlashPickerCoordsForEditor({
              editor,
              trigger: slashTrigger,
              container: editorWrapper,
            }) ?? slashPickerCoords,
          contextElement,
        }) as never,
      );
      updateFloating();
    }, [
      editor,
      floatingRefs,
      slashPickerCoords,
      slashPickerOpen,
      slashTrigger,
      updateFloating,
    ]);

    const toolbarActive = useEditorState({
      editor,
      selector: ({ editor: ed }) => {
        if (!ed) {
          return {
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            code: false,
            highlight: false,
            heading1: false,
            heading2: false,
            bulletList: false,
            orderedList: false,
            taskList: false,
            blockquote: false,
            codeBlock: false,
            link: false,
          };
        }
        return {
          bold: ed.isActive("bold"),
          italic: ed.isActive("italic"),
          underline: ed.isActive("underline"),
          strike: ed.isActive("strike"),
          code: ed.isActive("code"),
          highlight: ed.isActive("highlight"),
          heading1: ed.isActive("heading", { level: 1 }),
          heading2: ed.isActive("heading", { level: 2 }),
          bulletList: ed.isActive("bulletList"),
          orderedList: ed.isActive("orderedList"),
          taskList: ed.isActive("taskList"),
          blockquote: ed.isActive("blockquote"),
          codeBlock: ed.isActive("codeBlock"),
          link: ed.isActive("link"),
        };
      },
    });

    const run = (command: () => boolean) => {
      command();
    };

    const iconClassName = "size-4";

    const resolveToolbarIcon = (itemId: string) => {
      switch (itemId) {
        case "undo":
          return <Undo className={iconClassName} />;
        case "redo":
          return <Redo className={iconClassName} />;
        case "bold":
          return <Bold className={iconClassName} />;
        case "italic":
          return <Italic className={iconClassName} />;
        case "underline":
          return <UnderlineIcon className={iconClassName} />;
        case "strike":
          return <Strikethrough className={iconClassName} />;
        case "code":
          return <Code className={iconClassName} />;
        case "highlight":
          return <Highlighter className={iconClassName} />;
        case "heading1":
          return <span className="text-sm font-semibold">H1</span>;
        case "heading2":
          return <span className="text-sm font-semibold">H2</span>;
        case "bulletList":
          return <List className={iconClassName} />;
        case "orderedList":
          return <ListOrdered className={iconClassName} />;
        case "taskList":
          return <ListTodo className={iconClassName} />;
        case "blockquote":
          return <Quote className={iconClassName} />;
        case "codeBlock":
          return <FileCode className={iconClassName} />;
        case "horizontalRule":
          return <Minus className={iconClassName} />;
        case "image":
          return <ImageIcon className={iconClassName} />;
        case "link":
          return <LinkIcon className={iconClassName} />;
        case "table":
          return <Table2 className={iconClassName} />;
        case "insertComponent":
          return (
            <>
              <Puzzle className={iconClassName} />
              <span>Insert Component</span>
            </>
          );
        default:
          return null;
      }
    };

    const triggerToolbarItem = (itemId: string) => {
      switch (itemId) {
        case "undo":
          return run(() => editor?.chain().focus().undo().run() ?? false);
        case "redo":
          return run(() => editor?.chain().focus().redo().run() ?? false);
        case "bold":
          return run(() => editor?.chain().focus().toggleBold().run() ?? false);
        case "italic":
          return run(
            () => editor?.chain().focus().toggleItalic().run() ?? false,
          );
        case "underline":
          return run(
            () => editor?.chain().focus().toggleUnderline().run() ?? false,
          );
        case "strike":
          return run(
            () => editor?.chain().focus().toggleStrike().run() ?? false,
          );
        case "code":
          return run(() => editor?.chain().focus().toggleCode().run() ?? false);
        case "highlight":
          return run(
            () => editor?.chain().focus().toggleHighlight().run() ?? false,
          );
        case "heading1":
          return run(
            () =>
              editor?.chain().focus().toggleHeading({ level: 1 }).run() ??
              false,
          );
        case "heading2":
          return run(
            () =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run() ??
              false,
          );
        case "bulletList":
          return run(
            () => editor?.chain().focus().toggleBulletList().run() ?? false,
          );
        case "orderedList":
          return run(
            () => editor?.chain().focus().toggleOrderedList().run() ?? false,
          );
        case "taskList":
          return run(
            () => editor?.chain().focus().toggleTaskList().run() ?? false,
          );
        case "blockquote":
          return run(
            () => editor?.chain().focus().toggleBlockquote().run() ?? false,
          );
        case "codeBlock":
          return run(
            () => editor?.chain().focus().toggleCodeBlock().run() ?? false,
          );
        case "horizontalRule":
          return run(
            () => editor?.chain().focus().setHorizontalRule().run() ?? false,
          );
        case "link": {
          if (!editor) return;
          const existingHref = editor.getAttributes("link").href as
            | string
            | undefined;
          setLinkInputValue(existingHref ?? "");
          setLinkPopoverOpen(true);
          return;
        }
        case "insertComponent":
          setPickerSource((currentSource) =>
            currentSource === "toolbar" ? null : "toolbar",
          );
          return;
        default:
          return;
      }
    };

    const isToolbarItemActive = (itemId: string) => {
      if (!toolbarActive) return false;
      switch (itemId) {
        case "bold":
          return toolbarActive.bold;
        case "italic":
          return toolbarActive.italic;
        case "underline":
          return toolbarActive.underline;
        case "strike":
          return toolbarActive.strike;
        case "code":
          return toolbarActive.code;
        case "highlight":
          return toolbarActive.highlight;
        case "heading1":
          return toolbarActive.heading1;
        case "heading2":
          return toolbarActive.heading2;
        case "bulletList":
          return toolbarActive.bulletList;
        case "orderedList":
          return toolbarActive.orderedList;
        case "taskList":
          return toolbarActive.taskList;
        case "blockquote":
          return toolbarActive.blockquote;
        case "codeBlock":
          return toolbarActive.codeBlock;
        case "link":
          return toolbarActive.link;
        default:
          return false;
      }
    };

    const submitLink = () => {
      if (!editor) return;
      const url = linkInputValue.trim();
      if (url) {
        editor.chain().focus().setLink({ href: url }).run();
      }
      setLinkPopoverOpen(false);
      setLinkInputValue("");
    };

    const removeLink = () => {
      if (!editor) return;
      editor.chain().focus().unsetLink().run();
      setLinkPopoverOpen(false);
      setLinkInputValue("");
    };

    const openLink = () => {
      const url = linkInputValue.trim();
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    };

    const insertSelectedComponent = (
      component: (typeof catalogComponents)[number],
    ) => {
      if (!editor) {
        return;
      }

      const didInsert =
        pickerSource === "slash" && slashTrigger
          ? replaceSlashTriggerWithMdxComponent(editor, slashTrigger, component)
          : editor.commands.insertContent(
              createMdxComponentInsertContent(component),
            );

      if (!didInsert) {
        return;
      }

      if (!getSelectedMdxComponent(editor, catalogComponents)) {
        selectAdjacentMdxComponent(editor);
      }

      setSlashTrigger(null);
      setSlashPickerCoords(null);
      setPickerSource(null);
      publishSelectedMdxComponent(editor);
      handleEditorUpdate(editor);
      syncSlashTrigger(editor);
    };
    // Keep the ref in sync so the editor's prosemirror handleKeyDown — which
    // closes over the FIRST insertSelectedComponent — can always invoke the
    // freshest version on Enter while the slash picker is open.
    insertSelectedComponentRef.current = insertSelectedComponent;

    const slashPicker = slashPickerOpen ? (
      <div
        ref={floatingRefs.setFloating}
        data-mdcms-mdx-picker-source="slash"
        style={{
          ...floatingStyles,
          width: "min(28rem, calc(100vw - 24px))",
          maxHeight: "calc(100vh - 24px)",
        }}
        className="z-50 overflow-y-auto"
      >
        <MdxComponentPicker
          components={insertableCatalogComponents}
          query={slashTrigger.query}
          forbidden={isEditorReadOnly}
          onSelect={insertSelectedComponent}
          highlightedIndex={slashHighlightIndex}
          onHighlightedIndexChange={setSlashHighlightIndex}
        />
      </div>
    ) : null;

    return (
      <div
        ref={editorWrapperRef}
        // While a drag is in flight, pin selection off across the editor and
        // its descendants so the pointer doesn't paint a text selection over
        // sibling block content as it sweeps over them. `pointer-events`
        // stays on so dragover continues to fire and auto-scroll works.
        // The wrapper takes the full height of the canvas pane so the
        // toolbar can sit fixed at the top and the editor body can scroll
        // independently below it.
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          isMdxDragging && "select-none [&_*]:select-none",
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="shrink-0 border-b border-border bg-card">
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-6 py-2">
              {toolbar.primaryGroups.map((group, groupIndex) => (
                <div key={group.id} className="flex items-center gap-1.5">
                  {groupIndex > 0 ? (
                    <Separator orientation="vertical" className="mr-1 h-6" />
                  ) : null}
                  {group.items.map((item) => {
                    const handleItemClick = () => {
                      if (
                        item.availability === "enabled" &&
                        !isEditorReadOnly
                      ) {
                        triggerToolbarItem(item.id);
                      }
                    };
                    const toolbarButton = (
                      <ToolbarButton
                        disabled={
                          item.availability !== "enabled" || isEditorReadOnly
                        }
                        label={
                          item.availability === "visual-only"
                            ? `${item.label} (planned)`
                            : isEditorReadOnly
                              ? `${item.label} (unavailable in read-only mode)`
                              : item.label
                        }
                        active={isToolbarItemActive(item.id)}
                        onClick={handleItemClick}
                        className={cn(
                          item.id === "heading1" || item.id === "heading2"
                            ? "min-w-10 px-3"
                            : "w-8 px-0",
                          item.availability === "visual-only" &&
                            "text-foreground-muted",
                        )}
                      >
                        {resolveToolbarIcon(item.id)}
                      </ToolbarButton>
                    );

                    if (item.id === "link") {
                      return (
                        <Popover
                          key={item.id}
                          open={linkPopoverOpen}
                          onOpenChange={(open) => {
                            setLinkPopoverOpen(open);
                            if (!open) setLinkInputValue("");
                          }}
                        >
                          <PopoverTrigger
                            asChild
                            onClick={(e) => {
                              if (
                                item.availability === "enabled" &&
                                !isEditorReadOnly
                              ) {
                                e.preventDefault();
                                triggerToolbarItem(item.id);
                              }
                            }}
                          >
                            <div>{toolbarButton}</div>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-auto p-1.5"
                            side="bottom"
                            align="start"
                            onOpenAutoFocus={(e) => e.preventDefault()}
                          >
                            <div className="flex items-center gap-1">
                              <input
                                type="url"
                                value={linkInputValue}
                                onChange={(e) =>
                                  setLinkInputValue(e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    submitLink();
                                  }
                                  if (e.key === "Escape") {
                                    setLinkPopoverOpen(false);
                                    setLinkInputValue("");
                                  }
                                }}
                                placeholder="Paste a link..."
                                className="h-7 w-48 rounded border-none bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
                              />
                              <Separator
                                orientation="vertical"
                                className="mx-0.5 h-5"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0"
                                title="Apply link"
                                onClick={submitLink}
                              >
                                <CornerDownLeft className="size-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0"
                                title="Open link in new tab"
                                disabled={!linkInputValue.trim()}
                                onClick={openLink}
                              >
                                <ExternalLink className="size-3.5" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="size-7 p-0"
                                title="Remove link"
                                onClick={removeLink}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
                      );
                    }

                    return (
                      <ToolbarButton
                        key={item.id}
                        disabled={
                          item.availability !== "enabled" || isEditorReadOnly
                        }
                        label={
                          item.availability === "visual-only"
                            ? `${item.label} (planned)`
                            : isEditorReadOnly
                              ? `${item.label} (unavailable in read-only mode)`
                              : item.label
                        }
                        active={isToolbarItemActive(item.id)}
                        onClick={handleItemClick}
                        className={cn(
                          item.id === "heading1" || item.id === "heading2"
                            ? "min-w-10 px-3"
                            : "w-8 px-0",
                          item.availability === "visual-only" &&
                            "text-foreground-muted",
                        )}
                      >
                        {resolveToolbarIcon(item.id)}
                      </ToolbarButton>
                    );
                  })}
                </div>
              ))}
            </div>

            {toolbar.secondaryItems.length > 0 ? (
              <div className="flex items-center gap-2 border-t border-border px-3 py-2">
                {toolbar.secondaryItems.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={
                      item.availability !== "enabled" || isEditorReadOnly
                    }
                    onClick={() => {
                      if (
                        item.availability === "enabled" &&
                        !isEditorReadOnly
                      ) {
                        triggerToolbarItem(item.id);
                      }
                    }}
                    title={
                      item.availability !== "enabled"
                        ? `${item.label} (planned)`
                        : isEditorReadOnly
                          ? `${item.label} (unavailable in read-only mode)`
                          : item.label
                    }
                    className="border-primary text-primary hover:bg-accent-subtle hover:text-primary"
                  >
                    {resolveToolbarIcon(item.id)}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-mdcms-mdx-collapse-all={
                    collapseController.snapshot.globalState ?? "expanded"
                  }
                  onClick={() => collapseController.toggleGlobalCollapse()}
                  title={
                    collapseController.snapshot.globalState === "collapsed"
                      ? "Expand all components"
                      : "Collapse all components"
                  }
                  aria-label={
                    collapseController.snapshot.globalState === "collapsed"
                      ? "Expand all components"
                      : "Collapse all components"
                  }
                  className="ml-auto text-foreground-muted hover:text-foreground"
                >
                  {collapseController.snapshot.globalState === "collapsed" ? (
                    <>
                      <ChevronsUpDown className="size-4" />
                      <span>Expand all</span>
                    </>
                  ) : (
                    <>
                      <ChevronsDownUp className="size-4" />
                      <span>Collapse all</span>
                    </>
                  )}
                </Button>
              </div>
            ) : null}

            {pickerSource === "toolbar" ? (
              <div
                data-mdcms-mdx-picker-source="toolbar"
                className="border-t border-border p-3"
              >
                <MdxComponentPicker
                  components={insertableCatalogComponents}
                  query=""
                  forbidden={isEditorReadOnly}
                  onSelect={insertSelectedComponent}
                />
              </div>
            ) : null}
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[880px] px-6 pb-24 pt-4 lg:px-10 lg:pt-5">
              {canvasHeader}
              <MdxComponentCollapseProvider
                snapshot={collapseController.snapshot}
              >
                <EditorContent editor={editor} />
              </MdxComponentCollapseProvider>
            </div>
          </div>
        </div>

        {slashPicker && typeof document !== "undefined"
          ? createPortal(slashPicker, document.body)
          : null}
      </div>
    );
  },
);
