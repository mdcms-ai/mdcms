import { z } from "zod";

import { RuntimeError } from "../runtime/error.js";
import { mdxComponentCatalogSchema } from "./extensibility.js";

export const AI_TASK_KINDS = [
  "copy_improvement",
  "seo_improvement",
  "mdx_component_insertion",
  "current_document_edit",
  "new_document_draft",
] as const;

/**
 * Audit-only task kind. Chat turns produce a single audit record per
 * turn regardless of how many tool calls the model made; the kind is
 * `chat` so consumers can distinguish chat-driven proposals from
 * direct task calls.
 */
export const AI_AUDIT_TASK_KIND_CHAT = "chat" as const;

export type AiTaskKind = (typeof AI_TASK_KINDS)[number];

export const AI_PROPOSAL_KINDS = [
  "replace_selection",
  "insert_block",
  "update_frontmatter",
  "create_document",
  "delete_document",
] as const;

export type AiProposalKind = (typeof AI_PROPOSAL_KINDS)[number];

export const AI_ERROR_CODES = [
  "AI_DISABLED",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_RATE_LIMITED",
  "AI_CONTEXT_TOO_LARGE",
  "AI_OUTPUT_INVALID",
  "AI_UNSUPPORTED_TASK",
  "AI_UNSUPPORTED_ACTION",
] as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

export type AiProposalOperation =
  | {
      op: "replace_selection";
      selectionId: string;
      originalText: string;
      replacementText: string;
    }
  | {
      op: "insert_block";
      afterSelectionId?: string;
      bodyMdx: string;
    }
  | {
      op: "update_frontmatter";
      patch: Record<string, unknown>;
    }
  | {
      op: "create_document";
      path: string;
      format: "md" | "mdx";
      frontmatter: Record<string, unknown>;
      body: string;
    }
  | {
      op: "delete_document";
      path: string;
      reason?: string;
    };

export type AiProposalValidation =
  | { status: "valid" }
  | {
      status: "invalid";
      errors: {
        code: string;
        message: string;
        path?: string;
      }[];
    };

export type AiProposalProviderMetadata = {
  providerId: string;
  model: string;
  promptTemplateId: string;
};

export type AiProposal = {
  proposalId: string;
  kind: AiProposalKind;
  project: string;
  environment: string;
  documentId?: string;
  baseDraftRevision?: number;
  type: string;
  locale: string;
  summary: string;
  operations: AiProposalOperation[];
  validation: AiProposalValidation;
  expiresAt: string;
  provider: AiProposalProviderMetadata;
};

const nonEmptyString = z.string().trim().min(1, {
  message: "must be a non-empty string.",
});

const isoDateString = z.iso.datetime({
  message: "must be an ISO-8601 datetime string.",
});

const recordOfUnknown = z.record(z.string(), z.unknown());

export const replaceSelectionOperationSchema = z
  .object({
    op: z.literal("replace_selection"),
    selectionId: nonEmptyString,
    originalText: z.string(),
    replacementText: z.string(),
  })
  .strict();

export const insertBlockOperationSchema = z
  .object({
    op: z.literal("insert_block"),
    afterSelectionId: nonEmptyString.optional(),
    bodyMdx: z.string().min(1, {
      message: "must be a non-empty MDX block.",
    }),
  })
  .strict();

export const updateFrontmatterOperationSchema = z
  .object({
    op: z.literal("update_frontmatter"),
    patch: recordOfUnknown,
  })
  .strict();

export const createDocumentOperationSchema = z
  .object({
    op: z.literal("create_document"),
    path: nonEmptyString,
    format: z.enum(["md", "mdx"]),
    frontmatter: recordOfUnknown,
    body: z.string(),
  })
  .strict();

export const deleteDocumentOperationSchema = z
  .object({
    op: z.literal("delete_document"),
    path: nonEmptyString,
    reason: nonEmptyString.optional(),
  })
  .strict();

export const aiProposalOperationSchema = z.discriminatedUnion("op", [
  replaceSelectionOperationSchema,
  insertBlockOperationSchema,
  updateFrontmatterOperationSchema,
  createDocumentOperationSchema,
  deleteDocumentOperationSchema,
]);

/**
 * Per-kind operation schema lookup. Tasks that only emit a subset of
 * operation kinds compose the schemas they need from this map so the
 * derived JSON Schema sent to providers (some of which run in
 * `strict` mode and reject optional properties not listed in
 * `required`) only mentions the variants the task can actually emit.
 */
export const aiProposalOperationSchemaByOp = {
  replace_selection: replaceSelectionOperationSchema,
  insert_block: insertBlockOperationSchema,
  update_frontmatter: updateFrontmatterOperationSchema,
  create_document: createDocumentOperationSchema,
  delete_document: deleteDocumentOperationSchema,
} as const;

export const aiProposalValidationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid") }).strict(),
  z
    .object({
      status: z.literal("invalid"),
      errors: z
        .array(
          z
            .object({
              code: nonEmptyString,
              message: nonEmptyString,
              path: nonEmptyString.optional(),
            })
            .strict(),
        )
        .min(1, { message: "must include at least one validation error." }),
    })
    .strict(),
]);

const aiProposalProviderMetadataSchema = z
  .object({
    providerId: nonEmptyString,
    model: nonEmptyString,
    promptTemplateId: nonEmptyString,
  })
  .strict();

export const aiProposalSchema = z
  .object({
    proposalId: nonEmptyString,
    kind: z.enum(AI_PROPOSAL_KINDS),
    project: nonEmptyString,
    environment: nonEmptyString,
    documentId: nonEmptyString.optional(),
    baseDraftRevision: z.number().int().nonnegative().optional(),
    type: nonEmptyString,
    locale: nonEmptyString,
    summary: nonEmptyString,
    operations: z.array(aiProposalOperationSchema).min(1, {
      message: "must include at least one operation.",
    }),
    validation: aiProposalValidationSchema,
    expiresAt: isoDateString,
    provider: aiProposalProviderMetadataSchema,
  })
  .strict()
  .superRefine((proposal, ctx) => {
    proposal.operations.forEach((operation, index) => {
      if (operation.op !== proposal.kind) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", index, "op"],
          message: `operation.op "${operation.op}" must match proposal.kind "${proposal.kind}".`,
        });
      }
    });

    if (proposal.kind === "create_document") {
      if (proposal.documentId !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["documentId"],
          message:
            "create_document proposals must not carry a source documentId.",
        });
      }

      if (proposal.baseDraftRevision !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["baseDraftRevision"],
          message:
            "create_document proposals must not carry a source baseDraftRevision.",
        });
      }
    }
  });

function formatPath(path: string, issuePath: readonly PropertyKey[]): string {
  if (issuePath.length === 0) {
    return path;
  }

  return issuePath.reduce<string>((acc, segment) => {
    if (typeof segment === "number") {
      return `${acc}[${segment}]`;
    }

    if (typeof segment === "symbol") {
      return `${acc}.[${String(segment)}]`;
    }

    return `${acc}.${segment}`;
  }, path);
}

export function assertAiProposal(
  value: unknown,
  path = "proposal",
): asserts value is AiProposal {
  const parsed = aiProposalSchema.safeParse(value);

  if (parsed.success) {
    return;
  }

  const [first] = parsed.error.issues;
  const issuePath = first ? formatPath(path, first.path ?? []) : path;
  const message = first
    ? `${issuePath} ${first.message ?? "is invalid."}`
    : `${path} is invalid.`;

  throw new RuntimeError({
    code: "AI_OUTPUT_INVALID",
    message,
    statusCode: 422,
    details: {
      path: issuePath,
      issues: parsed.error.issues,
    },
  });
}

export function isAiProposal(value: unknown): value is AiProposal {
  return aiProposalSchema.safeParse(value).success;
}

// ───────────────────────────────────────────────────────────────────────
// Chat-message endpoint — POST /api/v1/ai/chat/messages
// ───────────────────────────────────────────────────────────────────────

export const AI_CHAT_ALLOWED_ACTIONS = [
  "answer",
  "edit_document",
  "create_document",
  "delete_document",
] as const;

export type AiChatAllowedAction = (typeof AI_CHAT_ALLOWED_ACTIONS)[number];

// Intentionally a free-form string, not z.enum: SPEC-014 §Authorization
// requires the route to surface `AI_UNSUPPORTED_ACTION` (403) when a
// client requests an action that is permanently denied (publish,
// schema_change, env_change, role_change, provider_change, restore). If
// this were an enum the request would be rejected as INVALID_INPUT (400)
// before the route's hard denylist could fire, and clients would see the
// wrong contract error code. The route still bounds the accepted set;
// unknown strings just route through the denylist + capability check.
export const aiChatAllowedActionSchema = nonEmptyString;

export const aiChatAttachedSelectionSchema = z
  .object({
    documentId: nonEmptyString,
    draftRevision: z.number().int().nonnegative(),
    selectionId: nonEmptyString,
    text: z.string(),
  })
  .strict();

export type AiChatAttachedSelection = z.infer<
  typeof aiChatAttachedSelectionSchema
>;

export const aiChatConversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: nonEmptyString,
  })
  .strict();

export type AiChatConversationTurn = z.infer<
  typeof aiChatConversationTurnSchema
>;

export type AiComponentReference = {
  componentName: string;
  source: "studio_host_preview";
  renderedHtml: string;
  text?: string;
  styleSummary?: string;
};

export const aiComponentReferenceSchema = z
  .object({
    componentName: nonEmptyString,
    source: z.literal("studio_host_preview"),
    renderedHtml: z.string().max(20_000),
    text: z.string().max(5_000).optional(),
    styleSummary: z.string().max(5_000).optional(),
  })
  .strict();

export const aiChatMessageRequestSchema = z
  .object({
    message: nonEmptyString,
    conversationId: nonEmptyString.optional(),
    attachedDocumentIds: z.array(nonEmptyString).optional(),
    attachedSelection: aiChatAttachedSelectionSchema.optional(),
    rejectedProposalId: nonEmptyString.optional(),
    /**
     * Full body of the rejected proposal, used by the regenerate flow.
     * Chat proposals live in client localStorage, so the client posts
     * the prior proposal back when asking the model to try again. The
     * server falls back to a `rejectedProposalId` lookup against the
     * in-memory store for non-chat callers.
     */
    rejectedProposal: aiProposalSchema.optional(),
    rejectionFeedback: nonEmptyString.optional(),
    allowedActions: z.array(aiChatAllowedActionSchema).optional(),
    /**
     * Serializable active MDX component catalog supplied by the embedded
     * Studio host. The server uses it to ground chat proposals and to
     * reject generated MDX that references unregistered components or
     * invalid props before the user can accept it.
     */
    mdxCatalog: mdxComponentCatalogSchema.optional(),
    /**
     * Studio-host-rendered MDX component reference snapshots. These
     * are read-only grounding material for the model-facing
     * `get_component_reference` tool, used when the user asks to clone
     * or visually match an existing component. The AI server treats
     * them as opaque sanitized references; it does not import host app
     * component source.
     */
    componentReferences: z.array(aiComponentReferenceSchema).max(50).optional(),
    /**
     * Prior turns from the same conversation, oldest first. The server is
     * stateless per request — the client owns conversation memory — so it
     * sends a rolling window of recent turns alongside the new message so
     * the model can resolve anaphora ("make it shorter", "do the same to
     * the other one") instead of acting on each turn in isolation.
     */
    conversationHistory: z.array(aiChatConversationTurnSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // rejectionFeedback only makes sense alongside rejectedProposalId.
    if (value.rejectionFeedback && !value.rejectedProposalId) {
      ctx.addIssue({
        code: "custom",
        path: ["rejectionFeedback"],
        message:
          "rejectionFeedback can only be set when rejectedProposalId is also provided.",
      });
    }
  });

export type AiChatMessageRequest = z.infer<typeof aiChatMessageRequestSchema>;

export const AI_CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;
export type AiChatMessageRole = (typeof AI_CHAT_MESSAGE_ROLES)[number];

export const aiChatMessageSchema = z
  .object({
    id: nonEmptyString,
    role: z.enum(AI_CHAT_MESSAGE_ROLES),
    at: isoDateString,
    text: z.string().optional(),
    proposals: z.array(nonEmptyString).optional(),
    rejectedProposalId: nonEmptyString.optional(),
  })
  .strict();

export type AiChatMessage = z.infer<typeof aiChatMessageSchema>;

export const aiChatMessageResponseSchema = z
  .object({
    conversationId: nonEmptyString,
    message: aiChatMessageSchema,
    proposals: z.array(aiProposalSchema).optional(),
  })
  .strict();

export type AiChatMessageResponse = z.infer<typeof aiChatMessageResponseSchema>;
