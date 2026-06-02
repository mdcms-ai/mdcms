"use client";

import { useEffect } from "react";

const MDCMS_LIVE_PREVIEW_READY_MESSAGE = "mdcms:live-preview-ready";

export function PreviewReadySignal() {
  useEffect(() => {
    window.parent.postMessage({ type: MDCMS_LIVE_PREVIEW_READY_MESSAGE }, "*");
  }, []);

  return (
    <span
      data-mdcms-live-preview-ready-signal={MDCMS_LIVE_PREVIEW_READY_MESSAGE}
      hidden
    />
  );
}
