"use client";

import { useReducer, useEffect } from "react";
import { useRouter, useBasePath } from "../../navigation.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { MDCMSLogo } from "../../components/mdcms-logo.js";
import { createLoginApi, type SsoProvider } from "../../../login-api.js";
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

const EMPTY_SSO_PROVIDERS: SsoProvider[] = [];

type LoginState = {
  email: string;
  password: string;
  submitting: boolean;
  error: string | null;
  sso: { status: "loading" } | { status: "ready"; providers: SsoProvider[] };
};

type LoginAction =
  | { type: "email-change"; value: string }
  | { type: "password-change"; value: string }
  | { type: "submit-start" }
  | { type: "submit-error"; message: string }
  | { type: "sso-ready"; providers: SsoProvider[] };

const initialLoginState: LoginState = {
  email: "",
  password: "",
  submitting: false,
  error: null,
  sso: { status: "loading" },
};

function loginReducer(state: LoginState, action: LoginAction): LoginState {
  switch (action.type) {
    case "email-change":
      return { ...state, email: action.value };
    case "password-change":
      return { ...state, password: action.value };
    case "submit-start":
      return { ...state, submitting: true, error: null };
    case "submit-error":
      return { ...state, submitting: false, error: action.message };
    case "sso-ready":
      return {
        ...state,
        sso: { status: "ready", providers: action.providers },
      };
  }
}

export default function LoginPage() {
  const { replace } = useRouter();
  const basePath = useBasePath();
  const sessionState = useStudioSession();
  const mountInfo = useStudioMountInfo();
  const returnTo = useReturnTo();

  const [state, dispatch] = useReducer(loginReducer, initialLoginState);
  const { email, password, submitting, error } = state;
  const ssoProviders =
    state.sso.status === "ready" ? state.sso.providers : EMPTY_SSO_PROVIDERS;
  const ssoLoading = state.sso.status === "loading";

  useEffect(() => {
    if (sessionState.status === "authenticated") {
      replace(returnTo);
    }
  }, [sessionState.status, returnTo, replace]);

  useEffect(() => {
    if (!mountInfo.apiBaseUrl) {
      dispatch({ type: "sso-ready", providers: EMPTY_SSO_PROVIDERS });
      return;
    }

    let cancelled = false;
    const api = createLoginApi({ serverUrl: mountInfo.apiBaseUrl });

    void api
      .getSsoProviders()
      .then((providers) => {
        if (!cancelled) {
          dispatch({ type: "sso-ready", providers });
        }
      })
      .catch(() => {
        if (!cancelled) {
          dispatch({ type: "sso-ready", providers: EMPTY_SSO_PROVIDERS });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [mountInfo.apiBaseUrl]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    dispatch({ type: "submit-start" });

    const api = createLoginApi({ serverUrl: mountInfo.apiBaseUrl });
    const result = await api.login(email, password);

    switch (result.outcome) {
      case "success":
        window.location.href = basePath
          ? `${basePath}${stripAdminPrefix(returnTo)}`
          : returnTo;
        return;
      case "invalid_credentials":
        dispatch({
          type: "submit-error",
          message: "Invalid email or password.",
        });
        break;
      case "throttled":
        dispatch({
          type: "submit-error",
          message: `Too many attempts. Try again in ${result.retryAfterSeconds}s.`,
        });
        break;
      case "error":
        dispatch({ type: "submit-error", message: result.message });
        break;
    }
  };

  const handleSsoClick = (providerId: string) => {
    const callbackURL = basePath
      ? `${basePath}${stripAdminPrefix(returnTo)}`
      : returnTo;

    void fetch(`${mountInfo.apiBaseUrl}/api/v1/auth/sign-in/sso`, {
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
          dispatch({
            type: "submit-error",
            message:
              "SSO provider did not return a redirect. Please try again.",
          });
        }
      })
      .catch(() => {
        dispatch({
          type: "submit-error",
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
            Sign in to your workspace
          </p>
        </div>

        {!ssoLoading && ssoProviders.length > 0 && (
          <>
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
            </div>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-foreground-muted uppercase">
                or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label
              htmlFor="login-email"
              className="text-sm font-medium text-foreground"
            >
              Email
            </label>
            <Input
              id="login-email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) =>
                dispatch({ type: "email-change", value: e.target.value })
              }
              required
              autoComplete="email"
            />
          </div>

          <div className="space-y-2">
            <label
              htmlFor="login-password"
              className="text-sm font-medium text-foreground"
            >
              Password
            </label>
            <Input
              id="login-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) =>
                dispatch({ type: "password-change", value: e.target.value })
              }
              required
              autoComplete="current-password"
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !email || !password}
          >
            {submitting ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
