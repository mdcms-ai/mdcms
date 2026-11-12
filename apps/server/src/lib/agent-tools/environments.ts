import { z } from "zod";
import {
  type EnvironmentListResponse,
  type EnvironmentCloneResult,
  type EnvironmentPromoteResult,
} from "@mdcms/shared";
import { dispatchJson } from "./content.js";
import { defineAgentTool } from "./types.js";
import type { ApiKeyOperationScope } from "../auth.js";
const text = z.string().min(1);
export const environmentListSchema = z.object({
  data: z.array(
    z.object({
      id: text,
      project: text,
      name: text,
      extends: z.string().nullable(),
      isDefault: z.boolean(),
      createdAt: text,
    }),
  ),
  meta: z.discriminatedUnion("definitionsStatus", [
    z.object({ definitionsStatus: z.literal("missing") }),
    z.object({
      definitionsStatus: z.literal("ready"),
      configSnapshotHash: text,
      syncedAt: text,
    }),
  ]),
}) satisfies z.ZodType<EnvironmentListResponse>;
export const cloneResultSchema = z.object({
  targetEnvironmentId: text,
  documentsCloned: z.number().int().nonnegative(),
}) satisfies z.ZodType<EnvironmentCloneResult>;
export const promoteResultSchema = z.object({
  promoted: z.array(
    z.object({
      sourceDocumentId: text,
      targetDocumentId: text.nullable(),
      status: z.enum(["overwrote", "created", "skipped_unpublished"]),
      path: text,
      locale: text,
      type: text,
      publishedVersion: z.number().nullable(),
      remappedReferences: z.number().int().nonnegative(),
    }),
  ),
}) satisfies z.ZodType<EnvironmentPromoteResult>;
export const environmentTools = [
  defineAgentTool({
    name: "list_environments",
    title: "List environments",
    description: "Read environment metadata in the authenticated project.",
    requiredScopes: ["environments:read"],
    requiresGlobalAdmin: true,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.strictObject({}),
    outputSchema: environmentListSchema,
    execute: (_, { dispatch }) =>
      dispatchJson(dispatch, { method: "GET", path: "/api/v1/environments" }),
  }),
  defineAgentTool({
    name: "clone_environment",
    title: "Clone environment",
    description:
      "Copy authorized source content and settings into the authenticated destination.",
    requiredScopes: ["environments:clone", "schema:read"],
    anyOfScopes: ["content:read", "schema:write"],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    inputSchema: z.strictObject({
      targetEnvironmentId: text,
      sourceEnvironmentId: text,
      include: z.strictObject({ content: z.boolean(), settings: z.boolean() }),
      includeDrafts: z.boolean(),
      preservePaths: z.boolean(),
    }),
    outputSchema: z.object({ data: cloneResultSchema }),
    executionScopes: (input) => {
      const value = input as {
        include: { content: boolean; settings: boolean };
        includeDrafts: boolean;
      };
      const scopes: ApiKeyOperationScope[] = [
        "environments:clone",
        "schema:read",
      ];
      if (value.include.content) {
        scopes.push("content:read");
        if (value.includeDrafts) scopes.push("content:read:draft");
      }
      if (value.include.settings) scopes.push("schema:write");
      return scopes;
    },
    execute: ({ targetEnvironmentId, ...body }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "POST",
        path: `/api/v1/environments/${encodeURIComponent(targetEnvironmentId)}/clone`,
        body,
      }),
  }),
  defineAgentTool({
    name: "promote_documents",
    title: "Promote documents",
    description:
      "Promote authorized source drafts or return an authorized dry-run plan.",
    requiredScopes: [
      "environments:promote",
      "content:read:draft",
      "schema:read",
    ],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    inputSchema: z.strictObject({
      targetEnvironmentId: text,
      sourceEnvironmentId: text,
      documentIds: z.array(text).min(1),
      includeUnpublished: z.boolean(),
      dryRun: z.boolean(),
    }),
    outputSchema: z.object({ data: promoteResultSchema }),
    execute: ({ targetEnvironmentId, ...body }, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "POST",
        path: `/api/v1/environments/${encodeURIComponent(targetEnvironmentId)}/promote`,
        body,
      }),
  }),
];
