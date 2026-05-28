export type MdxComponentCollapseMode = "expanded" | "collapsed";

export type MdxComponentCollapseSnapshot = {
  globalState: MdxComponentCollapseMode | null;
  generation: number;
};

export const defaultMdxComponentCollapseSnapshot: MdxComponentCollapseSnapshot =
  {
    globalState: null,
    generation: 0,
  };

// Extracted as a pure helper so the snapshot transition contract — the
// `generation` bump that node views observe — is testable without spinning
// up React just to drive a hook.
export function nextMdxComponentCollapseSnapshot(
  previous: MdxComponentCollapseSnapshot,
  next: MdxComponentCollapseMode,
): MdxComponentCollapseSnapshot {
  return {
    globalState: next,
    generation: previous.generation + 1,
  };
}

export function toggleMdxComponentCollapseSnapshot(
  previous: MdxComponentCollapseSnapshot,
): MdxComponentCollapseSnapshot {
  return nextMdxComponentCollapseSnapshot(
    previous,
    previous.globalState === "collapsed" ? "expanded" : "collapsed",
  );
}
