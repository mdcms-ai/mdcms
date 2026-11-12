import { z } from "zod";
import {
  API_KEY_OPERATION_SCOPES,
  resolveApiKeyRbacAction,
  type ApiKeyOperationScope,
} from "../auth.js";
import { OAuthError } from "./database-store.js";

const registrationSchema = z
  .object({
    client_name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[\x20-\x7e]+$/),
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    token_endpoint_auth_method: z.literal("none"),
    grant_types: z
      .tuple([z.literal("authorization_code"), z.literal("refresh_token")])
      .optional(),
    response_types: z.tuple([z.literal("code")]).optional(),
  })
  .strict();

function redirectUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?]|$)/.test(value)
    )
      throw new Error();
    if (
      value.trim() !== value ||
      value.includes("#") ||
      value.includes("*") ||
      value.includes("\\") ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error();
    return url;
  } catch {
    throw new OAuthError("invalid_redirect_uri");
  }
}
export function parseRegistration(input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) throw new OAuthError("invalid_client_metadata");
  const value = parsed.data;
  if (new Set(value.redirect_uris).size !== value.redirect_uris.length)
    throw new OAuthError("invalid_redirect_uri");
  value.redirect_uris.forEach(redirectUrl);
  return value;
}
export function matchesRedirect(
  registered: string,
  requested: string,
): boolean {
  try {
    const left = redirectUrl(registered);
    const right = redirectUrl(requested);
    if (registered === requested) return true;
    if (
      left.protocol !== "http:" ||
      right.protocol !== "http:" ||
      left.hostname !== right.hostname
    )
      return false;
    const withoutPort = (value: string) =>
      value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::[0-9]+)?/, "$1");
    return withoutPort(registered) === withoutPort(requested);
  } catch {
    return false;
  }
}
export function parseAuthorization(params: URLSearchParams, resource: string) {
  const required = (key: string) => {
    const values = params.getAll(key);
    if (values.length !== 1 || !values[0])
      throw new OAuthError("invalid_request");
    return values[0];
  };
  if (required("response_type") !== "code")
    throw new OAuthError("unsupported_response_type");
  if (required("resource") !== resource) throw new OAuthError("invalid_target");
  if (required("code_challenge_method") !== "S256")
    throw new OAuthError("invalid_request");
  const challenge = required("code_challenge");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
    throw new OAuthError("invalid_request");
  const scopes = [...new Set(required("scope").split(" "))];
  if (
    scopes.some(
      (scope) =>
        !(API_KEY_OPERATION_SCOPES as readonly string[]).includes(scope),
    )
  )
    throw new OAuthError("invalid_scope");
  try {
    for (const scope of scopes)
      resolveApiKeyRbacAction(scope as ApiKeyOperationScope);
  } catch {
    throw new OAuthError("invalid_scope");
  }
  const redirectUri = required("redirect_uri");
  redirectUrl(redirectUri);
  return {
    clientId: required("client_id"),
    redirectUri,
    scopes,
    challenge,
    resource,
    state: required("state"),
  };
}
