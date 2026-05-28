import type { StudioMountContext } from "@mdcms/shared";

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

  const headerEntries = Array.from(headers.entries());

  if (headerEntries.length > 0) {
    nextInit.headers = Object.fromEntries(headerEntries);
  } else {
    delete nextInit.headers;
  }

  return nextInit;
}
