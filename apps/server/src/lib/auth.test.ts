import assert from "node:assert/strict";
import { test } from "bun:test";

import { createConsoleLogger } from "@mdcms/shared";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";

import {
  buildStaticSamlProviders,
  buildStaticSsoPluginOptions,
  buildStaticOidcProviders,
  mapSsoCallbackErrorCode,
  resolveApiKeyRbacAction,
  resolveStartupOidcProviders,
  validateSsoSignInPayload,
  validateSsoRedirectUrl,
} from "./auth.js";
import {
  OIDC_FIXTURE_PROVIDER_IDS,
  createMissingEmailOidcFixture,
  createMissingSubOidcFixture,
  createOidcEnv,
  createOidcFixture,
  normalizeOidcFixtureClaims,
  startMockOidcProvider,
} from "./auth-oidc-fixtures.js";
import {
  createSamlEnv,
  createSamlProviderConfig,
  createSamlResponseFixture,
  decodeSamlSignInRedirect,
  SAML_TEST_NOW_MS,
} from "./auth-saml-fixtures.js";
import {
  apiKeys,
  authAccounts,
  authLoginBackoffs,
  authSessions,
  authUsers,
  cliLoginChallenges,
  environments,
  projects,
  rbacGrants,
} from "./db/schema.js";
import { createServerRequestHandlerWithModules } from "./runtime-with-modules.js";

const env = {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  APP_VERSION: "9.9.9",
  PORT: "4000",
  SERVICE_NAME: "mdcms-server",
  DATABASE_URL: "postgres://mdcms:mdcms@localhost:5432/mdcms",
} as NodeJS.ProcessEnv;

const logger = createConsoleLogger({
  level: "error",
  sink: () => undefined,
});

async function canConnectToDatabase(): Promise<boolean> {
  const client = postgres(env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
    connect_timeout: 1,
    max: 1,
  });

  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const dbAvailable = await canConnectToDatabase();
const testWithDatabase = dbAvailable ? test : test.skip;

async function ensureAuthLoginBackoffTable(): Promise<void> {
  const client = postgres(env.DATABASE_URL ?? "", {
    onnotice: () => undefined,
    connect_timeout: 1,
    max: 1,
  });

  try {
    await client`
      CREATE TABLE IF NOT EXISTS auth_login_backoffs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        login_key text NOT NULL,
        failure_count integer DEFAULT 0 NOT NULL,
        first_failed_at timestamp with time zone NOT NULL,
        last_failed_at timestamp with time zone NOT NULL,
        next_allowed_at timestamp with time zone NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL,
        updated_at timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT uniq_auth_login_backoffs_login_key UNIQUE (login_key)
      )
    `;
    await client`
      CREATE INDEX IF NOT EXISTS idx_auth_login_backoffs_next_allowed
      ON auth_login_backoffs USING btree (next_allowed_at)
    `;
  } finally {
    await client.end({ timeout: 1 });
  }
}

test("auth oidc provider config builds static Better Auth providers", () => {
  const providers = buildStaticOidcProviders("http://localhost:4000", [
    {
      providerId: "okta",
      issuer: "https://example.okta.com/oauth2/default",
      domain: "example.com",
      clientId: "okta-client-id",
      clientSecret: "okta-client-secret",
      scopes: ["openid", "email", "profile"],
      trustedOrigins: ["https://issuer-fixture.example"],
      discoveryOverrides: {
        authorizationEndpoint: "https://issuer-fixture.example/authorize",
        tokenEndpoint: "https://issuer-fixture.example/token",
        userInfoEndpoint: "https://issuer-fixture.example/userinfo",
        jwksUri: "https://issuer-fixture.example/jwks",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    },
  ]);

  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0], {
    providerId: "okta",
    domain: "example.com",
    oidcConfig: {
      issuer: "https://example.okta.com/oauth2/default",
      discoveryEndpoint:
        "https://example.okta.com/oauth2/default/.well-known/openid-configuration",
      clientId: "okta-client-id",
      clientSecret: "okta-client-secret",
      pkce: true,
      scopes: ["openid", "email", "profile"],
      authorizationEndpoint: "https://issuer-fixture.example/authorize",
      tokenEndpoint: "https://issuer-fixture.example/token",
      userInfoEndpoint: "https://issuer-fixture.example/userinfo",
      jwksEndpoint: "https://issuer-fixture.example/jwks",
      tokenEndpointAuthentication: "client_secret_post",
      mapping: {
        id: "sub",
        email: "email",
        emailVerified: "email_verified",
        name: "name",
        image: "picture",
        extraFields: {
          givenName: "given_name",
          familyName: "family_name",
          preferredUsername: "preferred_username",
        },
      },
    },
  });
});

test("auth oidc redirect validation allows only relative and same-origin URLs", () => {
  assert.equal(
    validateSsoRedirectUrl("/studio", "callbackURL", "http://localhost:4000"),
    "/studio",
  );
  assert.equal(
    validateSsoRedirectUrl(
      "http://localhost:4000/studio?tab=users",
      "callbackURL",
      "http://localhost:4000",
    ),
    "http://localhost:4000/studio?tab=users",
  );
  assert.throws(
    () =>
      validateSsoRedirectUrl(
        "https://evil.example/callback",
        "callbackURL",
        "http://localhost:4000",
      ),
    /callbackURL/,
  );
});

test("auth oidc callback error mapping recognizes missing required claims", () => {
  assert.equal(
    mapSsoCallbackErrorCode(
      "http://localhost:4000/studio?error=invalid_provider&error_description=missing_user_info",
    )?.code,
    "AUTH_OIDC_REQUIRED_CLAIM_MISSING",
  );
  assert.equal(
    mapSsoCallbackErrorCode(
      "http://localhost:4000/studio?error=discovery_failed&error_description=timeout",
    )?.code,
    "AUTH_PROVIDER_ERROR",
  );
  assert.equal(
    mapSsoCallbackErrorCode("http://localhost:4000/studio"),
    undefined,
  );
});

test("auth oidc startup resolution hydrates discovery metadata before boot", async () => {
  const fixture = createOidcFixture("okta");
  const provider = await startMockOidcProvider(fixture.claims, {
    clientId: fixture.providerConfig.clientId,
  });

  try {
    const [resolved] = await resolveStartupOidcProviders([
      {
        ...fixture.providerConfig,
        issuer: provider.issuer,
        discoveryOverrides: undefined,
      },
    ]);

    assert.equal(
      resolved?.discoveryOverrides?.authorizationEndpoint,
      provider.authorizationEndpoint,
    );
    assert.equal(
      resolved?.discoveryOverrides?.tokenEndpoint,
      provider.tokenEndpoint,
    );
    assert.equal(resolved?.discoveryOverrides?.jwksUri, provider.jwksEndpoint);
  } finally {
    await provider.close();
  }
});

test("auth oidc static provider build rejects unresolved discovery metadata", () => {
  const fixture = createOidcFixture("okta");

  assert.throws(
    () =>
      buildStaticOidcProviders("http://localhost:4000", [
        {
          ...fixture.providerConfig,
          discoveryOverrides: undefined,
        },
      ]),
    /discovery/i,
  );
});

test("auth oidc sign-in payload rejects unsupported Better Auth fields", () => {
  assert.throws(
    () =>
      validateSsoSignInPayload(
        {
          providerId: "okta",
          callbackURL: "/studio",
          scopes: ["offline_access"],
        },
        "http://localhost:4000",
        new Set(["okta"]),
      ),
    /invalid/i,
  );
});

test("auth sso sign-in payload accepts configured SAML provider ids", () => {
  const options = buildStaticSsoPluginOptions(
    "http://localhost:4000",
    [],
    [createSamlProviderConfig()],
  );

  const payload = validateSsoSignInPayload(
    {
      providerId: "okta-saml",
      callbackURL: "/studio",
    },
    "http://localhost:4000",
    new Set((options.defaultSSO ?? []).map((provider) => provider.providerId)),
  );

  assert.equal(payload.providerId, "okta-saml");
});

test("auth sso provider-not-configured errors are protocol-neutral", () => {
  assert.throws(
    () =>
      validateSsoSignInPayload(
        {
          providerId: "missing-saml",
          callbackURL: "/studio",
        },
        "http://localhost:4000",
        new Set(["okta-saml"]),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'SSO provider "missing-saml" is not configured.',
  );

  assert.equal(
    mapSsoCallbackErrorCode(
      "http://localhost:4000/studio?error=discovery_failed&error_description=timeout",
    )?.message,
    "SSO provider callback failed.",
  );
});

test("auth saml provider config builds static Better Auth providers and required protections", () => {
  const providerConfig = createSamlProviderConfig({
    authnRequestsSigned: true,
  });
  const providers = buildStaticSamlProviders("http://localhost:4000", [
    providerConfig,
  ]);
  const options = buildStaticSsoPluginOptions(
    "http://localhost:4000",
    [],
    [providerConfig],
  );

  assert.equal(providers.length, 1);
  assert.deepEqual(providers[0], {
    providerId: "okta-saml",
    domain: "example.com",
    samlConfig: {
      issuer: "https://www.okta.com/exk123456789",
      entryPoint: "https://example.okta.com/app/example/sso/saml",
      cert: providerConfig.cert,
      callbackUrl:
        "http://localhost:4000/api/v1/auth/sso/saml2/sp/acs/okta-saml",
      audience: "https://cms.example.com/saml/okta-saml/sp",
      spMetadata: {
        entityID: "https://cms.example.com/saml/okta-saml/sp",
      },
      identifierFormat:
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      authnRequestsSigned: true,
      wantAssertionsSigned: true,
      mapping: {
        id: "nameID",
        email: "email",
        name: "displayName",
        firstName: "givenName",
        lastName: "surname",
      },
    },
  });
  assert.deepEqual(options.saml, {
    enableInResponseToValidation: true,
    allowIdpInitiated: false,
    requireTimestamps: true,
  });
});

for (const providerId of OIDC_FIXTURE_PROVIDER_IDS) {
  test(`auth oidc fixture ${providerId} normalizes canonical user fields`, () => {
    const fixture = createOidcFixture(providerId);
    const providers = buildStaticOidcProviders("http://localhost:4000", [
      fixture.providerConfig,
    ]);

    assert.equal(providers[0]?.providerId, providerId);
    assert.deepEqual(normalizeOidcFixtureClaims(fixture.claims), fixture.user);
  });
}

test("auth oidc fixture rejects missing email claims", () => {
  const fixture = createMissingEmailOidcFixture("okta");

  assert.throws(() => normalizeOidcFixtureClaims(fixture.claims), /email/i);
});

test("auth oidc fixture rejects missing sub claims", () => {
  const fixture = createMissingSubOidcFixture("okta");

  assert.throws(() => normalizeOidcFixtureClaims(fixture.claims), /sub/i);
});

test("resolveApiKeyRbacAction rejects unmapped API key scopes", () => {
  assert.throws(
    () => resolveApiKeyRbacAction("media:upload"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "FORBIDDEN",
  );
});

if (dbAvailable) {
  await ensureAuthLoginBackoffTable();
}

async function withMockedNow<T>(
  value: number,
  run: () => Promise<T>,
): Promise<T> {
  const OriginalDate = Date;
  class MockDate extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(value);
        return;
      }

      switch (args.length) {
        case 1:
          super(args[0]);
          return;
        case 2:
          super(args[0], args[1]);
          return;
        case 3:
          super(args[0], args[1], args[2]);
          return;
        case 4:
          super(args[0], args[1], args[2], args[3]);
          return;
        case 5:
          super(args[0], args[1], args[2], args[3], args[4]);
          return;
        case 6:
          super(args[0], args[1], args[2], args[3], args[4], args[5]);
          return;
        default:
          super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
      }
    }

    static override now(): number {
      return value;
    }
  }

  MockDate.parse = OriginalDate.parse;
  MockDate.UTC = OriginalDate.UTC;
  globalThis.Date = MockDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

function uniqueEmail(): string {
  return `auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mdcms.local`;
}

function extractSetCookie(response: Response): string {
  const setCookieValues = response.headers.getSetCookie?.();

  if (setCookieValues && setCookieValues.length > 0) {
    return setCookieValues.join(", ");
  }

  const header = response.headers.get("set-cookie");
  assert.ok(header);
  return header;
}

function splitSetCookieHeader(header: string): string[] {
  const values: string[] = [];
  let current = "";
  let index = 0;

  while (index < header.length) {
    const character = header[index];

    if (character === ",") {
      const lower = current.toLowerCase();

      if (lower.includes("expires=") && !lower.includes("gmt")) {
        current += character;
        index += 1;
        continue;
      }

      const trimmed = current.trim();

      if (trimmed.length > 0) {
        values.push(trimmed);
      }

      current = "";
      index += 1;

      if (index < header.length && header[index] === " ") {
        index += 1;
      }

      continue;
    }

    current += character;
    index += 1;
  }

  const trimmed = current.trim();

  if (trimmed.length > 0) {
    values.push(trimmed);
  }

  return values;
}

function toCookieHeader(setCookie: string): string {
  return splitSetCookieHeader(setCookie)
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("; ");
}

function extractCookieValue(
  setCookie: string,
  name: string,
): string | undefined {
  return splitSetCookieHeader(setCookie)
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function startOidcSignIn(
  handler: (request: Request) => Promise<Response>,
  providerId: string,
  callbackURL = "/studio",
): Promise<{
  signInResponse: Response;
  redirectUri: string;
  state: string;
}> {
  const signInResponse = await handler(
    new Request("http://localhost/api/v1/auth/sign-in/sso", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerId,
        callbackURL,
      }),
    }),
  );

  assert.equal(signInResponse.status, 302);
  const location = signInResponse.headers.get("location");
  assert.ok(location);

  const redirect = new URL(location);
  const state = redirect.searchParams.get("state");
  const redirectUri = redirect.searchParams.get("redirect_uri");
  assert.ok(state);
  assert.ok(redirectUri);

  return {
    signInResponse,
    redirectUri,
    state,
  };
}

async function completeOidcCallback(
  handler: (request: Request) => Promise<Response>,
  signInResponse: Response,
  redirectUri: string,
  state: string,
): Promise<Response> {
  return handler(
    new Request(`${redirectUri}?code=mock-code&state=${state}`, {
      headers: {
        cookie: toCookieHeader(extractSetCookie(signInResponse)),
      },
    }),
  );
}

async function startSamlSignIn(
  handler: (request: Request) => Promise<Response>,
  callbackURL = "/studio",
): Promise<{
  cookie?: string;
  signInResponse: Response;
  location: string;
  requestId: string;
  relayState?: string;
}> {
  const signInResponse = await withMockedNow(SAML_TEST_NOW_MS, () =>
    handler(
      new Request("http://localhost:4000/api/v1/auth/sign-in/sso", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providerId: "okta-saml",
          callbackURL,
        }),
      }),
    ),
  );

  assert.equal(signInResponse.status, 302);
  const location = signInResponse.headers.get("location");
  assert.ok(location);
  const decoded = decodeSamlSignInRedirect(location);

  return {
    cookie: signInResponse.headers.get("set-cookie") ?? undefined,
    signInResponse,
    location,
    requestId: decoded.requestId,
    relayState: decoded.relayState,
  };
}

function postSamlAcs(
  handler: (request: Request) => Promise<Response>,
  input: {
    cookie?: string;
    providerId?: string;
    SAMLResponse: string;
    RelayState?: string;
  },
): Promise<Response> {
  const body = new URLSearchParams({
    SAMLResponse: input.SAMLResponse,
  });

  if (input.RelayState) {
    body.set("RelayState", input.RelayState);
  }

  return withMockedNow(SAML_TEST_NOW_MS, () =>
    handler(
      new Request(
        `http://localhost:4000/api/v1/auth/sso/saml2/sp/acs/${input.providerId ?? "okta-saml"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(input.cookie
              ? {
                  cookie: toCookieHeader(input.cookie),
                }
              : {}),
          },
          body,
        },
      ),
    ),
  );
}

function createCsrfHeaders(
  loginResult: {
    cookie: string;
    csrfToken?: string;
    setCookie: string;
  },
  headers: Record<string, string> = {},
): Record<string, string> {
  const csrfToken =
    loginResult.csrfToken ??
    extractCookieValue(loginResult.setCookie, "mdcms_csrf");
  assert.ok(csrfToken);

  return {
    cookie: loginResult.cookie,
    "x-mdcms-csrf-token": csrfToken,
    ...headers,
  };
}

async function signUp(
  handler: (request: Request) => Promise<Response>,
  input: {
    email: string;
    password: string;
    name?: string;
  },
): Promise<void> {
  const response = await handler(
    new Request("http://localhost/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        name: input.name ?? "Admin User",
      }),
    }),
  );

  assert.equal(response.status, 200);
}

async function login(
  handler: (request: Request) => Promise<Response>,
  input: {
    email: string;
    password: string;
  },
): Promise<{
  cookie: string;
  csrfToken?: string;
  setCookie: string;
  session: {
    id: string;
    userId: string;
    email: string;
    issuedAt: string;
    expiresAt: string;
  };
}> {
  const loginResponse = await attemptLogin(handler, input);
  const loginBody = (await loginResponse.json()) as {
    data: {
      csrfToken?: string;
      session: {
        id: string;
        userId: string;
        email: string;
        issuedAt: string;
        expiresAt: string;
      };
    };
  };

  assert.equal(loginResponse.status, 200);
  const setCookie = extractSetCookie(loginResponse);
  return {
    cookie: toCookieHeader(setCookie),
    csrfToken: loginBody.data.csrfToken,
    setCookie,
    session: loginBody.data.session,
  };
}

function attemptLogin(
  handler: (request: Request) => Promise<Response>,
  input: {
    email: string;
    password: string;
  },
): Promise<Response> {
  return handler(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );
}

testWithDatabase(
  "auth oidc sign-in redirects to the configured provider authorization URL",
  async () => {
    const provider = await startMockOidcProvider(
      {
        sub: "oidc-user-1",
        email: "oidc-user@example.com",
        email_verified: true,
        name: "OIDC User",
      },
      {
        clientId: "okta-client-id",
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env),
      logger,
    });

    try {
      const response = await handler(
        new Request("http://localhost/api/v1/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "okta",
            callbackURL: "/studio",
          }),
        }),
      );

      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location);
      assert.equal(location.startsWith(provider.authorizationEndpoint), true);
      assert.ok(extractSetCookie(response));
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

for (const providerId of ["azure-ad", "google-workspace", "auth0"] as const) {
  testWithDatabase(
    `auth oidc sign-in redirects to the configured ${providerId} fixture authorization URL`,
    async () => {
      const fixture = createOidcFixture(providerId);
      const provider = await startMockOidcProvider(fixture.claims, {
        clientId: fixture.providerConfig.clientId,
      });
      const { handler, dbConnection } = createServerRequestHandlerWithModules({
        env: createOidcEnv(provider, env, providerId),
        logger,
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/v1/auth/sign-in/sso", {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              providerId,
              callbackURL: "/studio",
            }),
          }),
        );

        assert.equal(response.status, 302);
        const location = response.headers.get("location");
        assert.ok(location);
        assert.equal(location.startsWith(provider.authorizationEndpoint), true);
      } finally {
        await provider.close();
        await dbConnection.close();
      }
    },
  );
}

for (const providerId of OIDC_FIXTURE_PROVIDER_IDS) {
  testWithDatabase(
    `auth oidc callback persists canonical mapped user fields for ${providerId}`,
    async () => {
      const fixture = createOidcFixture(providerId);
      const claims = {
        ...fixture.claims,
        sub: `${providerId}-oidc-${Date.now()}`,
        email: uniqueEmail(),
      };
      const expectedUser = normalizeOidcFixtureClaims(claims);
      const provider = await startMockOidcProvider(claims, {
        clientId: fixture.providerConfig.clientId,
      });
      const { handler, dbConnection } = createServerRequestHandlerWithModules({
        env: createOidcEnv(provider, env, providerId),
        logger,
      });

      try {
        const { signInResponse, redirectUri, state } = await startOidcSignIn(
          handler,
          providerId,
        );
        const callbackResponse = await completeOidcCallback(
          handler,
          signInResponse,
          redirectUri,
          state,
        );

        assert.equal(callbackResponse.status, 302);
        const callbackLocation = callbackResponse.headers.get("location");
        assert.ok(callbackLocation);
        assert.equal(
          new URL(callbackLocation, "http://localhost").pathname,
          "/studio",
        );
        assert.ok(extractSetCookie(callbackResponse));

        const [account] = await dbConnection.db
          .select({
            userId: authAccounts.userId,
            accountId: authAccounts.accountId,
            providerId: authAccounts.providerId,
          })
          .from(authAccounts)
          .where(
            and(
              eq(authAccounts.providerId, providerId),
              eq(authAccounts.accountId, expectedUser.id),
            ),
          );
        assert.ok(account);

        const [user] = await dbConnection.db
          .select({
            id: authUsers.id,
            email: authUsers.email,
            emailVerified: authUsers.emailVerified,
            name: authUsers.name,
            image: authUsers.image,
          })
          .from(authUsers)
          .where(eq(authUsers.id, account.userId));
        assert.deepEqual(user, {
          id: account.userId,
          email: expectedUser.email,
          emailVerified: expectedUser.emailVerified,
          name: expectedUser.name,
          image: expectedUser.image,
        });
      } finally {
        await provider.close();
        await dbConnection.close();
      }
    },
  );
}

testWithDatabase(
  "auth oidc sign-in rejects unconfigured providers",
  async () => {
    const provider = await startMockOidcProvider(
      {
        sub: "oidc-user-2",
        email: "configured@example.com",
        email_verified: true,
        name: "Configured User",
      },
      {
        clientId: "okta-client-id",
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env),
      logger,
    });

    try {
      const response = await handler(
        new Request("http://localhost/api/v1/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "auth0",
            callbackURL: "/studio",
          }),
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 404);
      assert.equal(body.code, "SSO_PROVIDER_NOT_CONFIGURED");
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth saml sign-in starts from POST /api/v1/auth/sign-in/sso",
  async () => {
    const providerConfig = createSamlProviderConfig();
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createSamlEnv(env),
      logger,
    });

    try {
      const { location } = await startSamlSignIn(handler);
      const redirect = new URL(location);

      assert.equal(
        `${redirect.origin}${redirect.pathname}`,
        providerConfig.entryPoint,
      );
      assert.ok(redirect.searchParams.get("SAMLRequest"));
      assert.ok(redirect.searchParams.get("RelayState"));
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth saml metadata endpoint returns 200 for a configured provider",
  async () => {
    const providerConfig = createSamlProviderConfig();
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createSamlEnv(env),
      logger,
    });

    try {
      const response = await handler(
        new Request(
          "http://localhost:4000/api/v1/auth/sso/saml2/sp/metadata?providerId=okta-saml&format=xml",
        ),
      );
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(
        body,
        new RegExp(
          `entityID="${providerConfig.spEntityId?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
        ),
      );
      assert.match(
        body,
        /Location="http:\/\/localhost:4000\/api\/v1\/auth\/sso\/saml2\/sp\/acs\/okta-saml"/,
      );
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth saml acs success establishes a session and redirects to /studio",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createSamlEnv(env),
      logger,
    });

    try {
      const { cookie, requestId, relayState } = await startSamlSignIn(handler);
      const responseFixture = await createSamlResponseFixture({
        kind: "success",
        requestId,
        relayState,
      });
      const acsResponse = await postSamlAcs(handler, {
        ...responseFixture,
        cookie,
      });

      assert.equal(acsResponse.status, 302);
      const location = acsResponse.headers.get("location");
      assert.ok(location);
      assert.equal(
        new URL(location, "http://localhost:4000").pathname,
        "/studio",
      );

      const sessionResponse = await withMockedNow(SAML_TEST_NOW_MS, () =>
        handler(
          new Request("http://localhost:4000/api/v1/auth/session", {
            headers: {
              cookie: toCookieHeader(extractSetCookie(acsResponse)),
            },
          }),
        ),
      );

      assert.equal(sessionResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth saml falls back to NameID when it is a usable email address",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createSamlEnv(env, {
        attributeMapping: {
          id: "customId",
          email: "customMail",
        },
      }),
      logger,
    });

    try {
      const { cookie, requestId, relayState } = await startSamlSignIn(handler);
      const responseFixture = await createSamlResponseFixture({
        kind: "nameid-email-fallback",
        requestId,
        relayState,
      });
      const acsResponse = await postSamlAcs(handler, {
        ...responseFixture,
        cookie,
      });

      assert.equal(acsResponse.status, 302);
      assert.equal(
        new URL(
          acsResponse.headers.get("location") ?? "",
          "http://localhost:4000",
        ).pathname,
        "/studio",
      );
    } finally {
      await dbConnection.close();
    }
  },
);

for (const kind of ["missing-email", "missing-id"] as const) {
  testWithDatabase(
    `auth saml ${kind} responses map to AUTH_SAML_REQUIRED_ATTRIBUTE_MISSING`,
    async () => {
      const { handler, dbConnection } = createServerRequestHandlerWithModules({
        env: createSamlEnv(env),
        logger,
      });

      try {
        const { cookie, requestId, relayState } =
          await startSamlSignIn(handler);
        const responseFixture = await createSamlResponseFixture({
          kind,
          requestId,
          relayState,
        });
        const acsResponse = await postSamlAcs(handler, {
          ...responseFixture,
          cookie,
        });
        const body = (await acsResponse.json()) as { code: string };

        assert.equal(acsResponse.status, 401);
        assert.equal(body.code, "AUTH_SAML_REQUIRED_ATTRIBUTE_MISSING");
      } finally {
        await dbConnection.close();
      }
    },
  );
}

testWithDatabase("auth saml acs rejects an unconfigured provider", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env: createSamlEnv(env),
    logger,
  });

  try {
    const { cookie, requestId, relayState } = await startSamlSignIn(handler);
    const responseFixture = await createSamlResponseFixture({
      kind: "success",
      requestId,
      relayState,
    });
    const acsResponse = await postSamlAcs(handler, {
      ...responseFixture,
      cookie,
      providerId: "missing-saml",
    });
    const body = (await acsResponse.json()) as { code: string };

    assert.equal(acsResponse.status, 404);
    assert.equal(body.code, "SSO_PROVIDER_NOT_CONFIGURED");
  } finally {
    await dbConnection.close();
  }
});

testWithDatabase("auth saml unsolicited responses are rejected", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env: createSamlEnv(env),
    logger,
  });

  try {
    const responseFixture = await createSamlResponseFixture({
      kind: "unsolicited",
    });
    const acsResponse = await postSamlAcs(handler, responseFixture);
    const body = (await acsResponse.json()) as { code: string };

    assert.equal(acsResponse.status, 502);
    assert.equal(body.code, "AUTH_PROVIDER_ERROR");
  } finally {
    await dbConnection.close();
  }
});

testWithDatabase("auth saml replayed assertions are rejected", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env: createSamlEnv(env),
    logger,
  });

  try {
    const { cookie, requestId, relayState } = await startSamlSignIn(handler);
    const responseFixture = await createSamlResponseFixture({
      kind: "success",
      requestId,
      relayState,
    });
    const firstResponse = await postSamlAcs(handler, {
      ...responseFixture,
      cookie,
    });

    assert.equal(firstResponse.status, 302);

    const replayResponse = await postSamlAcs(handler, {
      ...responseFixture,
      cookie,
    });
    const replayBody = (await replayResponse.json()) as { code: string };

    assert.equal(replayResponse.status, 502);
    assert.equal(replayBody.code, "AUTH_PROVIDER_ERROR");
  } finally {
    await dbConnection.close();
  }
});

testWithDatabase(
  "auth oidc callback does not implicitly link to an existing local user with the same email",
  async () => {
    const localEmail = uniqueEmail();
    const provider = await startMockOidcProvider(
      {
        sub: `okta-local-link-${Date.now()}`,
        email: localEmail,
        email_verified: true,
        name: "OIDC User",
      },
      {
        clientId: "okta-client-id",
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env),
      logger,
    });

    try {
      await signUp(handler, {
        email: localEmail,
        password: "Admin12345!",
      });

      const [localUser] = await dbConnection.db
        .select({
          id: authUsers.id,
        })
        .from(authUsers)
        .where(eq(authUsers.email, localEmail));
      assert.ok(localUser);

      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        handler,
        "okta",
      );
      const callbackResponse = await completeOidcCallback(
        handler,
        signInResponse,
        redirectUri,
        state,
      );

      assert.notEqual(callbackResponse.status, 302);

      const linkedAccounts = await dbConnection.db
        .select({
          id: authAccounts.id,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, localUser.id),
            eq(authAccounts.providerId, "okta"),
          ),
        );

      assert.equal(linkedAccounts.length, 0);
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback uses userinfo-only fallback claims when the id token omits them",
  async () => {
    const providerId = "auth0";
    const email = uniqueEmail();
    const sub = `auth0-userinfo-only-${Date.now()}`;
    const provider = await startMockOidcProvider(
      {
        sub,
        email,
        email_verified: true,
      },
      {
        clientId: "auth0-client-id",
        userInfoClaims: {
          sub,
          email,
          email_verified: true,
          preferred_username: "Fixture User",
          picture: "https://fixtures.mdcms.local/userinfo-avatar.png",
        },
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env, providerId),
      logger,
    });

    try {
      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        handler,
        providerId,
      );
      const callbackResponse = await completeOidcCallback(
        handler,
        signInResponse,
        redirectUri,
        state,
      );

      assert.equal(callbackResponse.status, 302);

      const [account] = await dbConnection.db
        .select({
          userId: authAccounts.userId,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, providerId),
            eq(authAccounts.accountId, sub),
          ),
        );
      assert.ok(account);

      const [user] = await dbConnection.db
        .select({
          name: authUsers.name,
          image: authUsers.image,
        })
        .from(authUsers)
        .where(eq(authUsers.id, account.userId));

      assert.deepEqual(user, {
        name: "Fixture User",
        image: "https://fixtures.mdcms.local/userinfo-avatar.png",
      });
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback defaults emailVerified to false when providers omit email_verified on repeat login",
  async () => {
    const providerId = "auth0";
    const sub = `auth0-repeat-email-verified-${Date.now()}`;
    const email = uniqueEmail();

    const firstProvider = await startMockOidcProvider(
      {
        sub,
        email,
        email_verified: true,
        name: "First Login",
      },
      {
        clientId: "auth0-client-id",
      },
    );
    const firstBundle = createServerRequestHandlerWithModules({
      env: createOidcEnv(firstProvider, env, providerId),
      logger,
    });

    try {
      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        firstBundle.handler,
        providerId,
      );
      const callbackResponse = await completeOidcCallback(
        firstBundle.handler,
        signInResponse,
        redirectUri,
        state,
      );

      assert.equal(callbackResponse.status, 302);
    } finally {
      await firstProvider.close();
      await firstBundle.dbConnection.close();
    }

    const secondProvider = await startMockOidcProvider(
      {
        sub,
        email,
        name: "Second Login",
      },
      {
        clientId: "auth0-client-id",
        userInfoClaims: {
          sub,
          email,
          name: "Second Login",
        },
      },
    );
    const secondBundle = createServerRequestHandlerWithModules({
      env: createOidcEnv(secondProvider, env, providerId),
      logger,
    });

    try {
      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        secondBundle.handler,
        providerId,
      );
      const callbackResponse = await completeOidcCallback(
        secondBundle.handler,
        signInResponse,
        redirectUri,
        state,
      );

      assert.equal(callbackResponse.status, 302);

      const [account] = await secondBundle.dbConnection.db
        .select({
          userId: authAccounts.userId,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, providerId),
            eq(authAccounts.accountId, sub),
          ),
        );
      assert.ok(account);

      const [user] = await secondBundle.dbConnection.db
        .select({
          emailVerified: authUsers.emailVerified,
          name: authUsers.name,
        })
        .from(authUsers)
        .where(eq(authUsers.id, account.userId));

      assert.deepEqual(user, {
        emailVerified: false,
        name: "Second Login",
      });
    } finally {
      await secondProvider.close();
      await secondBundle.dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback maps missing sub claims to a deterministic auth error",
  async () => {
    const fixture = createMissingSubOidcFixture("auth0");
    const provider = await startMockOidcProvider(fixture.claims, {
      clientId: fixture.providerConfig.clientId,
    });
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env, "auth0"),
      logger,
    });

    try {
      const signInResponse = await handler(
        new Request("http://localhost/api/v1/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "auth0",
            callbackURL: "/studio",
          }),
        }),
      );

      assert.equal(signInResponse.status, 302);
      const location = signInResponse.headers.get("location");
      assert.ok(location);

      const redirect = new URL(location);
      const state = redirect.searchParams.get("state");
      const redirectUri = redirect.searchParams.get("redirect_uri");
      assert.ok(state);
      assert.ok(redirectUri);

      const callbackResponse = await handler(
        new Request(`${redirectUri}?code=mock-code&state=${state}`, {
          headers: {
            cookie: toCookieHeader(extractSetCookie(signInResponse)),
          },
        }),
      );
      const body = (await callbackResponse.json()) as { code: string };

      assert.equal(callbackResponse.status, 401);
      assert.equal(body.code, "AUTH_OIDC_REQUIRED_CLAIM_MISSING");
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback rejects whitespace-only email claims without persisting auth rows",
  async () => {
    const fixture = createOidcFixture("auth0");
    const claims = {
      ...fixture.claims,
      sub: `auth0-whitespace-email-${Date.now()}`,
      email: " ".repeat(3 + (Date.now() % 7)),
    };
    const provider = await startMockOidcProvider(claims, {
      clientId: fixture.providerConfig.clientId,
    });
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env, "auth0"),
      logger,
    });

    try {
      const existingAccounts = await dbConnection.db
        .select({
          id: authAccounts.id,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, "auth0"),
            eq(authAccounts.accountId, claims.sub),
          ),
        );
      const existingUsers = await dbConnection.db
        .select({
          id: authUsers.id,
        })
        .from(authUsers)
        .where(eq(authUsers.email, claims.email));
      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        handler,
        "auth0",
      );
      const callbackResponse = await completeOidcCallback(
        handler,
        signInResponse,
        redirectUri,
        state,
      );
      const body = (await callbackResponse.json()) as { code: string };

      assert.equal(callbackResponse.status, 401);
      assert.equal(body.code, "AUTH_OIDC_REQUIRED_CLAIM_MISSING");

      const accounts = await dbConnection.db
        .select({
          id: authAccounts.id,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, "auth0"),
            eq(authAccounts.accountId, claims.sub),
          ),
        );
      const users = await dbConnection.db
        .select({
          id: authUsers.id,
        })
        .from(authUsers)
        .where(eq(authUsers.email, claims.email));

      assert.equal(accounts.length, existingAccounts.length);
      assert.equal(users.length, existingUsers.length);
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback rejects whitespace-only sub claims without persisting auth rows",
  async () => {
    const fixture = createOidcFixture("auth0");
    const claims = {
      ...fixture.claims,
      sub: " ".repeat(3 + (Date.now() % 7)),
      email: uniqueEmail(),
    };
    const provider = await startMockOidcProvider(claims, {
      clientId: fixture.providerConfig.clientId,
    });
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env, "auth0"),
      logger,
    });

    try {
      const existingAccounts = await dbConnection.db
        .select({
          id: authAccounts.id,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, "auth0"),
            eq(authAccounts.accountId, claims.sub),
          ),
        );
      const existingUsers = await dbConnection.db
        .select({
          id: authUsers.id,
        })
        .from(authUsers)
        .where(eq(authUsers.email, claims.email));
      const { signInResponse, redirectUri, state } = await startOidcSignIn(
        handler,
        "auth0",
      );
      const callbackResponse = await completeOidcCallback(
        handler,
        signInResponse,
        redirectUri,
        state,
      );
      const body = (await callbackResponse.json()) as { code: string };

      assert.equal(callbackResponse.status, 401);
      assert.equal(body.code, "AUTH_OIDC_REQUIRED_CLAIM_MISSING");

      const accounts = await dbConnection.db
        .select({
          id: authAccounts.id,
        })
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.providerId, "auth0"),
            eq(authAccounts.accountId, claims.sub),
          ),
        );
      const users = await dbConnection.db
        .select({
          id: authUsers.id,
        })
        .from(authUsers)
        .where(eq(authUsers.email, claims.email));

      assert.equal(accounts.length, existingAccounts.length);
      assert.equal(users.length, existingUsers.length);
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc sign-in rejects callback URLs outside the server origin",
  async () => {
    const provider = await startMockOidcProvider(
      {
        sub: "oidc-user-3",
        email: "callback@example.com",
        email_verified: true,
        name: "Callback User",
      },
      {
        clientId: "okta-client-id",
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env),
      logger,
    });

    try {
      const response = await handler(
        new Request("http://localhost/api/v1/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "okta",
            callbackURL: "https://evil.example/callback",
          }),
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 400);
      assert.equal(body.code, "INVALID_INPUT");
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth oidc callback maps missing required claims to a deterministic auth error",
  async () => {
    const provider = await startMockOidcProvider(
      {
        sub: "oidc-user-4",
        email_verified: true,
        name: "Missing Email User",
      },
      {
        clientId: "okta-client-id",
      },
    );
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: createOidcEnv(provider, env),
      logger,
    });

    try {
      const signInResponse = await handler(
        new Request("http://localhost/api/v1/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "okta",
            callbackURL: "/studio",
          }),
        }),
      );

      assert.equal(signInResponse.status, 302);
      const location = signInResponse.headers.get("location");
      assert.ok(location);

      const redirect = new URL(location);
      const state = redirect.searchParams.get("state");
      const redirectUri = redirect.searchParams.get("redirect_uri");
      assert.ok(state);
      assert.ok(redirectUri);

      const callbackResponse = await handler(
        new Request(`${redirectUri}?code=mock-code&state=${state}`, {
          headers: {
            cookie: toCookieHeader(extractSetCookie(signInResponse)),
          },
        }),
      );
      const body = (await callbackResponse.json()) as { code: string };

      assert.equal(callbackResponse.status, 401);
      assert.equal(body.code, "AUTH_OIDC_REQUIRED_CLAIM_MISSING");
    } finally {
      await provider.close();
      await dbConnection.close();
    }
  },
);

async function seedScope(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  scope: {
    project: string;
    environment: string;
  },
): Promise<void> {
  await db
    .insert(projects)
    .values({
      name: scope.project,
      slug: scope.project,
      createdBy: "00000000-0000-0000-0000-000000000001",
    })
    .onConflictDoNothing();

  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, scope.project),
  });
  assert.ok(project);

  await db
    .insert(environments)
    .values({
      projectId: project.id,
      name: scope.environment,
      description: null,
      createdBy: "00000000-0000-0000-0000-000000000001",
    })
    .onConflictDoNothing();
}

function createSchemaSyncPayload(
  schemaHash: string,
  project = "marketing-site",
) {
  return {
    rawConfigSnapshot: {
      project,
      environments: {
        production: {},
      },
    },
    resolvedSchema: {
      Post: {
        type: "Post",
        directory: "content/posts",
        localized: false,
        fields: {
          title: {
            kind: "string",
            required: true,
            nullable: false,
          },
        },
      },
    },
    schemaHash,
  };
}

testWithDatabase(
  "auth login issues a Studio session cookie and session is retrievable",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      const signUpResponse = await handler(
        new Request("http://localhost/api/v1/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
            name: "Admin User",
          }),
        }),
      );

      assert.equal(signUpResponse.status, 200);

      const loginResponse = await handler(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
          }),
        }),
      );
      const loginBody = (await loginResponse.json()) as {
        data: { session: { email: string } };
      };
      const setCookie = extractSetCookie(loginResponse);
      const cookie = toCookieHeader(setCookie);

      assert.equal(loginResponse.status, 200);
      assert.equal(setCookie.includes("session_token="), true);
      assert.equal(loginBody.data.session.email, email);

      const sessionResponse = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie,
          },
        }),
      );
      const sessionBody = (await sessionResponse.json()) as {
        data: { session: { email: string } };
      };

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.data.session.email, email);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login issues a Studio session with a 7-day rolling inactivity expiry",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });

      const beforeLogin = Date.now();
      const loginResult = await login(handler, { email, password });
      const expiresAt = Date.parse(loginResult.session.expiresAt);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      assert.ok(Number.isFinite(expiresAt));
      assert.ok(expiresAt >= beforeLogin + sevenDaysMs - 30_000);
      assert.ok(expiresAt <= Date.now() + sevenDaysMs + 30_000);
      assert.equal(loginResult.setCookie.includes("Max-Age=604800"), true);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login and session bootstrap issue a CSRF cookie for Studio mutations",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });
      const loginResult = await login(handler, { email, password });
      const loginCsrf = extractCookieValue(loginResult.setCookie, "mdcms_csrf");

      assert.ok(loginCsrf);
      assert.equal(loginResult.csrfToken, loginCsrf);

      const sessionResponse = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie: loginResult.cookie,
          },
        }),
      );
      const sessionBody = (await sessionResponse.json()) as {
        data: { csrfToken?: string };
      };

      assert.equal(sessionResponse.status, 200);
      const sessionCsrf = extractCookieValue(
        extractSetCookie(sessionResponse),
        "mdcms_csrf",
      );
      assert.ok(sessionCsrf);
      assert.equal(sessionCsrf, loginCsrf);
      assert.equal(sessionBody.data.csrfToken, sessionCsrf);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login cookie uses SameSite=None+Secure by default and SameSite=Lax for insecure override",
  async () => {
    const secureDefaultEmail = uniqueEmail();
    const insecureOverrideEmail = uniqueEmail();
    const password = "Admin12345!";

    const secureHandlerBundle = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const insecureHandlerBundle = createServerRequestHandlerWithModules({
      env: {
        ...env,
        MDCMS_AUTH_INSECURE_COOKIES: "true",
      },
      logger,
    });

    try {
      await signUp(secureHandlerBundle.handler, {
        email: secureDefaultEmail,
        password,
      });
      const secureLogin = await login(secureHandlerBundle.handler, {
        email: secureDefaultEmail,
        password,
      });

      assert.equal(secureLogin.setCookie.includes("HttpOnly"), true);
      assert.equal(secureLogin.setCookie.includes("SameSite=None"), true);
      assert.equal(secureLogin.setCookie.includes("Path=/"), true);
      assert.equal(secureLogin.setCookie.includes("Secure"), true);

      await signUp(insecureHandlerBundle.handler, {
        email: insecureOverrideEmail,
        password,
      });
      const insecureLogin = await login(insecureHandlerBundle.handler, {
        email: insecureOverrideEmail,
        password,
      });

      assert.equal(insecureLogin.setCookie.includes("HttpOnly"), true);
      assert.equal(insecureLogin.setCookie.includes("SameSite=Lax"), true);
      assert.equal(insecureLogin.setCookie.includes("Path=/"), true);
      assert.equal(insecureLogin.setCookie.includes("Secure"), false);
    } finally {
      await secureHandlerBundle.dbConnection.close();
      await insecureHandlerBundle.dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login rejects Studio browser origins outside the allowlist",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: {
        ...env,
        MDCMS_STUDIO_ALLOWED_ORIGINS: "http://localhost:4173",
      },
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });

      const response = await handler(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: {
            origin: "http://localhost:9999",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
          }),
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 403);
      assert.equal(body.code, "FORBIDDEN_ORIGIN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login applies exponential backoff and clears stored state after successful sign-in",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const invalidPassword = "WrongPassword123!";
    const start = Date.parse("2026-03-13T10:00:00.000Z");

    try {
      await signUp(handler, { email, password });

      const firstInvalidResponse = await withMockedNow(start, () =>
        attemptLogin(handler, {
          email,
          password: invalidPassword,
        }),
      );
      const firstInvalidBody = (await firstInvalidResponse.json()) as {
        code: string;
      };

      assert.equal(firstInvalidResponse.status, 401);
      assert.equal(firstInvalidBody.code, "AUTH_INVALID_CREDENTIALS");

      const [storedBackoff] = await dbConnection.db
        .select()
        .from(authLoginBackoffs)
        .where(eq(authLoginBackoffs.loginKey, email.toLowerCase()));
      assert.ok(storedBackoff);
      assert.equal(storedBackoff.failureCount, 1);

      const lockedResponse = await withMockedNow(start, () =>
        attemptLogin(handler, {
          email,
          password: invalidPassword,
        }),
      );
      const lockedBody = (await lockedResponse.json()) as {
        code: string;
      };

      assert.equal(lockedResponse.status, 429);
      assert.equal(lockedBody.code, "AUTH_BACKOFF_ACTIVE");
      assert.equal(lockedResponse.headers.get("retry-after"), "1");

      const secondInvalidResponse = await withMockedNow(start + 1_100, () =>
        attemptLogin(handler, {
          email,
          password: invalidPassword,
        }),
      );
      const secondInvalidBody = (await secondInvalidResponse.json()) as {
        code: string;
      };

      assert.equal(secondInvalidResponse.status, 401);
      assert.equal(secondInvalidBody.code, "AUTH_INVALID_CREDENTIALS");

      await withMockedNow(start + 3_200, () =>
        login(handler, { email, password }),
      );

      const clearedBackoffRows = await dbConnection.db
        .select()
        .from(authLoginBackoffs)
        .where(eq(authLoginBackoffs.loginKey, email.toLowerCase()));
      assert.equal(clearedBackoffRows.length, 0);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login surfaces internal errors when backoff persistence fails",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const invalidPassword = "WrongPassword123!";
    const originalTransaction = dbConnection.db.transaction.bind(
      dbConnection.db,
    );

    try {
      await signUp(handler, { email, password });
      (
        dbConnection.db as typeof dbConnection.db & {
          transaction: typeof dbConnection.db.transaction;
        }
      ).transaction = (async (callback: any, ...args: any[]) =>
        originalTransaction(
          async (tx: any, ...txArgs: any[]) => {
            const originalTxInsert = tx.insert.bind(tx);
            tx.insert = ((table: unknown) => {
              if (table === authLoginBackoffs) {
                throw new Error("forced backoff insert failure");
              }

              return originalTxInsert(
                table as Parameters<typeof originalTxInsert>[0],
              );
            }) as typeof tx.insert;

            return callback(tx, ...txArgs);
          },
          ...args,
        )) as typeof dbConnection.db.transaction;

      const response = await attemptLogin(handler, {
        email,
        password: invalidPassword,
      });
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 500);
      assert.equal(body.code, "INTERNAL_ERROR");
    } finally {
      dbConnection.db.transaction = originalTransaction;
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login surfaces internal errors when provider sign-in throws",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const originalInsert = dbConnection.db.insert.bind(dbConnection.db);

    try {
      await signUp(handler, { email, password });
      (
        dbConnection.db as typeof dbConnection.db & {
          insert: typeof dbConnection.db.insert;
        }
      ).insert = ((table: unknown) => {
        if (table === authSessions) {
          throw new Error("forced auth session insert failure");
        }

        return originalInsert(table as Parameters<typeof originalInsert>[0]);
      }) as typeof dbConnection.db.insert;

      const response = await attemptLogin(handler, {
        email,
        password,
      });
      const body = (await response.json()) as {
        code: string;
      };

      assert.equal(response.status, 500);
      assert.equal(body.code, "INTERNAL_ERROR");
    } finally {
      dbConnection.db.insert = originalInsert;
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth session endpoint is deny-by-default without a valid session",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });

    try {
      const response = await handler(
        new Request("http://localhost/api/v1/auth/session"),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 401);
      assert.equal(body.code, "UNAUTHORIZED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase("auth logout revokes an active session", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });
  const email = uniqueEmail();
  const password = "Admin12345!";

  try {
    await handler(
      new Request("http://localhost/api/v1/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          name: "Admin User",
        }),
      }),
    );

    const loginResult = await login(handler, { email, password });
    const cookie = loginResult.cookie;

    const logoutResponse = await handler(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: createCsrfHeaders(loginResult),
      }),
    );
    const logoutBody = (await logoutResponse.json()) as {
      data: { revoked: boolean };
    };

    assert.equal(logoutResponse.status, 200);
    assert.equal(logoutBody.data.revoked, true);
    assert.equal(extractSetCookie(logoutResponse).includes("Max-Age=0"), true);

    const sessionResponse = await handler(
      new Request("http://localhost/api/v1/auth/session", {
        headers: {
          cookie,
        },
      }),
    );
    const sessionBody = (await sessionResponse.json()) as { code: string };

    assert.equal(sessionResponse.status, 401);
    assert.equal(sessionBody.code, "UNAUTHORIZED");
  } finally {
    await dbConnection.close();
  }
});

testWithDatabase(
  "auth API key creation rejects missing or mismatched CSRF tokens and accepts the issued token",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, {
        email,
        password,
        name: "CSRF Test User",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:csrf-api-key-owner",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();

      const missingHeaderResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: {
            cookie: loginResult.cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "csrf-missing-header",
            scopes: ["content:read"],
            contextAllowlist: [
              { project: "marketing-site", environment: "production" },
            ],
          }),
        }),
      );
      const missingHeaderBody = (await missingHeaderResponse.json()) as {
        code: string;
      };

      assert.equal(missingHeaderResponse.status, 403);
      assert.equal(missingHeaderBody.code, "FORBIDDEN");

      const mismatchedResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: {
            cookie: `${loginResult.cookie}; mdcms_csrf=csrf-cookie-token`,
            "content-type": "application/json",
            "x-mdcms-csrf-token": "csrf-header-token",
          },
          body: JSON.stringify({
            label: "csrf-mismatch",
            scopes: ["content:read"],
            contextAllowlist: [
              { project: "marketing-site", environment: "production" },
            ],
          }),
        }),
      );
      const mismatchedBody = (await mismatchedResponse.json()) as {
        code: string;
      };

      assert.equal(mismatchedResponse.status, 403);
      assert.equal(mismatchedBody.code, "FORBIDDEN");

      const csrfToken = extractCookieValue(loginResult.setCookie, "mdcms_csrf");
      assert.ok(csrfToken);

      const matchingResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: {
            cookie: loginResult.cookie,
            "content-type": "application/json",
            "x-mdcms-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            label: "csrf-match",
            scopes: ["content:read"],
            contextAllowlist: [
              { project: "marketing-site", environment: "production" },
            ],
          }),
        }),
      );

      assert.equal(matchingResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth logout clears the CSRF cookie alongside the session cookie",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, {
        email,
        password,
        name: "Logout CSRF User",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });

      const logoutResponse = await handler(
        new Request("http://localhost/api/v1/auth/logout", {
          method: "POST",
          headers: createCsrfHeaders(loginResult),
        }),
      );
      const logoutSetCookie = extractSetCookie(logoutResponse);

      assert.equal(logoutResponse.status, 200);
      assert.equal(logoutSetCookie.includes("mdcms_csrf="), true);
      assert.equal(logoutSetCookie.includes("Max-Age=0"), true);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth session expires after inactivity timeout semantics are enforced",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });
      const { cookie, session } = await login(handler, { email, password });

      await dbConnection.db
        .update(authSessions)
        .set({
          expiresAt: new Date(Date.now() - 60_000),
        })
        .where(eq(authSessions.id, session.id));

      const response = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie,
          },
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 401);
      assert.equal(body.code, "UNAUTHORIZED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth session is rejected after absolute max age and removed from storage",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });
      const { cookie, session } = await login(handler, { email, password });

      await dbConnection.db
        .update(authSessions)
        .set({
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where(eq(authSessions.id, session.id));

      const response = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie,
          },
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 401);
      assert.equal(body.code, "UNAUTHORIZED");

      const rows = await dbConnection.db
        .select({
          id: authSessions.id,
        })
        .from(authSessions)
        .where(eq(authSessions.id, session.id));

      assert.equal(rows.length, 0);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "native get-session route enforces absolute max age policy",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });
      const { cookie, session } = await login(handler, { email, password });

      await dbConnection.db
        .update(authSessions)
        .set({
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where(eq(authSessions.id, session.id));

      const response = await handler(
        new Request("http://localhost/api/v1/auth/get-session", {
          headers: {
            cookie,
          },
        }),
      );
      const body = (await response.json()) as { code: string };

      assert.equal(response.status, 401);
      assert.equal(body.code, "UNAUTHORIZED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "auth login preserves existing sessions for the same user",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email, password });
      const firstLogin = await login(handler, { email, password });
      const secondLogin = await login(handler, { email, password });

      assert.notEqual(firstLogin.session.id, secondLogin.session.id);

      const currentSessionResponse = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie: secondLogin.cookie,
          },
        }),
      );
      const currentSessionBody = (await currentSessionResponse.json()) as {
        data: { session: { id: string; email: string } };
      };

      assert.equal(currentSessionResponse.status, 200);
      assert.equal(currentSessionBody.data.session.id, secondLogin.session.id);
      assert.equal(currentSessionBody.data.session.email, email);

      const firstSessionResponse = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie: firstLogin.cookie,
          },
        }),
      );
      const firstSessionBody = (await firstSessionResponse.json()) as {
        data: { session: { id: string; email: string } };
      };

      assert.equal(firstSessionResponse.status, 200);
      assert.equal(firstSessionBody.data.session.id, firstLogin.session.id);
      assert.equal(firstSessionBody.data.session.email, email);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "admin revoke-all endpoint enforces authz and revokes target sessions",
  async () => {
    const adminEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const targetEmail = uniqueEmail();
    const password = "Admin12345!";
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env: {
        ...env,
        MDCMS_AUTH_ADMIN_EMAILS: adminEmail,
      },
      logger,
    });

    try {
      await signUp(handler, {
        email: adminEmail,
        password,
        name: "Owner User",
      });
      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Editor User",
      });
      await signUp(handler, {
        email: targetEmail,
        password,
        name: "Target User",
      });

      const adminLogin = await login(handler, {
        email: adminEmail,
        password,
      });
      const editorLogin = await login(handler, {
        email: editorEmail,
        password,
      });
      const targetLogin = await login(handler, {
        email: targetEmail,
        password,
      });

      const unauthenticatedResponse = await handler(
        new Request(
          "http://localhost/api/v1/auth/users/non-existent/sessions/revoke-all",
          {
            method: "POST",
          },
        ),
      );
      const unauthenticatedBody = (await unauthenticatedResponse.json()) as {
        code: string;
      };
      assert.equal(unauthenticatedResponse.status, 401);
      assert.equal(unauthenticatedBody.code, "UNAUTHORIZED");

      const forbiddenResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/users/${targetLogin.session.userId}/sessions/revoke-all`,
          {
            method: "POST",
            headers: createCsrfHeaders(editorLogin),
          },
        ),
      );
      const forbiddenBody = (await forbiddenResponse.json()) as {
        code: string;
      };
      assert.equal(forbiddenResponse.status, 403);
      assert.equal(forbiddenBody.code, "FORBIDDEN");

      const notFoundResponse = await handler(
        new Request(
          "http://localhost/api/v1/auth/users/user-not-found/sessions/revoke-all",
          {
            method: "POST",
            headers: createCsrfHeaders(adminLogin),
          },
        ),
      );
      const notFoundBody = (await notFoundResponse.json()) as { code: string };
      assert.equal(notFoundResponse.status, 404);
      assert.equal(notFoundBody.code, "NOT_FOUND");

      const revokeResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/users/${targetLogin.session.userId}/sessions/revoke-all`,
          {
            method: "POST",
            headers: createCsrfHeaders(adminLogin),
          },
        ),
      );
      const revokeBody = (await revokeResponse.json()) as {
        data: { userId: string; revokedSessions: number };
      };

      assert.equal(revokeResponse.status, 200);
      assert.equal(revokeBody.data.userId, targetLogin.session.userId);
      assert.ok(revokeBody.data.revokedSessions >= 1);

      const targetSessionResponse = await handler(
        new Request("http://localhost/api/v1/auth/session", {
          headers: {
            cookie: targetLogin.cookie,
          },
        }),
      );
      const targetSessionBody = (await targetSessionResponse.json()) as {
        code: string;
      };

      assert.equal(targetSessionResponse.status, 401);
      assert.equal(targetSessionBody.code, "UNAUTHORIZED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key lifecycle supports create/list/revoke with one-time key reveal",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";

    try {
      await handler(
        new Request("http://localhost/api/v1/auth/sign-up/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email,
            password,
            name: "Admin User",
          }),
        }),
      );

      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:api-key-lifecycle-owner",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();
      const cookie = loginResult.cookie;

      const readKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "read-only",
            scopes: ["content:read"],
            contextAllowlist: [
              { project: "marketing-site", environment: "production" },
            ],
          }),
        }),
      );
      const readKeyBody = (await readKeyResponse.json()) as {
        data: {
          id: string;
          key: string;
          label: string;
          revokedAt: string | null;
        };
      };

      assert.equal(readKeyResponse.status, 200);
      assert.equal(readKeyBody.data.key.startsWith("mdcms_key_"), true);
      assert.equal(readKeyBody.data.label, "read-only");
      assert.equal(readKeyBody.data.revokedAt, null);

      const listBeforeRevoke = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          headers: {
            cookie,
          },
        }),
      );
      const listBeforeRevokeBody = (await listBeforeRevoke.json()) as {
        data: Array<{
          id: string;
          label: string;
          revokedAt: string | null;
          key?: string;
        }>;
      };
      const createdMetadata = listBeforeRevokeBody.data.find(
        (row) => row.id === readKeyBody.data.id,
      );

      assert.equal(listBeforeRevoke.status, 200);
      assert.ok(createdMetadata);
      assert.equal(createdMetadata?.label, "read-only");
      assert.equal(createdMetadata?.revokedAt, null);
      assert.equal(
        Object.prototype.hasOwnProperty.call(createdMetadata ?? {}, "key"),
        false,
      );

      const revokeResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/api-keys/${readKeyBody.data.id}/revoke`,
          {
            method: "POST",
            headers: createCsrfHeaders(loginResult),
          },
        ),
      );
      const revokeBody = (await revokeResponse.json()) as {
        data: { id: string; revokedAt: string | null };
      };

      assert.equal(revokeResponse.status, 200);
      assert.equal(revokeBody.data.id, readKeyBody.data.id);
      assert.ok(revokeBody.data.revokedAt);

      const listAfterRevoke = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          headers: {
            cookie,
          },
        }),
      );
      const listAfterRevokeBody = (await listAfterRevoke.json()) as {
        data: Array<{ id: string; revokedAt: string | null }>;
      };
      const revokedMetadata = listAfterRevokeBody.data.find(
        (row) => row.id === readKeyBody.data.id,
      );

      assert.equal(listAfterRevoke.status, 200);
      assert.ok(revokedMetadata?.revokedAt);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key creation requires the session to already hold the requested schema scope for each allowlisted target",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";
    const allowedScope = {
      project: `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const blockedScope = {
      project: `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "API Key Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:api-key-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, allowedScope);
      await seedScope(dbConnection.db, blockedScope);

      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Scoped Editor",
      });
      const editorLogin = await login(handler, {
        email: editorEmail,
        password,
      });
      await dbConnection.db.insert(rbacGrants).values({
        userId: editorLogin.session.userId,
        role: "editor",
        scopeKind: "project",
        project: allowedScope.project,
        source: "test:api-key-editor",
        createdByUserId: ownerLogin.session.userId,
      });

      const allowedReadResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(editorLogin, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-read-allowed",
            scopes: ["schema:read"],
            contextAllowlist: [allowedScope],
          }),
        }),
      );
      assert.equal(allowedReadResponse.status, 200);

      const blockedWriteResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(editorLogin, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-write-blocked",
            scopes: ["schema:write"],
            contextAllowlist: [allowedScope],
          }),
        }),
      );
      const blockedWriteBody = (await blockedWriteResponse.json()) as {
        code: string;
      };
      assert.equal(blockedWriteResponse.status, 403);
      assert.equal(blockedWriteBody.code, "FORBIDDEN");

      const blockedTargetResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(editorLogin, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-read-wrong-target",
            scopes: ["schema:read"],
            contextAllowlist: [allowedScope, blockedScope],
          }),
        }),
      );
      const blockedTargetBody = (await blockedTargetResponse.json()) as {
        code: string;
      };
      assert.equal(blockedTargetResponse.status, 403);
      assert.equal(blockedTargetBody.code, "FORBIDDEN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key content scopes split draft-read and write while keeping legacy write:draft as write-only",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const schemaHash = "content-scope-split";
    const scopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await signUp(handler, {
        email,
        password,
        name: "Scope Test User",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:auth-scope-split",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, scope);

      const schemaSyncResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: createCsrfHeaders(loginResult, {
            ...scopeHeaders,
            "x-mdcms-schema-hash": schemaHash,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createSchemaSyncPayload(schemaHash, scope.project),
          ),
        }),
      );
      assert.equal(schemaSyncResponse.status, 200);

      const createDocumentResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            ...scopeHeaders,
            "x-mdcms-schema-hash": schemaHash,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            path: `content/posts/scope-test-${Date.now()}`,
            type: "Post",
            locale: "en",
            format: "md",
            frontmatter: {
              title: "Scope test",
              slug: "scope-test",
            },
            body: "draft body",
          }),
        }),
      );
      const createDocumentBody = (await createDocumentResponse.json()) as {
        data: { documentId: string };
      };
      assert.equal(createDocumentResponse.status, 200);

      const readKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "published-read-only",
            scopes: ["content:read"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const readKeyBody = (await readKeyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(readKeyResponse.status, 200);

      const publishedListAllowedResponse = await handler(
        new Request("http://localhost/api/v1/content", {
          headers: {
            authorization: `Bearer ${readKeyBody.data.key}`,
            ...scopeHeaders,
          },
        }),
      );
      assert.equal(publishedListAllowedResponse.status, 200);

      const draftListForbiddenResponse = await handler(
        new Request("http://localhost/api/v1/content?draft=true", {
          headers: {
            authorization: `Bearer ${readKeyBody.data.key}`,
            ...scopeHeaders,
          },
        }),
      );
      const draftListForbiddenBody =
        (await draftListForbiddenResponse.json()) as {
          code: string;
        };
      assert.equal(draftListForbiddenResponse.status, 403);
      assert.equal(draftListForbiddenBody.code, "FORBIDDEN");

      const legacyWriteKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "legacy-write-only",
            scopes: ["content:write:draft"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const legacyWriteKeyBody = (await legacyWriteKeyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(legacyWriteKeyResponse.status, 200);

      const draftReadForbiddenResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${createDocumentBody.data.documentId}?draft=true`,
          {
            headers: {
              authorization: `Bearer ${legacyWriteKeyBody.data.key}`,
              ...scopeHeaders,
            },
          },
        ),
      );
      const draftReadForbiddenBody =
        (await draftReadForbiddenResponse.json()) as {
          code: string;
        };
      assert.equal(draftReadForbiddenResponse.status, 403);
      assert.equal(draftReadForbiddenBody.code, "FORBIDDEN");

      const legacyWriteUpdateResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${createDocumentBody.data.documentId}`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${legacyWriteKeyBody.data.key}`,
              ...scopeHeaders,
              "x-mdcms-schema-hash": schemaHash,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              body: "updated by legacy write scope",
            }),
          },
        ),
      );
      assert.equal(legacyWriteUpdateResponse.status, 200);

      const draftReadKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "draft-read-only",
            scopes: ["content:read:draft"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const draftReadKeyBody = (await draftReadKeyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(draftReadKeyResponse.status, 200);

      const draftReadAllowedResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${createDocumentBody.data.documentId}?draft=true`,
          {
            headers: {
              authorization: `Bearer ${draftReadKeyBody.data.key}`,
              ...scopeHeaders,
            },
          },
        ),
      );
      assert.equal(draftReadAllowedResponse.status, 200);

      const draftListAllowedResponse = await handler(
        new Request("http://localhost/api/v1/content?draft=true", {
          headers: {
            authorization: `Bearer ${draftReadKeyBody.data.key}`,
            ...scopeHeaders,
          },
        }),
      );
      assert.equal(draftListAllowedResponse.status, 200);

      const draftWriteForbiddenResponse = await handler(
        new Request(
          `http://localhost/api/v1/content/${createDocumentBody.data.documentId}`,
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${draftReadKeyBody.data.key}`,
              ...scopeHeaders,
              "x-mdcms-schema-hash": schemaHash,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              body: "should be rejected",
            }),
          },
        ),
      );
      const draftWriteForbiddenBody =
        (await draftWriteForbiddenResponse.json()) as {
          code: string;
        };
      assert.equal(draftWriteForbiddenResponse.status, 403);
      assert.equal(draftWriteForbiddenBody.code, "FORBIDDEN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key creation rejects reserved schema:write scope for non-admin sessions",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "Bootstrap Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:api-key-scope-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();

      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Schema Scope Editor",
      });
      const editorLogin = await login(handler, {
        email: editorEmail,
        password,
      });
      const scope = {
        project: "marketing-site",
        environment: "staging",
      };
      await seedScope(dbConnection.db, scope);
      await dbConnection.db.insert(rbacGrants).values({
        userId: editorLogin.session.userId,
        role: "editor",
        scopeKind: "project",
        project: scope.project,
        source: "test:schema-scope-editor",
        createdByUserId: ownerLogin.session.userId,
      });

      const createResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(editorLogin, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-write-attempt",
            scopes: ["schema:write"],
            contextAllowlist: [scope],
          }),
        }),
      );
      const createBody = (await createResponse.json()) as {
        code: string;
      };

      assert.equal(createResponse.status, 403);
      assert.equal(createBody.code, "FORBIDDEN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key creation rejects unmapped scopes even for owner sessions",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `unmapped-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:unmapped-scope-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, scope);

      const createResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(ownerLogin, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "media-upload",
            scopes: ["media:upload"],
            contextAllowlist: [scope],
          }),
        }),
      );
      const createBody = (await createResponse.json()) as {
        code: string;
      };

      assert.equal(createResponse.status, 403);
      assert.equal(createBody.code, "FORBIDDEN");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "API key schema scopes require schema:read for GET and schema:write for PUT",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const scopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await signUp(handler, {
        email,
        password,
        name: "Schema Key User",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:schema-api-key-owner",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, {
        project: scope.project,
        environment: scope.environment,
      });

      const readKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-read",
            scopes: ["schema:read"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const readKeyBody = (await readKeyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(readKeyResponse.status, 200);

      const writeKeyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "schema-write",
            scopes: ["schema:write"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const writeKeyBody = (await writeKeyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(writeKeyResponse.status, 200);

      const getWithReadResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${readKeyBody.data.key}`,
          },
        }),
      );
      assert.equal(getWithReadResponse.status, 200);

      const putWithReadResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${readKeyBody.data.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSchemaSyncPayload("schema-read-blocked", scope.project),
          ),
        }),
      );
      const putWithReadBody = (await putWithReadResponse.json()) as {
        code: string;
      };
      assert.equal(putWithReadResponse.status, 403);
      assert.equal(putWithReadBody.code, "FORBIDDEN");

      const getWithWriteResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${writeKeyBody.data.key}`,
          },
        }),
      );
      const getWithWriteBody = (await getWithWriteResponse.json()) as {
        code: string;
      };
      assert.equal(getWithWriteResponse.status, 403);
      assert.equal(getWithWriteBody.code, "FORBIDDEN");

      const putWithWriteResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${writeKeyBody.data.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            createSchemaSyncPayload("schema-write-allowed", scope.project),
          ),
        }),
      );
      assert.equal(putWithWriteResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "session RBAC gates schema routes with read-only viewer/editor scopes and write-capable admin scope",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const scopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "Bootstrap Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:schema-session-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, {
        project: scope.project,
        environment: scope.environment,
      });

      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Schema Scoped User",
      });
      const scopedLogin = await login(handler, {
        email: editorEmail,
        password,
      });

      const forbiddenReadResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: {
            ...scopeHeaders,
            cookie: scopedLogin.cookie,
          },
        }),
      );
      const forbiddenReadBody = (await forbiddenReadResponse.json()) as {
        code: string;
      };
      assert.equal(forbiddenReadResponse.status, 403);
      assert.equal(forbiddenReadBody.code, "FORBIDDEN");

      await dbConnection.db.insert(rbacGrants).values({
        userId: scopedLogin.session.userId,
        role: "viewer",
        scopeKind: "project",
        project: scope.project,
        source: "test:schema-session-viewer",
        createdByUserId: ownerLogin.session.userId,
      });

      const allowedReadResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          headers: {
            ...scopeHeaders,
            cookie: scopedLogin.cookie,
          },
        }),
      );
      assert.equal(allowedReadResponse.status, 200);

      const viewerWriteResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: createCsrfHeaders(scopedLogin, {
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createSchemaSyncPayload("viewer-write-blocked", scope.project),
          ),
        }),
      );
      const viewerWriteBody = (await viewerWriteResponse.json()) as {
        code: string;
      };
      assert.equal(viewerWriteResponse.status, 403);
      assert.equal(viewerWriteBody.code, "FORBIDDEN");

      await dbConnection.db.insert(rbacGrants).values({
        userId: scopedLogin.session.userId,
        role: "editor",
        scopeKind: "project",
        project: scope.project,
        source: "test:schema-session-editor",
        createdByUserId: ownerLogin.session.userId,
      });

      const editorWriteResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: createCsrfHeaders(scopedLogin, {
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createSchemaSyncPayload("editor-write-allowed", scope.project),
          ),
        }),
      );
      const editorWriteBody = (await editorWriteResponse.json()) as {
        code: string;
      };
      assert.equal(editorWriteResponse.status, 403);
      assert.equal(editorWriteBody.code, "FORBIDDEN");

      await dbConnection.db.insert(rbacGrants).values({
        userId: scopedLogin.session.userId,
        role: "admin",
        scopeKind: "global",
        source: "test:schema-session-admin",
        createdByUserId: ownerLogin.session.userId,
      });

      const adminWriteResponse = await handler(
        new Request("http://localhost/api/v1/schema", {
          method: "PUT",
          headers: createCsrfHeaders(scopedLogin, {
            ...scopeHeaders,
            "content-type": "application/json",
          }),
          body: JSON.stringify(
            createSchemaSyncPayload("admin-write-allowed", scope.project),
          ),
        }),
      );
      assert.equal(adminWriteResponse.status, 200);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "current principal capabilities report effective session permissions for the routed target",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `caps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const scopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "Capabilities Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:capabilities-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, {
        project: scope.project,
        environment: scope.environment,
      });

      await signUp(handler, {
        email: editorEmail,
        password,
        name: "Capabilities Editor",
      });
      const editorLogin = await login(handler, {
        email: editorEmail,
        password,
      });
      await dbConnection.db.insert(rbacGrants).values({
        userId: editorLogin.session.userId,
        role: "editor",
        scopeKind: "project",
        project: scope.project,
        source: "test:capabilities-editor",
        createdByUserId: ownerLogin.session.userId,
      });

      const response = await handler(
        new Request("http://localhost/api/v1/me/capabilities", {
          headers: {
            ...scopeHeaders,
            cookie: editorLogin.cookie,
          },
        }),
      );
      const body = (await response.json()) as {
        data: {
          project: string;
          environment: string;
          capabilities: {
            schema: { read: boolean; write: boolean };
            content: {
              read: boolean;
              readDraft: boolean;
              write: boolean;
              publish: boolean;
              unpublish: boolean;
              delete: boolean;
            };
            users: { manage: boolean };
            settings: { manage: boolean };
            ai: { use: boolean };
          };
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.data.project, scope.project);
      assert.equal(body.data.environment, scope.environment);
      assert.deepEqual(body.data.capabilities, {
        schema: {
          read: true,
          write: false,
        },
        content: {
          read: true,
          readDraft: true,
          write: true,
          publish: true,
          unpublish: true,
          delete: true,
        },
        users: {
          manage: false,
        },
        settings: {
          manage: false,
        },
        ai: {
          use: true,
        },
      });
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "current principal capabilities report effective API key permissions and reject disallowed target routing",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const scope = {
      project: `caps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      environment: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const scopeHeaders = {
      "x-mdcms-project": scope.project,
      "x-mdcms-environment": scope.environment,
    };

    try {
      await signUp(handler, {
        email,
        password,
        name: "Capabilities Key Owner",
      });
      const loginResult = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: loginResult.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:capabilities-key-owner",
          createdByUserId: loginResult.session.userId,
        })
        .onConflictDoNothing();
      await seedScope(dbConnection.db, {
        project: scope.project,
        environment: scope.environment,
      });

      const keyResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          method: "POST",
          headers: createCsrfHeaders(loginResult, {
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            label: "capabilities-readonly",
            scopes: ["schema:read", "content:read", "webhooks:read"],
            contextAllowlist: [
              {
                project: scope.project,
                environment: scope.environment,
              },
            ],
          }),
        }),
      );
      const keyBody = (await keyResponse.json()) as {
        data: { key: string };
      };
      assert.equal(keyResponse.status, 200);

      const response = await handler(
        new Request("http://localhost/api/v1/me/capabilities", {
          headers: {
            ...scopeHeaders,
            authorization: `Bearer ${keyBody.data.key}`,
          },
        }),
      );
      const body = (await response.json()) as {
        data: {
          capabilities: {
            schema: { read: boolean; write: boolean };
            content: {
              read: boolean;
              readDraft: boolean;
              write: boolean;
              publish: boolean;
              unpublish: boolean;
              delete: boolean;
            };
            users: { manage: boolean };
            settings: { manage: boolean };
            ai: { use: boolean };
          };
        };
      };

      assert.equal(response.status, 200);
      assert.deepEqual(body.data.capabilities, {
        schema: {
          read: true,
          write: false,
        },
        content: {
          read: true,
          readDraft: false,
          write: false,
          publish: false,
          unpublish: false,
          delete: false,
        },
        users: {
          manage: false,
        },
        settings: {
          manage: true,
        },
        ai: {
          use: false,
        },
      });

      const mismatchedResponse = await handler(
        new Request("http://localhost/api/v1/me/capabilities", {
          headers: {
            "x-mdcms-project": scope.project,
            "x-mdcms-environment": `${scope.environment}-other`,
            authorization: `Bearer ${keyBody.data.key}`,
          },
        }),
      );
      const mismatchedBody = (await mismatchedResponse.json()) as {
        code: string;
      };

      assert.equal(mismatchedResponse.status, 400);
      assert.equal(mismatchedBody.code, "TARGET_ROUTING_MISMATCH");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login authorize rejects reserved schema:write scope for non-admin sessions",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const ownerEmail = uniqueEmail();
    const editorEmail = uniqueEmail();
    const password = "Admin12345!";
    const state = `state-${Date.now()}-abcdefghijklmnop`;

    try {
      await signUp(handler, {
        email: ownerEmail,
        password,
        name: "Bootstrap Owner",
      });
      const ownerLogin = await login(handler, {
        email: ownerEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:cli-scope-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();

      await signUp(handler, {
        email: editorEmail,
        password,
        name: "CLI Schema Editor",
      });

      const startResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project: "marketing-site",
            environment: "staging",
            redirectUri: "http://127.0.0.1:45123/callback",
            state,
            scopes: ["schema:write"],
          }),
        }),
      );
      const startBody = (await startResponse.json()) as {
        data: { challengeId: string; authorizeUrl: string };
      };

      const authorizeResponse = await handler(
        new Request(startBody.data.authorizeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            email: editorEmail,
            password,
          }).toString(),
        }),
      );
      const authorizeBody = (await authorizeResponse.json()) as {
        code: string;
      };

      assert.equal(authorizeResponse.status, 403);
      assert.equal(authorizeBody.code, "FORBIDDEN");

      const [challengeRow] = await dbConnection.db
        .select()
        .from(cliLoginChallenges)
        .where(eq(cliLoginChallenges.id, startBody.data.challengeId));

      assert.equal(challengeRow?.status, "pending");
      assert.equal(challengeRow?.authorizedAt, null);
      assert.equal(challengeRow?.authorizationCodeHash, null);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login browser flow supports start -> authorize -> exchange and self-revoke",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const state = `state-${Date.now()}-abcdefghijklmnop`;
    const redirectUri = "http://127.0.0.1:45123/callback";

    try {
      await signUp(handler, { email, password });
      const ownerLogin = await login(handler, {
        email,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:cli-login-owner",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();

      const startResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project: "marketing-site",
            environment: "staging",
            redirectUri,
            state,
            scopes: ["content:read", "content:read:draft", "content:write"],
          }),
        }),
      );
      const startBody = (await startResponse.json()) as {
        data: {
          challengeId: string;
          authorizeUrl: string;
        };
      };

      assert.equal(startResponse.status, 200);
      assert.ok(startBody.data.challengeId);
      assert.equal(
        startBody.data.authorizeUrl.includes(
          "/api/v1/auth/cli/login/authorize",
        ),
        true,
      );

      const authorizeGetResponse = await handler(
        new Request(startBody.data.authorizeUrl, {
          method: "GET",
        }),
      );
      const authorizeGetHtml = await authorizeGetResponse.text();

      assert.equal(authorizeGetResponse.status, 200);
      assert.equal(
        authorizeGetResponse.headers.get("content-type")?.includes("text/html"),
        true,
      );
      assert.equal(authorizeGetHtml.includes("<form"), true);

      const authorizePostUrl = new URL(startBody.data.authorizeUrl);
      const authorizePostResponse = await handler(
        new Request(authorizePostUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            email,
            password,
          }).toString(),
        }),
      );
      const redirectLocation = authorizePostResponse.headers.get("location");

      assert.equal(authorizePostResponse.status, 302);
      assert.ok(redirectLocation);
      assert.ok(authorizePostResponse.headers.get("set-cookie"));

      const callbackUrl = new URL(redirectLocation ?? "");
      const code = callbackUrl.searchParams.get("code");
      const returnedState = callbackUrl.searchParams.get("state");

      assert.ok(code);
      assert.equal(returnedState, state);

      const exchangeResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/exchange", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            challengeId: startBody.data.challengeId,
            state,
            code,
          }),
        }),
      );
      const exchangeBody = (await exchangeResponse.json()) as {
        data: {
          id: string;
          key: string;
          keyPrefix: string;
        };
      };

      assert.equal(exchangeResponse.status, 200);
      assert.equal(exchangeBody.data.key.startsWith("mdcms_key_"), true);
      assert.ok(exchangeBody.data.id);
      assert.ok(exchangeBody.data.keyPrefix);

      const challengeRows = await dbConnection.db
        .select()
        .from(cliLoginChallenges)
        .where(eq(cliLoginChallenges.id, startBody.data.challengeId));
      assert.equal(challengeRows.length, 1);
      assert.equal(challengeRows[0]?.status, "exchanged");
      assert.ok(challengeRows[0]?.usedAt);

      const reusedExchangeResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/exchange", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            challengeId: startBody.data.challengeId,
            state,
            code,
          }),
        }),
      );
      const reusedExchangeBody = (await reusedExchangeResponse.json()) as {
        code: string;
      };
      assert.equal(reusedExchangeResponse.status, 409);
      assert.equal(reusedExchangeBody.code, "LOGIN_CHALLENGE_USED");

      const selfRevokeResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys/self/revoke", {
          method: "POST",
          headers: {
            authorization: `Bearer ${exchangeBody.data.key}`,
          },
        }),
      );
      const selfRevokeBody = (await selfRevokeResponse.json()) as {
        data: { revoked: boolean; keyId: string };
      };
      assert.equal(selfRevokeResponse.status, 200);
      assert.equal(selfRevokeBody.data.revoked, true);
      assert.equal(selfRevokeBody.data.keyId, exchangeBody.data.id);

      const secondRevokeResponse = await handler(
        new Request("http://localhost/api/v1/auth/api-keys/self/revoke", {
          method: "POST",
          headers: {
            authorization: `Bearer ${exchangeBody.data.key}`,
          },
        }),
      );
      const secondRevokeBody = (await secondRevokeResponse.json()) as {
        code: string;
      };
      assert.equal(secondRevokeResponse.status, 401);
      assert.equal(secondRevokeBody.code, "UNAUTHORIZED");
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login authorize applies password backoff without authorizing the challenge",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const invalidPassword = "WrongPassword123!";
    const state = `state-${Date.now()}-abcdefghijklmnop`;
    const start = Date.now();

    try {
      await signUp(handler, { email, password });

      const startResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project: "marketing-site",
            environment: "staging",
            redirectUri: "http://127.0.0.1:45123/callback",
            state,
          }),
        }),
      );
      const startBody = (await startResponse.json()) as {
        data: { challengeId: string; authorizeUrl: string };
      };

      const authorizeUrl = new URL(startBody.data.authorizeUrl);

      const firstAuthorizeResponse = await withMockedNow(start, () =>
        handler(
          new Request(authorizeUrl.toString(), {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              email,
              password: invalidPassword,
            }).toString(),
          }),
        ),
      );
      const firstAuthorizeHtml = await firstAuthorizeResponse.text();

      assert.equal(firstAuthorizeResponse.status, 401);
      assert.equal(
        firstAuthorizeResponse.headers
          .get("content-type")
          ?.includes("text/html"),
        true,
      );
      assert.equal(
        firstAuthorizeHtml.includes("Invalid email or password"),
        true,
      );
      assert.equal(firstAuthorizeHtml.includes("<form"), true);

      const lockedAuthorizeResponse = await withMockedNow(start, () =>
        handler(
          new Request(authorizeUrl.toString(), {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              email,
              password: invalidPassword,
            }).toString(),
          }),
        ),
      );
      const lockedAuthorizeHtml = await lockedAuthorizeResponse.text();

      assert.equal(lockedAuthorizeResponse.status, 429);
      assert.equal(
        lockedAuthorizeResponse.headers
          .get("content-type")
          ?.includes("text/html"),
        true,
      );
      assert.equal(lockedAuthorizeHtml.includes("Too many attempts"), true);
      assert.equal(lockedAuthorizeHtml.includes("<form"), true);
      assert.equal(lockedAuthorizeResponse.headers.get("retry-after"), "1");

      const [challengeRow] = await dbConnection.db
        .select()
        .from(cliLoginChallenges)
        .where(eq(cliLoginChallenges.id, startBody.data.challengeId));

      assert.equal(challengeRow?.status, "pending");
      assert.equal(challengeRow?.authorizedAt, null);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase("CLI login exchange rejects expired challenge", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });
  const state = `state-${Date.now()}-abcdefghijklmnop`;

  try {
    const startResponse = await handler(
      new Request("http://localhost/api/v1/auth/cli/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project: "marketing-site",
          environment: "staging",
          redirectUri: "http://127.0.0.1:45123/callback",
          state,
        }),
      }),
    );
    const startBody = (await startResponse.json()) as {
      data: { challengeId: string };
    };

    await dbConnection.db
      .update(cliLoginChallenges)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(cliLoginChallenges.id, startBody.data.challengeId));

    const exchangeResponse = await handler(
      new Request("http://localhost/api/v1/auth/cli/login/exchange", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          challengeId: startBody.data.challengeId,
          state,
          code: "invalid-code-for-expired-case",
        }),
      }),
    );
    const exchangeBody = (await exchangeResponse.json()) as { code: string };

    assert.equal(exchangeResponse.status, 410);
    assert.equal(exchangeBody.code, "LOGIN_CHALLENGE_EXPIRED");
  } finally {
    await dbConnection.close();
  }
});

testWithDatabase("CLI login authorize rejects state mismatch", async () => {
  const { handler, dbConnection } = createServerRequestHandlerWithModules({
    env,
    logger,
  });
  const state = `state-${Date.now()}-abcdefghijklmnop`;

  try {
    const startResponse = await handler(
      new Request("http://localhost/api/v1/auth/cli/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          project: "marketing-site",
          environment: "staging",
          redirectUri: "http://127.0.0.1:45123/callback",
          state,
        }),
      }),
    );
    const startBody = (await startResponse.json()) as {
      data: { challengeId: string };
    };

    const badAuthorizeResponse = await handler(
      new Request(
        `http://localhost/api/v1/auth/cli/login/authorize?challenge=${encodeURIComponent(startBody.data.challengeId)}&state=wrong-state-value-abcdefghijklmnop`,
      ),
    );
    const badAuthorizeBody = (await badAuthorizeResponse.json()) as {
      code: string;
    };

    assert.equal(badAuthorizeResponse.status, 400);
    assert.equal(badAuthorizeBody.code, "INVALID_LOGIN_EXCHANGE");
  } finally {
    await dbConnection.close();
  }
});

async function seedApiKey(
  db: ReturnType<
    typeof createServerRequestHandlerWithModules
  >["dbConnection"]["db"],
  input: {
    userId: string;
    label: string;
  },
): Promise<{ id: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      label: input.label,
      keyPrefix: `mdcms_key_test_${suffix}`,
      keyHash: `test-hash-${suffix}`,
      scopes: ["content:read"],
      contextAllowlist: [
        { project: "marketing-site", environment: "production" },
      ],
      createdByUserId: input.userId,
    })
    .returning({ id: apiKeys.id });
  assert.ok(row);
  return row;
}

testWithDatabase(
  "listApiKeys returns only caller's own keys for non-admin session",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const adminEmail = uniqueEmail();
    const userEmail = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email: adminEmail, password, name: "Admin" });
      const adminLogin = await login(handler, {
        email: adminEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: adminLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:list-api-keys-admin",
          createdByUserId: adminLogin.session.userId,
        })
        .onConflictDoNothing();

      await signUp(handler, { email: userEmail, password, name: "User" });
      const userLogin = await login(handler, {
        email: userEmail,
        password,
      });

      const adminKey = await seedApiKey(dbConnection.db, {
        userId: adminLogin.session.userId,
        label: "admin-key",
      });
      const userKey = await seedApiKey(dbConnection.db, {
        userId: userLogin.session.userId,
        label: "user-key",
      });

      const nonAdminList = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          headers: { cookie: userLogin.cookie },
        }),
      );
      const nonAdminBody = (await nonAdminList.json()) as {
        data: Array<{ id: string; label: string }>;
      };

      assert.equal(nonAdminList.status, 200);
      const visibleIds = nonAdminBody.data.map((row) => row.id);
      assert.equal(visibleIds.includes(userKey.id), true);
      assert.equal(visibleIds.includes(adminKey.id), false);

      const adminList = await handler(
        new Request("http://localhost/api/v1/auth/api-keys", {
          headers: { cookie: adminLogin.cookie },
        }),
      );
      const adminBody = (await adminList.json()) as {
        data: Array<{ id: string }>;
      };
      const adminVisibleIds = adminBody.data.map((row) => row.id);

      assert.equal(adminList.status, 200);
      assert.equal(adminVisibleIds.includes(adminKey.id), true);
      assert.equal(adminVisibleIds.includes(userKey.id), true);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "revokeApiKey returns 404 when a non-admin targets another user's key and leaves the key active",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const adminEmail = uniqueEmail();
    const userEmail = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email: adminEmail, password, name: "Admin" });
      const adminLogin = await login(handler, {
        email: adminEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: adminLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:revoke-api-key-admin",
          createdByUserId: adminLogin.session.userId,
        })
        .onConflictDoNothing();

      await signUp(handler, { email: userEmail, password, name: "User" });
      const userLogin = await login(handler, {
        email: userEmail,
        password,
      });

      const adminKey = await seedApiKey(dbConnection.db, {
        userId: adminLogin.session.userId,
        label: "admin-owned",
      });

      const revokeResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/api-keys/${adminKey.id}/revoke`,
          {
            method: "POST",
            headers: createCsrfHeaders(userLogin),
          },
        ),
      );
      const revokeBody = (await revokeResponse.json()) as { code: string };

      assert.equal(revokeResponse.status, 404);
      assert.equal(revokeBody.code, "NOT_FOUND");

      const persistedKey = await dbConnection.db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, adminKey.id),
      });

      assert.ok(persistedKey);
      assert.equal(persistedKey?.revokedAt, null);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "revokeApiKey allows an admin to revoke another user's key",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const adminEmail = uniqueEmail();
    const userEmail = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email: adminEmail, password, name: "Admin" });
      const adminLogin = await login(handler, {
        email: adminEmail,
        password,
      });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: adminLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:admin-revoke-foreign-key",
          createdByUserId: adminLogin.session.userId,
        })
        .onConflictDoNothing();

      await signUp(handler, { email: userEmail, password, name: "User" });
      const userLogin = await login(handler, {
        email: userEmail,
        password,
      });

      const userKey = await seedApiKey(dbConnection.db, {
        userId: userLogin.session.userId,
        label: "user-owned",
      });

      const revokeResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/api-keys/${userKey.id}/revoke`,
          {
            method: "POST",
            headers: createCsrfHeaders(adminLogin),
          },
        ),
      );
      const revokeBody = (await revokeResponse.json()) as {
        data: { id: string; revokedAt: string | null };
      };

      assert.equal(revokeResponse.status, 200);
      assert.equal(revokeBody.data.id, userKey.id);
      assert.ok(revokeBody.data.revokedAt);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "revokeApiKey allows a non-admin to revoke their own key",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const userEmail = uniqueEmail();
    const password = "Admin12345!";

    try {
      await signUp(handler, { email: userEmail, password, name: "User" });
      const userLogin = await login(handler, {
        email: userEmail,
        password,
      });

      const ownKey = await seedApiKey(dbConnection.db, {
        userId: userLogin.session.userId,
        label: "self-owned",
      });

      const revokeResponse = await handler(
        new Request(
          `http://localhost/api/v1/auth/api-keys/${ownKey.id}/revoke`,
          {
            method: "POST",
            headers: createCsrfHeaders(userLogin),
          },
        ),
      );
      const revokeBody = (await revokeResponse.json()) as {
        data: { id: string; revokedAt: string | null };
      };

      assert.equal(revokeResponse.status, 200);
      assert.equal(revokeBody.data.id, ownKey.id);
      assert.ok(revokeBody.data.revokedAt);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login authorize GET with expired challenge returns styled HTML error page",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const state = `state-${Date.now()}-abcdefghijklmnop`;

    try {
      const startResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "marketing-site",
            environment: "staging",
            redirectUri: "http://127.0.0.1:45123/callback",
            state,
          }),
        }),
      );
      const startBody = (await startResponse.json()) as {
        data: { challengeId: string; authorizeUrl: string };
      };

      await dbConnection.db
        .update(cliLoginChallenges)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(cliLoginChallenges.id, startBody.data.challengeId));

      const authorizeResponse = await handler(
        new Request(startBody.data.authorizeUrl, { method: "GET" }),
      );
      const html = await authorizeResponse.text();

      assert.equal(authorizeResponse.status, 410);
      assert.equal(
        authorizeResponse.headers.get("content-type")?.includes("text/html"),
        true,
      );
      assert.equal(html.includes("Login link expired"), true);
      assert.equal(html.includes("mdcms login"), true);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login authorize GET with invalid challenge ID returns styled HTML error page",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });

    try {
      const authorizeResponse = await handler(
        new Request(
          "http://localhost/api/v1/auth/cli/login/authorize?challenge=00000000-0000-0000-0000-000000000000&state=state-fake-abcdefghijklmnop",
          { method: "GET" },
        ),
      );
      const html = await authorizeResponse.text();

      assert.equal(authorizeResponse.status, 404);
      assert.equal(
        authorizeResponse.headers.get("content-type")?.includes("text/html"),
        true,
      );
      assert.equal(html.includes("Invalid login link"), true);
    } finally {
      await dbConnection.close();
    }
  },
);

testWithDatabase(
  "CLI login authorize POST with invalid credentials returns HTML with error message",
  async () => {
    const { handler, dbConnection } = createServerRequestHandlerWithModules({
      env,
      logger,
    });
    const email = uniqueEmail();
    const password = "Admin12345!";
    const state = `state-${Date.now()}-abcdefghijklmnop`;
    const redirectUri = "http://127.0.0.1:45123/callback";

    try {
      await signUp(handler, { email, password });
      const ownerLogin = await login(handler, { email, password });
      await dbConnection.db
        .insert(rbacGrants)
        .values({
          userId: ownerLogin.session.userId,
          role: "owner",
          scopeKind: "global",
          source: "test:cli-login-invalid-creds",
          createdByUserId: ownerLogin.session.userId,
        })
        .onConflictDoNothing();

      const startResponse = await handler(
        new Request("http://localhost/api/v1/auth/cli/login/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project: "marketing-site",
            environment: "staging",
            redirectUri,
            state,
            scopes: ["content:read", "content:read:draft", "content:write"],
          }),
        }),
      );
      const startBody = (await startResponse.json()) as {
        data: { challengeId: string; authorizeUrl: string };
      };

      assert.equal(startResponse.status, 200);
      assert.ok(startBody.data.challengeId);

      const authorizeUrl = new URL(startBody.data.authorizeUrl);

      const authorizePostResponse = await handler(
        new Request(authorizeUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            email,
            password: "WrongPassword123!",
          }).toString(),
        }),
      );
      const html = await authorizePostResponse.text();

      assert.equal(authorizePostResponse.status, 401);
      assert.equal(
        authorizePostResponse.headers
          .get("content-type")
          ?.includes("text/html"),
        true,
      );
      assert.equal(html.includes("Invalid email or password"), true);
      assert.equal(html.includes("<form"), true);
    } finally {
      await dbConnection.close();
    }
  },
);
