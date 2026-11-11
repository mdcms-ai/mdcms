import { timingSafeEqual } from "node:crypto";
import { RuntimeError, parseDeclaredClient } from "@mdcms/shared";
import type { ServerRequestHandler } from "../server.js";

export type AgentDispatch = (input: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  schemaHash?: string;
}) => Promise<Response>;

export type AgentRequestContext = {
  request: Request;
  project: string;
  environment: string;
  channel: "mcp" | "studio_ai";
  declared?: string;
};

const DOMAIN_PATH =
  /^\/api\/v1\/(content|schema|media|environments|webhooks)(?:\/|$)/;

export function stripInternalHeaders(request: Request): Request {
  const headers = new Headers(request.headers);
  const keys: string[] = [];
  headers.forEach((_value, key) => keys.push(key));
  for (const key of keys) {
    if (key.startsWith("x-mdcms-internal")) headers.delete(key);
  }
  return new Request(request, { headers });
}

export function trustedInternalChannel(
  request: Request,
  secret: string,
): AgentRequestContext["channel"] | undefined {
  const supplied = request.headers.get("x-mdcms-internal");
  if (!secret || !supplied) return undefined;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return undefined;
  const channel = request.headers.get("x-mdcms-internal-channel");
  return channel === "mcp" || channel === "studio_ai" ? channel : undefined;
}

export function createInternalDispatcher(
  handler: ServerRequestHandler,
  secret: string,
  context: AgentRequestContext,
): AgentDispatch {
  return async (input) => {
    const invalid = () =>
      new RuntimeError({
        code: "INVALID_INPUT",
        message: "Invalid internal dispatch route or target.",
        statusCode: 400,
      });
    if (!DOMAIN_PATH.test(input.path) || /[?#\\\s]/.test(input.path))
      throw invalid();
    // Reject encoded delimiters and dot segments before URL normalization.
    for (const segment of input.path.split("/")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw invalid();
      }
      if (decoded === "." || decoded === ".." || /[/\\%?#]/.test(decoded))
        throw invalid();
    }
    if (
      Object.keys(input.query ?? {}).some((key) =>
        ["project", "environment"].includes(key.toLowerCase()),
      )
    )
      throw invalid();
    const url = new URL(input.path, "http://mdcms.internal");
    for (const [key, value] of Object.entries(input.query ?? {}))
      url.searchParams.set(key, value);
    const headers = new Headers();
    const authorization = context.request.headers.get("authorization");
    if (authorization) headers.set("authorization", authorization);
    else {
      for (const name of ["cookie", "x-mdcms-csrf-token"]) {
        const value = context.request.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    headers.set("x-mdcms-project", context.project);
    headers.set("x-mdcms-environment", context.environment);
    headers.set("x-mdcms-internal", secret);
    headers.set("x-mdcms-internal-channel", context.channel);
    const declared = parseDeclaredClient(context.declared);
    if (declared) headers.set("x-mdcms-client", declared);
    if (input.schemaHash !== undefined)
      headers.set("x-mdcms-schema-hash", input.schemaHash);
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined) headers.set("content-type", "application/json");
    return handler(new Request(url, { method: input.method, headers, body }));
  };
}
