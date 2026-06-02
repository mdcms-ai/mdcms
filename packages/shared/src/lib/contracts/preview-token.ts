export const MDCMS_PREVIEW_TOKEN_QUERY_PARAM = "mdcms_preview_token";
export const MDCMS_PREVIEW_TOKEN_ISSUER = "mdcms";
export const MDCMS_PREVIEW_TOKEN_AUDIENCE = "mdcms-preview";
export const DEFAULT_MDCMS_PREVIEW_TOKEN_TTL_SECONDS = 5 * 60;

type JwtHeader = {
  alg: "HS256";
  typ: "JWT";
};

export type ContentPreviewTokenRequest = {
  previewUrl?: string;
};

export type ContentPreviewTokenResponse = {
  token: string;
  expiresAt: string;
};

export type MdcmsPreviewTokenMintClaims = {
  project: string;
  environment: string;
  documentId: string;
  type: string;
  path: string;
  locale: string;
  draftRevision: number;
  previewUrl?: string;
};

export type MdcmsPreviewTokenClaims = MdcmsPreviewTokenMintClaims & {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
};

export type MdcmsPreviewVerificationFailureReason =
  | "missing"
  | "malformed"
  | "expired"
  | "invalid_signature"
  | "invalid_claim";

export type MdcmsPreviewVerificationResult =
  | {
      ok: true;
      claims: MdcmsPreviewTokenClaims;
    }
  | {
      ok: false;
      reason: MdcmsPreviewVerificationFailureReason;
    };

export type MdcmsPreviewTokenExpectedClaims = Partial<
  Pick<
    MdcmsPreviewTokenClaims,
    | "project"
    | "environment"
    | "documentId"
    | "type"
    | "path"
    | "locale"
    | "draftRevision"
    | "previewUrl"
  >
>;

export type SignMdcmsPreviewTokenInput = {
  secret: string;
  claims: MdcmsPreviewTokenMintClaims;
  now?: Date;
  ttlSeconds?: number;
  issuer?: string;
  audience?: string;
};

export type VerifyMdcmsPreviewTokenInput = {
  secret: string;
  now?: Date;
  issuer?: string;
  audience?: string;
  expected?: MdcmsPreviewTokenExpectedClaims;
};

type PreviewTokenCryptoKey = unknown;

type PreviewTokenSubtleCrypto = {
  importKey: (
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: false,
    keyUsages: string[],
  ) => Promise<PreviewTokenCryptoKey>;
  sign: (
    algorithm: "HMAC",
    key: PreviewTokenCryptoKey,
    data: Uint8Array,
  ) => Promise<ArrayBuffer>;
  verify: (
    algorithm: "HMAC",
    key: PreviewTokenCryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ) => Promise<boolean>;
};

function getSubtleCrypto(): PreviewTokenSubtleCrypto {
  const subtle = globalThis.crypto?.subtle as
    | PreviewTokenSubtleCrypto
    | undefined;

  if (!subtle) {
    throw new Error("Web Crypto subtle API is required for preview tokens.");
  }

  return subtle;
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeBase64(padded);
}

function encodeJsonBase64Url(value: unknown): string {
  return encodeBase64Url(encodeUtf8(JSON.stringify(value)));
}

function decodeJsonBase64Url(value: string): unknown {
  const bytes = decodeBase64Url(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<PreviewTokenCryptoKey> {
  return getSubtleCrypto().importKey(
    "raw",
    encodeUtf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function signHmac(input: string, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret, "sign");
  const signature = await getSubtleCrypto().sign(
    "HMAC",
    key,
    encodeUtf8(input),
  );
  return new Uint8Array(signature);
}

async function verifyHmac(
  input: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  const key = await importHmacKey(secret, "verify");
  return getSubtleCrypto().verify("HMAC", key, signature, encodeUtf8(input));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPreviewTokenClaims(
  value: unknown,
): value is MdcmsPreviewTokenClaims {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.iss) &&
    isNonEmptyString(value.aud) &&
    isNonEmptyString(value.sub) &&
    isNonEmptyString(value.project) &&
    isNonEmptyString(value.environment) &&
    isNonEmptyString(value.documentId) &&
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.locale) &&
    typeof value.draftRevision === "number" &&
    Number.isInteger(value.draftRevision) &&
    value.draftRevision >= 0 &&
    (value.previewUrl === undefined || isNonEmptyString(value.previewUrl)) &&
    typeof value.iat === "number" &&
    Number.isInteger(value.iat) &&
    typeof value.exp === "number" &&
    Number.isInteger(value.exp)
  );
}

function claimsMatchExpected(
  claims: MdcmsPreviewTokenClaims,
  expected: MdcmsPreviewTokenExpectedClaims | undefined,
): boolean {
  if (!expected) {
    return true;
  }

  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && claims[key as keyof typeof expected] !== value) {
      return false;
    }
  }

  return true;
}

export async function signMdcmsPreviewToken(
  input: SignMdcmsPreviewTokenInput,
): Promise<ContentPreviewTokenResponse> {
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ttlSeconds =
    input.ttlSeconds ?? DEFAULT_MDCMS_PREVIEW_TOKEN_TTL_SECONDS;
  const expiresAt = new Date((nowSeconds + ttlSeconds) * 1000);
  const header: JwtHeader = {
    alg: "HS256",
    typ: "JWT",
  };
  const claims: MdcmsPreviewTokenClaims = {
    iss: input.issuer ?? MDCMS_PREVIEW_TOKEN_ISSUER,
    aud: input.audience ?? MDCMS_PREVIEW_TOKEN_AUDIENCE,
    sub: input.claims.documentId,
    ...input.claims,
    iat: nowSeconds,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const signingInput = `${encodeJsonBase64Url(header)}.${encodeJsonBase64Url(
    claims,
  )}`;
  const signature = await signHmac(signingInput, input.secret);

  return {
    token: `${signingInput}.${encodeBase64Url(signature)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyMdcmsPreviewToken(
  token: string | undefined,
  input: VerifyMdcmsPreviewTokenInput,
): Promise<MdcmsPreviewVerificationResult> {
  if (!token || token.trim().length === 0) {
    return { ok: false, reason: "missing" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let header: unknown;
  let payload: unknown;
  let signature: Uint8Array;

  try {
    header = decodeJsonBase64Url(encodedHeader);
    payload = decodeJsonBase64Url(encodedPayload);
    signature = decodeBase64Url(encodedSignature);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT") {
    return { ok: false, reason: "malformed" };
  }

  if (!(await verifyHmac(signingInput, signature, input.secret))) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (!isPreviewTokenClaims(payload)) {
    return { ok: false, reason: "invalid_claim" };
  }

  const issuer = input.issuer ?? MDCMS_PREVIEW_TOKEN_ISSUER;
  const audience = input.audience ?? MDCMS_PREVIEW_TOKEN_AUDIENCE;
  if (
    payload.iss !== issuer ||
    payload.aud !== audience ||
    payload.sub !== payload.documentId
  ) {
    return { ok: false, reason: "invalid_claim" };
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (payload.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }

  if (!claimsMatchExpected(payload, input.expected)) {
    return { ok: false, reason: "invalid_claim" };
  }

  return { ok: true, claims: payload };
}

export function appendMdcmsPreviewTokenToUrl(
  href: string,
  token: string,
): string {
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//iu.test(href);
  const url = new URL(href, "http://mdcms.local");
  url.searchParams.set(MDCMS_PREVIEW_TOKEN_QUERY_PARAM, token);

  return isAbsolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

export function readMdcmsPreviewTokenFromUrl(url: URL): string | undefined {
  const value = url.searchParams.get(MDCMS_PREVIEW_TOKEN_QUERY_PARAM)?.trim();
  return value && value.length > 0 ? value : undefined;
}
