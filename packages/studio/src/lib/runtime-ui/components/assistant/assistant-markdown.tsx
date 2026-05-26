"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";
import { Streamdown, type Components } from "streamdown";

import { cn } from "../../lib/utils.js";

export type AssistantMarkdownProps = {
  text: string;
  /**
   * When true, Streamdown runs in streaming mode and patches unfinished
   * markdown (open emphasis markers, unterminated code fences) so a
   * mid-stream chunk renders sensibly instead of leaking raw `**` or
   * `\`\`\`` into the output. Default `true` because every assistant
   * turn we render is potentially mid-stream.
   */
  streaming?: boolean;
  className?: string;
};

type AssistantCodeProps = React.ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: boolean | string;
};

const codeLanguagePattern = /(?:^|\s)language-([^\s]+)/;

const languageExtensions: Record<string, string> = {
  bash: "sh",
  css: "css",
  html: "html",
  javascript: "js",
  js: "js",
  json: "json",
  markdown: "md",
  md: "md",
  mdx: "mdx",
  shell: "sh",
  sh: "sh",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
  yml: "yml",
};

function extractLanguage(className?: string): string | null {
  const match = className?.match(codeLanguagePattern);
  return match?.[1]?.toLowerCase() ?? null;
}

function codeTextFromChildren(children: React.ReactNode): string {
  return React.Children.toArray(children).join("").replace(/\n+$/, "");
}

function codeDownloadName(language: string): string {
  const extension = languageExtensions[language] ?? "txt";
  return `code-block.${extension}`;
}

export async function copyCodeToClipboard(code: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(code);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API not available.");
  }

  const textArea = document.createElement("textarea");
  const selection = document.getSelection();
  const selectedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  textArea.value = code;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.inset = "0 auto auto -9999px";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    document.body.removeChild(textArea);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}

export function downloadCodeBlock(code: string, language: string): void {
  if (typeof document === "undefined") {
    throw new Error("Document API not available.");
  }

  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = href;
  anchor.download = codeDownloadName(language);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(href);
}

function AssistantCodeAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md border border-transparent text-foreground-muted transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
    >
      {children}
    </button>
  );
}

function AssistantCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [downloadState, setDownloadState] = React.useState<"idle" | "error">(
    "idle",
  );
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const scheduleCopyReset = React.useCallback(() => {
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => {
      setCopyState("idle");
      resetTimer.current = null;
    }, 1800);
  }, []);

  const handleCopy = React.useCallback(() => {
    void copyCodeToClipboard(code)
      .then(() => {
        setCopyState("copied");
        scheduleCopyReset();
      })
      .catch(() => {
        setCopyState("error");
      });
  }, [code, scheduleCopyReset]);

  const handleDownload = React.useCallback(() => {
    try {
      downloadCodeBlock(code, language);
      setDownloadState("idle");
    } catch {
      setDownloadState("error");
    }
  }, [code, language]);

  const statusText =
    copyState === "copied"
      ? "Code copied"
      : copyState === "error"
        ? "Code copy failed"
        : downloadState === "error"
          ? "Code download failed"
          : "";

  return (
    <div
      data-mdcms-assistant-code-block=""
      data-language={language}
      className="not-prose my-3 overflow-hidden rounded-lg border border-border/70 bg-[var(--code-bg)] text-foreground shadow-sm"
    >
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/60 bg-card/70 px-3 py-1.5">
        <span className="truncate font-mono text-[11px] font-medium uppercase text-foreground-muted">
          {language}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <AssistantCodeAction
            label="Download code block"
            onClick={handleDownload}
          >
            <Download className="size-4" aria-hidden="true" />
          </AssistantCodeAction>
          <AssistantCodeAction label="Copy code block" onClick={handleCopy}>
            {copyState === "copied" ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
          </AssistantCodeAction>
        </div>
      </div>
      <pre className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap break-words bg-transparent px-4 py-3 font-mono text-[12.5px] leading-6 text-foreground">
        <code>{code}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {statusText}
      </span>
    </div>
  );
}

function AssistantCode({ children, className, ...props }: AssistantCodeProps) {
  const language = extractLanguage(className);
  const isBlock = Boolean(props["data-block"]) || language !== null;

  if (!isBlock) {
    return (
      <code
        className={cn(
          "rounded bg-[var(--code-bg)] px-1.5 py-0.5 font-mono text-[0.95em] text-foreground",
          className,
        )}
      >
        {children}
      </code>
    );
  }

  return (
    <AssistantCodeBlock
      code={codeTextFromChildren(children)}
      language={language ?? "text"}
    />
  );
}

const assistantMarkdownComponents: Components = {
  code: AssistantCode,
};

/**
 * Markdown surface for assistant prose. Wraps `streamdown` (the
 * library AI SDK Elements uses under the hood) with the chat
 * bubble's typography scale and the Studio's `prose` theme, so the
 * default headings, lists, blockquotes, tables, and fenced code
 * blocks all pick up the same hue/border tokens the rest of the UI
 * uses.
 *
 * The `prose-sm` size class drops the body to 14px to match the
 * existing chat-bubble text size (the bubble was already
 * `text-[13.5px]`; `prose-sm` resolves to ~13.5–14px depending on
 * the override). `max-w-none` opts out of the typography plugin's
 * default 65-char ceiling so the markdown fills the bubble width.
 */
export function AssistantMarkdown({
  text,
  streaming = true,
  className,
}: AssistantMarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-[13.5px] leading-relaxed text-foreground",
        // Tighten the typography defaults so a single-paragraph reply
        // doesn't get the same top/bottom margin a long-form blog
        // post would. Chat bubbles aren't articles.
        "[&_p]:my-1 [&_h1]:my-2 [&_h2]:my-2 [&_h3]:my-2 [&_ul]:my-1 [&_ol]:my-1 [&_pre]:my-2",
        className,
      )}
    >
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        components={assistantMarkdownComponents}
        controls={{ code: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
}
