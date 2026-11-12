import type { StudioMountContext } from "@mdcms/shared";

import {
  STUDIO_SESSION_HEADER,
  getActiveStudioSessionToken,
} from "./studio-session-token.js";

export type StudioRuntimeAuth = StudioMountContext["auth"];

export function isStudioCookieAuth(
  auth: StudioRuntimeAuth | undefined,
): auth is Extract<StudioRuntimeAuth, { mode: "cookie" }> {
  return auth?.mode === "cookie";
}

/**
 * applyStudioAuthToRequestInit normalizes browser request options for the
 * selected Studio auth mode.
 */
export function applyStudioAuthToRequestInit(
  auth: StudioRuntimeAuth | undefined,
  init: RequestInit = {},
): RequestInit {
  const nextInit: RequestInit = {
    ...init,
  };
  const headers = new Headers(init.headers);

  if (auth?.mode === "token" && auth.token) {
    headers.set("authorization", `Bearer ${auth.token}`);
  }

  if (auth?.mode === "cookie" && nextInit.credentials === undefined) {
    nextInit.credentials = "include";
  }

  // Session auth signed in through the server redirect sends its session in
  // a header, which works where the browser blocks the server's cookie.
  const sessionToken =
    auth?.mode === "cookie" ? getActiveStudioSessionToken() : undefined;

  if (sessionToken) {
    headers.set(STUDIO_SESSION_HEADER, sessionToken);
  }

  const headerEntries = Array.from(headers.entries());

  if (headerEntries.length > 0) {
    nextInit.headers = Object.fromEntries(headerEntries);
  } else {
    delete nextInit.headers;
  }

  return nextInit;
}
