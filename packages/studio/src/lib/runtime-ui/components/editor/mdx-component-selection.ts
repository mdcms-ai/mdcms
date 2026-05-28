import type { Editor } from "@tiptap/core";

import type { StudioMountContext } from "@mdcms/shared";

type MdxCatalogComponent = NonNullable<
  StudioMountContext["mdx"]
>["catalog"]["components"][number];

export type SelectedMdxComponent = {
  kind: "component" | "intrinsic";
  component: MdxCatalogComponent | undefined;
  componentName: string;
  isVoid: boolean;
  props: Record<string, unknown>;
  pos: number;
};

type UpdateSelectedMdxComponentPropsOptions = {
  readOnly?: boolean;
  forbidden?: boolean;
};

export function getSelectedMdxComponent(
  editor: Editor,
  components: readonly MdxCatalogComponent[],
): SelectedMdxComponent | null {
  const nodeSelection = editor.state.selection as {
    from: number;
    node?: {
      type: { name: string };
      attrs: Record<string, unknown>;
    };
  };

  if (
    nodeSelection.node?.type.name === "mdxComponent" ||
    nodeSelection.node?.type.name === "mdxIntrinsicElement"
  ) {
    return createSelectedMdxComponent(
      nodeSelection.node,
      nodeSelection.from,
      components,
    );
  }

  const { $from } = editor.state.selection;

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);

    if (
      node.type.name === "mdxComponent" ||
      node.type.name === "mdxIntrinsicElement"
    ) {
      return createSelectedMdxComponent(node, $from.before(depth), components);
    }
  }

  return null;
}

export function updateSelectedMdxComponentProps(
  editor: Editor,
  components: readonly MdxCatalogComponent[],
  patch: Record<string, unknown>,
  options: UpdateSelectedMdxComponentPropsOptions = {},
): boolean {
  if (options.readOnly || options.forbidden) {
    return false;
  }

  const selected = getSelectedMdxComponent(editor, components);

  if (!selected) {
    return false;
  }

  return editor.commands.command(({ tr, dispatch }) => {
    const nextProps = {
      ...selected.props,
      ...patch,
    };

    tr.setNodeMarkup(
      selected.pos,
      undefined,
      selected.kind === "intrinsic"
        ? {
            tagName: selected.componentName,
            props: nextProps,
            isVoid: selected.isVoid,
          }
        : {
            componentName: selected.componentName,
            props: nextProps,
            isVoid: selected.isVoid,
          },
    );
    dispatch?.(tr);

    return true;
  });
}

export function selectAdjacentMdxComponent(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  const nodeBefore = $from.nodeBefore;

  if (nodeBefore?.type.name === "mdxComponent") {
    return editor.commands.setNodeSelection($from.pos - nodeBefore.nodeSize);
  }

  const nodeAfter = $from.nodeAfter;

  if (nodeAfter?.type.name === "mdxComponent") {
    return editor.commands.setNodeSelection($from.pos);
  }

  return false;
}

function createSelectedMdxComponent(
  node: {
    attrs: Record<string, unknown>;
    type: { name: string };
  },
  pos: number,
  components: readonly MdxCatalogComponent[],
): SelectedMdxComponent | null {
  const kind =
    node.type.name === "mdxIntrinsicElement" ? "intrinsic" : "component";
  const componentName =
    kind === "intrinsic"
      ? typeof node.attrs.tagName === "string"
        ? node.attrs.tagName
        : ""
      : typeof node.attrs.componentName === "string"
        ? node.attrs.componentName
        : "";

  if (componentName.length === 0) {
    return null;
  }

  return {
    kind,
    component:
      kind === "component"
        ? components.find((component) => component.name === componentName)
        : undefined,
    componentName,
    isVoid: node.attrs.isVoid === true,
    props: isPropsRecord(node.attrs.props) ? node.attrs.props : {},
    pos,
  };
}

function isPropsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
