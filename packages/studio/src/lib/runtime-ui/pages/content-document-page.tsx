"use client";

import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  appendMdcmsPreviewTokenToUrl,
  type MdcmsPreviewDocument,
  type StudioDocumentRouteMountContext,
  type StudioMountContext,
} from "@mdcms/shared";

import type { StudioDocumentRouteApi } from "../../document-route-api.js";
import type { StudioSchemaState } from "../../schema-state.js";
import { useStudioMountInfo } from "../app/admin/mount-info-context.js";
import { useParams, useRouter } from "../adapters/next-navigation.js";
import {
  MdxPropsPanel,
  type MdxPropsPanelSelection,
} from "../components/editor/mdx-props-panel.js";
import {
  TipTapEditor,
  type TipTapEditorHandle,
  type TipTapEditorSelectionInfo,
} from "../components/editor/tiptap-editor.js";
import { InlineAiBubble } from "../components/editor/inline-ai-bubble.js";
import {
  createStudioAiRouteApi,
  type StudioAiRouteApi,
} from "../../ai-route-api.js";
import { BreadcrumbTrail } from "../components/layout/page-header.js";
import { AssistantLauncher } from "../components/assistant/assistant-launcher.js";
import {
  ASSISTANT_PROPOSAL_APPLIED_EVENT,
  AssistantActiveDocumentProvider,
  type AssistantProposalAppliedEventDetail,
  useAssistant,
  type AssistantActiveDocument,
} from "../components/assistant/assistant-context.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip.js";
import {
  Check,
  ExternalLink,
  Globe,
  Monitor,
  PanelRight,
  PanelRightClose,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { cn } from "../lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import {
  PROPERTY_SELECT_UNSET_VALUE,
  SCHEMA_MISMATCH_WRITE_MESSAGE,
  areJsonValuesEqual,
  applyAssistantProposalDocumentToReadyState,
  applyGuardedDraftSaveFailureToReadyState,
  applyGuardedPublishFailureToReadyState,
  applyFailedDraftSaveToReadyState,
  applySchemaStateToReadyState,
  applySuccessfulDraftSaveToReadyState,
  applySuccessfulPublishToReadyState,
  cloneFrontmatter,
  createContentDocumentRouteApi,
  createContentDocumentRouteRequestToken,
  createErrorState,
  createLoadingState,
  filterLocaleOptions,
  formatSchemaRecoveryHash,
  getPropertyDescriptors,
  hasSchemaRecoveryMismatch,
  isDraftPersisted,
  loadContentDocumentPageState,
  loadContentDocumentVersionHistoryState,
  loadContentDocumentVersionDiff,
  matchesContentDocumentRouteRequestToken,
  publishContentDocumentReadyState,
  reduceContentDocumentPageReadyState,
  resetVersionDiffState,
  resolveActiveDocumentRouteContext,
  resolveSchemaHashForAi,
  saveContentDocumentReadyState,
  syncSchemaStateForGuard,
  toRouteErrorMessage,
  unsetFieldValue,
  type ContentDocumentPageReadyState,
  type ContentDocumentPageState,
} from "./content-document-page-state.js";
import {
  resolveDocumentPreviewRoute,
  type DocumentPreviewRouteResolution,
} from "./document-preview-route.js";

const DOCUMENT_SAVE_DEBOUNCE_MS = 5000;

type ContentDocumentPreviewMode = "edit" | "split" | "preview";

const CONTENT_DOCUMENT_PREVIEW_MODE_QUERY_PARAM = "previewMode";
export const LIVE_PREVIEW_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-same-origin";

function isContentDocumentPreviewMode(
  value: unknown,
): value is ContentDocumentPreviewMode {
  return value === "edit" || value === "split" || value === "preview";
}

export function readContentDocumentPreviewModeSearchParam(
  search: string,
): ContentDocumentPreviewMode | undefined {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const mode = params.get(CONTENT_DOCUMENT_PREVIEW_MODE_QUERY_PARAM);

  return isContentDocumentPreviewMode(mode) ? mode : undefined;
}

export function writeContentDocumentPreviewModeSearchParam(
  search: string,
  mode: ContentDocumentPreviewMode,
): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  params.set(CONTENT_DOCUMENT_PREVIEW_MODE_QUERY_PARAM, mode);

  const serialized = params.toString();

  return serialized ? `?${serialized}` : "";
}

function readBrowserContentDocumentPreviewMode():
  | ContentDocumentPreviewMode
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return readContentDocumentPreviewModeSearchParam(window.location.search);
}

function replaceBrowserContentDocumentPreviewMode(
  mode: ContentDocumentPreviewMode,
) {
  if (typeof window === "undefined") {
    return;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.search = writeContentDocumentPreviewModeSearchParam(
    window.location.search,
    mode,
  );

  window.history.replaceState(
    window.history.state,
    "",
    `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
  );
}

function useLatestCallback<Args extends unknown[], Return>(
  callback: (...args: Args) => Return,
): (...args: Args) => Return {
  const callbackRef = useRef(callback);

  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

type ContentDocumentPageViewProps = {
  state: ContentDocumentPageState;
  context?: StudioMountContext;
  sidebarOpen?: boolean;
  activeMdxComponent?: MdxPropsPanelSelection | null;
  onDraftChange?: (body: string) => void;
  onFrontmatterFieldChange?: (fieldName: string, value: unknown) => void;
  onActiveMdxComponentChange?: (
    selection: MdxPropsPanelSelection | null,
  ) => void;
  onToggleSidebar?: () => void;
  onGoBack?: () => void;
  onPublishDialogOpenChange?: (open: boolean) => void;
  onPublishChangeSummaryChange?: (value: string) => void;
  onPublishSubmit?: () => void;
  /** Persist the current draft immediately, bypassing the auto-save debounce. */
  onSaveNow?: () => void;
  onSchemaSync?: () => void;
  onSelectComparisonVersion?: (
    side: "left" | "right",
    version?: number,
  ) => void;
  editorRef?: React.Ref<TipTapEditorHandle>;
  onViewVersion?: (version: number) => void;
  onBackToDraft?: () => void;
  onRestoreVersion?: (version: number) => void;
  onLocaleSwitch?: (locale: string) => void;
  onCreateVariant?: (prefill: boolean) => void;
  onCancelVariantCreation?: () => void;
  aiSelection?: TipTapEditorSelectionInfo | null;
  onAiSelectionChange?: (selection: TipTapEditorSelectionInfo | null) => void;
  aiApi?: StudioAiRouteApi;
  previewTokenApi?: Pick<StudioDocumentRouteApi, "createPreviewToken">;
  onAiProposalApplied?: (input: {
    bodyAfter: string;
    documentId?: string;
    frontmatterAfter?: Record<string, unknown>;
    draftRevision?: number;
    updatedAt?: string;
  }) => void;
  previewMode?: ContentDocumentPreviewMode;
  onPreviewModeChange?: (mode: ContentDocumentPreviewMode) => void;
  onPreviewRefresh?: () => boolean | Promise<boolean>;
};

type LivePreviewViewportSize = "mobile" | "tablet" | "desktop";

const LIVE_PREVIEW_VIEWPORT_PRESETS: Record<
  LivePreviewViewportSize,
  { label: string; width: number }
> = {
  mobile: { label: "Mobile", width: 390 },
  tablet: { label: "Tablet", width: 768 },
  desktop: { label: "Desktop", width: 1280 },
};

type LivePreviewViewportFrame = {
  targetWidth: number;
  visualWidth: number;
  scale: number;
  heightPercent: number;
};

function roundViewportNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function getLivePreviewViewportFrame(
  size: LivePreviewViewportSize,
  availableWidth: number,
): LivePreviewViewportFrame {
  const targetWidth = LIVE_PREVIEW_VIEWPORT_PRESETS[size].width;
  const hasMeasuredWidth =
    Number.isFinite(availableWidth) && availableWidth > 0;
  const visualWidth = hasMeasuredWidth
    ? Math.min(targetWidth, availableWidth)
    : targetWidth;
  const scale = hasMeasuredWidth
    ? roundViewportNumber(Math.min(1, visualWidth / targetWidth))
    : 1;
  const heightPercent =
    hasMeasuredWidth && visualWidth < targetWidth
      ? roundViewportNumber((targetWidth / visualWidth) * 100)
      : 100;

  return {
    targetWidth,
    visualWidth: roundViewportNumber(visualWidth),
    scale,
    heightPercent,
  };
}

function formatDocumentLabel(path: string, documentId: string): string {
  const trimmedPath = path.trim();

  if (trimmedPath.length === 0) {
    return documentId;
  }

  const segments = trimmedPath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? trimmedPath;
}

function describeStatusContent(state: ContentDocumentPageState): string {
  switch (state.status) {
    case "loading":
      return "Loading document draft…";
    case "forbidden":
    case "not-found":
    case "error":
      return state.message;
    case "ready":
      switch (state.saveState) {
        case "saved":
          return "Saved";
        case "saving":
          return "Saving...";
        case "unsaved":
          return "Unsaved changes";
      }
  }
}

function ContentDocumentPageStatusView(props: {
  state: ContentDocumentPageState;
  onGoBack?: () => void;
}) {
  return (
    <div className="flex min-h-[320px] items-center justify-center p-6">
      <div className="max-w-md text-center">
        <p className="mb-3 text-sm text-foreground-muted">
          {describeStatusContent(props.state)}
        </p>
        {props.state.status !== "loading" ? (
          <Button variant="ghost" onClick={() => props.onGoBack?.()}>
            Go back
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function renderProjectMismatchBanner(schemaState: StudioSchemaState) {
  if (schemaState.status !== "project-mismatch") {
    return null;
  }

  return (
    <section
      data-mdcms-schema-recovery-state="project-mismatch"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-foreground"
    >
      <div className="space-y-2">
        <p className="font-medium">
          Studio configuration does not match the connected project
        </p>
        <p className="text-foreground-muted">
          The local configuration is for project{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {schemaState.configProject}
          </code>{" "}
          but the server resolved project{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {schemaState.serverProject}
          </code>
          .
        </p>
        <div className="space-y-1 text-xs text-foreground-muted">
          <p className="font-medium text-foreground">To resolve:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              Ensure Studio is embedded in the same directory as the{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                mdcms.config.ts
              </code>{" "}
              for the target project
            </li>
            <li>
              Verify that{" "}
              <code className="rounded bg-muted px-1 py-0.5">serverUrl</code>{" "}
              points to the server hosting project{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                {schemaState.configProject}
              </code>
            </li>
            <li>
              Only run schema sync after confirming the project pairing is
              correct
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function renderSchemaRecoveryBanner(input: {
  state: ContentDocumentPageReadyState;
  onSchemaSync?: () => void;
}) {
  const schemaState = input.state.schemaState;

  if (!hasSchemaRecoveryMismatch(schemaState)) {
    return null;
  }

  const localSchemaHash = formatSchemaRecoveryHash(schemaState.localSchemaHash);
  const serverSchemaHash = formatSchemaRecoveryHash(
    schemaState.serverSchemaHash,
  );

  return (
    <section
      data-mdcms-schema-recovery-state="mismatch"
      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="font-medium">Schema changes detected</p>
          <p className="text-amber-900/80 dark:text-amber-100/80">
            {SCHEMA_MISMATCH_WRITE_MESSAGE}
          </p>
          <div className="grid gap-2 text-xs text-amber-900/80 dark:text-amber-100/80 sm:grid-cols-2">
            <p data-mdcms-schema-recovery-hash="local">
              <span className="font-medium text-amber-900 dark:text-amber-100">
                Local schema hash
              </span>{" "}
              <code>{localSchemaHash}</code>
            </p>
            <p data-mdcms-schema-recovery-hash="server">
              <span className="font-medium text-amber-900 dark:text-amber-100">
                Server schema hash
              </span>{" "}
              <code>{serverSchemaHash}</code>
            </p>
          </div>
          {schemaState.syncError ? (
            <p
              data-mdcms-schema-sync-state="error"
              className="text-destructive"
            >
              {schemaState.syncError}
            </p>
          ) : null}
        </div>

        {schemaState.canSync ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => input.onSchemaSync?.()}
          >
            Sync Schema
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

function getStatusBadge(state: ContentDocumentPageReadyState): {
  label: string;
  className: string;
} {
  if (state.document.publishedVersion === null) {
    return { label: "Draft", className: "bg-muted text-foreground-muted" };
  }

  return state.document.hasUnpublishedChanges
    ? { label: "Changed", className: "bg-warning/10 text-warning" }
    : { label: "Published", className: "bg-success/10 text-success" };
}

function formatPropertyOptionLabel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

function DocumentCanvasHeader({
  state,
}: {
  state: ContentDocumentPageReadyState;
}) {
  const fm = state.draftFrontmatter ?? state.document.frontmatter ?? {};
  // Pull a small set of "always-shown" frontmatter facts. The fields we
  // surface here mirror what the design's mono fmRow shows at the top of the
  // canvas — title comes from the editor body's first heading via the schema
  // form, so we focus on metadata-style fields here.
  const pickValue = (key: string): string | null => {
    const value = (fm as Record<string, unknown>)[key];
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim().length === 0) return null;
    if (Array.isArray(value)) {
      if (value.length === 0) return null;
      return JSON.stringify(value);
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const fmEntries: Array<[string, string]> = [];
  for (const key of [
    "author",
    "publishedAt",
    "publishDate",
    "tags",
    "slug",
  ] as const) {
    const formatted = pickValue(key);
    if (formatted !== null) fmEntries.push([key, formatted]);
  }
  fmEntries.push(["locale", state.locale]);
  fmEntries.push(["format", `.${state.document.format}`]);

  const path = state.document.path;
  const pathSuffix = `.${state.document.format}`;
  const fullPath = path.endsWith(pathSuffix) ? path : `${path}${pathSuffix}`;

  return (
    <div data-mdcms-document-canvas-header="true" className="space-y-3">
      <span className="inline-flex items-center gap-1.5 rounded-sm bg-code-bg px-2 py-1 font-mono text-[11px] text-foreground-muted">
        <span aria-hidden="true">📄</span>
        <span className="break-all">{fullPath}</span>
      </span>
      <div className="flex flex-wrap items-baseline border-y border-dashed border-border py-2.5">
        {fmEntries.map(([key, value], index) => (
          <span
            key={key}
            className={cn(
              "inline-flex items-baseline gap-2 px-3.5 py-1",
              index > 0 && "border-l border-dashed border-border",
              index === 0 && "pl-0",
            )}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-foreground-muted">
              {key}
            </span>
            <span className="text-[13px] font-medium text-foreground">
              {value}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SidebarTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-mdcms-sidebar-tab={label.toLowerCase()}
      onClick={onClick}
      className={cn(
        "flex-1 border-b-2 border-transparent py-2.5 text-center font-mono text-[11px] uppercase tracking-wider transition-colors",
        active
          ? "border-primary text-foreground"
          : "text-foreground-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function SidebarInfoTab(props: {
  state: ContentDocumentPageReadyState;
}) {
  const status = getStatusBadge(props.state);

  return (
    <div className="px-5 py-4">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        Document
      </div>
      <div className="space-y-2.5 font-mono text-[11px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground-muted">status</span>
          <Badge variant="tag" className={status.className}>
            {status.label}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground-muted">type</span>
          <span className="text-foreground">{props.state.typeId}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground-muted">locale</span>
          <span className="text-foreground">{props.state.locale}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground-muted">publishedVersion</span>
          <span className="text-foreground">
            {props.state.document.publishedVersion !== null
              ? `v${props.state.document.publishedVersion}`
              : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-foreground-muted">updatedAt</span>
          <span className="text-foreground">
            {formatRelativeTime(props.state.document.updatedAt)}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-foreground-muted">path</span>
          <span className="break-all text-right text-foreground">
            {props.state.document.path}
          </span>
        </div>
      </div>
    </div>
  );
}

function SidebarPropertiesTab(props: {
  state: ContentDocumentPageReadyState;
  onFrontmatterFieldChange?: (fieldName: string, value: unknown) => void;
}) {
  const propertyDescriptors = getPropertyDescriptors(props.state);
  const propertiesReadOnly =
    !props.state.canWrite || !!props.state.viewingVersion;

  return (
    <div className="px-5 py-4">
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
        Schema · {props.state.typeId}
      </div>
      {propertyDescriptors.length > 0 ? (
        <div className="flex flex-col">
          {propertyDescriptors.map((descriptor) => {
            const inputId = `document-property-${descriptor.fieldName}`;
            const envLabel = descriptor.badgeLabel?.replace(/ only$/, "");

            if (
              descriptor.status === "editable" &&
              descriptor.control.kind === "boolean"
            ) {
              return (
                <div
                  key={descriptor.fieldName}
                  data-mdcms-property-field={descriptor.fieldName}
                  data-mdcms-property-type={descriptor.typeLabel}
                  data-mdcms-property-editor="boolean"
                  className="flex items-center justify-between border-b border-border py-2.5 last:border-b-0"
                >
                  <div className="flex items-baseline gap-1.5">
                    <label
                      htmlFor={inputId}
                      className="text-xs font-medium text-foreground"
                    >
                      {descriptor.fieldName}
                      {descriptor.field.required ? (
                        <span className="text-destructive"> *</span>
                      ) : null}
                    </label>
                    {envLabel ? (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
                        {envLabel}
                      </span>
                    ) : null}
                    <span className="font-mono text-[10px] text-foreground-muted">
                      {descriptor.typeLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-foreground-muted">
                      {descriptor.control.isUnset
                        ? "Unset"
                        : descriptor.control.value
                          ? "On"
                          : "Off"}
                    </span>
                    {descriptor.control.canUnset &&
                    !descriptor.control.isUnset ? (
                      <button
                        type="button"
                        disabled={propertiesReadOnly}
                        className="text-[11px] text-foreground-muted hover:text-foreground disabled:opacity-50"
                        onClick={() =>
                          props.onFrontmatterFieldChange?.(
                            descriptor.fieldName,
                            unsetFieldValue(descriptor.field),
                          )
                        }
                      >
                        Unset
                      </button>
                    ) : null}
                    <Switch
                      id={inputId}
                      checked={descriptor.control.value}
                      disabled={propertiesReadOnly}
                      aria-label={descriptor.fieldName}
                      onCheckedChange={(checked) =>
                        props.onFrontmatterFieldChange?.(
                          descriptor.fieldName,
                          checked,
                        )
                      }
                    />
                  </div>
                </div>
              );
            }

            return (
              <div
                key={descriptor.fieldName}
                data-mdcms-property-field={descriptor.fieldName}
                data-mdcms-property-type={descriptor.typeLabel}
                data-mdcms-property-editor={
                  descriptor.status === "editable"
                    ? descriptor.control.kind
                    : "unsupported"
                }
                className={cn(
                  "flex flex-col gap-1.5 border-b border-border py-2.5 last:border-b-0",
                  descriptor.status !== "editable" && "opacity-50",
                )}
              >
                <div className="flex items-baseline justify-between">
                  <div className="flex items-baseline gap-1.5">
                    <label
                      htmlFor={inputId}
                      className="text-xs font-medium text-foreground"
                    >
                      {descriptor.fieldName}
                      {descriptor.field.required ? (
                        <span className="text-destructive"> *</span>
                      ) : null}
                    </label>
                    {envLabel ? (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-500">
                        {envLabel}
                      </span>
                    ) : null}
                  </div>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {descriptor.typeLabel}
                  </span>
                </div>

                {descriptor.status === "editable" ? (
                  <>
                    {descriptor.control.kind === "string" ? (
                      <Input
                        id={inputId}
                        type="text"
                        value={descriptor.control.value}
                        disabled={propertiesReadOnly}
                        onChange={(event) =>
                          props.onFrontmatterFieldChange?.(
                            descriptor.fieldName,
                            event.currentTarget.value.length === 0 &&
                              descriptor.control.canUnset
                              ? unsetFieldValue(descriptor.field)
                              : event.currentTarget.value,
                          )
                        }
                      />
                    ) : null}

                    {descriptor.control.kind === "number" ? (
                      <Input
                        id={inputId}
                        type="number"
                        inputMode="decimal"
                        value={descriptor.control.value ?? ""}
                        disabled={propertiesReadOnly}
                        onChange={(event) => {
                          const rawValue = event.currentTarget.value.trim();

                          if (rawValue.length === 0) {
                            if (descriptor.control.canUnset) {
                              props.onFrontmatterFieldChange?.(
                                descriptor.fieldName,
                                unsetFieldValue(descriptor.field),
                              );
                            }
                            return;
                          }

                          const nextValue = Number(rawValue);

                          if (Number.isFinite(nextValue)) {
                            props.onFrontmatterFieldChange?.(
                              descriptor.fieldName,
                              nextValue,
                            );
                          }
                        }}
                      />
                    ) : null}

                    {descriptor.control.kind === "select" ? (
                      <Select
                        value={
                          descriptor.control.value === undefined ||
                          descriptor.control.value === null
                            ? PROPERTY_SELECT_UNSET_VALUE
                            : JSON.stringify(descriptor.control.value)
                        }
                        disabled={propertiesReadOnly}
                        onValueChange={(value) =>
                          props.onFrontmatterFieldChange?.(
                            descriptor.fieldName,
                            value === PROPERTY_SELECT_UNSET_VALUE
                              ? unsetFieldValue(descriptor.field)
                              : JSON.parse(value),
                          )
                        }
                      >
                        <SelectTrigger id={inputId} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {descriptor.control.canUnset ? (
                            <SelectItem value={PROPERTY_SELECT_UNSET_VALUE}>
                              Unset
                            </SelectItem>
                          ) : null}
                          {descriptor.control.options.map((option) => (
                            <SelectItem
                              key={JSON.stringify(option)}
                              value={JSON.stringify(option)}
                            >
                              {formatPropertyOptionLabel(option)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                  </>
                ) : (
                  <span className="text-[11px] italic text-foreground-muted">
                    Not editable yet
                  </span>
                )}

                {descriptor.error ? (
                  <p
                    data-mdcms-property-error={descriptor.fieldName}
                    className="text-xs text-destructive"
                  >
                    {descriptor.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SidebarComponentTab(props: {
  context: StudioMountContext;
  activeMdxComponent: MdxPropsPanelSelection;
}) {
  return (
    <div className="p-4">
      <MdxPropsPanel
        context={props.context}
        selection={props.activeMdxComponent}
      />
    </div>
  );
}

function SidebarHistoryTab(props: {
  state: ContentDocumentPageReadyState;
  onViewVersion?: (version: number) => void;
  onBackToDraft?: () => void;
}) {
  const { versionHistory, viewingVersion } = props.state;

  const isViewingLatest = !viewingVersion;

  return (
    <div className="p-4">
      {versionHistory.status === "idle" ||
      versionHistory.status === "loading" ? (
        <p className="text-sm text-foreground-muted">
          {versionHistory.status === "loading"
            ? "Loading versions..."
            : "Loading..."}
        </p>
      ) : versionHistory.status === "error" ? (
        <p className="text-sm text-destructive">{versionHistory.message}</p>
      ) : versionHistory.status === "empty" ? (
        <p className="text-sm text-foreground-muted">
          No published versions yet.
        </p>
      ) : (
        <div className="relative border-l-2 border-border pl-4">
          {/* Latest (current draft) entry */}
          <button
            type="button"
            className={cn(
              "relative mb-4 w-full rounded-md px-2 py-1.5 text-left transition-colors",
              isViewingLatest ? "bg-primary/10" : "hover:bg-background-subtle",
            )}
            onClick={() => {
              if (!isViewingLatest) {
                props.onBackToDraft?.();
              }
            }}
          >
            <div className="absolute -left-[21px] top-2.5 size-2.5 rounded-full border-2 border-background bg-primary" />
            <p className="text-sm font-medium">
              Latest
              {isViewingLatest ? (
                <span className="ml-1.5 text-xs font-normal text-primary">
                  viewing
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Current draft
            </p>
          </button>

          {/* Published versions */}
          {versionHistory.versions.map((version) => {
            const isViewing = viewingVersion?.version === version.version;

            return (
              <button
                key={version.version}
                type="button"
                data-mdcms-version={version.version}
                className={cn(
                  "relative mb-4 w-full rounded-md px-2 py-1.5 text-left transition-colors last:mb-0",
                  isViewing ? "bg-primary/10" : "hover:bg-background-subtle",
                )}
                onClick={() => {
                  if (isViewing) {
                    props.onBackToDraft?.();
                  } else {
                    props.onViewVersion?.(version.version);
                  }
                }}
              >
                <div className="absolute -left-[21px] top-2.5 size-2.5 rounded-full border-2 border-background bg-primary" />
                <p className="text-sm font-medium">
                  v{version.version}
                  {isViewing ? (
                    <span className="ml-1.5 text-xs font-normal text-primary">
                      viewing
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-foreground-muted">
                  {version.changeSummary ?? "No summary"}
                </p>
                <p className="mt-0.5 text-xs text-foreground-muted">
                  {formatRelativeTime(version.publishedAt)}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContentDocumentPageSidebar(props: {
  state: ContentDocumentPageReadyState;
  context?: StudioMountContext;
  activeMdxComponent?: MdxPropsPanelSelection | null;
  onFrontmatterFieldChange?: (fieldName: string, value: unknown) => void;
  onViewVersion?: (version: number) => void;
  onBackToDraft?: () => void;
  onClose?: () => void;
}) {
  const hasComponentTab = Boolean(props.context && props.activeMdxComponent);
  const [selectedTab, setSelectedTab] = useState<
    "info" | "properties" | "history"
  >("properties");
  const activeTab = hasComponentTab ? "component" : selectedTab;

  return (
    <aside
      data-mdcms-editor-pane="sidebar"
      className="flex size-full shrink-0 flex-col border-l border-border bg-card"
    >
      {/* Tabs — mono uppercase, bottom-border accent on active.
          Stable tabs (Info, Properties, History) with a contextual
          Component tab when an MDX block is selected. */}
      <div className="flex items-stretch border-b border-border">
        <SidebarTabButton
          label="Info"
          active={activeTab === "info"}
          onClick={() => setSelectedTab("info")}
        />
        <SidebarTabButton
          label="Properties"
          active={activeTab === "properties"}
          onClick={() => setSelectedTab("properties")}
        />
        {hasComponentTab ? (
          <SidebarTabButton
            label="Component"
            active={activeTab === "component"}
            onClick={() => undefined}
          />
        ) : null}
        <SidebarTabButton
          label="History"
          active={activeTab === "history"}
          onClick={() => setSelectedTab("history")}
        />
        {props.onClose ? (
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close properties (Esc)"
            className="ml-auto flex shrink-0 items-center justify-center px-3 text-foreground-muted transition-colors hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === "component" &&
        props.context &&
        props.activeMdxComponent ? (
          <SidebarComponentTab
            context={props.context}
            activeMdxComponent={props.activeMdxComponent}
          />
        ) : activeTab === "history" ? (
          <SidebarHistoryTab
            state={props.state}
            onViewVersion={props.onViewVersion}
            onBackToDraft={props.onBackToDraft}
          />
        ) : activeTab === "properties" ? (
          <SidebarPropertiesTab
            state={props.state}
            onFrontmatterFieldChange={props.onFrontmatterFieldChange}
          />
        ) : (
          <SidebarInfoTab state={props.state} />
        )}
      </div>
    </aside>
  );
}

function PreviewModeButton(props: {
  mode: ContentDocumentPreviewMode;
  activeMode: ContentDocumentPreviewMode;
  onSelect: (mode: ContentDocumentPreviewMode) => void;
}) {
  const label =
    props.mode === "edit"
      ? "Edit"
      : props.mode === "split"
        ? "Split"
        : "Preview";

  return (
    <button
      type="button"
      data-mdcms-preview-mode-option={props.mode}
      data-state={props.activeMode === props.mode ? "active" : "inactive"}
      className={cn(
        "h-8 border-l border-border px-3 font-mono text-[11px] uppercase transition-colors first:border-l-0",
        props.activeMode === props.mode
          ? "bg-primary text-primary-foreground"
          : "bg-card text-foreground-muted hover:bg-muted hover:text-foreground",
      )}
      onClick={() => props.onSelect(props.mode)}
    >
      {label}
    </button>
  );
}

function DocumentPreviewModeControl(props: {
  mode: ContentDocumentPreviewMode;
  onModeChange: (mode: ContentDocumentPreviewMode) => void;
}) {
  return (
    <div
      data-mdcms-preview-mode-control="true"
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-border bg-card"
      aria-label="Editor preview mode"
    >
      {(["edit", "split", "preview"] as const).map((mode) => (
        <PreviewModeButton
          key={mode}
          mode={mode}
          activeMode={props.mode}
          onSelect={props.onModeChange}
        />
      ))}
    </div>
  );
}

function LivePreviewFailureMatrix() {
  return (
    <div className="divide-y divide-border border-y border-border">
      {[
        ["NO ADAPTER", "Install the host preview route or use open-in-tab."],
        ["FRAMING BLOCKED", "Allow Studio in frame-ancestors for preview."],
        ["UNAUTHORIZED", "Refresh the Studio session or preview token."],
        ["DRAFT INVALID", "Last valid render is kept until save succeeds."],
      ].map(([label, description]) => (
        <div key={label} className="grid gap-1 py-2 sm:grid-cols-[8rem_1fr]">
          <p className="font-mono text-[10px] font-semibold uppercase text-foreground">
            {label}
          </p>
          <p className="text-xs text-foreground-muted">{description}</p>
        </div>
      ))}
    </div>
  );
}

function LivePreviewUnavailableState(props: {
  route: Extract<DocumentPreviewRouteResolution, { status: "unavailable" }>;
}) {
  return (
    <div
      data-mdcms-live-preview-pane="unavailable"
      className="flex size-full items-center justify-center bg-background-subtle p-6"
    >
      <div className="max-w-md">
        <p className="font-mono text-[10px] uppercase text-primary">
          Real-route preview
        </p>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          Live preview not available
        </h2>
        <p className="mt-2 text-sm leading-6 text-foreground-muted">
          {props.route.message} Studio only embeds host routes returned by
          mdcms.config.ts; frontmatter preview fields are ignored.
        </p>
        <div className="mt-4">
          <LivePreviewFailureMatrix />
        </div>
      </div>
    </div>
  );
}

function LivePreviewFrameUnavailableState(props: {
  documentPath: string;
  href: string;
  message: string;
}) {
  return (
    <div
      data-mdcms-live-preview-frame-state="error"
      className="flex h-full w-full items-center justify-center rounded-md border border-border bg-card px-4 text-center text-sm text-foreground-muted"
    >
      <div className="max-w-md">
        <p className="font-mono text-[10px] uppercase text-primary">
          Real-route preview
        </p>
        <h2 className="mt-2 text-base font-semibold text-foreground">
          Live preview not available
        </h2>
        <p className="mt-2 leading-6">
          {props.message} Document path:{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            {props.documentPath}
          </code>
          .
        </p>
        <a
          href={props.href}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Open preview in new tab
        </a>
      </div>
    </div>
  );
}

export function resolveLivePreviewDocument(
  state: ContentDocumentPageReadyState,
): MdcmsPreviewDocument {
  return {
    documentId: state.document.documentId,
    type: state.document.type,
    path: state.document.path,
    locale: state.document.locale,
    frontmatter: cloneFrontmatter(state.document.frontmatter),
    draftRevision: state.document.draftRevision,
  };
}

export function shouldPersistBeforeLivePreviewRefresh(
  state: ContentDocumentPageReadyState,
): boolean {
  return state.canWrite && !state.viewingVersion && !isDraftPersisted(state);
}

export async function runLivePreviewRefresh(input: {
  beforeRefresh?: () => boolean | Promise<boolean>;
  refresh: () => void;
}): Promise<boolean> {
  const canRefresh = input.beforeRefresh ? await input.beforeRefresh() : true;

  if (canRefresh === false) {
    return false;
  }

  input.refresh();
  return true;
}

export type LivePreviewIframeRoute = {
  href: string;
  expiresAt: string;
};

export async function createLivePreviewIframeRoute(input: {
  api: Pick<StudioDocumentRouteApi, "createPreviewToken">;
  document: Pick<MdcmsPreviewDocument, "documentId">;
  href: string;
}): Promise<LivePreviewIframeRoute> {
  const token = await input.api.createPreviewToken({
    documentId: input.document.documentId,
    previewUrl: input.href,
  });

  return {
    href: appendMdcmsPreviewTokenToUrl(input.href, token.token),
    expiresAt: token.expiresAt,
  };
}

export const MDCMS_LIVE_PREVIEW_READY_MESSAGE = "mdcms:live-preview-ready";
const LIVE_PREVIEW_READY_TIMEOUT_MS = 10_000;

type LivePreviewReadyMessageEvent = {
  data: unknown;
  source: MessageEventSource | null;
};

export function isLivePreviewReadyMessage(
  event: LivePreviewReadyMessageEvent,
  iframe: Pick<HTMLIFrameElement, "contentWindow"> | null | undefined,
  expectedHref: string,
): boolean {
  if (!iframe?.contentWindow || event.source !== iframe.contentWindow) {
    return false;
  }

  if (event.data === MDCMS_LIVE_PREVIEW_READY_MESSAGE) {
    return true;
  }

  if (
    !event.data ||
    typeof event.data !== "object" ||
    Array.isArray(event.data)
  ) {
    return false;
  }

  const payload = event.data as { type?: unknown; href?: unknown };

  if (payload.type !== MDCMS_LIVE_PREVIEW_READY_MESSAGE) {
    return false;
  }

  return typeof payload.href !== "string" || payload.href === expectedHref;
}

function createLivePreviewFrameErrorMessage(documentPath: string): string {
  return `The host preview route did not signal readiness for "${documentPath}". Check the route's frame policy, preview token handling, and ready postMessage integration.`;
}

function LivePreviewViewportControl(props: {
  size: LivePreviewViewportSize;
  onSizeChange: (size: LivePreviewViewportSize) => void;
}) {
  const options: Array<{
    size: LivePreviewViewportSize;
    Icon: typeof Smartphone;
  }> = [
    { size: "mobile", Icon: Smartphone },
    { size: "tablet", Icon: Tablet },
    { size: "desktop", Icon: Monitor },
  ];

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="hidden shrink-0 overflow-hidden rounded-md border border-border sm:inline-flex"
        aria-label="Preview viewport"
      >
        {options.map((option) => {
          const preset = LIVE_PREVIEW_VIEWPORT_PRESETS[option.size];
          const active = props.size === option.size;
          const label = `${preset.label} viewport`;

          return (
            <Tooltip key={option.size}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-mdcms-preview-viewport-option={option.size}
                  data-state={active ? "active" : "inactive"}
                  className={cn(
                    "inline-flex size-8 items-center justify-center transition-colors",
                    active
                      ? "bg-foreground text-background"
                      : "text-foreground-muted hover:bg-muted hover:text-foreground",
                  )}
                  onClick={() => props.onSizeChange(option.size)}
                  aria-label={label}
                  aria-pressed={active}
                >
                  <option.Icon className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {preset.label} · {preset.width}px
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function LivePreviewPane(props: {
  state: ContentDocumentPageReadyState;
  context?: StudioMountContext;
  previewTokenApi?: Pick<StudioDocumentRouteApi, "createPreviewToken">;
  refreshToken: number;
  onRefresh: () => void;
}) {
  const [viewportSize, setViewportSize] =
    useState<LivePreviewViewportSize>("desktop");
  const [previewFrameAvailableWidth, setPreviewFrameAvailableWidth] =
    useState(0);
  const [iframeRoute, setIframeRoute] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        href: string;
        sourceHref: string;
        documentId: string;
        draftRevision: number;
        refreshToken: number;
      }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const [previewFrameState, setPreviewFrameState] = useState<
    | { status: "loading" }
    | { status: "ready" }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewFrameSlotRef = useRef<HTMLDivElement | null>(null);
  const previewDocument = resolveLivePreviewDocument(props.state);
  const route = resolveDocumentPreviewRoute({
    document: previewDocument,
    preview: props.context?.preview,
  });
  const viewportFrame = getLivePreviewViewportFrame(
    viewportSize,
    previewFrameAvailableWidth,
  );
  const readyRouteHref = route.status === "ready" ? route.href : undefined;
  const readyIframeRoute =
    route.status === "ready" &&
    iframeRoute.status === "ready" &&
    iframeRoute.sourceHref === route.href &&
    iframeRoute.documentId === previewDocument.documentId &&
    iframeRoute.draftRevision === previewDocument.draftRevision &&
    iframeRoute.refreshToken === props.refreshToken
      ? iframeRoute
      : undefined;
  const iframeInstanceKey = readyIframeRoute
    ? `${readyIframeRoute.sourceHref}:${props.refreshToken}`
    : undefined;

  useLayoutEffect(() => {
    const slot = previewFrameSlotRef.current;

    if (!slot || typeof ResizeObserver === "undefined") {
      return;
    }

    const updateWidth = (width: number) => {
      setPreviewFrameAvailableWidth((current) =>
        Math.abs(current - width) < 0.5 ? current : width,
      );
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (entry) {
        updateWidth(entry.contentRect.width);
      }
    });

    updateWidth(slot.clientWidth);
    observer.observe(slot);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (route.status !== "ready") {
      setIframeRoute({ status: "loading" });
      return;
    }

    if (!props.previewTokenApi) {
      setIframeRoute({
        status: "error",
        message:
          "Preview token creation is not available for this Studio mount.",
      });
      return;
    }

    let cancelled = false;
    setIframeRoute({ status: "loading" });

    void createLivePreviewIframeRoute({
      api: props.previewTokenApi,
      document: previewDocument,
      href: route.href,
    })
      .then((tokenizedRoute) => {
        if (cancelled) return;
        setIframeRoute({
          status: "ready",
          href: tokenizedRoute.href,
          sourceHref: route.href,
          documentId: previewDocument.documentId,
          draftRevision: previewDocument.draftRevision,
          refreshToken: props.refreshToken,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setIframeRoute({
          status: "error",
          message: toRouteErrorMessage(
            error,
            "Failed to create a preview token for this document.",
          ),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    previewDocument.documentId,
    previewDocument.draftRevision,
    props.previewTokenApi,
    props.refreshToken,
    readyRouteHref,
    route.status,
  ]);

  useEffect(() => {
    if (!readyIframeRoute) {
      iframeRef.current = null;
      setPreviewFrameState({ status: "loading" });
      return;
    }

    setPreviewFrameState({ status: "loading" });

    if (typeof window === "undefined") {
      return;
    }

    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      setPreviewFrameState({
        status: "error",
        message: createLivePreviewFrameErrorMessage(props.state.document.path),
      });
    }, LIVE_PREVIEW_READY_TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (
        !isLivePreviewReadyMessage(
          event,
          iframeRef.current,
          readyIframeRoute.sourceHref,
        )
      ) {
        return;
      }

      if (timedOut) {
        return;
      }

      window.clearTimeout(timeout);
      setPreviewFrameState({ status: "ready" });
    };

    window.addEventListener("message", onMessage);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [
    props.state.document.path,
    readyIframeRoute?.href,
    readyIframeRoute?.sourceHref,
    iframeInstanceKey,
  ]);

  if (route.status === "unavailable") {
    return <LivePreviewUnavailableState route={route} />;
  }

  return (
    <section
      data-mdcms-live-preview-pane="ready"
      data-mdcms-preview-viewport={viewportSize}
      className="flex size-full min-w-0 flex-col bg-background-subtle"
      aria-label="Live host route preview"
    >
      <div className="flex min-h-11 items-center gap-2 border-b border-border bg-card px-3">
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md border border-border text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
          onClick={props.onRefresh}
          aria-label="Refresh preview"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-3 py-1.5 font-mono text-[11px] text-foreground-muted">
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="truncate text-foreground">{route.label}</span>
          <span className="ml-auto shrink-0 text-primary">draft</span>
        </div>
        <LivePreviewViewportControl
          size={viewportSize}
          onSizeChange={setViewportSize}
        />
        <a
          href={readyIframeRoute?.href ?? route.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-muted transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          <span className="hidden lg:inline">Open preview in new tab</span>
          <span className="lg:hidden">Open</span>
        </a>
      </div>
      <div
        ref={previewFrameSlotRef}
        className="flex min-h-0 flex-1 justify-center overflow-hidden p-3"
      >
        {readyIframeRoute ? (
          previewFrameState.status === "error" ? (
            <LivePreviewFrameUnavailableState
              documentPath={props.state.document.path}
              href={readyIframeRoute.href}
              message={previewFrameState.message}
            />
          ) : (
            <div
              data-mdcms-live-preview-frame-state={previewFrameState.status}
              className={cn(
                "relative h-full overflow-hidden rounded-md border border-border bg-card shadow-sm transition-[width]",
              )}
              style={{
                width: viewportFrame.visualWidth,
                maxWidth: "100%",
              }}
              data-mdcms-preview-target-width={viewportFrame.targetWidth}
              data-mdcms-preview-scale={viewportFrame.scale}
            >
              <div
                className="h-full"
                style={{
                  width: viewportFrame.targetWidth,
                  height: `${viewportFrame.heightPercent}%`,
                  transform: `scale(${viewportFrame.scale})`,
                  transformOrigin: "top left",
                }}
              >
                <iframe
                  key={iframeInstanceKey}
                  ref={iframeRef}
                  title={`Preview ${props.state.document.path}`}
                  src={readyIframeRoute.href}
                  sandbox={LIVE_PREVIEW_IFRAME_SANDBOX}
                  referrerPolicy="no-referrer-when-downgrade"
                  onLoad={() => {
                    setPreviewFrameState((current) =>
                      current.status === "ready" || current.status === "error"
                        ? current
                        : { status: "loading" },
                    );
                  }}
                  onError={() => {
                    setPreviewFrameState({
                      status: "error",
                      message: createLivePreviewFrameErrorMessage(
                        props.state.document.path,
                      ),
                    });
                  }}
                  className={cn(
                    "size-full rounded-md bg-white transition-opacity",
                    previewFrameState.status === "ready"
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
              </div>
              {previewFrameState.status === "loading" ? (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-card px-4 text-center text-sm text-foreground-muted">
                  Loading preview…
                </div>
              ) : null}
            </div>
          )
        ) : (
          <div
            data-mdcms-live-preview-frame-state={
              iframeRoute.status === "error" ? "error" : "loading"
            }
            className={cn(
              "flex h-full w-full items-center justify-center rounded-md border border-border bg-card px-4 text-center text-sm text-foreground-muted",
            )}
          >
            {iframeRoute.status === "error"
              ? iframeRoute.message
              : "Preparing preview..."}
          </div>
        )}
      </div>
    </section>
  );
}

export function ContentDocumentPageView(props: ContentDocumentPageViewProps) {
  return useContentDocumentPageViewElement(props);
}

function useContentDocumentPageViewElement({
  state,
  context,
  sidebarOpen = false,
  activeMdxComponent = null,
  onDraftChange,
  onFrontmatterFieldChange,
  onActiveMdxComponentChange,
  onToggleSidebar,
  onGoBack,
  onPublishDialogOpenChange,
  onPublishChangeSummaryChange,
  onPublishSubmit,
  onSaveNow,
  onSchemaSync,
  onSelectComparisonVersion,
  editorRef,
  onViewVersion,
  onBackToDraft,
  onRestoreVersion,
  onLocaleSwitch,
  onCreateVariant,
  onCancelVariantCreation,
  aiSelection,
  onAiSelectionChange,
  aiApi,
  previewTokenApi,
  onAiProposalApplied,
  previewMode,
  onPreviewModeChange,
  onPreviewRefresh,
}: ContentDocumentPageViewProps) {
  const [internalPreviewMode, setInternalPreviewMode] =
    useState<ContentDocumentPreviewMode>(
      () => previewMode ?? readBrowserContentDocumentPreviewMode() ?? "edit",
    );
  const [previewRefreshToken, setPreviewRefreshToken] = useState(0);
  const activePreviewMode = previewMode ?? internalPreviewMode;
  const setPreviewMode = useCallback(
    (mode: ContentDocumentPreviewMode) => {
      if (previewMode === undefined) {
        setInternalPreviewMode(mode);
      }
      replaceBrowserContentDocumentPreviewMode(mode);
      onPreviewModeChange?.(mode);
    },
    [onPreviewModeChange, previewMode],
  );
  const refreshLivePreview = useLatestCallback(async () => {
    await runLivePreviewRefresh({
      beforeRefresh: onPreviewRefresh,
      refresh: () => setPreviewRefreshToken((token) => token + 1),
    });
  });
  const documentLabel =
    state.status === "ready"
      ? formatDocumentLabel(state.document.path, state.documentId)
      : state.documentId;
  const writeState =
    state.status === "ready"
      ? state.canWrite
        ? "enabled"
        : "blocked"
      : "idle";
  const canPublish =
    state.status === "ready" &&
    state.canWrite &&
    state.saveState === "saved" &&
    state.document.hasUnpublishedChanges &&
    state.publishState !== "publishing";

  const canSaveNow =
    state.status === "ready" &&
    state.canWrite &&
    state.saveState === "unsaved" &&
    state.publishState !== "publishing" &&
    !state.viewingVersion;

  // The Properties pane renders as a docked column when the assistant
  // is closed (3 columns: app rail · editor · properties) and as an
  // overlay slide-over when the assistant is open (4 columns would
  // squeeze the editor). The container auto-collapses Properties on
  // assistant-open; the View just needs the bit to pick render mode.
  const assistantOpen = useAssistant().isOpen;

  const triggerSaveShortcut = useLatestCallback(() => {
    onSaveNow?.();
  });
  useEffect(() => {
    if (!canSaveNow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "s" && event.key !== "S") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      // Don't fire when a modal/composer captured the shortcut already.
      if (event.defaultPrevented) return;
      event.preventDefault();
      triggerSaveShortcut();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canSaveNow, triggerSaveShortcut]);

  // Publish the active document to the assistant rail so the chat surface
  // can attach the right document context + resolve the schema hash on
  // accept. The live editor selection is included so document chat can
  // send the same selected span that powers inline AI transforms.
  const assistantReadyState = state.status === "ready" ? state : null;
  const assistantActiveDocument =
    useMemo<AssistantActiveDocument | null>(() => {
      if (!assistantReadyState) return null;
      const schemaHash = resolveSchemaHashForAi(
        assistantReadyState.schemaState,
      );
      if (!schemaHash) return null;
      const documentId = assistantReadyState.document.documentId;
      if (!documentId) return null;
      return {
        documentId,
        path: assistantReadyState.document.path,
        type: assistantReadyState.document.type,
        locale: assistantReadyState.document.locale,
        draftRevision: assistantReadyState.document.draftRevision,
        schemaHash,
        project: assistantReadyState.route.project,
        environment: assistantReadyState.route.initialEnvironment,
        ...(aiSelection
          ? {
              selection: {
                selectionId: aiSelection.selectionId,
                text: aiSelection.serializedText,
              },
            }
          : {}),
      };
    }, [assistantReadyState, aiSelection]);

  return (
    <AssistantActiveDocumentProvider value={assistantActiveDocument}>
      <TooltipProvider>
        <div
          data-mdcms-editor-layout="document"
          data-mdcms-editor-preview-mode={activePreviewMode}
          data-mdcms-document-state={state.status}
          data-mdcms-document-write-state={writeState}
          className="flex h-screen min-w-0 flex-col overflow-x-hidden"
        >
          <header className="sticky top-0 z-30 flex h-14 min-w-0 items-center gap-3 border-b border-border bg-card px-6">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <BreadcrumbTrail
                className="flex-1"
                breadcrumbs={[
                  { label: "Content", href: "/admin/content" },
                  {
                    label: state.typeLabel,
                    href: `/admin/content/${state.typeId}`,
                  },
                  { label: documentLabel },
                ]}
              />

              {state.status === "loading" ? (
                <span className="shrink-0 text-sm text-foreground-muted">
                  Loading document draft…
                </span>
              ) : null}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {state.status === "ready" ? (
                <DocumentPreviewModeControl
                  mode={activePreviewMode}
                  onModeChange={setPreviewMode}
                />
              ) : null}

              {state.status === "ready" &&
              state.localized &&
              state.route.supportedLocales &&
              state.route.supportedLocales.length > 0 ? (
                <Select
                  value={state.variantCreation?.targetLocale ?? state.locale}
                  onValueChange={(value) => onLocaleSwitch?.(value)}
                  disabled={state.variantCreation?.status === "creating"}
                >
                  <SelectTrigger className="h-8 w-auto min-w-[88px] gap-1.5 text-xs">
                    <Globe className="size-3.5 shrink-0" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {filterLocaleOptions({
                      supportedLocales: state.route.supportedLocales,
                      translationVariants: state.translationVariants,
                      canWrite: state.canWrite,
                      variantsFetchFailed: state.variantsFetchFailed,
                    }).map(({ locale: loc, hasVariant }) => (
                      <SelectItem key={loc} value={loc}>
                        {hasVariant ? loc : `+ ${loc}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              {state.status === "ready" && !state.canWrite ? (
                <Badge variant="outline" className="text-xs">
                  Read-only
                </Badge>
              ) : null}

              <AssistantLauncher className="h-8 px-2.5 text-[11px]" />

              {state.status === "ready" && state.canWrite ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    state.saveState !== "unsaved" ||
                    state.publishState === "publishing" ||
                    !!state.viewingVersion
                  }
                  onClick={() => onSaveNow?.()}
                  data-mdcms-document-save-now="true"
                  data-mdcms-document-save-state={state.saveState}
                  aria-label={
                    state.saveState === "saved"
                      ? "Saved"
                      : state.saveState === "saving"
                        ? "Saving"
                        : "Save draft"
                  }
                >
                  {state.saveState === "saved" ? (
                    <span className="inline-flex items-center gap-1.5 text-foreground-muted">
                      <Check className="size-3.5 text-success" aria-hidden />
                      Saved
                    </span>
                  ) : state.saveState === "saving" ? (
                    <span className="inline-flex animate-pulse items-center text-foreground-muted">
                      Saving…
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      Save draft
                      <span className="rounded-sm bg-muted px-1 py-px font-mono text-[10px] font-medium text-foreground-muted">
                        ⌘ S
                      </span>
                    </span>
                  )}
                </Button>
              ) : null}

              {state.status === "ready" ? (
                <Button
                  size="sm"
                  disabled={!canPublish}
                  onClick={() => onPublishDialogOpenChange?.(true)}
                  data-mdcms-document-unpublished-changes={
                    state.document.hasUnpublishedChanges ? "true" : undefined
                  }
                >
                  <Send className="mr-2 size-4" />
                  Publish
                  {state.document.hasUnpublishedChanges ? (
                    <span className="ml-2 rounded-sm bg-black/20 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary-foreground">
                      unpublished
                    </span>
                  ) : null}
                </Button>
              ) : null}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onToggleSidebar}
                  >
                    {sidebarOpen ? (
                      <PanelRightClose className="size-4" />
                    ) : (
                      <PanelRight className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                </TooltipContent>
              </Tooltip>
            </div>
          </header>

          <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <div
              data-mdcms-editor-pane="canvas"
              className="flex min-w-0 flex-1 flex-col overflow-hidden"
            >
              {state.status !== "ready" ? (
                <div className="overflow-y-auto p-6">
                  <div className="mx-auto max-w-4xl">
                    <ContentDocumentPageStatusView
                      state={state}
                      onGoBack={onGoBack}
                    />
                  </div>
                </div>
              ) : state.variantCreation ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <div className="max-w-md text-center">
                    <Globe className="mx-auto mb-4 size-10 text-foreground-muted" />
                    <p className="mb-1 text-base font-medium">
                      No {state.variantCreation.targetLocale} variant exists yet
                    </p>
                    <p className="mb-5 text-sm text-foreground-muted">
                      Create a translation variant for this document to start
                      editing in {state.variantCreation.targetLocale}.
                    </p>
                    {state.variantCreation.error ? (
                      <div className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {state.variantCreation.error}
                      </div>
                    ) : null}
                    <div className="flex items-center justify-center gap-3">
                      <Button
                        variant="ghost"
                        disabled={state.variantCreation.status === "creating"}
                        onClick={() => onCreateVariant?.(false)}
                      >
                        Create empty
                      </Button>
                      <Button
                        disabled={state.variantCreation.status === "creating"}
                        onClick={() => onCreateVariant?.(true)}
                      >
                        {state.variantCreation.status === "creating"
                          ? "Creating..."
                          : `Pre-fill from ${state.variantCreation.sourceLocale}`}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    "flex min-h-0 flex-1",
                    activePreviewMode === "split"
                      ? "flex-col lg:flex-row"
                      : "flex-col",
                  )}
                >
                  {activePreviewMode !== "preview" ? (
                    <div
                      data-mdcms-editor-authoring-pane="true"
                      className={cn(
                        "flex min-w-0 flex-col overflow-hidden",
                        activePreviewMode === "split"
                          ? "w-full lg:w-1/2 lg:border-r lg:border-border"
                          : "flex-1",
                      )}
                    >
                      <TipTapEditor
                        ref={editorRef}
                        initialContent={state.draftBody}
                        context={context}
                        onChange={onDraftChange}
                        onActiveMdxComponentChange={onActiveMdxComponentChange}
                        onSelectionTextChange={onAiSelectionChange}
                        readOnly={!state.canWrite || !!state.viewingVersion}
                        forbidden={false}
                        canvasHeader={
                          <div className="space-y-3 pb-1">
                            {/* Path chip + dashed-border frontmatter mono row */}
                            <DocumentCanvasHeader state={state} />

                            {state.schemaState?.status === "project-mismatch"
                              ? renderProjectMismatchBanner(state.schemaState)
                              : hasSchemaRecoveryMismatch(state.schemaState)
                                ? renderSchemaRecoveryBanner({
                                    state,
                                    onSchemaSync,
                                  })
                                : null}

                            {state.mutationError ? (
                              <div
                                data-mdcms-document-mutation-state="error"
                                className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                              >
                                {state.mutationError}
                              </div>
                            ) : null}

                            {!state.canWrite &&
                            state.writeMessage &&
                            !hasSchemaRecoveryMismatch(state.schemaState) &&
                            state.schemaState?.status !== "project-mismatch" ? (
                              <div className="rounded-md border border-border bg-background-subtle px-4 py-3 text-sm text-foreground-muted">
                                {state.writeMessage}
                              </div>
                            ) : null}

                            {state.publishError ? (
                              <div
                                data-mdcms-document-publish-state="error"
                                className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                              >
                                {state.publishError}
                              </div>
                            ) : null}

                            {state.viewingVersion ? (
                              <div
                                data-mdcms-viewing-version={
                                  state.viewingVersion.version
                                }
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5"
                              >
                                <p className="text-sm font-medium">
                                  Viewing version {state.viewingVersion.version}
                                  {state.viewingVersion.status === "loading"
                                    ? " — Loading..."
                                    : null}
                                  {state.restoreVersionState === "restoring"
                                    ? " — Restoring..."
                                    : null}
                                </p>
                                <div className="flex items-center gap-1">
                                  {/* "Restore this version" copies the viewed
                              version's body + frontmatter back into the
                              document as a new draft. The edit isn't
                              published until the user clicks Publish,
                              mirroring the standard edit-then-publish flow
                              and keeping the content:write scope sufficient
                              (publish requires content:publish, which not
                              every editor has). */}
                                  {state.canWrite ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs"
                                      disabled={
                                        state.viewingVersion.status !==
                                          "ready" ||
                                        state.restoreVersionState ===
                                          "restoring"
                                      }
                                      data-mdcms-restore-version={
                                        state.viewingVersion.version
                                      }
                                      onClick={() => {
                                        const v = state.viewingVersion?.version;
                                        if (typeof v === "number") {
                                          onRestoreVersion?.(v);
                                        }
                                      }}
                                    >
                                      {state.restoreVersionState === "restoring"
                                        ? "Restoring..."
                                        : "Restore this version"}
                                    </Button>
                                  ) : null}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs"
                                    disabled={
                                      state.restoreVersionState === "restoring"
                                    }
                                    onClick={() => onBackToDraft?.()}
                                  >
                                    View latest
                                  </Button>
                                </div>
                              </div>
                            ) : null}

                            {state.viewingVersion?.status === "error" ? (
                              <div className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                                {state.viewingVersion.error}
                              </div>
                            ) : null}

                            {state.restoreVersionError ? (
                              <div
                                data-mdcms-document-restore-version-state="error"
                                className="rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                              >
                                {state.restoreVersionError}
                              </div>
                            ) : null}
                          </div>
                        }
                      />
                    </div>
                  ) : null}
                  {activePreviewMode !== "edit" ? (
                    <div
                      data-mdcms-editor-host-preview-pane="true"
                      className={cn(
                        "min-w-0 overflow-hidden",
                        activePreviewMode === "split"
                          ? "w-full lg:w-1/2"
                          : "flex-1",
                      )}
                    >
                      <LivePreviewPane
                        state={state}
                        context={context}
                        previewTokenApi={previewTokenApi}
                        refreshToken={previewRefreshToken}
                        onRefresh={() => {
                          void refreshLivePreview();
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {state.status === "ready" && !sidebarOpen ? (
              <button
                type="button"
                onClick={onToggleSidebar}
                data-mdcms-document-properties-handle="true"
                aria-label="Open properties"
                className="absolute right-0 top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-2 rounded-l-md border border-r-0 border-border bg-card px-2.5 py-2 font-mono text-[11px] uppercase tracking-wider text-foreground shadow-[-4px_0_12px_-4px_rgba(0,0,0,0.25)] transition-colors hover:bg-muted"
              >
                <span
                  className="inline-block size-1.5 rounded-full bg-primary"
                  aria-hidden
                />
                Properties
              </button>
            ) : null}
            {state.status === "ready" && sidebarOpen && assistantOpen ? (
              <div
                data-mdcms-document-properties-overlay="slide-over"
                className="absolute inset-y-0 right-0 z-20 flex w-96 animate-in fade-in slide-in-from-right-4 duration-200 motion-reduce:animate-none"
                style={{
                  boxShadow: "-12px 0 32px -8px rgba(0,0,0,0.45)",
                }}
              >
                <ContentDocumentPageSidebar
                  state={state}
                  context={context}
                  activeMdxComponent={activeMdxComponent}
                  onFrontmatterFieldChange={onFrontmatterFieldChange}
                  onViewVersion={onViewVersion}
                  onBackToDraft={onBackToDraft}
                  onClose={onToggleSidebar}
                />
              </div>
            ) : null}
            {state.status === "ready" && sidebarOpen && !assistantOpen ? (
              <div
                data-mdcms-document-properties-overlay="docked"
                className="relative flex w-80 shrink-0"
              >
                <ContentDocumentPageSidebar
                  state={state}
                  context={context}
                  activeMdxComponent={activeMdxComponent}
                  onFrontmatterFieldChange={onFrontmatterFieldChange}
                  onViewVersion={onViewVersion}
                  onBackToDraft={onBackToDraft}
                />
              </div>
            ) : null}

            {state.status === "ready" &&
            aiApi &&
            editorRef &&
            !state.viewingVersion ? (
              <InlineAiBubble
                api={aiApi}
                enabled={state.canAi === true}
                selection={aiSelection ?? null}
                editorRef={
                  editorRef as React.RefObject<TipTapEditorHandle | null>
                }
                options={{
                  documentId: state.documentId,
                  schemaHash: resolveSchemaHashForAi(state.schemaState),
                }}
                onApplied={
                  onAiProposalApplied
                    ? ({ document }) =>
                        onAiProposalApplied({ bodyAfter: document.body })
                    : undefined
                }
              />
            ) : null}
          </div>

          {state.status === "ready" ? (
            <Dialog
              open={state.publishDialogOpen}
              onOpenChange={onPublishDialogOpenChange}
            >
              <DialogContent
                forceMount={state.publishDialogOpen ? true : undefined}
                data-mdcms-publish-dialog="open"
              >
                <DialogHeader>
                  <DialogTitle>Publish document</DialogTitle>
                  <DialogDescription>
                    This creates a new immutable version from the current draft.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <label
                      htmlFor="publish-change-summary"
                      className="text-sm font-medium"
                    >
                      Change summary (optional)
                    </label>
                    <Textarea
                      id="publish-change-summary"
                      value={state.publishChangeSummary}
                      onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                        onPublishChangeSummaryChange?.(
                          event.currentTarget.value,
                        )
                      }
                      placeholder="Describe what changed..."
                      rows={3}
                    />
                  </div>
                  <p className="text-sm text-foreground-muted">
                    Current published version:{" "}
                    {state.document.publishedVersion === null
                      ? "Not published"
                      : `v${state.document.publishedVersion}`}
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => onPublishDialogOpenChange?.(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={state.publishState === "publishing"}
                    onClick={onPublishSubmit}
                  >
                    {state.publishState === "publishing"
                      ? "Publishing..."
                      : "Publish"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </TooltipProvider>
    </AssistantActiveDocumentProvider>
  );
}

function useContentDocumentPageController({
  context,
}: {
  context?: StudioMountContext;
}): ContentDocumentPageViewProps {
  const mountInfo = useStudioMountInfo();
  const params = useParams();
  const { back, push } = useRouter();
  const typeId = (params.type as string) || "content";
  const documentId = (params.documentId as string) || "";
  const typeLabel = typeId;
  const route = useMemo(
    () =>
      context?.documentRoute
        ? resolveActiveDocumentRouteContext(
            context.documentRoute,
            mountInfo.environment,
          )
        : undefined,
    [context?.documentRoute, mountInfo.environment],
  );
  const activeContext = useMemo(
    () =>
      context && route
        ? {
            ...context,
            documentRoute: route,
          }
        : context,
    [context, route],
  );

  const [state, setState] = useState<ContentDocumentPageState>(() =>
    route
      ? createLoadingState({
          typeId,
          typeLabel,
          documentId,
          route,
        })
      : createErrorState({
          status: "error",
          typeId,
          typeLabel,
          documentId,
          message: "Studio document route context is unavailable.",
        }),
  );
  // The document inspector starts collapsed for a focused editor canvas. When
  // the global assistant opens it claims the right-side column, so collapse
  // Properties to the handle. Closing the assistant does not auto-open the
  // inspector; the user's explicit toggle owns that state.
  const assistant = useAssistant();
  const assistantOpen = assistant.isOpen;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const prevAssistantOpenRef = useRef(assistantOpen);
  useEffect(() => {
    if (prevAssistantOpenRef.current === assistantOpen) return;
    prevAssistantOpenRef.current = assistantOpen;
    if (assistantOpen) {
      setSidebarOpen(false);
    }
  }, [assistantOpen]);
  // Esc dismisses the slide-over (only meaningful when Properties is
  // overlaying the canvas — i.e. the assistant is open). Skip when
  // another surface already handled the event so dialogs/menus that
  // consume Escape don't also collapse the sidebar.
  useEffect(() => {
    if (!sidebarOpen || !assistantOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen, assistantOpen]);
  const editorRef = useRef<TipTapEditorHandle>(null);
  const [activeMdxComponent, setActiveMdxComponent] =
    useState<MdxPropsPanelSelection | null>(null);
  const [aiSelection, setAiSelection] =
    useState<TipTapEditorSelectionInfo | null>(null);
  const aiApi = useMemo<StudioAiRouteApi | undefined>(() => {
    if (!activeContext || !route) {
      return undefined;
    }
    return createStudioAiRouteApi(
      {
        project: route.project,
        environment: route.initialEnvironment,
        serverUrl: activeContext.apiBaseUrl,
      },
      { auth: activeContext.auth },
    );
  }, [activeContext, route]);
  const previewTokenApi = useMemo<
    Pick<StudioDocumentRouteApi, "createPreviewToken"> | undefined
  >(() => {
    if (!activeContext || !route) {
      return undefined;
    }

    return createContentDocumentRouteApi({
      context: activeContext,
      route,
    });
  }, [activeContext, route]);
  const stateRef = useRef(state);
  const loadRequestIdRef = useRef(0);

  // Sync ref after commit so event handlers and async callbacks always
  // see the latest committed state. useLayoutEffect runs synchronously
  // after commit but before paint, avoiding the stale-ref gap of useEffect
  // while respecting React's rule against mutating refs during render.
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  function createRouteApi(input?: {
    context?: StudioMountContext;
    route?: StudioDocumentRouteMountContext;
  }): StudioDocumentRouteApi | undefined {
    const nextContext = input?.context ?? activeContext;
    const nextRoute = input?.route ?? route;

    if (!nextContext || !nextRoute) {
      return undefined;
    }

    return createContentDocumentRouteApi({
      context: nextContext,
      route: nextRoute,
    });
  }

  const loadSelectedVersionDiff = useLatestCallback(async () => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (
      !api ||
      !requestRoute ||
      currentState.status !== "ready" ||
      !currentState.selectedComparison.leftVersion ||
      !currentState.selectedComparison.rightVersion
    ) {
      return;
    }

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });
    const leftVersion = currentState.selectedComparison.leftVersion;
    const rightVersion = currentState.selectedComparison.rightVersion;

    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            versionDiff: {
              status: "loading",
              leftVersion,
              rightVersion,
            },
          }
        : current,
    );

    try {
      const diff = await loadContentDocumentVersionDiff({
        api,
        documentId: currentState.documentId,
        locale: currentState.document.locale,
        leftVersion,
        rightVersion,
      });

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current) &&
        current.selectedComparison.leftVersion === leftVersion &&
        current.selectedComparison.rightVersion === rightVersion
          ? {
              ...current,
              versionDiff: {
                status: "ready",
                diff,
              },
            }
          : current,
      );
    } catch (error) {
      const message = toRouteErrorMessage(
        error,
        "Failed to load document version diff.",
      );

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current) &&
        current.selectedComparison.leftVersion === leftVersion &&
        current.selectedComparison.rightVersion === rightVersion
          ? {
              ...current,
              versionDiff: {
                status: "error",
                leftVersion,
                rightVersion,
                message,
              },
            }
          : current,
      );
    }
  });

  const publishDocument = useLatestCallback(async () => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (
      !api ||
      !requestRoute ||
      currentState.status !== "ready" ||
      !currentState.canWrite
    ) {
      return;
    }

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            publishState: "publishing",
            publishError: undefined,
          }
        : current,
    );

    try {
      const nextState = await publishContentDocumentReadyState({
        api,
        state: currentState,
        changeSummary: currentState.publishChangeSummary,
      });

      const recoveredSchemaState = nextState.schemaState;

      if (hasSchemaRecoveryMismatch(recoveredSchemaState)) {
        setState((current) =>
          current.status === "ready" &&
          matchesContentDocumentRouteRequestToken(requestToken, current)
            ? applyGuardedPublishFailureToReadyState({
                state: current,
                schemaState: recoveredSchemaState,
              })
            : current,
        );
        return;
      }

      // If publish normalized the body, rehydrate the editor — but only
      // if the user hasn't typed newer edits during the in-flight publish.
      const publishedBody = nextState.document.body;
      const latestAfterPublish = stateRef.current;
      if (
        publishedBody !== currentState.draftBody &&
        latestAfterPublish.status === "ready" &&
        matchesContentDocumentRouteRequestToken(
          requestToken,
          latestAfterPublish,
        ) &&
        latestAfterPublish.draftBody === currentState.draftBody &&
        !latestAfterPublish.viewingVersion
      ) {
        editorRef.current?.setContent(publishedBody);
      }

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? applySuccessfulPublishToReadyState({
              state: current,
              requestBody: currentState.draftBody,
              requestFrontmatter: currentState.draftFrontmatter,
              publishedState: nextState,
            })
          : current,
      );
    } catch (error) {
      const message = toRouteErrorMessage(error, "Failed to publish document.");

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? {
              ...current,
              publishState: "idle",
              publishError: message,
            }
          : current,
      );
    }
  });

  const syncSchema = useLatestCallback(async () => {
    const currentState = stateRef.current;

    if (
      currentState.status !== "ready" ||
      !currentState.schemaState ||
      currentState.schemaState.status !== "ready" ||
      !currentState.schemaState.canSync
    ) {
      return;
    }

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: currentState.route,
    });

    // Sync Schema forwards the authored config snapshot through the schema
    // registry contract; Studio does not edit schema definitions here.
    const nextSchemaState = await syncSchemaStateForGuard(
      currentState.schemaState,
    );

    const latestAfterSync = stateRef.current;
    if (
      !nextSchemaState ||
      latestAfterSync.status !== "ready" ||
      !matchesContentDocumentRouteRequestToken(requestToken, latestAfterSync)
    ) {
      return;
    }

    setState((current) =>
      current.status === "ready" &&
      matchesContentDocumentRouteRequestToken(requestToken, current)
        ? applySchemaStateToReadyState({
            state: current,
            schemaState: nextSchemaState,
          })
        : current,
    );
  });

  const loadDocument = useLatestCallback(async () => {
    const loadRequestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = loadRequestId;

    setState(
      createLoadingState({
        typeId,
        typeLabel,
        documentId,
        route,
      }),
    );

    // react-doctor-disable-next-line react-doctor/async-defer-await -- stale route-load results are discarded by the request-id guard immediately after this await.
    const nextState = await loadContentDocumentPageState({
      context: activeContext,
      typeId,
      typeLabel,
      documentId,
    });

    if (loadRequestIdRef.current !== loadRequestId) {
      return;
    }

    setState(nextState);
  });

  const saveDraft = useLatestCallback(async (): Promise<boolean> => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (
      !api ||
      // Fail closed when the embedded host cannot derive the local schema hash
      // required by guarded draft-write routes.
      !requestRoute ||
      !requestRoute.write.canWrite ||
      currentState.status !== "ready"
    ) {
      return false;
    }

    if (
      !currentState.canWrite ||
      currentState.saveState !== "unsaved" ||
      // Both the manual `Save draft` button and the autosave debounce
      // route through this function. Refuse to persist while the user is
      // viewing a historical version — restoring is an explicit action
      // gated by the "Restore this version" button, not a side effect of
      // autosave.
      currentState.viewingVersion ||
      isDraftPersisted(currentState) ||
      (currentState.saveRequestBody === currentState.draftBody &&
        areJsonValuesEqual(
          currentState.saveRequestFrontmatter ?? {},
          currentState.draftFrontmatter,
        ))
    ) {
      return false;
    }

    const requestBody = currentState.draftBody;
    const requestFrontmatter = currentState.draftFrontmatter;
    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });

    setState((current) =>
      current.status === "ready"
        ? reduceContentDocumentPageReadyState(current, {
            type: "saveStarted",
          })
        : current,
    );

    const nextState = await saveContentDocumentReadyState({
      api,
      route: requestRoute,
      state: currentState,
    });

    const recoveredSchemaState = nextState.schemaState;

    if (hasSchemaRecoveryMismatch(recoveredSchemaState)) {
      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? applyGuardedDraftSaveFailureToReadyState({
              state: current,
              schemaState: recoveredSchemaState,
            })
          : current,
      );
      return false;
    }

    const failedFieldName = nextState.fieldErrors
      ? Object.keys(nextState.fieldErrors)[0]
      : undefined;
    const mutationError =
      nextState.mutationError ??
      (failedFieldName ? nextState.fieldErrors?.[failedFieldName] : undefined);

    if (mutationError) {
      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? applyFailedDraftSaveToReadyState({
              state: current,
              requestBody,
              requestFrontmatter,
              message: mutationError,
              fieldName: failedFieldName,
            })
          : current,
      );
      return false;
    }

    // If the server normalized the body (whitespace, etc.), rehydrate the
    // editor — but only if the user hasn't typed newer edits during the
    // in-flight save. The reducer already preserves newer drafts in state.
    const persistedBody = nextState.document.body;
    const latestAfterSave = stateRef.current;
    if (
      persistedBody !== requestBody &&
      latestAfterSave.status === "ready" &&
      matchesContentDocumentRouteRequestToken(requestToken, latestAfterSave) &&
      latestAfterSave.draftBody === requestBody &&
      !latestAfterSave.viewingVersion
    ) {
      editorRef.current?.setContent(persistedBody);
    }

    setState((current) =>
      current.status === "ready" &&
      matchesContentDocumentRouteRequestToken(requestToken, current)
        ? applySuccessfulDraftSaveToReadyState({
            state: current,
            requestBody,
            requestFrontmatter,
            persistedBody,
            persistedFrontmatter: nextState.document.frontmatter,
            updatedAt: nextState.document.updatedAt,
            draftRevision: nextState.document.draftRevision,
          })
        : current,
    );
    return true;
  });

  const handleLocaleSwitch = useLatestCallback(async (targetLocale: string) => {
    const currentState = stateRef.current;
    if (currentState.status !== "ready") return;

    // If selecting the current locale, clear variant creation state
    if (targetLocale === currentState.locale && !currentState.variantCreation) {
      return;
    }

    // Unsaved changes guard: save before switching (covers both unsaved
    // edits and in-flight saves that haven't persisted yet)
    if (
      currentState.saveState !== "saved" &&
      currentState.canWrite &&
      !isDraftPersisted(currentState)
    ) {
      const saved = await saveDraft();

      if (!saved) {
        return;
      }
    }

    const existingVariant = currentState.translationVariants.find(
      (v) => v.locale === targetLocale,
    );

    if (existingVariant) {
      setState((current) =>
        current.status === "ready"
          ? { ...current, variantCreation: undefined }
          : current,
      );
      push(
        `/admin/content/${currentState.typeId}/${existingVariant.documentId}`,
      );
      return;
    }

    // No variant exists — show creation prompt (only if user can write)
    if (!currentState.canWrite) {
      return;
    }

    // Prefer the default locale variant as the prefill source per SPEC-009.
    // Fall back to the current variant if the default locale variant is
    // not available (e.g., not yet created or current doc is the default).
    const defaultLocale = route?.defaultLocale;
    const defaultVariant =
      defaultLocale && defaultLocale !== currentState.locale
        ? currentState.translationVariants.find(
            (v) => v.locale === defaultLocale,
          )
        : undefined;

    const sourceDocumentId =
      defaultVariant?.documentId ?? currentState.documentId;
    const sourceLocale = defaultVariant?.locale ?? currentState.locale;

    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            variantCreation: {
              targetLocale,
              sourceDocumentId,
              sourceLocale,
              status: "idle",
            },
          }
        : current,
    );
  });

  const prepareLivePreviewRefresh = useLatestCallback(async () => {
    const currentState = stateRef.current;

    if (
      currentState.status !== "ready" ||
      !shouldPersistBeforeLivePreviewRefresh(currentState)
    ) {
      return true;
    }

    if (currentState.saveState !== "unsaved") {
      return false;
    }

    return saveDraft();
  });

  const handleCreateVariant = useLatestCallback(async (prefill: boolean) => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (
      !api ||
      !requestRoute ||
      currentState.status !== "ready" ||
      !currentState.variantCreation ||
      !currentState.canWrite
    ) {
      return;
    }

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });
    const { targetLocale, sourceDocumentId } = currentState.variantCreation;

    setState((current) =>
      current.status === "ready" && current.variantCreation
        ? {
            ...current,
            variantCreation: {
              ...current.variantCreation,
              status: "creating",
              error: undefined,
            },
          }
        : current,
    );

    try {
      // Always fetch the source document via loadDraft for prefill because the
      // source variant may differ from the currently loaded document.
      let sourceBody = "";
      let sourceFrontmatter: Record<string, unknown> = {};
      let sourceFormat: "md" | "mdx" = "mdx";

      if (prefill) {
        const sourceDoc = await api.loadDraft({
          documentId: sourceDocumentId,
          type: currentState.typeId,
          locale: currentState.variantCreation.sourceLocale,
        });

        const latestAfterSourceLoad = stateRef.current;
        if (
          latestAfterSourceLoad.status !== "ready" ||
          !matchesContentDocumentRouteRequestToken(
            requestToken,
            latestAfterSourceLoad,
          )
        ) {
          return;
        }

        sourceBody = sourceDoc.body ?? "";
        sourceFrontmatter = sourceDoc.frontmatter ?? {};
        sourceFormat = sourceDoc.format ?? "mdx";
      }

      const result = await api.create({
        type: currentState.typeId,
        path: currentState.document.path,
        locale: targetLocale,
        format: sourceFormat,
        frontmatter: prefill ? sourceFrontmatter : {},
        body: prefill ? sourceBody : "",
        sourceDocumentId,
        schemaHash: requestRoute.write.canWrite
          ? requestRoute.write.schemaHash
          : undefined,
      });

      const latestAfterCreate = stateRef.current;
      if (
        latestAfterCreate.status !== "ready" ||
        !matchesContentDocumentRouteRequestToken(
          requestToken,
          latestAfterCreate,
        )
      ) {
        return;
      }

      push(`/admin/content/${currentState.typeId}/${result.documentId}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create variant.";

      const latestAfterError = stateRef.current;
      if (
        latestAfterError.status !== "ready" ||
        !matchesContentDocumentRouteRequestToken(requestToken, latestAfterError)
      ) {
        return;
      }

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current) &&
        current.variantCreation
          ? {
              ...current,
              variantCreation: {
                ...current.variantCreation,
                status: "idle",
                error: message,
              },
            }
          : current,
      );
    }
  });

  const handleCancelVariantCreation = useLatestCallback(() => {
    setState((current) =>
      current.status === "ready"
        ? { ...current, variantCreation: undefined }
        : current,
    );
  });

  const handleViewVersion = useLatestCallback(async (version: number) => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (!api || !requestRoute || currentState.status !== "ready") return;

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });

    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            viewingVersion: { version, body: "", status: "loading" },
          }
        : current,
    );

    try {
      const versionDoc = await api.getVersion({
        documentId: currentState.documentId,
        locale: currentState.document.locale,
        version,
      });

      const versionBody = versionDoc.body ?? "";

      // Only update the editor if this version is still the one the UI expects.
      // A newer version click may have fired while this fetch was in-flight.
      const afterFetch = stateRef.current;
      if (
        afterFetch.status !== "ready" ||
        !matchesContentDocumentRouteRequestToken(requestToken, afterFetch) ||
        afterFetch.viewingVersion?.version !== version
      ) {
        return;
      }

      editorRef.current?.setContent(versionBody);

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current) &&
        current.viewingVersion?.version === version
          ? {
              ...current,
              viewingVersion: {
                version,
                body: versionBody,
                status: "ready",
              },
            }
          : current,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load version.";

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current) &&
        current.viewingVersion?.version === version
          ? {
              ...current,
              viewingVersion: {
                version,
                body: "",
                status: "error",
                error: message,
              },
            }
          : current,
      );
    }
  });

  const handleBackToDraft = useLatestCallback(() => {
    const currentState = stateRef.current;

    if (currentState.status === "ready") {
      editorRef.current?.setContent(currentState.draftBody);
    }

    setState((current) =>
      current.status === "ready"
        ? { ...current, viewingVersion: undefined }
        : current,
    );
  });

  // Restores a historical published version as the current draft. The
  // server endpoint defaults `targetStatus` to "draft", so the restored
  // body lands in the draft slot and the user can review + republish via
  // the normal flow. We exit version-viewing mode on success so the
  // editor reflects the restored draft, mark the draft as freshly saved
  // (the server already persisted the new draft revision), and refresh
  // version history so the new draftRevision shows.
  const restoreDocumentVersion = useLatestCallback(async (version: number) => {
    const currentState = stateRef.current;
    const requestContext = activeContext;
    const requestRoute = route;
    const api = createRouteApi({
      context: requestContext,
      route: requestRoute,
    });

    if (
      !api ||
      !requestRoute ||
      currentState.status !== "ready" ||
      !currentState.canWrite ||
      currentState.restoreVersionState === "restoring"
    ) {
      return;
    }

    const requestToken = createContentDocumentRouteRequestToken({
      documentId: currentState.documentId,
      route: requestRoute,
    });

    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            restoreVersionState: "restoring",
            restoreVersionError: undefined,
          }
        : current,
    );

    try {
      const restored = await api.restoreVersion({
        documentId: currentState.documentId,
        locale: currentState.document.locale,
        version,
      });

      const restoredBody = restored.body ?? "";
      const restoredFrontmatter = cloneFrontmatter(restored.frontmatter);
      const versionHistoryRefresh =
        await loadContentDocumentVersionHistoryState({
          api,
          state: currentState,
        });

      const afterRestore = stateRef.current;
      if (
        afterRestore.status !== "ready" ||
        !matchesContentDocumentRouteRequestToken(requestToken, afterRestore)
      ) {
        return;
      }

      editorRef.current?.setContent(restoredBody);

      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? {
              ...current,
              document: {
                ...current.document,
                ...restored,
                body: restoredBody,
                frontmatter: restoredFrontmatter,
              },
              draftBody: restoredBody,
              draftFrontmatter: restoredFrontmatter,
              saveState: "saved",
              mutationError: undefined,
              fieldErrors: undefined,
              saveRequestBody: undefined,
              saveRequestFrontmatter: undefined,
              viewingVersion: undefined,
              restoreVersionState: "idle",
              restoreVersionError: undefined,
              versionHistory: versionHistoryRefresh.versionHistory,
            }
          : current,
      );
    } catch (error) {
      const message = toRouteErrorMessage(
        error,
        "Failed to restore document version.",
      );
      setState((current) =>
        current.status === "ready" &&
        matchesContentDocumentRouteRequestToken(requestToken, current)
          ? {
              ...current,
              restoreVersionState: "idle",
              restoreVersionError: message,
            }
          : current,
      );
    }
  });

  const handleAiProposalApplied = useLatestCallback(
    (input: {
      bodyAfter: string;
      documentId?: string;
      frontmatterAfter?: Record<string, unknown>;
      draftRevision?: number;
      updatedAt?: string;
    }) => {
      const currentState = stateRef.current;
      if (currentState.status !== "ready") return;

      const appliedDocumentId = input.documentId ?? currentState.documentId;
      if (appliedDocumentId !== currentState.documentId) return;

      editorRef.current?.setContent(input.bodyAfter);
      setState((current) =>
        current.status === "ready"
          ? applyAssistantProposalDocumentToReadyState({
              state: current,
              document: {
                documentId: appliedDocumentId,
                body: input.bodyAfter,
                ...(input.frontmatterAfter
                  ? { frontmatter: input.frontmatterAfter }
                  : {}),
                ...(typeof input.draftRevision === "number"
                  ? { draftRevision: input.draftRevision }
                  : {}),
                ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
              },
            })
          : current,
      );
    },
  );

  useEffect(() => {
    const onApplied = (event: Event) => {
      const detail = (event as CustomEvent<AssistantProposalAppliedEventDetail>)
        .detail;
      if (!detail) return;

      handleAiProposalApplied({
        bodyAfter: detail.body,
        documentId: detail.documentId,
        frontmatterAfter: detail.frontmatter,
        draftRevision: detail.draftRevision,
        updatedAt: detail.updatedAt,
      });
    };

    document.addEventListener(ASSISTANT_PROPOSAL_APPLIED_EVENT, onApplied);
    return () => {
      document.removeEventListener(ASSISTANT_PROPOSAL_APPLIED_EVENT, onApplied);
    };
  }, [handleAiProposalApplied]);

  useEffect(() => {
    void loadDocument();
  }, [activeContext, documentId, loadDocument, route, typeId, typeLabel]);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      !state.canWrite ||
      state.saveState !== "unsaved" ||
      // Saving while a historical version is being inspected would persist
      // the historical body as a new draft without the user explicitly
      // asking; the "Restore this version" button is the deliberate path.
      state.viewingVersion ||
      isDraftPersisted(state) ||
      (state.saveRequestBody === state.draftBody &&
        areJsonValuesEqual(
          state.saveRequestFrontmatter ?? {},
          state.draftFrontmatter,
        ))
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      void saveDraft();
    }, DOCUMENT_SAVE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [saveDraft, state]);

  useEffect(() => {
    if (
      state.status !== "ready" ||
      !state.selectedComparison.leftVersion ||
      !state.selectedComparison.rightVersion
    ) {
      return;
    }

    if (
      state.versionDiff.status === "ready" &&
      state.versionDiff.diff.leftVersion ===
        state.selectedComparison.leftVersion &&
      state.versionDiff.diff.rightVersion ===
        state.selectedComparison.rightVersion
    ) {
      return;
    }

    if (
      state.versionDiff.status === "loading" &&
      state.versionDiff.leftVersion === state.selectedComparison.leftVersion &&
      state.versionDiff.rightVersion === state.selectedComparison.rightVersion
    ) {
      return;
    }

    void loadSelectedVersionDiff();
  }, [loadSelectedVersionDiff, state]);

  return {
    state,
    context: activeContext,
    sidebarOpen,
    activeMdxComponent,
    onDraftChange: (body) => {
      setState((current) =>
        current.status === "ready"
          ? reduceContentDocumentPageReadyState(current, {
              type: "draftChanged",
              body,
            })
          : current,
      );
    },
    onFrontmatterFieldChange: (fieldName, value) => {
      setState((current) =>
        current.status === "ready"
          ? reduceContentDocumentPageReadyState(current, {
              type: "frontmatterFieldChanged",
              fieldName,
              value,
            })
          : current,
      );
    },
    onActiveMdxComponentChange: setActiveMdxComponent,
    onToggleSidebar: () => setSidebarOpen((current) => !current),
    onGoBack: () => back(),
    onPublishDialogOpenChange: (open) => {
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              publishDialogOpen: open,
              publishState: open ? current.publishState : "idle",
              publishError: open ? undefined : current.publishError,
              publishChangeSummary: open ? current.publishChangeSummary : "",
            }
          : current,
      );
    },
    onPublishChangeSummaryChange: (value) => {
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              publishChangeSummary: value,
            }
          : current,
      );
    },
    onPublishSubmit: () => {
      void publishDocument();
    },
    onSaveNow: () => {
      void saveDraft();
    },
    onPreviewRefresh: prepareLivePreviewRefresh,
    onSchemaSync: () => {
      void syncSchema();
    },
    onSelectComparisonVersion: (side, version) => {
      setState((current) =>
        current.status === "ready"
          ? {
              ...current,
              selectedComparison: {
                ...current.selectedComparison,
                [side === "left" ? "leftVersion" : "rightVersion"]: version,
              },
              versionDiff: resetVersionDiffState(),
            }
          : current,
      );
    },
    onLocaleSwitch: (locale) => {
      void handleLocaleSwitch(locale);
    },
    onCreateVariant: (prefill) => {
      void handleCreateVariant(prefill);
    },
    onCancelVariantCreation: handleCancelVariantCreation,
    editorRef,
    onViewVersion: (version) => {
      void handleViewVersion(version);
    },
    onBackToDraft: handleBackToDraft,
    onRestoreVersion: (version) => {
      void restoreDocumentVersion(version);
    },
    aiSelection,
    onAiSelectionChange: setAiSelection,
    aiApi,
    previewTokenApi,
    onAiProposalApplied: handleAiProposalApplied,
  };
}

export default function ContentDocumentPage({
  context,
}: {
  context?: StudioMountContext;
}) {
  const viewProps = useContentDocumentPageController({ context });
  return <ContentDocumentPageView {...viewProps} />;
}
