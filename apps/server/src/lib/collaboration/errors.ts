import { RuntimeError } from "@mdcms/shared";

export const COLLABORATION_UNAVAILABLE_CODE = "COLLABORATION_UNAVAILABLE";

export function createCollaborationUnavailableError(
  details: Record<string, unknown> = {},
): RuntimeError {
  return new RuntimeError({
    code: COLLABORATION_UNAVAILABLE_CODE,
    message: "Collaboration Redis is unavailable.",
    statusCode: 503,
    details,
  });
}
