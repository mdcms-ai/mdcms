/**
 * Session token from Studio browser sign-in.
 *
 * Studio signs in through a redirect to the MDCMS server and receives a
 * session token, which it sends in the `X-MDCMS-Session` header because the
 * server's session cookie is a third-party cookie on the host site and many
 * browsers do not send it. The token is kept in `localStorage`, keyed by
 * server URL, so other tabs of the same host stay signed in.
 */

export const STUDIO_SESSION_HEADER = "x-mdcms-session";

const STORAGE_KEY_PREFIX = "mdcms.studio.session:";

type StoredStudioSession = {
  token: string;
  expiresAt: string;
};

let activeToken: string | undefined;

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "");
}

function storageKey(serverUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${normalizeServerUrl(serverUrl)}`;
}

function getStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function readStoredSession(serverUrl: string): StoredStudioSession | undefined {
  const raw = getStorage()?.getItem(storageKey(serverUrl));

  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredStudioSession>;

    if (
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.expiresAt === "string" &&
      Date.parse(parsed.expiresAt) > Date.now()
    ) {
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    }
  } catch {
    // A malformed entry is treated as no session.
  }

  getStorage()?.removeItem(storageKey(serverUrl));
  return undefined;
}

/**
 * Loads the stored token for `serverUrl` so Studio API requests carry it.
 * Called when the runtime mounts.
 */
export function activateStudioSessionToken(serverUrl: string): void {
  activeToken = readStoredSession(serverUrl)?.token;
}

export function getActiveStudioSessionToken(): string | undefined {
  return activeToken;
}

export function hasActiveStudioSessionToken(): boolean {
  return activeToken !== undefined;
}

export function storeStudioSessionToken(
  serverUrl: string,
  session: StoredStudioSession,
): void {
  getStorage()?.setItem(storageKey(serverUrl), JSON.stringify(session));
  activeToken = session.token;
}

export function clearStudioSessionToken(serverUrl: string): void {
  getStorage()?.removeItem(storageKey(serverUrl));
  activeToken = undefined;
}
