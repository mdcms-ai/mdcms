import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { RuntimeError } from "@mdcms/shared";

import { createCredentialStore, type CredentialStore } from "./credentials.js";
import type { CliCommand, CliCommandContext } from "./framework.js";

export const DEFAULT_CLI_LOGIN_SCOPES = [
  "projects:read",
  "projects:write",
  "schema:read",
  "schema:write",
  "content:read",
  "content:read:draft",
  "content:write",
  "content:delete",
] as const;

type LoginOptions = {
  credentialStore?: CredentialStore;
  openBrowserUrl?: (url: string) => Promise<boolean>;
  createState?: () => string;
  createCallbackListener?: () => Promise<LoopbackCallbackListener>;
};

export type LoopbackCallbackListener = {
  redirectUri: string;
  waitForCallback: () => Promise<{ code: string; state: string }>;
  close: () => Promise<void>;
};

type LoginStartResponse = {
  challengeId: string;
  authorizeUrl: string;
  expiresAt: string;
};

type LoginExchangeResponse = {
  id: string;
  key: string;
};

function parseLoginArgs(args: string[]): { help: boolean } {
  for (const token of args) {
    if (token === "--help" || token === "-h") {
      continue;
    }

    throw new RuntimeError({
      code: "INVALID_INPUT",
      message: `Unknown login flag "${token}".`,
      statusCode: 400,
    });
  }

  return {
    help: args.includes("--help") || args.includes("-h"),
  };
}

function renderLoginHelp(): string {
  return [
    "Usage: mdcms login",
    "",
    "Authenticate through browser-based flow and store credentials",
    "for the current server/project/environment tuple.",
    "",
  ].join("\n");
}

function renderCliCallbackPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MDCMS CLI — Authentication Complete</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background: #FCF9F8;
      background-image: radial-gradient(ellipse at top left, rgba(47,73,229,0.08) 0%, transparent 60%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      max-width: 400px;
      width: 100%;
      background: #fff;
      border: 1px solid #C5C5D8;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
      padding: 2rem;
      text-align: center;
    }
    .logo {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      margin-bottom: 28px;
    }
    .logo-text {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700;
      font-size: 20px;
      color: #1C1B1B;
      letter-spacing: -0.02em;
    }
    h1 {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700;
      font-size: 22px;
      color: #1C1B1B;
      margin-bottom: 12px;
    }
    .message {
      font-size: 14px;
      font-weight: 400;
      color: #444655;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="35" height="35" viewBox="0 4 35 35" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.4954 19.8468C16.8523 19.7988 16.5695 19.8252 16.0137 20.1448C13.9577 21.3269 11.8896 22.4902 9.84301 23.6884C8.71035 24.3515 8.86327 25.4939 8.86856 26.6135L8.87323 29.049L8.86754 31.4129C8.86208 33.6365 8.87086 33.7353 10.8305 34.8569L12.7272 35.9412C13.5772 36.4271 16.0648 37.9743 16.7961 38.1227C17.4032 38.1839 17.7316 38.1169 18.2555 37.8171C20.2878 36.6538 22.3256 35.499 24.3513 34.3245C25.5248 33.644 25.3944 32.6758 25.3941 31.522L25.3915 28.8691L25.396 26.5205C25.4007 24.3233 25.3797 24.2285 23.4707 23.1348L21.5627 22.0412L19.3001 20.7437C18.7928 20.4531 18.047 19.9646 17.4954 19.8468Z" fill="#1C1B1B"/>
        <path d="M26.4326 4.08956C25.8135 4.03531 25.4981 4.07102 24.9624 4.38156C23.0193 5.50784 21.084 6.64735 19.1433 7.77787C18.6139 8.08624 18.1508 8.4779 18.0124 9.10786C17.8664 9.77215 17.9212 10.5397 17.9239 11.2234L17.9247 13.6338L17.921 15.6797C17.9197 16.4984 17.8187 17.4363 18.3987 18.0931C18.766 18.509 19.2648 18.7439 19.7366 19.0229C20.2456 19.3238 20.7602 19.6176 21.2709 19.9157L23.6489 21.307C24.1935 21.6256 25.092 22.2074 25.6525 22.359C26.5274 22.4342 26.7078 22.3363 27.436 21.9116L31.5337 19.5176C31.9048 19.301 33.2517 18.5452 33.5247 18.301C33.809 18.0485 34.0095 17.7153 34.0996 17.3458C34.2306 16.8302 34.1905 15.8811 34.1881 15.3182L34.1869 12.9892L34.1909 10.8318C34.1941 8.63869 34.2067 8.49732 32.3014 7.38407L30.5377 6.35429L28.3471 5.07312C27.8022 4.75331 27.0227 4.23424 26.4326 4.08956Z" fill="#CAF240"/>
        <path d="M8.58217 4.09055C7.9301 4.03424 7.61858 4.07788 7.05481 4.40779C5.09063 5.5562 3.12254 6.6993 1.1626 7.85475C0.628794 8.16937 0.310829 8.51792 0.146414 9.13369C0.101146 9.30918 0.0754332 9.48911 0.0692766 9.67022C0.0174895 10.8607 0.0739828 12.4295 0.0721723 13.6712L0.0681892 15.7221C0.062757 17.8453 0.0895542 17.9803 1.90428 19.0366L3.63425 20.0439L5.9733 21.413C6.50528 21.7242 7.23024 22.2109 7.80661 22.3603C8.5945 22.4512 8.87405 22.3186 9.52562 21.9424L13.5603 19.5843C14.0662 19.2898 14.6172 18.9422 15.1248 18.67C16.5527 17.9041 16.3376 16.7588 16.3309 15.3383L16.3291 13.0458L16.3337 10.8074C16.3349 10.0947 16.4178 9.24654 16.0423 8.6199C15.9028 8.38554 15.7166 8.18226 15.4955 8.02259C15.2008 7.8081 14.7526 7.56378 14.4259 7.37299L12.6291 6.32531C11.4588 5.64323 10.2823 4.93464 9.099 4.27731C8.93579 4.18663 8.763 4.13495 8.58217 4.09055Z" fill="#2F49E5"/>
      </svg>
      <span class="logo-text">MDCMS</span>
    </div>
    <h1>You're all set</h1>
    <p class="message">Authentication complete. You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;
}

export function createLoopbackCallbackListener(): Promise<LoopbackCallbackListener> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finalize = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      handler();
    };

    const callbackPromise = new Promise<{ code: string; state: string }>(
      (resolveCallback, rejectCallback) => {
        timeout = setTimeout(
          () => {
            finalize(() => {
              rejectCallback(
                new RuntimeError({
                  code: "LOGIN_TIMEOUT",
                  message:
                    "Timed out waiting for browser callback. Please retry `mdcms login`.",
                  statusCode: 408,
                }),
              );
            });
          },
          2 * 60 * 1000,
        );

        server.on("request", (request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");

          if (url.pathname !== "/callback") {
            response.statusCode = 404;
            response.end("Not Found");
            return;
          }

          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) {
            response.statusCode = 400;
            response.end("Missing code/state query params.");
            return;
          }

          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderCliCallbackPage());

          finalize(() => {
            resolveCallback({ code, state });
          });
        });
      },
    );

    server.once("error", (error) => {
      finalize(() => {
        reject(
          new RuntimeError({
            code: "INTERNAL_ERROR",
            message: "Failed to start loopback callback listener.",
            statusCode: 500,
            details:
              error instanceof Error ? { cause: error.message } : undefined,
          }),
        );
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finalize(() => {
          reject(
            new RuntimeError({
              code: "INTERNAL_ERROR",
              message: "Failed to resolve loopback callback listener address.",
              statusCode: 500,
            }),
          );
        });
        return;
      }

      const listener: LoopbackCallbackListener = {
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        waitForCallback: () => callbackPromise,
        close: async () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      };

      resolve(listener);
    });
  });
}

/**
 * Command that opens `url` in the default browser on `platform`. On Windows
 * the URL passes through `cmd`, where `&` separates commands, so it is escaped
 * as `^&`.
 */
export function resolveBrowserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", url.replace(/&/g, "^&")],
    };
  }

  return { command: "xdg-open", args: [url] };
}

export async function openBrowserUrl(url: string): Promise<boolean> {
  try {
    const { command, args } = resolveBrowserOpenCommand(process.platform, url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseStartResponse(payload: unknown): LoginStartResponse {
  const body = payload as {
    data?: {
      challengeId?: unknown;
      authorizeUrl?: unknown;
      expiresAt?: unknown;
    };
  };

  if (
    !body?.data ||
    typeof body.data.challengeId !== "string" ||
    typeof body.data.authorizeUrl !== "string" ||
    typeof body.data.expiresAt !== "string"
  ) {
    throw new RuntimeError({
      code: "REMOTE_ERROR",
      message: "Login start response payload is invalid.",
      statusCode: 502,
    });
  }

  return {
    challengeId: body.data.challengeId,
    authorizeUrl: body.data.authorizeUrl,
    expiresAt: body.data.expiresAt,
  };
}

function parseExchangeResponse(payload: unknown): LoginExchangeResponse {
  const body = payload as {
    data?: {
      id?: unknown;
      key?: unknown;
    };
  };

  if (
    !body?.data ||
    typeof body.data.id !== "string" ||
    typeof body.data.key !== "string"
  ) {
    throw new RuntimeError({
      code: "REMOTE_ERROR",
      message: "Login exchange response payload is invalid.",
      statusCode: 502,
    });
  }

  return {
    id: body.data.id,
    key: body.data.key,
  };
}

function throwRemoteError(
  responseStatus: number,
  payload: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): never {
  const body = payload as { code?: unknown; message?: unknown };
  throw new RuntimeError({
    code: typeof body?.code === "string" ? body.code : fallbackCode,
    message: typeof body?.message === "string" ? body.message : fallbackMessage,
    statusCode: responseStatus,
  });
}

export type OAuthFlowParams = {
  serverUrl: string;
  project: string;
  environment: string;
  fetcher: typeof fetch;
  /** Receives the sign-in URL so callers can print it for manual use. */
  onBrowserOpened?: (authorizeUrl: string) => void;
  onBrowserFailed?: (authorizeUrl: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
  createState?: () => string;
  createListener?: () => Promise<LoopbackCallbackListener>;
};

export async function performCliOAuthFlow(
  params: OAuthFlowParams,
): Promise<LoginExchangeResponse> {
  const openUrl = params.openUrl ?? openBrowserUrl;
  const createState =
    params.createState ??
    (() => `state_${randomBytes(18).toString("base64url")}_${Date.now()}`);
  const createListener =
    params.createListener ?? createLoopbackCallbackListener;

  const listener = await createListener();
  const state = createState();

  try {
    const startResponse = await params.fetcher(
      `${params.serverUrl}/api/v1/auth/cli/login/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirectUri: listener.redirectUri,
          state,
          project: params.project,
          environment: params.environment,
          scopes: [...DEFAULT_CLI_LOGIN_SCOPES],
        }),
      },
    );
    const startBody = await startResponse.json().catch(() => undefined);

    if (!startResponse.ok) {
      throwRemoteError(
        startResponse.status,
        startBody,
        "REMOTE_ERROR",
        "Failed to start CLI login flow.",
      );
    }

    const start = parseStartResponse(startBody);
    const browserOpened = await openUrl(start.authorizeUrl);

    if (browserOpened) {
      params.onBrowserOpened?.(start.authorizeUrl);
    } else {
      params.onBrowserFailed?.(start.authorizeUrl);
    }

    const callback = await listener.waitForCallback();
    if (callback.state !== state) {
      throw new RuntimeError({
        code: "INVALID_LOGIN_EXCHANGE",
        message: "Browser callback state does not match login request state.",
        statusCode: 400,
      });
    }

    const exchangeResponse = await params.fetcher(
      `${params.serverUrl}/api/v1/auth/cli/login/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: start.challengeId,
          state,
          code: callback.code,
        }),
      },
    );
    const exchangeBody = await exchangeResponse.json().catch(() => undefined);

    if (!exchangeResponse.ok) {
      throwRemoteError(
        exchangeResponse.status,
        exchangeBody,
        "REMOTE_ERROR",
        "Failed to exchange CLI login code.",
      );
    }

    return parseExchangeResponse(exchangeBody);
  } finally {
    await listener.close();
  }
}

export function createLoginCommand(options: LoginOptions = {}): CliCommand {
  return {
    name: "login",
    description: "Authenticate via browser flow and store scoped credentials",
    requiresTarget: true,
    requiresConfig: true,
    run: async (context: CliCommandContext): Promise<number> => {
      const store =
        options.credentialStore ??
        createCredentialStore({
          env: context.env,
        });
      const parsed = parseLoginArgs(context.args);
      if (parsed.help) {
        context.stdout.write(`${renderLoginHelp()}\n`);
        return 0;
      }

      const exchanged = await performCliOAuthFlow({
        serverUrl: context.serverUrl,
        project: context.project,
        environment: context.environment,
        fetcher: context.fetcher,
        openUrl: options.openBrowserUrl,
        createState: options.createState,
        createListener: options.createCallbackListener,
        onBrowserOpened: (url) => {
          context.stdout.write(
            `Browser login started. Complete authentication in your browser.\nIf the browser did not open or shows an error, open this URL:\n${url}\n`,
          );
        },
        onBrowserFailed: (url) => {
          context.stdout.write(
            `Could not open browser automatically. Open this URL manually:\n${url}\n`,
          );
        },
      });

      const projectsResponse = await context.fetcher(
        `${context.serverUrl}/api/v1/projects`,
        {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${exchanged.key}`,
            "x-mdcms-project": context.project,
            "x-mdcms-environment": context.environment,
          },
        },
      );
      if (projectsResponse.ok) {
        const projectsBody = (await projectsResponse.json()) as {
          data: Array<{ slug: string }>;
        };
        const exists = projectsBody.data.some(
          (p) => p.slug === context.project,
        );
        if (!exists) {
          await context
            .fetcher(`${context.serverUrl}/api/v1/auth/api-keys/self/revoke`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${exchanged.key}`,
              },
            })
            .catch(() => undefined);
          context.stderr.write(
            `Project "${context.project}" does not exist on ${context.serverUrl}. Run "cms init" to create it.\n`,
          );
          return 1;
        }
      }

      const nowIso = new Date().toISOString();

      await store.setProfile(
        {
          serverUrl: context.serverUrl,
          project: context.project,
          environment: context.environment,
        },
        {
          authMode: "api_key",
          apiKey: exchanged.key,
          apiKeyId: exchanged.id,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      );

      context.stdout.write(
        `Login successful for ${context.project}/${context.environment}. Credentials stored.\n`,
      );
      context.stdout.write(
        `MDCMS_DEMO_API_KEY="${exchanged.key}" (use this value for demo app requests if needed).\n`,
      );

      return 0;
    },
  };
}
