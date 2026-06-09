import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { inflateRawSync } from "node:zlib";

import { DiscoveryError, discoverOIDCConfig, sso } from "@better-auth/sso";
import {
  RuntimeError,
  assertRequestTargetRouting,
  createEmptyCurrentPrincipalCapabilities,
  isRuntimeErrorLike,
  serializeError,
  type CurrentPrincipalCapabilities,
  type CurrentPrincipalCapabilitiesResponse,
} from "@mdcms/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleDatabase } from "./db.js";
import {
  apiKeys,
  authAccounts,
  authLoginBackoffs,
  authSessions,
  authUsers,
  authVerifications,
  cliLoginChallenges,
  invites,
  rbacGrants,
  type ApiKeyScopeTuple,
} from "./db/schema.js";
import {
  parseServerEnv,
  type OidcProviderConfig,
  type OidcTokenEndpointAuthMethod,
  type SamlProviderConfig,
} from "./env.js";
import {
  createJsonResponse,
  executeWithRuntimeErrorsHandled,
} from "./http-utils.js";
import type { EmailService } from "./email.js";
import {
  assertOwnerMutationAllowed,
  evaluatePermission,
  type RbacAction,
  type RbacGrant,
  type RbacRole,
} from "./rbac.js";

export const API_KEY_OPERATION_SCOPES = [
  "content:read",
  "content:read:draft",
  "content:write",
  "content:write:draft",
  "content:publish",
  "content:delete",
  "schema:read",
  "schema:write",
  "media:read",
  "media:upload",
  "media:delete",
  "webhooks:read",
  "webhooks:write",
  "environments:clone",
  "environments:promote",
  "migrations:run",
  "projects:read",
  "projects:write",
  "ai:use",
] as const;

const API_KEY_PREFIX = "mdcms_key_";
const LEGACY_CONTENT_WRITE_DRAFT_SCOPE = "content:write:draft";
const SESSION_INACTIVITY_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const SESSION_ABSOLUTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_LOGIN_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const LOGIN_BACKOFF_RESET_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BACKOFF_DELAYS_SECONDS = [1, 2, 4, 8, 16, 32] as const;
const CSRF_COOKIE_NAME = "mdcms_csrf";
const CSRF_HEADER_NAME = "x-mdcms-csrf-token";
const CSRF_TOKEN_BYTES = 24;
const OIDC_CALLBACK_PROVISIONING_WINDOW_MS = 5_000;
const SAML_AUTHN_REQUEST_TTL_MS = 5 * 60 * 1000;
const CLI_LOGIN_DEFAULT_SCOPES: readonly ApiKeyOperationScope[] = [
  "content:read",
  "content:read:draft",
  "content:write",
  "content:delete",
  "schema:read",
  "schema:write",
];

export type ApiKeyOperationScope = (typeof API_KEY_OPERATION_SCOPES)[number];

export type StudioSession = {
  id: string;
  userId: string;
  email: string;
  issuedAt: string;
  expiresAt: string;
};

export type AuthorizedActor = {
  id: string;
  email: string;
};

export type ApiKeyPrincipal = {
  type: "api_key";
  keyId: string;
  createdByUserId: string;
  createdByUserEmail: string;
  keyPrefix: string;
  label: string;
  scopes: readonly ApiKeyOperationScope[];
  contextAllowlist: readonly ApiKeyScopeTuple[];
};

export type SessionPrincipal = {
  type: "session";
  session: StudioSession;
  role?: RbacRole;
};

export type AuthPrincipal = ApiKeyPrincipal | SessionPrincipal;

export type AuthorizationRequirement = {
  requiredScope: ApiKeyOperationScope;
  project?: string;
  environment?: string;
  documentPath?: string;
};

export type AuthorizedRequest = {
  mode: "session" | "api_key";
  principal: AuthPrincipal;
};

export function actorFromAuthorizedRequest(
  authorized: AuthorizedRequest,
): AuthorizedActor {
  if (authorized.principal.type === "session") {
    return {
      id: authorized.principal.session.userId,
      email: authorized.principal.session.email,
    };
  }

  return {
    id: authorized.principal.createdByUserId,
    email: authorized.principal.createdByUserEmail,
  };
}

export type CreateApiKeyInput = {
  label: string;
  scopes: ApiKeyOperationScope[];
  contextAllowlist: ApiKeyScopeTuple[];
  expiresAt?: string;
};

export type ApiKeyMetadata = {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: ApiKeyOperationScope[];
  contextAllowlist: ApiKeyScopeTuple[];
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type CliLoginStartInput = {
  project: string;
  environment: string;
  redirectUri: string;
  state: string;
  scopes?: ApiKeyOperationScope[];
};

export type CliLoginStartResult = {
  challengeId: string;
  authorizeUrl: string;
  expiresAt: string;
};

export type CliLoginAuthorizeInput = {
  challengeId: string;
  state: string;
  email?: string;
  password?: string;
  request: Request;
};

export type CliLoginAuthorizeResult =
  | {
      outcome: "login_required";
      challengeId: string;
      state: string;
    }
  | {
      outcome: "throttled";
      retryAfterSeconds: number;
    }
  | {
      outcome: "redirect";
      location: string;
      setCookie?: string;
    };

export type CliLoginExchangeInput = {
  challengeId: string;
  state: string;
  code: string;
};

export type AuthService = {
  login: (
    request: Request,
    email: string,
    password: string,
  ) => Promise<PasswordLoginResult>;
  getSession: (request: Request) => Promise<StudioSession | undefined>;
  getCurrentPrincipalCapabilities: (
    request: Request,
  ) => Promise<CurrentPrincipalCapabilitiesResponse>;
  requireAdminSession: (request: Request) => Promise<StudioSession>;
  logout: (request: Request) => Promise<{
    revoked: boolean;
    setCookie?: string;
  }>;
  signOut: (request: Request) => Promise<Response>;
  authorizeRequest: (
    request: Request,
    requirement: AuthorizationRequirement,
  ) => Promise<AuthorizedRequest>;
  requireCsrfProtection: (request: Request) => Promise<void>;
  issueCsrfBootstrap: (request?: Request) => {
    token: string;
    setCookie: string;
  };
  clearCsrfCookie: () => string;
  createApiKey: (
    request: Request,
    input: CreateApiKeyInput,
  ) => Promise<{ key: string; metadata: ApiKeyMetadata }>;
  listApiKeys: (request: Request) => Promise<ApiKeyMetadata[]>;
  revokeApiKey: (request: Request, keyId: string) => Promise<ApiKeyMetadata>;
  revokeSelfApiKey: (
    request: Request,
  ) => Promise<{ revoked: boolean; keyId: string }>;
  startCliLogin: (input: CliLoginStartInput) => Promise<CliLoginStartResult>;
  authorizeCliLogin: (
    input: CliLoginAuthorizeInput,
  ) => Promise<CliLoginAuthorizeResult>;
  exchangeCliLogin: (
    input: CliLoginExchangeInput,
  ) => Promise<{ key: string; metadata: ApiKeyMetadata }>;
  revokeAllUserSessions: (userId: string) => Promise<number>;
  revokeAllSessionsForUserByAdmin: (
    request: Request,
    userId: string,
  ) => Promise<{
    userId: string;
    revokedSessions: number;
  }>;
  startSsoSignIn: (request: Request) => Promise<Response>;
  handleSsoCallback: (request: Request) => Promise<Response>;
  handleSamlAcs: (request: Request) => Promise<Response>;
  handleSamlMetadata: (request: Request) => Promise<Response>;
  handleAuthRequest: (request: Request) => Promise<Response>;
  listSsoProviders: () => Array<{ id: string; name: string }>;
  listUsers: (request: Request) => Promise<UserWithGrants[]>;
  getUser: (request: Request, userId: string) => Promise<UserWithGrants>;
  inviteUser: (
    request: Request,
    input: InviteUserInput,
  ) => Promise<{
    id: string;
    email: string;
    expiresAt: string;
  }>;
  updateUserGrants: (
    request: Request,
    userId: string,
    grants: InviteUserInput["grants"],
  ) => Promise<UserWithGrants>;
  removeUser: (request: Request, userId: string) => Promise<{ removed: true }>;
  listInvites: (request: Request) => Promise<PendingInvite[]>;
  revokeInvite: (
    request: Request,
    inviteId: string,
  ) => Promise<{ revoked: true }>;
  acceptInvite: (
    token: string,
    input: AcceptInviteInput,
  ) => Promise<{ userId: string }>;
};

export type UserWithGrants = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
  grants: Array<{
    id: string;
    role: string;
    scopeKind: string;
    project: string | null;
    environment: string | null;
    pathPrefix: string | null;
    createdAt: string;
  }>;
};

export type PendingInvite = {
  id: string;
  email: string;
  grants: Array<{
    role: string;
    scopeKind: string;
    project?: string;
    environment?: string;
    pathPrefix?: string;
  }>;
  createdAt: string;
  expiresAt: string;
};

export type InviteUserInput = {
  email: string;
  grants: Array<{
    role: string;
    scopeKind: string;
    project?: string;
    environment?: string;
    pathPrefix?: string;
  }>;
};

export type AcceptInviteInput = {
  name: string;
  password: string;
};

type BetterAuthLikeSession = {
  session?: {
    id?: unknown;
    userId?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
  };
  user?: {
    id?: unknown;
    email?: unknown;
  };
};

type PasswordLoginResult =
  | {
      outcome: "success";
      csrfToken: string;
      session: StudioSession;
      setCookie: string;
    }
  | {
      outcome: "throttled";
      retryAfterSeconds: number;
    };

type AuthRouteApp = {
  get?: (path: string, handler: (ctx: any) => unknown) => AuthRouteApp;
  post?: (path: string, handler: (ctx: any) => unknown) => AuthRouteApp;
  patch?: (path: string, handler: (ctx: any) => unknown) => AuthRouteApp;
  delete?: (path: string, handler: (ctx: any) => unknown) => AuthRouteApp;
};

type StaticOidcProvider = {
  providerId: OidcProviderConfig["providerId"];
  domain: string;
  oidcConfig: {
    issuer: string;
    discoveryEndpoint: string;
    clientId: string;
    clientSecret: string;
    pkce: true;
    scopes: string[];
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
    jwksEndpoint?: string;
    tokenEndpointAuthentication?: OidcTokenEndpointAuthMethod;
    mapping: {
      id: "sub";
      email: "email";
      emailVerified: "email_verified";
      name: "name";
      image: "picture";
      extraFields: {
        givenName: "given_name";
        familyName: "family_name";
        preferredUsername: "preferred_username";
      };
    };
  };
};

type StaticSamlProvider = {
  providerId: SamlProviderConfig["providerId"];
  domain: string;
  samlConfig: {
    issuer: string;
    entryPoint: string;
    cert: string;
    callbackUrl: string;
    audience?: string;
    spMetadata: {
      entityID?: string;
    };
    identifierFormat?: string;
    authnRequestsSigned?: boolean;
    wantAssertionsSigned?: boolean;
    mapping?: SamlProviderConfig["attributeMapping"];
  };
};

type StaticSsoPluginOptions = NonNullable<Parameters<typeof sso>[0]>;

type OidcCanonicalClaims = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
};

type OidcCallbackRecord = {
  sessionId: string;
  sessionCreatedAt: Date;
  userId: string;
  userCreatedAt: Date;
  userEmail: string;
  userEmailVerified: boolean;
  userName: string;
  userImage: string | null;
  accountRowId: string;
  accountCreatedAt: Date;
  accountId: string;
  accountAccessToken: string | null;
  accountIdToken: string | null;
};

type SamlCallbackRecord = {
  sessionId: string;
  sessionCreatedAt: Date;
  userId: string;
  userCreatedAt: Date;
  userEmail: string;
  userEmailVerified: boolean;
  userName: string;
  userImage: string | null;
  accountRowId: string;
  accountCreatedAt: Date;
  accountId: string;
};

type SamlCanonicalClaims = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

type SamlifyMetadataBuilder = {
  getMetadata(): string;
};

type SamlifyModule = {
  SPMetadata: (options: Record<string, unknown>) => SamlifyMetadataBuilder;
};

type AuthHandlerErrorPayload = {
  code?: unknown;
  details?: unknown;
  message?: unknown;
};

type SamlAcsPayload = {
  RelayState?: string;
  SAMLResponse?: string;
};

const DEFAULT_SAML_ATTRIBUTE_MAPPING = {
  id: "nameID",
  email: "email",
  name: "displayName",
  firstName: "givenName",
  lastName: "surname",
} as const;

const CreateApiKeyInputSchema = z.object({
  label: z.string().trim().min(1).max(128),
  scopes: z.array(z.enum(API_KEY_OPERATION_SCOPES)).min(1),
  contextAllowlist: z
    .array(
      z.object({
        project: z.string().trim().min(1),
        environment: z.string().trim().min(1),
      }),
    )
    .min(1),
  expiresAt: z.string().datetime().optional(),
});

const CliLoginStartInputSchema = z.object({
  project: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  redirectUri: z.string().trim().url(),
  state: z.string().trim().min(16).max(256),
  scopes: z.array(z.enum(API_KEY_OPERATION_SCOPES)).min(1).optional(),
});

const CliLoginExchangeInputSchema = z.object({
  challengeId: z.string().uuid(),
  state: z.string().trim().min(16).max(256),
  code: z.string().trim().min(16).max(256),
});

const SsoSignInInputSchema = z
  .object({
    providerId: z.string().trim().min(1),
    callbackURL: z.string().trim().min(1),
    errorCallbackURL: z.string().trim().min(1).optional(),
    newUserCallbackURL: z.string().trim().min(1).optional(),
    loginHint: z.string().trim().min(1).optional(),
  })
  .strict();

const SamlMetadataQuerySchema = z.object({
  providerId: z.string().trim().min(1),
  format: z.enum(["xml", "json"]).default("xml"),
});

function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return new Date(value).toISOString();
  }

  return new Date(value as any).toISOString();
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Field "${field}" is required.`,
      statusCode: 400,
      details: { field },
    });
  }

  return value.trim();
}

function extractCookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader || setCookieHeader.trim().length === 0) {
    throw new RuntimeError({
      code: "INTERNAL_ERROR",
      message: "Auth provider did not return a session cookie.",
      statusCode: 500,
    });
  }

  const [pair] = setCookieHeader.split(";");

  if (!pair || pair.trim().length === 0) {
    throw new RuntimeError({
      code: "INTERNAL_ERROR",
      message: "Auth provider returned an invalid session cookie.",
      statusCode: 500,
    });
  }

  return pair.trim();
}

function splitSetCookieHeader(setCookieHeader: string): string[] {
  const values: string[] = [];
  let current = "";
  let index = 0;

  while (index < setCookieHeader.length) {
    const character = setCookieHeader[index];

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

      if (index < setCookieHeader.length && setCookieHeader[index] === " ") {
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

function createSamlAcsRequestKey(
  requestUrl: string,
  samlResponse: string | undefined,
): string {
  if (!samlResponse) {
    return requestUrl;
  }

  return `${requestUrl}#${createHash("sha256").update(samlResponse).digest("hex")}`;
}

function appendSetCookieHeaders(
  ...values: Array<string | null | undefined>
): string | undefined {
  const normalized = values
    .flatMap((value) => (value ? splitSetCookieHeader(value) : []))
    .filter((value, index, array) => array.indexOf(value) === index);

  return normalized.length > 0 ? normalized.join(", ") : undefined;
}

function normalizeOptionalOidcClaimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUsableSamlEmail(value: unknown): string | undefined {
  const normalized = normalizeOptionalOidcClaimString(value);

  if (!normalized) {
    return undefined;
  }

  const parsed = z.string().email().safeParse(normalized);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

function selectOidcClaimString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = normalizeOptionalOidcClaimString(value);

    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function selectOidcBooleanClaim(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (value === true || value === false) {
      return value;
    }
  }

  return undefined;
}

function decodeJwtPayload(
  token: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }

  const [, payload] = token.split(".");

  if (!payload) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeOidcClaims(
  claims: Record<string, unknown>,
): OidcCanonicalClaims {
  const id = normalizeOptionalOidcClaimString(claims.sub);
  const email = normalizeOptionalOidcClaimString(claims.email);

  if (!id || !email) {
    throw createRequiredOidcClaimError();
  }

  const combinedName = [
    normalizeOptionalOidcClaimString(claims.given_name),
    normalizeOptionalOidcClaimString(claims.family_name),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();

  return {
    id,
    email,
    emailVerified: claims.email_verified === true,
    name:
      normalizeOptionalOidcClaimString(claims.name) ||
      combinedName ||
      normalizeOptionalOidcClaimString(claims.preferred_username) ||
      email,
    image: normalizeOptionalOidcClaimString(claims.picture) ?? null,
  };
}

function wasCreatedDuringOidcCallback(
  createdAt: Date,
  sessionCreatedAt: Date,
): boolean {
  return (
    Math.abs(createdAt.getTime() - sessionCreatedAt.getTime()) <=
    OIDC_CALLBACK_PROVISIONING_WINDOW_MS
  );
}

function serializeCookie(input: {
  name: string;
  value: string;
  path?: string;
  sameSite?: "Strict" | "Lax" | "None";
  secure?: boolean;
  httpOnly?: boolean;
  maxAge?: number;
}): string {
  const parts = [`${input.name}=${input.value}`];

  if (input.path) {
    parts.push(`Path=${input.path}`);
  }

  if (input.maxAge !== undefined) {
    parts.push(`Max-Age=${input.maxAge}`);
  }

  if (input.sameSite) {
    parts.push(`SameSite=${input.sameSite}`);
  }

  if (input.secure) {
    parts.push("Secure");
  }

  if (input.httpOnly) {
    parts.push("HttpOnly");
  }

  return parts.join("; ");
}

function readCookieValue(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");

  if (!cookieHeader) {
    return undefined;
  }

  for (const candidate of cookieHeader.split(";")) {
    const trimmed = candidate.trim();

    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }

  return undefined;
}

function isStateChangingMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return (
    normalized.length > 0 &&
    normalized !== "GET" &&
    normalized !== "HEAD" &&
    normalized !== "OPTIONS"
  );
}

function withSetCookie(
  response: Response,
  setCookie: string | undefined,
): Response {
  if (!setCookie) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    appendSetCookieHeaders(headers.get("set-cookie"), setCookie) ?? setCookie,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function extractBearerToken(
  authorizationHeader: string | null,
): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const trimmed = authorizationHeader.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const [scheme, token] = trimmed.split(/\s+/, 2);

  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    throw new RuntimeError({
      code: "UNAUTHORIZED",
      message: "Authorization header must use Bearer token format.",
      statusCode: 401,
    });
  }

  return token;
}

function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashCliLoginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertLoopbackRedirectUri(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "redirectUri" must be a valid URL.',
      statusCode: 400,
      details: { field: "redirectUri" },
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopbackHost =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

  if (parsed.protocol !== "http:" || !isLoopbackHost) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message:
        'Field "redirectUri" must use loopback HTTP origin (127.0.0.1, localhost, or ::1).',
      statusCode: 400,
      details: { field: "redirectUri", value },
    });
  }

  if (!parsed.port) {
    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: 'Field "redirectUri" must include an explicit loopback port.',
      statusCode: 400,
      details: { field: "redirectUri", value },
    });
  }

  return parsed.toString();
}

function appendQueryParams(
  url: string,
  params: Record<string, string>,
): string {
  const parsed = new URL(url);

  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }

  return parsed.toString();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCliHtmlPage(options: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(options.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{
  font-family:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:1rem;
  background:#FCF9F8;
  background-image:
    radial-gradient(ellipse at top left,rgba(47,73,229,0.08) 0%,transparent 60%),
    linear-gradient(to bottom,#FCF9F8,#F6F3F2);
}
.card{
  width:100%;
  max-width:400px;
  background:#FFFFFF;
  border:1px solid #C5C5D8;
  border-radius:0.5rem;
  padding:2rem;
  box-shadow:0 1px 3px rgba(0,0,0,0.04),0 1px 2px rgba(0,0,0,0.06);
}
.logo{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:0.5rem;
  margin-bottom:1.5rem;
}
.logo svg{width:28px;height:28px;flex-shrink:0;}
.logo span{
  font-family:'Space Grotesk',sans-serif;
  font-weight:700;
  font-size:1.125rem;
  letter-spacing:-0.01em;
  color:#1C1B1B;
}
h1{
  font-family:'Space Grotesk',sans-serif;
  font-weight:700;
  font-size:1.25rem;
  text-align:center;
  color:#1C1B1B;
  margin-bottom:0.25rem;
}
.subtitle{
  font-size:0.875rem;
  color:#444655;
  text-align:center;
  margin-bottom:1.5rem;
}
label{
  display:block;
  font-size:0.875rem;
  font-weight:500;
  color:#1C1B1B;
  margin-bottom:0.25rem;
}
input[type="email"],input[type="password"],input[type="text"]{
  width:100%;
  padding:0.5rem 0.75rem;
  font-size:0.875rem;
  font-family:inherit;
  border:1px solid #C5C5D8;
  border-radius:0.375rem;
  outline:none;
  transition:border-color 0.15s;
  margin-bottom:0.75rem;
}
input:focus{border-color:#2F49E5;box-shadow:0 0 0 2px rgba(47,73,229,0.15);}
button[type="submit"]{
  width:100%;
  padding:0.625rem 1rem;
  font-size:0.875rem;
  font-weight:500;
  font-family:inherit;
  color:#FFFFFF;
  background:#2F49E5;
  border:none;
  border-radius:0.375rem;
  cursor:pointer;
  transition:background 0.15s;
  margin-top:0.25rem;
}
button[type="submit"]:hover{background:#2740cc;}
.error-banner{
  background:rgba(239,68,68,0.1);
  color:#ef4444;
  font-size:0.875rem;
  padding:0.625rem 0.75rem;
  border-radius:0.375rem;
  margin-bottom:1rem;
  text-align:center;
}
.message{
  font-size:0.875rem;
  color:#444655;
  text-align:center;
  line-height:1.5;
}
.message code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-size:0.8125rem;
  background:rgba(0,0,0,0.06);
  padding:0.125rem 0.375rem;
  border-radius:0.25rem;
}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg viewBox="0 4 35 35" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.4954 19.8468C16.8523 19.7988 16.5695 19.8252 16.0137 20.1448C13.9577 21.3269 11.8896 22.4902 9.84301 23.6884C8.71035 24.3515 8.86327 25.4939 8.86856 26.6135L8.87323 29.049L8.86754 31.4129C8.86208 33.6365 8.87086 33.7353 10.8305 34.8569L12.7272 35.9412C13.5772 36.4271 16.0648 37.9743 16.7961 38.1227C17.4032 38.1839 17.7316 38.1169 18.2555 37.8171C20.2878 36.6538 22.3256 35.499 24.3513 34.3245C25.5248 33.644 25.3944 32.6758 25.3941 31.522L25.3915 28.8691L25.396 26.5205C25.4007 24.3233 25.3797 24.2285 23.4707 23.1348L21.5627 22.0412L19.3001 20.7437C18.7928 20.4531 18.047 19.9646 17.4954 19.8468Z" fill="#1C1B1B"/>
      <path d="M26.4326 4.08956C25.8135 4.03531 25.4981 4.07102 24.9624 4.38156C23.0193 5.50784 21.084 6.64735 19.1433 7.77787C18.6139 8.08624 18.1508 8.4779 18.0124 9.10786C17.8664 9.77215 17.9212 10.5397 17.9239 11.2234L17.9247 13.6338L17.921 15.6797C17.9197 16.4984 17.8187 17.4363 18.3987 18.0931C18.766 18.509 19.2648 18.7439 19.7366 19.0229C20.2456 19.3238 20.7602 19.6176 21.2709 19.9157L23.6489 21.307C24.1935 21.6256 25.092 22.2074 25.6525 22.359C26.5274 22.4342 26.7078 22.3363 27.436 21.9116L31.5337 19.5176C31.9048 19.301 33.2517 18.5452 33.5247 18.301C33.809 18.0485 34.0095 17.7153 34.0996 17.3458C34.2306 16.8302 34.1905 15.8811 34.1881 15.3182L34.1869 12.9892L34.1909 10.8318C34.1941 8.63869 34.2067 8.49732 32.3014 7.38407L30.5377 6.35429L28.3471 5.07312C27.8022 4.75331 27.0227 4.23424 26.4326 4.08956Z" fill="#CAF240"/>
      <path d="M8.58217 4.09055C7.9301 4.03424 7.61858 4.07788 7.05481 4.40779C5.09063 5.5562 3.12254 6.6993 1.1626 7.85475C0.628794 8.16937 0.310829 8.51792 0.146414 9.13369C0.101146 9.30918 0.0754332 9.48911 0.0692766 9.67022C0.0174895 10.8607 0.0739828 12.4295 0.0721723 13.6712L0.0681892 15.7221C0.062757 17.8453 0.0895542 17.9803 1.90428 19.0366L3.63425 20.0439L5.9733 21.413C6.50528 21.7242 7.23024 22.2109 7.80661 22.3603C8.5945 22.4512 8.87405 22.3186 9.52562 21.9424L13.5603 19.5843C14.0662 19.2898 14.6172 18.9422 15.1248 18.67C16.5527 17.9041 16.3376 16.7588 16.3309 15.3383L16.3291 13.0458L16.3337 10.8074C16.3349 10.0947 16.4178 9.24654 16.0423 8.6199C15.9028 8.38554 15.7166 8.18226 15.4955 8.02259C15.2008 7.8081 14.7526 7.56378 14.4259 7.37299L12.6291 6.32531C11.4588 5.64323 10.2823 4.93464 9.099 4.27731C8.93579 4.18663 8.763 4.13495 8.58217 4.09055Z" fill="#2F49E5"/>
    </svg>
    <span>MDCMS</span>
  </div>
  ${options.body}
</div>
</body>
</html>`;
}

function renderCliAuthorizeLoginForm(input: {
  challengeId: string;
  state: string;
  errorMessage?: string;
}): string {
  const errorBanner = input.errorMessage
    ? `<div class="error-banner">${escapeHtml(input.errorMessage)}</div>`
    : "";

  return renderCliHtmlPage({
    title: "MDCMS — Authorize CLI",
    body: `
<p class="subtitle">Sign in to authorize CLI</p>
<form method="post" action="/api/v1/auth/cli/login/authorize?challenge=${encodeURIComponent(input.challengeId)}&state=${encodeURIComponent(input.state)}">
  ${errorBanner}
  <label>Email<input name="email" type="email" autocomplete="email" placeholder="you@company.com" required /></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" placeholder="••••••••" required /></label>
  <button type="submit">Authorize</button>
</form>`,
  });
}

function renderCliErrorPage(options: {
  title: string;
  heading: string;
  message: string;
}): string {
  return renderCliHtmlPage({
    title: `MDCMS — ${options.title}`,
    body: `<h1>${escapeHtml(options.heading)}</h1><p class="message" style="margin-top:0.75rem;">${options.message}</p>`,
  });
}

function renderCliChallengeError(error: unknown): Response | null {
  if (!isRuntimeErrorLike(error)) return null;

  if (error.code === "LOGIN_CHALLENGE_EXPIRED") {
    return new Response(
      renderCliErrorPage({
        title: "Login Link Expired",
        heading: "Login link expired",
        message:
          "This authorization link has expired. Please run <code>mdcms login</code> again to start a new session.",
      }),
      { status: 410, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (error.code === "LOGIN_CHALLENGE_USED") {
    return new Response(
      renderCliErrorPage({
        title: "Link Already Used",
        heading: "Link already used",
        message:
          "This authorization link has already been used. Please run <code>mdcms login</code> again if you need a new session.",
      }),
      { status: 409, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  if (error.code === "NOT_FOUND") {
    return new Response(
      renderCliErrorPage({
        title: "Invalid Login Link",
        heading: "Invalid login link",
        message:
          "This authorization link is not valid. Please run <code>mdcms login</code> to start a new session.",
      }),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  return null;
}

function ensureValidApiKeyToken(token: string): void {
  if (!token.startsWith(API_KEY_PREFIX)) {
    throw new RuntimeError({
      code: "UNAUTHORIZED",
      message: "Invalid API key format.",
      statusCode: 401,
    });
  }
}

function normalizeApiKeyScopes(value: unknown): ApiKeyOperationScope[] {
  const parsed = z.array(z.enum(API_KEY_OPERATION_SCOPES)).safeParse(value);

  if (!parsed.success) {
    throw new RuntimeError({
      code: "INTERNAL_ERROR",
      message: "Stored API key scopes are invalid.",
      statusCode: 500,
    });
  }

  return parsed.data;
}

function normalizeApiKeyContextAllowlist(value: unknown): ApiKeyScopeTuple[] {
  const parsed = z
    .array(
      z.object({
        project: z.string().trim().min(1),
        environment: z.string().trim().min(1),
      }),
    )
    .safeParse(value);

  if (!parsed.success) {
    throw new RuntimeError({
      code: "INTERNAL_ERROR",
      message: "Stored API key context allowlist is invalid.",
      statusCode: 500,
    });
  }

  return parsed.data;
}

function toApiKeyMetadata(row: typeof apiKeys.$inferSelect): ApiKeyMetadata {
  return {
    id: row.id,
    label: row.label,
    keyPrefix: row.keyPrefix,
    scopes: normalizeApiKeyScopes(row.scopes),
    contextAllowlist: normalizeApiKeyContextAllowlist(row.contextAllowlist),
    createdByUserId: row.createdByUserId,
    createdAt: toIsoString(row.createdAt),
    expiresAt: row.expiresAt ? toIsoString(row.expiresAt) : null,
    revokedAt: row.revokedAt ? toIsoString(row.revokedAt) : null,
    lastUsedAt: row.lastUsedAt ? toIsoString(row.lastUsedAt) : null,
  };
}

function toStudioSession(payload: BetterAuthLikeSession): StudioSession {
  const sessionId = assertNonEmptyString(payload.session?.id, "session.id");
  const userId = assertNonEmptyString(payload.user?.id, "user.id");
  const email = assertNonEmptyString(payload.user?.email, "user.email");
  const issuedAt = toIsoString(payload.session?.createdAt);
  const expiresAt = toIsoString(payload.session?.expiresAt);

  return {
    id: sessionId,
    userId,
    email,
    issuedAt,
    expiresAt,
  };
}

function createInvalidInputError(
  message: string,
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_INPUT",
    message,
    statusCode: 400,
    details,
  });
}

function createSsoProviderNotConfiguredError(providerId: string): RuntimeError {
  return new RuntimeError({
    code: "SSO_PROVIDER_NOT_CONFIGURED",
    message: `SSO provider "${providerId}" is not configured.`,
    statusCode: 404,
    details: {
      providerId,
    },
  });
}

function createRequiredOidcClaimError(): RuntimeError {
  return new RuntimeError({
    code: "AUTH_OIDC_REQUIRED_CLAIM_MISSING",
    message: "OIDC provider response is missing required claims.",
    statusCode: 401,
  });
}

function createAuthProviderError(
  error: string,
  errorDescription: string,
): RuntimeError {
  return new RuntimeError({
    code: "AUTH_PROVIDER_ERROR",
    message: "SSO provider callback failed.",
    statusCode: 502,
    details: {
      providerError: error,
      providerErrorDescription: errorDescription,
    },
  });
}

function createRequiredSamlAttributeError(
  missingFields: string[] = ["id", "email"],
): RuntimeError {
  return new RuntimeError({
    code: "AUTH_SAML_REQUIRED_ATTRIBUTE_MISSING",
    message: "SAML provider response is missing required attributes.",
    statusCode: 401,
    details: {
      missingFields,
    },
  });
}

function readUnknownErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message} ${error.stack ?? ""}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "";
  }
}

function isMissingRequiredSamlAttributeFailure(error: unknown): boolean {
  const normalized = readUnknownErrorText(error).toLowerCase();

  return (
    normalized.includes("unable to extract user id or email") ||
    normalized.includes("tolowercase is not a function") ||
    normalized.includes("cannot read properties of undefined")
  );
}

function loadSamlifyModule(): SamlifyModule {
  const require = createRequire(import.meta.url);
  const ssoEntry = require.resolve("@better-auth/sso");
  const samlifyEntry = require.resolve("samlify", {
    paths: [ssoEntry],
  });

  return require(samlifyEntry) as SamlifyModule;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function normalizeXmlText(value: string): string {
  return decodeXmlEntities(
    value.replaceAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"),
  )
    .replaceAll(/\s+/g, " ")
    .trim();
}

function decodeSamlResponseXml(samlResponse: string): string {
  try {
    return Buffer.from(samlResponse, "base64").toString("utf8");
  } catch {
    throw createAuthProviderError(
      "invalid_saml_response",
      "SAML response payload could not be decoded.",
    );
  }
}

function decodeSamlRedirectRequestXml(payload: string): string {
  const decoded = Buffer.from(payload, "base64");

  try {
    return inflateRawSync(decoded).toString("utf8");
  } catch {
    return decoded.toString("utf8");
  }
}

function extractSamlAuthnRequestId(location: string): string | undefined {
  const url = new URL(location);
  const samlRequest = url.searchParams.get("SAMLRequest");

  if (!samlRequest) {
    return undefined;
  }

  const xml = decodeSamlRedirectRequestXml(samlRequest);
  const match =
    /<(?:\w+:)?AuthnRequest\b[^>]*\bID=(?:"([^"]*)"|'([^']*)')[^>]*>/i.exec(
      xml,
    );
  const requestId = (match?.[1] ?? match?.[2] ?? "").trim();

  return requestId.length > 0 ? requestId : undefined;
}

function extractSamlNameId(xml: string): string | undefined {
  const match = /<(?:\w+:)?NameID\b[^>]*>([\s\S]*?)<\/(?:\w+:)?NameID>/i.exec(
    xml,
  );
  const value = match ? normalizeXmlText(match[1]) : "";
  return value.length > 0 ? value : undefined;
}

function extractSamlInResponseTo(xml: string): string | undefined {
  const responseMatch =
    /<(?:\w+:)?Response\b[^>]*\bInResponseTo=(?:"([^"]*)"|'([^']*)')[^>]*>/i.exec(
      xml,
    );
  const subjectMatch =
    /<(?:\w+:)?SubjectConfirmationData\b[^>]*\bInResponseTo=(?:"([^"]*)"|'([^']*)')[^>]*>/i.exec(
      xml,
    );
  const value =
    responseMatch?.[1] ??
    responseMatch?.[2] ??
    subjectMatch?.[1] ??
    subjectMatch?.[2] ??
    "";

  return value.trim().length > 0 ? value.trim() : undefined;
}

function extractSamlAttributes(xml: string): Map<string, string[]> {
  const attributes = new Map<string, string[]>();
  const attributePattern =
    /<(?:\w+:)?Attribute\b[^>]*\bName=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/(?:\w+:)?Attribute>/gi;

  for (const match of xml.matchAll(attributePattern)) {
    const name = (match[1] ?? match[2] ?? "").trim();

    if (!name) {
      continue;
    }

    const values = [
      ...(match[3] ?? "").matchAll(
        /<(?:\w+:)?AttributeValue\b[^>]*>([\s\S]*?)<\/(?:\w+:)?AttributeValue>/gi,
      ),
    ]
      .map((valueMatch) => normalizeXmlText(valueMatch[1]))
      .filter((value) => value.length > 0);

    attributes.set(name, values);
  }

  return attributes;
}

function resolveSamlAttributeMapping(provider: SamlProviderConfig) {
  return {
    ...DEFAULT_SAML_ATTRIBUTE_MAPPING,
    ...(provider.attributeMapping ?? {}),
  };
}

function readSamlMappedValue(
  source: string | undefined,
  nameId: string | undefined,
  attributes: Map<string, string[]>,
): string | undefined {
  if (!source) {
    return undefined;
  }

  if (source === "nameID") {
    return nameId;
  }

  const value = attributes
    .get(source)
    ?.find((candidate) => candidate.length > 0);
  return value;
}

function normalizeSamlResponseClaims(
  samlResponse: string,
  provider: SamlProviderConfig,
): SamlCanonicalClaims {
  const xml = decodeSamlResponseXml(samlResponse);
  const nameId = extractSamlNameId(xml);
  const attributes = extractSamlAttributes(xml);
  const mapping = resolveSamlAttributeMapping(provider);
  const id =
    normalizeOptionalOidcClaimString(
      readSamlMappedValue(mapping.id, nameId, attributes),
    ) ?? normalizeOptionalOidcClaimString(nameId);
  const email =
    normalizeUsableSamlEmail(
      readSamlMappedValue(mapping.email, nameId, attributes),
    ) ?? normalizeUsableSamlEmail(nameId);
  const missingFields = [...(id ? [] : ["id"]), ...(email ? [] : ["email"])];

  if (missingFields.length > 0) {
    throw createRequiredSamlAttributeError(missingFields);
  }

  const firstName = readSamlMappedValue(mapping.firstName, nameId, attributes);
  const lastName = readSamlMappedValue(mapping.lastName, nameId, attributes);
  const displayName = readSamlMappedValue(mapping.name, nameId, attributes);
  const normalizedEmail = assertNonEmptyString(
    email,
    "saml.email",
  ).toLowerCase();
  const name =
    [firstName, lastName].filter(Boolean).join(" ").trim() ||
    displayName ||
    normalizedEmail;

  return {
    id: assertNonEmptyString(id, "saml.id"),
    email: normalizedEmail,
    name,
    emailVerified: false,
  };
}

function createStaticSamlMetadataXml(provider: StaticSamlProvider): string {
  const samlify = loadSamlifyModule();
  const metadata = samlify.SPMetadata({
    entityID:
      provider.samlConfig.spMetadata.entityID ?? provider.samlConfig.issuer,
    assertionConsumerService: [
      {
        Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        Location: provider.samlConfig.callbackUrl,
      },
    ],
    wantMessageSigned: provider.samlConfig.wantAssertionsSigned ?? false,
    authnRequestsSigned: provider.samlConfig.authnRequestsSigned ?? false,
    nameIDFormat: provider.samlConfig.identifierFormat
      ? [provider.samlConfig.identifierFormat]
      : undefined,
  });

  return metadata.getMetadata();
}

function createStaticSamlMetadataJson(provider: StaticSamlProvider) {
  return {
    providerId: provider.providerId,
    entityID:
      provider.samlConfig.spMetadata.entityID ?? provider.samlConfig.issuer,
    assertionConsumerService: [
      {
        binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
        location: provider.samlConfig.callbackUrl,
      },
    ],
    nameIDFormat: provider.samlConfig.identifierFormat
      ? [provider.samlConfig.identifierFormat]
      : [],
    authnRequestsSigned: provider.samlConfig.authnRequestsSigned ?? false,
    wantAssertionsSigned: provider.samlConfig.wantAssertionsSigned ?? false,
  };
}

async function readAuthHandlerErrorPayload(
  response: Response,
): Promise<AuthHandlerErrorPayload> {
  return ((await response
    .clone()
    .json()
    .catch(async () => ({
      message: await response
        .clone()
        .text()
        .catch(() => undefined),
    }))) ?? {}) as AuthHandlerErrorPayload;
}

function createDiscoveryEndpoint(issuer: string): string {
  const url = new URL(issuer);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  url.pathname = `${normalizedPath}/.well-known/openid-configuration`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function createAuthRouteUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

function hasResolvedDiscoveryOverrides(provider: OidcProviderConfig): boolean {
  return Boolean(
    provider.discoveryOverrides?.authorizationEndpoint &&
      provider.discoveryOverrides?.tokenEndpoint &&
      provider.discoveryOverrides?.jwksUri,
  );
}

function createInvalidEnvDiscoveryError(
  provider: OidcProviderConfig,
  error: unknown,
): RuntimeError {
  const details: Record<string, unknown> = {
    providerId: provider.providerId,
    issuer: provider.issuer,
  };

  if (error instanceof DiscoveryError) {
    details.discoveryCode = error.code;
  }

  return new RuntimeError({
    code: "INVALID_ENV",
    message: `OIDC discovery failed for provider "${provider.providerId}".`,
    statusCode: 500,
    details,
  });
}

function createStartupDiscoveryConfig(provider: OidcProviderConfig) {
  return {
    issuer: provider.issuer,
    discoveryEndpoint: createDiscoveryEndpoint(provider.issuer),
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    pkce: true,
    scopes: [...provider.scopes],
    authorizationEndpoint: provider.discoveryOverrides?.authorizationEndpoint,
    tokenEndpoint: provider.discoveryOverrides?.tokenEndpoint,
    userInfoEndpoint: provider.discoveryOverrides?.userInfoEndpoint,
    jwksEndpoint: provider.discoveryOverrides?.jwksUri,
    tokenEndpointAuthentication:
      provider.discoveryOverrides?.tokenEndpointAuthMethod,
    mapping: {
      id: "sub" as const,
      email: "email" as const,
      emailVerified: "email_verified" as const,
      name: "name" as const,
      image: "picture" as const,
      extraFields: {
        givenName: "given_name" as const,
        familyName: "family_name" as const,
        preferredUsername: "preferred_username" as const,
      },
    },
  };
}

function createProviderOriginAllowlist(
  provider: OidcProviderConfig,
): Set<string> {
  return new Set([
    new URL(provider.issuer).origin,
    ...(provider.trustedOrigins ?? []),
  ]);
}

export async function resolveStartupOidcProviders(
  providers: OidcProviderConfig[],
): Promise<OidcProviderConfig[]> {
  return Promise.all(
    providers.map(async (provider) => {
      if (hasResolvedDiscoveryOverrides(provider)) {
        return provider;
      }

      const trustedOrigins = createProviderOriginAllowlist(provider);

      try {
        const discovered = await discoverOIDCConfig({
          issuer: provider.issuer,
          existingConfig: createStartupDiscoveryConfig(provider),
          isTrustedOrigin: (url) => {
            try {
              return trustedOrigins.has(new URL(url).origin);
            } catch {
              return false;
            }
          },
        });

        return {
          ...provider,
          discoveryOverrides: {
            authorizationEndpoint: discovered.authorizationEndpoint,
            tokenEndpoint: discovered.tokenEndpoint,
            userInfoEndpoint: discovered.userInfoEndpoint,
            jwksUri: discovered.jwksEndpoint,
            tokenEndpointAuthMethod:
              discovered.tokenEndpointAuthentication ??
              provider.discoveryOverrides?.tokenEndpointAuthMethod ??
              "client_secret_basic",
          },
        };
      } catch (error) {
        throw createInvalidEnvDiscoveryError(provider, error);
      }
    }),
  );
}

export function buildStaticOidcProviders(
  _baseUrl: string,
  providers: OidcProviderConfig[],
): StaticOidcProvider[] {
  return providers.map((provider) => {
    if (!hasResolvedDiscoveryOverrides(provider)) {
      throw new RuntimeError({
        code: "INVALID_ENV",
        message: `OIDC provider "${provider.providerId}" must have resolved discovery metadata before auth startup.`,
        statusCode: 500,
        details: {
          providerId: provider.providerId,
          issuer: provider.issuer,
        },
      });
    }

    return {
      providerId: provider.providerId,
      domain: provider.domain,
      oidcConfig: {
        issuer: provider.issuer,
        discoveryEndpoint: createDiscoveryEndpoint(provider.issuer),
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        pkce: true,
        scopes: [...provider.scopes],
        authorizationEndpoint:
          provider.discoveryOverrides?.authorizationEndpoint,
        tokenEndpoint: provider.discoveryOverrides?.tokenEndpoint,
        userInfoEndpoint: provider.discoveryOverrides?.userInfoEndpoint,
        jwksEndpoint: provider.discoveryOverrides?.jwksUri,
        tokenEndpointAuthentication:
          provider.discoveryOverrides?.tokenEndpointAuthMethod,
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
    };
  });
}

export function buildStaticSamlProviders(
  baseUrl: string,
  providers: SamlProviderConfig[],
): StaticSamlProvider[] {
  return providers.map((provider) => ({
    providerId: provider.providerId,
    domain: provider.domain,
    samlConfig: {
      issuer: provider.issuer,
      entryPoint: provider.entryPoint,
      cert: provider.cert,
      callbackUrl: createAuthRouteUrl(
        baseUrl,
        `/api/v1/auth/sso/saml2/sp/acs/${provider.providerId}`,
      ),
      audience: provider.audience,
      spMetadata: {
        entityID: provider.spEntityId,
      },
      identifierFormat: provider.identifierFormat,
      authnRequestsSigned: provider.authnRequestsSigned,
      wantAssertionsSigned: provider.wantAssertionsSigned,
      mapping: provider.attributeMapping,
    },
  }));
}

export function buildStaticSsoPluginOptions(
  baseUrl: string,
  oidcProviders: OidcProviderConfig[],
  samlProviders: SamlProviderConfig[],
): StaticSsoPluginOptions {
  return {
    defaultSSO: [
      ...buildStaticOidcProviders(baseUrl, oidcProviders),
      ...buildStaticSamlProviders(baseUrl, samlProviders),
    ],
    providersLimit: 0,
    saml: {
      enableInResponseToValidation: true,
      allowIdpInitiated: false,
      requireTimestamps: true,
    },
  };
}

export function validateSsoRedirectUrl(
  value: string,
  field: string,
  baseUrl: string,
): string {
  const trimmed = value.trim();

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  let target: URL;
  let appOrigin: string;

  try {
    target = new URL(trimmed);
    appOrigin = new URL(baseUrl).origin;
  } catch {
    throw createInvalidInputError(
      `Field "${field}" must be a relative path or same-origin absolute URL.`,
      { field, value },
    );
  }

  if (target.origin !== appOrigin) {
    throw createInvalidInputError(
      `Field "${field}" must be a relative path or same-origin absolute URL.`,
      { field, value },
    );
  }

  return trimmed;
}

export function mapSsoCallbackErrorCode(
  location: string,
  providerId?: string,
): RuntimeError | undefined {
  let url: URL;

  try {
    url = new URL(location, "http://localhost");
  } catch {
    return createAuthProviderError("invalid_redirect", location);
  }

  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description") ?? "";
  const normalizedDescription = errorDescription.toLowerCase();

  if (!error) {
    return undefined;
  }

  if (
    error === "invalid_provider" &&
    normalizedDescription.includes("missing_user_info")
  ) {
    return createRequiredOidcClaimError();
  }

  if (
    error === "invalid_provider" &&
    normalizedDescription.includes("provider not found")
  ) {
    return createSsoProviderNotConfiguredError(providerId ?? "unknown");
  }

  if (
    [
      "invalid_saml_response",
      "multiple_assertions",
      "no_assertion",
      "replay_detected",
      "unsolicited_response",
    ].includes(error)
  ) {
    return createAuthProviderError(error, errorDescription);
  }

  if (error === "invalid_state") {
    return createInvalidInputError("OIDC callback state is invalid.");
  }

  return createAuthProviderError(error, errorDescription);
}

export function validateSsoSignInPayload(
  payload: unknown,
  baseUrl: string,
  configuredProviderIds: ReadonlySet<string>,
): z.infer<typeof SsoSignInInputSchema> {
  const parsed = SsoSignInInputSchema.safeParse(payload);

  if (!parsed.success) {
    throw createInvalidInputError("SSO sign-in payload is invalid.", {
      issues: parsed.error.issues,
    });
  }

  if (!configuredProviderIds.has(parsed.data.providerId)) {
    throw createSsoProviderNotConfiguredError(parsed.data.providerId);
  }

  validateSsoRedirectUrl(parsed.data.callbackURL, "callbackURL", baseUrl);

  if (parsed.data.errorCallbackURL) {
    validateSsoRedirectUrl(
      parsed.data.errorCallbackURL,
      "errorCallbackURL",
      baseUrl,
    );
  }

  if (parsed.data.newUserCallbackURL) {
    validateSsoRedirectUrl(
      parsed.data.newUserCallbackURL,
      "newUserCallbackURL",
      baseUrl,
    );
  }

  return parsed.data;
}

function resolveAuthBaseUrl(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.MDCMS_SERVER_URL?.trim();

  if (fromEnv) {
    return fromEnv;
  }

  const port = env.PORT?.trim() || "4000";
  return `http://localhost:${port}`;
}

function collectTrustedOrigins(
  baseUrl: string,
  providers: OidcProviderConfig[],
): string[] {
  const trustedOrigins = new Set<string>([new URL(baseUrl).origin]);

  for (const provider of providers) {
    trustedOrigins.add(new URL(provider.issuer).origin);

    for (const origin of provider.trustedOrigins ?? []) {
      trustedOrigins.add(origin);
    }
  }

  return [...trustedOrigins];
}

function resolveAuthSecret(env: NodeJS.ProcessEnv): string {
  const configured = env.BETTER_AUTH_SECRET?.trim() || env.AUTH_SECRET?.trim();

  if (configured) {
    return configured;
  }

  if (env.NODE_ENV === "production") {
    throw new RuntimeError({
      code: "INVALID_ENV",
      message:
        "BETTER_AUTH_SECRET (or AUTH_SECRET) must be configured in production.",
      statusCode: 500,
    });
  }

  return "mdcms-dev-secret-do-not-use-in-production";
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function resolveSecureCookiePolicy(env: NodeJS.ProcessEnv): boolean {
  const explicitInsecure = parseEnvBoolean(env.MDCMS_AUTH_INSECURE_COOKIES);
  return explicitInsecure === true ? false : true;
}

function parseCsvSet(rawValue: string | undefined): Set<string> {
  if (!rawValue) {
    return new Set<string>();
  }

  return new Set(
    rawValue
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

function resolveAdminAllowlist(env: NodeJS.ProcessEnv): {
  userIds: Set<string>;
  emails: Set<string>;
} {
  return {
    userIds: parseCsvSet(env.MDCMS_AUTH_ADMIN_USER_IDS),
    emails: new Set(
      [...parseCsvSet(env.MDCMS_AUTH_ADMIN_EMAILS)].map((email) =>
        email.toLowerCase(),
      ),
    ),
  };
}

function toRbacAction(requiredScope: ApiKeyOperationScope): RbacAction | null {
  if (requiredScope === "content:read") {
    return "content:read";
  }

  if (requiredScope === "content:read:draft") {
    return "content:read:draft";
  }

  if (
    requiredScope === "content:write" ||
    requiredScope === LEGACY_CONTENT_WRITE_DRAFT_SCOPE
  ) {
    return "content:write";
  }

  if (requiredScope === "content:publish") {
    return "content:publish";
  }

  if (requiredScope === "content:delete") {
    return "content:delete";
  }

  if (requiredScope === "schema:read") {
    return "schema:read";
  }

  if (requiredScope === "schema:write") {
    return "schema:write";
  }

  if (
    requiredScope === "media:read" ||
    requiredScope === "media:upload" ||
    requiredScope === "media:delete"
  ) {
    return requiredScope;
  }

  if (requiredScope === "webhooks:read" || requiredScope === "webhooks:write") {
    return "settings:manage";
  }

  if (requiredScope === "projects:read") {
    return "projects:read";
  }

  if (requiredScope === "projects:write") {
    return "projects:write";
  }

  if (requiredScope === "ai:use") {
    return "ai:use";
  }

  return null;
}

export function resolveApiKeyRbacAction(
  requiredScope: ApiKeyOperationScope,
): RbacAction {
  const action = toRbacAction(requiredScope);

  if (action) {
    return action;
  }

  throw new RuntimeError({
    code: "FORBIDDEN",
    message: "Session role cannot mint this API key scope.",
    statusCode: 403,
  });
}

function apiKeyScopesSatisfyRequirement(
  scopes: readonly ApiKeyOperationScope[],
  requiredScope: ApiKeyOperationScope,
): boolean {
  if (scopes.includes(requiredScope)) {
    return true;
  }

  if (requiredScope === "content:write") {
    return scopes.includes(LEGACY_CONTENT_WRITE_DRAFT_SCOPE);
  }

  return false;
}

function apiKeyAllowsTarget(
  contextAllowlist: readonly ApiKeyScopeTuple[],
  target: {
    project: string;
    environment: string;
  },
): boolean {
  return contextAllowlist.some(
    (candidate) =>
      candidate.project === target.project &&
      candidate.environment === target.environment,
  );
}

function buildCapabilitiesFromSessionGrants(input: {
  grants: readonly RbacGrant[];
  target: {
    project: string;
    environment: string;
  };
}): CurrentPrincipalCapabilities {
  const capabilities = createEmptyCurrentPrincipalCapabilities();
  const evaluate = (action: RbacAction): boolean =>
    evaluatePermission({
      grants: input.grants,
      target: input.target,
      action,
    }).allowed;

  capabilities.schema.read = evaluate("schema:read");
  capabilities.schema.write = evaluate("schema:write");
  capabilities.content.read = evaluate("content:read");
  capabilities.content.readDraft = evaluate("content:read:draft");
  capabilities.content.write = evaluate("content:write");
  capabilities.content.publish = evaluate("content:publish");
  capabilities.content.unpublish = evaluate("content:unpublish");
  capabilities.content.delete = evaluate("content:delete");
  capabilities.media.read = evaluate("media:read");
  capabilities.media.upload = evaluate("media:upload");
  capabilities.media.delete = evaluate("media:delete");
  capabilities.users.manage = evaluate("user:manage");
  capabilities.settings.manage = evaluate("settings:manage");
  capabilities.ai.use = evaluate("ai:use");

  return capabilities;
}

function buildCapabilitiesFromApiKeyScopes(
  scopes: readonly ApiKeyOperationScope[],
): CurrentPrincipalCapabilities {
  const capabilities = createEmptyCurrentPrincipalCapabilities();

  capabilities.schema.read = apiKeyScopesSatisfyRequirement(
    scopes,
    "schema:read",
  );
  capabilities.schema.write = apiKeyScopesSatisfyRequirement(
    scopes,
    "schema:write",
  );
  capabilities.content.read = apiKeyScopesSatisfyRequirement(
    scopes,
    "content:read",
  );
  capabilities.content.readDraft = apiKeyScopesSatisfyRequirement(
    scopes,
    "content:read:draft",
  );
  capabilities.content.write = apiKeyScopesSatisfyRequirement(
    scopes,
    "content:write",
  );
  capabilities.content.publish = apiKeyScopesSatisfyRequirement(
    scopes,
    "content:publish",
  );
  capabilities.content.unpublish = capabilities.content.publish;
  capabilities.content.delete = apiKeyScopesSatisfyRequirement(
    scopes,
    "content:delete",
  );
  capabilities.media.read = apiKeyScopesSatisfyRequirement(
    scopes,
    "media:read",
  );
  capabilities.media.upload = apiKeyScopesSatisfyRequirement(
    scopes,
    "media:upload",
  );
  capabilities.media.delete = apiKeyScopesSatisfyRequirement(
    scopes,
    "media:delete",
  );
  capabilities.settings.manage = scopes.some(
    (scope) => toRbacAction(scope) === "settings:manage",
  );
  capabilities.ai.use = apiKeyScopesSatisfyRequirement(scopes, "ai:use");

  return capabilities;
}

function isSessionBeyondAbsoluteMaxAge(session: StudioSession): boolean {
  const issuedAt = Date.parse(session.issuedAt);

  if (Number.isNaN(issuedAt)) {
    return true;
  }

  return Date.now() - issuedAt > SESSION_ABSOLUTE_MAX_AGE_MS;
}

function createUnauthorizedSessionError(message: string): RuntimeError {
  return new RuntimeError({
    code: "UNAUTHORIZED",
    message,
    statusCode: 401,
  });
}

function normalizeLoginBackoffKey(email: string): string {
  return email.trim().toLowerCase();
}

function getLoginBackoffDelaySeconds(failureCount: number): number {
  const index = Math.max(0, failureCount - 1);
  return (
    LOGIN_BACKOFF_DELAYS_SECONDS[
      Math.min(index, LOGIN_BACKOFF_DELAYS_SECONDS.length - 1)
    ] ?? LOGIN_BACKOFF_DELAYS_SECONDS[LOGIN_BACKOFF_DELAYS_SECONDS.length - 1]
  );
}

function hasLoginBackoffWindowExpired(
  row: typeof authLoginBackoffs.$inferSelect,
  nowMs: number,
): boolean {
  return nowMs - row.lastFailedAt.getTime() >= LOGIN_BACKOFF_RESET_WINDOW_MS;
}

function getRetryAfterSeconds(nextAllowedAt: Date, nowMs: number): number {
  return Math.max(1, Math.ceil((nextAllowedAt.getTime() - nowMs) / 1000));
}

function createAuthBackoffError(retryAfterSeconds: number): RuntimeError {
  return new RuntimeError({
    code: "AUTH_BACKOFF_ACTIVE",
    message: `Too many failed login attempts. Retry after ${retryAfterSeconds} seconds.`,
    statusCode: 429,
    details: {
      retryAfterSeconds,
    },
  });
}

function formatSsoProviderName(providerId: string): string {
  const names: Record<string, string> = {
    okta: "Okta",
    "azure-ad": "Azure AD",
    "google-workspace": "Google Workspace",
    auth0: "Auth0",
  };
  return names[providerId] ?? providerId;
}

function createAuthBackoffResponse(
  request: Request,
  retryAfterSeconds: number,
): Response {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  return createJsonResponse(
    serializeError(createAuthBackoffError(retryAfterSeconds), { requestId }),
    429,
    {
      "retry-after": String(retryAfterSeconds),
    },
  );
}

export type CreateAuthServiceOptions = {
  db: DrizzleDatabase;
  env?: NodeJS.ProcessEnv;
  isAdminSession?: (session: StudioSession) => boolean | Promise<boolean>;
  emailService?: EmailService;
};

export function createAuthService(
  options: CreateAuthServiceOptions,
): AuthService {
  const rawEnv = options.env ?? process.env;
  const parsedEnv = parseServerEnv(rawEnv);
  const baseUrl = resolveAuthBaseUrl(rawEnv);
  const secret = resolveAuthSecret(rawEnv);
  const useSecureCookies = resolveSecureCookiePolicy(rawEnv);
  const csrfCookieSameSite = useSecureCookies ? "None" : ("Lax" as const);
  const sessionCookieSameSite = useSecureCookies ? "none" : ("lax" as const);
  const adminAllowlist = resolveAdminAllowlist(rawEnv);
  const staticSamlProviders = buildStaticSamlProviders(
    baseUrl,
    parsedEnv.MDCMS_AUTH_SAML_PROVIDERS,
  );
  const ssoPluginOptions = buildStaticSsoPluginOptions(
    baseUrl,
    parsedEnv.MDCMS_AUTH_OIDC_PROVIDERS,
    parsedEnv.MDCMS_AUTH_SAML_PROVIDERS,
  );
  const runtimeSsoPluginOptions: StaticSsoPluginOptions = {
    ...ssoPluginOptions,
    saml: {
      ...ssoPluginOptions.saml,
      // Better Auth currently reads samlify's InResponseTo field from the
      // wrong extraction path, so MDCMS enforces the same validation in the
      // ACS wrapper against the persisted authn-request records instead.
      enableInResponseToValidation: false,
    },
  };
  const trustedOrigins = collectTrustedOrigins(
    baseUrl,
    parsedEnv.MDCMS_AUTH_OIDC_PROVIDERS,
  );
  const oidcProviderConfigById = new Map(
    parsedEnv.MDCMS_AUTH_OIDC_PROVIDERS.map((provider) => [
      provider.providerId,
      provider,
    ]),
  );
  const samlProviderConfigById = new Map(
    parsedEnv.MDCMS_AUTH_SAML_PROVIDERS.map((provider) => [
      provider.providerId,
      provider,
    ]),
  );
  const staticSamlProviderById = new Map(
    staticSamlProviders.map((provider) => [provider.providerId, provider]),
  );
  const configuredSsoProviderIds = new Set(
    runtimeSsoPluginOptions.defaultSSO?.map(
      (provider) => provider.providerId,
    ) ?? [],
  );
  const configuredSamlProviderIds = new Set(samlProviderConfigById.keys());
  const oidcCallbackHookErrors = new Map<string, RuntimeError>();
  const samlCallbackHookErrors = new Map<string, RuntimeError>();
  const isAdminSession =
    options.isAdminSession ??
    ((session: StudioSession) =>
      adminAllowlist.userIds.has(session.userId) ||
      adminAllowlist.emails.has(session.email.toLowerCase()));

  function createCsrfBootstrap(request?: Request): {
    token: string;
    setCookie: string;
  } {
    const existingToken = request
      ? readCookieValue(request, CSRF_COOKIE_NAME)?.trim()
      : undefined;
    const token =
      existingToken && existingToken.length > 0
        ? existingToken
        : randomBytes(CSRF_TOKEN_BYTES).toString("base64url");

    return {
      token,
      setCookie: serializeCookie({
        name: CSRF_COOKIE_NAME,
        value: token,
        path: "/",
        sameSite: csrfCookieSameSite,
        secure: useSecureCookies,
        maxAge: SESSION_INACTIVITY_TIMEOUT_SECONDS,
      }),
    };
  }

  function createClearedCsrfCookie(): string {
    return serializeCookie({
      name: CSRF_COOKIE_NAME,
      value: "",
      path: "/",
      sameSite: csrfCookieSameSite,
      secure: useSecureCookies,
      maxAge: 0,
    });
  }

  async function loadOidcCallbackRecord(
    sessionId: string,
    userId: string,
    providerId: string,
  ): Promise<OidcCallbackRecord> {
    const [record] = await options.db
      .select({
        sessionId: authSessions.id,
        sessionCreatedAt: authSessions.createdAt,
        userId: authUsers.id,
        userCreatedAt: authUsers.createdAt,
        userEmail: authUsers.email,
        userEmailVerified: authUsers.emailVerified,
        userName: authUsers.name,
        userImage: authUsers.image,
        accountRowId: authAccounts.id,
        accountCreatedAt: authAccounts.createdAt,
        accountId: authAccounts.accountId,
        accountAccessToken: authAccounts.accessToken,
        accountIdToken: authAccounts.idToken,
      })
      .from(authSessions)
      .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
      .innerJoin(
        authAccounts,
        and(
          eq(authAccounts.userId, authUsers.id),
          eq(authAccounts.providerId, providerId),
        ),
      )
      .where(and(eq(authSessions.id, sessionId), eq(authUsers.id, userId)))
      .orderBy(desc(authAccounts.updatedAt))
      .limit(1);

    if (!record) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "OIDC callback did not produce a persisted auth account.",
        statusCode: 500,
        details: {
          providerId,
          sessionId,
          userId,
        },
      });
    }

    return record;
  }

  async function loadOidcUserInfoClaims(
    providerId: string,
    accessToken: string | null,
  ): Promise<Record<string, unknown> | undefined> {
    const provider = oidcProviderConfigById.get(
      providerId as OidcProviderConfig["providerId"],
    );
    const userInfoEndpoint = provider?.discoveryOverrides?.userInfoEndpoint;

    if (!accessToken || !userInfoEndpoint) {
      return undefined;
    }

    try {
      const response = await fetch(userInfoEndpoint, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        return undefined;
      }

      const body = (await response.json().catch(() => undefined)) as
        | Record<string, unknown>
        | undefined;

      return body && !Array.isArray(body) ? body : undefined;
    } catch {
      return undefined;
    }
  }

  async function loadSamlCallbackRecord(
    sessionId: string,
    userId: string,
    providerId: string,
  ): Promise<SamlCallbackRecord> {
    const [record] = await options.db
      .select({
        sessionId: authSessions.id,
        sessionCreatedAt: authSessions.createdAt,
        userId: authUsers.id,
        userCreatedAt: authUsers.createdAt,
        userEmail: authUsers.email,
        userEmailVerified: authUsers.emailVerified,
        userName: authUsers.name,
        userImage: authUsers.image,
        accountRowId: authAccounts.id,
        accountCreatedAt: authAccounts.createdAt,
        accountId: authAccounts.accountId,
      })
      .from(authSessions)
      .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
      .innerJoin(
        authAccounts,
        and(
          eq(authAccounts.userId, authUsers.id),
          eq(authAccounts.providerId, providerId),
        ),
      )
      .where(and(eq(authSessions.id, sessionId), eq(authUsers.id, userId)))
      .orderBy(desc(authAccounts.updatedAt))
      .limit(1);

    if (!record) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "SAML callback did not produce a persisted auth account.",
        statusCode: 500,
        details: {
          providerId,
          sessionId,
          userId,
        },
      });
    }

    return record;
  }

  async function rollbackInvalidCallbackRecord(
    record: SamlCallbackRecord | OidcCallbackRecord,
  ): Promise<void> {
    await options.db
      .delete(authSessions)
      .where(eq(authSessions.id, record.sessionId));

    const createdAccountDuringCallback = wasCreatedDuringOidcCallback(
      record.accountCreatedAt,
      record.sessionCreatedAt,
    );

    if (createdAccountDuringCallback) {
      await options.db
        .delete(authAccounts)
        .where(eq(authAccounts.id, record.accountRowId));
    }

    const [remainingAccount] = await options.db
      .select({
        id: authAccounts.id,
      })
      .from(authAccounts)
      .where(eq(authAccounts.userId, record.userId))
      .limit(1);
    const [remainingSession] = await options.db
      .select({
        id: authSessions.id,
      })
      .from(authSessions)
      .where(eq(authSessions.userId, record.userId))
      .limit(1);

    if (!remainingAccount && !remainingSession) {
      await options.db.delete(authUsers).where(eq(authUsers.id, record.userId));
    }
  }

  async function synchronizeOidcCallbackUser(
    sessionId: string,
    userId: string,
    providerId: string,
  ): Promise<void> {
    const record = await loadOidcCallbackRecord(sessionId, userId, providerId);
    const idTokenClaims = decodeJwtPayload(record.accountIdToken);
    const userInfoClaims = await loadOidcUserInfoClaims(
      providerId,
      record.accountAccessToken,
    );
    let normalized: OidcCanonicalClaims;

    try {
      normalized = normalizeOidcClaims({
        sub: selectOidcClaimString(
          idTokenClaims?.sub,
          userInfoClaims?.sub,
          record.accountId,
        ),
        email: selectOidcClaimString(
          idTokenClaims?.email,
          userInfoClaims?.email,
          record.userEmail,
        ),
        email_verified:
          selectOidcBooleanClaim(
            idTokenClaims?.email_verified,
            userInfoClaims?.email_verified,
          ) ?? false,
        name: selectOidcClaimString(
          idTokenClaims?.name,
          userInfoClaims?.name,
          record.userName,
        ),
        picture: selectOidcClaimString(
          idTokenClaims?.picture,
          userInfoClaims?.picture,
          record.userImage,
        ),
        preferred_username: selectOidcClaimString(
          idTokenClaims?.preferred_username,
          userInfoClaims?.preferred_username,
        ),
        given_name: selectOidcClaimString(
          idTokenClaims?.given_name,
          userInfoClaims?.given_name,
        ),
        family_name: selectOidcClaimString(
          idTokenClaims?.family_name,
          userInfoClaims?.family_name,
        ),
      });
    } catch (error) {
      await rollbackInvalidCallbackRecord(record);

      if (error instanceof RuntimeError) {
        throw error;
      }

      throw createRequiredOidcClaimError();
    }

    if (record.accountId !== normalized.id) {
      await options.db
        .update(authAccounts)
        .set({
          accountId: normalized.id,
          updatedAt: new Date(),
        })
        .where(eq(authAccounts.id, record.accountRowId));
    }

    if (
      record.userEmail === normalized.email &&
      record.userEmailVerified === normalized.emailVerified &&
      record.userName === normalized.name &&
      record.userImage === normalized.image
    ) {
      return;
    }

    await options.db
      .update(authUsers)
      .set({
        email: normalized.email,
        emailVerified: normalized.emailVerified,
        name: normalized.name,
        image: normalized.image,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, record.userId));
  }

  async function synchronizeSamlCallbackUser(
    sessionId: string,
    userId: string,
    providerId: string,
    samlResponse: string,
  ): Promise<void> {
    const provider = samlProviderConfigById.get(
      providerId as SamlProviderConfig["providerId"],
    );

    if (!provider) {
      throw createSsoProviderNotConfiguredError(providerId);
    }

    const record = await loadSamlCallbackRecord(sessionId, userId, providerId);
    let normalized: SamlCanonicalClaims;

    try {
      normalized = normalizeSamlResponseClaims(samlResponse, provider);
    } catch (error) {
      await rollbackInvalidCallbackRecord(record);

      if (error instanceof RuntimeError) {
        throw error;
      }

      throw createRequiredSamlAttributeError();
    }

    if (record.accountId !== normalized.id) {
      await options.db
        .update(authAccounts)
        .set({
          accountId: normalized.id,
          updatedAt: new Date(),
        })
        .where(eq(authAccounts.id, record.accountRowId));
    }

    if (
      record.userEmail === normalized.email &&
      record.userEmailVerified === normalized.emailVerified &&
      record.userName === normalized.name
    ) {
      return;
    }

    await options.db
      .update(authUsers)
      .set({
        email: normalized.email,
        emailVerified: normalized.emailVerified,
        name: normalized.name,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, record.userId));
  }

  const auth = betterAuth({
    appName: "mdcms",
    baseURL: baseUrl,
    basePath: "/api/v1/auth",
    secret,
    trustedOrigins,
    database: drizzleAdapter(options.db as unknown as Record<string, unknown>, {
      provider: "pg",
      schema: {
        users: authUsers,
        sessions: authSessions,
        accounts: authAccounts,
        verifications: authVerifications,
      },
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      expiresIn: SESSION_INACTIVITY_TIMEOUT_SECONDS,
      updateAge: 0,
    },
    advanced: {
      useSecureCookies,
      defaultCookieAttributes: {
        path: "/",
        httpOnly: true,
        sameSite: sessionCookieSameSite,
        secure: useSecureCookies,
      },
    },
    rateLimit: {
      enabled: false,
    },
    plugins: [
      sso(runtimeSsoPluginOptions),
      {
        id: "mdcms-oidc-callback-normalization",
        hooks: {
          after: [
            {
              matcher(context: { path?: string }) {
                return context.path?.startsWith("/sso/callback/") ?? false;
              },
              handler: createAuthMiddleware(async (ctx) => {
                const newSession = ctx.context.newSession;

                if (!newSession?.session?.id || !newSession.user?.id) {
                  return;
                }

                const providerId =
                  typeof ctx.params?.providerId === "string"
                    ? ctx.params.providerId
                    : undefined;

                if (!providerId) {
                  return;
                }

                try {
                  await synchronizeOidcCallbackUser(
                    assertNonEmptyString(newSession.session.id, "session.id"),
                    assertNonEmptyString(newSession.user.id, "user.id"),
                    providerId,
                  );
                } catch (error) {
                  if (error instanceof RuntimeError && ctx.request?.url) {
                    oidcCallbackHookErrors.set(ctx.request.url, error);
                    return;
                  }

                  throw error;
                }
              }),
            },
          ],
        },
      },
      {
        id: "mdcms-saml-callback-normalization",
        hooks: {
          after: [
            {
              matcher(context: { path?: string }) {
                return context.path?.startsWith("/sso/saml2/sp/acs/") ?? false;
              },
              handler: createAuthMiddleware(async (ctx) => {
                const newSession = ctx.context.newSession;

                if (!newSession?.session?.id || !newSession.user?.id) {
                  return;
                }

                const providerId =
                  typeof ctx.params?.providerId === "string"
                    ? ctx.params.providerId
                    : undefined;
                const samlResponse =
                  typeof ctx.body?.SAMLResponse === "string"
                    ? ctx.body.SAMLResponse
                    : undefined;

                if (!providerId || !samlResponse) {
                  return;
                }

                try {
                  await synchronizeSamlCallbackUser(
                    assertNonEmptyString(newSession.session.id, "session.id"),
                    assertNonEmptyString(newSession.user.id, "user.id"),
                    providerId,
                    samlResponse,
                  );
                } catch (error) {
                  if (error instanceof RuntimeError && ctx.request?.url) {
                    samlCallbackHookErrors.set(
                      createSamlAcsRequestKey(ctx.request.url, samlResponse),
                      error,
                    );
                    return;
                  }

                  throw error;
                }
              }),
            },
          ],
        },
      },
    ],
  });

  function assertConfiguredSsoProvider(providerId: string): void {
    if (!configuredSsoProviderIds.has(providerId)) {
      throw createSsoProviderNotConfiguredError(providerId);
    }
  }

  function assertConfiguredSamlProvider(providerId: string): void {
    if (!configuredSamlProviderIds.has(providerId)) {
      throw createSsoProviderNotConfiguredError(providerId);
    }
  }

  async function parseSsoSignInPayload(request: Request): Promise<{
    providerId: string;
    callbackURL: string;
    errorCallbackURL?: string;
    newUserCallbackURL?: string;
    loginHint?: string;
  }> {
    const payload = await request
      .clone()
      .json()
      .catch(() => {
        throw createInvalidInputError(
          "SSO sign-in requires a valid JSON request body.",
        );
      });

    return validateSsoSignInPayload(payload, baseUrl, configuredSsoProviderIds);
  }

  async function parseSamlAcsPayload(
    request: Request,
  ): Promise<SamlAcsPayload> {
    const clonedRequest = request.clone();
    const contentType = clonedRequest.headers.get("content-type") ?? "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await clonedRequest.formData().catch(() => undefined);
      const samlResponse = formData?.get("SAMLResponse");
      const relayState = formData?.get("RelayState");

      return {
        SAMLResponse:
          typeof samlResponse === "string" ? samlResponse : undefined,
        RelayState: typeof relayState === "string" ? relayState : undefined,
      };
    }

    if (contentType.includes("application/json")) {
      const payload = (await clonedRequest.json().catch(() => ({}))) as {
        RelayState?: unknown;
        SAMLResponse?: unknown;
      };

      return {
        SAMLResponse:
          typeof payload.SAMLResponse === "string"
            ? payload.SAMLResponse
            : undefined,
        RelayState:
          typeof payload.RelayState === "string"
            ? payload.RelayState
            : undefined,
      };
    }

    return {};
  }

  function parseSamlMetadataQuery(
    request: Request,
  ): z.infer<typeof SamlMetadataQuerySchema> {
    const url = new URL(request.url);
    const parsed = SamlMetadataQuerySchema.safeParse({
      providerId: url.searchParams.get("providerId") ?? undefined,
      format: url.searchParams.get("format") ?? undefined,
    });

    if (!parsed.success) {
      throw createInvalidInputError("SAML SP metadata query is invalid.", {
        issues: parsed.error.issues,
      });
    }

    return parsed.data;
  }

  async function validateSamlAcsInResponseTo(
    payload: SamlAcsPayload,
    providerId: string,
  ): Promise<void> {
    if (!payload.SAMLResponse) {
      return;
    }

    const samlResponseXml = decodeSamlResponseXml(payload.SAMLResponse);
    const inResponseTo = extractSamlInResponseTo(samlResponseXml);

    if (!inResponseTo) {
      throw createAuthProviderError(
        "unsolicited_response",
        "IdP-initiated SSO not allowed",
      );
    }

    const identifier = `saml-authn-request:${inResponseTo}`;
    const [storedRequest] = await options.db
      .select({
        id: authVerifications.id,
        value: authVerifications.value,
        expiresAt: authVerifications.expiresAt,
      })
      .from(authVerifications)
      .where(eq(authVerifications.identifier, identifier))
      .limit(1);

    if (!storedRequest) {
      throw createAuthProviderError(
        "invalid_saml_response",
        "Unknown or expired request ID",
      );
    }

    if (storedRequest.expiresAt.getTime() < Date.now()) {
      await options.db
        .delete(authVerifications)
        .where(eq(authVerifications.id, storedRequest.id));
      throw createAuthProviderError(
        "invalid_saml_response",
        "Unknown or expired request ID",
      );
    }

    let storedPayload: { providerId?: unknown } | undefined;

    try {
      storedPayload = JSON.parse(storedRequest.value) as {
        providerId?: unknown;
      };
    } catch {
      storedPayload = undefined;
    }

    if (storedPayload?.providerId !== providerId) {
      await options.db
        .delete(authVerifications)
        .where(eq(authVerifications.id, storedRequest.id));
      throw createAuthProviderError(
        "invalid_saml_response",
        "Provider mismatch",
      );
    }

    await options.db
      .delete(authVerifications)
      .where(eq(authVerifications.id, storedRequest.id));
  }

  async function validateSamlAcsRequiredAttributes(
    payload: SamlAcsPayload,
    providerId: string,
  ): Promise<void> {
    if (!payload.SAMLResponse) {
      return;
    }

    const provider = samlProviderConfigById.get(
      providerId as SamlProviderConfig["providerId"],
    );

    if (!provider) {
      throw createSsoProviderNotConfiguredError(providerId);
    }

    normalizeSamlResponseClaims(payload.SAMLResponse, provider);
  }

  function toRedirectResponse(response: Response, location: string): Response {
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.set("location", location);

    return new Response(JSON.stringify({ url: location }), {
      status: 302,
      headers,
    });
  }

  function createSsoSignInRequest(
    request: Request,
    payload: Awaited<ReturnType<typeof parseSsoSignInPayload>>,
  ): Request {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");

    return new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(payload),
    });
  }

  async function findLoginBackoff(
    loginKey: string,
  ): Promise<typeof authLoginBackoffs.$inferSelect | undefined> {
    const [row] = await options.db
      .select()
      .from(authLoginBackoffs)
      .where(eq(authLoginBackoffs.loginKey, loginKey));

    return row;
  }

  async function clearLoginBackoff(loginKey: string): Promise<void> {
    await options.db
      .delete(authLoginBackoffs)
      .where(eq(authLoginBackoffs.loginKey, loginKey));
  }

  async function getActiveLoginBackoff(
    loginKey: string,
    nowMs = Date.now(),
  ): Promise<{ retryAfterSeconds: number } | undefined> {
    const row = await findLoginBackoff(loginKey);

    if (!row) {
      return undefined;
    }

    if (hasLoginBackoffWindowExpired(row, nowMs)) {
      await clearLoginBackoff(loginKey);
      return undefined;
    }

    if (row.nextAllowedAt.getTime() <= nowMs) {
      return undefined;
    }

    return {
      retryAfterSeconds: getRetryAfterSeconds(row.nextAllowedAt, nowMs),
    };
  }

  async function recordFailedLoginAttempt(
    loginKey: string,
    nowMs = Date.now(),
  ): Promise<void> {
    const now = new Date(nowMs);
    await options.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${loginKey}))`,
      );

      const [existing] = await tx
        .select()
        .from(authLoginBackoffs)
        .where(eq(authLoginBackoffs.loginKey, loginKey));
      const expired = existing
        ? hasLoginBackoffWindowExpired(existing, nowMs)
        : true;
      const seededExisting = existing && !expired ? existing : undefined;
      const failureCount = seededExisting ? seededExisting.failureCount + 1 : 1;
      const nextAllowedAt = new Date(
        nowMs + getLoginBackoffDelaySeconds(failureCount) * 1000,
      );

      await tx
        .insert(authLoginBackoffs)
        .values({
          loginKey,
          failureCount,
          firstFailedAt: seededExisting?.firstFailedAt ?? now,
          lastFailedAt: now,
          nextAllowedAt,
          createdAt: seededExisting?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: authLoginBackoffs.loginKey,
          set: {
            failureCount,
            firstFailedAt: seededExisting?.firstFailedAt ?? now,
            lastFailedAt: now,
            nextAllowedAt,
            updatedAt: now,
          },
        });
    });
  }

  function toRbacGrant(row: typeof rbacGrants.$inferSelect): RbacGrant {
    if (row.role === "owner" || row.role === "admin") {
      if (row.scopeKind !== "global") {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Stored RBAC grant has invalid role/scope pairing.",
          statusCode: 500,
          details: {
            grantId: row.id,
          },
        });
      }

      return {
        role: row.role,
        scope: { kind: "global" },
        source: row.source ?? undefined,
      };
    }

    if (row.role !== "editor" && row.role !== "viewer") {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "Stored RBAC grant has invalid role value.",
        statusCode: 500,
        details: {
          grantId: row.id,
          role: row.role,
        },
      });
    }

    if (row.scopeKind === "global") {
      return {
        role: row.role,
        scope: { kind: "global" },
        source: row.source ?? undefined,
      };
    }

    if (row.scopeKind === "project") {
      if (!row.project) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Stored RBAC grant is missing required project scope data.",
          statusCode: 500,
          details: {
            grantId: row.id,
          },
        });
      }

      return {
        role: row.role,
        scope: {
          kind: "project",
          project: row.project,
        },
        source: row.source ?? undefined,
      };
    }

    if (row.scopeKind === "folder_prefix") {
      if (!row.project || !row.environment || !row.pathPrefix) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message:
            "Stored RBAC grant is missing required folder-prefix scope data.",
          statusCode: 500,
          details: {
            grantId: row.id,
          },
        });
      }

      return {
        role: row.role,
        scope: {
          kind: "folder_prefix",
          project: row.project,
          environment: row.environment,
          pathPrefix: row.pathPrefix,
        },
        source: row.source ?? undefined,
      };
    }

    throw new RuntimeError({
      code: "INTERNAL_ERROR",
      message: "Stored RBAC grant has invalid scope kind.",
      statusCode: 500,
      details: {
        grantId: row.id,
        scopeKind: row.scopeKind,
      },
    });
  }

  async function seedBootstrapOwnerIfNeeded(
    session: StudioSession,
  ): Promise<void> {
    const [ownerCountRow] = await options.db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(rbacGrants)
      .where(and(eq(rbacGrants.role, "owner"), isNull(rbacGrants.revokedAt)));
    const ownerCount = ownerCountRow?.count ?? 0;

    if (ownerCount > 0) {
      return;
    }

    await options.db
      .insert(rbacGrants)
      .values({
        userId: session.userId,
        role: "owner",
        scopeKind: "global",
        source: "bootstrap:first-session",
        createdByUserId: session.userId,
      })
      .onConflictDoNothing();
  }

  async function loadSessionRbacGrants(
    session: StudioSession,
  ): Promise<RbacGrant[]> {
    await seedBootstrapOwnerIfNeeded(session);

    const rows = await options.db
      .select()
      .from(rbacGrants)
      .where(
        and(
          eq(rbacGrants.userId, session.userId),
          isNull(rbacGrants.revokedAt),
        ),
      );

    return rows.map((row) => toRbacGrant(row));
  }

  async function assertSessionCanIssueApiKeyScopes(
    session: StudioSession,
    scopes: readonly ApiKeyOperationScope[],
    contextAllowlist: readonly ApiKeyScopeTuple[],
  ): Promise<void> {
    const grants = await loadSessionRbacGrants(session);

    for (const scope of new Set(scopes)) {
      const action = resolveApiKeyRbacAction(scope);

      for (const target of contextAllowlist) {
        const decision = evaluatePermission({
          grants,
          target: {
            project: target.project,
            environment: target.environment,
          },
          action,
        });

        if (decision.allowed) {
          continue;
        }

        throw new RuntimeError({
          code: "FORBIDDEN",
          message:
            "Session role does not allow minting this API key scope for the requested target.",
          statusCode: 403,
          details: {
            requiredScope: scope,
            project: target.project,
            environment: target.environment,
          },
        });
      }
    }
  }

  async function assertSessionRbacAuthorization(
    session: StudioSession,
    requirement: AuthorizationRequirement,
  ): Promise<RbacRole | undefined> {
    const action = toRbacAction(requirement.requiredScope);

    if (!action) {
      return undefined;
    }

    if (!requirement.project) {
      throw new RuntimeError({
        code: "FORBIDDEN",
        message:
          "RBAC authorization requires an explicit project in the request context.",
        statusCode: 403,
      });
    }

    const grants = await loadSessionRbacGrants(session);
    const decision = evaluatePermission({
      grants,
      target: {
        project: requirement.project,
        environment: requirement.environment,
        path: requirement.documentPath,
      },
      action,
    });

    if (!decision.allowed) {
      throw new RuntimeError({
        code: "FORBIDDEN",
        message:
          "Session role does not allow this operation for the requested content scope.",
        statusCode: 403,
        details: {
          requiredScope: requirement.requiredScope,
          project: requirement.project,
          environment: requirement.environment ?? null,
          documentPath: requirement.documentPath ?? null,
        },
      });
    }

    return decision.effectiveRole;
  }

  async function revokeAllUserSessions(userId: string): Promise<number> {
    const normalizedUserId = assertNonEmptyString(userId, "userId");
    const revoked = await options.db
      .delete(authSessions)
      .where(eq(authSessions.userId, normalizedUserId))
      .returning({
        id: authSessions.id,
      });

    return revoked.length;
  }

  async function requireSession(request: Request): Promise<StudioSession> {
    const session = (await auth.api.getSession({
      headers: request.headers,
    })) as BetterAuthLikeSession | null;

    if (!session) {
      throw createUnauthorizedSessionError(
        "A valid Studio session is required.",
      );
    }

    const parsed = toStudioSession(session);

    if (isSessionBeyondAbsoluteMaxAge(parsed)) {
      await options.db
        .delete(authSessions)
        .where(eq(authSessions.id, parsed.id));
      throw createUnauthorizedSessionError(
        "Session exceeded the absolute maximum age.",
      );
    }

    return parsed;
  }

  async function sessionHasAdminPrivileges(
    session: StudioSession,
  ): Promise<boolean> {
    const grants = await loadSessionRbacGrants(session);
    const hasGlobalAdminGrant = grants.some(
      (grant) =>
        grant.scope.kind === "global" &&
        (grant.role === "owner" || grant.role === "admin"),
    );
    return hasGlobalAdminGrant || (await isAdminSession(session));
  }

  async function assertAdminSession(request: Request): Promise<StudioSession> {
    const session = await requireSession(request);
    const isAdmin = await sessionHasAdminPrivileges(session);

    if (!isAdmin) {
      throw new RuntimeError({
        code: "FORBIDDEN",
        message:
          "Admin privileges are required to revoke sessions for another user.",
        statusCode: 403,
      });
    }

    return session;
  }

  async function requireActiveApiKey(
    token: string,
  ): Promise<{ row: typeof apiKeys.$inferSelect; metadata: ApiKeyMetadata }> {
    ensureValidApiKeyToken(token);
    const hashedToken = hashApiKey(token);

    const row = await options.db.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.keyHash, hashedToken),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), sql`${apiKeys.expiresAt} > now()`),
      ),
    });

    if (!row) {
      throw new RuntimeError({
        code: "UNAUTHORIZED",
        message: "API key is invalid, expired, or revoked.",
        statusCode: 401,
      });
    }

    return {
      row,
      metadata: toApiKeyMetadata(row),
    };
  }

  async function requireApiKeyOwnerEmail(userId: string): Promise<string> {
    const user = await options.db.query.authUsers.findFirst({
      columns: { email: true },
      where: eq(authUsers.id, userId),
    });

    if (!user) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "API key owner no longer exists.",
        statusCode: 500,
      });
    }

    return user.email;
  }

  async function touchApiKeyLastUsed(keyId: string): Promise<void> {
    await options.db
      .update(apiKeys)
      .set({
        lastUsedAt: new Date(),
      })
      .where(eq(apiKeys.id, keyId));
  }

  function normalizeRequestedCliScopes(
    scopes: ApiKeyOperationScope[] | undefined,
  ): ApiKeyOperationScope[] {
    const source =
      scopes && scopes.length > 0 ? scopes : [...CLI_LOGIN_DEFAULT_SCOPES];
    return [...new Set(source)].sort();
  }

  async function createApiKeyForUser(input: {
    userId: string;
    label: string;
    scopes: ApiKeyOperationScope[];
    contextAllowlist: ApiKeyScopeTuple[];
    expiresAt?: Date | null;
  }): Promise<{ key: string; metadata: ApiKeyMetadata }> {
    const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
    const keyHash = hashApiKey(key);
    const keyPrefix = `${key.slice(0, API_KEY_PREFIX.length + 8)}...`;

    const [created] = await options.db
      .insert(apiKeys)
      .values({
        label: input.label,
        keyPrefix,
        keyHash,
        scopes: input.scopes,
        contextAllowlist: input.contextAllowlist,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.userId,
      })
      .returning();

    if (!created) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "Failed to create API key.",
        statusCode: 500,
      });
    }

    return {
      key,
      metadata: toApiKeyMetadata(created),
    };
  }

  async function requireCliLoginChallenge(
    challengeId: string,
  ): Promise<typeof cliLoginChallenges.$inferSelect> {
    const normalizedChallengeId = assertNonEmptyString(
      challengeId,
      "challengeId",
    );
    const row = await options.db.query.cliLoginChallenges.findFirst({
      where: eq(cliLoginChallenges.id, normalizedChallengeId),
    });

    if (!row) {
      throw new RuntimeError({
        code: "NOT_FOUND",
        message: "CLI login challenge not found.",
        statusCode: 404,
        details: {
          challengeId: normalizedChallengeId,
        },
      });
    }

    if (row.usedAt || row.status === "exchanged") {
      throw new RuntimeError({
        code: "LOGIN_CHALLENGE_USED",
        message: "CLI login challenge has already been used.",
        statusCode: 409,
      });
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      await options.db
        .update(cliLoginChallenges)
        .set({
          usedAt: new Date(),
          status: "exchanged",
        })
        .where(eq(cliLoginChallenges.id, row.id));

      throw new RuntimeError({
        code: "LOGIN_CHALLENGE_EXPIRED",
        message: "CLI login challenge expired.",
        statusCode: 410,
      });
    }

    return row;
  }

  function assertCliChallengeState(
    row: typeof cliLoginChallenges.$inferSelect,
    state: string,
  ): void {
    const normalizedState = assertNonEmptyString(state, "state");
    const stateHash = hashCliLoginToken(normalizedState);

    if (stateHash !== row.stateHash) {
      throw new RuntimeError({
        code: "INVALID_LOGIN_EXCHANGE",
        message: "CLI login state does not match challenge.",
        statusCode: 400,
      });
    }
  }

  async function loginWithEmailPassword(
    request: Request,
    email: string,
    password: string,
  ): Promise<PasswordLoginResult> {
    // MDCMS owns failed-attempt backoff here because server-side auth.api
    // calls are outside Better Auth's built-in rate limiter.
    const loginKey = normalizeLoginBackoffKey(email);
    const activeBackoff = await getActiveLoginBackoff(loginKey);

    if (activeBackoff) {
      return {
        outcome: "throttled",
        retryAfterSeconds: activeBackoff.retryAfterSeconds,
      };
    }

    const response = await auth.api.signInEmail({
      headers: request.headers,
      body: {
        email,
        password,
      },
      asResponse: true,
    });

    if (response.status >= 400) {
      await recordFailedLoginAttempt(loginKey);
      throw new RuntimeError({
        code: "AUTH_INVALID_CREDENTIALS",
        message: "Email or password is invalid.",
        statusCode: 401,
      });
    }

    const setCookie = response.headers.get("set-cookie");
    if (!setCookie || setCookie.trim().length === 0) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "Auth provider did not return a session cookie.",
        statusCode: 500,
      });
    }

    const cookiePair = extractCookiePair(setCookie);
    const session = (await auth.api.getSession({
      headers: new Headers({
        cookie: cookiePair,
      }),
    })) as BetterAuthLikeSession | null;

    if (!session) {
      throw new RuntimeError({
        code: "INTERNAL_ERROR",
        message: "Session lookup failed after successful sign-in.",
        statusCode: 500,
      });
    }

    const studioSession = toStudioSession(session);
    await clearLoginBackoff(loginKey);
    const csrf = createCsrfBootstrap();

    return {
      csrfToken: csrf.token,
      outcome: "success",
      session: studioSession,
      setCookie: appendSetCookieHeaders(setCookie, csrf.setCookie) ?? setCookie,
    };
  }

  async function getSessionIfAvailable(
    request: Request,
  ): Promise<StudioSession | undefined> {
    try {
      return await requireSession(request);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "UNAUTHORIZED") {
        return undefined;
      }

      throw error;
    }
  }

  async function assertCsrfProtection(request: Request): Promise<void> {
    if (!isStateChangingMethod(request.method)) {
      return;
    }

    // API-key requests are not susceptible to browser-driven CSRF.
    if (extractBearerToken(request.headers.get("authorization"))) {
      return;
    }

    const session = await getSessionIfAvailable(request);

    if (!session) {
      return;
    }

    const cookieToken = readCookieValue(request, CSRF_COOKIE_NAME);
    const headerToken = request.headers.get(CSRF_HEADER_NAME)?.trim();

    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
      throw new RuntimeError({
        code: "FORBIDDEN",
        message:
          "Valid CSRF token is required for session-authenticated state-changing requests.",
        statusCode: 403,
      });
    }
  }

  async function loadUserWithGrants(
    userId: string,
  ): Promise<UserWithGrants | undefined> {
    const user = await options.db.query.authUsers.findFirst({
      where: eq(authUsers.id, userId),
    });
    if (!user) return undefined;

    const activeGrants = await options.db
      .select()
      .from(rbacGrants)
      .where(and(eq(rbacGrants.userId, userId), isNull(rbacGrants.revokedAt)));

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      createdAt: user.createdAt.toISOString(),
      grants: activeGrants.map((g) => ({
        id: g.id,
        role: g.role,
        scopeKind: g.scopeKind,
        project: g.project,
        environment: g.environment,
        pathPrefix: g.pathPrefix,
        createdAt: g.createdAt.toISOString(),
      })),
    };
  }

  return {
    async login(request, email, password) {
      return loginWithEmailPassword(request, email, password);
    },

    async getSession(request) {
      return getSessionIfAvailable(request);
    },

    async getCurrentPrincipalCapabilities(request) {
      const target = assertRequestTargetRouting(request, "project_environment");
      const project = assertNonEmptyString(target.project, "project");
      const environment = assertNonEmptyString(
        target.environment,
        "environment",
      );
      const bearerToken = extractBearerToken(
        request.headers.get("authorization"),
      );

      if (bearerToken) {
        const { row, metadata } = await requireActiveApiKey(bearerToken);

        if (
          !apiKeyAllowsTarget(metadata.contextAllowlist, {
            project,
            environment,
          })
        ) {
          throw new RuntimeError({
            code: "TARGET_ROUTING_MISMATCH",
            message:
              "Explicit target routing does not match the API key allowlist.",
            statusCode: 400,
            details: {
              project,
              environment,
            },
          });
        }

        await touchApiKeyLastUsed(row.id);

        return {
          project,
          environment,
          capabilities: buildCapabilitiesFromApiKeyScopes(metadata.scopes),
        };
      }

      const session = await requireSession(request);
      const grants = await loadSessionRbacGrants(session);

      return {
        project,
        environment,
        capabilities: buildCapabilitiesFromSessionGrants({
          grants,
          target: {
            project,
            environment,
          },
        }),
      };
    },

    async requireAdminSession(request) {
      return assertAdminSession(request);
    },

    async logout(request) {
      const response = await auth.api.signOut({
        headers: request.headers,
        asResponse: true,
      });

      return {
        revoked: response.status < 400,
        setCookie: appendSetCookieHeaders(
          response.headers.get("set-cookie"),
          createClearedCsrfCookie(),
        ),
      };
    },

    async signOut(request) {
      return withSetCookie(
        await auth.handler(request),
        createClearedCsrfCookie(),
      );
    },

    async authorizeRequest(request, requirement) {
      const bearerToken = extractBearerToken(
        request.headers.get("authorization"),
      );

      if (bearerToken) {
        const { row, metadata } = await requireActiveApiKey(bearerToken);
        const hasRequiredScope = apiKeyScopesSatisfyRequirement(
          metadata.scopes,
          requirement.requiredScope,
        );

        if (!hasRequiredScope) {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: `API key scope "${requirement.requiredScope}" is required for this endpoint.`,
            statusCode: 403,
            details: {
              requiredScope: requirement.requiredScope,
            },
          });
        }

        if (!requirement.project || !requirement.environment) {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message:
              "API key authorization requires explicit project/environment routing context.",
            statusCode: 403,
          });
        }

        const isContextAllowed = apiKeyAllowsTarget(metadata.contextAllowlist, {
          project: requirement.project,
          environment: requirement.environment,
        });

        if (!isContextAllowed) {
          throw new RuntimeError({
            code: "TARGET_ROUTING_MISMATCH",
            message:
              "Explicit target routing does not match the API key allowlist.",
            statusCode: 400,
            details: {
              project: requirement.project,
              environment: requirement.environment,
            },
          });
        }

        const createdByUserEmail = await requireApiKeyOwnerEmail(
          metadata.createdByUserId,
        );
        await touchApiKeyLastUsed(row.id);

        return {
          mode: "api_key",
          principal: {
            type: "api_key",
            keyId: metadata.id,
            createdByUserId: metadata.createdByUserId,
            createdByUserEmail,
            keyPrefix: metadata.keyPrefix,
            label: metadata.label,
            scopes: metadata.scopes,
            contextAllowlist: metadata.contextAllowlist,
          } satisfies ApiKeyPrincipal,
        };
      }

      const session = await requireSession(request);
      const role = await assertSessionRbacAuthorization(session, requirement);
      return {
        mode: "session",
        principal: {
          type: "session",
          session,
          role,
        } satisfies SessionPrincipal,
      };
    },

    async requireCsrfProtection(request) {
      await assertCsrfProtection(request);
    },

    issueCsrfBootstrap(request) {
      return createCsrfBootstrap(request);
    },

    clearCsrfCookie() {
      return createClearedCsrfCookie();
    },

    async createApiKey(request, input) {
      const session = await requireSession(request);
      const parsed = CreateApiKeyInputSchema.safeParse(input);

      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            parsed.error.issues[0]?.message ?? "API key payload is invalid.",
          statusCode: 400,
          details: {
            issue: parsed.error.issues[0]?.path.join(".") ?? undefined,
          },
        });
      }

      await assertSessionCanIssueApiKeyScopes(
        session,
        parsed.data.scopes,
        parsed.data.contextAllowlist,
      );

      const expiresAt = parsed.data.expiresAt
        ? new Date(parsed.data.expiresAt)
        : null;
      return createApiKeyForUser({
        userId: session.userId,
        label: parsed.data.label,
        scopes: parsed.data.scopes,
        contextAllowlist: parsed.data.contextAllowlist,
        expiresAt,
      });
    },

    async listApiKeys(request) {
      const session = await requireSession(request);
      const isAdmin = await sessionHasAdminPrivileges(session);

      const query = options.db.select().from(apiKeys);
      const rows = await (isAdmin
        ? query.orderBy(desc(apiKeys.createdAt))
        : query
            .where(eq(apiKeys.createdByUserId, session.userId))
            .orderBy(desc(apiKeys.createdAt)));

      return rows.map((row) => toApiKeyMetadata(row));
    },

    async revokeApiKey(request, keyId) {
      const session = await requireSession(request);
      const normalizedKeyId = assertNonEmptyString(keyId, "keyId");
      const isAdmin = await sessionHasAdminPrivileges(session);

      const [existing] = await options.db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, normalizedKeyId))
        .limit(1);

      if (
        !existing ||
        (!isAdmin && existing.createdByUserId !== session.userId)
      ) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "API key not found.",
          statusCode: 404,
          details: {
            keyId: normalizedKeyId,
          },
        });
      }

      const [updated] = await options.db
        .update(apiKeys)
        .set({
          revokedAt: new Date(),
        })
        .where(eq(apiKeys.id, normalizedKeyId))
        .returning();

      return toApiKeyMetadata(updated ?? existing);
    },

    async revokeSelfApiKey(request) {
      const bearerToken = extractBearerToken(
        request.headers.get("authorization"),
      );

      if (!bearerToken) {
        throw new RuntimeError({
          code: "UNAUTHORIZED",
          message: "Authorization header with Bearer API key is required.",
          statusCode: 401,
        });
      }

      const { row } = await requireActiveApiKey(bearerToken);

      await options.db
        .update(apiKeys)
        .set({
          revokedAt: new Date(),
        })
        .where(eq(apiKeys.id, row.id));

      return {
        revoked: true,
        keyId: row.id,
      };
    },

    async startCliLogin(input) {
      const parsed = CliLoginStartInputSchema.safeParse(input);

      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            parsed.error.issues[0]?.message ??
            "CLI login start payload is invalid.",
          statusCode: 400,
        });
      }

      const redirectUri = assertLoopbackRedirectUri(parsed.data.redirectUri);
      const state = parsed.data.state.trim();
      const stateHash = hashCliLoginToken(state);
      const expiresAt = new Date(Date.now() + CLI_LOGIN_CHALLENGE_TTL_MS);
      const requestedScopes = normalizeRequestedCliScopes(parsed.data.scopes);
      const [challenge] = await options.db
        .insert(cliLoginChallenges)
        .values({
          project: parsed.data.project,
          environment: parsed.data.environment,
          redirectUri,
          requestedScopes,
          stateHash,
          status: "pending",
          expiresAt,
        })
        .returning();

      if (!challenge) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "Failed to create CLI login challenge.",
          statusCode: 500,
        });
      }

      const authorizeUrl = appendQueryParams(
        `${baseUrl}/api/v1/auth/cli/login/authorize`,
        {
          challenge: challenge.id,
          state,
        },
      );

      return {
        challengeId: challenge.id,
        authorizeUrl,
        expiresAt: challenge.expiresAt.toISOString(),
      };
    },

    async authorizeCliLogin(input) {
      const challengeId = assertNonEmptyString(
        input.challengeId,
        "challengeId",
      );
      const state = assertNonEmptyString(input.state, "state");
      const challenge = await requireCliLoginChallenge(challengeId);
      assertCliChallengeState(challenge, state);

      let session = await getSessionIfAvailable(input.request);
      let setCookie: string | undefined;

      if (!session) {
        if (!input.email || !input.password) {
          return {
            outcome: "login_required",
            challengeId,
            state,
          };
        }

        const loginResult = await loginWithEmailPassword(
          input.request,
          input.email,
          input.password,
        );

        if (loginResult.outcome === "throttled") {
          return {
            outcome: "throttled",
            retryAfterSeconds: loginResult.retryAfterSeconds,
          };
        }

        session = loginResult.session;
        setCookie = loginResult.setCookie;
      }

      if (!session) {
        throw new RuntimeError({
          code: "UNAUTHORIZED",
          message: "A valid session is required to authorize CLI login.",
          statusCode: 401,
        });
      }

      const authContextAllowlist: ApiKeyScopeTuple[] = [
        {
          project: challenge.project,
          environment: challenge.environment,
        },
      ];

      await assertSessionCanIssueApiKeyScopes(
        session,
        normalizeRequestedCliScopes(
          challenge.requestedScopes as ApiKeyOperationScope[],
        ),
        authContextAllowlist,
      );

      const code = randomBytes(24).toString("base64url");
      const codeHash = hashCliLoginToken(code);
      await options.db
        .update(cliLoginChallenges)
        .set({
          authorizationCodeHash: codeHash,
          userId: session.userId,
          status: "authorized",
          authorizedAt: new Date(),
        })
        .where(eq(cliLoginChallenges.id, challenge.id));

      return {
        outcome: "redirect",
        location: appendQueryParams(challenge.redirectUri, {
          code,
          state,
        }),
        setCookie,
      };
    },

    async exchangeCliLogin(input) {
      const parsed = CliLoginExchangeInputSchema.safeParse(input);

      if (!parsed.success) {
        throw new RuntimeError({
          code: "INVALID_INPUT",
          message:
            parsed.error.issues[0]?.message ??
            "CLI login exchange payload is invalid.",
          statusCode: 400,
        });
      }

      const challenge = await requireCliLoginChallenge(parsed.data.challengeId);
      assertCliChallengeState(challenge, parsed.data.state);

      if (
        challenge.status !== "authorized" ||
        !challenge.authorizationCodeHash ||
        !challenge.userId
      ) {
        throw new RuntimeError({
          code: "INVALID_LOGIN_EXCHANGE",
          message: "CLI login challenge is not ready for code exchange.",
          statusCode: 400,
        });
      }

      const codeHash = hashCliLoginToken(parsed.data.code);
      if (codeHash !== challenge.authorizationCodeHash) {
        throw new RuntimeError({
          code: "INVALID_LOGIN_EXCHANGE",
          message: "CLI login authorization code is invalid.",
          statusCode: 400,
        });
      }

      const label = `cli:${challenge.project}/${challenge.environment}`;
      const contextAllowlist: ApiKeyScopeTuple[] = [
        {
          project: challenge.project,
          environment: challenge.environment,
        },
      ];
      const created = await createApiKeyForUser({
        userId: challenge.userId,
        label,
        scopes: normalizeRequestedCliScopes(
          challenge.requestedScopes as ApiKeyOperationScope[],
        ),
        contextAllowlist,
      });

      await options.db
        .update(cliLoginChallenges)
        .set({
          status: "exchanged",
          usedAt: new Date(),
        })
        .where(eq(cliLoginChallenges.id, challenge.id));

      return created;
    },

    revokeAllUserSessions,

    async revokeAllSessionsForUserByAdmin(request, userId) {
      await assertAdminSession(request);
      const normalizedUserId = assertNonEmptyString(userId, "userId");
      const user = await options.db.query.authUsers.findFirst({
        where: eq(authUsers.id, normalizedUserId),
      });

      if (!user) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "User not found.",
          statusCode: 404,
          details: {
            userId: normalizedUserId,
          },
        });
      }

      const revokedSessions = await revokeAllUserSessions(normalizedUserId);
      return {
        userId: normalizedUserId,
        revokedSessions,
      };
    },

    async startSsoSignIn(request) {
      const payload = await parseSsoSignInPayload(request);

      const response = await auth.handler(
        createSsoSignInRequest(request, payload),
      );

      if (response.status === 404) {
        throw createSsoProviderNotConfiguredError(payload.providerId);
      }

      if (response.status === 400) {
        throw createInvalidInputError("SSO sign-in payload is invalid.");
      }

      if (response.status >= 500) {
        throw createAuthProviderError("sign_in_failed", "SSO sign-in failed.");
      }

      if (response.status >= 400) {
        return response;
      }

      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as
        | {
            url?: unknown;
            redirect?: unknown;
          }
        | undefined;
      const location =
        typeof body?.url === "string" && body.url.trim().length > 0
          ? body.url
          : undefined;

      if (!location) {
        throw new RuntimeError({
          code: "INTERNAL_ERROR",
          message: "SSO sign-in did not return a provider redirect URL.",
          statusCode: 500,
        });
      }

      if (configuredSamlProviderIds.has(payload.providerId)) {
        const requestId = extractSamlAuthnRequestId(location);

        if (!requestId) {
          throw createAuthProviderError(
            "invalid_saml_request",
            "SAML sign-in did not produce an AuthnRequest ID.",
          );
        }

        const now = Date.now();
        const expiresAt = new Date(now + SAML_AUTHN_REQUEST_TTL_MS);
        const identifier = `saml-authn-request:${requestId}`;

        await options.db
          .delete(authVerifications)
          .where(eq(authVerifications.identifier, identifier));
        await options.db.insert(authVerifications).values({
          id: randomBytes(24).toString("base64url"),
          identifier,
          value: JSON.stringify({
            id: requestId,
            providerId: payload.providerId,
            createdAt: now,
            expiresAt: expiresAt.getTime(),
          }),
          expiresAt,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        });
      }

      return toRedirectResponse(response, location);
    },

    async handleSsoCallback(request) {
      const providerId = new URL(request.url).pathname.split("/").at(-1);
      assertConfiguredSsoProvider(
        assertNonEmptyString(providerId, "providerId"),
      );

      const response = await auth.handler(request);
      const hookError = oidcCallbackHookErrors.get(request.url);

      if (hookError) {
        oidcCallbackHookErrors.delete(request.url);
        throw hookError;
      }

      if (response.status !== 302) {
        return response;
      }

      const location = response.headers.get("location");

      if (!location) {
        return response;
      }

      const mappedError = mapSsoCallbackErrorCode(location, providerId);

      if (mappedError) {
        throw mappedError;
      }

      return response;
    },

    async handleSamlAcs(request) {
      const providerId = assertNonEmptyString(
        new URL(request.url).pathname.split("/").at(-1),
        "providerId",
      );
      assertConfiguredSamlProvider(providerId);
      const payload = await parseSamlAcsPayload(request);
      const requestKey = createSamlAcsRequestKey(
        request.url,
        payload.SAMLResponse,
      );
      await validateSamlAcsInResponseTo(payload, providerId);
      await validateSamlAcsRequiredAttributes(payload, providerId);

      let response: Response;

      try {
        response = await auth.handler(request);
      } catch (error) {
        if (isMissingRequiredSamlAttributeFailure(error)) {
          throw createRequiredSamlAttributeError();
        }

        throw error;
      }

      const hookError = samlCallbackHookErrors.get(requestKey);

      if (hookError) {
        samlCallbackHookErrors.delete(requestKey);
        throw hookError;
      }

      if (response.status === 404) {
        throw createSsoProviderNotConfiguredError(providerId);
      }

      if (response.status === 400) {
        const payload = await readAuthHandlerErrorPayload(response);
        const message =
          typeof payload.message === "string" ? payload.message : "";
        const normalizedMessage = message.toLowerCase();

        if (normalizedMessage.includes("unable to extract user id or email")) {
          throw createRequiredSamlAttributeError();
        }

        if (
          normalizedMessage.includes("state error") ||
          normalizedMessage.includes("samlresponse is required") ||
          normalizedMessage.includes("maximum allowed size")
        ) {
          throw createInvalidInputError(
            message || "SAML Assertion Consumer Service request is invalid.",
          );
        }

        throw createAuthProviderError(
          "invalid_saml_response",
          typeof payload.details === "string"
            ? payload.details
            : message || "Invalid SAML response",
        );
      }

      if (response.status >= 500) {
        const payload = await readAuthHandlerErrorPayload(response);
        const message =
          typeof payload.message === "string" ? payload.message : "";
        const details =
          typeof payload.details === "string" ? payload.details : "";
        if (isMissingRequiredSamlAttributeFailure(`${message} ${details}`)) {
          throw createRequiredSamlAttributeError();
        }

        throw createAuthProviderError("acs_failed", "SAML ACS request failed.");
      }

      if (response.status !== 302) {
        return response;
      }

      const location = response.headers.get("location");

      if (!location) {
        return response;
      }

      const mappedError = mapSsoCallbackErrorCode(location, providerId);

      if (mappedError) {
        throw mappedError;
      }

      return response;
    },

    async handleSamlMetadata(request) {
      const query = parseSamlMetadataQuery(request);
      const provider = staticSamlProviderById.get(query.providerId);

      if (!provider) {
        throw createSsoProviderNotConfiguredError(query.providerId);
      }

      if (query.format === "json") {
        return createJsonResponse(
          {
            data: createStaticSamlMetadataJson(provider),
          },
          200,
        );
      }

      return new Response(createStaticSamlMetadataXml(provider), {
        status: 200,
        headers: {
          "content-type": "application/xml; charset=utf-8",
        },
      });
    },

    handleAuthRequest(request) {
      return auth.handler(request);
    },
    listSsoProviders() {
      const providers: Array<{ id: string; name: string }> = [];

      for (const [id] of oidcProviderConfigById) {
        providers.push({ id, name: formatSsoProviderName(id) });
      }

      for (const [id] of samlProviderConfigById) {
        if (!providers.some((p) => p.id === id)) {
          providers.push({ id, name: formatSsoProviderName(id) });
        }
      }

      return providers;
    },

    async listUsers(request) {
      await assertAdminSession(request);
      const users = await options.db.query.authUsers.findMany({
        orderBy: (users, { asc }) => [asc(users.createdAt)],
      });
      const activeGrants = await options.db
        .select()
        .from(rbacGrants)
        .where(isNull(rbacGrants.revokedAt));
      const grantsByUserId = new Map<string, (typeof activeGrants)[number][]>();
      for (const grant of activeGrants) {
        const existing = grantsByUserId.get(grant.userId) ?? [];
        existing.push(grant);
        grantsByUserId.set(grant.userId, existing);
      }
      return users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        createdAt: user.createdAt.toISOString(),
        grants: (grantsByUserId.get(user.id) ?? []).map((g) => ({
          id: g.id,
          role: g.role,
          scopeKind: g.scopeKind,
          project: g.project,
          environment: g.environment,
          pathPrefix: g.pathPrefix,
          createdAt: g.createdAt.toISOString(),
        })),
      }));
    },

    async getUser(request, userId) {
      await assertAdminSession(request);
      const normalizedId = assertNonEmptyString(userId, "userId");
      const user = await loadUserWithGrants(normalizedId);
      if (!user) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "User not found.",
          statusCode: 404,
        });
      }
      return user;
    },

    async inviteUser(request, input) {
      const session = await assertAdminSession(request);
      const email = assertNonEmptyString(input.email, "email")
        .toLowerCase()
        .trim();
      if (!Array.isArray(input.grants) || input.grants.length === 0) {
        throw new RuntimeError({
          code: "VALIDATION_ERROR",
          message: "At least one grant is required.",
          statusCode: 400,
        });
      }
      // Validate grants
      const ALLOWED_ROLES = ["viewer", "editor", "admin"] as const;
      const ALLOWED_SCOPE_KINDS = [
        "global",
        "project",
        "folder_prefix",
      ] as const;
      for (const grant of input.grants) {
        const role = assertNonEmptyString(grant.role, "role");
        const scopeKind = assertNonEmptyString(grant.scopeKind, "scopeKind");
        if (role === "owner") {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: "Cannot invite with owner role.",
            statusCode: 403,
          });
        }
        if (!(ALLOWED_ROLES as readonly string[]).includes(role)) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: `Invalid role: ${role}. Allowed: ${ALLOWED_ROLES.join(", ")}.`,
            statusCode: 400,
          });
        }
        if (!(ALLOWED_SCOPE_KINDS as readonly string[]).includes(scopeKind)) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: `Invalid scopeKind: ${scopeKind}. Allowed: ${ALLOWED_SCOPE_KINDS.join(", ")}.`,
            statusCode: 400,
          });
        }
        if (role === "admin" && scopeKind !== "global") {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: "Admin role must be global scope.",
            statusCode: 400,
          });
        }
        if (scopeKind === "project" && !grant.project) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: "Project scope requires a project.",
            statusCode: 400,
          });
        }
        if (
          scopeKind === "folder_prefix" &&
          (!grant.project || !grant.environment || !grant.pathPrefix)
        ) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message:
              "Folder prefix scope requires project, environment, and pathPrefix.",
            statusCode: 400,
          });
        }
      }
      // Validate email service before any DB writes
      if (!options.emailService) {
        throw new RuntimeError({
          code: "EMAIL_NOT_CONFIGURED",
          message: "Email service is not configured. Cannot send invite.",
          statusCode: 500,
        });
      }
      // Check for existing pending invite
      const existingInvite = await options.db.query.invites.findFirst({
        where: and(
          eq(invites.email, email),
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
        ),
      });
      if (existingInvite) {
        throw new RuntimeError({
          code: "INVITE_ALREADY_PENDING",
          message: "An active invitation already exists for this email.",
          statusCode: 409,
        });
      }
      const existingUser = await options.db.query.authUsers.findFirst({
        where: eq(authUsers.email, email),
      });
      if (existingUser) {
        throw new RuntimeError({
          code: "EMAIL_ALREADY_REGISTERED",
          message: "A user with this email already exists.",
          statusCode: 409,
        });
      }
      // Get inviter name before transaction
      const inviter = await options.db.query.authUsers.findFirst({
        where: eq(authUsers.id, session.userId),
      });
      const studioUrl = parsedEnv.MDCMS_STUDIO_ALLOWED_ORIGINS[0] ?? baseUrl;
      // Generate token and insert + send email transactionally
      const token = randomBytes(32).toString("hex");
      const tokenHash = hashInviteToken(token);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [inserted] = await options.db
        .insert(invites)
        .values({
          tokenHash,
          email,
          grants: input.grants,
          createdByUserId: session.userId,
          expiresAt,
        })
        .returning();
      await options.emailService!.sendInviteEmail({
        to: email,
        inviterName: inviter?.name ?? "An administrator",
        studioUrl,
        token,
      });
      return {
        id: inserted.id,
        email: inserted.email,
        expiresAt: inserted.expiresAt.toISOString(),
      };
    },

    async updateUserGrants(request, userId, newGrants) {
      const session = await assertAdminSession(request);
      const normalizedId = assertNonEmptyString(userId, "userId");
      if (!Array.isArray(newGrants) || newGrants.length === 0) {
        throw new RuntimeError({
          code: "VALIDATION_ERROR",
          message: "At least one grant is required.",
          statusCode: 400,
        });
      }
      // Validate grants
      const ALLOWED_GRANT_ROLES = [
        "viewer",
        "editor",
        "admin",
        "owner",
      ] as const;
      const ALLOWED_GRANT_SCOPE_KINDS = [
        "global",
        "project",
        "folder_prefix",
      ] as const;
      for (const grant of newGrants) {
        const role = assertNonEmptyString(grant.role, "role");
        const scopeKind = assertNonEmptyString(grant.scopeKind, "scopeKind");
        if (!(ALLOWED_GRANT_ROLES as readonly string[]).includes(role)) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: `Invalid role: ${role}. Allowed: ${ALLOWED_GRANT_ROLES.join(", ")}.`,
            statusCode: 400,
          });
        }
        if (
          !(ALLOWED_GRANT_SCOPE_KINDS as readonly string[]).includes(scopeKind)
        ) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: `Invalid scopeKind: ${scopeKind}. Allowed: ${ALLOWED_GRANT_SCOPE_KINDS.join(", ")}.`,
            statusCode: 400,
          });
        }
        if ((role === "admin" || role === "owner") && scopeKind !== "global") {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: `${role} role must be global scope.`,
            statusCode: 400,
          });
        }
        if (scopeKind === "project" && !grant.project) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message: "Project scope requires a project.",
            statusCode: 400,
          });
        }
        if (
          scopeKind === "folder_prefix" &&
          (!grant.project || !grant.environment || !grant.pathPrefix)
        ) {
          throw new RuntimeError({
            code: "VALIDATION_ERROR",
            message:
              "Folder prefix scope requires project, environment, and pathPrefix.",
            statusCode: 400,
          });
        }
      }
      const user = await options.db.query.authUsers.findFirst({
        where: eq(authUsers.id, normalizedId),
      });
      if (!user) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "User not found.",
          statusCode: 404,
        });
      }
      // Only owners can grant the owner role
      const willBeOwner = newGrants.some((g) => g.role === "owner");
      if (willBeOwner) {
        const callerGrants = await loadSessionRbacGrants(session);
        const callerIsOwner = callerGrants.some(
          (g) => g.role === "owner" && g.scope.kind === "global",
        );
        if (!callerIsOwner) {
          throw new RuntimeError({
            code: "FORBIDDEN",
            message: "Only owners can grant the owner role.",
            statusCode: 403,
          });
        }
      }
      // Revoke + insert in a single transaction (owner check inside to prevent TOCTOU race)
      await options.db.transaction(async (tx) => {
        const currentGrants = await tx
          .select()
          .from(rbacGrants)
          .where(
            and(
              eq(rbacGrants.userId, normalizedId),
              isNull(rbacGrants.revokedAt),
            ),
          );
        const isCurrentlyOwner = currentGrants.some((g) => g.role === "owner");
        if (isCurrentlyOwner && !willBeOwner) {
          const ownerCountRow = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(rbacGrants)
            .where(
              and(eq(rbacGrants.role, "owner"), isNull(rbacGrants.revokedAt)),
            );
          assertOwnerMutationAllowed({
            activeOwnerCount: ownerCountRow[0]?.count ?? 0,
            intent: "demote_owner",
          });
        }
        await tx
          .update(rbacGrants)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(rbacGrants.userId, normalizedId),
              isNull(rbacGrants.revokedAt),
            ),
          );
        for (const grant of newGrants) {
          await tx.insert(rbacGrants).values({
            userId: normalizedId,
            role: grant.role,
            scopeKind: grant.scopeKind,
            project: grant.project || null,
            environment: grant.environment || null,
            pathPrefix: grant.pathPrefix || null,
            createdByUserId: session.userId,
          });
        }
      });
      const updated = await loadUserWithGrants(normalizedId);
      return updated!;
    },

    async removeUser(request, userId) {
      const session = await assertAdminSession(request);
      const normalizedId = assertNonEmptyString(userId, "userId");
      if (normalizedId === session.userId) {
        throw new RuntimeError({
          code: "FORBIDDEN",
          message: "Cannot remove your own account.",
          statusCode: 403,
        });
      }
      const user = await options.db.query.authUsers.findFirst({
        where: eq(authUsers.id, normalizedId),
      });
      if (!user) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "User not found.",
          statusCode: 404,
        });
      }
      // Owner check + removal in a single transaction to prevent TOCTOU race
      await options.db.transaction(async (tx) => {
        const userGrants = await tx
          .select()
          .from(rbacGrants)
          .where(
            and(
              eq(rbacGrants.userId, normalizedId),
              isNull(rbacGrants.revokedAt),
            ),
          );
        const isOwner = userGrants.some((g) => g.role === "owner");
        if (isOwner) {
          const ownerCountRow = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(rbacGrants)
            .where(
              and(eq(rbacGrants.role, "owner"), isNull(rbacGrants.revokedAt)),
            );
          assertOwnerMutationAllowed({
            activeOwnerCount: ownerCountRow[0]?.count ?? 0,
            intent: "remove_owner",
          });
        }
        await tx
          .update(rbacGrants)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(rbacGrants.userId, normalizedId),
              isNull(rbacGrants.revokedAt),
            ),
          );
        // Revoke all sessions
        await tx
          .delete(authSessions)
          .where(eq(authSessions.userId, normalizedId));
        // Delete API keys (FK is onDelete: restrict, must remove first)
        await tx
          .delete(apiKeys)
          .where(eq(apiKeys.createdByUserId, normalizedId));
        // Delete user (cascades sessions/accounts/invites)
        await tx.delete(authUsers).where(eq(authUsers.id, normalizedId));
      });
      return { removed: true as const };
    },

    async listInvites(request) {
      await assertAdminSession(request);
      const rows = await options.db.query.invites.findMany({
        where: and(
          isNull(invites.acceptedAt),
          isNull(invites.revokedAt),
          gt(invites.expiresAt, new Date()),
        ),
        orderBy: desc(invites.createdAt),
      });
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        grants: row.grants,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }));
    },

    async revokeInvite(request, inviteId) {
      await assertAdminSession(request);
      const normalizedId = assertNonEmptyString(inviteId, "inviteId");
      const invite = await options.db.query.invites.findFirst({
        where: eq(invites.id, normalizedId),
      });
      if (!invite) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Invitation not found.",
          statusCode: 404,
        });
      }
      if (invite.acceptedAt) {
        throw new RuntimeError({
          code: "INVITE_ALREADY_ACCEPTED",
          message: "This invitation has already been accepted.",
          statusCode: 409,
        });
      }
      if (invite.revokedAt) {
        throw new RuntimeError({
          code: "INVITE_ALREADY_REVOKED",
          message: "This invitation has already been revoked.",
          statusCode: 409,
        });
      }
      await options.db
        .update(invites)
        .set({ revokedAt: new Date() })
        .where(eq(invites.id, normalizedId));
      return { revoked: true as const };
    },

    async acceptInvite(token, input) {
      const normalizedToken = assertNonEmptyString(token, "token");
      const name = assertNonEmptyString(input.name, "name");
      const password = assertNonEmptyString(input.password, "password");
      if (password.length < 8) {
        throw new RuntimeError({
          code: "VALIDATION_ERROR",
          message: "Password must be at least 8 characters.",
          statusCode: 400,
        });
      }
      const tokenHash = hashInviteToken(normalizedToken);
      const invite = await options.db.query.invites.findFirst({
        where: eq(invites.tokenHash, tokenHash),
      });
      if (!invite) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Invitation not found.",
          statusCode: 404,
        });
      }
      if (invite.acceptedAt) {
        throw new RuntimeError({
          code: "INVITE_ALREADY_ACCEPTED",
          message: "This invitation has already been accepted.",
          statusCode: 409,
        });
      }
      if (invite.revokedAt) {
        throw new RuntimeError({
          code: "INVITE_REVOKED",
          message: "This invitation has been revoked.",
          statusCode: 410,
        });
      }
      if (new Date() > invite.expiresAt) {
        throw new RuntimeError({
          code: "INVITE_EXPIRED",
          message: "This invitation has expired.",
          statusCode: 410,
        });
      }
      // Hash password before entering transaction
      const { hashPassword } = await import("better-auth/crypto");
      const hashedPassword = await hashPassword(password);

      const userId = crypto.randomUUID();
      await options.db.transaction(async (tx) => {
        // Atomically claim the invite to prevent concurrent acceptors
        const [claimed] = await tx
          .update(invites)
          .set({ acceptedAt: new Date() })
          .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
          .returning({ id: invites.id });
        if (!claimed) {
          throw new RuntimeError({
            code: "INVITE_ALREADY_ACCEPTED",
            message: "This invitation has already been accepted.",
            statusCode: 409,
          });
        }
        const existingUser = await tx.query.authUsers.findFirst({
          where: eq(authUsers.email, invite.email),
        });
        if (existingUser) {
          throw new RuntimeError({
            code: "EMAIL_ALREADY_REGISTERED",
            message: "A user with this email already exists.",
            statusCode: 409,
          });
        }
        // Create user
        await tx.insert(authUsers).values({
          id: userId,
          name,
          email: invite.email,
          emailVerified: true,
        });
        // Create account with password
        await tx.insert(authAccounts).values({
          id: crypto.randomUUID(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: hashedPassword,
        });
        // Apply grants from invite
        for (const grant of invite.grants) {
          await tx.insert(rbacGrants).values({
            userId,
            role: grant.role,
            scopeKind: grant.scopeKind,
            project: grant.project || null,
            environment: grant.environment || null,
            pathPrefix: grant.pathPrefix || null,
            source: `invite:${invite.id}`,
            createdByUserId: invite.createdByUserId,
          });
        }
      });
      return { userId };
    },
  };
}

export type MountAuthRoutesOptions = {
  authService: AuthService;
};

function requireSessionPayload(
  session: StudioSession | undefined,
): StudioSession {
  if (!session) {
    throw createUnauthorizedSessionError("A valid Studio session is required.");
  }

  return session;
}

function parseCliLoginAuthorizeQuery(request: Request): {
  challengeId: string;
  state: string;
} {
  const url = new URL(request.url);
  const challengeId = assertNonEmptyString(
    url.searchParams.get("challenge"),
    "challenge",
  );
  const state = assertNonEmptyString(url.searchParams.get("state"), "state");
  return {
    challengeId,
    state,
  };
}

export function mountAuthRoutes(
  app: unknown,
  options: MountAuthRoutesOptions,
): void {
  const authApp = app as AuthRouteApp;

  authApp.post?.("/api/v1/auth/login", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const payload = (body ?? {}) as {
        email?: unknown;
        password?: unknown;
      };
      const email = assertNonEmptyString(payload.email, "email");
      const password = assertNonEmptyString(payload.password, "password");
      const result = await options.authService.login(request, email, password);

      if (result.outcome === "throttled") {
        return createAuthBackoffResponse(request, result.retryAfterSeconds);
      }

      return createJsonResponse(
        {
          data: {
            csrfToken: result.csrfToken,
            session: result.session,
          },
        },
        200,
        {
          "set-cookie": result.setCookie,
        },
      );
    }),
  );

  const mountSessionRoute = (path: string): void => {
    authApp.get?.(path, ({ request }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        const session = requireSessionPayload(
          await options.authService.getSession(request),
        );
        const csrf = options.authService.issueCsrfBootstrap(request);
        return createJsonResponse(
          {
            data: {
              csrfToken: csrf.token,
              session,
            },
          },
          200,
          {
            "set-cookie": csrf.setCookie,
          },
        );
      }),
    );
  };

  mountSessionRoute("/api/v1/auth/session");

  authApp.get?.("/api/v1/me/capabilities", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const capabilities =
        await options.authService.getCurrentPrincipalCapabilities(request);

      return {
        data: capabilities,
      };
    }),
  );

  authApp.post?.("/api/v1/auth/logout", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      await options.authService.requireCsrfProtection(request);
      const result = await options.authService.logout(request);

      return createJsonResponse(
        {
          data: {
            revoked: result.revoked,
          },
        },
        200,
        result.setCookie
          ? {
              "set-cookie": result.setCookie,
            }
          : {},
      );
    }),
  );

  authApp.post?.(
    "/api/v1/auth/users/:userId/sessions/revoke-all",
    ({ request, params }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        await options.authService.requireCsrfProtection(request);
        const result =
          await options.authService.revokeAllSessionsForUserByAdmin(
            request,
            params.userId,
          );

        return {
          data: result,
        };
      }),
  );

  authApp.get?.("/api/v1/auth/api-keys", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const rows = await options.authService.listApiKeys(request);
      return {
        data: rows,
      };
    }),
  );

  authApp.post?.("/api/v1/auth/api-keys", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      await options.authService.requireCsrfProtection(request);
      const payload = (body ?? {}) as CreateApiKeyInput;
      const created = await options.authService.createApiKey(request, payload);

      return {
        data: {
          key: created.key,
          ...created.metadata,
        },
      };
    }),
  );

  authApp.post?.(
    "/api/v1/auth/api-keys/:keyId/revoke",
    ({ request, params }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        await options.authService.requireCsrfProtection(request);
        const metadata = await options.authService.revokeApiKey(
          request,
          params.keyId,
        );

        return {
          data: metadata,
        };
      }),
  );

  authApp.post?.("/api/v1/auth/api-keys/self/revoke", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const result = await options.authService.revokeSelfApiKey(request);
      return {
        data: result,
      };
    }),
  );

  authApp.get?.("/api/v1/auth/users", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const users = await options.authService.listUsers(request);
      return { data: users };
    }),
  );

  authApp.post?.("/api/v1/auth/users/invite", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      await options.authService.requireCsrfProtection(request);
      const payload = (body ?? {}) as InviteUserInput;
      const result = await options.authService.inviteUser(request, payload);
      return { data: result };
    }),
  );

  authApp.get?.("/api/v1/auth/invites", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const pending = await options.authService.listInvites(request);
      return { data: pending };
    }),
  );

  authApp.delete?.(
    "/api/v1/auth/invites/:inviteId",
    ({ request, params }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        await options.authService.requireCsrfProtection(request);
        const result = await options.authService.revokeInvite(
          request,
          params.inviteId,
        );
        return { data: result };
      }),
  );

  authApp.get?.("/api/v1/auth/users/:userId", ({ request, params }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const user = await options.authService.getUser(request, params.userId);
      return { data: user };
    }),
  );

  authApp.patch?.(
    "/api/v1/auth/users/:userId/grants",
    ({ request, params, body }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        await options.authService.requireCsrfProtection(request);
        const payload = (body ?? {}) as { grants: InviteUserInput["grants"] };
        const user = await options.authService.updateUserGrants(
          request,
          params.userId,
          payload.grants,
        );
        return { data: user };
      }),
  );

  authApp.delete?.("/api/v1/auth/users/:userId", ({ request, params }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      await options.authService.requireCsrfProtection(request);
      const result = await options.authService.removeUser(
        request,
        params.userId,
      );
      return { data: result };
    }),
  );

  authApp.post?.(
    "/api/v1/auth/invites/:token/accept",
    ({ request, params, body }: any) =>
      executeWithRuntimeErrorsHandled(request, async () => {
        const payload = (body ?? {}) as AcceptInviteInput;
        const result = await options.authService.acceptInvite(
          params.token,
          payload,
        );
        return { data: result };
      }),
  );

  authApp.post?.("/api/v1/auth/cli/login/start", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const payload = (body ?? {}) as CliLoginStartInput;
      const started = await options.authService.startCliLogin(payload);
      return {
        data: started,
      };
    }),
  );

  authApp.get?.("/api/v1/auth/cli/login/authorize", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const query = parseCliLoginAuthorizeQuery(request);

      let result;
      try {
        result = await options.authService.authorizeCliLogin({
          challengeId: query.challengeId,
          state: query.state,
          request,
        });
      } catch (error) {
        const htmlError = renderCliChallengeError(error);
        if (htmlError) return htmlError;
        throw error;
      }

      if (result.outcome === "throttled") {
        return new Response(
          renderCliAuthorizeLoginForm({
            challengeId: query.challengeId,
            state: query.state,
            errorMessage: `Too many attempts. Try again in ${result.retryAfterSeconds}s.`,
          }),
          {
            status: 429,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "retry-after": String(result.retryAfterSeconds),
            },
          },
        );
      }

      if (result.outcome === "login_required") {
        return new Response(
          renderCliAuthorizeLoginForm({
            challengeId: result.challengeId,
            state: result.state,
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }

      return createJsonResponse(
        {
          data: {
            redirectTo: result.location,
          },
        },
        302,
        {
          location: result.location,
          ...(result.setCookie
            ? {
                "set-cookie": result.setCookie,
              }
            : {}),
        },
      );
    }),
  );

  authApp.post?.("/api/v1/auth/cli/login/authorize", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const query = parseCliLoginAuthorizeQuery(request);
      let email: string | undefined;
      let password: string | undefined;

      const payload = (body ?? {}) as {
        email?: unknown;
        password?: unknown;
      };
      email = typeof payload.email === "string" ? payload.email : undefined;
      password =
        typeof payload.password === "string" ? payload.password : undefined;

      if (!email || !password) {
        const contentType = request.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await request.formData().catch(() => undefined);
          const formEmail = formData?.get("email");
          const formPassword = formData?.get("password");
          email = typeof formEmail === "string" ? formEmail : email;
          password = typeof formPassword === "string" ? formPassword : password;
        } else if (contentType.includes("application/json")) {
          const jsonPayload = (await request.json().catch(() => ({}))) as {
            email?: unknown;
            password?: unknown;
          };
          email =
            typeof jsonPayload.email === "string" ? jsonPayload.email : email;
          password =
            typeof jsonPayload.password === "string"
              ? jsonPayload.password
              : password;
        }
      }

      let result;
      try {
        result = await options.authService.authorizeCliLogin({
          challengeId: query.challengeId,
          state: query.state,
          email,
          password,
          request,
        });
      } catch (error) {
        const htmlError = renderCliChallengeError(error);
        if (htmlError) return htmlError;
        if (
          isRuntimeErrorLike(error) &&
          error.code === "AUTH_INVALID_CREDENTIALS"
        ) {
          return new Response(
            renderCliAuthorizeLoginForm({
              challengeId: query.challengeId,
              state: query.state,
              errorMessage: "Invalid email or password.",
            }),
            {
              status: 401,
              headers: {
                "content-type": "text/html; charset=utf-8",
              },
            },
          );
        }
        throw error;
      }

      if (result.outcome === "throttled") {
        return new Response(
          renderCliAuthorizeLoginForm({
            challengeId: query.challengeId,
            state: query.state,
            errorMessage: `Too many attempts. Try again in ${result.retryAfterSeconds}s.`,
          }),
          {
            status: 429,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "retry-after": String(result.retryAfterSeconds),
            },
          },
        );
      }

      if (result.outcome === "login_required") {
        return new Response(
          renderCliAuthorizeLoginForm({
            challengeId: result.challengeId,
            state: result.state,
          }),
          {
            status: 401,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }

      return createJsonResponse(
        {
          data: {
            redirectTo: result.location,
          },
        },
        302,
        {
          location: result.location,
          ...(result.setCookie
            ? {
                "set-cookie": result.setCookie,
              }
            : {}),
        },
      );
    }),
  );

  authApp.post?.("/api/v1/auth/cli/login/exchange", ({ request, body }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const payload = (body ?? {}) as CliLoginExchangeInput;
      const exchanged = await options.authService.exchangeCliLogin(payload);
      return {
        data: {
          key: exchanged.key,
          ...exchanged.metadata,
        },
      };
    }),
  );

  // Expose Better Auth native endpoints under /api/v1/auth/*
  authApp.post?.("/api/v1/auth/sign-up/email", ({ request }: any) =>
    options.authService.handleAuthRequest(request),
  );
  authApp.post?.("/api/v1/auth/sign-in/email", ({ request }: any) =>
    options.authService.handleAuthRequest(request),
  );
  authApp.post?.("/api/v1/auth/sign-in/sso", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () =>
      options.authService.startSsoSignIn(request),
    ),
  );
  authApp.get?.("/api/v1/auth/sso/providers", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      const providers = options.authService.listSsoProviders();
      return { data: providers };
    }),
  );
  authApp.get?.("/api/v1/auth/sso/callback/:providerId", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () =>
      options.authService.handleSsoCallback(request),
    ),
  );
  authApp.get?.("/api/v1/auth/sso/saml2/sp/metadata", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () =>
      options.authService.handleSamlMetadata(request),
    ),
  );
  authApp.post?.(
    "/api/v1/auth/sso/saml2/sp/acs/:providerId",
    ({ request }: any) =>
      executeWithRuntimeErrorsHandled(request, async () =>
        options.authService.handleSamlAcs(request),
      ),
  );
  authApp.post?.("/api/v1/auth/sign-out", ({ request }: any) =>
    executeWithRuntimeErrorsHandled(request, async () => {
      await options.authService.requireCsrfProtection(request);
      return options.authService.signOut(request);
    }),
  );
  mountSessionRoute("/api/v1/auth/get-session");
}
