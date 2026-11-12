import { z } from "zod";
import {
  RuntimeError,
  inferContentFormat,
  parseMdxSyntax,
  validateFrontmatter,
  type SchemaRegistryListResponse,
} from "@mdcms/shared";
import type { AgentDispatch } from "./dispatcher.js";
import { defineAgentTool, type AgentTool } from "./types.js";
import { toAgentToolFailure } from "./errors.js";
import {
  documentEnvelopeSchema,
  documentListEnvelopeSchema,
  schemaEnvelopeSchema,
} from "./schema.js";

export async function dispatchJson(
  dispatch: AgentDispatch,
  input: Parameters<AgentDispatch>[0],
): Promise<unknown> {
  const response = await dispatch(input);
  const envelope: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.unknown().optional() })
      .passthrough()
      .safeParse(envelope);
    const error = z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(
        parsed.success && parsed.data.error ? parsed.data.error : envelope,
      );
    const failure = toAgentToolFailure(
      new RuntimeError({
        code: typeof error.code === "string" ? error.code : "INTERNAL_ERROR",
        message: error.message ?? "Request failed.",
        statusCode: response.status,
        details: error.details,
      }),
    );
    throw new RuntimeError({ ...failure, statusCode: failure.status });
  }
  return envelope;
}

export async function validateAgentDocument(
  dispatch: AgentDispatch,
  input: {
    type: string;
    frontmatter: Record<string, unknown>;
    body: string;
    format?: unknown;
  },
  schemaHash: string,
): Promise<void> {
  const schema = schemaEnvelopeSchema.parse(
    await dispatchJson(dispatch, { method: "GET", path: "/api/v1/schema" }),
  ).data as SchemaRegistryListResponse;
  if (!schema.schemaHash)
    throw new RuntimeError({
      code: "SCHEMA_NOT_SYNCED",
      message: "Schema is not synced.",
      statusCode: 409,
    });
  if (schemaHash !== schema.schemaHash)
    throw new RuntimeError({
      code: "SCHEMA_HASH_MISMATCH",
      message: "Schema hash does not match.",
      statusCode: 409,
    });
  const type = schema.types.find(
    (type) => type.type === input.type,
  )?.resolvedSchema;
  if (!type)
    throw new RuntimeError({
      code: "UNKNOWN_TYPE",
      message: "Unknown content type.",
      statusCode: 400,
    });
  const { errors } = validateFrontmatter(input.frontmatter, type);
  if (errors.length)
    throw new RuntimeError({
      code: "INVALID_FRONTMATTER",
      message: "Frontmatter validation failed.",
      statusCode: 422,
      details: { errors },
    });
  if (inferContentFormat(input.body) === "mdx") {
    try {
      parseMdxSyntax(input.body);
    } catch {
      throw new RuntimeError({
        code: "INVALID_MDX",
        message: "MDX syntax is invalid.",
        statusCode: 422,
      });
    }
  }
}

const text = z.string().min(1);
const object = z.record(z.string(), z.unknown());
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};
const path = (id: string) => `/api/v1/content/${encodeURIComponent(id)}`;
export const contentTools: AgentTool[] = [
  defineAgentTool({
    name: "get_schema",
    title: "Get schema",
    description: "Read the complete synced schema and its hash.",
    requiredScopes: ["schema:read"],
    annotations: read,
    inputSchema: z.strictObject({}),
    outputSchema: schemaEnvelopeSchema,
    execute: (_input, { dispatch }) =>
      dispatchJson(dispatch, { method: "GET", path: "/api/v1/schema" }),
  }),
  defineAgentTool({
    name: "list_documents",
    title: "List documents",
    description: "List draft documents visible to the caller.",
    requiredScopes: ["content:read:draft"],
    annotations: read,
    inputSchema: z.strictObject({
      type: text.optional(),
      locale: text.optional(),
      q: z.string().optional(),
      path: z.string().optional(),
      isDeleted: z.boolean().optional(),
      published: z.boolean().optional(),
      hasUnpublishedChanges: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    outputSchema: documentListEnvelopeSchema,
    execute: (input, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: "/api/v1/content",
        query: {
          draft: "true",
          fileFields: "raw",
          ...Object.fromEntries(
            Object.entries(input).map(([key, value]) => [key, String(value)]),
          ),
        },
      }),
  }),
  defineAgentTool({
    name: "get_document",
    title: "Get document",
    description: "Read a draft document visible to the caller.",
    requiredScopes: ["content:read:draft"],
    annotations: read,
    inputSchema: z.strictObject({ documentId: text }),
    outputSchema: documentEnvelopeSchema,
    execute: (input, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "GET",
        path: path(input.documentId),
        query: { draft: "true", fileFields: "raw" },
      }),
  }),
  defineAgentTool({
    name: "create_document",
    title: "Create document",
    description:
      "Validate and create a draft using the caller's pinned schema hash.",
    requiredScopes: ["schema:read", "content:write"],
    annotations: { ...write, destructiveHint: false },
    inputSchema: z.strictObject({
      type: text,
      path: text,
      frontmatter: object,
      body: z.string(),
      locale: text,
      format: z.unknown().optional(),
      schemaHash: text,
    }),
    outputSchema: documentEnvelopeSchema,
    execute: async (input, { dispatch }) => {
      const { schemaHash, ...body } = input;
      await validateAgentDocument(dispatch, body, schemaHash);
      return dispatchJson(dispatch, {
        method: "POST",
        path: "/api/v1/content",
        body,
        schemaHash,
        query: { fileFields: "raw" },
      });
    },
  }),
  defineAgentTool({
    name: "update_document",
    title: "Update document",
    description:
      "Read, validate and update a draft at its exact current revision.",
    requiredScopes: ["schema:read", "content:read:draft", "content:write"],
    annotations: write,
    inputSchema: z
      .strictObject({
        documentId: text,
        frontmatter: object.optional(),
        body: z.string().optional(),
        path: text.optional(),
        schemaHash: text,
      })
      .refine(
        (input) =>
          input.frontmatter !== undefined ||
          input.body !== undefined ||
          input.path !== undefined,
      ),
    outputSchema: documentEnvelopeSchema,
    execute: async (input, { dispatch }) => {
      const existing = documentEnvelopeSchema.parse(
        await dispatchJson(dispatch, {
          method: "GET",
          path: path(input.documentId),
          query: { draft: "true", fileFields: "raw" },
        }),
      ).data;
      const frontmatter = { ...existing.frontmatter };
      for (const [key, value] of Object.entries(input.frontmatter ?? {})) {
        if (value === null) delete frontmatter[key];
        else frontmatter[key] = value;
      }
      const body = input.body ?? existing.body;
      await validateAgentDocument(
        dispatch,
        { ...existing, frontmatter, body },
        input.schemaHash,
      );
      return dispatchJson(dispatch, {
        method: "PUT",
        path: path(input.documentId),
        schemaHash: input.schemaHash,
        query: { fileFields: "raw" },
        body: {
          frontmatter,
          body,
          ...(input.path ? { path: input.path } : {}),
          draftRevision: existing.draftRevision,
        },
      });
    },
  }),
  defineAgentTool({
    name: "publish_document",
    title: "Publish document",
    description: "Publish the current draft through the content route.",
    requiredScopes: ["content:publish"],
    annotations: write,
    inputSchema: z.strictObject({
      documentId: text,
      changeSummary: z.string().optional(),
    }),
    outputSchema: documentEnvelopeSchema,
    execute: (input, { dispatch }) =>
      dispatchJson(dispatch, {
        method: "POST",
        path: `${path(input.documentId)}/publish`,
        body: { changeSummary: input.changeSummary },
        query: { fileFields: "raw" },
      }),
  }),
];

for (const [name, action, scope] of [
  ["duplicate_document", "duplicate", "content:write"],
  ["delete_document", "", "content:delete"],
  ["restore_document", "restore", "content:write"],
  ["unpublish_document", "unpublish", "content:publish"],
] as const) {
  contentTools.push(
    defineAgentTool({
      name,
      title: name.replaceAll("_", " "),
      description:
        "Execute the content operation through its authorized route.",
      requiredScopes: action === "restore" ? [] : [scope],
      ...(action === "restore"
        ? { anyOfScopes: ["content:write", "content:publish"] as const }
        : {}),
      executionScopes: action === "restore" ? restoreScopes : undefined,
      annotations: write,
      inputSchema: z.strictObject({
        documentId: text,
        ...(action === "duplicate" ? { schemaHash: text } : {}),
        ...(action === "restore"
          ? { targetStatus: z.enum(["draft", "published"]).optional() }
          : {}),
      }),
      outputSchema: documentEnvelopeSchema,
      execute: (input, { dispatch }) =>
        dispatchJson(dispatch, {
          method: action ? "POST" : "DELETE",
          path: path(input.documentId) + (action ? `/${action}` : ""),
          schemaHash:
            typeof input.schemaHash === "string" ? input.schemaHash : undefined,
          body:
            action === "restore"
              ? { targetStatus: input.targetStatus }
              : undefined,
          query: { fileFields: "raw" },
        }),
    }),
  );
}

export function restoreScopes(
  input: unknown,
): readonly ("content:write" | "content:publish")[] {
  return [
    (input as { targetStatus?: string }).targetStatus === "published"
      ? "content:publish"
      : "content:write",
  ];
}
