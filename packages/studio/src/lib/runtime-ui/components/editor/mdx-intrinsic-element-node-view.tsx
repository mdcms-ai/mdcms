"use client";

import {
  cloneElement,
  createElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";

import { useMdxComponentCollapseSnapshot } from "./mdx-component-collapse.js";
import { MdxComponentNodeFrame } from "./mdx-component-node-view.js";
import { formatMdxComponentPropsSummary } from "./mdx-component-node-view-utils.js";

const MDX_EDITABLE_SLOT_SELECTOR = "[data-mdcms-mdx-editable-slot]";
const URL_BEARING_ATTRIBUTES = new Set([
  "action",
  "formaction",
  "href",
  "poster",
  "src",
  "xlinkhref",
]);
const UNSAFE_ATTRIBUTES = new Set(["srcdoc", "dangerouslysetinnerhtml"]);

type EditableSlotProps = {
  className?: string;
  suppressContentEditableWarning?: boolean;
  "data-mdcms-mdx-editable-slot"?: string;
};

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

function normalizeReactPropName(name: string): string {
  if (name === "class") return "className";
  if (name === "for") return "htmlFor";
  return name;
}

function isFlatStyleRecord(
  value: unknown,
): value is Record<string, string | number> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    )
  );
}

function createSafeIntrinsicPreviewProps(
  tagName: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const safeProps: Record<string, unknown> = {};

  for (const [rawName, value] of Object.entries(props)) {
    const name = normalizeReactPropName(rawName);
    const normalizedName = name.toLowerCase();

    if (
      normalizedName.startsWith("on") ||
      URL_BEARING_ATTRIBUTES.has(normalizedName) ||
      UNSAFE_ATTRIBUTES.has(normalizedName) ||
      value === undefined ||
      value === null ||
      value === false
    ) {
      continue;
    }

    if (name === "style") {
      if (isFlatStyleRecord(value)) {
        safeProps[name] = value;
      }
      continue;
    }

    if (
      value === true ||
      typeof value === "string" ||
      typeof value === "number"
    ) {
      safeProps[name] = value;
    }
  }

  if (tagName === "form") {
    safeProps.onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
    };
  }

  return safeProps;
}

function renderEditableSlot(tagName: string, children: ReactNode): ReactNode {
  const slotProps = {
    "data-mdcms-mdx-editable-slot": tagName,
    suppressContentEditableWarning: true,
  } satisfies Omit<EditableSlotProps, "className">;

  if (isValidElement<EditableSlotProps>(children)) {
    return cloneElement(children, {
      ...slotProps,
      className: [
        children.props.className,
        "mdcms-mdx-editable-slot select-text",
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  return (
    <div {...slotProps} className="mdcms-mdx-editable-slot select-text">
      {children}
    </div>
  );
}

function MdxIntrinsicEditableSurface(input: {
  tagName: string;
  props: Record<string, unknown>;
  children: ReactNode;
  onSelectPreview?: () => void;
}) {
  const editableSlot = renderEditableSlot(input.tagName, input.children);
  const safeProps = createSafeIntrinsicPreviewProps(input.tagName, input.props);

  const keepNativePreviewInert = (event: SyntheticEvent<HTMLElement>) => {
    if (isInsideEditableSlot(event.target, event.currentTarget)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    input.onSelectPreview?.();
  };

  return (
    <div
      data-mdcms-mdx-rendered-intrinsic={input.tagName}
      className="select-none"
      onPointerDownCapture={keepNativePreviewInert}
      onMouseDownCapture={keepNativePreviewInert}
      onBeforeInputCapture={keepNativePreviewInert}
      onCompositionStartCapture={keepNativePreviewInert}
      onInputCapture={keepNativePreviewInert}
      onKeyDownCapture={keepNativePreviewInert}
      onPasteCapture={keepNativePreviewInert}
    >
      {createElement(input.tagName, safeProps, editableSlot)}
    </div>
  );
}

function MdxIntrinsicVoidPreviewSurface(props: {
  tagName: string;
  mdxProps: Record<string, unknown>;
}) {
  return (
    <div
      data-mdcms-mdx-preview-state="ready"
      contentEditable={false}
      suppressContentEditableWarning
    >
      {createElement(
        props.tagName,
        createSafeIntrinsicPreviewProps(props.tagName, props.mdxProps),
      )}
    </div>
  );
}

export function MdxIntrinsicElementNodeView(
  props: ReactNodeViewProps & {
    readOnly?: boolean;
    forbidden?: boolean;
  },
) {
  const tagName =
    typeof props.node.attrs.tagName === "string"
      ? props.node.attrs.tagName
      : "div";
  const isVoid = props.node.attrs.isVoid === true;
  const mdxProps =
    (props.node.attrs.props as Record<string, unknown> | undefined) ?? {};
  const propsSummary = formatMdxComponentPropsSummary(mdxProps);
  const collapseSnapshot = useMdxComponentCollapseSnapshot();
  const [collapsed, setCollapsed] = useState(
    () => collapseSnapshot.globalState === "collapsed",
  );
  const lastSyncedGenerationRef = useRef(collapseSnapshot.generation);
  const isEditable = !props.readOnly && !props.forbidden;

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

  const selectThisNode = (): number | null => {
    const pos = props.getPos();
    if (typeof pos !== "number") {
      return null;
    }

    props.editor.commands.setNodeSelection(pos);
    return pos;
  };

  const handleEditProps = () => {
    selectThisNode();
  };

  const handleDuplicate = () => {
    const pos = selectThisNode();
    if (pos === null) {
      return;
    }

    props.editor.commands.command(({ tr, dispatch }) => {
      tr.insert(pos + props.node.nodeSize, props.node.copy());
      dispatch?.(tr);
      return true;
    });
    props.editor.commands.focus();
  };

  const handleUnwrap = () => {
    const pos = selectThisNode();
    if (pos === null || isVoid || props.node.content.size === 0) {
      return;
    }

    props.editor.commands.command(({ tr, dispatch }) => {
      tr.replaceWith(pos, pos + props.node.nodeSize, props.node.content);
      dispatch?.(tr);
      return true;
    });
    props.editor.commands.focus();
  };

  const handleDelete = () => {
    props.deleteNode();
    props.editor.commands.focus();
  };

  return (
    <NodeViewWrapper as="div">
      <MdxComponentNodeFrame
        componentName={tagName}
        isVoid={isVoid}
        propsSummary={propsSummary}
        selected={props.selected}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
        onEditProps={isEditable ? handleEditProps : undefined}
        onDuplicate={isEditable ? handleDuplicate : undefined}
        onUnwrap={isEditable && !isVoid ? handleUnwrap : undefined}
        onDelete={isEditable ? handleDelete : undefined}
        previewSurface={
          isVoid ? (
            <MdxIntrinsicVoidPreviewSurface
              tagName={tagName}
              mdxProps={mdxProps}
            />
          ) : null
        }
        previewSurfaceOwnsChrome
        readOnly={props.readOnly}
        forbidden={props.forbidden}
      >
        {isVoid ? null : (
          <MdxIntrinsicEditableSurface
            tagName={tagName}
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
          </MdxIntrinsicEditableSurface>
        )}
      </MdxComponentNodeFrame>
    </NodeViewWrapper>
  );
}
