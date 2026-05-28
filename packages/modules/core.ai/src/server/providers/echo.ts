import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";

import type { AiProvider, AiProviderUsage } from "../provider.js";

export const ECHO_PROVIDER_ID = "echo" as const;
export const ECHO_PROVIDER_DEFAULT_MODEL = "echo-1" as const;

export type EchoToolCall = {
  toolName: string;
  /** Stringified JSON args for the tool. */
  input: string;
  toolCallId?: string;
};

export type EchoStepResponse =
  | { type: "text"; text: string }
  | { type: "tool-calls"; calls: EchoToolCall[]; trailingText?: string };

export type EchoAiProviderOptions = {
  model?: string;
  /**
   * Returns the model output text for a given call. The returned
   * string must be valid JSON matching the task's output schema for
   * `generateObject` to succeed; tests can intentionally return
   * malformed text to exercise the AI_OUTPUT_INVALID path.
   */
  respond?: (options: LanguageModelV3CallOptions) => string;
  /**
   * Scripted multi-step response — used by chat tool-calling tests.
   * Each call to `doGenerate` consumes one entry, in order. Step 0
   * is typically `{ type: "tool-calls", calls: [...] }`; step 1 the
   * concluding text reply. If exhausted, falls through to `respond`
   * / text-only behavior so existing callers keep working.
   */
  steps?: EchoStepResponse[];
  usage?: AiProviderUsage;
  /**
   * If set, every doGenerate call rejects with this error. Used in
   * tests to exercise AI_PROVIDER_UNAVAILABLE handling.
   */
  throwOnGenerate?: Error;
};

/**
 * Deterministic in-memory provider for unit tests and local
 * development. Wraps `MockLanguageModelV3` from the AI SDK and
 * lets callers control output text, scripted tool-call sequences,
 * usage, or failure injection.
 */
export function createEchoAiProvider(
  options: EchoAiProviderOptions = {},
): AiProvider {
  const modelId = options.model ?? ECHO_PROVIDER_DEFAULT_MODEL;
  let stepCursor = 0;

  const languageModel = new MockLanguageModelV3({
    provider: ECHO_PROVIDER_ID,
    modelId,
    doGenerate: async (callOptions) => {
      if (options.throwOnGenerate) {
        throw options.throwOnGenerate;
      }

      // Scripted multi-step path — used by chat tool-calling tests.
      if (options.steps && stepCursor < options.steps.length) {
        const step = options.steps[stepCursor]!;
        stepCursor += 1;
        const content: LanguageModelV3Content[] = [];
        let finishReasonRaw: "tool-calls" | "stop" = "stop";
        if (step.type === "tool-calls") {
          for (const call of step.calls) {
            content.push({
              type: "tool-call",
              toolCallId:
                call.toolCallId ?? `tc_${stepCursor}_${content.length + 1}`,
              toolName: call.toolName,
              input: call.input,
            });
          }
          if (step.trailingText) {
            content.push({ type: "text", text: step.trailingText });
          }
          finishReasonRaw = "tool-calls";
        } else {
          content.push({ type: "text", text: step.text });
          finishReasonRaw = "stop";
        }
        return {
          content,
          finishReason: { unified: finishReasonRaw, raw: finishReasonRaw },
          usage: {
            inputTokens: {
              total: options.usage?.inputTokens,
              noCache: options.usage?.inputTokens,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: options.usage?.outputTokens,
              text: options.usage?.outputTokens,
              reasoning: undefined,
            },
          },
          warnings: [],
        };
      }

      const text = options.respond
        ? options.respond(callOptions)
        : extractUserPrompt(callOptions);

      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: options.usage?.inputTokens,
            noCache: options.usage?.inputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: options.usage?.outputTokens,
            text: options.usage?.outputTokens,
            reasoning: undefined,
          },
        },
        warnings: [],
      };
    },
    doStream: async (callOptions) => {
      if (options.throwOnGenerate) {
        throw options.throwOnGenerate;
      }

      if (options.steps && stepCursor < options.steps.length) {
        const step = options.steps[stepCursor]!;
        stepCursor += 1;
        return streamFromStep(step, stepCursor, options.usage);
      }

      const text = options.respond
        ? options.respond(callOptions)
        : extractUserPrompt(callOptions);
      return streamFromStep({ type: "text", text }, stepCursor, options.usage);
    },
  });

  return {
    id: ECHO_PROVIDER_ID,
    languageModel,
  };
}

function streamFromStep(
  step: EchoStepResponse,
  stepCursor: number,
  usage: AiProviderUsage | undefined,
) {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
  ];

  if (step.type === "tool-calls") {
    for (const [idx, call] of step.calls.entries()) {
      parts.push({
        type: "tool-call",
        toolCallId: call.toolCallId ?? `tc_${stepCursor}_${idx + 1}`,
        toolName: call.toolName,
        input: call.input,
      });
    }
    if (step.trailingText) {
      parts.push(
        { type: "text-start", id: `txt_${stepCursor}` },
        {
          type: "text-delta",
          id: `txt_${stepCursor}`,
          delta: step.trailingText,
        },
        { type: "text-end", id: `txt_${stepCursor}` },
      );
    }
    parts.push({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: streamUsage(usage),
    });
  } else {
    parts.push(
      { type: "text-start", id: `txt_${stepCursor}` },
      { type: "text-delta", id: `txt_${stepCursor}`, delta: step.text },
      { type: "text-end", id: `txt_${stepCursor}` },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: streamUsage(usage),
      },
    );
  }

  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

function streamUsage(usage: AiProviderUsage | undefined): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage?.inputTokens,
      noCache: usage?.inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.outputTokens,
      text: usage?.outputTokens,
      reasoning: undefined,
    },
  };
}

function extractUserPrompt(options: LanguageModelV3CallOptions): string {
  for (const message of options.prompt) {
    if (message.role !== "user") {
      continue;
    }

    for (const part of message.content) {
      if (part.type === "text") {
        return part.text;
      }
    }
  }

  return "";
}
