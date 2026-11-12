function isRenderableComponent(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }

  // `React.memo`, `forwardRef` and `lazy` results are objects tagged with
  // `$$typeof`.
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in value &&
    typeof (value as { $$typeof?: unknown }).$$typeof === "symbol"
  );
}

/**
 * The React component behind an MDX component registration's `load()` result.
 * `load` may resolve to the component itself or to its module, as
 * `() => import("./components/callout")` does; for a module, the default
 * export is used, then the export named like the component. Returns
 * `undefined` when neither is a component.
 */
export function resolveMdxComponentExport(
  name: string,
  loaded: unknown,
): unknown {
  if (isRenderableComponent(loaded)) {
    return loaded;
  }

  if (typeof loaded !== "object" || loaded === null) {
    return undefined;
  }

  const moduleExports = loaded as Record<string, unknown>;

  for (const candidate of [moduleExports.default, moduleExports[name]]) {
    if (isRenderableComponent(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
