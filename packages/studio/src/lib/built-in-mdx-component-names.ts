// Kept apart from the built-in component implementations so modules that
// only need the reserved names do not import React.
export const BUILT_IN_MDX_COMPONENT_NAMES = [
  "Box",
  "Text",
  "Image",
  "Link",
] as const;

export type BuiltInMdxComponentName =
  (typeof BUILT_IN_MDX_COMPONENT_NAMES)[number];

const builtInMdxComponentNameSet = new Set<string>(
  BUILT_IN_MDX_COMPONENT_NAMES,
);

export function isBuiltInMdxComponentName(name: string): boolean {
  return builtInMdxComponentNameSet.has(name);
}
