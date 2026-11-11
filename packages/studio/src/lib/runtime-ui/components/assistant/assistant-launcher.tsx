"use client";

import { cn } from "../../lib/utils.js";
import { useAssistant, useAssistantMounted } from "./assistant-context.js";
import { SparkleMark } from "./sparkle-mark.js";

/**
 * Topbar "Ask AI" trigger. Toggles the rail open / closed and reflects
 * its current state visually so the user always knows whether the rail
 * is mounted on the right.
 */
export function AssistantLauncher({ className }: { className?: string }) {
  const mounted = useAssistantMounted();
  const assistant = useAssistant();
  if (!mounted) return null;
  const isOpen = assistant.isOpen;
  const onClick = () => {
    if (isOpen) {
      assistant.close();
    } else {
      assistant.openRail();
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isOpen}
      aria-label={isOpen ? "Close AI assistant" : "Open AI assistant"}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors",
        isOpen
          ? "border-vibrant-green-border bg-vibrant-green/15 text-foreground"
          : "border-border text-foreground hover:bg-muted",
        className,
      )}
    >
      <SparkleMark size={12} className="text-foreground-muted" />
      <span>Assistant</span>
      <span className="rounded-sm border border-border bg-muted px-1 font-mono text-[11px] text-foreground-muted">
        ⌘ K
      </span>
    </button>
  );
}
