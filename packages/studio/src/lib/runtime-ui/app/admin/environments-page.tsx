"use client";

import { useEffect, useId, useMemo, useReducer, type ReactNode } from "react";

import type {
  ContentDocumentResponse,
  DocumentPromotionResult,
  EnvironmentDefinitionsMeta,
  EnvironmentSummary,
} from "@mdcms/shared";
import { ArrowRight, ChevronRight, Plus, X } from "lucide-react";

import { createStudioContentListApi } from "../../../content-list-api.js";
import { createStudioEnvironmentApi } from "../../../environment-api.js";
import { useStudioSession } from "./session-context.js";
import { useStudioMountInfo } from "./mount-info-context.js";
import { PageHeader } from "../../components/layout/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Switch } from "../../components/ui/switch.js";
import { cn } from "../../lib/utils.js";
import {
  PROMOTE_DEFAULT_STATE,
  readRemapDetails,
  readRuntimeErrorMessage,
  readRuntimeErrorStatus,
  resolveDeleteFailureState,
  type EnvironmentPromoteSnapshot,
  type EnvironmentPromoteState,
  type PromoteStage,
} from "./environments-page-state.js";

export type EnvironmentManagementState =
  | { status: "loading"; project: string; message: string }
  | { status: "forbidden"; project: string; message: string }
  | { status: "error"; project: string; message: string }
  | {
      status: "ready";
      project: string;
      environments: EnvironmentSummary[];
      definitionsMeta: EnvironmentDefinitionsMeta;
    };

export type EnvironmentCloneFormState = {
  sourceEnvironmentId: string;
  includeContent: boolean;
  includeSettings: boolean;
  includeDrafts: boolean;
  preservePaths: boolean;
};

type EnvironmentManagementPageViewProps = {
  state: EnvironmentManagementState;
  activeEnvironment?: string | null;
  createName?: string;
  createError?: string | null;
  actionError?: string | null;
  deleteError?: string | null;
  pendingCreate?: boolean;
  pendingDeleteId?: string | null;
  deleteTarget?: EnvironmentSummary | null;
  isCreateDialogOpen?: boolean;
  cloneTarget?: EnvironmentSummary | null;
  cloneForm?: EnvironmentCloneFormState;
  cloneError?: string | null;
  cloneSuccess?: string | null;
  pendingCloneId?: string | null;
  promoteTarget?: EnvironmentSummary | null;
  promoteState?: EnvironmentPromoteState;
  onCreateDialogChange?: (open: boolean) => void;
  onCreateNameChange?: (value: string) => void;
  onCreateSubmit?: () => void;
  onDeleteDialogChange?: (open: boolean) => void;
  onRequestDelete?: (environment: EnvironmentSummary) => void;
  onDeleteConfirm?: () => void;
  onRequestClone?: (environment: EnvironmentSummary) => void;
  onCloneDialogChange?: (open: boolean) => void;
  onCloneFormChange?: (state: EnvironmentCloneFormState) => void;
  onCloneSubmit?: () => void;
  onRequestPromote?: (environment: EnvironmentSummary) => void;
  onPromoteDialogChange?: (open: boolean) => void;
  onPromoteSourceChange?: (id: string) => void;
  onPromoteTargetChange?: (id: string) => void;
  onPromoteToggleDocument?: (documentId: string) => void;
  onPromoteIncludeUnpublishedChange?: (value: boolean) => void;
  onPromoteRunPreview?: () => void;
  onPromoteBackToConfigure?: () => void;
  onPromoteExecute?: () => void;
  onPromoteRunAnother?: () => void;
  onRetry?: () => void;
};

const CREATE_SYNC_REQUIRED_MESSAGE =
  "Environment management requires a successful cms schema sync from the host app repo before new environments can be created.";

function createLoadingState(project: string): EnvironmentManagementState {
  return { status: "loading", project, message: "Loading environments." };
}

function createMissingRouteState(): EnvironmentManagementState {
  return {
    status: "error",
    project: "unknown",
    message:
      "Environment management requires an active project and environment.",
  };
}

function isEnvironmentSummary(value: unknown): value is EnvironmentSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string" &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

const CLONE_DEFAULT_FORM: EnvironmentCloneFormState = {
  sourceEnvironmentId: "",
  includeContent: true,
  includeSettings: false,
  includeDrafts: true,
  preservePaths: true,
};

type EnvironmentPageUiState = {
  isCreateDialogOpen: boolean;
  createName: string;
  createError: string | null;
  actionError: string | null;
  deleteError: string | null;
  pendingCreate: boolean;
  pendingDeleteId: string | null;
  deleteTarget: EnvironmentSummary | null;
  cloneTarget: EnvironmentSummary | null;
  cloneForm: EnvironmentCloneFormState;
  cloneError: string | null;
  cloneSuccess: string | null;
  pendingCloneId: string | null;
  promoteTarget: EnvironmentSummary | null;
  promoteState: EnvironmentPromoteState;
};

type EnvironmentPageUiPatch =
  | Partial<EnvironmentPageUiState>
  | ((state: EnvironmentPageUiState) => Partial<EnvironmentPageUiState>);

const ENVIRONMENT_PAGE_INITIAL_UI: EnvironmentPageUiState = {
  isCreateDialogOpen: false,
  createName: "",
  createError: null,
  actionError: null,
  deleteError: null,
  pendingCreate: false,
  pendingDeleteId: null,
  deleteTarget: null,
  cloneTarget: null,
  cloneForm: CLONE_DEFAULT_FORM,
  cloneError: null,
  cloneSuccess: null,
  pendingCloneId: null,
  promoteTarget: null,
  promoteState: PROMOTE_DEFAULT_STATE,
};

function environmentPageStateReducer(
  _state: EnvironmentManagementState,
  nextState: EnvironmentManagementState,
): EnvironmentManagementState {
  return nextState;
}

function environmentPageUiReducer(
  state: EnvironmentPageUiState,
  update: EnvironmentPageUiPatch,
): EnvironmentPageUiState {
  const patch = typeof update === "function" ? update(state) : update;
  return { ...state, ...patch };
}

function orderedByLineage(
  environments: readonly EnvironmentSummary[],
): EnvironmentSummary[] {
  const result: EnvironmentSummary[] = [];
  const seen = new Set<string>();
  const walk = (node: EnvironmentSummary) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    result.push(node);
    for (const child of environments) {
      if (child.extends === node.name) walk(child);
    }
  };
  for (const root of environments) {
    if (!root.extends) walk(root);
  }
  for (const entry of environments) {
    if (!seen.has(entry.id)) result.push(entry);
  }
  return result;
}

function findEnvById(
  environments: readonly EnvironmentSummary[],
  id: string | null,
): EnvironmentSummary | undefined {
  if (!id) return undefined;
  return environments.find((entry) => entry.id === id);
}

// `EnvironmentSummary.extends` is the parent environment's name (not its id),
// so callers resolving the parent for display use this lookup.
function findEnvByName(
  environments: readonly EnvironmentSummary[],
  name: string | null,
): EnvironmentSummary | undefined {
  if (!name) return undefined;
  return environments.find((entry) => entry.name === name);
}

const PROMOTE_STAGES: { id: PromoteStage; label: string }[] = [
  { id: "configure", label: "Configure" },
  { id: "preview", label: "Preview (dry-run)" },
  { id: "result", label: "Run" },
];

function PromoteStepper({ stage }: { stage: PromoteStage }) {
  const stageOrder: PromoteStage[] = ["configure", "preview", "result"];
  const activeIndex = stageOrder.indexOf(stage);
  return (
    <div
      data-mdcms-environment-promote-stepper={stage}
      className="flex flex-wrap items-center gap-2 border-b border-card-border bg-background-subtle px-5 py-3 font-mono text-[11px]"
    >
      {PROMOTE_STAGES.map((entry, index) => {
        const isActive = entry.id === stage;
        const isDone = index < activeIndex;
        return (
          <span
            key={entry.id}
            className="inline-flex items-center gap-2"
            data-mdcms-environment-promote-step={entry.id}
            data-mdcms-environment-promote-step-state={
              isActive ? "active" : isDone ? "done" : "pending"
            }
          >
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-sm px-2 py-1 text-[11px]",
                isActive && "bg-foreground text-background",
                !isActive && isDone && "text-foreground",
                !isActive && !isDone && "text-foreground-muted",
              )}
            >
              <span
                className={cn(
                  "grid size-4 place-items-center rounded-full bg-background-subtle text-[9px] font-bold",
                  isActive && "bg-primary text-primary-foreground",
                  !isActive && isDone && "bg-success text-primary-foreground",
                )}
              >
                {isDone ? "✓" : index + 1}
              </span>
              {entry.label}
            </span>
            {index < PROMOTE_STAGES.length - 1 ? (
              <ChevronRight className="size-3 text-foreground-muted/60" />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function DefinitionsStrip({ meta }: { meta: EnvironmentDefinitionsMeta }) {
  const ready = meta.definitionsStatus === "ready";
  return (
    <div
      data-mdcms-environments-definitions-strip
      data-mdcms-environments-definitions-status={meta.definitionsStatus}
      className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-primary/60 bg-card px-3.5 py-2.5 font-mono text-[11px] text-foreground-muted"
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          ready ? "bg-success" : "bg-warning",
        )}
      />
      <span className="text-foreground-muted">definitionsStatus</span>
      <span className="text-foreground">{meta.definitionsStatus}</span>
      {ready ? (
        <>
          <span className="h-3 w-px bg-card-border" />
          <span className="text-foreground-muted">configSnapshotHash</span>
          <span className="text-foreground">{meta.configSnapshotHash}</span>
          <span className="h-3 w-px bg-card-border" />
          <span className="text-foreground-muted">syncedAt</span>
          <span className="text-foreground">{meta.syncedAt}</span>
        </>
      ) : (
        <span className="text-foreground">
          run <span className="text-foreground">cms schema sync</span> to enable
          create
        </span>
      )}
    </div>
  );
}

function LineageCard({
  environments,
}: {
  environments: readonly EnvironmentSummary[];
}) {
  const ordered = orderedByLineage(environments);
  return (
    <section
      data-mdcms-environments-lineage
      className="overflow-hidden rounded-lg border border-card-border bg-card"
    >
      <div className="flex items-center gap-3 border-b border-card-border px-5 py-3.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
            Inheritance
          </div>
          <div className="font-heading text-base font-bold text-foreground">
            Lineage
          </div>
        </div>
        <span className="ml-auto font-mono text-[11px] text-foreground-muted">
          child → parent · root is the default env
        </span>
      </div>
      <div className="flex flex-wrap items-stretch gap-0 px-4 py-5">
        {ordered.map((env, index) => {
          const isRoot = !env.extends;
          const parent = findEnvByName(environments, env.extends);
          const isLast = index === ordered.length - 1;
          return (
            <div
              key={env.id}
              className="flex items-stretch"
              data-mdcms-environments-lineage-node={env.name}
            >
              <div
                className={cn(
                  "flex min-h-[132px] min-w-[200px] max-w-[280px] flex-1 flex-col gap-1 rounded-md border border-card-border bg-background p-4",
                  env.isDefault && "border-primary/70 bg-blue-100",
                  isRoot && "border-foreground bg-foreground text-background",
                )}
              >
                <div className="flex flex-wrap gap-1">
                  {env.isDefault ? (
                    <span className="rounded-sm bg-primary px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-primary-foreground">
                      Default
                    </span>
                  ) : null}
                  {isRoot ? (
                    <span
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em]",
                        "bg-background/20 text-background",
                      )}
                    >
                      Root
                    </span>
                  ) : null}
                </div>
                <div className="font-heading text-[18px] font-bold leading-tight">
                  {env.name}
                </div>
                <div
                  className={cn(
                    "font-mono text-[10px] opacity-70",
                    isRoot ? "text-background/80" : "text-foreground-muted",
                  )}
                >
                  {env.id}
                </div>
                {!isRoot ? (
                  <div className="mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] opacity-85">
                    <span className="uppercase tracking-[0.06em] opacity-55">
                      extends
                    </span>
                    <span>← {parent?.name ?? env.extends}</span>
                  </div>
                ) : null}
                <div
                  className={cn(
                    "mt-auto pt-2 font-mono text-[10px] opacity-80",
                    isRoot ? "text-background/80" : "text-foreground-muted",
                  )}
                >
                  {env.isDefault ? "default · production target" : "child env"}
                </div>
              </div>
              {!isLast ? (
                <div className="flex w-7 items-center justify-center text-foreground-muted/60">
                  ──
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EnvironmentRow({
  environment,
  parent,
  pendingDeleteId,
  pendingCloneId,
  isPromotePending,
  onRequestPromote,
  onRequestClone,
  onRequestDelete,
}: {
  environment: EnvironmentSummary;
  parent: EnvironmentSummary | undefined;
  pendingDeleteId: string | null;
  pendingCloneId: string | null;
  isPromotePending: boolean;
  onRequestPromote?: (environment: EnvironmentSummary) => void;
  onRequestClone?: (environment: EnvironmentSummary) => void;
  onRequestDelete?: (environment: EnvironmentSummary) => void;
}) {
  return (
    <tr
      data-mdcms-environment-row={environment.name}
      className="border-t border-card-border align-middle"
    >
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              environment.isDefault ? "bg-primary" : "bg-foreground/40",
            )}
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-heading text-[15px] font-bold leading-tight text-foreground">
                {environment.name}
              </span>
              {environment.isDefault ? (
                <span className="rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.06em] text-background">
                  Default
                </span>
              ) : null}
            </div>
            <span className="font-mono text-[10px] text-foreground-muted">
              {environment.id}
            </span>
          </div>
        </div>
      </td>
      <td className="px-4 py-3.5">
        {parent ? (
          <span className="inline-flex items-center gap-1 rounded-sm bg-background-subtle px-2 py-1 font-mono text-[11px] text-foreground-muted">
            ← extends {parent.name}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-sm bg-background-subtle px-2 py-1 font-mono text-[11px] italic text-foreground-muted">
            root · no parent
          </span>
        )}
      </td>
      <td className="px-4 py-3.5 font-mono text-[11px] text-foreground-muted">
        <time dateTime={environment.createdAt}>{environment.createdAt}</time>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex justify-end gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="default"
            data-mdcms-environment-promote-action={environment.name}
            disabled={isPromotePending}
            onClick={() => onRequestPromote?.(environment)}
          >
            Promote
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-mdcms-environment-clone-action={environment.name}
            disabled={pendingCloneId === environment.id}
            onClick={() => onRequestClone?.(environment)}
          >
            {pendingCloneId === environment.id ? "Cloning…" : "Clone"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              !environment.isDefault &&
                "border-destructive/30 text-destructive hover:text-destructive",
            )}
            disabled={
              environment.isDefault || pendingDeleteId === environment.id
            }
            title={
              environment.isDefault
                ? "Default environment cannot be deleted"
                : "Delete environment"
            }
            onClick={() =>
              !environment.isDefault && onRequestDelete?.(environment)
            }
          >
            {pendingDeleteId === environment.id ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </td>
    </tr>
  );
}

function EnvironmentTable({
  environments,
  pendingDeleteId,
  pendingCloneId,
  isPromotePending,
  onRequestPromote,
  onRequestClone,
  onRequestDelete,
}: {
  environments: readonly EnvironmentSummary[];
  pendingDeleteId: string | null;
  pendingCloneId: string | null;
  isPromotePending: boolean;
  onRequestPromote?: (environment: EnvironmentSummary) => void;
  onRequestClone?: (environment: EnvironmentSummary) => void;
  onRequestDelete?: (environment: EnvironmentSummary) => void;
}) {
  return (
    <section
      data-mdcms-environments-table
      className="overflow-hidden rounded-lg border border-card-border bg-card"
    >
      <div className="flex items-center gap-3 border-b border-card-border px-5 py-3.5">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
            All environments
          </div>
          <div className="font-heading text-base font-bold text-foreground">
            Manage
          </div>
        </div>
      </div>
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-[760px] border-separate border-spacing-0">
          <thead className="bg-background-subtle">
            <tr>
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                Name
              </th>
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                Extends
              </th>
              <th className="px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                Created
              </th>
              <th className="px-4 py-2.5 text-right font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {environments.map((environment) => (
              <EnvironmentRow
                key={environment.id}
                environment={environment}
                parent={
                  environment.extends
                    ? findEnvByName(environments, environment.extends)
                    : undefined
                }
                pendingDeleteId={pendingDeleteId}
                pendingCloneId={pendingCloneId}
                isPromotePending={isPromotePending}
                onRequestPromote={onRequestPromote}
                onRequestClone={onRequestClone}
                onRequestDelete={onRequestDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DrawerShell({
  open,
  onOpenChange,
  kind,
  title,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: string;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  testId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-mdcms-environment-drawer={testId}
        className="left-auto right-0 top-0 grid h-screen max-h-screen w-full max-w-[720px] translate-x-0 translate-y-0 grid-rows-[auto_1fr_auto] gap-0 rounded-none border-l border-card-border bg-card p-0 shadow-[-8px_0_32px_rgba(28,27,27,0.18)]"
      >
        <DialogHeader className="flex flex-row items-center gap-3 border-b border-card-border px-5 py-4 text-left">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
              {kind}
            </div>
            <DialogTitle className="font-heading text-[20px] font-bold leading-tight text-foreground">
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {kind} {title}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid size-7 place-items-center rounded-sm border border-card-border text-foreground-muted hover:bg-background-subtle"
            aria-label="Close drawer"
          >
            <X className="size-3.5" />
          </button>
        </DialogHeader>
        {children}
        <DialogFooter className="flex flex-row items-center gap-2 border-t border-card-border bg-background-subtle px-5 py-3">
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloneDrawer({
  cloneTarget,
  cloneForm,
  cloneError,
  cloneSuccess,
  pendingCloneId,
  state,
  onCloneDialogChange,
  onCloneFormChange,
  onCloneSubmit,
}: {
  cloneTarget: EnvironmentSummary | null;
  cloneForm: EnvironmentCloneFormState;
  cloneError: string | null;
  cloneSuccess: string | null;
  pendingCloneId: string | null;
  state: EnvironmentManagementState;
  onCloneDialogChange?: (open: boolean) => void;
  onCloneFormChange?: (state: EnvironmentCloneFormState) => void;
  onCloneSubmit?: () => void;
}) {
  const sources =
    state.status === "ready" && cloneTarget
      ? state.environments.filter((entry) => entry.id !== cloneTarget.id)
      : [];
  const submitting = cloneTarget !== null && pendingCloneId === cloneTarget.id;
  const submitDisabled = !cloneForm.sourceEnvironmentId || submitting;

  return (
    <DrawerShell
      open={cloneTarget !== null}
      onOpenChange={(open) => onCloneDialogChange?.(open)}
      kind="Clone"
      title={`Clone into ${cloneTarget?.name ?? ""}`}
      testId="clone"
      footer={
        <>
          <span className="flex-1 font-mono text-[10px] text-foreground-muted">
            media inclusion is deferred (SPEC-009).
          </span>
          <Button variant="ghost" onClick={() => onCloneDialogChange?.(false)}>
            Cancel
          </Button>
          <Button
            disabled={submitDisabled}
            onClick={() => onCloneSubmit?.()}
            data-mdcms-environment-clone-submit
          >
            {submitting ? "Cloning…" : "Run clone"}
          </Button>
        </>
      }
    >
      <div
        data-mdcms-environment-clone-dialog={cloneTarget?.name ?? ""}
        className="space-y-5 overflow-y-auto p-5"
      >
        <div className="grid gap-2">
          <Label
            htmlFor="clone-source-env"
            className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted"
          >
            Source environment
          </Label>
          <select
            id="clone-source-env"
            className="h-9 rounded-md border border-card-border bg-background px-3 text-sm text-foreground"
            value={cloneForm.sourceEnvironmentId}
            onChange={(event) =>
              onCloneFormChange?.({
                ...cloneForm,
                sourceEnvironmentId: event.target.value,
              })
            }
          >
            <option value="">Select source environment…</option>
            {sources.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <p className="font-mono text-[10px] text-foreground-muted">
            Documents are bulk-copied from this env into{" "}
            {cloneTarget?.name ?? ""}.
          </p>
        </div>

        <CloneToggleRow
          title="Include content"
          hint="Copy document rows from the source environment."
          checked={cloneForm.includeContent}
          onChange={(value) =>
            onCloneFormChange?.({ ...cloneForm, includeContent: value })
          }
        />
        <CloneToggleRow
          title="Include settings"
          hint="Overwrites synced schema state in the target — opt in only."
          checked={cloneForm.includeSettings}
          onChange={(value) =>
            onCloneFormChange?.({ ...cloneForm, includeSettings: value })
          }
        />
        <CloneToggleRow
          title="Include drafts"
          hint="Clone drafts alongside published versions."
          checked={cloneForm.includeDrafts}
          onChange={(value) =>
            onCloneFormChange?.({ ...cloneForm, includeDrafts: value })
          }
        />
        <CloneToggleRow
          title="Preserve paths"
          hint="Keep source paths exactly as-is in the target."
          checked={cloneForm.preservePaths}
          onChange={(value) =>
            onCloneFormChange?.({ ...cloneForm, preservePaths: value })
          }
        />

        {cloneError ? (
          <p
            data-mdcms-clone-error
            className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive"
          >
            {cloneError}
          </p>
        ) : null}
        {cloneSuccess ? (
          <p
            data-mdcms-clone-success
            className="rounded-md border border-success/30 bg-success-subtle p-2 text-sm text-success"
          >
            {cloneSuccess}
          </p>
        ) : null}
      </div>
    </DrawerShell>
  );
}

function CloneToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const switchId = useId();
  return (
    <label
      htmlFor={switchId}
      className="flex items-center gap-3 border-t border-card-border/60 py-2"
    >
      <div className="flex-1">
        <div className="text-sm text-foreground">{title}</div>
        <div className="font-mono text-[10px] text-foreground-muted">
          {hint}
        </div>
      </div>
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function PromoteDrawer({
  promoteTarget,
  promoteState,
  state,
  onPromoteDialogChange,
  onPromoteSourceChange,
  onPromoteTargetChange,
  onPromoteToggleDocument,
  onPromoteIncludeUnpublishedChange,
  onPromoteRunPreview,
  onPromoteBackToConfigure,
  onPromoteExecute,
  onPromoteRunAnother,
}: {
  promoteTarget: EnvironmentSummary | null;
  promoteState: EnvironmentPromoteState;
  state: EnvironmentManagementState;
  onPromoteDialogChange?: (open: boolean) => void;
  onPromoteSourceChange?: (id: string) => void;
  onPromoteTargetChange?: (id: string) => void;
  onPromoteToggleDocument?: (documentId: string) => void;
  onPromoteIncludeUnpublishedChange?: (value: boolean) => void;
  onPromoteRunPreview?: () => void;
  onPromoteBackToConfigure?: () => void;
  onPromoteExecute?: () => void;
  onPromoteRunAnother?: () => void;
}) {
  const open = promoteTarget !== null;
  const environments = state.status === "ready" ? state.environments : [];
  const source = findEnvById(environments, promoteState.sourceEnvironmentId);
  const target = findEnvById(environments, promoteState.targetEnvironmentId);
  const sameSourceTarget =
    promoteState.sourceEnvironmentId === promoteState.targetEnvironmentId &&
    promoteState.sourceEnvironmentId !== "";
  const canPreview =
    promoteState.selectedDocumentIds.length > 0 &&
    !sameSourceTarget &&
    !!source &&
    !!target;

  const counts = {
    overwrote:
      promoteState.preview.status === "ready"
        ? promoteState.preview.results.filter(
            (entry) => entry.status === "overwrote",
          ).length
        : 0,
    created:
      promoteState.preview.status === "ready"
        ? promoteState.preview.results.filter(
            (entry) => entry.status === "created",
          ).length
        : 0,
    skipped:
      promoteState.preview.status === "ready"
        ? promoteState.preview.results.filter(
            (entry) => entry.status === "skipped_unpublished",
          ).length
        : 0,
  };

  const promotedTotal = counts.overwrote + counts.created;

  return (
    <DrawerShell
      open={open}
      onOpenChange={(value) => onPromoteDialogChange?.(value)}
      kind="Promote"
      title={`Promote ${source?.name ?? "…"} → ${target?.name ?? "…"}`}
      testId="promote"
      footer={
        <>
          <span className="flex-1 font-mono text-[10px] text-foreground-muted">
            {promoteState.stage === "configure" &&
              "Step 1 of 3 · pick docs to promote"}
            {promoteState.stage === "preview" &&
              "Step 2 of 3 · dry-run plan · no writes yet"}
            {promoteState.stage === "result" && "Step 3 of 3 · committed"}
          </span>
          {promoteState.stage === "configure" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onPromoteDialogChange?.(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={
                  !canPreview || promoteState.preview.status === "loading"
                }
                onClick={() => onPromoteRunPreview?.()}
                data-mdcms-environment-promote-preview-button
              >
                {promoteState.preview.status === "loading"
                  ? "Previewing…"
                  : "Preview as dry-run →"}
              </Button>
            </>
          ) : null}
          {promoteState.stage === "preview" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onPromoteBackToConfigure?.()}
              >
                ← Back
              </Button>
              <Button
                disabled={promotedTotal === 0 || promoteState.executing}
                onClick={() => onPromoteExecute?.()}
                data-mdcms-environment-promote-execute-button
              >
                {promoteState.executing
                  ? "Promoting…"
                  : `Promote ${promotedTotal} doc${promotedTotal === 1 ? "" : "s"}`}
              </Button>
            </>
          ) : null}
          {promoteState.stage === "result" ? (
            <>
              <Button variant="ghost" onClick={() => onPromoteRunAnother?.()}>
                Run another
              </Button>
              <Button onClick={() => onPromoteDialogChange?.(false)}>
                Close
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="flex min-h-0 flex-col">
        <PromoteStepper stage={promoteState.stage} />
        <div className="flex-1 overflow-y-auto p-5">
          {promoteState.stage === "configure" ? (
            <PromoteConfigure
              environments={environments}
              promoteState={promoteState}
              sameSourceTarget={sameSourceTarget}
              onPromoteSourceChange={onPromoteSourceChange}
              onPromoteTargetChange={onPromoteTargetChange}
              onPromoteToggleDocument={onPromoteToggleDocument}
              onPromoteIncludeUnpublishedChange={
                onPromoteIncludeUnpublishedChange
              }
            />
          ) : null}
          {promoteState.stage === "preview" ? (
            <PromotePreview
              preview={promoteState.preview}
              counts={counts}
              targetName={target?.name ?? ""}
            />
          ) : null}
          {promoteState.stage === "result" ? (
            <PromoteResult
              results={promoteState.executeResult ?? []}
              targetName={target?.name ?? ""}
              executeError={promoteState.executeError}
            />
          ) : null}
        </div>
      </div>
    </DrawerShell>
  );
}

function PromoteConfigure({
  environments,
  promoteState,
  sameSourceTarget,
  onPromoteSourceChange,
  onPromoteTargetChange,
  onPromoteToggleDocument,
  onPromoteIncludeUnpublishedChange,
}: {
  environments: readonly EnvironmentSummary[];
  promoteState: EnvironmentPromoteState;
  sameSourceTarget: boolean;
  onPromoteSourceChange?: (id: string) => void;
  onPromoteTargetChange?: (id: string) => void;
  onPromoteToggleDocument?: (documentId: string) => void;
  onPromoteIncludeUnpublishedChange?: (value: boolean) => void;
}) {
  const documentsLoading = promoteState.documentsLoading;
  const documents = promoteState.documents;
  const documentsError = promoteState.documentsError;
  const includeUnpublishedSwitchId = useId();

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3">
        <div className="grid gap-2">
          <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
            Source environment
          </Label>
          <select
            data-mdcms-environment-promote-source
            className="h-9 rounded-md border border-card-border bg-background px-3 text-sm text-foreground"
            value={promoteState.sourceEnvironmentId}
            onChange={(event) => onPromoteSourceChange?.(event.target.value)}
          >
            {environments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="pb-2 font-mono text-lg text-foreground-muted">→</div>
        <div className="grid gap-2">
          <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
            Target environment
          </Label>
          <select
            data-mdcms-environment-promote-target
            className="h-9 rounded-md border border-card-border bg-background px-3 text-sm text-foreground"
            value={promoteState.targetEnvironmentId}
            onChange={(event) => onPromoteTargetChange?.(event.target.value)}
          >
            {environments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sameSourceTarget ? (
        <p className="mt-2 font-mono text-[11px] text-destructive">
          Source and target must differ.
        </p>
      ) : null}

      <div className="mt-5 grid gap-2">
        <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
          Documents · {promoteState.selectedDocumentIds.length} selected
        </Label>
        <div
          className="max-h-[260px] overflow-auto rounded-md border border-card-border bg-background"
          data-mdcms-environment-promote-document-list
        >
          {documentsLoading ? (
            <p className="px-4 py-3 text-sm text-foreground-muted">
              Loading documents…
            </p>
          ) : documentsError ? (
            <p
              data-mdcms-environment-promote-documents-error
              className="px-4 py-3 text-sm text-destructive"
            >
              {documentsError}
            </p>
          ) : documents.length === 0 ? (
            <p className="px-4 py-3 text-sm text-foreground-muted">
              No documents in source environment.
            </p>
          ) : (
            documents.map((doc) => {
              const checked = promoteState.selectedDocumentIds.includes(
                doc.documentId,
              );
              return (
                <label
                  key={doc.documentId}
                  className="flex items-center gap-3 border-b border-card-border/60 px-3 py-2 text-sm last:border-b-0"
                  data-mdcms-environment-promote-document-row={doc.documentId}
                >
                  <input
                    aria-label={`Promote ${doc.path}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onPromoteToggleDocument?.(doc.documentId)}
                    data-mdcms-environment-promote-document-checkbox={
                      doc.documentId
                    }
                    className="size-3.5"
                  />
                  <span className="flex-1 truncate font-mono text-[11px] text-foreground">
                    {doc.path}
                  </span>
                  <span className="font-mono text-[10px] text-foreground-muted">
                    {doc.type} · {doc.locale} ·{" "}
                    {doc.publishedVersion === null
                      ? "draft"
                      : `pub v${doc.publishedVersion}`}
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>

      <label
        htmlFor={includeUnpublishedSwitchId}
        className="mt-4 flex items-center gap-3 border-t border-card-border/60 py-2"
      >
        <div className="flex-1">
          <div className="text-sm text-foreground">Include unpublished</div>
          <div className="font-mono text-[10px] text-foreground-muted">
            By default only published documents promote; turn on to include
            drafts.
          </div>
        </div>
        <Switch
          id={includeUnpublishedSwitchId}
          checked={promoteState.includeUnpublished}
          onCheckedChange={(value) =>
            onPromoteIncludeUnpublishedChange?.(value)
          }
        />
      </label>
    </>
  );
}

function PromotePreview({
  preview,
  counts,
  targetName,
}: {
  preview: EnvironmentPromoteState["preview"];
  counts: { overwrote: number; created: number; skipped: number };
  targetName: string;
}) {
  if (preview.status === "loading") {
    return (
      <p className="text-sm text-foreground-muted">Generating dry-run plan…</p>
    );
  }
  if (preview.status === "error") {
    return (
      <section
        data-mdcms-environment-promote-preview-error
        className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        <p>{preview.message}</p>
        {preview.remapDetails ? (
          <p className="font-mono text-[11px]">
            Field {preview.remapDetails.fieldPath ?? "?"} on source{" "}
            {preview.remapDetails.sourceDocumentId ?? "?"} cannot be remapped to
            ({preview.remapDetails.translationGroupId ?? "?"},{" "}
            {preview.remapDetails.locale ?? "?"}) in target.
          </p>
        ) : null}
      </section>
    );
  }
  if (preview.status !== "ready") return null;

  return (
    <div data-mdcms-environment-promote-preview className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-subtle p-3">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-warning text-[12px] font-bold text-primary-foreground">
          !
        </span>
        <div className="text-xs leading-relaxed text-foreground">
          <div className="font-semibold">
            No merge: target content is replaced.
          </div>
          Promotes overwrite matching target documents in {targetName} entirely.
          Each document is auto-published;{" "}
          <span className="font-mono">publishedVersion</span> is bumped and
          frontmatter references are atomically remapped to the target env.
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        <PreviewTile label="Will overwrite" value={counts.overwrote} />
        <PreviewTile label="Will create" value={counts.created} />
        <PreviewTile label="Skipped" value={counts.skipped} />
      </div>

      <PromotePlanList results={preview.results} mode="preview" />
    </div>
  );
}

function PreviewTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-card-border bg-background px-3 py-2.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-foreground-muted">
        {label}
      </div>
      <div className="mt-1 font-heading text-[24px] font-bold leading-none text-foreground">
        {value}
      </div>
    </div>
  );
}

function PromotePlanList({
  results,
  mode,
}: {
  results: readonly DocumentPromotionResult[];
  mode: "preview" | "result";
}) {
  return (
    <div className="overflow-hidden rounded-md border border-card-border">
      <div className="grid grid-cols-[80px_minmax(0,1fr)_56px_110px] items-center gap-2.5 bg-background-subtle px-3.5 py-2 font-mono text-[9px] uppercase tracking-[0.08em] text-foreground-muted">
        <span>Status</span>
        <span>Path</span>
        <span>Locale</span>
        <span className="text-right">
          {mode === "preview" ? "Remap refs" : "Target id"}
        </span>
      </div>
      {results.map((entry) => (
        <div
          key={entry.sourceDocumentId}
          className="grid grid-cols-[80px_minmax(0,1fr)_56px_110px] items-center gap-2.5 border-b border-card-border/60 px-3.5 py-2 font-mono text-[11px] last:border-b-0"
          data-mdcms-environment-promote-row={entry.sourceDocumentId}
        >
          <PromoteStatusPill status={entry.status} />
          <span className="truncate text-foreground">{entry.path}</span>
          <span className="text-foreground-muted">{entry.locale}</span>
          <span className="truncate text-right text-foreground-muted">
            {mode === "preview"
              ? `${entry.remappedReferences} remapped`
              : entry.targetDocumentId
                ? `${entry.targetDocumentId.slice(0, 12)}…`
                : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromoteStatusPill({
  status,
}: {
  status: DocumentPromotionResult["status"];
}) {
  const label = status === "skipped_unpublished" ? "skipped" : status;
  return (
    <span
      data-mdcms-environment-promote-status={status}
      className={cn(
        "inline-flex w-fit items-center rounded-sm px-1 py-px font-mono text-[8px] font-bold uppercase tracking-[0.06em] leading-tight",
        status === "overwrote" && "bg-primary/20 text-primary",
        status === "created" && "bg-success/20 text-success",
        status === "skipped_unpublished" &&
          "bg-background-subtle text-foreground-muted",
      )}
    >
      {label}
    </span>
  );
}

function PromoteResult({
  results,
  targetName,
  executeError,
}: {
  results: readonly DocumentPromotionResult[];
  targetName: string;
  executeError: string | null;
}) {
  if (executeError) {
    return (
      <section
        data-mdcms-environment-promote-execute-error
        className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {executeError}
      </section>
    );
  }
  const promotedTotal = results.filter(
    (entry) => entry.status !== "skipped_unpublished",
  ).length;
  const refsRemapped = results.reduce(
    (acc, entry) => acc + entry.remappedReferences,
    0,
  );

  return (
    <div data-mdcms-environment-promote-result className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-md border border-success/30 bg-success-subtle p-3">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-success text-[12px] font-bold text-primary-foreground">
          ✓
        </span>
        <div className="text-xs leading-relaxed text-foreground">
          <div className="font-semibold">
            Promoted {promotedTotal} document{promotedTotal === 1 ? "" : "s"}{" "}
            into {targetName}.
          </div>
          Atomic remap succeeded · {refsRemapped} references rewritten.
        </div>
      </div>
      <PromotePlanList results={results} mode="result" />
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) return null;
  return (
    <Button variant="ghost" onClick={onRetry}>
      Retry
    </Button>
  );
}

export function EnvironmentManagementPageView({
  state,
  activeEnvironment = null,
  createName = "",
  createError = null,
  actionError = null,
  deleteError = null,
  pendingCreate = false,
  pendingDeleteId = null,
  deleteTarget = null,
  isCreateDialogOpen = false,
  cloneTarget = null,
  cloneForm = CLONE_DEFAULT_FORM,
  cloneError = null,
  cloneSuccess = null,
  pendingCloneId = null,
  promoteTarget = null,
  promoteState = PROMOTE_DEFAULT_STATE,
  onCreateDialogChange,
  onCreateNameChange,
  onCreateSubmit,
  onDeleteDialogChange,
  onRequestDelete,
  onDeleteConfirm,
  onRequestClone,
  onCloneDialogChange,
  onCloneFormChange,
  onCloneSubmit,
  onRequestPromote,
  onPromoteDialogChange,
  onPromoteSourceChange,
  onPromoteTargetChange,
  onPromoteToggleDocument,
  onPromoteIncludeUnpublishedChange,
  onPromoteRunPreview,
  onPromoteBackToConfigure,
  onPromoteExecute,
  onPromoteRunAnother,
  onRetry,
}: EnvironmentManagementPageViewProps) {
  void activeEnvironment;
  const canManage = state.status === "ready";
  const canCreate =
    state.status === "ready" &&
    state.definitionsMeta.definitionsStatus === "ready";

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Environments" }]} />

      <div className="space-y-6 p-6 lg:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1.5">
            <h1 className="font-heading text-[36px] font-semibold leading-[1.05] tracking-tight text-foreground">
              Environments
            </h1>
            <p className="font-mono text-[12px] text-foreground-muted">
              {canManage
                ? `${state.environments.length} environments`
                : `Manage project environments for ${state.project}.`}
            </p>
          </div>
          {canManage ? (
            <Dialog
              open={isCreateDialogOpen}
              onOpenChange={(open) => onCreateDialogChange?.(open)}
            >
              <Button
                type="button"
                disabled={!canCreate}
                onClick={() => onCreateDialogChange?.(true)}
              >
                <Plus className="mr-1.5 size-4" />
                New environment
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create environment</DialogTitle>
                  <DialogDescription>
                    Create a new environment for this project.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 py-2">
                  <div className="grid gap-2">
                    <Label htmlFor="environment-name">Name</Label>
                    <Input
                      id="environment-name"
                      placeholder="e.g. staging"
                      value={createName}
                      onChange={(event) =>
                        onCreateNameChange?.(event.target.value)
                      }
                    />
                  </div>
                  {createError ? (
                    <p className="text-sm text-destructive">{createError}</p>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    onClick={() => onCreateDialogChange?.(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={pendingCreate}
                    onClick={() => onCreateSubmit?.()}
                  >
                    {pendingCreate ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>

        {actionError ? (
          <section
            data-mdcms-page-action-error
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            {actionError}
          </section>
        ) : null}

        {state.status === "ready" ? (
          <DefinitionsStrip meta={state.definitionsMeta} />
        ) : null}

        {state.status === "ready" &&
        state.definitionsMeta.definitionsStatus === "missing" ? (
          <section
            data-mdcms-environments-create-gated
            className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
          >
            {CREATE_SYNC_REQUIRED_MESSAGE}
          </section>
        ) : null}

        {state.status === "loading" ? (
          <section
            data-mdcms-environments-page-state="loading"
            className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
          >
            {state.message}
          </section>
        ) : state.status === "forbidden" ? (
          <section
            data-mdcms-environments-page-state="forbidden"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="default">Forbidden</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">{state.project}</p>
          </section>
        ) : state.status === "error" ? (
          <section
            data-mdcms-environments-page-state="error"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="destructive">Error</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">{state.project}</p>
            <RetryButton onRetry={onRetry} />
          </section>
        ) : state.environments.length === 0 ? (
          <section
            data-mdcms-environments-page-state="empty"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="outline">Empty</Badge>
            <p className="text-sm text-muted-foreground">
              No environments were returned for this project yet.
            </p>
            <p className="text-xs text-muted-foreground">{state.project}</p>
          </section>
        ) : (
          <div data-mdcms-environments-page-state="ready" className="space-y-5">
            <LineageCard environments={state.environments} />
            <EnvironmentTable
              environments={state.environments}
              pendingDeleteId={pendingDeleteId}
              pendingCloneId={pendingCloneId}
              isPromotePending={promoteTarget !== null}
              onRequestPromote={onRequestPromote}
              onRequestClone={onRequestClone}
              onRequestDelete={onRequestDelete}
            />
          </div>
        )}

        <CloneDrawer
          cloneTarget={cloneTarget}
          cloneForm={cloneForm}
          cloneError={cloneError}
          cloneSuccess={cloneSuccess}
          pendingCloneId={pendingCloneId}
          state={state}
          onCloneDialogChange={onCloneDialogChange}
          onCloneFormChange={onCloneFormChange}
          onCloneSubmit={onCloneSubmit}
        />

        <PromoteDrawer
          promoteTarget={promoteTarget}
          promoteState={promoteState}
          state={state}
          onPromoteDialogChange={onPromoteDialogChange}
          onPromoteSourceChange={onPromoteSourceChange}
          onPromoteTargetChange={onPromoteTargetChange}
          onPromoteToggleDocument={onPromoteToggleDocument}
          onPromoteIncludeUnpublishedChange={onPromoteIncludeUnpublishedChange}
          onPromoteRunPreview={onPromoteRunPreview}
          onPromoteBackToConfigure={onPromoteBackToConfigure}
          onPromoteExecute={onPromoteExecute}
          onPromoteRunAnother={onPromoteRunAnother}
        />

        <Dialog
          open={deleteTarget !== null}
          onOpenChange={(open) => onDeleteDialogChange?.(open)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete environment</DialogTitle>
              <DialogDescription>
                {isEnvironmentSummary(deleteTarget)
                  ? `Delete ${deleteTarget.name} from ${state.project}?`
                  : "Delete this environment?"}
              </DialogDescription>
            </DialogHeader>
            {deleteError ? (
              <p data-mdcms-delete-error className="text-sm text-destructive">
                {deleteError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => onDeleteDialogChange?.(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!deleteTarget || pendingDeleteId === deleteTarget.id}
                onClick={() => onDeleteConfirm?.()}
              >
                {deleteTarget && pendingDeleteId === deleteTarget.id
                  ? `Deleting ${deleteTarget.name}…`
                  : deleteTarget
                    ? `Delete ${deleteTarget.name}`
                    : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function useEnvironmentPageController(): EnvironmentManagementPageViewProps {
  const { project, environment, apiBaseUrl, auth } = useStudioMountInfo();
  const sessionState = useStudioSession();
  const [state, setEnvironmentState] = useReducer(
    environmentPageStateReducer,
    project ? createLoadingState(project) : createMissingRouteState(),
  );
  const [uiState, updateUiState] = useReducer(
    environmentPageUiReducer,
    ENVIRONMENT_PAGE_INITIAL_UI,
  );
  const {
    isCreateDialogOpen,
    createName,
    createError,
    actionError,
    deleteError,
    pendingCreate,
    pendingDeleteId,
    deleteTarget,
    cloneTarget,
    cloneForm,
    cloneError,
    cloneSuccess,
    pendingCloneId,
    promoteTarget,
    promoteState,
  } = uiState;
  const setIsCreateDialogOpen = (isCreateDialogOpen: boolean) =>
    updateUiState({ isCreateDialogOpen });
  const setCreateName = (createName: string) => updateUiState({ createName });
  const setCreateError = (createError: string | null) =>
    updateUiState({ createError });
  const setActionError = (actionError: string | null) =>
    updateUiState({ actionError });
  const setDeleteError = (deleteError: string | null) =>
    updateUiState({ deleteError });
  const setPendingCreate = (pendingCreate: boolean) =>
    updateUiState({ pendingCreate });
  const setPendingDeleteId = (pendingDeleteId: string | null) =>
    updateUiState({ pendingDeleteId });
  const setDeleteTarget = (deleteTarget: EnvironmentSummary | null) =>
    updateUiState({ deleteTarget });
  const setCloneTarget = (cloneTarget: EnvironmentSummary | null) =>
    updateUiState({ cloneTarget });
  const setCloneForm = (cloneForm: EnvironmentCloneFormState) =>
    updateUiState({ cloneForm });
  const setCloneError = (cloneError: string | null) =>
    updateUiState({ cloneError });
  const setCloneSuccess = (cloneSuccess: string | null) =>
    updateUiState({ cloneSuccess });
  const setPendingCloneId = (pendingCloneId: string | null) =>
    updateUiState({ pendingCloneId });
  const setPromoteTarget = (promoteTarget: EnvironmentSummary | null) =>
    updateUiState({ promoteTarget });
  const setPromoteState = (
    promoteState:
      | EnvironmentPromoteState
      | ((previousState: EnvironmentPromoteState) => EnvironmentPromoteState),
  ) =>
    updateUiState((currentUiState) => ({
      promoteState:
        typeof promoteState === "function"
          ? promoteState(currentUiState.promoteState)
          : promoteState,
    }));
  const [reloadVersion, requestReload] = useReducer(
    (version: number) => version + 1,
    0,
  );

  useEffect(() => {
    let cancelled = false;

    const loadEnvironments = async () => {
      if (!project || !environment) {
        setEnvironmentState(createMissingRouteState());
        return;
      }

      setEnvironmentState(createLoadingState(project));

      const environmentApi = createStudioEnvironmentApi(
        { project, environment, serverUrl: apiBaseUrl },
        { auth },
      );

      try {
        const result = await environmentApi.list();
        if (cancelled) return;
        setEnvironmentState({
          status: "ready",
          project,
          environments: result.data.toSorted((left, right) => {
            if (left.isDefault !== right.isDefault) {
              return left.isDefault ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          }),
          definitionsMeta: result.meta,
        });
      } catch (error) {
        if (cancelled) return;
        const message = readRuntimeErrorMessage(
          error,
          "Environment request failed.",
        );
        const statusCode = readRuntimeErrorStatus(error);
        setEnvironmentState(
          statusCode === 401 || statusCode === 403
            ? { status: "forbidden", project, message }
            : { status: "error", project, message },
        );
      }
    };

    void loadEnvironments();

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, auth, environment, project, reloadVersion]);

  const sourceEnvName = useMemo(() => {
    if (state.status !== "ready") return null;
    return state.environments.find(
      (entry) => entry.id === promoteState.sourceEnvironmentId,
    )?.name;
  }, [state, promoteState.sourceEnvironmentId]);

  // Load source documents whenever the promote drawer is open and the source
  // environment changes.
  useEffect(() => {
    let cancelled = false;

    const loadSourceDocuments = async () => {
      if (
        !project ||
        promoteTarget === null ||
        !sourceEnvName ||
        state.status !== "ready"
      ) {
        return;
      }

      setPromoteState((prev) => ({
        ...prev,
        documents: [],
        documentsLoading: true,
        documentsError: null,
        selectedDocumentIds: [],
      }));

      const contentApi = createStudioContentListApi(
        { project, environment: sourceEnvName, serverUrl: apiBaseUrl },
        { auth },
      );

      // Paginate exhaustively so the picker reflects the entire source
      // environment, not just the first 100 results. The cap protects against
      // pathological pagination loops and matches what an operator can
      // reasonably scroll in a drawer.
      const PAGE_SIZE = 100;
      const HARD_CAP = 1000;
      const collected: ContentDocumentResponse[] = [];
      let offset = 0;
      while (collected.length < HARD_CAP) {
        const result = await contentApi.list({
          limit: PAGE_SIZE,
          offset,
          sort: "updatedAt",
          order: "desc",
        });
        if (cancelled) return collected;
        collected.push(...result.data);
        if (!result.pagination.hasMore || result.data.length === 0) break;
        offset = collected.length;
      }
      return collected;
    };

    const loadDocuments = async () => {
      try {
        const documents = await loadSourceDocuments();
        if (!documents) return;
        if (cancelled) return;
        setPromoteState((prev) => ({
          ...prev,
          documents,
          documentsLoading: false,
          documentsError: null,
        }));
      } catch (error) {
        if (cancelled) return;
        setPromoteState((prev) => ({
          ...prev,
          documentsLoading: false,
          documentsError: readRuntimeErrorMessage(
            error,
            "Failed to load source environment documents.",
          ),
        }));
      }
    };

    void loadDocuments();

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, auth, project, promoteTarget, sourceEnvName, state]);

  // Invalidate any existing preview when configure inputs change.
  useEffect(() => {
    setPromoteState((prev) => {
      if (prev.preview.status !== "ready") return prev;
      return { ...prev, preview: { status: "idle" } };
    });
  }, [
    promoteState.sourceEnvironmentId,
    promoteState.targetEnvironmentId,
    promoteState.selectedDocumentIds,
    promoteState.includeUnpublished,
  ]);

  async function handleCreateSubmit() {
    if (!project || !environment) {
      setCreateError("Environment management requires an active project.");
      return;
    }
    if (
      state.status !== "ready" ||
      state.definitionsMeta.definitionsStatus !== "ready"
    ) {
      setCreateError(CREATE_SYNC_REQUIRED_MESSAGE);
      return;
    }
    if (sessionState.status !== "authenticated") {
      setCreateError("Session could not be verified.");
      return;
    }

    setPendingCreate(true);
    setCreateError(null);
    setActionError(null);
    try {
      const environmentApi = createStudioEnvironmentApi(
        { project, environment, serverUrl: apiBaseUrl },
        { auth, csrfToken: sessionState.csrfToken },
      );
      await environmentApi.create({ name: createName });
      setCreateName("");
      setIsCreateDialogOpen(false);
      requestReload();
    } catch (error) {
      setCreateError(
        readRuntimeErrorMessage(error, "Environment creation failed."),
      );
    } finally {
      setPendingCreate(false);
    }
  }

  async function handleCloneSubmit() {
    if (!project || !environment || !cloneTarget) {
      setCloneError("Clone requires an active project and target.");
      return;
    }
    if (sessionState.status !== "authenticated") {
      setCloneError("Session could not be verified.");
      return;
    }
    if (!cloneForm.sourceEnvironmentId) {
      setCloneError("Pick a source environment to clone from.");
      return;
    }
    if (cloneForm.sourceEnvironmentId === cloneTarget.id) {
      setCloneError("Source and target environment must differ.");
      return;
    }

    setPendingCloneId(cloneTarget.id);
    setCloneError(null);
    setCloneSuccess(null);
    try {
      const environmentApi = createStudioEnvironmentApi(
        { project, environment, serverUrl: apiBaseUrl },
        { auth, csrfToken: sessionState.csrfToken },
      );
      const result = await environmentApi.clone(cloneTarget.id, {
        sourceEnvironmentId: cloneForm.sourceEnvironmentId,
        include: {
          content: cloneForm.includeContent,
          settings: cloneForm.includeSettings,
        },
        includeDrafts: cloneForm.includeDrafts,
        preservePaths: cloneForm.preservePaths,
      });
      setCloneSuccess(
        `Cloned ${result.documentsCloned} document${result.documentsCloned === 1 ? "" : "s"} into ${cloneTarget.name}.`,
      );
      requestReload();
    } catch (error) {
      setCloneError(
        readRuntimeErrorMessage(error, "Environment clone failed."),
      );
    } finally {
      setPendingCloneId(null);
    }
  }

  async function handleDeleteConfirm() {
    if (!project || !environment || !deleteTarget) {
      setActionError("Environment deletion requires an active target.");
      return;
    }
    if (sessionState.status !== "authenticated") {
      setActionError("Session could not be verified.");
      return;
    }

    setPendingDeleteId(deleteTarget.id);
    setActionError(null);
    setDeleteError(null);
    try {
      const environmentApi = createStudioEnvironmentApi(
        { project, environment, serverUrl: apiBaseUrl },
        { auth, csrfToken: sessionState.csrfToken },
      );
      await environmentApi.delete(deleteTarget.id);
      setDeleteError(null);
      setDeleteTarget(null);
      requestReload();
    } catch (error) {
      const failure = resolveDeleteFailureState(error);
      setActionError(failure.renderInDialog ? null : failure.message);
      setDeleteError(failure.renderInDialog ? failure.message : null);
      if (failure.shouldCloseDialog) setDeleteTarget(null);
      if (failure.shouldReload) {
        requestReload();
      }
    } finally {
      setPendingDeleteId(null);
    }
  }

  async function handlePromotePreview() {
    if (!project || state.status !== "ready") return;
    const source = state.environments.find(
      (entry) => entry.id === promoteState.sourceEnvironmentId,
    );
    const target = state.environments.find(
      (entry) => entry.id === promoteState.targetEnvironmentId,
    );
    if (!source || !target) return;
    if (sessionState.status !== "authenticated") {
      setPromoteState((prev) => ({
        ...prev,
        preview: { status: "error", message: "Session could not be verified." },
      }));
      return;
    }
    if (promoteState.selectedDocumentIds.length === 0) {
      setPromoteState((prev) => ({
        ...prev,
        preview: {
          status: "error",
          message: "Pick at least one source document to promote.",
        },
      }));
      return;
    }

    const snapshot: EnvironmentPromoteSnapshot = {
      sourceEnvId: source.id,
      sourceEnvName: source.name,
      targetEnvId: target.id,
      targetEnvName: target.name,
      documentIds: [...promoteState.selectedDocumentIds],
      includeUnpublished: promoteState.includeUnpublished,
    };

    setPromoteState((prev) => ({ ...prev, preview: { status: "loading" } }));

    try {
      const environmentApi = createStudioEnvironmentApi(
        { project, environment: snapshot.sourceEnvName, serverUrl: apiBaseUrl },
        { auth, csrfToken: sessionState.csrfToken },
      );
      const result = await environmentApi.promote(snapshot.targetEnvId, {
        sourceEnvironmentId: snapshot.sourceEnvId,
        documentIds: snapshot.documentIds,
        includeUnpublished: snapshot.includeUnpublished,
        dryRun: true,
      });
      setPromoteState((prev) => ({
        ...prev,
        stage: "preview",
        preview: { status: "ready", results: result.promoted, snapshot },
      }));
    } catch (error) {
      // Advance the stepper to the preview stage so PromotePreview mounts and
      // renders the error state — without this, the drawer stays on configure
      // and the failure is silently invisible.
      setPromoteState((prev) => ({
        ...prev,
        stage: "preview",
        preview: {
          status: "error",
          message: readRuntimeErrorMessage(error, "Promote preview failed."),
          remapDetails: readRemapDetails(error),
        },
      }));
    }
  }

  async function handlePromoteExecute() {
    if (!project || promoteState.preview.status !== "ready") return;
    if (sessionState.status !== "authenticated") {
      setPromoteState((prev) => ({
        ...prev,
        executeError: "Session could not be verified.",
      }));
      return;
    }
    const snapshot = promoteState.preview.snapshot;
    setPromoteState((prev) => ({
      ...prev,
      executing: true,
      executeError: null,
      executeResult: null,
    }));

    try {
      const environmentApi = createStudioEnvironmentApi(
        { project, environment: snapshot.sourceEnvName, serverUrl: apiBaseUrl },
        { auth, csrfToken: sessionState.csrfToken },
      );
      const preallocatedTargetIds: Record<string, string> = {};
      if (promoteState.preview.status === "ready") {
        for (const entry of promoteState.preview.results) {
          if (entry.status === "created" && entry.targetDocumentId) {
            preallocatedTargetIds[entry.sourceDocumentId] =
              entry.targetDocumentId;
          }
        }
      }
      const result = await environmentApi.promote(snapshot.targetEnvId, {
        sourceEnvironmentId: snapshot.sourceEnvId,
        documentIds: snapshot.documentIds,
        includeUnpublished: snapshot.includeUnpublished,
        dryRun: false,
        ...(Object.keys(preallocatedTargetIds).length > 0
          ? { preallocatedTargetIds }
          : {}),
      });
      setPromoteState((prev) => ({
        ...prev,
        stage: "result",
        executing: false,
        executeResult: result.promoted,
      }));
      requestReload();
    } catch (error) {
      setPromoteState((prev) => ({
        ...prev,
        stage: "result",
        executing: false,
        executeError: readRuntimeErrorMessage(
          error,
          "Promote execution failed.",
        ),
      }));
    }
  }

  return {
    state,
    activeEnvironment: environment,
    createName,
    createError,
    actionError,
    pendingCreate,
    pendingDeleteId,
    deleteTarget,
    cloneTarget,
    cloneForm,
    cloneError,
    cloneSuccess,
    pendingCloneId,
    promoteTarget,
    promoteState,
    onRequestClone: (target) => {
      setCloneTarget(target);
      setCloneError(null);
      setCloneSuccess(null);
      const defaultSource =
        state.status === "ready"
          ? state.environments.find(
              (entry) => entry.id !== target.id && entry.name === environment,
            )
          : undefined;
      setCloneForm({
        ...CLONE_DEFAULT_FORM,
        sourceEnvironmentId: defaultSource?.id ?? "",
      });
    },
    onCloneDialogChange: (open) => {
      if (!open) {
        setCloneTarget(null);
        setCloneError(null);
        setCloneSuccess(null);
      }
    },
    onCloneFormChange: setCloneForm,
    onCloneSubmit: handleCloneSubmit,
    onRequestPromote: (target) => {
      if (state.status !== "ready") return;
      const defaultSource =
        state.environments.find(
          (entry) => entry.id !== target.id && entry.name === environment,
        ) ?? state.environments.find((entry) => entry.id !== target.id);
      setPromoteTarget(target);
      setPromoteState({
        ...PROMOTE_DEFAULT_STATE,
        sourceEnvironmentId: defaultSource?.id ?? "",
        targetEnvironmentId: target.id,
      });
    },
    onPromoteDialogChange: (open) => {
      if (!open) {
        setPromoteTarget(null);
        setPromoteState(PROMOTE_DEFAULT_STATE);
      }
    },
    onPromoteSourceChange: (id) =>
      setPromoteState((prev) => ({
        ...prev,
        sourceEnvironmentId: id,
        selectedDocumentIds: [],
      })),
    onPromoteTargetChange: (id) =>
      setPromoteState((prev) => ({ ...prev, targetEnvironmentId: id })),
    onPromoteToggleDocument: (documentId) =>
      setPromoteState((prev) => ({
        ...prev,
        selectedDocumentIds: prev.selectedDocumentIds.includes(documentId)
          ? prev.selectedDocumentIds.filter((id) => id !== documentId)
          : [...prev.selectedDocumentIds, documentId],
      })),
    onPromoteIncludeUnpublishedChange: (value) =>
      setPromoteState((prev) => ({ ...prev, includeUnpublished: value })),
    onPromoteRunPreview: handlePromotePreview,
    onPromoteBackToConfigure: () =>
      setPromoteState((prev) => ({ ...prev, stage: "configure" })),
    onPromoteExecute: handlePromoteExecute,
    onPromoteRunAnother: () =>
      setPromoteState((prev) => ({
        ...PROMOTE_DEFAULT_STATE,
        sourceEnvironmentId: prev.sourceEnvironmentId,
        targetEnvironmentId: prev.targetEnvironmentId,
        documents: prev.documents,
        documentsLoading: false,
      })),
    isCreateDialogOpen,
    onCreateDialogChange: (open) => {
      setIsCreateDialogOpen(open);
      if (!open) {
        setCreateError(null);
        setCreateName("");
      }
    },
    onCreateNameChange: setCreateName,
    onCreateSubmit: handleCreateSubmit,
    onDeleteDialogChange: (open) => {
      if (!open) {
        setDeleteError(null);
        setDeleteTarget(null);
      }
    },
    onRequestDelete: (env) => {
      setActionError(null);
      setDeleteError(null);
      setDeleteTarget(env);
    },
    onDeleteConfirm: handleDeleteConfirm,
    deleteError,
    onRetry: () => {
      setActionError(null);
      requestReload();
    },
  };
}

export default function EnvironmentsPage() {
  const viewProps = useEnvironmentPageController();
  return <EnvironmentManagementPageView {...viewProps} />;
}
