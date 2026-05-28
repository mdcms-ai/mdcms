import { isRuntimeErrorLike } from "@mdcms/shared";

import {
  resolveAppliedTheme,
  STUDIO_THEME_STORAGE_KEY,
} from "./runtime-ui/adapters/next-themes-state.js";

export type ShellAppliedTheme = "light" | "dark";

export const SHELL_THEME_INLINE_SCRIPT = `(function(){try{var el=document.currentScript&&document.currentScript.parentElement;if(!el)return;var s=null;try{s=window.localStorage&&window.localStorage.getItem(${JSON.stringify(STUDIO_THEME_STORAGE_KEY)});}catch(_){}var p=s==="light"||s==="dark"||s==="system"?s:"system";var r=p==="light"||p==="dark"?p:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");if(el.getAttribute("data-mdcms-theme")!==r){el.setAttribute("data-mdcms-theme",r);}}catch(_){}})();`;

export const LOADING_TITLE = "Loading Studio";
export const LOADING_SUMMARY = "Fetching and validating the runtime bundle.";
export const READY_CONTAINER_STYLE = {
  minHeight: "20rem",
} as const;

export const STUDIO_SHELL_STYLES = `
.mdcms-studio-shell,
.mdcms-studio-shell * {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.mdcms-studio-shell {
  --s-bg: #FCF9F8;
  --s-surface: #FFFFFF;
  --s-fg: #1C1B1B;
  --s-fg-muted: #444655;
  --s-primary: #2F49E5;
  --s-border: rgba(197, 197, 216, 0.25);
  --s-border-subtle: rgba(197, 197, 216, 0.15);
  --s-surface-inner: rgba(246, 243, 242, 0.6);
  --s-surface-inner-subtle: rgba(246, 243, 242, 0.4);
  --s-skeleton-strong: rgba(197, 197, 216, 0.3);
  --s-skeleton-mid: rgba(197, 197, 216, 0.2);
  --s-skeleton-soft: rgba(197, 197, 216, 0.14);
  --s-check-bg: rgba(47, 73, 229, 0.04);
  --s-destructive: #ef4444;
  --s-destructive-border: rgba(239, 68, 68, 0.2);
  --s-destructive-bg: rgba(239, 68, 68, 0.08);
  --s-warning: #f59e0b;
  --s-code-bg: #F0EDEC;
  --s-glow: rgba(47, 73, 229, 0.04);
  --s-path-bg: rgba(197, 197, 216, 0.1);
  --s-path-border: rgba(197, 197, 216, 0.18);
  color-scheme: light;

  position: fixed;
  inset: 0;
  z-index: 2147483000;
  isolation: isolate;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--s-bg);
  color: var(--s-fg);
  font-family: "Inter Variable", "Inter", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.mdcms-studio-shell[data-mdcms-theme="dark"] {
  --s-bg: #0C0C0E;
  --s-surface: #151518;
  --s-fg: #F5F4F4;
  --s-fg-muted: #A0A2B5;
  --s-primary: #5B72F5;
  --s-border: rgba(197, 197, 216, 0.15);
  --s-border-subtle: rgba(197, 197, 216, 0.08);
  --s-surface-inner: rgba(40, 40, 48, 0.6);
  --s-surface-inner-subtle: rgba(40, 40, 48, 0.4);
  --s-skeleton-strong: rgba(197, 197, 216, 0.14);
  --s-skeleton-mid: rgba(197, 197, 216, 0.09);
  --s-skeleton-soft: rgba(197, 197, 216, 0.06);
  --s-check-bg: rgba(91, 114, 245, 0.1);
  --s-destructive: #f87171;
  --s-destructive-border: rgba(248, 113, 113, 0.25);
  --s-destructive-bg: rgba(248, 113, 113, 0.1);
  --s-warning: #fbbf24;
  --s-code-bg: #1A1A1E;
  --s-glow: rgba(91, 114, 245, 0.08);
  --s-path-bg: rgba(197, 197, 216, 0.06);
  --s-path-border: rgba(197, 197, 216, 0.12);
  color-scheme: dark;
}

.mdcms-studio-shell__backdrop {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(ellipse 60% 50% at 50% 0%, var(--s-glow), transparent);
}

.mdcms-studio-shell__frame {
  position: relative;
  display: flex;
  min-height: 100%;
  align-items: stretch;
  width: 100%;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.25rem;
}

.mdcms-studio-shell__panel {
  width: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--s-border);
  border-radius: 0.75rem;
  background: var(--s-surface);
  padding: 1.5rem;
}

.mdcms-studio-shell__header {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--s-border);
}

.mdcms-studio-shell__brand-group {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.mdcms-studio-shell__brand-logo {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
}

.mdcms-studio-shell__brand-name {
  font-family: "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif;
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--s-fg);
}

.mdcms-studio-shell__path-chip {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;
  font-weight: 400;
  color: var(--s-fg-muted);
  background: var(--s-path-bg);
  border: 1px solid var(--s-path-border);
}

.mdcms-studio-shell__title {
  font-family: "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif;
  font-weight: 600;
  font-size: 1.5rem;
  letter-spacing: -0.02em;
  color: var(--s-fg);
  margin-bottom: 0.375rem;
}

.mdcms-studio-shell__content {
  margin-top: 1.5rem;
  display: grid;
  gap: 1.25rem;
}

.mdcms-studio-shell__eyebrow,
.mdcms-studio-shell__section-label,
.mdcms-studio-shell__meta-label,
.mdcms-studio-shell__details-hint {
  font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--s-fg-muted);
}

.mdcms-studio-shell__eyebrow {
  margin-bottom: 0.5rem;
}

.mdcms-studio-shell__copy,
.mdcms-studio-shell__summary {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--s-fg-muted);
  max-width: 36rem;
  margin-bottom: 1.25rem;
}

.mdcms-studio-shell__note {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--s-warning);
  max-width: 36rem;
  margin-bottom: 1rem;
}

.mdcms-studio-shell__check-text,
.mdcms-studio-shell__details-summary {
  font-size: 0.875rem;
  line-height: 1.5;
}

.mdcms-studio-shell__meta-value {
  font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--s-fg);
  word-break: break-word;
}

.mdcms-studio-shell__surface,
.mdcms-studio-shell__aside,
.mdcms-studio-shell__details {
  border-radius: 0.5rem;
  border: 1px solid var(--s-border-subtle);
}

.mdcms-studio-shell__surface,
.mdcms-studio-shell__details {
  background: var(--s-surface-inner);
  padding: 1rem;
}

.mdcms-studio-shell__aside {
  background: var(--s-surface-inner-subtle);
  padding: 1rem;
}

.mdcms-studio-shell__skeleton-stack {
  display: grid;
  gap: 0.625rem;
}

.mdcms-studio-shell__skeleton-line,
.mdcms-studio-shell__skeleton-bar,
.mdcms-studio-shell__skeleton-card {
  animation: mdcms-shell-pulse 2s ease-in-out infinite;
}

.mdcms-studio-shell__skeleton-line {
  height: 0.625rem;
  width: 6rem;
  border-radius: 0.25rem;
  background: var(--s-skeleton-strong);
}

.mdcms-studio-shell__skeleton-bar {
  height: 2rem;
  width: 100%;
  border-radius: 0.375rem;
  background: var(--s-skeleton-mid);
}

.mdcms-studio-shell__skeleton-grid {
  display: grid;
  gap: 0.625rem;
}

.mdcms-studio-shell__skeleton-card {
  height: 5rem;
  border-radius: 0.375rem;
  background: var(--s-skeleton-soft);
}

.mdcms-studio-shell__skeleton-card:nth-child(2) {
  animation-delay: 0.15s;
}

.mdcms-studio-shell__skeleton-card:nth-child(3) {
  animation-delay: 0.3s;
}

.mdcms-studio-shell__check-list {
  display: grid;
  gap: 0.5rem;
}

.mdcms-studio-shell__check-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  border-radius: 0.375rem;
  background: var(--s-check-bg);
}

.mdcms-studio-shell__check-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--s-primary);
  animation: mdcms-shell-pulse 2s ease-in-out infinite;
}

.mdcms-studio-shell__check-item:nth-child(2) .mdcms-studio-shell__check-dot {
  animation-delay: 0.3s;
}

.mdcms-studio-shell__check-item:nth-child(3) .mdcms-studio-shell__check-dot {
  animation-delay: 0.6s;
}

.mdcms-studio-shell__check-text {
  color: var(--s-fg-muted);
}

.mdcms-studio-shell__category-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  border-radius: 0.375rem;
  padding: 0.25rem 0.625rem;
  font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
  border: 1px solid var(--s-destructive-border);
  background: var(--s-destructive-bg);
  color: var(--s-destructive);
}

.mdcms-studio-shell__details {
  margin-top: 1.25rem;
}

.mdcms-studio-shell__details-summary {
  cursor: pointer;
  list-style: none;
  color: var(--s-fg);
  font-weight: 500;
}

.mdcms-studio-shell__details-summary::-webkit-details-marker {
  display: none;
}

.mdcms-studio-shell__details-summary-inner {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.mdcms-studio-shell__details[open] .mdcms-studio-shell__details-hint {
  color: var(--s-primary);
}

.mdcms-studio-shell__details-pre {
  margin: 0.75rem 0 0;
  padding: 0.875rem;
  border-radius: 0.375rem;
  border: 1px solid var(--s-border-subtle);
  background: var(--s-code-bg);
  color: var(--s-fg-muted);
  font-family: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

.mdcms-studio-shell__meta-list {
  margin: 0.75rem 0 0;
  display: grid;
}

.mdcms-studio-shell__meta-group {
  margin-top: 1rem;
}

.mdcms-studio-shell__meta-row {
  display: grid;
  gap: 0.25rem;
  padding: 0.625rem 0;
  border-top: 1px solid var(--s-border-subtle);
}

.mdcms-studio-shell__meta-row:first-child {
  padding-top: 0;
  border-top: 0;
}

@keyframes mdcms-shell-pulse {
  0%, 100% {
    opacity: 0.4;
  }

  50% {
    opacity: 1;
  }
}

@media (min-width: 640px) {
  .mdcms-studio-shell__frame {
    padding: 1.5rem;
  }

  .mdcms-studio-shell__panel {
    padding: 2rem;
  }

  .mdcms-studio-shell__header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .mdcms-studio-shell__skeleton-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (min-width: 1024px) {
  .mdcms-studio-shell__frame {
    padding: 2.5rem;
  }

  .mdcms-studio-shell__panel {
    padding: 2.5rem;
  }

  .mdcms-studio-shell__content {
    grid-template-columns: 1.3fr 0.7fr;
  }
}
`;

export type StudioStartupErrorMetadataRow = {
  label: string;
  value: string;
};

export type StudioStartupErrorDescription = {
  categoryLabel: string;
  title: string;
  summary: string;
  note?: string;
  technicalDetails: string;
  metadata: StudioStartupErrorMetadataRow[];
};

const LOAD_ERROR_CODES = new Set([
  "STUDIO_BOOTSTRAP_FETCH_FAILED",
  "STUDIO_RUNTIME_ASSET_LOAD_FAILED",
]);

const REJECTED_ERROR_CODES = new Set([
  "INVALID_STUDIO_BOOTSTRAP_MANIFEST",
  "INVALID_STUDIO_BOOTSTRAP_RESPONSE",
  "INCOMPATIBLE_STUDIO_BOOTSTRAP_MANIFEST",
  "STUDIO_RUNTIME_INTEGRITY_UNAVAILABLE",
  "STUDIO_RUNTIME_INTEGRITY_MISMATCH",
  "INVALID_STUDIO_RUNTIME_SIGNATURE",
  "INVALID_STUDIO_RUNTIME_KEY_ID",
]);

const STARTUP_BLOCKED_ERROR_CODES = new Set([
  "STUDIO_RUNTIME_DISABLED",
  "STUDIO_RUNTIME_UNAVAILABLE",
]);

function readDetailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readDetailBoolean(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return details?.[key] === true;
}

export function describeStudioStartupError(
  error: unknown,
): StudioStartupErrorDescription {
  const fallbackMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "Failed to initialize Studio.";

  if (!isRuntimeErrorLike(error)) {
    return {
      categoryLabel: "Startup crash",
      title: "Studio bundle crashed during startup",
      summary:
        "The Studio runtime loaded, but failed while initializing inside the shell.",
      technicalDetails: fallbackMessage,
      metadata: [{ label: "Error code", value: "INTERNAL_ERROR" }],
    };
  }

  const metadata: StudioStartupErrorMetadataRow[] = [
    { label: "Error code", value: error.code },
  ];
  const browserOrigin = readDetailString(error.details, "browserOrigin");
  const requestedOrigin = readDetailString(error.details, "requestedOrigin");
  const requestUrl = readDetailString(error.details, "url");

  if (browserOrigin) {
    metadata.push({ label: "Host origin", value: browserOrigin });
  }

  if (requestedOrigin) {
    metadata.push({ label: "Target origin", value: requestedOrigin });
  }

  if (requestUrl) {
    metadata.push({ label: "Request URL", value: requestUrl });
  }

  if (LOAD_ERROR_CODES.has(error.code)) {
    const isCrossOrigin = readDetailBoolean(error.details, "isCrossOrigin");
    const isOriginPolicyFailure = readDetailBoolean(
      error.details,
      "isOriginPolicyFailure",
    );

    return {
      categoryLabel: "Bundle load",
      title: "Studio bundle could not be loaded",
      summary:
        "The shell could not retrieve the Studio runtime from the configured backend.",
      note: isOriginPolicyFailure
        ? "The browser blocked the request before Studio could start."
        : isCrossOrigin
          ? "Studio could not reach the configured backend before startup completed."
          : undefined,
      technicalDetails: error.message,
      metadata,
    };
  }

  if (REJECTED_ERROR_CODES.has(error.code)) {
    return {
      categoryLabel: "Bundle rejected",
      title: "Studio bundle was rejected",
      summary:
        "The downloaded Studio runtime did not pass host validation, so startup was stopped.",
      technicalDetails: error.message,
      metadata,
    };
  }

  if (STARTUP_BLOCKED_ERROR_CODES.has(error.code)) {
    if (error.code === "STUDIO_RUNTIME_DISABLED") {
      return {
        categoryLabel: "Startup disabled",
        title: "Studio startup is disabled",
        summary:
          "An operator has disabled Studio startup for this server, so the shell will not load a runtime bundle.",
        note: "Update the server-side Studio runtime configuration and reload this route after the operator re-enables startup.",
        technicalDetails: error.message,
        metadata,
      };
    }

    return {
      categoryLabel: "Runtime unavailable",
      title: "No safe Studio runtime is available",
      summary:
        "The server could not provide a safe runtime from either the active or last-known-good publication, so startup was stopped before the bundle loaded.",
      note: "Publish or restore a verified Studio runtime on the server before retrying this route.",
      technicalDetails: error.message,
      metadata,
    };
  }

  return {
    categoryLabel: "Startup crash",
    title: "Studio bundle crashed during startup",
    summary:
      "The Studio runtime loaded, but failed while initializing inside the shell.",
    technicalDetails: error.message,
    metadata,
  };
}

export function resolveShellAppliedTheme(input: {
  storedThemeRaw: string | null;
  systemPrefersDark: boolean;
}): ShellAppliedTheme {
  const stored =
    input.storedThemeRaw === "light" ||
    input.storedThemeRaw === "dark" ||
    input.storedThemeRaw === "system"
      ? input.storedThemeRaw
      : null;

  return resolveAppliedTheme(stored ?? "system", input.systemPrefersDark);
}
