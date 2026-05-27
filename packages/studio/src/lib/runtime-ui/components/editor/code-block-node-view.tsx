"use client";

import type { ReactNodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.js";
import { cn } from "../../lib/utils.js";
import {
  COMMON_CODE_BLOCK_LANGUAGES,
  PLAIN_TEXT_LANGUAGE_VALUE,
  getCodeBlockLanguageLabel,
  isKnownCodeBlockLanguage,
  resolveCodeBlockLanguageChange,
} from "./code-block-languages.js";

interface CodeBlockLanguageSelectProps {
  language: string | null | undefined;
  disabled: boolean;
  onChange: (patch: { language: string | null }) => void;
}

export function CodeBlockLanguageSelect({
  language,
  disabled,
  onChange,
}: CodeBlockLanguageSelectProps) {
  const currentValue =
    language && language.length > 0 ? language : PLAIN_TEXT_LANGUAGE_VALUE;
  const isUnknown =
    typeof language === "string" &&
    language.length > 0 &&
    !isKnownCodeBlockLanguage(language);
  const label = getCodeBlockLanguageLabel(language ?? null);

  return (
    <Select
      value={currentValue}
      onValueChange={(next) => onChange(resolveCodeBlockLanguageChange(next))}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        data-mdcms-code-block-language-select=""
        data-unknown-language={isUnknown ? "true" : undefined}
        className={cn(
          "h-6 w-auto min-w-[7rem] gap-1 rounded-none border-transparent bg-transparent px-1.5 text-xs font-medium text-foreground-muted/60 shadow-none transition-colors hover:bg-background-subtle/70 hover:text-foreground-muted",
          isUnknown && "text-warning/70 hover:text-warning",
        )}
        aria-label={
          isUnknown
            ? `Code block language: ${label} (not registered)`
            : "Code block language"
        }
      >
        <SelectValue placeholder={label} aria-label={label}>
          {label}
          {isUnknown ? (
            <span className="ml-1 text-[10px] uppercase tracking-wide text-warning">
              not registered
            </span>
          ) : null}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={PLAIN_TEXT_LANGUAGE_VALUE}>Plain text</SelectItem>
        {COMMON_CODE_BLOCK_LANGUAGES.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CodeBlockNodeView({
  node,
  updateAttributes,
  editor,
}: ReactNodeViewProps) {
  const rawLanguage = node.attrs.language;
  const language =
    typeof rawLanguage === "string" && rawLanguage.length > 0
      ? rawLanguage
      : null;
  const disabled = !editor.isEditable;

  return (
    <NodeViewWrapper
      as="div"
      className="relative"
      data-mdcms-code-block-kind={language ? "tagged" : "plain"}
    >
      <div
        className="absolute right-2 top-2 z-10"
        contentEditable={false}
        suppressContentEditableWarning
      >
        <CodeBlockLanguageSelect
          language={language}
          disabled={disabled}
          onChange={(patch) => updateAttributes(patch)}
        />
      </div>
      <pre className="mdcms-editor-code-block">
        <NodeViewContent<"code"> as="code" className="hljs" />
      </pre>
    </NodeViewWrapper>
  );
}
