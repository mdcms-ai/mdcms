import { createElement } from "react";
import { createRoot } from "react-dom/client";

import {
  assertStudioMountContext,
  type RemoteStudioModule,
  type StudioMountContext,
} from "@mdcms/shared";

import { RemoteStudioApp } from "./remote-studio-app.js";
import { activateStudioSessionToken } from "./studio-session-token.js";
import {
  installStudioRuntimeStyles,
  resolveStudioRuntimeStylesheetUrl,
} from "./runtime-ui/style-installer.js";

function resolveMountTarget(container: unknown): HTMLElement {
  if (container instanceof HTMLElement) {
    return container;
  }

  throw new TypeError(
    "Remote Studio runtime mount target must be an HTMLElement.",
  );
}

/**
 * mount is the typed remote Studio runtime entrypoint.
 */
export const mount: RemoteStudioModule["mount"] = (
  container: unknown,
  context: StudioMountContext,
): (() => void) => {
  assertStudioMountContext(context);

  const target = resolveMountTarget(container);
  const removeStyles = installStudioRuntimeStyles(
    resolveStudioRuntimeStylesheetUrl(import.meta.url),
  );
  const root = createRoot(target);

  if (context.auth.mode === "cookie") {
    activateStudioSessionToken(context.apiBaseUrl);
  }

  root.render(createElement(RemoteStudioApp, { context }));

  return () => {
    root.unmount();
    removeStyles();
  };
};
