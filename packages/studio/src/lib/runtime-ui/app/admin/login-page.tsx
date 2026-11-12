"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useBasePath } from "../../navigation.js";
import { Button } from "../../components/ui/button.js";
import { MDCMSLogo } from "../../components/mdcms-logo.js";
import { createLoginApi, type SsoProvider } from "../../../login-api.js";
import { clearStudioSessionToken } from "../../../studio-session-token.js";
import {
  completeStudioSignIn,
  createStudioSignInUrl,
  readStudioSignInCallback,
} from "../../lib/studio-sign-in.js";
import { useStudioSession } from "./session-context.js";
import { useStudioMountInfo } from "./mount-info-context.js";

function useReturnTo(): string {
  if (typeof window === "undefined") return "/admin";

  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get("returnTo") ?? "/admin";

  return returnTo.startsWith("/admin") ? returnTo : "/admin";
}

function stripAdminPrefix(path: string): string {
  return path.startsWith("/admin") ? path.slice("/admin".length) : path;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Sign-in failed. Try again.";
}

type LoginStatus =
  | { kind: "working"; message: string }
  | { kind: "choose" }
  | { kind: "error"; message: string };

/**
 * Studio does not collect passwords itself. It sends the browser to the MDCMS
 * server's sign-in page, which redirects back here with a one-time code that
 * is exchanged for a session (see `studio-sign-in.ts`). When SSO providers are
 * configured, the page offers them next to email sign-in.
 */
export default function LoginPage() {
  const { replace } = useRouter();
  const basePath = useBasePath();
  const sessionState = useStudioSession();
  const mountInfo = useStudioMountInfo();
  const returnTo = useReturnTo();
  const serverUrl = mountInfo.apiBaseUrl;

  const [status, setStatus] = useState<LoginStatus>({
    kind: "working",
    message: "Opening sign-in…",
  });
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([]);
  const startedRef = useRef(false);

  const resolveStudioUrl = useCallback(
    (path: string) => {
      const target = path.startsWith("/admin") ? path : "/admin";
      return basePath ? `${basePath}${stripAdminPrefix(target)}` : target;
    },
    [basePath],
  );

  const startSignIn = useCallback(async () => {
    setStatus({ kind: "working", message: "Opening sign-in…" });

    try {
      clearStudioSessionToken(serverUrl);
      const url = await createStudioSignInUrl({
        serverUrl,
        redirectUri: `${window.location.origin}${window.location.pathname}`,
        returnTo,
        storage: window.sessionStorage,
      });
      window.location.assign(url);
    } catch (error) {
      setStatus({ kind: "error", message: toErrorMessage(error) });
    }
  }, [returnTo, serverUrl]);

  useEffect(() => {
    if (sessionState.status === "authenticated") {
      replace(returnTo);
    }
  }, [sessionState.status, returnTo, replace]);

  useEffect(() => {
    if (
      startedRef.current ||
      sessionState.status === "loading" ||
      sessionState.status === "authenticated" ||
      !serverUrl
    ) {
      return;
    }

    startedRef.current = true;
    const callback = readStudioSignInCallback(window.location.search);

    if (callback.kind === "code") {
      setStatus({ kind: "working", message: "Signing in…" });
      completeStudioSignIn({
        serverUrl,
        code: callback.code,
        state: callback.state,
        storage: window.sessionStorage,
      })
        .then(({ returnTo: next }) => {
          window.location.href = resolveStudioUrl(next);
        })
        .catch((error: unknown) => {
          setStatus({ kind: "error", message: toErrorMessage(error) });
        });
      return;
    }

    void createLoginApi({ serverUrl })
      .getSsoProviders()
      .catch(() => [] as SsoProvider[])
      .then((providers) => {
        if (providers.length > 0) {
          setSsoProviders(providers);
          setStatus({ kind: "choose" });
          return;
        }

        void startSignIn();
      });
  }, [resolveStudioUrl, serverUrl, sessionState.status, startSignIn]);

  const handleSsoClick = (providerId: string) => {
    const callbackURL = resolveStudioUrl(returnTo);

    void fetch(`${serverUrl}/api/v1/auth/sign-in/sso`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId, callbackURL }),
      redirect: "manual",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => undefined);
        const redirectUrl =
          body && typeof body === "object" && typeof body.url === "string"
            ? body.url
            : null;
        if (redirectUrl) {
          window.location.href = redirectUrl;
        } else {
          setStatus({
            kind: "error",
            message:
              "SSO provider did not return a redirect. Please try again.",
          });
        }
      })
      .catch(() => {
        setStatus({
          kind: "error",
          message: "SSO sign-in failed. Please try again.",
        });
      });
  };

  if (sessionState.status === "authenticated") {
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="text-center space-y-1">
          <div className="flex justify-center mb-4">
            <MDCMSLogo collapsed={false} />
          </div>
          <p className="text-sm text-foreground-muted">
            {status.kind === "working"
              ? status.message
              : "Sign in to your workspace"}
          </p>
        </div>

        {status.kind === "error" && (
          <div className="space-y-4">
            <div
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {status.message}
            </div>
            <Button
              type="button"
              className="w-full"
              onClick={() => void startSignIn()}
            >
              Try again
            </Button>
          </div>
        )}

        {status.kind === "choose" && (
          <div className="space-y-2">
            {ssoProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => handleSsoClick(provider.id)}
              >
                Continue with {provider.name}
              </Button>
            ))}
            <Button
              type="button"
              className="w-full"
              onClick={() => void startSignIn()}
            >
              Sign in with email
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
