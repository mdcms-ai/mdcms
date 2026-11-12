import { MDCMS_CLIENT_HEADER } from "@mdcms/shared";

/**
 * Reports the CLI name and version to the configured MDCMS server so the
 * server can show which client made a change. Requests to other origins are
 * passed through unchanged.
 */
export function withMdcmsClientHeader(
  fetcher: typeof fetch,
  serverUrl: string,
  client: string,
): typeof fetch {
  const serverOrigin = new URL(serverUrl).origin;

  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    let origin: string;

    try {
      origin = new URL(url).origin;
    } catch {
      return fetcher(input, init);
    }

    if (origin !== serverOrigin) {
      return fetcher(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    if (!headers.has(MDCMS_CLIENT_HEADER)) {
      headers.set(MDCMS_CLIENT_HEADER, client);
    }

    return fetcher(input, { ...init, headers });
  };

  return wrapped as typeof fetch;
}
