import type {
  ContentDocumentResponse,
  ContentVersionSummaryResponse,
  SchemaRegistryEntry,
  SchemaRegistryFieldSnapshot,
  StudioDocumentRouteMountContext,
  StudioMountContext,
  TranslationVariantSummary,
} from "@mdcms/shared";
import { RuntimeError } from "@mdcms/shared";

import {
  loadStudioDocumentShell,
  type StudioDocumentShell,
  type StudioDocumentShellData,
} from "../../document-shell.js";
import {
  createStudioDocumentRouteApi,
  type StudioDocumentRouteApi,
} from "../../document-route-api.js";
import {
  loadStudioSchemaState,
  type StudioSchemaState,
} from "../../schema-state.js";
import {
  diffDocumentVersions,
  type DocumentVersionDiff,
} from "../../document-version-diff.js";

export const SCHEMA_MISMATCH_WRITE_MESSAGE =
  "Schema changes detected. Studio is read-only until schema sync resolves the mismatch.";
const SCHEMA_WRITE_GUARD_CODES = new Set([
  "SCHEMA_HASH_MISMATCH",
  "SCHEMA_NOT_SYNCED",
]);

export type ContentDocumentSchemaReadyState = Extract<
  StudioSchemaState,
  {
    status: "ready";
  }
>;

export type ContentDocumentVersionHistoryState =
  | {
      status: "idle" | "loading" | "empty";
      versions: ContentVersionSummaryResponse[];
    }
  | {
      status: "error";
      versions: ContentVersionSummaryResponse[];
      message: string;
    }
  | {
      status: "ready";
      versions: ContentVersionSummaryResponse[];
    };

export type ContentDocumentVersionDiffState =
  | {
      status: "idle";
    }
  | {
      status: "loading";
      leftVersion: number;
      rightVersion: number;
    }
  | {
      status: "error";
      leftVersion: number;
      rightVersion: number;
      message: string;
    }
  | {
      status: "ready";
      diff: DocumentVersionDiff;
    };

export type ContentDocumentVersionComparison = {
  leftVersion?: number;
  rightVersion?: number;
};

export type ContentDocumentVariantCreationState = {
  targetLocale: string;
  sourceDocumentId: string;
  sourceLocale: string;
  status: "idle" | "creating";
  error?: string;
};

export type ContentDocumentPageReadyState = {
  status: "ready";
  typeId: string;
  typeLabel: string;
  documentId: string;
  locale: string;
  route: StudioDocumentRouteMountContext;
  schemaState?: StudioSchemaState;
  document: StudioDocumentShellData;
  draftBody: string;
  draftFrontmatter: Record<string, unknown>;
  saveState: "saved" | "saving" | "unsaved";
  mutationError?: string;
  fieldErrors?: Record<string, string>;
  saveRequestBody?: string;
  saveRequestFrontmatter?: Record<string, unknown>;
  canWrite: boolean;
  writeMessage?: string;
  /**
   * Mirrors `capabilities.ai.use` for the routed project/environment.
   * When false, the AI sidebar tab is hidden and inline transforms are
   * not requestable.
   */
  canAi?: boolean;
  canReadMedia: boolean;
  canUploadMedia: boolean;
  publishDialogOpen: boolean;
  publishChangeSummary: string;
  publishState: "idle" | "publishing";
  publishError?: string;
  // While a "Restore this version" action is in flight against the
  // POST /api/v1/content/:documentId/versions/:version/restore endpoint,
  // surface the in-flight state so the banner can disable the button and
  // show a spinner. The error is surfaced inline above the editor on
  // failure (mirrors the publishError convention).
  restoreVersionState: "idle" | "restoring";
  restoreVersionError?: string;
  versionHistory: ContentDocumentVersionHistoryState;
  selectedComparison: ContentDocumentVersionComparison;
  versionDiff: ContentDocumentVersionDiffState;
  translationVariants: TranslationVariantSummary[];
  localized: boolean;
  variantsFetchFailed: boolean;
  variantCreation?: ContentDocumentVariantCreationState;
  viewingVersion?: {
    version: number;
    body: string;
    status: "loading" | "ready" | "error";
    error?: string;
  };
};

export type ContentDocumentPageState =
  | {
      status: "loading";
      typeId: string;
      typeLabel: string;
      documentId: string;
      locale: string;
      route?: StudioDocumentRouteMountContext;
    }
  | {
      status: "forbidden" | "not-found" | "error";
      typeId: string;
      typeLabel: string;
      documentId: string;
      locale: string;
      route?: StudioDocumentRouteMountContext;
      message: string;
    }
  | ContentDocumentPageReadyState;

export type ContentDocumentRouteRequestToken = {
  documentId: string;
  initialEnvironment: string;
};

export type ContentDocumentPageStateInput = {
  shell: StudioDocumentShell;
  typeLabel: string;
  typeId?: string;
  documentRoute: StudioDocumentRouteMountContext;
  schemaState?: StudioSchemaState;
};

export type ContentDocumentPageReadyEvent =
  | {
      type: "draftChanged";
      body: string;
    }
  | {
      type: "frontmatterFieldChanged";
      fieldName: string;
      value: unknown;
    }
  | {
      type: "saveStarted";
    }
  | {
      type: "saveSucceeded";
      updatedAt: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      draftRevision?: number;
    }
  | {
      type: "saveFailed";
      message: string;
      fieldName?: string;
    };

/** Captures the routed document identity used to reject stale async results. */
export function createContentDocumentRouteRequestToken(input: {
  documentId: string;
  route: Pick<StudioDocumentRouteMountContext, "initialEnvironment">;
}): ContentDocumentRouteRequestToken {
  return {
    documentId: input.documentId,
    initialEnvironment: input.route.initialEnvironment,
  };
}

export function matchesContentDocumentRouteRequestToken(
  token: ContentDocumentRouteRequestToken,
  input: {
    documentId: string;
    route?: Pick<StudioDocumentRouteMountContext, "initialEnvironment">;
  },
): boolean {
  return (
    input.documentId === token.documentId &&
    input.route?.initialEnvironment === token.initialEnvironment
  );
}

type CreateContentDocumentPageHistoryApi = (input: {
  context: StudioMountContext;
  route: StudioDocumentRouteMountContext;
}) => Pick<StudioDocumentRouteApi, "listVersions" | "listVariants">;

export type ContentDocumentPropertyControl =
  | {
      kind: "string";
      value: string;
      canUnset: boolean;
    }
  | {
      kind: "number";
      value: number | undefined;
      canUnset: boolean;
    }
  | {
      kind: "boolean";
      value: boolean;
      canUnset: boolean;
      isUnset: boolean;
    }
  | {
      kind: "select";
      value: unknown;
      options: unknown[];
      canUnset: boolean;
    }
  | {
      kind: "file";
      value: string | null | undefined;
      preset: "image" | "video" | "file";
      accept: string[];
      canUnset: boolean;
    };

export type ContentDocumentPropertyDescriptor = {
  fieldName: string;
  field: SchemaRegistryFieldSnapshot;
  typeLabel: string;
  badgeLabel?: string;
  error?: string;
} & (
  | {
      status: "editable";
      control: ContentDocumentPropertyControl;
    }
  | {
      status: "unsupported";
    }
);

export const PROPERTY_SELECT_UNSET_VALUE = "__mdcms_unset__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...(frontmatter ?? {}) };
}

export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return left === right;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }

    return (
      left.length === right.length &&
      left.every((entry, index) => areJsonValuesEqual(entry, right[index]))
    );
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }

    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        areJsonValuesEqual(left[key], right[key]),
    );
  }

  return false;
}

export function isDraftPersisted(
  state: ContentDocumentPageReadyState,
): boolean {
  return (
    state.draftBody === state.document.body &&
    areJsonValuesEqual(state.draftFrontmatter, state.document.frontmatter)
  );
}

function hasDifferentSaveRequestSnapshot(input: {
  state: ContentDocumentPageReadyState;
  requestBody: string;
  requestFrontmatter: Record<string, unknown>;
}): boolean {
  return (
    input.state.saveRequestBody !== undefined &&
    (input.state.saveRequestBody !== input.requestBody ||
      !areJsonValuesEqual(
        input.state.saveRequestFrontmatter ?? {},
        input.requestFrontmatter,
      ))
  );
}

function clearFieldError(
  fieldErrors: Record<string, string> | undefined,
  fieldName: string,
): Record<string, string> | undefined {
  if (!fieldErrors?.[fieldName]) {
    return fieldErrors;
  }

  const nextErrors = { ...fieldErrors };
  delete nextErrors[fieldName];

  return Object.keys(nextErrors).length > 0 ? nextErrors : undefined;
}

function normalizeFrontmatterFieldCandidate(
  candidate: unknown,
): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return undefined;
  }

  if (!candidate.startsWith("frontmatter.")) {
    return undefined;
  }

  const normalized = candidate.slice("frontmatter.".length);
  const [fieldName] = normalized.split(/[.[\]]/, 1);

  return fieldName?.trim().length ? fieldName : undefined;
}

function mapErrorToFrontmatterField(error: unknown): string | undefined {
  if (!(error instanceof RuntimeError) || !isRecord(error.details)) {
    return undefined;
  }

  const directField = normalizeFrontmatterFieldCandidate(error.details.field);

  if (directField) {
    return directField;
  }

  const payload = error.details.payload;
  const payloadDetails = isRecord(payload) ? payload.details : undefined;

  return isRecord(payloadDetails)
    ? normalizeFrontmatterFieldCandidate(payloadDetails.field)
    : undefined;
}

function isUnsettableField(field: SchemaRegistryFieldSnapshot): boolean {
  return !field.required || field.nullable;
}

export function unsetFieldValue(
  field: SchemaRegistryFieldSnapshot,
): undefined | null {
  return field.nullable ? null : undefined;
}

function updateDraftFrontmatter(input: {
  frontmatter: Record<string, unknown>;
  fieldName: string;
  value: unknown;
}): Record<string, unknown> {
  const nextFrontmatter = { ...input.frontmatter };

  if (input.value === undefined) {
    delete nextFrontmatter[input.fieldName];
    return nextFrontmatter;
  }

  nextFrontmatter[input.fieldName] = input.value;
  return nextFrontmatter;
}

function getSchemaEntryForReadyState(
  state: ContentDocumentPageReadyState,
): SchemaRegistryEntry | undefined {
  if (state.schemaState?.status !== "ready") {
    return undefined;
  }

  return state.schemaState.entries.find((entry) => entry.type === state.typeId);
}

function getEnvironmentSpecificFieldLabel(
  state: ContentDocumentPageReadyState,
  fieldName: string,
): string | undefined {
  const targets =
    state.route.environmentFieldTargets?.[state.typeId]?.[fieldName];

  if (!targets?.includes(state.route.initialEnvironment)) {
    return undefined;
  }

  return `${targets.join(", ")} only`;
}

function canEditStringField(
  value: unknown,
): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

function canEditFileField(value: unknown): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

function canEditNumberField(
  value: unknown,
): value is number | undefined | null {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function canEditBooleanField(
  value: unknown,
): value is boolean | undefined | null {
  return value === undefined || value === null || typeof value === "boolean";
}

function canEditSelectField(
  field: SchemaRegistryFieldSnapshot,
  value: unknown,
): boolean {
  const options = field.options;

  if (!options || options.length === 0) {
    return false;
  }

  const supportsOptions = options.every(
    (option) =>
      option === null ||
      typeof option === "string" ||
      typeof option === "number" ||
      typeof option === "boolean",
  );

  if (!supportsOptions) {
    return false;
  }

  return (
    value === undefined ||
    value === null ||
    options.some((option) => areJsonValuesEqual(option, value))
  );
}

function describePropertyFieldType(field: SchemaRegistryFieldSnapshot): string {
  if (field.file) {
    return `file:${field.file.preset}`;
  }

  if (field.reference) {
    return `reference:${field.reference.targetType}`;
  }

  return field.kind;
}

function resolvePropertyDescriptor(input: {
  state: ContentDocumentPageReadyState;
  fieldName: string;
  field: SchemaRegistryFieldSnapshot;
}): ContentDocumentPropertyDescriptor {
  const badgeLabel = getEnvironmentSpecificFieldLabel(
    input.state,
    input.fieldName,
  );
  const error = input.state.fieldErrors?.[input.fieldName];
  const currentValue = input.state.draftFrontmatter[input.fieldName];
  const typeLabel = describePropertyFieldType(input.field);

  if (input.field.file && canEditFileField(currentValue)) {
    return {
      fieldName: input.fieldName,
      field: input.field,
      typeLabel,
      badgeLabel,
      error,
      status: "editable",
      control: {
        kind: "file",
        value: currentValue,
        preset: input.field.file.preset,
        accept: input.field.file.accept,
        canUnset: isUnsettableField(input.field),
      },
    };
  }

  if (input.field.options && canEditSelectField(input.field, currentValue)) {
    return {
      fieldName: input.fieldName,
      field: input.field,
      typeLabel,
      badgeLabel,
      error,
      status: "editable",
      control: {
        kind: "select",
        value: currentValue,
        options: input.field.options,
        canUnset: isUnsettableField(input.field),
      },
    };
  }

  if (input.field.kind === "string" && canEditStringField(currentValue)) {
    return {
      fieldName: input.fieldName,
      field: input.field,
      typeLabel,
      badgeLabel,
      error,
      status: "editable",
      control: {
        kind: "string",
        value: typeof currentValue === "string" ? currentValue : "",
        canUnset: isUnsettableField(input.field),
      },
    };
  }

  if (input.field.kind === "number" && canEditNumberField(currentValue)) {
    return {
      fieldName: input.fieldName,
      field: input.field,
      typeLabel,
      badgeLabel,
      error,
      status: "editable",
      control: {
        kind: "number",
        value: typeof currentValue === "number" ? currentValue : undefined,
        canUnset: isUnsettableField(input.field),
      },
    };
  }

  if (input.field.kind === "boolean" && canEditBooleanField(currentValue)) {
    return {
      fieldName: input.fieldName,
      field: input.field,
      typeLabel,
      badgeLabel,
      error,
      status: "editable",
      control: {
        kind: "boolean",
        value: currentValue === true,
        canUnset: isUnsettableField(input.field),
        isUnset: currentValue === undefined || currentValue === null,
      },
    };
  }

  return {
    fieldName: input.fieldName,
    field: input.field,
    typeLabel,
    badgeLabel,
    error,
    status: "unsupported",
  };
}

export function getPropertyDescriptors(
  state: ContentDocumentPageReadyState,
): ContentDocumentPropertyDescriptor[] {
  const entry = getSchemaEntryForReadyState(state);

  if (!entry) {
    return [];
  }

  return Object.entries(entry.resolvedSchema.fields).map(([fieldName, field]) =>
    resolvePropertyDescriptor({
      state,
      fieldName,
      field,
    }),
  );
}

export function createLoadingState(input: {
  typeId: string;
  typeLabel: string;
  documentId: string;
  locale?: string;
  route?: StudioDocumentRouteMountContext;
}): ContentDocumentPageState {
  return {
    status: "loading",
    typeId: input.typeId,
    typeLabel: input.typeLabel,
    documentId: input.documentId,
    locale: input.locale ?? "en",
    ...(input.route ? { route: input.route } : {}),
  };
}

function resolveContentDocumentAiCapability(input: {
  schemaState?: StudioSchemaState;
}): boolean {
  const schemaState = input.schemaState;

  if (!schemaState || schemaState.status !== "ready") {
    return false;
  }

  return schemaState.capabilities.ai.use === true;
}

function resolveContentDocumentMediaUploadCapability(input: {
  schemaState?: StudioSchemaState;
}): boolean {
  const schemaState = input.schemaState;

  if (!schemaState || schemaState.status !== "ready") {
    return false;
  }

  return schemaState.capabilities.media.upload === true;
}

function resolveContentDocumentMediaReadCapability(input: {
  schemaState?: StudioSchemaState;
}): boolean {
  const schemaState = input.schemaState;

  if (!schemaState || schemaState.status !== "ready") {
    return false;
  }

  return schemaState.capabilities.media.read === true;
}

export function resolveSchemaHashForAi(
  schemaState?: StudioSchemaState,
): string {
  if (!schemaState || schemaState.status !== "ready") {
    return "";
  }
  return schemaState.serverSchemaHash ?? schemaState.localSchemaHash ?? "";
}

function resolveContentDocumentWriteAccess(input: {
  route: StudioDocumentRouteMountContext;
  schemaState?: StudioSchemaState;
}): {
  canWrite: boolean;
  writeMessage?: string;
} {
  const routeWriteAccess = resolveRouteWriteAccess(input.route);
  const schemaState = input.schemaState;

  if (!schemaState) {
    return routeWriteAccess;
  }

  if (schemaState.status === "project-mismatch") {
    return {
      canWrite: false,
      writeMessage: `Studio is configured for project "${schemaState.configProject}" but the server resolved project "${schemaState.serverProject}".`,
    };
  }

  if (schemaState.status !== "ready") {
    return {
      canWrite: false,
      writeMessage: schemaState.message,
    };
  }

  if (hasSchemaRecoveryMismatch(schemaState)) {
    return {
      canWrite: false,
      writeMessage: SCHEMA_MISMATCH_WRITE_MESSAGE,
    };
  }

  return routeWriteAccess;
}

function resolveRouteWriteAccess(route: StudioDocumentRouteMountContext): {
  canWrite: boolean;
  writeMessage?: string;
} {
  return route.write.canWrite
    ? {
        canWrite: true,
      }
    : {
        canWrite: false,
        writeMessage: route.write.message,
      };
}

export function createErrorState(input: {
  status: "forbidden" | "not-found" | "error";
  typeId: string;
  typeLabel: string;
  documentId: string;
  locale?: string;
  route?: StudioDocumentRouteMountContext;
  message: string;
}): ContentDocumentPageState {
  return {
    status: input.status,
    typeId: input.typeId,
    typeLabel: input.typeLabel,
    documentId: input.documentId,
    locale: input.locale ?? "en",
    ...(input.route ? { route: input.route } : {}),
    message: input.message,
  };
}

function createReadyState(input: {
  shell: StudioDocumentShell;
  typeId: string;
  typeLabel: string;
  documentRoute: StudioDocumentRouteMountContext;
  schemaState?: StudioSchemaState;
}): ContentDocumentPageReadyState {
  const document = input.shell.data as StudioDocumentShellData;
  const writeAccess = resolveContentDocumentWriteAccess({
    route: input.documentRoute,
    schemaState: input.schemaState,
  });
  const canAi = resolveContentDocumentAiCapability({
    schemaState: input.schemaState,
  });
  const canReadMedia = resolveContentDocumentMediaReadCapability({
    schemaState: input.schemaState,
  });
  const canUploadMedia = resolveContentDocumentMediaUploadCapability({
    schemaState: input.schemaState,
  });

  return {
    status: "ready",
    typeId: input.typeId,
    typeLabel: input.typeLabel,
    documentId: input.shell.documentId,
    locale: document.locale ?? input.shell.locale,
    route: input.documentRoute,
    ...(input.schemaState ? { schemaState: input.schemaState } : {}),
    document,
    draftBody: document.body ?? "",
    draftFrontmatter: cloneFrontmatter(document.frontmatter),
    saveState: "saved",
    canWrite: writeAccess.canWrite,
    canAi,
    canReadMedia,
    canUploadMedia,
    publishDialogOpen: false,
    publishChangeSummary: "",
    publishState: "idle",
    restoreVersionState: "idle",
    versionHistory: {
      status: "idle",
      versions: [],
    },
    selectedComparison: {},
    versionDiff: {
      status: "idle",
    },
    translationVariants: [],
    localized: false,
    variantsFetchFailed: false,
    ...(writeAccess.writeMessage
      ? { writeMessage: writeAccess.writeMessage }
      : {}),
  };
}

function createVersionHistoryState(
  versions: ContentVersionSummaryResponse[],
): ContentDocumentVersionHistoryState {
  return versions.length === 0
    ? {
        status: "empty",
        versions: [],
      }
    : {
        status: "ready",
        versions,
      };
}

function createDefaultVersionComparison(
  versions: ContentVersionSummaryResponse[],
): ContentDocumentVersionComparison {
  if (versions.length < 2) {
    return {};
  }

  return {
    leftVersion: versions[1]?.version,
    rightVersion: versions[0]?.version,
  };
}

function isReadySchemaState(
  schemaState?: StudioSchemaState,
): schemaState is ContentDocumentSchemaReadyState {
  return schemaState?.status === "ready";
}

export function hasSchemaRecoveryMismatch(
  schemaState?: StudioSchemaState,
): schemaState is ContentDocumentSchemaReadyState {
  return (
    isReadySchemaState(schemaState) &&
    (schemaState.isMismatch ||
      (schemaState.localSchemaHash !== undefined &&
        schemaState.serverSchemaHash === undefined))
  );
}

function isSchemaGuardRuntimeError(error: unknown): error is RuntimeError {
  return (
    error instanceof RuntimeError && SCHEMA_WRITE_GUARD_CODES.has(error.code)
  );
}

export function formatSchemaRecoveryHash(hash?: string): string {
  return hash?.trim().length ? hash : "Not synced";
}

type SchemaGuardLogger = (message: string, error: unknown) => void;

function defaultSchemaGuardLogger(message: string, error: unknown): void {
  console.error(message, error);
}

export async function reloadSchemaStateForGuard(
  state: ContentDocumentPageReadyState,
  logError: SchemaGuardLogger = defaultSchemaGuardLogger,
): Promise<StudioSchemaState | undefined> {
  if (!isReadySchemaState(state.schemaState)) {
    return undefined;
  }

  try {
    return await state.schemaState.reload();
  } catch (error) {
    logError("reloadSchemaStateForGuard failed", error);
    return undefined;
  }
}

export async function syncSchemaStateForGuard(
  schemaState: ContentDocumentSchemaReadyState,
  logError: SchemaGuardLogger = defaultSchemaGuardLogger,
): Promise<StudioSchemaState | undefined> {
  try {
    return await schemaState.sync();
  } catch (error) {
    logError("syncSchemaStateForGuard failed", error);
    return undefined;
  }
}

function createGuardedSchemaRecoveryState(input: {
  state: ContentDocumentPageReadyState;
  error: RuntimeError;
  reloadedSchemaState?: StudioSchemaState;
}): ContentDocumentSchemaReadyState | undefined {
  const baseState = isReadySchemaState(input.reloadedSchemaState)
    ? input.reloadedSchemaState
    : isReadySchemaState(input.state.schemaState)
      ? input.state.schemaState
      : undefined;

  if (!baseState) {
    return undefined;
  }

  return {
    ...baseState,
    isMismatch: true,
    serverSchemaHash:
      input.error.code === "SCHEMA_NOT_SYNCED"
        ? undefined
        : baseState.serverSchemaHash,
    entries: input.error.code === "SCHEMA_NOT_SYNCED" ? [] : baseState.entries,
    syncError: undefined,
  };
}

export function applyGuardedDraftSaveFailureToReadyState(input: {
  state: ContentDocumentPageReadyState;
  schemaState: ContentDocumentSchemaReadyState;
}): ContentDocumentPageReadyState {
  const nextState = applySchemaStateToReadyState(input);

  return {
    ...nextState,
    saveState: isDraftPersisted(input.state) ? "saved" : "unsaved",
    mutationError: undefined,
    fieldErrors: undefined,
    saveRequestBody: undefined,
    saveRequestFrontmatter: undefined,
  };
}

export function applyGuardedPublishFailureToReadyState(input: {
  state: ContentDocumentPageReadyState;
  schemaState: ContentDocumentSchemaReadyState;
}): ContentDocumentPageReadyState {
  return {
    ...applySchemaStateToReadyState(input),
    publishDialogOpen: false,
    publishState: "idle",
    publishError: undefined,
  };
}

export function applySchemaStateToReadyState(input: {
  state: ContentDocumentPageReadyState;
  schemaState: StudioSchemaState;
}): ContentDocumentPageReadyState {
  const writeAccess = resolveContentDocumentWriteAccess({
    route: input.state.route,
    schemaState: input.schemaState,
  });
  const canAi = resolveContentDocumentAiCapability({
    schemaState: input.schemaState,
  });
  const canReadMedia = resolveContentDocumentMediaReadCapability({
    schemaState: input.schemaState,
  });
  const canUploadMedia = resolveContentDocumentMediaUploadCapability({
    schemaState: input.schemaState,
  });

  return {
    ...input.state,
    schemaState: input.schemaState,
    canWrite: writeAccess.canWrite,
    canAi,
    canReadMedia,
    canUploadMedia,
    writeMessage: writeAccess.writeMessage,
  };
}

function createVersionHistoryErrorState(
  message: string,
): ContentDocumentVersionHistoryState {
  return {
    status: "error",
    versions: [],
    message,
  };
}

export function resetVersionDiffState(): ContentDocumentVersionDiffState {
  return {
    status: "idle",
  };
}

function normalizeOptionalChangeSummary(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function parseSelectedComparisonVersionValue(
  value: string,
): number | undefined {
  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  const nextVersion = Number(normalized);
  return Number.isInteger(nextVersion) && nextVersion > 0
    ? nextVersion
    : undefined;
}

export function toRouteErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return fallback;
}

function applyDocumentResponseToReadyState(
  state: ContentDocumentPageReadyState,
  document: ContentDocumentResponse,
): ContentDocumentPageReadyState {
  return {
    ...state,
    locale: document.locale,
    document,
    draftBody: document.body ?? "",
    draftFrontmatter: cloneFrontmatter(document.frontmatter),
    saveState: "saved",
    mutationError: undefined,
    fieldErrors: undefined,
    saveRequestBody: undefined,
    saveRequestFrontmatter: undefined,
  };
}

export function createContentDocumentRouteApi(input: {
  context: StudioMountContext;
  route: StudioDocumentRouteMountContext;
}): StudioDocumentRouteApi {
  return createStudioDocumentRouteApi(
    {
      project: input.route.project,
      environment: input.route.initialEnvironment,
      serverUrl: input.context.apiBaseUrl,
    },
    {
      auth: input.context.auth,
    },
  );
}

export async function publishContentDocumentReadyState(input: {
  api: Pick<StudioDocumentRouteApi, "publish" | "listVersions">;
  state: ContentDocumentPageReadyState;
  changeSummary?: string;
}): Promise<ContentDocumentPageReadyState> {
  if (!input.state.canWrite) {
    return input.state;
  }

  const changeSummary = normalizeOptionalChangeSummary(input.changeSummary);
  let document: ContentDocumentResponse;

  try {
    document = await input.api.publish({
      documentId: input.state.documentId,
      locale: input.state.document.locale,
      changeSummary,
    });
  } catch (error) {
    if (isSchemaGuardRuntimeError(error)) {
      const schemaState = createGuardedSchemaRecoveryState({
        state: input.state,
        error,
        reloadedSchemaState: await reloadSchemaStateForGuard(input.state),
      });

      if (schemaState) {
        return applyGuardedPublishFailureToReadyState({
          state: input.state,
          schemaState,
        });
      }
    }

    throw error;
  }

  const nextState = {
    ...applyDocumentResponseToReadyState(input.state, document),
    publishDialogOpen: false,
    publishChangeSummary: "",
    publishState: "idle" as const,
    publishError: undefined,
  };

  try {
    const versionHistoryResponse = await input.api.listVersions({
      documentId: input.state.documentId,
      locale: input.state.document.locale,
    });

    return {
      ...nextState,
      versionHistory: createVersionHistoryState(versionHistoryResponse.data),
      selectedComparison: createDefaultVersionComparison(
        versionHistoryResponse.data,
      ),
      versionDiff: resetVersionDiffState(),
    };
  } catch (error) {
    return {
      ...nextState,
      versionHistory: createVersionHistoryErrorState(
        toRouteErrorMessage(error, "Failed to refresh version history."),
      ),
      selectedComparison: {},
      versionDiff: resetVersionDiffState(),
    };
  }
}

export function applySuccessfulPublishToReadyState(input: {
  state: ContentDocumentPageReadyState;
  requestBody: string;
  requestFrontmatter?: Record<string, unknown>;
  publishedState: ContentDocumentPageReadyState;
}): ContentDocumentPageReadyState {
  const requestFrontmatter =
    input.requestFrontmatter ?? input.state.draftFrontmatter;

  if (
    input.state.draftBody === input.requestBody &&
    areJsonValuesEqual(input.state.draftFrontmatter, requestFrontmatter)
  ) {
    return input.publishedState;
  }

  return {
    ...input.publishedState,
    draftBody: input.state.draftBody,
    draftFrontmatter: input.state.draftFrontmatter,
    saveState:
      input.state.draftBody === input.publishedState.document.body &&
      areJsonValuesEqual(
        input.state.draftFrontmatter,
        input.publishedState.document.frontmatter,
      )
        ? "saved"
        : "unsaved",
    mutationError: input.state.mutationError,
    fieldErrors: input.state.fieldErrors,
    saveRequestBody: input.state.saveRequestBody,
    saveRequestFrontmatter: input.state.saveRequestFrontmatter,
  };
}

export async function loadContentDocumentVersionDiff(input: {
  api: Pick<StudioDocumentRouteApi, "getVersion">;
  documentId: string;
  locale: string;
  leftVersion: number;
  rightVersion: number;
}): Promise<DocumentVersionDiff> {
  const [leftVersion, rightVersion] = await Promise.all([
    input.api.getVersion({
      documentId: input.documentId,
      locale: input.locale,
      version: input.leftVersion,
    }),
    input.api.getVersion({
      documentId: input.documentId,
      locale: input.locale,
      version: input.rightVersion,
    }),
  ]);

  return diffDocumentVersions(leftVersion, rightVersion);
}

export async function loadContentDocumentPageState(input: {
  context?: StudioMountContext;
  typeId: string;
  typeLabel: string;
  documentId: string;
  loadDocumentShell?: typeof loadStudioDocumentShell;
  loadSchemaState?: typeof loadStudioSchemaState;
  createRouteApi?: CreateContentDocumentPageHistoryApi;
}): Promise<ContentDocumentPageState> {
  const route = input.context?.documentRoute;

  if (!input.context || !route) {
    return createErrorState({
      status: "error",
      typeId: input.typeId,
      typeLabel: input.typeLabel,
      documentId: input.documentId,
      message: "Studio document route context is unavailable.",
    });
  }

  const loadDocumentShell = input.loadDocumentShell ?? loadStudioDocumentShell;
  const loadSchemaState = input.loadSchemaState ?? loadStudioSchemaState;
  const routeApiFactory = input.createRouteApi ?? createContentDocumentRouteApi;
  const shell = await loadDocumentShell(
    {
      project: route.project,
      environment: route.initialEnvironment,
      serverUrl: input.context.apiBaseUrl,
    },
    {
      type: input.typeId,
      documentId: input.documentId,
    },
    {
      auth: input.context.auth,
    },
  );

  const nextState = createContentDocumentPageState({
    shell,
    typeId: input.typeId,
    typeLabel: input.typeLabel,
    documentRoute: route,
  });

  if (nextState.status !== "ready") {
    return nextState;
  }

  const schemaState = await loadSchemaState({
    config: {
      project: route.project,
      environment: route.initialEnvironment,
      serverUrl: input.context.apiBaseUrl,
    },
    auth: input.context.auth,
    // Forward the host-precomputed hash so initial-load mismatch detection
    // matches the autosave guard's view. Without this the schema-recovery
    // banner only appears after the first save round-trips through the
    // server and comes back as SCHEMA_HASH_MISMATCH.
    ...(route.write.canWrite
      ? { precomputedLocalSchemaHash: route.write.schemaHash }
      : {}),
  });
  const readyState = applySchemaStateToReadyState({
    state: nextState,
    schemaState,
  });

  let translationVariants: TranslationVariantSummary[] = [];
  let localized = false;
  let variantsFetchFailed = false;

  if (schemaState.status === "ready") {
    const typeEntry = schemaState.entries.find((e) => e.type === input.typeId);
    localized = typeEntry?.localized ?? false;
  }

  // Fallback: if schema entries are empty (e.g., SCHEMA_NOT_SYNCED) but the
  // document has a real locale and supportedLocales is configured, infer the
  // type is localized so the switcher still appears for read-only navigation.
  if (
    !localized &&
    route.supportedLocales &&
    route.supportedLocales.length > 0 &&
    readyState.locale !== "__mdcms_default__"
  ) {
    localized = true;
  }

  if (
    localized &&
    route.supportedLocales &&
    route.supportedLocales.length > 0
  ) {
    try {
      const routeApi = routeApiFactory({
        context: input.context,
        route,
      });
      const variantsResponse = await routeApi.listVariants({
        documentId: input.documentId,
      });
      translationVariants = variantsResponse.data;

      // Ensure the current document always appears in the variants list
      // even if RBAC path filtering omitted it from the server response.
      if (
        !translationVariants.some((v) => v.documentId === readyState.documentId)
      ) {
        translationVariants = [
          {
            documentId: readyState.documentId,
            locale: readyState.locale,
            path: readyState.document.path,
            publishedVersion: readyState.document.publishedVersion,
            hasUnpublishedChanges: readyState.document.hasUnpublishedChanges,
          },
          ...translationVariants,
        ];
      }
    } catch {
      // Degrade gracefully — include the current document so its locale
      // is never shown as missing, and flag the failure so the UI
      // suppresses creation affordances for unverified locales.
      translationVariants = [
        {
          documentId: readyState.documentId,
          locale: readyState.locale,
          path: readyState.document.path,
          publishedVersion: readyState.document.publishedVersion,
          hasUnpublishedChanges: readyState.document.hasUnpublishedChanges,
        },
      ];
      variantsFetchFailed = true;
    }
  }

  const versionState = await loadContentDocumentVersionHistoryState({
    api: routeApiFactory({
      context: input.context,
      route,
    }),
    state: readyState,
  });

  return {
    ...readyState,
    translationVariants,
    localized,
    variantsFetchFailed,
    ...versionState,
  };
}

export async function saveContentDocumentReadyState(input: {
  api: Pick<StudioDocumentRouteApi, "updateDraft">;
  route: StudioDocumentRouteMountContext;
  state: ContentDocumentPageReadyState;
}): Promise<ContentDocumentPageReadyState> {
  if (
    !input.route.write.canWrite ||
    !input.state.canWrite ||
    input.state.saveState !== "unsaved" ||
    isDraftPersisted(input.state) ||
    (input.state.saveRequestBody === input.state.draftBody &&
      areJsonValuesEqual(
        input.state.saveRequestFrontmatter ?? {},
        input.state.draftFrontmatter,
      ))
  ) {
    return input.state;
  }

  const savingState = reduceContentDocumentPageReadyState(input.state, {
    type: "saveStarted",
  });

  try {
    const result = await input.api.updateDraft({
      documentId: input.state.documentId,
      locale: input.state.document.locale,
      payload: {
        body: input.state.draftBody,
        frontmatter: input.state.draftFrontmatter,
      },
      schemaHash: input.route.write.schemaHash,
    });

    return reduceContentDocumentPageReadyState(savingState, {
      type: "saveSucceeded",
      body: result.body ?? input.state.draftBody,
      frontmatter: result.frontmatter ?? input.state.draftFrontmatter,
      updatedAt: result.updatedAt ?? input.state.document.updatedAt,
      draftRevision: result.draftRevision,
    });
  } catch (error) {
    if (isSchemaGuardRuntimeError(error)) {
      const schemaState = createGuardedSchemaRecoveryState({
        state: savingState,
        error,
        reloadedSchemaState: await reloadSchemaStateForGuard(savingState),
      });

      if (schemaState) {
        return applyGuardedDraftSaveFailureToReadyState({
          state: savingState,
          schemaState,
        });
      }
    }

    return reduceContentDocumentPageReadyState(savingState, {
      type: "saveFailed",
      message: toRouteErrorMessage(error, "Failed to save draft."),
      fieldName: mapErrorToFrontmatterField(error),
    });
  }
}

export async function loadContentDocumentVersionHistoryState(input: {
  api: Pick<StudioDocumentRouteApi, "listVersions">;
  state: ContentDocumentPageReadyState;
}): Promise<{
  versionHistory: ContentDocumentVersionHistoryState;
  selectedComparison: ContentDocumentVersionComparison;
  versionDiff: ContentDocumentVersionDiffState;
}> {
  try {
    const response = await input.api.listVersions({
      documentId: input.state.documentId,
      locale: input.state.document.locale,
    });

    return {
      versionHistory: createVersionHistoryState(response.data),
      selectedComparison: createDefaultVersionComparison(response.data),
      versionDiff: resetVersionDiffState(),
    };
  } catch (error) {
    return {
      versionHistory: createVersionHistoryErrorState(
        toRouteErrorMessage(error, "Failed to load version history."),
      ),
      selectedComparison: {},
      versionDiff: resetVersionDiffState(),
    };
  }
}

function getForbiddenMessage(): string {
  return "You do not have access to this document draft.";
}

function getNotFoundMessage(): string {
  return "Document not found.";
}

export function createContentDocumentPageState(
  input: ContentDocumentPageStateInput,
): ContentDocumentPageState {
  const typeId = input.typeId ?? input.typeLabel;

  if (input.shell.state === "loading") {
    return createLoadingState({
      typeId,
      typeLabel: input.typeLabel,
      documentId: input.shell.documentId,
      locale: input.shell.locale,
      route: input.documentRoute,
    });
  }

  if (input.shell.state === "error") {
    if (
      input.shell.errorCode === "FORBIDDEN" ||
      input.shell.errorCode === "UNAUTHORIZED"
    ) {
      return createErrorState({
        status: "forbidden",
        typeId,
        typeLabel: input.typeLabel,
        documentId: input.shell.documentId,
        locale: input.shell.locale,
        route: input.documentRoute,
        message: getForbiddenMessage(),
      });
    }

    if (input.shell.errorCode === "NOT_FOUND") {
      return createErrorState({
        status: "not-found",
        typeId,
        typeLabel: input.typeLabel,
        documentId: input.shell.documentId,
        locale: input.shell.locale,
        route: input.documentRoute,
        message: getNotFoundMessage(),
      });
    }

    return createErrorState({
      status: "error",
      typeId,
      typeLabel: input.typeLabel,
      documentId: input.shell.documentId,
      locale: input.shell.locale,
      route: input.documentRoute,
      message: input.shell.errorMessage || "Failed to load document draft.",
    });
  }

  return createReadyState({
    shell: input.shell,
    typeId,
    typeLabel: input.typeLabel,
    documentRoute: input.documentRoute,
    schemaState: input.schemaState,
  });
}

export function reduceContentDocumentPageReadyState(
  state: ContentDocumentPageReadyState,
  event: ContentDocumentPageReadyEvent,
): ContentDocumentPageReadyState {
  switch (event.type) {
    case "draftChanged": {
      const isPersisted =
        event.body === state.document.body &&
        areJsonValuesEqual(state.draftFrontmatter, state.document.frontmatter);

      return {
        ...state,
        draftBody: event.body,
        saveState: isPersisted ? "saved" : "unsaved",
        mutationError: undefined,
        saveRequestBody: undefined,
        saveRequestFrontmatter: undefined,
      };
    }
    case "frontmatterFieldChanged": {
      const draftFrontmatter = updateDraftFrontmatter({
        frontmatter: state.draftFrontmatter,
        fieldName: event.fieldName,
        value: event.value,
      });
      const isPersisted =
        state.draftBody === state.document.body &&
        areJsonValuesEqual(draftFrontmatter, state.document.frontmatter);

      return {
        ...state,
        draftFrontmatter,
        saveState: isPersisted ? "saved" : "unsaved",
        mutationError: undefined,
        fieldErrors: clearFieldError(state.fieldErrors, event.fieldName),
        saveRequestBody: undefined,
        saveRequestFrontmatter: undefined,
      };
    }
    case "saveStarted": {
      if (!state.canWrite || isDraftPersisted(state)) {
        return state;
      }

      return {
        ...state,
        saveState: "saving",
        mutationError: undefined,
        fieldErrors: undefined,
        saveRequestBody: state.draftBody,
        saveRequestFrontmatter: state.draftFrontmatter,
      };
    }
    case "saveSucceeded": {
      const requestBody = state.saveRequestBody ?? state.draftBody;
      const requestFrontmatter =
        state.saveRequestFrontmatter ?? state.draftFrontmatter;
      const savedBody = event.body ?? requestBody;
      const savedFrontmatter = event.frontmatter ?? requestFrontmatter;
      const draftBody =
        state.draftBody === requestBody ? savedBody : state.draftBody;
      const draftFrontmatter = areJsonValuesEqual(
        state.draftFrontmatter,
        requestFrontmatter,
      )
        ? cloneFrontmatter(savedFrontmatter)
        : state.draftFrontmatter;

      return {
        ...state,
        document: {
          ...state.document,
          frontmatter: cloneFrontmatter(savedFrontmatter),
          body: savedBody,
          hasUnpublishedChanges: true,
          updatedAt: event.updatedAt,
          ...(typeof event.draftRevision === "number"
            ? { draftRevision: event.draftRevision }
            : {}),
        },
        draftBody,
        draftFrontmatter,
        saveState:
          draftBody === savedBody &&
          areJsonValuesEqual(draftFrontmatter, savedFrontmatter)
            ? "saved"
            : "unsaved",
        mutationError: undefined,
        fieldErrors: undefined,
        saveRequestBody: undefined,
        saveRequestFrontmatter: undefined,
      };
    }
    case "saveFailed": {
      const fieldErrors = event.fieldName
        ? {
            [event.fieldName]: event.message,
          }
        : undefined;

      return {
        ...state,
        saveState: isDraftPersisted(state) ? "saved" : "unsaved",
        mutationError: event.fieldName ? undefined : event.message,
        fieldErrors,
        saveRequestBody: undefined,
        saveRequestFrontmatter: undefined,
      };
    }
  }
}

export function applySuccessfulDraftSaveToReadyState(input: {
  state: ContentDocumentPageReadyState;
  requestBody: string;
  requestFrontmatter?: Record<string, unknown>;
  persistedBody?: string;
  persistedFrontmatter?: Record<string, unknown>;
  updatedAt: string;
  draftRevision?: number;
}): ContentDocumentPageReadyState {
  const requestFrontmatter =
    input.requestFrontmatter ??
    input.state.saveRequestFrontmatter ??
    input.state.draftFrontmatter;
  const hasNewerSaveInFlight = hasDifferentSaveRequestSnapshot({
    state: input.state,
    requestBody: input.requestBody,
    requestFrontmatter,
  });
  const persistedBody = input.persistedBody ?? input.requestBody;
  const persistedFrontmatter = input.persistedFrontmatter ?? requestFrontmatter;
  const draftBody =
    input.state.draftBody === input.requestBody
      ? persistedBody
      : input.state.draftBody;
  const draftFrontmatter = areJsonValuesEqual(
    input.state.draftFrontmatter,
    requestFrontmatter,
  )
    ? cloneFrontmatter(persistedFrontmatter)
    : input.state.draftFrontmatter;

  return {
    ...input.state,
    document: {
      ...input.state.document,
      frontmatter: cloneFrontmatter(persistedFrontmatter),
      body: persistedBody,
      hasUnpublishedChanges: true,
      updatedAt: input.updatedAt,
      ...(typeof input.draftRevision === "number"
        ? { draftRevision: input.draftRevision }
        : {}),
    },
    draftBody,
    draftFrontmatter,
    mutationError: undefined,
    fieldErrors: undefined,
    saveRequestBody: hasNewerSaveInFlight
      ? input.state.saveRequestBody
      : undefined,
    saveRequestFrontmatter: hasNewerSaveInFlight
      ? input.state.saveRequestFrontmatter
      : undefined,
    saveState: hasNewerSaveInFlight
      ? input.state.saveState
      : draftBody === persistedBody &&
          areJsonValuesEqual(draftFrontmatter, persistedFrontmatter)
        ? "saved"
        : "unsaved",
  };
}

export function applyAssistantProposalDocumentToReadyState(input: {
  state: ContentDocumentPageReadyState;
  document: {
    documentId: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    draftRevision?: number;
    updatedAt?: string;
    hasUnpublishedChanges?: boolean;
  };
}): ContentDocumentPageReadyState {
  if (input.document.documentId !== input.state.documentId) {
    return input.state;
  }

  const draftFrontmatter = cloneFrontmatter(
    input.document.frontmatter ?? input.state.draftFrontmatter,
  );

  return {
    ...input.state,
    document: {
      ...input.state.document,
      body: input.document.body,
      frontmatter: draftFrontmatter,
      hasUnpublishedChanges: input.document.hasUnpublishedChanges ?? true,
      ...(typeof input.document.draftRevision === "number"
        ? { draftRevision: input.document.draftRevision }
        : {}),
      ...(input.document.updatedAt
        ? { updatedAt: input.document.updatedAt }
        : {}),
    },
    draftBody: input.document.body,
    draftFrontmatter,
    saveState: "saved",
    mutationError: undefined,
    fieldErrors: undefined,
    saveRequestBody: undefined,
    saveRequestFrontmatter: undefined,
    viewingVersion: undefined,
  };
}

export function applyFailedDraftSaveToReadyState(input: {
  state: ContentDocumentPageReadyState;
  requestBody: string;
  requestFrontmatter?: Record<string, unknown>;
  message: string;
  fieldName?: string;
}): ContentDocumentPageReadyState {
  const requestFrontmatter =
    input.requestFrontmatter ??
    input.state.saveRequestFrontmatter ??
    input.state.draftFrontmatter;

  if (
    hasDifferentSaveRequestSnapshot({
      state: input.state,
      requestBody: input.requestBody,
      requestFrontmatter,
    })
  ) {
    return input.state;
  }

  return {
    ...input.state,
    saveState: isDraftPersisted(input.state) ? "saved" : "unsaved",
    mutationError: input.fieldName ? undefined : input.message,
    fieldErrors: input.fieldName
      ? {
          [input.fieldName]: input.message,
        }
      : undefined,
    saveRequestBody: undefined,
    saveRequestFrontmatter: undefined,
  };
}

export function filterLocaleOptions(input: {
  supportedLocales: string[];
  translationVariants: TranslationVariantSummary[];
  canWrite: boolean;
  variantsFetchFailed: boolean;
}): Array<{ locale: string; hasVariant: boolean }> {
  return input.supportedLocales.flatMap((loc) => {
    const hasVariant = input.translationVariants.some((v) => v.locale === loc);
    if (!hasVariant && !(input.canWrite && !input.variantsFetchFailed)) {
      return [];
    }
    return [{ locale: loc, hasVariant }];
  });
}

export function resolveActiveDocumentRouteContext(
  route: StudioDocumentRouteMountContext,
  environment: string | null | undefined,
): StudioDocumentRouteMountContext {
  const nextEnvironment = environment?.trim();

  if (!nextEnvironment || nextEnvironment === route.initialEnvironment) {
    return route;
  }

  return {
    ...route,
    initialEnvironment: nextEnvironment,
    write: route.writeByEnvironment?.[nextEnvironment] ?? {
      canWrite: false,
      message: `Studio writes require a resolved schema for environment "${nextEnvironment}".`,
    },
  };
}
