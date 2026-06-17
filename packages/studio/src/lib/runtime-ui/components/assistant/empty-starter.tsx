"use client";

import { cn } from "../../lib/utils.js";
import type { AssistantActiveDocument } from "./assistant-context.js";
import type { AssistantThread } from "./assistant-types.js";

type ExampleSet = "selection" | "document" | "global";

type Example = { label: string; prompt: string };

/**
 * Guided starter for a thread with zero messages. The example set is
 * picked by context: an attached selection → editing prompts, an active
 * document (or @-mention) → document-shape prompts, otherwise → global
 * prompts that scan the project. Clicking a card fills the composer
 * draft without sending so the user can tweak before submitting.
 */
const EXAMPLE_SETS: Record<ExampleSet, Example[]> = {
  selection: [
    {
      label: "Tighten this section",
      prompt:
        "Rewrite the selected paragraph to be roughly half the length without losing meaning.",
    },
    {
      label: "Change tone to formal",
      prompt: "Rewrite the selected text in a more formal, professional tone.",
    },
    {
      label: "Fix grammar",
      prompt:
        "Fix grammar and punctuation in the selected text. Preserve voice and meaning.",
    },
    {
      label: "Expand with examples",
      prompt:
        "Expand the selected text with concrete examples and supporting detail.",
    },
  ],
  document: [
    {
      label: "Suggest a better title",
      prompt:
        "Suggest three alternative titles for this document. Briefly explain each pick.",
    },
    {
      label: "Draft an intro",
      prompt:
        "Draft an opening paragraph for this document based on its current structure.",
    },
    {
      label: "Generate meta description",
      prompt:
        "Generate a 150–160 character SEO meta description summarising this document.",
    },
    {
      label: "Summarize this draft",
      prompt:
        "Summarise the current document and call out any unclear sections.",
    },
  ],
  global: [
    {
      label: "Draft a release post",
      prompt: "Draft a release announcement post for the next MDCMS milestone.",
    },
    {
      label: "Write a how-to intro",
      prompt:
        "Write the opening section of a how-to guide for content editors new to MDCMS.",
    },
    {
      label: "Suggest blog topics",
      prompt:
        "Suggest five evergreen blog topics for content editors using MDCMS.",
    },
    {
      label: "Outline a guide",
      prompt:
        "Draft an outline for a guide that explains MDCMS projects and environments.",
    },
  ],
};

function pickSet(
  thread: AssistantThread,
  activeDocument: AssistantActiveDocument | null,
): ExampleSet {
  if (thread.attachedSelection) return "selection";
  if (activeDocument) return "document";
  if (thread.contextDocs.length > 0) return "document";
  return "global";
}

export type EmptyStarterProps = {
  thread: AssistantThread;
  activeDocument: AssistantActiveDocument | null;
  /**
   * Whether the composer already has draft text. When true the cards
   * dim out so they don't compete with the in-progress draft.
   */
  hasDraft: boolean;
  /** Fill the composer with the example prompt (does NOT send). */
  onPick: (prompt: string) => void;
};

export function EmptyStarter({
  thread,
  activeDocument,
  hasDraft,
  onPick,
}: EmptyStarterProps) {
  const set = EXAMPLE_SETS[pickSet(thread, activeDocument)];
  return (
    <div
      className={cn(
        "px-1 pb-3 pt-6 transition-opacity duration-150",
        hasDraft && "opacity-40",
      )}
    >
      <div className="mb-4 text-[12.5px] leading-relaxed text-foreground-muted">
        Ask anything about this doc, propose edits, or draft new content.
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {set.map((ex) => (
          <ExampleCard
            key={ex.label}
            label={ex.label}
            prompt={ex.prompt}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

function ExampleCard({
  label,
  prompt,
  onPick,
}: Example & { onPick: (prompt: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(prompt)}
      className="flex flex-col gap-1 rounded-xl border border-divider/60 bg-card px-3.5 py-3 text-left transition-all hover:-translate-y-px hover:border-divider hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
    >
      <span className="text-[13px] text-foreground">{label}</span>
      <span className="line-clamp-1 text-[12px] leading-snug text-foreground-muted">
        {prompt}
      </span>
    </button>
  );
}
