import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "bun:test";

import {
  appendStudioSignInResult,
  assertStudioSignInRedirectUri,
  codeVerifierMatchesChallenge,
  computeS256CodeChallenge,
  isValidCodeVerifier,
  parseStudioSignInCodeRecord,
  parseStudioSignInParams,
  readStudioSessionHeader,
  signSessionTokenForCookie,
  toStudioSignInCodeIdentifier,
} from "./studio-sign-in.js";

const allowOnly =
  (...origins: string[]) =>
  (origin: string) =>
    origins.includes(origin);

// RFC 7636 appendix B test vector.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("redirect URIs must point to an allowed Studio origin", () => {
  const allow = allowOnly("http://localhost:3000");

  assert.equal(
    assertStudioSignInRedirectUri("http://localhost:3000/admin/login", allow),
    "http://localhost:3000/admin/login",
  );

  for (const value of [
    undefined,
    "",
    "/admin/login",
    "https://evil.example/admin/login",
    "javascript:alert(1)",
    "http://localhost:3000/admin/login#fragment",
    "http://user:pass@localhost:3000/admin/login",
  ]) {
    assert.throws(
      () => assertStudioSignInRedirectUri(value, allow),
      (error: { code?: string }) => error.code === "INVALID_INPUT",
      String(value),
    );
  }
});

test("sign-in params require state and an S256 challenge", () => {
  const allow = allowOnly("http://localhost:3000");
  const base = {
    redirect_uri: "http://localhost:3000/admin/login",
    state: "abc",
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: "S256",
  };

  assert.deepEqual(parseStudioSignInParams(new URLSearchParams(base), allow), {
    redirectUri: "http://localhost:3000/admin/login",
    state: "abc",
    codeChallenge: RFC_CHALLENGE,
  });

  for (const override of [
    { state: "" },
    { state: "x".repeat(513) },
    { code_challenge_method: "plain" },
    { code_challenge: "too-short" },
  ]) {
    assert.throws(
      () =>
        parseStudioSignInParams(
          new URLSearchParams({ ...base, ...override }),
          allow,
        ),
      (error: { code?: string }) => error.code === "INVALID_INPUT",
      JSON.stringify(override),
    );
  }
});

test("PKCE challenge and verifier checks follow RFC 7636", () => {
  assert.equal(computeS256CodeChallenge(RFC_VERIFIER), RFC_CHALLENGE);
  assert.equal(codeVerifierMatchesChallenge(RFC_VERIFIER, RFC_CHALLENGE), true);
  assert.equal(
    codeVerifierMatchesChallenge(`${RFC_VERIFIER}x`, RFC_CHALLENGE),
    false,
  );
  assert.equal(isValidCodeVerifier(RFC_VERIFIER), true);
  assert.equal(isValidCodeVerifier("short"), false);
  assert.equal(isValidCodeVerifier(`${RFC_VERIFIER} `), false);
  assert.equal(isValidCodeVerifier(42), false);
});

test("codes are stored as hashes and records parse defensively", () => {
  const identifier = toStudioSignInCodeIdentifier("code-1");

  assert.match(identifier, /^studio-sign-in:[0-9a-f]{64}$/);
  assert.notEqual(identifier, toStudioSignInCodeIdentifier("code-2"));
  assert.equal(identifier.includes("code-1"), false);

  assert.deepEqual(
    parseStudioSignInCodeRecord(
      JSON.stringify({
        userId: "u1",
        redirectUri: "http://localhost:3000/admin/login",
        codeChallenge: RFC_CHALLENGE,
      }),
    ),
    {
      userId: "u1",
      redirectUri: "http://localhost:3000/admin/login",
      codeChallenge: RFC_CHALLENGE,
    },
  );
  assert.equal(parseStudioSignInCodeRecord("not json"), undefined);
  assert.equal(parseStudioSignInCodeRecord('{"userId":1}'), undefined);
});

test("session tokens are signed the way Better Auth signs its cookie", async () => {
  const secret = "test-secret";
  const token = "sessiontoken123";
  // Better Auth (better-call) signs cookies with Web Crypto HMAC-SHA256 and
  // standard base64, then URI-encodes "<value>.<signature>".
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  ).toString("base64");

  assert.equal(
    signSessionTokenForCookie(token, secret),
    encodeURIComponent(`${token}.${signature}`),
  );
});

test("the session header is read trimmed and ignored when empty", () => {
  const request = (value?: string) =>
    new Request("http://localhost/api", {
      headers: value === undefined ? {} : { "x-mdcms-session": value },
    });

  assert.equal(readStudioSessionHeader(request("  tok  ")), "tok");
  assert.equal(readStudioSessionHeader(request("   ")), undefined);
  assert.equal(readStudioSessionHeader(request()), undefined);
});

test("the redirect back to Studio keeps existing query parameters", () => {
  assert.equal(
    appendStudioSignInResult("http://localhost:3000/admin/login?x=1", {
      code: "c",
      state: "s",
    }),
    "http://localhost:3000/admin/login?x=1&code=c&state=s",
  );
});
