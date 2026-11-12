import assert from "node:assert/strict";
import { test as bunTest } from "bun:test";

import { applyStudioAuthToRequestInit } from "../../request-auth.js";
import {
  activateStudioSessionToken,
  clearStudioSessionToken,
  getActiveStudioSessionToken,
} from "../../studio-session-token.js";
import {
  completeStudioSignIn,
  computeS256CodeChallenge,
  createStudioSignInUrl,
  readStudioSignInCallback,
} from "./studio-sign-in.js";

const SERVER_URL = "https://cms.example.com";
const REDIRECT_URI = "http://localhost:3000/admin/login";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const localStorageStub = new MemoryStorage();
const globalWithWindow = globalThis as { window?: unknown };

/**
 * Test files share one process, so each test installs a `window` with an
 * in-memory `localStorage` and restores the original `window` afterwards.
 */
function test(name: string, run: () => void | Promise<void>): void {
  bunTest(name, async () => {
    const hadWindow = "window" in globalWithWindow;
    const originalWindow = globalWithWindow.window;
    globalWithWindow.window = { localStorage: localStorageStub };

    try {
      await run();
    } finally {
      clearStudioSessionToken(SERVER_URL);
      localStorageStub.clear();

      if (hadWindow) {
        globalWithWindow.window = originalWindow;
      } else {
        delete globalWithWindow.window;
      }
    }
  });
}

test("the S256 challenge matches the RFC 7636 test vector", async () => {
  assert.equal(
    await computeS256CodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("the sign-in URL carries the redirect, state and challenge", async () => {
  const storage = new MemoryStorage();
  const url = new URL(
    await createStudioSignInUrl({
      serverUrl: SERVER_URL,
      redirectUri: REDIRECT_URI,
      returnTo: "/admin/content",
      storage,
    }),
  );

  assert.equal(url.origin, SERVER_URL);
  assert.equal(url.pathname, "/api/v1/auth/studio/sign-in");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[\w-]{43}$/);
  assert.equal(storage.length, 1);
  assert.equal(
    readStudioSignInCallback(`?code=abc&state=${url.searchParams.get("state")}`)
      .kind,
    "code",
  );
  assert.deepEqual(readStudioSignInCallback("?returnTo=%2Fadmin"), {
    kind: "none",
  });
});

test("completing sign-in exchanges the code once and stores the session", async () => {
  const storage = new MemoryStorage();
  const url = new URL(
    await createStudioSignInUrl({
      serverUrl: SERVER_URL,
      redirectUri: REDIRECT_URI,
      returnTo: "/admin/content",
      storage,
    }),
  );
  const state = url.searchParams.get("state") ?? "";
  let exchangeBody: Record<string, string> | undefined;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    exchangeBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        data: {
          sessionToken: "token-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const result = await completeStudioSignIn({
    serverUrl: SERVER_URL,
    code: "code-1",
    state,
    storage,
    fetcher,
  });

  assert.equal(result.returnTo, "/admin/content");
  assert.equal(exchangeBody?.code, "code-1");
  assert.equal(exchangeBody?.redirectUri, REDIRECT_URI);
  assert.equal(
    await computeS256CodeChallenge(exchangeBody?.codeVerifier ?? ""),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(getActiveStudioSessionToken(), "token-1");

  // The pending sign-in is consumed: replaying the callback fails.
  await assert.rejects(
    completeStudioSignIn({
      serverUrl: SERVER_URL,
      code: "code-1",
      state,
      storage,
      fetcher,
    }),
    /another tab or has expired/,
  );
});

test("a failed exchange surfaces the server message and stores nothing", async () => {
  const storage = new MemoryStorage();
  const url = new URL(
    await createStudioSignInUrl({
      serverUrl: SERVER_URL,
      redirectUri: REDIRECT_URI,
      returnTo: "/admin",
      storage,
    }),
  );

  await assert.rejects(
    completeStudioSignIn({
      serverUrl: SERVER_URL,
      code: "bad",
      state: url.searchParams.get("state") ?? "",
      storage,
      fetcher: (async () =>
        new Response(
          JSON.stringify({ message: "Studio sign-in code expired." }),
          { status: 410 },
        )) as typeof fetch,
    }),
    /code expired/,
  );
  assert.equal(getActiveStudioSessionToken(), undefined);
});

test("session-mode requests carry the stored session header", () => {
  localStorageStub.setItem(
    `mdcms.studio.session:${SERVER_URL}`,
    JSON.stringify({
      token: "token-2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  activateStudioSessionToken(`${SERVER_URL}/`);

  const cookieInit = applyStudioAuthToRequestInit({ mode: "cookie" });
  assert.equal(cookieInit.credentials, "include");
  assert.deepEqual(cookieInit.headers, { "x-mdcms-session": "token-2" });

  const tokenInit = applyStudioAuthToRequestInit({
    mode: "token",
    token: "mdcms_key_abc",
  });
  assert.deepEqual(tokenInit.headers, {
    authorization: "Bearer mdcms_key_abc",
  });
});

test("expired stored sessions are dropped", () => {
  localStorageStub.setItem(
    `mdcms.studio.session:${SERVER_URL}`,
    JSON.stringify({
      token: "token-3",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  activateStudioSessionToken(SERVER_URL);

  assert.equal(getActiveStudioSessionToken(), undefined);
  assert.equal(localStorageStub.length, 0);
  assert.equal(
    applyStudioAuthToRequestInit({ mode: "cookie" }).headers,
    undefined,
  );
});
