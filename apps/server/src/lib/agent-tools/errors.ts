import { RuntimeError } from "@mdcms/shared";
import { createCollaborationUnavailableError } from "../collaboration/errors.js";

export type AgentToolFailure = {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
};

/** Only known service failures expose a public 5xx domain contract. */
export function toAgentToolFailure(error: unknown): AgentToolFailure {
  if (error instanceof RuntimeError) {
    const unavailable = createCollaborationUnavailableError();
    if (
      error.code === unavailable.code &&
      error.statusCode === unavailable.statusCode
    ) {
      return {
        code: unavailable.code,
        message: unavailable.message,
        status: unavailable.statusCode,
      };
    }
    if (
      error.statusCode >= 400 &&
      error.statusCode < 500 &&
      error.code !== "INTERNAL_ERROR"
    ) {
      return {
        code: error.code,
        message: error.message,
        status: error.statusCode,
        ...(error.details ? { details: error.details } : {}),
      };
    }
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Internal server error.",
    status: 500,
  };
}
