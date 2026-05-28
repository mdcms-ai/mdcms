import { createAnthropic } from "@ai-sdk/anthropic";

import { aiError } from "../errors.js";
import type { AiProvider } from "../provider.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic" as const;
export const ANTHROPIC_PROVIDER_DEFAULT_MODEL = "claude-sonnet-4-6" as const;

export type AnthropicProviderOptions = {
  apiKey: string;
  model?: string;
  /** Optional override of the Anthropic base URL (e.g. for proxies). */
  baseURL?: string;
};

/**
 * Build an Anthropic-backed AiProvider. Credentials stay server-side;
 * callers only see normalized provider/model metadata on proposals
 * and audit records.
 */
export function createAnthropicAiProvider(
  options: AnthropicProviderOptions,
): AiProvider {
  const trimmedKey = options.apiKey.trim();

  if (trimmedKey.length === 0) {
    throw aiError(
      "AI_PROVIDER_UNAVAILABLE",
      "Anthropic provider requires a non-empty ANTHROPIC_API_KEY.",
      { providerId: ANTHROPIC_PROVIDER_ID },
    );
  }

  const anthropic = createAnthropic({
    apiKey: trimmedKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const modelId = options.model?.trim() || ANTHROPIC_PROVIDER_DEFAULT_MODEL;

  return {
    id: ANTHROPIC_PROVIDER_ID,
    languageModel: anthropic(modelId),
  };
}
