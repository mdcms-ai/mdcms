import type {
  ContentDocumentResponse,
  DocumentPromotionResult,
} from "@mdcms/shared";

export type PromoteStage = "configure" | "preview" | "result";

export type EnvironmentPromoteSnapshot = {
  sourceEnvId: string;
  sourceEnvName: string;
  targetEnvId: string;
  targetEnvName: string;
  documentIds: string[];
  includeUnpublished: boolean;
};

export type EnvironmentPromoteState = {
  stage: PromoteStage;
  sourceEnvironmentId: string;
  targetEnvironmentId: string;
  selectedDocumentIds: string[];
  includeUnpublished: boolean;
  documents: ContentDocumentResponse[];
  documentsLoading: boolean;
  documentsError: string | null;
  preview:
    | { status: "idle" }
    | { status: "loading" }
    | {
        status: "ready";
        results: DocumentPromotionResult[];
        snapshot: EnvironmentPromoteSnapshot;
      }
    | {
        status: "error";
        message: string;
        remapDetails?: {
          sourceDocumentId?: string;
          fieldPath?: string;
          translationGroupId?: string;
          locale?: string;
        };
      };
  executing: boolean;
  executeError: string | null;
  executeResult: DocumentPromotionResult[] | null;
};

export function readRuntimeErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const normalize = (message: string): string =>
    message === "Server config is required to manage environments."
      ? "Environment management is unavailable because the connected backend could not load mdcms.config.ts."
      : message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.trim().length > 0
  ) {
    return normalize((error as { message: string }).message);
  }
  return normalize(fallback);
}

export function readRuntimeErrorStatus(error: unknown): number | null {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return null;
}

export function readRemapDetails(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "details" in error &&
    typeof (error as { details?: unknown }).details === "object" &&
    (error as { details?: unknown }).details !== null
  ) {
    const details = (error as { details: Record<string, unknown> }).details;
    return {
      sourceDocumentId:
        typeof details.sourceDocumentId === "string"
          ? details.sourceDocumentId
          : undefined,
      fieldPath:
        typeof details.fieldPath === "string" ? details.fieldPath : undefined,
      translationGroupId:
        typeof details.translationGroupId === "string"
          ? details.translationGroupId
          : undefined,
      locale: typeof details.locale === "string" ? details.locale : undefined,
    };
  }
  return undefined;
}

export function resolveDeleteFailureState(error: unknown): {
  message: string;
  shouldCloseDialog: boolean;
  shouldReload: boolean;
  renderInDialog: boolean;
} {
  const message = readRuntimeErrorMessage(
    error,
    "Environment deletion failed.",
  );
  const statusCode = readRuntimeErrorStatus(error);
  return {
    message,
    shouldCloseDialog: statusCode === 404,
    shouldReload: statusCode === 404,
    renderInDialog: statusCode !== 404,
  };
}

export const PROMOTE_DEFAULT_STATE: EnvironmentPromoteState = {
  stage: "configure",
  sourceEnvironmentId: "",
  targetEnvironmentId: "",
  selectedDocumentIds: [],
  includeUnpublished: false,
  documents: [],
  documentsLoading: false,
  documentsError: null,
  preview: { status: "idle" },
  executing: false,
  executeError: null,
  executeResult: null,
};
