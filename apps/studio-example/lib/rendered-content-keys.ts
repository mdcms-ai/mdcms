export type RenderNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{
    type?: string;
    attrs?: Record<string, unknown>;
  }>;
  content?: RenderNode[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNodeKeyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeNodeKeyValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, childValue]) => [key, normalizeNodeKeyValue(childValue)]),
    );
  }

  return value;
}

function normalizeNodeMarks(node: RenderNode): unknown[] {
  return (node.marks ?? [])
    .map(normalizeNodeKeyValue)
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

export function getRenderedContentNodeKey(node: RenderNode): string {
  return JSON.stringify({
    type: node.type,
    text: node.text,
    attrs: normalizeNodeKeyValue(node.attrs ?? {}),
    marks: normalizeNodeMarks(node),
    content: normalizeNodeKeyValue(node.content ?? []),
  });
}

export function createRenderedContentSiblingKeyer(): (
  node: RenderNode,
) => string {
  const seen = new Map<string, number>();

  return (node) => {
    const baseKey = getRenderedContentNodeKey(node);
    const count = seen.get(baseKey) ?? 0;
    seen.set(baseKey, count + 1);

    return count === 0 ? baseKey : `${baseKey}:duplicate-${count}`;
  };
}
