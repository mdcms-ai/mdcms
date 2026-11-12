import { storeStudioSessionToken } from "../../studio-session-token.js";

/**
 * Client side of Studio browser sign-in: Studio redirects to the MDCMS
 * server's sign-in page with a PKCE challenge, the server redirects back with
 * a one-time code, and Studio exchanges the code for a session token.
 */

export const STUDIO_SIGN_IN_PATH = "/api/v1/auth/studio/sign-in";
export const STUDIO_SIGN_IN_EXCHANGE_PATH =
  "/api/v1/auth/studio/sign-in/exchange";

const PENDING_SIGN_IN_KEY_PREFIX = "mdcms.studio.sign-in:";

type PendingStudioSignIn = {
  serverUrl: string;
  redirectUri: string;
  codeVerifier: string;
  returnTo: string;
};

export type StudioSignInCallback =
  | { kind: "code"; code: string; state: string }
  | { kind: "none" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function requireWebCrypto(): Crypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "Studio sign-in needs a secure page (https or localhost). Open Studio over https.",
    );
  }

  return crypto;
}

export function createRandomUrlSafeToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  requireWebCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function computeS256CodeChallenge(
  codeVerifier: string,
): Promise<string> {
  const digest = await requireWebCrypto().subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );

  return base64UrlEncode(new Uint8Array(digest));
}

function pendingKey(state: string): string {
  return `${PENDING_SIGN_IN_KEY_PREFIX}${state}`;
}

/**
 * Builds the server sign-in URL and remembers the PKCE verifier for this tab.
 */
export async function createStudioSignInUrl(input: {
  serverUrl: string;
  redirectUri: string;
  returnTo: string;
  storage: Storage;
}): Promise<string> {
  const state = createRandomUrlSafeToken(16);
  const codeVerifier = createRandomUrlSafeToken(32);
  const codeChallenge = await computeS256CodeChallenge(codeVerifier);
  const pending: PendingStudioSignIn = {
    serverUrl: input.serverUrl,
    redirectUri: input.redirectUri,
    codeVerifier,
    returnTo: input.returnTo,
  };

  input.storage.setItem(pendingKey(state), JSON.stringify(pending));

  const url = new URL(STUDIO_SIGN_IN_PATH, input.serverUrl);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

export function readStudioSignInCallback(search: string): StudioSignInCallback {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const code = params.get("code");
  const state = params.get("state");

  return code && state ? { kind: "code", code, state } : { kind: "none" };
}

function readPendingSignIn(
  storage: Storage,
  state: string,
): PendingStudioSignIn | undefined {
  const raw = storage.getItem(pendingKey(state));
  storage.removeItem(pendingKey(state));

  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingStudioSignIn>;

    if (
      typeof parsed.serverUrl === "string" &&
      typeof parsed.redirectUri === "string" &&
      typeof parsed.codeVerifier === "string" &&
      typeof parsed.returnTo === "string"
    ) {
      return parsed as PendingStudioSignIn;
    }
  } catch {
    // Treated as a missing sign-in below.
  }

  return undefined;
}

function readErrorMessage(payload: unknown): string | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return undefined;
}

/**
 * Exchanges the code from the server redirect for a session token and stores
 * it. Returns the Studio path to open next.
 */
export async function completeStudioSignIn(input: {
  serverUrl: string;
  code: string;
  state: string;
  storage: Storage;
  fetcher?: typeof fetch;
}): Promise<{ returnTo: string }> {
  const pending = readPendingSignIn(input.storage, input.state);

  if (!pending || pending.serverUrl !== input.serverUrl) {
    throw new Error(
      "This sign-in was started in another tab or has expired. Sign in again.",
    );
  }

  const fetcher = input.fetcher ?? fetch;
  let response: Response;

  try {
    response = await fetcher(
      new URL(STUDIO_SIGN_IN_EXCHANGE_PATH, input.serverUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
        }),
      },
    );
  } catch {
    throw new Error("Could not reach the MDCMS server. Try again.");
  }

  const payload = (await response.json().catch(() => undefined)) as
    | { data?: { sessionToken?: unknown; expiresAt?: unknown } }
    | undefined;

  if (!response.ok) {
    throw new Error(
      readErrorMessage(payload) ?? "Sign-in failed. Sign in again.",
    );
  }

  const sessionToken = payload?.data?.sessionToken;
  const expiresAt = payload?.data?.expiresAt;

  if (typeof sessionToken !== "string" || typeof expiresAt !== "string") {
    throw new Error("The server returned an unexpected sign-in response.");
  }

  storeStudioSessionToken(input.serverUrl, {
    token: sessionToken,
    expiresAt,
  });

  return { returnTo: pending.returnTo };
}
