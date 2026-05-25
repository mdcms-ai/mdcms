"use client";

import {
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type { StudioMountContext } from "@mdcms/shared";
import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";

import {
  Box as BoxIcon,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Scissors,
  Settings,
  Trash2,
} from "lucide-react";

import { isMdxExpressionValue } from "../../../mdx-component-extension.js";
import { cn } from "../../lib/utils.js";
import { useMdxComponentCollapseSnapshot } from "./mdx-component-collapse.js";
import {
  duplicateSelectedMdxComponent,
  unwrapSelectedMdxComponent,
  wrapSelectedBlockInBox,
} from "./visual-composition-commands.js";

const MDX_EDITABLE_SLOT_SELECTOR = "[data-mdcms-mdx-editable-slot]";

function preventEditorChromeButtonMouseDown(
  event: MouseEvent<HTMLButtonElement>,
) {
  event.preventDefault();
}

export function formatMdxComponentPropsSummary(
  props: Record<string, unknown> | undefined,
): string {
  const entries = Object.entries(props ?? {}).filter(
    ([, value]) => value !== undefined,
  );

  if (entries.length === 0) {
    return "No props set yet";
  }

  return entries
    .map(([name, value]) => {
      if (isMdxExpressionValue(value)) {
        return `${name}={${value.__mdxExpression}}`;
      }

      if (typeof value === "string") {
        return `${name}="${value}"`;
      }

      return `${name}={${JSON.stringify(value)}}`;
    })
    .join(" ");
}

export function MdxComponentNodeFrame(props: {
  componentName: string;
  isVoid: boolean;
  propsSummary: string;
  selected?: boolean;
  previewState?: "ready" | "empty" | "error";
  previewSurface?: ReactNode;
  readOnly?: boolean;
  forbidden?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onEditProps?: () => void;
  onDuplicate?: () => void;
  onWrapInBox?: () => void;
  onUnwrap?: () => void;
  onDelete?: () => void;
  children?: ReactNode;
}) {
  const collapsed = props.collapsed === true;
  const hasProps = props.propsSummary !== "No props set yet";

  return (
    <div
      data-mdcms-mdx-component-frame={props.componentName}
      data-mdcms-mdx-component-kind={props.isVoid ? "void" : "wrapper"}
      data-mdcms-mdx-component-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "group/mdx-block relative my-4 rounded-md border-l-[3px] pl-3 transition-colors duration-150",
        props.selected
          ? "border-l-primary bg-accent-subtle"
          : "border-l-primary/20 hover:border-l-primary/50",
      )}
    >
      {/* Drag handle. Tiptap recognizes `[data-drag-handle]` inside a
          `draggable: true` node view and routes pointer-down to ProseMirror's
          drag-start, so only this element initiates a drag — clicking
          anywhere else in the wrapper places a caret. The handle is
          suppressed in read-only / forbidden modes to match how the props
          and delete affordances are gated. */}
      <div
        className="absolute -left-7 top-1.5 flex opacity-0 transition-opacity duration-150 group-hover/mdx-block:opacity-100"
        contentEditable={false}
        suppressContentEditableWarning
      >
        {props.readOnly || props.forbidden ? (
          <span className="rounded p-0.5 text-foreground-muted/50">
            <GripVertical className="size-4" />
          </span>
        ) : (
          <span
            data-drag-handle
            draggable={true}
            aria-label={`Drag to reorder ${props.componentName}`}
            title="Drag to reorder"
            className="cursor-grab rounded p-0.5 text-foreground-muted hover:bg-background-subtle hover:text-foreground active:cursor-grabbing"
          >
            <GripVertical className="size-4" />
          </span>
        )}
      </div>

      {/* Chip row — the `<Name />` label and the action buttons are chrome,
          never editable document content. */}
      <div
        className={cn(
          "flex items-center justify-between gap-3 py-1.5",
          collapsed ? "min-w-0" : undefined,
        )}
        contentEditable={false}
        suppressContentEditableWarning
      >
        <div className="flex min-w-0 items-center gap-1.5 text-mono-label select-none text-foreground-muted">
          {/* Collapse toggle is the primary affordance for "show less" on
              tall components. We always show it when the block is collapsed
              (otherwise the user has no visible way back) and on
              hover/selection when expanded, matching the other chrome
              actions. */}
          {props.onToggleCollapsed ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onToggleCollapsed}
              aria-label={
                collapsed
                  ? `Expand ${props.componentName}`
                  : `Collapse ${props.componentName}`
              }
              aria-expanded={!collapsed}
              title={collapsed ? "Expand component" : "Collapse component"}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-background-subtle hover:text-foreground",
                "transition-opacity duration-150",
                collapsed || props.selected
                  ? "opacity-100"
                  : "opacity-60 group-hover/mdx-block:opacity-100",
              )}
            >
              {collapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>
          ) : null}
          {/* When expanded, the chip reads as a contiguous `<Name />` token.
              When collapsed, an inline props summary slots in between the
              tag name and its self-closing `/>` so the chip mirrors the
              underlying MDX (e.g. `<Hero title="Welcome" />`) and gives
              the user enough context to identify the block without having
              to expand it. */}
          {collapsed && hasProps ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0">
                {"<"}
                {props.componentName}
              </span>
              <span
                data-mdcms-mdx-collapsed-props={props.componentName}
                className="truncate text-foreground-muted/70"
                title={props.propsSummary}
              >
                {props.propsSummary}
              </span>
              <span className="shrink-0">{" />"}</span>
            </span>
          ) : (
            <span>
              {"<"}
              {props.componentName}
              {" />"}
            </span>
          )}
        </div>

        <div
          className={cn(
            "flex shrink-0 items-center gap-1 transition-opacity duration-150",
            props.selected
              ? "opacity-100"
              : "opacity-0 group-hover/mdx-block:opacity-100",
          )}
        >
          {props.forbidden ? (
            <span className="text-xs text-foreground-muted">Unavailable</span>
          ) : props.readOnly ? (
            <span className="text-xs text-foreground-muted">Read-only</span>
          ) : null}
          {props.onEditProps ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onEditProps}
              aria-label={`Edit ${props.componentName} props`}
              title="Edit props"
              className="inline-flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-subtle hover:text-foreground"
            >
              <Settings className="size-3.5" />
            </button>
          ) : null}
          {props.onDuplicate ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onDuplicate}
              aria-label={`Duplicate ${props.componentName}`}
              title="Duplicate"
              className="inline-flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-subtle hover:text-foreground"
            >
              <Copy className="size-3.5" />
            </button>
          ) : null}
          {props.onWrapInBox ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onWrapInBox}
              aria-label={`Wrap ${props.componentName} in Box`}
              title="Wrap in Box"
              className="inline-flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-subtle hover:text-foreground"
            >
              <BoxIcon className="size-3.5" />
            </button>
          ) : null}
          {props.onUnwrap ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onUnwrap}
              aria-label={`Unwrap ${props.componentName}`}
              title="Unwrap"
              className="inline-flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-background-subtle hover:text-foreground"
            >
              <Scissors className="size-3.5" />
            </button>
          ) : null}
          {props.onDelete ? (
            <button
              type="button"
              onMouseDown={preventEditorChromeButtonMouseDown}
              onClick={props.onDelete}
              aria-label={`Delete ${props.componentName}`}
              title="Delete component"
              className="inline-flex size-6 items-center justify-center rounded text-foreground-muted hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Content area. When collapsed we hide the preview + children via
          `display: none` rather than unmounting them: ProseMirror tracks the
          editable region through the live DOM node, and unmounting the
          NodeViewContent slot would break that link the moment the user
          expands again. */}
      <div className={collapsed ? "hidden" : "pb-3"}>
        {/* Preview surface — React-rendered component output. Must be
            contentEditable=false or the browser lets the caret land inside
            the rendered DOM (headings, labels, table cells) and corrupts the
            preview on the next keystroke. */}
        {props.isVoid ? (
          <div
            data-mdcms-mdx-preview-state={props.previewState ?? "empty"}
            contentEditable={false}
            suppressContentEditableWarning
          >
            {props.previewSurface}
            {props.previewState === "error" ? (
              <p className="text-xs text-destructive">
                Preview failed to render.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Wrapper children — the inner NodeViewContent is the ONE place
            inside this frame that must stay editable. */}
        {props.isVoid ? null : (
          <div
            data-mdcms-mdx-content-label={props.componentName}
            className="relative"
          >
            {props.children}
          </div>
        )}
      </div>
    </div>
  );
}

function getElementFromEventTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }

  if (target instanceof Node) {
    return target.parentElement;
  }

  return null;
}

function isInsideEditableSlot(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  const targetElement = getElementFromEventTarget(target);

  if (!(currentTarget instanceof Element) || !targetElement) {
    return false;
  }

  const editableSlot = targetElement.closest(MDX_EDITABLE_SLOT_SELECTOR);

  return editableSlot !== null && currentTarget.contains(editableSlot);
}

function MdxComponentEditableSurface(input: {
  component: unknown;
  componentName: string;
  props: Record<string, unknown>;
  children: ReactNode;
  onSelectPreview?: () => void;
}) {
  if (!input.component) {
    return (
      <div data-mdcms-mdx-unresolved-wrapper={input.componentName}>
        {input.children}
      </div>
    );
  }

  const Component = input.component as ComponentType<
    Record<string, unknown> & { children?: ReactNode }
  >;
  const editableSlot = renderEditableSlot(input.componentName, input.children);

  const keepHostPreviewInert = (event: SyntheticEvent<HTMLElement>) => {
    if (isInsideEditableSlot(event.target, event.currentTarget)) {
      return;
    }

    event.preventDefault();
    input.onSelectPreview?.();
  };

  return (
    <div
      data-mdcms-mdx-rendered-wrapper={input.componentName}
      contentEditable={false}
      suppressContentEditableWarning
      className="select-none"
      onPointerDownCapture={keepHostPreviewInert}
      onMouseDownCapture={keepHostPreviewInert}
      onBeforeInputCapture={keepHostPreviewInert}
    >
      {createElement(Component, input.props, editableSlot)}
    </div>
  );
}

type EditableSlotProps = {
  className?: string;
  contentEditable?: boolean;
  suppressContentEditableWarning?: boolean;
  "data-mdcms-mdx-editable-slot"?: string;
};

function renderEditableSlot(
  componentName: string,
  children: ReactNode,
): ReactNode {
  const slotProps = {
    "data-mdcms-mdx-editable-slot": componentName,
    contentEditable: true,
    suppressContentEditableWarning: true,
  } satisfies Omit<EditableSlotProps, "className">;

  if (isValidElement<EditableSlotProps>(children)) {
    return cloneElement(children, {
      ...slotProps,
      className: cn(
        children.props.className,
        "mdcms-mdx-editable-slot select-text",
      ),
    });
  }

  return (
    <div {...slotProps} className="mdcms-mdx-editable-slot select-text">
      {children}
    </div>
  );
}

export function MdxComponentNodeView(
  props: ReactNodeViewProps & {
    context?: StudioMountContext;
    readOnly?: boolean;
    forbidden?: boolean;
  },
) {
  const componentName =
    typeof props.node.attrs.componentName === "string"
      ? props.node.attrs.componentName
      : "Component";
  const isVoid = props.node.attrs.isVoid === true;
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewState, setPreviewState] = useState<"ready" | "empty" | "error">(
    "empty",
  );
  const collapseSnapshot = useMdxComponentCollapseSnapshot();
  // Seed `collapsed` from the snapshot so node views mounted *after* a
  // global broadcast (e.g. inserting a new component while everything is
  // already collapsed) start in the announced mode. Pairing that with
  // `lastSyncedGenerationRef` initialized to the current generation makes
  // the post-mount effect a no-op for the same generation, so it only
  // fires on subsequent broadcasts.
  const [collapsed, setCollapsed] = useState(
    () => collapseSnapshot.globalState === "collapsed",
  );
  const lastSyncedGenerationRef = useRef(collapseSnapshot.generation);

  // The toolbar's collapse-all/expand-all toggle bumps `generation` on the
  // shared snapshot. Each node view watches the bump and snaps its local
  // state to the new global mode, which means individual blocks the user
  // already toggled get reset to whatever the global broadcast says.
  useEffect(() => {
    if (collapseSnapshot.generation === lastSyncedGenerationRef.current) {
      return;
    }
    lastSyncedGenerationRef.current = collapseSnapshot.generation;
    if (collapseSnapshot.globalState === "collapsed") {
      setCollapsed(true);
    } else if (collapseSnapshot.globalState === "expanded") {
      setCollapsed(false);
    }
  }, [collapseSnapshot.generation, collapseSnapshot.globalState]);

  const mdxProps =
    (props.node.attrs.props as Record<string, unknown> | undefined) ?? {};
  const serializedPreviewProps = JSON.stringify(mdxProps);
  const propsSummary = formatMdxComponentPropsSummary(mdxProps);

  useEffect(() => {
    if (!isVoid) {
      return;
    }

    const container = previewContainerRef.current;

    if (!container || !props.context) {
      setPreviewState("empty");
      return;
    }

    if (props.context.hostBridge.resolveComponent(componentName) == null) {
      setPreviewState("empty");
      return;
    }

    try {
      const cleanup = props.context.hostBridge.renderMdxPreview({
        container,
        componentName,
        props: mdxProps,
        key: `mdx-component:${componentName}:${serializedPreviewProps}`,
      });

      setPreviewState("ready");

      return () => {
        cleanup();
      };
    } catch {
      setPreviewState("error");
      return;
    }
  }, [componentName, isVoid, mdxProps, props.context, serializedPreviewProps]);

  const handleEditProps = () => {
    const pos = props.getPos();
    if (typeof pos === "number") {
      props.editor.commands.setNodeSelection(pos);
    }
  };

  const selectThisNode = (): number | null => {
    const pos = props.getPos();
    if (typeof pos !== "number") {
      return null;
    }

    props.editor.commands.setNodeSelection(pos);
    return pos;
  };

  const handleDelete = () => {
    props.deleteNode();
    props.editor.commands.focus();
  };

  const handleToggleCollapsed = () => {
    setCollapsed((current) => !current);
  };

  const isEditable = !props.readOnly && !props.forbidden;
  const boxComponent = props.context?.mdx?.catalog.components.find(
    (component) => component.name === "Box",
  );
  const resolvedWrapperComponent = !isVoid
    ? props.context?.hostBridge.resolveComponent(componentName)
    : null;

  const runSelectedAction = (action: () => boolean) => {
    if (selectThisNode() === null) {
      return;
    }

    if (action()) {
      props.editor.commands.focus();
    }
  };

  return (
    <NodeViewWrapper as="div">
      <MdxComponentNodeFrame
        componentName={componentName}
        isVoid={isVoid}
        propsSummary={propsSummary}
        previewState={previewState}
        selected={props.selected}
        collapsed={collapsed}
        onToggleCollapsed={handleToggleCollapsed}
        onEditProps={isEditable ? handleEditProps : undefined}
        onDuplicate={
          isEditable
            ? () =>
                runSelectedAction(() =>
                  duplicateSelectedMdxComponent(props.editor),
                )
            : undefined
        }
        onWrapInBox={
          isEditable && boxComponent
            ? () =>
                runSelectedAction(() =>
                  wrapSelectedBlockInBox(props.editor, boxComponent),
                )
            : undefined
        }
        onUnwrap={
          isEditable && !isVoid
            ? () =>
                runSelectedAction(() =>
                  unwrapSelectedMdxComponent(props.editor),
                )
            : undefined
        }
        onDelete={isEditable ? handleDelete : undefined}
        previewSurface={
          <div
            ref={previewContainerRef}
            data-mdcms-mdx-preview-surface={componentName}
            // `not-prose` opts the host-rendered component out of the
            // editor's surrounding `.prose` typography rules. Without this,
            // selectors like `.prose h1`, `.prose h2`, `.prose p` win on
            // specificity (0,1,1) over the host component's own utility
            // classes (0,1,0) — so a marketing component using
            // `text-dark` on a light section would silently render with
            // the editor's dark-mode prose heading color (light/white) and
            // appear white-on-light. Resetting prose at the preview
            // boundary lets the host component own its own typography.
            className={cn(
              "not-prose",
              previewState === "ready" ? "min-h-[3rem]" : "hidden",
            )}
          />
        }
        readOnly={props.readOnly}
        forbidden={props.forbidden}
      >
        {isVoid ? null : (
          <MdxComponentEditableSurface
            component={resolvedWrapperComponent}
            componentName={componentName}
            props={mdxProps}
            onSelectPreview={() => {
              selectThisNode();
            }}
          >
            <NodeViewContent
              as="div"
              data-placeholder="Type content here..."
              className="max-w-none min-h-[3rem] before:pointer-events-none before:float-left before:h-0 before:text-foreground-muted/60 before:content-[attr(data-placeholder)] has-[>:first-child:not(.is-empty)]:before:content-none"
            />
          </MdxComponentEditableSurface>
        )}
      </MdxComponentNodeFrame>
    </NodeViewWrapper>
  );
}
