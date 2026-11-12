import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { RuntimeError } from "@mdcms/shared";

/**
 * Studio browser sign-in.
 *
 * Embedded Studio often runs on a different site than the MDCMS server, and
 * browsers that block third-party cookies never send the server's session
 * cookie from that site. Studio therefore signs in through a top-level
 * redirect to the server (where the server's cookie is first-party), receives
 * a one-time code bound to a PKCE challenge, exchanges it for a session token,
 * and sends that token in the `X-MDCMS-Session` header on every API request.
 */

export const STUDIO_SESSION_HEADER = "x-mdcms-session";
export const STUDIO_SIGN_IN_PATH = "/api/v1/auth/studio/sign-in";
export const STUDIO_SIGN_IN_EXCHANGE_PATH =
  "/api/v1/auth/studio/sign-in/exchange";
export const STUDIO_SIGN_IN_CODE_TTL_MS = 2 * 60 * 1000;

const STUDIO_SIGN_IN_CODE_IDENTIFIER_PREFIX = "studio-sign-in:";
const MAX_STATE_LENGTH = 512;
const S256_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Loopback origins implicitly trusted for Studio browser routes when
 * running outside production. The dev-time convenience saves operators
 * from listing both `localhost` and `127.0.0.1` variants of the same
 * port in `MDCMS_STUDIO_ALLOWED_ORIGINS`; production deployments rely
 * exclusively on the env-configured allowlist.
 */
const STUDIO_LOOPBACK_DEV_ORIGINS: readonly string[] = [
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

function studioLoopbackEnabled(): boolean {
  // Resolved at request time so test env mutations are honored without
  // restarting the process.
  try {
    return (
      typeof process !== "undefined" && process.env?.NODE_ENV !== "production"
    );
  } catch {
    return false;
  }
}

/**
 * Whether `origin` may embed Studio: listed in `MDCMS_STUDIO_ALLOWED_ORIGINS`,
 * or a development loopback origin outside production.
 */
export function isAllowedStudioOrigin(
  origin: string,
  allowedOrigins: readonly string[],
): boolean {
  return (
    allowedOrigins.includes(origin) ||
    (studioLoopbackEnabled() && STUDIO_LOOPBACK_DEV_ORIGINS.includes(origin))
  );
}

export type StudioSignInParams = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export type StudioSignInCodeRecord = {
  userId: string;
  redirectUri: string;
  codeChallenge: string;
};

function invalidInput(message: string, details?: Record<string, unknown>) {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    ...(details ? { details } : {}),
  });
}

/**
 * Validates the redirect target Studio asked to return to. Only origins that
 * are allowed to embed Studio may receive a sign-in code.
 */
export function assertStudioSignInRedirectUri(
  value: unknown,
  isAllowedOrigin: (origin: string) => boolean,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput('Query parameter "redirect_uri" is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw invalidInput(
      'Query parameter "redirect_uri" must be an absolute URL.',
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidInput(
      'Query parameter "redirect_uri" must use http or https.',
    );
  }

  if (parsed.hash.length > 0 || parsed.username || parsed.password) {
    throw invalidInput(
      'Query parameter "redirect_uri" must not contain a fragment or credentials.',
    );
  }

  if (!isAllowedOrigin(parsed.origin)) {
    throw invalidInput(
      'Query parameter "redirect_uri" must point to an allowed Studio origin.',
      { origin: parsed.origin },
    );
  }

  return parsed.toString();
}

export function parseStudioSignInParams(
  searchParams: URLSearchParams,
  isAllowedOrigin: (origin: string) => boolean,
): StudioSignInParams {
  const redirectUri = assertStudioSignInRedirectUri(
    searchParams.get("redirect_uri"),
    isAllowedOrigin,
  );
  const state = searchParams.get("state")?.trim() ?? "";

  if (state.length === 0 || state.length > MAX_STATE_LENGTH) {
    throw invalidInput(
      `Query parameter "state" is required and must be at most ${MAX_STATE_LENGTH} characters.`,
    );
  }

  const codeChallenge = searchParams.get("code_challenge")?.trim() ?? "";
  const method = searchParams.get("code_challenge_method")?.trim() ?? "";

  if (method !== "S256" || !S256_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw invalidInput(
      'Query parameters "code_challenge" (base64url SHA-256) and "code_challenge_method=S256" are required.',
    );
  }

  return { redirectUri, state, codeChallenge };
}

export function computeS256CodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && CODE_VERIFIER_PATTERN.test(value);
}

export function codeVerifierMatchesChallenge(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const expected = Buffer.from(computeS256CodeChallenge(codeVerifier));
  const actual = Buffer.from(codeChallenge);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Codes are stored only as hashes, under a dedicated identifier prefix. */
export function toStudioSignInCodeIdentifier(code: string): string {
  return `${STUDIO_SIGN_IN_CODE_IDENTIFIER_PREFIX}${createHash("sha256")
    .update(code)
    .digest("hex")}`;
}

export function parseStudioSignInCodeRecord(
  value: string,
): StudioSignInCodeRecord | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StudioSignInCodeRecord>;

    if (
      typeof parsed.userId === "string" &&
      typeof parsed.redirectUri === "string" &&
      typeof parsed.codeChallenge === "string"
    ) {
      return {
        userId: parsed.userId,
        redirectUri: parsed.redirectUri,
        codeChallenge: parsed.codeChallenge,
      };
    }
  } catch {
    // Fall through: a malformed record is treated as an invalid code.
  }

  return undefined;
}

/**
 * Produces the session cookie value Better Auth expects for `token`
 * (`encodeURIComponent("<token>.<base64 HMAC-SHA256>")`), so a session sent in
 * the Studio session header resolves exactly like the cookie would.
 */
export function signSessionTokenForCookie(
  token: string,
  secret: string,
): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");

  return encodeURIComponent(`${token}.${signature}`);
}

export function readStudioSessionHeader(request: Request): string | undefined {
  const value = request.headers.get(STUDIO_SESSION_HEADER)?.trim();

  return value && value.length > 0 ? value : undefined;
}

export function appendStudioSignInResult(
  redirectUri: string,
  params: Record<string, string>,
): string {
  const url = new URL(redirectUri);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}
