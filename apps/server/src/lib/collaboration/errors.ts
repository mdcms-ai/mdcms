import { RuntimeError } from "@mdcms/shared";

export const COLLABORATION_UNAVAILABLE_CODE = "COLLABORATION_UNAVAILABLE";
export const DOCUMENT_COLLABORATION_ACTIVE_CODE =
  "DOCUMENT_COLLABORATION_ACTIVE";

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

export function createDocumentCollaborationActiveError(
  documentId: string,
): RuntimeError {
  return new RuntimeError({
    code: DOCUMENT_COLLABORATION_ACTIVE_CODE,
    message: "Document has an active collaboration session.",
    statusCode: 409,
    details: {
      documentId,
    },
  });
}
