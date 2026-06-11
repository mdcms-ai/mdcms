import { createHash, createHmac } from "node:crypto";

import { RuntimeError } from "@mdcms/shared";

import type { MediaObjectStore } from "./types.js";

export type CreateMediaObjectKeyInput = {
  project: string;
  mediaId: string;
  filename: string;
};

export type CreateS3CompatibleMediaObjectStoreOptions = {
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  bucket?: string;
  publicBaseUrl?: string;
  region?: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

const SERVICE = "s3";
const DEFAULT_REGION = "us-east-1";
const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function createStorageUnavailableError(
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_STORAGE_UNAVAILABLE",
    message: "Media object storage is not configured.",
    statusCode: 503,
    details,
  });
}

function createObjectWriteFailedError(
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_OBJECT_WRITE_FAILED",
    message: "Failed to write media object.",
    statusCode: 502,
    details,
  });
}

function createObjectDeleteFailedError(
  details: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError({
    code: "MEDIA_OBJECT_DELETE_FAILED",
    message: "Failed to delete media object.",
    statusCode: 502,
    details,
  });
}

function requireNonBlank(
  name: string,
  value: string | undefined,
  missing: string[],
): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    missing.push(name);
    return "";
  }

  return trimmed;
}

function normalizeBaseUrl(raw: string, field: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw createStorageUnavailableError({
      field,
      reason: "invalid_url",
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw createStorageUnavailableError({
      field,
      reason: "invalid_protocol",
    });
  }

  if (
    url.search.length > 0 ||
    url.hash.length > 0 ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw createStorageUnavailableError({
      field,
      reason: "query_or_hash_not_supported",
    });
  }

  if (url.pathname === "/") {
    return url.origin;
  }

  return url.toString().replace(/\/+$/, "");
}

function normalizePublicBaseUrl(raw: string): string {
  const url = new URL(normalizeBaseUrl(raw, "publicBaseUrl"));

  if (url.pathname === "/") {
    return url.toString();
  }

  return url.toString().replace(/\/+$/, "");
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePathSegment(segment: string): string {
  try {
    return awsUriEncode(decodeURIComponent(segment));
  } catch {
    return awsUriEncode(segment);
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodePathSegment)
    .join("/");
}

function joinUrlPath(baseUrl: string, ...parts: string[]): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = parts.map(encodePath).filter(Boolean).join("/");

  if (!suffix) {
    return baseUrl;
  }

  return `${base}/${suffix}`;
}

function filenameBasename(filename: string): string {
  const basename = filename
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .at(-1);

  return basename ?? "upload.bin";
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function bytesAsBodyInit(input: Uint8Array): BodyInit {
  return input as unknown as BodyInit;
}

function hmacSha256(key: string | Buffer, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

function formatAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/\.\d{3}/, "");
}

function formatDateStamp(date: Date): string {
  return formatAmzDate(date).slice(0, 8);
}

function canonicalQueryString(url: URL): string {
  return Array.from(url.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue);
      }

      return leftKey.localeCompare(rightKey);
    })
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join("&");
}

function signingKey(
  secretKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const dateKey = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, SERVICE);
  return hmacSha256(serviceKey, "aws4_request");
}

function signRequest(input: {
  method: string;
  url: URL;
  accessKey: string;
  secretKey: string;
  region: string;
  now: Date;
  payloadHash: string;
  headers: Record<string, string>;
}): string {
  const dateStamp = formatDateStamp(input.now);
  const amzDate = formatAmzDate(input.now);
  const credentialScope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;
  const headerNames = Object.keys(input.headers).sort();
  const canonicalHeaders = headerNames
    .map(
      (name) => `${name}:${input.headers[name]?.trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalQueryString(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.secretKey, dateStamp, input.region),
  )
    .update(stringToSign)
    .digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

export function createMediaObjectKey(input: CreateMediaObjectKeyInput): string {
  const basename = filenameBasename(input.filename);

  return [
    "projects",
    awsUriEncode(input.project),
    "media",
    awsUriEncode(input.mediaId),
    awsUriEncode(basename),
  ].join("/");
}

export function createS3CompatibleMediaObjectStore(
  options: CreateS3CompatibleMediaObjectStoreOptions,
): MediaObjectStore {
  const missing: string[] = [];
  const endpoint = requireNonBlank("endpoint", options.endpoint, missing);
  const accessKey = requireNonBlank("accessKey", options.accessKey, missing);
  const secretKey = requireNonBlank("secretKey", options.secretKey, missing);
  const bucket = requireNonBlank("bucket", options.bucket, missing);

  if (missing.length > 0) {
    throw createStorageUnavailableError({ missing });
  }

  const normalizedEndpoint = normalizeBaseUrl(endpoint, "endpoint");
  const normalizedPublicBaseUrl = options.publicBaseUrl
    ? normalizePublicBaseUrl(options.publicBaseUrl)
    : undefined;
  const region = options.region?.trim() || DEFAULT_REGION;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  function objectUrlForKey(key: string): string {
    return joinUrlPath(normalizedEndpoint, bucket, key);
  }

  function publicUrlForKey(key: string): string {
    if (normalizedPublicBaseUrl) {
      return joinUrlPath(normalizedPublicBaseUrl, key);
    }

    return objectUrlForKey(key);
  }

  async function signedFetch(input: {
    method: "PUT" | "DELETE";
    key: string;
    payload: Uint8Array;
    contentType?: string;
  }): Promise<Response> {
    const url = new URL(objectUrlForKey(input.key));
    const requestDate = now();
    const amzDate = formatAmzDate(requestDate);
    const payloadHash =
      input.payload.byteLength === 0
        ? EMPTY_BODY_SHA256
        : sha256Hex(input.payload);
    const signedHeaders: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };

    if (input.contentType) {
      signedHeaders["content-type"] = input.contentType;
    }

    const headers = new Headers(signedHeaders);
    headers.set(
      "authorization",
      signRequest({
        method: input.method,
        url,
        accessKey,
        secretKey,
        region,
        now: requestDate,
        payloadHash,
        headers: signedHeaders,
      }),
    );

    return fetcher(url.toString(), {
      method: input.method,
      headers,
      body: input.method === "PUT" ? bytesAsBodyInit(input.payload) : undefined,
    });
  }

  return {
    async putObject(input) {
      let response: Response;

      try {
        response = await signedFetch({
          method: "PUT",
          key: input.key,
          payload: input.body,
          contentType: input.contentType,
        });
      } catch (error) {
        throw createObjectWriteFailedError({
          key: input.key,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      if (!response.ok) {
        throw createObjectWriteFailedError({
          key: input.key,
          status: response.status,
          statusText: response.statusText,
        });
      }
    },

    async deleteObject(input) {
      let response: Response;

      try {
        response = await signedFetch({
          method: "DELETE",
          key: input.key,
          payload: new Uint8Array(),
        });
      } catch (error) {
        throw createObjectDeleteFailedError({
          key: input.key,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      if (response.status === 404) {
        return;
      }

      if (!response.ok) {
        throw createObjectDeleteFailedError({
          key: input.key,
          status: response.status,
          statusText: response.statusText,
        });
      }
    },

    publicUrlForKey,
  };
}
