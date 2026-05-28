"use client";

import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";

import type { SchemaRegistryEntry } from "@mdcms/shared";

import { useStudioMountInfo } from "./mount-info-context.js";
import {
  createStudioSchemaLoadingState,
  loadStudioSchemaState,
  type StudioSchemaState,
} from "../../../schema-state.js";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderHeading,
} from "../../components/layout/page-header.js";
import { Badge } from "../../components/ui/badge.js";
import { cn } from "../../lib/utils.js";
import type { SchemaPageLoadInput } from "./schema-page-state.js";

type SchemaFieldSnapshot =
  SchemaRegistryEntry["resolvedSchema"]["fields"][string];

const SCHEMA_READ_ONLY_COPY =
  "Schema definitions are managed in code and synced with cms schema sync. Studio shows the active types, fields, and validation rules for this target.";

function formatConstraintValue(value: unknown): string {
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

function formatCheckValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatConstraintValue(entry)).join(", ");
  }

  return formatConstraintValue(value);
}

function describeCheckDefinition(
  check: Record<string, unknown>,
): string | null {
  const kind = typeof check.kind === "string" ? check.kind : "rule";
  const details = Object.entries(check).filter(
    ([key, value]) => key !== "kind" && value !== undefined,
  );

  if (details.length === 0) {
    return kind;
  }

  if (details.length === 1) {
    return `${kind}: ${formatCheckValue(details[0][1])}`;
  }

  return `${kind}: ${details
    .map(([key, value]) => `${key} ${formatCheckValue(value)}`)
    .join(", ")}`;
}

function describeSchemaFieldConstraints(field: SchemaFieldSnapshot): string[] {
  const constraints: string[] = [];

  if (field.default !== undefined) {
    constraints.push(`default: ${formatConstraintValue(field.default)}`);
  }

  if (field.reference) {
    constraints.push(`reference: ${field.reference.targetType}`);
  }

  if (field.item) {
    constraints.push(`item: ${field.item.kind}`);
  }

  if (field.fields) {
    constraints.push(`fields: ${Object.keys(field.fields).join(", ")}`);
  }

  if (field.options) {
    constraints.push(
      `options: ${field.options.map((option) => formatConstraintValue(option)).join(", ")}`,
    );
  }

  if (field.checks?.length) {
    constraints.push(
      ...field.checks.flatMap((check) => {
        const summary = describeCheckDefinition(check);
        return summary !== null ? [summary] : [];
      }),
    );
  }

  return constraints;
}

const KIND_CHIP_CLASSES: Record<string, string> = {
  string: "bg-[rgba(47,73,229,0.10)] text-primary",
  number: "bg-[rgba(174,213,32,0.18)] text-[#516600]",
  boolean: "bg-[rgba(186,26,26,0.10)] text-destructive",
  date: "bg-[rgba(135,148,242,0.18)] text-primary",
  enum: "bg-vibrant-green text-[#516600]",
  literal: "bg-vibrant-green text-[#516600]",
  array: "bg-code-bg text-foreground",
  object: "bg-code-bg text-foreground",
};

function SchemaKindChip({ field }: { field: SchemaFieldSnapshot }): ReactNode {
  const baseClass =
    "inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 font-mono text-[11px]";
  if (field.reference) {
    return (
      <span className={cn(baseClass, "bg-blue-100 text-primary")}>
        ref → {field.reference.targetType}
      </span>
    );
  }
  if (field.kind === "array") {
    const itemKind = field.item?.reference
      ? `ref<${field.item.reference.targetType}>`
      : (field.item?.kind ?? "any");
    return (
      <span className={cn(baseClass, KIND_CHIP_CLASSES.array)}>
        {itemKind}[]
      </span>
    );
  }
  return (
    <span
      className={cn(
        baseClass,
        KIND_CHIP_CLASSES[field.kind] ?? "bg-code-bg text-foreground-muted",
      )}
    >
      {field.kind}
    </span>
  );
}

function SchemaConstraintFlags({
  field,
}: {
  field: SchemaFieldSnapshot;
}): ReactNode {
  const constraints = describeSchemaFieldConstraints(field);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        <span
          className={cn(
            "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[10px] tracking-wide",
            field.required
              ? "bg-[rgba(47,73,229,0.12)] text-primary"
              : "bg-code-bg text-foreground-muted",
          )}
        >
          {field.required ? "required" : "optional"}
        </span>
        {field.nullable && (
          <span className="inline-flex items-center rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-foreground-muted">
            nullable
          </span>
        )}
      </div>
      {constraints.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {constraints.map((constraint) => (
            <span
              key={constraint}
              className="inline-flex items-center rounded-sm bg-code-bg px-1.5 py-0.5 font-mono text-[11px] text-foreground-muted"
            >
              {constraint}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createSchemaPageLoadingState(): StudioSchemaState {
  return createStudioSchemaLoadingState("Loading schema state.");
}

function createSchemaPageMissingRouteState(): StudioSchemaState {
  return {
    status: "error",
    project: "unknown",
    environment: "unknown",
    message: "Schema browser requires an active project and environment.",
  };
}

function sortEntries(entries: SchemaRegistryEntry[]): SchemaRegistryEntry[] {
  return entries.toSorted((left, right) => left.type.localeCompare(right.type));
}

function sortFields(fields: SchemaRegistryEntry["resolvedSchema"]["fields"]) {
  return Object.entries(fields).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

function getSharedSchemaSyncSummary(entries: SchemaRegistryEntry[]): {
  schemaHash?: string;
  syncedAt?: string;
} | null {
  const firstEntry = entries[0];

  if (!firstEntry) {
    return null;
  }

  const schemaHash = firstEntry.schemaHash.trim();
  const syncedAt = firstEntry.syncedAt.trim();

  return {
    ...(schemaHash.length > 0 &&
    entries.every((entry) => entry.schemaHash === schemaHash)
      ? { schemaHash }
      : {}),
    ...(syncedAt.length > 0 &&
    entries.every((entry) => entry.syncedAt === syncedAt)
      ? { syncedAt }
      : {}),
  };
}

export function SchemaPageView({ state }: { state: StudioSchemaState }) {
  const pageDescription =
    state.status === "loading"
      ? state.message
      : state.status === "project-mismatch"
        ? `Project mismatch: configured "${state.configProject}" but server resolved "${state.serverProject}".`
        : `Read-only schema browser for ${state.project} / ${state.environment}.`;
  const sharedSyncSummary =
    state.status === "ready" ? getSharedSchemaSyncSummary(state.entries) : null;

  return (
    <div className="min-h-screen">
      <PageHeader breadcrumbs={[{ label: "Schema" }]} />

      <div className="space-y-6 p-6 lg:p-8">
        <div>
          <PageHeaderHeading className="font-heading text-[36px] font-bold leading-[1.05] tracking-tight text-foreground">
            Schema
          </PageHeaderHeading>
          <PageHeaderDescription className="mt-1.5 font-mono text-[12px] text-foreground-muted">
            {pageDescription}
          </PageHeaderDescription>
        </div>

        {/* Registry strip — always visible, surfaces sync state + read-only marker */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-primary/60 bg-card px-4 py-2.5 font-mono text-[11px] text-foreground-muted">
          <span className="size-2 shrink-0 rounded-full bg-success" />
          <span className="text-foreground-muted">schemaHash</span>
          <span className="text-foreground">
            {sharedSyncSummary?.schemaHash ?? "—"}
          </span>
          <span className="hidden h-3 w-px bg-divider sm:inline-block" />
          <span className="text-foreground-muted">syncedAt</span>
          <span className="text-foreground">
            {sharedSyncSummary?.syncedAt ?? "—"}
          </span>
          <span className="hidden h-3 w-px bg-divider sm:inline-block" />
          <span className="text-foreground-muted">project</span>
          <span className="text-foreground">
            {state.status === "ready"
              ? state.project
              : state.status === "project-mismatch"
                ? state.serverProject
                : state.status === "forbidden" || state.status === "error"
                  ? state.project
                  : "—"}
          </span>
          <span className="ml-auto rounded-sm bg-foreground px-2 py-1 font-mono text-[11px] text-background">
            $ mdcms schema sync
          </span>
          <span className="rounded-sm bg-code-bg px-2 py-1 text-[10px] font-bold tracking-wider text-foreground-muted">
            READ-ONLY IN STUDIO
          </span>
        </div>

        {state.status === "loading" ? (
          <div
            data-mdcms-schema-page-state="loading"
            className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
          >
            {state.message}
          </div>
        ) : state.status === "forbidden" ? (
          <section
            data-mdcms-schema-page-state="forbidden"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="default">Forbidden</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : state.status === "error" ? (
          <section
            data-mdcms-schema-page-state="error"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="destructive">Error</Badge>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : state.status === "project-mismatch" ? (
          <section
            data-mdcms-schema-page-state="project-mismatch"
            className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6"
          >
            <Badge variant="destructive">Configuration mismatch</Badge>
            <p className="text-sm text-muted-foreground">
              The local configuration is for project{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {state.configProject}
              </code>{" "}
              but the server resolved project{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                {state.serverProject}
              </code>
              .
            </p>
            <p className="text-xs text-muted-foreground">
              {state.configProject} / {state.environment}
            </p>
          </section>
        ) : state.entries.length === 0 ? (
          <section
            data-mdcms-schema-page-state="empty"
            className="space-y-3 rounded-lg border border-dashed p-6"
          >
            <Badge variant="outline">Empty</Badge>
            <p className="text-sm text-muted-foreground">
              {SCHEMA_READ_ONLY_COPY}
            </p>
            <p className="text-sm text-muted-foreground">
              No synced schema is available for this project and environment.
              Ask an admin or developer to run <code>cms schema sync</code> from
              the host app repo to publish the latest schema.
            </p>
            <p className="text-xs text-muted-foreground">
              {state.project} / {state.environment}
            </p>
          </section>
        ) : (
          <SchemaSplitPane entries={sortEntries(state.entries)} />
        )}
      </div>
    </div>
  );
}

function SchemaSplitPane({ entries }: { entries: SchemaRegistryEntry[] }) {
  const [activeType, setActiveType] = useState(entries[0]?.type ?? "");
  const [tab, setTab] = useState<"fields" | "source">("fields");

  const entry = useMemo(
    () => entries.find((e) => e.type === activeType) ?? entries[0],
    [entries, activeType],
  );

  if (!entry) {
    return null;
  }

  const fields = sortFields(entry.resolvedSchema.fields);

  return (
    <div
      data-mdcms-schema-page-state="ready"
      className="grid min-h-[480px] overflow-hidden rounded-lg border border-card-border bg-card lg:grid-cols-[260px_1fr]"
    >
      {/* Type list */}
      <div className="border-b border-divider lg:border-b-0 lg:border-r lg:border-divider">
        <div className="px-4 pb-2 pt-3 font-mono text-[10px] uppercase tracking-[0.08em] text-foreground-muted">
          Types · {entries.length}
        </div>
        <ul className="pb-2">
          {entries.map((e) => {
            const isActive = e.type === entry.type;
            return (
              <li key={e.type}>
                <button
                  type="button"
                  onClick={() => setActiveType(e.type)}
                  className={cn(
                    "flex w-full items-center gap-2.5 border-l-2 border-transparent px-4 py-2.5 text-left transition-colors",
                    isActive
                      ? "border-primary bg-blue-100"
                      : "hover:bg-background-subtle",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded font-mono text-[11px] font-bold",
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "bg-code-bg text-foreground-muted",
                    )}
                  >
                    {e.type[0]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-foreground">
                      {e.type}
                    </div>
                    <div className="truncate font-mono text-[10px] text-foreground-muted">
                      /{e.directory}
                    </div>
                  </div>
                  {e.localized && (
                    <span className="rounded-sm bg-blue-100 px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-primary">
                      i18n
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Detail */}
      <div
        data-mdcms-schema-entry-type={entry.type}
        className="flex min-w-0 flex-col"
      >
        <div className="flex items-start gap-4 border-b border-divider px-7 py-6">
          <div className="min-w-0 flex-1">
            <h2 className="font-heading text-[28px] font-semibold leading-[1.1] tracking-tight text-foreground">
              {entry.type}
            </h2>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-foreground-muted">
              <span>
                <span className="text-primary">directory</span> /
                {entry.directory}
              </span>
              <span>
                <span className="text-primary">localized</span>{" "}
                {String(entry.localized)}
              </span>
              <span>
                <span className="text-primary">fields</span> {fields.length}
              </span>
              <span className="break-all">
                <span className="text-primary">schemaHash</span>{" "}
                {entry.schemaHash}
              </span>
            </div>
          </div>
        </div>

        <div className="flex border-b border-divider">
          <button
            type="button"
            onClick={() => setTab("fields")}
            className={cn(
              "border-b-2 border-transparent px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
              tab === "fields"
                ? "border-primary text-foreground"
                : "text-foreground-muted hover:text-foreground",
            )}
          >
            Fields
          </button>
          <button
            type="button"
            onClick={() => setTab("source")}
            className={cn(
              "border-b-2 border-transparent px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
              tab === "source"
                ? "border-primary text-foreground"
                : "text-foreground-muted hover:text-foreground",
            )}
          >
            resolvedSchema (JSON)
          </button>
        </div>

        {tab === "fields" ? (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0">
              <thead className="bg-background-subtle">
                <tr>
                  <th className="border-b border-divider px-7 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                    Field
                  </th>
                  <th className="border-b border-divider px-7 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                    Kind
                  </th>
                  <th className="border-b border-divider px-7 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-foreground-muted">
                    Constraints
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.map(([fieldName, field]) => (
                  <tr
                    key={fieldName}
                    data-mdcms-schema-field-name={fieldName}
                    data-mdcms-schema-field-kind={field.kind}
                    className="border-b border-divider/60"
                  >
                    <td className="border-t border-divider/60 px-7 py-3.5 align-top">
                      <div className="font-mono text-[13px] font-semibold text-foreground">
                        {fieldName}
                        {field.required && (
                          <span className="ml-1 text-primary">*</span>
                        )}
                      </div>
                    </td>
                    <td className="border-t border-divider/60 px-7 py-3.5 align-top">
                      <SchemaKindChip field={field} />
                    </td>
                    <td className="border-t border-divider/60 px-7 py-3.5 align-top">
                      <SchemaConstraintFlags field={field} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-7">
            <pre className="overflow-auto rounded-lg border border-divider bg-foreground p-5 font-mono text-[12px] leading-relaxed text-background">
              {jsonStringify(entry.resolvedSchema)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SchemaPage() {
  const mountInfo = useStudioMountInfo();
  const [state, dispatchState] = useReducer(
    (_state: StudioSchemaState, nextState: StudioSchemaState) => nextState,
    createSchemaPageLoadingState(),
  );

  useEffect(() => {
    if (!mountInfo.project || !mountInfo.environment) {
      dispatchState(createSchemaPageMissingRouteState());
      return;
    }

    const loadInput: SchemaPageLoadInput = {
      config: {
        project: mountInfo.project,
        environment: mountInfo.environment,
        serverUrl: mountInfo.apiBaseUrl,
      },
      auth: mountInfo.auth,
    };

    let active = true;
    dispatchState(createSchemaPageLoadingState());

    void loadStudioSchemaState(loadInput)
      .then((nextState) => {
        if (active) {
          dispatchState(nextState);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        dispatchState({
          status: "error",
          project: loadInput.config.project,
          environment: loadInput.config.environment,
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Failed to load schema state.",
        });
      });

    return () => {
      active = false;
    };
  }, [
    mountInfo.apiBaseUrl,
    mountInfo.auth,
    mountInfo.environment,
    mountInfo.project,
  ]);

  return <SchemaPageView state={state} />;
}
