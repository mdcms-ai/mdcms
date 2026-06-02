import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import { parseServerEnv } from "./env.js";

test("parseServerEnv parses valid OIDC provider config", () => {
  const env = parseServerEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "debug",
    APP_VERSION: "1.2.3",
    PORT: "4100",
    SERVICE_NAME: "mdcms-server",
    MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
      {
        providerId: "okta",
        issuer: "https://example.okta.com/oauth2/default",
        domain: "example.com",
        clientId: "okta-client-id",
        clientSecret: "okta-client-secret",
        scopes: ["openid", "email", "profile"],
        trustedOrigins: ["https://fixtures.mdcms.local"],
        discoveryOverrides: {
          authorizationEndpoint: "https://fixtures.mdcms.local/authorize",
          tokenEndpoint: "https://fixtures.mdcms.local/token",
          userInfoEndpoint: "https://fixtures.mdcms.local/userinfo",
          jwksUri: "https://fixtures.mdcms.local/jwks",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
    ]),
  } as NodeJS.ProcessEnv);

  assert.equal(env.PORT, 4100);
  assert.equal(env.MDCMS_AUTH_OIDC_PROVIDERS.length, 1);
  assert.deepEqual(env.MDCMS_AUTH_OIDC_PROVIDERS[0], {
    providerId: "okta",
    issuer: "https://example.okta.com/oauth2/default",
    domain: "example.com",
    clientId: "okta-client-id",
    clientSecret: "okta-client-secret",
    scopes: ["openid", "email", "profile"],
    trustedOrigins: ["https://fixtures.mdcms.local"],
    discoveryOverrides: {
      authorizationEndpoint: "https://fixtures.mdcms.local/authorize",
      tokenEndpoint: "https://fixtures.mdcms.local/token",
      userInfoEndpoint: "https://fixtures.mdcms.local/userinfo",
      jwksUri: "https://fixtures.mdcms.local/jwks",
      tokenEndpointAuthMethod: "client_secret_post",
    },
  });
});

test("parseServerEnv preserves bare-origin OIDC issuers without adding a slash", () => {
  const env = parseServerEnv({
    MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
      {
        providerId: "auth0",
        issuer: "https://tenant.example.com",
        domain: "example.com",
        clientId: "auth0-client-id",
        clientSecret: "auth0-client-secret",
      },
    ]),
  } as NodeJS.ProcessEnv);

  assert.equal(
    env.MDCMS_AUTH_OIDC_PROVIDERS[0]?.issuer,
    "https://tenant.example.com",
  );
});

test("parseServerEnv parses studio allowed origins as normalized origin strings", () => {
  const env = parseServerEnv({
    MDCMS_STUDIO_ALLOWED_ORIGINS:
      " http://localhost:4173 , https://admin.example.com/ ",
  } as NodeJS.ProcessEnv);

  assert.deepEqual(env.MDCMS_STUDIO_ALLOWED_ORIGINS, [
    "http://localhost:4173",
    "https://admin.example.com",
  ]);
});

test("parseServerEnv parses studio runtime disabled flag as boolean", () => {
  const enabled = parseServerEnv({
    MDCMS_STUDIO_RUNTIME_DISABLED: "true",
  } as NodeJS.ProcessEnv);
  const disabled = parseServerEnv({
    MDCMS_STUDIO_RUNTIME_DISABLED: "false",
  } as NodeJS.ProcessEnv);

  assert.equal(enabled.MDCMS_STUDIO_RUNTIME_DISABLED, true);
  assert.equal(disabled.MDCMS_STUDIO_RUNTIME_DISABLED, false);
});

test("parseServerEnv trims optional preview token secret", () => {
  const env = parseServerEnv({
    MDCMS_PREVIEW_TOKEN_SECRET: "  preview-secret-value  ",
  } as NodeJS.ProcessEnv);

  assert.equal(env.MDCMS_PREVIEW_TOKEN_SECRET, "preview-secret-value");
});

test("parseServerEnv leaves preview token secret undefined when absent", () => {
  const env = parseServerEnv({} as NodeJS.ProcessEnv);

  assert.equal(env.MDCMS_PREVIEW_TOKEN_SECRET, undefined);
});

test("parseServerEnv rejects invalid studio runtime disabled flag values", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_STUDIO_RUNTIME_DISABLED: "sometimes",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "MDCMS_STUDIO_RUNTIME_DISABLED",
  );
});

test("parseServerEnv rejects studio allowed origins that are not absolute origins", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_STUDIO_ALLOWED_ORIGINS: "https://admin.example.com/path",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "MDCMS_STUDIO_ALLOWED_ORIGINS",
  );
});

test("parseServerEnv rejects malformed OIDC provider JSON", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: "not-json",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "INVALID_ENV",
  );
});

test("parseServerEnv rejects non-array OIDC provider payloads", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify({
          providerId: "okta",
        }),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "MDCMS_AUTH_OIDC_PROVIDERS must be a JSON array.",
  );
});

test("parseServerEnv rejects unsupported OIDC provider IDs", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "github",
            issuer: "https://github.example.com",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "INVALID_ENV",
  );
});

test("parseServerEnv rejects duplicate OIDC provider IDs and domains", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://okta-a.example.com",
            domain: "example.com",
            clientId: "client-id-a",
            clientSecret: "client-secret-a",
          },
          {
            providerId: "okta",
            issuer: "https://okta-b.example.com",
            domain: "example.com",
            clientId: "client-id-b",
            clientSecret: "client-secret-b",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "INVALID_ENV",
  );
});

test("parseServerEnv rejects missing required OIDC provider fields", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError && error.code === "INVALID_ENV",
  );
});

test("parseServerEnv rejects blank scope entries as non-empty strings", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            scopes: ["openid", "   "],
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "scopes must be a non-empty string.",
  );
});

test("parseServerEnv rejects empty scopes arrays", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            scopes: [],
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "scopes must not be empty.",
  );
});

test("parseServerEnv preserves non-empty-string errors for blank OIDC URL fields", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "issuer must be a non-empty string.",
  );

  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            discoveryOverrides: {
              authorizationEndpoint: "",
            },
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message ===
        "discoveryOverrides.authorizationEndpoint must be a non-empty string.",
  );
});

test("parseServerEnv preserves discovery override unknown-key and auth-method envelopes", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            discoveryOverrides: {
              unsupported: "https://fixtures.mdcms.local/unsupported",
            },
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "discoveryOverrides.unsupported is not supported." &&
      error.details?.overrideKey === "unsupported",
  );

  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
            discoveryOverrides: {
              tokenEndpointAuthMethod: "private_key_jwt",
            },
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message ===
        "discoveryOverrides.tokenEndpointAuthMethod must be client_secret_basic or client_secret_post.",
  );
});

test("parseServerEnv parses valid SAML provider config", () => {
  const env = parseServerEnv({
    MDCMS_AUTH_SAML_PROVIDERS: JSON.stringify([
      {
        providerId: "okta-saml",
        issuer: "https://www.okta.com/exk123456789",
        domain: "example.com",
        entryPoint: "https://example.okta.com/app/example/sso/saml",
        cert: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
        audience: "https://cms.example.com/saml/okta-saml/sp",
        spEntityId: "https://cms.example.com/saml/okta-saml/sp",
        identifierFormat:
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        authnRequestsSigned: true,
        wantAssertionsSigned: true,
        attributeMapping: {
          id: "nameID",
          email: "email",
          name: "displayName",
          firstName: "givenName",
          lastName: "surname",
        },
      },
    ]),
  } as NodeJS.ProcessEnv);

  assert.equal(env.MDCMS_AUTH_SAML_PROVIDERS.length, 1);
  assert.deepEqual(env.MDCMS_AUTH_SAML_PROVIDERS[0], {
    providerId: "okta-saml",
    issuer: "https://www.okta.com/exk123456789",
    domain: "example.com",
    entryPoint: "https://example.okta.com/app/example/sso/saml",
    cert: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
    audience: "https://cms.example.com/saml/okta-saml/sp",
    spEntityId: "https://cms.example.com/saml/okta-saml/sp",
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    authnRequestsSigned: true,
    wantAssertionsSigned: true,
    attributeMapping: {
      id: "nameID",
      email: "email",
      name: "displayName",
      firstName: "givenName",
      lastName: "surname",
    },
  });
});

test("parseServerEnv treats absent or blank SAML provider config as no providers", () => {
  assert.deepEqual(
    parseServerEnv({} as NodeJS.ProcessEnv).MDCMS_AUTH_SAML_PROVIDERS,
    [],
  );
  assert.deepEqual(
    parseServerEnv({
      MDCMS_AUTH_SAML_PROVIDERS: "   ",
    } as NodeJS.ProcessEnv).MDCMS_AUTH_SAML_PROVIDERS,
    [],
  );
});

test("parseServerEnv rejects malformed SAML provider JSON", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_SAML_PROVIDERS: "not-json",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "MDCMS_AUTH_SAML_PROVIDERS",
  );
});

test("parseServerEnv rejects non-array SAML provider payloads", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_SAML_PROVIDERS: JSON.stringify({
          providerId: "okta-saml",
        }),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "MDCMS_AUTH_SAML_PROVIDERS must be a JSON array.",
  );
});

test("parseServerEnv rejects missing required SAML provider fields", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_SAML_PROVIDERS: JSON.stringify([
          {
            providerId: "okta-saml",
            issuer: "",
            domain: "example.com",
            entryPoint: "https://example.okta.com/app/example/sso/saml",
            cert: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "MDCMS_AUTH_SAML_PROVIDERS",
  );
});

test("parseServerEnv rejects duplicate SAML domains", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_SAML_PROVIDERS: JSON.stringify([
          {
            providerId: "okta-saml",
            issuer: "https://www.okta.com/exk123456789",
            domain: "example.com",
            entryPoint: "https://example.okta.com/app/example/sso/saml",
            cert: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
          },
          {
            providerId: "azure-saml",
            issuer: "https://sts.windows.net/tenant-id/",
            domain: "example.com",
            entryPoint: "https://login.microsoftonline.com/tenant-id/saml2",
            cert: "-----BEGIN CERTIFICATE-----\\ndef\\n-----END CERTIFICATE-----",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "MDCMS_AUTH_SAML_PROVIDERS",
  );
});

test("parseServerEnv rejects duplicate providerId across OIDC and SAML providers", () => {
  assert.throws(
    () =>
      parseServerEnv({
        MDCMS_AUTH_OIDC_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://example.okta.com/oauth2/default",
            domain: "oidc.example.com",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        ]),
        MDCMS_AUTH_SAML_PROVIDERS: JSON.stringify([
          {
            providerId: "okta",
            issuer: "https://www.okta.com/exk123456789",
            domain: "saml.example.com",
            entryPoint: "https://example.okta.com/app/example/sso/saml",
            cert: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
          },
        ]),
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.message === "providerId okta must be unique across OIDC and SAML.",
  );
});
