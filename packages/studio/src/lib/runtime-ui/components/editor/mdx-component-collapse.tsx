"use client";

import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  defaultMdxComponentCollapseSnapshot,
  nextMdxComponentCollapseSnapshot,
  toggleMdxComponentCollapseSnapshot,
  type MdxComponentCollapseMode,
  type MdxComponentCollapseSnapshot,
} from "./mdx-component-collapse-state.js";

const MdxComponentCollapseContext = createContext<MdxComponentCollapseSnapshot>(
  defaultMdxComponentCollapseSnapshot,
);

export function useMdxComponentCollapseSnapshot(): MdxComponentCollapseSnapshot {
  return use(MdxComponentCollapseContext);
}

export function MdxComponentCollapseProvider(props: {
  snapshot: MdxComponentCollapseSnapshot;
  children?: ReactNode;
}) {
  return (
    <MdxComponentCollapseContext.Provider value={props.snapshot}>
      {props.children}
    </MdxComponentCollapseContext.Provider>
  );
}

export type MdxComponentCollapseController = {
  snapshot: MdxComponentCollapseSnapshot;
  broadcastGlobalCollapse: (next: MdxComponentCollapseMode) => void;
  toggleGlobalCollapse: () => void;
};

export function useMdxComponentCollapseController(): MdxComponentCollapseController {
  const [snapshot, setSnapshot] = useState<MdxComponentCollapseSnapshot>(
    defaultMdxComponentCollapseSnapshot,
  );

  const broadcastGlobalCollapse = useCallback(
    (next: MdxComponentCollapseMode) => {
      setSnapshot((previous) =>
        nextMdxComponentCollapseSnapshot(previous, next),
      );
    },
    [],
  );

  const toggleGlobalCollapse = useCallback(() => {
    setSnapshot((previous) => toggleMdxComponentCollapseSnapshot(previous));
  }, []);

  return useMemo(
    () => ({ snapshot, broadcastGlobalCollapse, toggleGlobalCollapse }),
    [snapshot, broadcastGlobalCollapse, toggleGlobalCollapse],
  );
}
