"use client";

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from "react";

import { type HostBridgeV1, type StudioMountContext } from "@mdcms/shared";

import {
  loadStudioRuntime,
  type MdcmsConfig,
  type StudioLoaderOptions,
} from "./studio-loader.js";
import { readStoredThemePreference } from "./runtime-ui/adapters/next-themes-state.js";
import {
  LOADING_SUMMARY,
  LOADING_TITLE,
  READY_CONTAINER_STYLE,
  SHELL_THEME_INLINE_SCRIPT,
  STUDIO_SHELL_STYLES,
  describeStudioStartupError,
  resolveShellAppliedTheme,
  type ShellAppliedTheme,
} from "./studio-shell-state.js";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export type { MdcmsConfig } from "./studio-loader.js";

export type StudioStartupState = "loading" | "ready" | "error";

type StudioStartupViewState =
  | { status: "loading"; error?: undefined }
  | { status: "ready"; error?: undefined }
  | { status: "error"; error: unknown };

type StudioStartupAction =
  | { type: "loading" }
  | { type: "ready" }
  | { type: "error"; error: unknown };

function studioStartupReducer(
  _state: StudioStartupViewState,
  action: StudioStartupAction,
): StudioStartupViewState {
  switch (action.type) {
    case "loading":
      return { status: "loading" };
    case "ready":
      return { status: "ready" };
    case "error":
      return { status: "error", error: action.error };
  }
}

export type StudioProps = {
  config: MdcmsConfig;
  basePath: string;
  auth?: StudioMountContext["auth"];
  hostBridge?: HostBridgeV1;
  fetcher?: StudioLoaderOptions["fetcher"];
  loadRemoteModule?: StudioLoaderOptions["loadRemoteModule"];
};

export type StudioShellFrameProps = {
  config: MdcmsConfig;
  basePath: string;
  startupState: StudioStartupState;
  startupError?: unknown;
  containerRef?: RefObject<HTMLDivElement | null>;
  shellTheme?: ShellAppliedTheme;
};

function useResolvedShellTheme(): ShellAppliedTheme {
  const [applied, setApplied] = useState<ShellAppliedTheme>("light");

  useIsomorphicLayoutEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const storage = window.localStorage ?? null;

    const recompute = () => {
      const stored = readStoredThemePreference(storage);
      setApplied((prev) => {
        const next = resolveShellAppliedTheme({
          storedThemeRaw: stored,
          systemPrefersDark: mediaQuery.matches,
        });
        return prev === next ? prev : next;
      });
    };

    recompute();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", recompute);
      return () => {
        mediaQuery.removeEventListener("change", recompute);
      };
    }

    mediaQuery.addListener(recompute);
    return () => {
      mediaQuery.removeListener(recompute);
    };
  }, []);

  return applied;
}

export function StudioShellFrame({
  config,
  basePath,
  startupState,
  startupError,
  containerRef,
  shellTheme = "light",
}: StudioShellFrameProps) {
  const describedError =
    startupState === "error"
      ? describeStudioStartupError(startupError)
      : undefined;
  const shellThemeScriptProps = {
    dangerouslySetInnerHTML: { __html: SHELL_THEME_INLINE_SCRIPT },
  };

  return (
    <div
      data-testid="mdcms-studio-root"
      data-mdcms-project={config.project}
      data-mdcms-server-url={config.serverUrl}
      data-mdcms-base-path={basePath}
      data-mdcms-state={startupState}
      data-mdcms-brand="MDCMS"
      data-mdcms-theme={shellTheme}
      className={startupState === "ready" ? undefined : "mdcms-studio-shell"}
      suppressHydrationWarning
    >
      {/* SHELL_THEME_INLINE_SCRIPT is a hardcoded module constant: it reads
       * the dark/light preference from window.localStorage and applies the
       * theme attribute before the runtime hydrates, preventing FOUC. The
       * payload contains no user input and never touches network data. */}
      {/* react-doctor-disable-next-line react-doctor/nextjs-no-native-script -- this framework-agnostic package cannot depend on Next's Script component, and this must run before hydration. */}
      <script {...shellThemeScriptProps} />
      <div
        ref={containerRef}
        data-mdcms-runtime-container="true"
        hidden={startupState !== "ready"}
        style={startupState === "ready" ? READY_CONTAINER_STYLE : undefined}
      />

      {startupState !== "ready" ? (
        <>
          <style>{STUDIO_SHELL_STYLES}</style>
          <div aria-hidden="true" className="mdcms-studio-shell__backdrop" />
          <section className="mdcms-studio-shell__frame">
            <div className="mdcms-studio-shell__panel">
              <header className="mdcms-studio-shell__header">
                <div className="mdcms-studio-shell__brand-group">
                  <svg
                    className="mdcms-studio-shell__brand-logo"
                    viewBox="0 4 35 35"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <mask
                      id="mdcms-shell-logo-m"
                      style={{ maskType: "luminance" }}
                      maskUnits="userSpaceOnUse"
                      x="0"
                      y="4"
                      width="35"
                      height="35"
                    >
                      <path d="M0 4.01H34.33V38.2H0V4.01Z" fill="white" />
                    </mask>
                    <g mask="url(#mdcms-shell-logo-m)">
                      <path
                        d="M17.5 19.85C16.85 19.8 16.57 19.83 16.01 20.14C13.96 21.33 11.89 22.49 9.84 23.69C8.71 24.35 8.86 25.49 8.87 26.61L8.87 29.05L8.87 31.41C8.86 33.64 8.87 33.74 10.83 34.86L12.73 35.94C13.58 36.43 16.06 37.97 16.8 38.12C17.4 38.18 17.73 38.12 18.26 37.82C20.29 36.65 22.33 35.5 24.35 34.32C25.52 33.64 25.39 32.68 25.39 31.52L25.39 28.87L25.4 26.52C25.4 24.32 25.38 24.23 23.47 23.13L21.56 22.04L19.3 20.74C18.79 20.45 18.05 19.96 17.5 19.85Z"
                        fill="currentColor"
                      />
                      <path
                        d="M26.43 4.09C25.81 4.04 25.5 4.07 24.96 4.38C23.02 5.51 21.08 6.65 19.14 7.78C18.61 8.09 18.15 8.48 18.01 9.11C17.87 9.77 17.92 10.54 17.92 11.22L17.92 13.63L17.92 15.68C17.92 16.5 17.82 17.44 18.4 18.09C18.77 18.51 19.26 18.74 19.74 19.02C20.25 19.32 20.76 19.62 21.27 19.92L23.65 21.31C24.19 21.63 25.09 22.21 25.65 22.36C26.53 22.43 26.71 22.34 27.44 21.91L31.53 19.52C31.9 19.3 33.25 18.55 33.52 18.3C33.81 18.05 34.01 17.72 34.1 17.35C34.23 16.83 34.19 15.88 34.19 15.32L34.19 12.99L34.19 10.83C34.19 8.64 34.21 8.5 32.3 7.38L30.54 6.35L28.35 5.07C27.8 4.75 27.02 4.23 26.43 4.09Z"
                        fill="#CAF240"
                      />
                      <path
                        d="M8.58 4.09C7.93 4.03 7.62 4.08 7.05 4.41C5.09 5.56 3.12 6.7 1.16 7.85C0.63 8.17 0.31 8.52 0.15 9.13C0.1 9.31 0.08 9.49 0.07 9.67C0.02 10.86 0.07 12.43 0.07 13.67L0.07 15.72C0.06 17.85 0.09 17.98 1.9 19.04L3.63 20.04L5.97 21.41C6.51 21.72 7.23 22.21 7.81 22.36C8.59 22.45 8.87 22.32 9.53 21.94L13.56 19.58C14.07 19.29 14.62 18.94 15.12 18.67C16.55 17.9 16.34 16.76 16.33 15.34L16.33 13.05L16.33 10.81C16.33 10.09 16.42 9.25 16.04 8.62C15.9 8.39 15.72 8.18 15.5 8.02C15.2 7.81 14.75 7.56 14.43 7.37L12.63 6.33C11.46 5.64 10.28 4.93 9.1 4.28C8.94 4.19 8.76 4.13 8.58 4.09Z"
                        fill="#2F49E5"
                      />
                    </g>
                  </svg>
                  <h1 className="mdcms-studio-shell__brand-name">
                    MDCMS Studio
                  </h1>
                </div>
                <span className="mdcms-studio-shell__path-chip">
                  {basePath}
                </span>
              </header>

              {startupState === "loading" ? (
                <div className="mdcms-studio-shell__content" aria-live="polite">
                  <div>
                    <div>
                      <p className="mdcms-studio-shell__eyebrow">Startup</p>
                      <h2 className="mdcms-studio-shell__title">
                        {LOADING_TITLE}
                      </h2>
                      <p className="mdcms-studio-shell__copy">
                        {LOADING_SUMMARY}
                      </p>
                    </div>

                    <div className="mdcms-studio-shell__surface">
                      <div className="mdcms-studio-shell__skeleton-stack">
                        <div className="mdcms-studio-shell__skeleton-line" />
                        <div className="mdcms-studio-shell__skeleton-bar" />
                        <div className="mdcms-studio-shell__skeleton-grid">
                          <div className="mdcms-studio-shell__skeleton-card" />
                          <div className="mdcms-studio-shell__skeleton-card" />
                          <div className="mdcms-studio-shell__skeleton-card" />
                        </div>
                      </div>
                    </div>
                  </div>

                  <aside className="mdcms-studio-shell__aside">
                    <p className="mdcms-studio-shell__section-label">
                      Startup checks
                    </p>
                    <div className="mdcms-studio-shell__check-list">
                      {[
                        "Resolving runtime bundle",
                        "Verifying bundle integrity",
                        "Initializing runtime",
                      ].map((step) => (
                        <div
                          key={step}
                          className="mdcms-studio-shell__check-item"
                        >
                          <div className="mdcms-studio-shell__check-dot" />
                          <span className="mdcms-studio-shell__check-text">
                            {step}
                          </span>
                        </div>
                      ))}
                    </div>
                  </aside>
                </div>
              ) : describedError ? (
                <div role="alert" className="mdcms-studio-shell__content">
                  <div>
                    <div>
                      <span className="mdcms-studio-shell__category-badge">
                        {describedError.categoryLabel}
                      </span>
                      <h2 className="mdcms-studio-shell__title">
                        {describedError.title}
                      </h2>
                      <p className="mdcms-studio-shell__summary">
                        {describedError.summary}
                      </p>
                      {describedError.note ? (
                        <p className="mdcms-studio-shell__note">
                          {describedError.note}
                        </p>
                      ) : null}
                    </div>

                    <details className="mdcms-studio-shell__details">
                      <summary className="mdcms-studio-shell__details-summary">
                        <span className="mdcms-studio-shell__details-summary-inner">
                          <span>Technical details</span>
                          <span className="mdcms-studio-shell__details-hint">
                            Expand
                          </span>
                        </span>
                      </summary>
                      <pre className="mdcms-studio-shell__details-pre">
                        {describedError.technicalDetails}
                      </pre>
                      <div className="mdcms-studio-shell__meta-group">
                        <p className="mdcms-studio-shell__section-label">
                          Failure metadata
                        </p>
                        <dl className="mdcms-studio-shell__meta-list">
                          {describedError.metadata.map((row) => (
                            <div
                              key={row.label}
                              className="mdcms-studio-shell__meta-row"
                            >
                              <dt className="mdcms-studio-shell__meta-label">
                                {row.label}
                              </dt>
                              <dd className="mdcms-studio-shell__meta-value">
                                {row.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </details>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

/**
 * Studio is the host-embedded entrypoint for MDCMS Studio.
 * It owns only bootstrap-time loading and fatal startup failures; once the
 * remote runtime mounts successfully, the remote app owns all Studio UI.
 */
export function Studio({
  config,
  basePath,
  auth,
  hostBridge,
  fetcher,
  loadRemoteModule,
}: StudioProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [startup, dispatchStartup] = useReducer(studioStartupReducer, {
    status: "loading",
  });
  const shellTheme = useResolvedShellTheme();

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    let isDisposed = false;
    let unmountRuntime: (() => void) | undefined;

    dispatchStartup({ type: "loading" });

    void loadStudioRuntime({
      config,
      basePath,
      container,
      auth,
      hostBridge,
      fetcher,
      loadRemoteModule,
    })
      .then((dispose) => {
        if (isDisposed) {
          dispose();
          return;
        }

        unmountRuntime = dispose;
        dispatchStartup({ type: "ready" });
      })
      .catch((error: unknown) => {
        if (isDisposed) {
          return;
        }

        dispatchStartup({ type: "error", error });
      });

    return () => {
      isDisposed = true;
      unmountRuntime?.();
    };
  }, [auth, basePath, config, fetcher, hostBridge, loadRemoteModule]);

  return (
    <StudioShellFrame
      config={config}
      basePath={basePath}
      startupState={startup.status}
      startupError={startup.error}
      containerRef={containerRef}
      shellTheme={shellTheme}
    />
  );
}
