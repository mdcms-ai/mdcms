import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";

import { createMdxComponentInsertContent } from "./mdx-component-catalog.js";
import {
  type MdxCatalogComponent,
  type VisualCompositionBlock,
  type VisualCompositionGroupId,
  type VisualCompositionInsertion,
  type VisualCompositionMarkdownBlock,
  type VisualCompositionPaletteGroup,
  type VisualCompositionRequiredPropsResult,
} from "./visual-composition-types.js";

const MDX_CHILDREN_PROP_NAME = "children";
const BUILT_IN_LAYOUT_COMPONENTS = new Set(["Box"]);
const BUILT_IN_MEDIA_COMPONENTS = new Set(["Image"]);
const BUILT_IN_ACTION_COMPONENTS = new Set(["Link"]);

const MARKDOWN_BLOCKS: VisualCompositionMarkdownBlock[] = [
  {
    kind: "markdown",
    id: "paragraph",
    label: "Paragraph",
    group: "Text",
    nodeType: "paragraph",
  },
  {
    kind: "markdown",
    id: "heading",
    label: "Heading",
    group: "Text",
    nodeType: "heading",
  },
  {
    kind: "markdown",
    id: "list",
    label: "List",
    group: "Text",
    nodeType: "bulletList",
  },
  {
    kind: "markdown",
    id: "quote",
    label: "Quote",
    group: "Text",
    nodeType: "blockquote",
  },
];

export function createVisualCompositionPaletteGroups(
  components: readonly MdxCatalogComponent[],
): VisualCompositionPaletteGroup[] {
  const grouped = new Map<VisualCompositionGroupId, VisualCompositionBlock[]>([
    ["Text", [...MARKDOWN_BLOCKS]],
    ["Layout", []],
    ["Media", []],
    ["Actions", []],
    ["Components", []],
  ]);

  for (const component of components) {
    const group = getVisualCompositionComponentGroup(component);
    grouped.get(group)?.push({
      kind: "mdx-component",
      id: `component:${component.name}`,
      label: component.name,
      group,
      component,
    });
  }

  return Array.from(grouped.entries()).map(([id, blocks]) => ({
    id,
    label: id,
    blocks,
  }));
}

export function getRequiredMdxComponentPropNames(
  component: MdxCatalogComponent,
): string[] {
  return Object.entries(component.extractedProps ?? {}).flatMap(
    ([name, prop]) =>
      prop.required &&
      !(name === MDX_CHILDREN_PROP_NAME && prop.type === "rich-text")
        ? [name]
        : [],
  );
}

export function validateMdxComponentRequiredProps(
  component: MdxCatalogComponent,
  props: Record<string, unknown>,
): VisualCompositionRequiredPropsResult {
  const missing = getRequiredMdxComponentPropNames(component).filter((name) =>
    isMissingRequiredPropValue(props[name]),
  );

  return {
    valid: missing.length === 0,
    missing,
  };
}

export function createVisualCompositionBlockContent(
  block: VisualCompositionBlock,
  props: Record<string, unknown> = {},
): JSONContent | JSONContent[] {
  if (block.kind === "mdx-component") {
    return createMdxComponentInsertContent(block.component, props);
  }

  switch (block.nodeType) {
    case "paragraph":
      return createTextBlock("paragraph", "Paragraph");
    case "heading":
      return {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Heading" }],
      };
    case "bulletList":
      return {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [createTextBlock("paragraph", "List item")],
          },
        ],
      };
    case "blockquote":
      return {
        type: "blockquote",
        content: [createTextBlock("paragraph", "Quote")],
      };
  }
}

export function insertVisualCompositionBlock(
  editor: Editor,
  insertion: VisualCompositionInsertion | VisualCompositionBlock,
): boolean {
  const normalized =
    "block" in insertion
      ? insertion
      : {
          block: insertion,
        };
  const content = createVisualCompositionBlockContent(
    normalized.block,
    normalized.props,
  );

  if (typeof normalized.position === "number") {
    return editor.commands.insertContentAt(normalized.position, content);
  }

  return editor.commands.insertContent(content);
}

export function patchSelectedMdxComponentProps(
  editor: Editor,
  patch: Record<string, unknown>,
): boolean {
  const selected = getSelectedMdxComponentNode(editor);

  if (!selected) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    const props = getMdxComponentProps(selected.node);

    tr.setNodeMarkup(selected.pos, undefined, {
      componentName: selected.componentName,
      props: {
        ...props,
        ...patch,
      },
      isVoid: selected.isVoid,
    });
    dispatch?.(tr);

    return true;
  });
}

export function patchSelectedMdxComponentStyle(
  editor: Editor,
  stylePatch: Record<string, string | number | undefined>,
): boolean {
  const selected = getSelectedMdxComponentNode(editor);

  if (!selected) {
    return false;
  }

  const props = getMdxComponentProps(selected.node);
  const currentStyle = isFlatStyleRecord(props.style) ? props.style : {};
  const nextStyle = { ...currentStyle };

  for (const [key, value] of Object.entries(stylePatch)) {
    if (value === undefined) {
      delete nextStyle[key];
    } else {
      nextStyle[key] = value;
    }
  }

  return patchSelectedMdxComponentProps(editor, {
    style: Object.keys(nextStyle).length > 0 ? nextStyle : undefined,
  });
}

export function duplicateSelectedMdxComponent(editor: Editor): boolean {
  const selected = getSelectedMdxComponentNode(editor);

  if (!selected) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    tr.insert(selected.pos + selected.node.nodeSize, selected.node.copy());
    dispatch?.(tr);
    return true;
  });
}

export function deleteSelectedVisualBlock(editor: Editor): boolean {
  const selection = editor.state.selection as {
    node?: PmNode;
    from: number;
    to: number;
  };

  if (!selection.node) {
    return false;
  }

  return editor.commands.deleteSelection();
}

export function moveSelectedVisualBlock(
  editor: Editor,
  direction: "up" | "down",
): boolean {
  const selection = editor.state.selection as {
    node?: PmNode;
    from: number;
    to: number;
    $from: { parent: PmNode; index: () => number };
  };

  if (!selection.node) {
    return false;
  }

  const index = selection.$from.index();
  const parent = selection.$from.parent;

  if (direction === "up") {
    if (index === 0) {
      return false;
    }

    const previous = parent.child(index - 1);
    const targetPos = selection.from - previous.nodeSize;

    return editor.commands.command(({ tr, dispatch }) => {
      tr.delete(selection.from, selection.to);
      tr.insert(targetPos, selection.node!.copy());
      dispatch?.(tr);
      return true;
    });
  }

  if (index >= parent.childCount - 1) {
    return false;
  }

  const next = parent.child(index + 1);

  return editor.commands.command(({ tr, dispatch }) => {
    tr.delete(selection.from, selection.to);
    tr.insert(selection.from + next.nodeSize, selection.node!.copy());
    dispatch?.(tr);
    return true;
  });
}

export function wrapSelectedBlockInBox(
  editor: Editor,
  boxComponent: MdxCatalogComponent,
): boolean {
  const selection = editor.state.selection as {
    node?: PmNode;
    from: number;
    to: number;
  };
  const node = selection.node;
  const mdxComponentType = editor.schema.nodes.mdxComponent;

  if (!node || !mdxComponentType) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    const wrapper = mdxComponentType.create(
      {
        componentName: boxComponent.name,
        props: {},
        isVoid: false,
      },
      Fragment.from(node.copy()),
    );

    tr.replaceWith(selection.from, selection.to, wrapper);
    dispatch?.(tr);

    return true;
  });
}

export function unwrapSelectedMdxComponent(editor: Editor): boolean {
  const selected = getSelectedMdxComponentNode(editor);

  if (!selected || selected.isVoid) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    const replacement = selected.node.content;

    if (replacement.size === 0) {
      return false;
    }

    tr.replaceWith(
      selected.pos,
      selected.pos + selected.node.nodeSize,
      replacement,
    );
    dispatch?.(tr);

    return true;
  });
}

function getVisualCompositionComponentGroup(
  component: MdxCatalogComponent,
): VisualCompositionGroupId {
  if (component.builtIn === true) {
    if (BUILT_IN_LAYOUT_COMPONENTS.has(component.name)) {
      return "Layout";
    }

    if (BUILT_IN_MEDIA_COMPONENTS.has(component.name)) {
      return "Media";
    }

    if (BUILT_IN_ACTION_COMPONENTS.has(component.name)) {
      return "Actions";
    }
  }

  return "Components";
}

function createTextBlock(type: "paragraph", text: string): JSONContent {
  return {
    type,
    content: [{ type: "text", text }],
  };
}

function isMissingRequiredPropValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return false;
}

function getSelectedMdxComponentNode(editor: Editor): {
  node: PmNode;
  pos: number;
  componentName: string;
  isVoid: boolean;
} | null {
  const selection = editor.state.selection as {
    node?: PmNode;
    from: number;
  };

  if (selection.node?.type.name !== "mdxComponent") {
    return null;
  }

  const componentName =
    typeof selection.node.attrs.componentName === "string"
      ? selection.node.attrs.componentName
      : "";

  if (componentName.length === 0) {
    return null;
  }

  return {
    node: selection.node,
    pos: selection.from,
    componentName,
    isVoid: selection.node.attrs.isVoid === true,
  };
}

function getMdxComponentProps(node: PmNode): Record<string, unknown> {
  const props = node.attrs.props;

  return props && typeof props === "object" && !Array.isArray(props)
    ? { ...(props as Record<string, unknown>) }
    : {};
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
