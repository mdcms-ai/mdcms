import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import { AI_ERROR_CODES, RuntimeError, type AiErrorCode } from "@mdcms/shared";

const DEFAULT_STATUS_BY_CODE: Record<AiErrorCode, number> = {
  AI_DISABLED: 403,
  AI_PROVIDER_UNAVAILABLE: 503,
  AI_RATE_LIMITED: 429,
  AI_CONTEXT_TOO_LARGE: 413,
  AI_OUTPUT_INVALID: 422,
  AI_UNSUPPORTED_TASK: 400,
  AI_UNSUPPORTED_ACTION: 403,
};

const AI_ERROR_CODE_SET: ReadonlySet<AiErrorCode> = new Set(AI_ERROR_CODES);

/**
 * Codes a provider adapter is allowed to surface up to the orchestrator.
 * `AI_UNSUPPORTED_TASK` is excluded because that is an orchestrator-level
 * concern, not something a provider call can produce.
 */
const PROVIDER_FACING_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  "AI_DISABLED",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_RATE_LIMITED",
  "AI_CONTEXT_TOO_LARGE",
  "AI_OUTPUT_INVALID",
]);

export function aiError(
  code: AiErrorCode,
  message: string,
  details?: Record<string, unknown>,
  statusCode?: number,
): RuntimeError {
  return new RuntimeError({
    code,
    message,
    statusCode: statusCode ?? DEFAULT_STATUS_BY_CODE[code],
    details,
  });
}

export function isAiErrorCode(value: string): value is AiErrorCode {
  return AI_ERROR_CODE_SET.has(value as AiErrorCode);
}

const PROVIDER_FAILURE_MESSAGE = "AI provider request failed.";
const OUTPUT_INVALID_MESSAGE = "AI provider returned invalid output.";

/**
 * Map any thrown value from a provider call to a deterministic
 * RuntimeError. Provider-facing AI_* RuntimeErrors pass through (so
 * adapters can surface AI_RATE_LIMITED, AI_CONTEXT_TOO_LARGE, etc.
 * directly); AI SDK error classes map to specific AI_* codes;
 * everything else — including non-provider-facing AI codes such as
 * AI_UNSUPPORTED_TASK — collapses to AI_PROVIDER_UNAVAILABLE so
 * callers never see raw provider response bodies or unrelated
 * orchestrator codes leaking out of the provider seam.
 */
export function mapProviderError(error: unknown): RuntimeError {
  if (
    error instanceof RuntimeError &&
    isAiErrorCode(error.code) &&
    PROVIDER_FACING_CODES.has(error.code)
  ) {
    return error;
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    return aiError("AI_OUTPUT_INVALID", OUTPUT_INVALID_MESSAGE, {
      cause: "NoObjectGeneratedError",
    });
  }

  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  ) {
    return aiError("AI_OUTPUT_INVALID", OUTPUT_INVALID_MESSAGE, {
      cause: error.name,
    });
  }

  if (APICallError.isInstance(error)) {
    // Capture provider response detail so server logs and the error
    // surface in chat show what actually failed (rate-limit reason,
    // schema rejection text, etc.) instead of a generic "request
    // failed".
    const providerDetail = (() => {
      const body = (error as { responseBody?: unknown }).responseBody;
      const text = typeof body === "string" ? body : undefined;
      return {
        cause: error.name,
        ...(typeof error.statusCode === "number"
          ? { providerStatusCode: error.statusCode }
          : {}),
        ...(text ? { providerResponse: text.slice(0, 1000) } : {}),
        providerMessage: error.message,
      };
    })();
    if (error.statusCode === 429) {
      return aiError(
        "AI_RATE_LIMITED",
        "AI provider rate limit exceeded.",
        providerDetail,
      );
    }

    if (error.statusCode === 413) {
      return aiError(
        "AI_CONTEXT_TOO_LARGE",
        "AI provider rejected the request as too large.",
        providerDetail,
      );
    }

    // Surface the provider's own message in the RuntimeError text so
    // operators (and the user) see *why* the provider failed (e.g.
    // strict-mode schema rejection details).
    return aiError(
      "AI_PROVIDER_UNAVAILABLE",
      error.message
        ? `AI provider request failed: ${error.message}`
        : PROVIDER_FAILURE_MESSAGE,
      providerDetail,
    );
  }

  if (error instanceof Error) {
    return aiError("AI_PROVIDER_UNAVAILABLE", PROVIDER_FAILURE_MESSAGE, {
      cause: error.name,
    });
  }

  return aiError("AI_PROVIDER_UNAVAILABLE", PROVIDER_FAILURE_MESSAGE);
}
