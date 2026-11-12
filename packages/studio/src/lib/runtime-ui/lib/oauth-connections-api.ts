import { RuntimeError, type OAuthConnection } from "@mdcms/shared";
import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "../../request-auth.js";
import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export function createOAuthConnectionsApi(
  config: { serverUrl: string; project: string },
  options: {
    auth?: StudioRuntimeAuth;
    csrfToken?: string;
    fetcher?: typeof fetch;
  } = {},
) {
  async function request(id?: string): Promise<unknown> {
    if (options.auth?.mode === "token")
      throw new Error("Sign in with a session to manage connected apps.");
    if (id !== undefined && !options.csrfToken?.trim())
      throw new Error("CSRF token missing. Sign in again.");
    const response = await (options.fetcher ?? fetch)(
      resolveStudioRelativeUrl(
        `/api/v1/oauth/connections${id === undefined ? "" : `/${encodeURIComponent(id)}`}`,
        config.serverUrl,
      ),
      applyStudioAuthToRequestInit(options.auth, {
        method: id === undefined ? "GET" : "DELETE",
        headers: {
          "x-mdcms-project": config.project,
          ...(id === undefined
            ? {}
            : { "x-mdcms-csrf-token": options.csrfToken! }),
        },
      }),
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      throw new RuntimeError({
        code: payload?.code ?? "CONNECTION_REQUEST_FAILED",
        message: payload?.message ?? "Connection request failed. Try again.",
        statusCode: response.status,
      });
    return payload?.data;
  }
  return {
    async list(): Promise<OAuthConnection[]> {
      const data = await request();
      if (
        !Array.isArray(data) ||
        !data.every(
          (row) =>
            row &&
            [
              "id",
              "clientId",
              "clientName",
              "userId",
              "project",
              "environment",
              "createdAt",
            ].every((key) => typeof row[key] === "string") &&
            Array.isArray(row.scopes) &&
            row.scopes.every((scope: unknown) => typeof scope === "string") &&
            (row.lastUsedAt === null || typeof row.lastUsedAt === "string"),
        )
      )
        throw new Error("Invalid connections response. Try again.");
      return data;
    },
    async revoke(id: string): Promise<void> {
      const data = (await request(id)) as {
        id?: unknown;
        revoked?: unknown;
      } | null;
      if (data?.id !== id || data?.revoked !== true)
        throw new Error("Revocation was not confirmed. Refresh and try again.");
    },
  };
}
