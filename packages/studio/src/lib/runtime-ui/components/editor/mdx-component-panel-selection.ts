import type { SelectedMdxComponent } from "./mdx-component-selection.js";

export type PublishedMdxComponentSelectionSnapshot = {
  kind: SelectedMdxComponent["kind"];
  component: SelectedMdxComponent["component"];
  componentName: string;
  isVoid: boolean;
  pos: number;
  serializedProps: string;
  readOnly: boolean;
  forbidden: boolean;
};

export function createPublishedMdxComponentSelectionSnapshot(input: {
  selected: SelectedMdxComponent;
  readOnly: boolean;
  forbidden: boolean;
}): PublishedMdxComponentSelectionSnapshot {
  return {
    kind: input.selected.kind,
    component: input.selected.component,
    componentName: input.selected.componentName,
    isVoid: input.selected.isVoid,
    pos: input.selected.pos,
    serializedProps: JSON.stringify(input.selected.props),
    readOnly: input.readOnly,
    forbidden: input.forbidden,
  };
}

export function hasPublishedMdxComponentSelectionChanged(
  previous: PublishedMdxComponentSelectionSnapshot | null,
  next: PublishedMdxComponentSelectionSnapshot | null,
): boolean {
  if (previous === next) {
    return false;
  }

  if (!previous || !next) {
    return previous !== next;
  }

  return !(
    previous.component === next.component &&
    previous.kind === next.kind &&
    previous.componentName === next.componentName &&
    previous.isVoid === next.isVoid &&
    previous.pos === next.pos &&
    previous.serializedProps === next.serializedProps &&
    previous.readOnly === next.readOnly &&
    previous.forbidden === next.forbidden
  );
}
