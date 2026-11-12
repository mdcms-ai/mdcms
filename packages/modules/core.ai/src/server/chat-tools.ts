import { tool, type Tool } from "ai";
import { z } from "zod";
import type { AiProposal, AgentReadToolDefinition } from "@mdcms/shared";

import {
  buildProposalsFromOutput,
  type AiProposalEnvelope,
  type AiProposalValidator,
} from "./proposal-builder.js";

/**
 * Result returned by the `list_documents` chat tool. Shape kept
 * compact — the model uses `documentId` to reference entries and
 * `title`/`summary` to disambiguate candidates.
 */
export type FindEntriesResult = {
  matches: Array<{
    documentId: string;
    path: string;
    type: string;
    locale: string;
    title?: string;
    summary?: string;
    updatedAt: string;
    hasUnpublishedChanges: boolean;
  }>;
  total: number;
};

/**
 * Result returned by the `get_document` chat tool. Full document body
 * + frontmatter, plus enough revision metadata for the model to
 * understand staleness state.
 */
export type GetEntryResult = {
  documentId: string;
  path: string;
  type: string;
  locale: string;
  draftRevision: number;
  hasUnpublishedChanges: boolean;
  publishedVersion: number | null;
  frontmatter: Record<string, unknown>;
  body: string;
};

/**
 * Result returned by the `get_component_reference` chat tool. This is
 * a read-only design-reference snapshot rendered by the Studio host
 * before the chat request reaches the AI server.
 */
export type GetComponentReferenceResult = {
  componentName: string;
  source: "studio_host_preview";
  renderedHtml: string;
  text?: string;
  styleSummary?: string;
};

/**
 * Chat-tool surface for the assistant. The model picks a tool per
 * "thing it wants to do" — propose an edit to the selected span,
 * propose a new draft, propose a delete, etc. — and the server's
 * tool `execute` builds a server-trusted `AiProposal` and pushes it
 * into a per-turn collector. This replaces the previous regex-based
 * "intent routing" where the server pre-decided which task the model
 * would run; here the model itself decides via tool selection.
 *
 * The toolset is conditional: a tool is only registered when the
 * caller has the capability AND the request supplies the inputs that
 * tool requires (e.g. `propose_edit_selection` requires an
 * `attachedSelection` to anchor the edit). The model never sees tools
 * it can't legitimately call.
 */

export const CHAT_TOOL_PROMPT_TEMPLATE_ID = "chat_tools.v2";

export type ChatToolCapabilities = {
  canEditDocument: boolean;
  canCreateDocument: boolean;
  canDeleteDocument: boolean;
  canReadEntries: boolean;
};

export type ChatToolDeps = {
  /** Stamped onto every proposal. Active doc fields (documentId/baseDraftRevision) are propagated. */
  envelope: AiProposalEnvelope;
  /**
   * Required for replace_selection. Both fields are server-trusted:
   * the model may describe the source text, but proposal anchoring uses
   * this exact selected markdown span.
   */
  attachedSelection?: { selectionId: string; text: string };
  /** Set when the request had an active document; gates insert_block / update_frontmatter / delete tools. */
  hasActiveDocument: boolean;
  /** Path of the active document; needed to populate the delete operation's `path` field. */
  activeDocumentPath?: string;
  /** Whether the active document is already published (delete then becomes invalid). */
  activeDocumentHasPublishedVersion: boolean;
  providerId: string;
  model: string;
  clock: () => Date;
  idFactory: () => string;
  ttlMs: number;
  validator?: AiProposalValidator;
  capabilities: ChatToolCapabilities;
  /** Per-turn output collector — mutated by tool executes. */
  collected: AiProposal[];

  /**
   * Registered content type ids for this project. Used as the enum
   * source for the list_documents tool's `type` parameter so the model
   * can't query for types that don't exist.
   */
  registeredTypeIds: string[];

  /**
   * Supported locales for this project. Used as the enum source for
   * list_documents' `locale` parameter.
   */
  supportedLocales: string[];

  readTools?: readonly AgentReadToolDefinition[];

  /**
   * Backend for the get_component_reference tool. The route layer
   * serves request-supplied Studio-host-rendered component snapshots.
   */
  getComponentReferenceBackend?: (input: {
    componentName: string;
  }) => Promise<GetComponentReferenceResult | undefined>;
};

const SUMMARY_FIELD = z
  .string()
  .min(1)
  .describe(
    "Short human-readable summary of what this proposal does — shown on the proposal card.",
  );

/**
 * Free-shape objects (frontmatter, frontmatter patches) are passed as
 * JSON-encoded strings rather than open `z.record` shapes. This is a
 * concession to providers that run strict JSON-schema validation on
 * tool inputs — OpenAI-compatible strict mode (which Groq's
 * `openai/gpt-oss-*` models emulate) rejects schemas with
 * `additionalProperties` set to anything other than `false`, so an
 * open record like `{ title, description, tags, author }` fails
 * before the tool's `execute` is ever called. Passing the structured
 * fields as a JSON string sidesteps that — the value is just a string
 * at schema-time, then parsed and validated server-side.
 */
function parseJsonObjectField(
  raw: string,
  fieldName: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "invalid JSON syntax";
    throw new Error(
      `${fieldName} must be a JSON-encoded object string; failed to parse: ${reason}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${fieldName} must encode a JSON object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}).`,
    );
  }
  return parsed as Record<string, unknown>;
}

function documentTextSelectionId(originalText: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < originalText.length; i += 1) {
    hash ^= originalText.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `doc-text:${(hash >>> 0).toString(36)}`;
}

export function buildChatTools(deps: ChatToolDeps): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  let validationRetryAvailable = true;

  const stampProposal = async (
    output: {
      summary: string;
      operations: Parameters<
        typeof buildProposalsFromOutput
      >[0]["output"]["operations"];
    },
    anchors?: Parameters<typeof buildProposalsFromOutput>[0]["anchors"],
    envelopeOverride?: Partial<AiProposalEnvelope>,
  ): Promise<AiProposal> => {
    const proposals = await buildProposalsFromOutput(
      {
        taskKind: "current_document_edit",
        promptTemplateId: CHAT_TOOL_PROMPT_TEMPLATE_ID,
        providerId: deps.providerId,
        model: deps.model,
        envelope: envelopeOverride
          ? { ...deps.envelope, ...envelopeOverride }
          : deps.envelope,
        output,
        ...(anchors ? { anchors } : {}),
      },
      {
        clock: deps.clock,
        idFactory: deps.idFactory,
        ttlMs: deps.ttlMs,
        ...(deps.validator ? { validator: deps.validator } : {}),
      },
    );
    const [proposal] = proposals;
    if (!proposal) {
      throw new Error(
        "chat-tools: buildProposalsFromOutput returned an empty array.",
      );
    }
    return proposal;
  };

  const queueProposal = (
    proposal: AiProposal,
    extra: Record<string, unknown> = {},
  ) => {
    if (proposal.validation.status === "valid") {
      deps.collected.push(proposal);
      return {
        proposalId: proposal.proposalId,
        queued: true as const,
        ...extra,
      };
    }

    const retryable = validationRetryAvailable;
    validationRetryAvailable = false;
    return {
      queued: false as const,
      rejected: true as const,
      retryable,
      validation: proposal.validation,
      error: retryable
        ? "Proposal was auto-rejected because it failed validation. Correct the tool arguments and call the proposal tool once more."
        : "Proposal was auto-rejected again after the retry. Do not call another proposal tool for this change; explain the validation failure to the user.",
    };
  };

  if (
    deps.capabilities.canEditDocument &&
    deps.hasActiveDocument &&
    deps.attachedSelection
  ) {
    tools.propose_edit_selection = tool({
      description:
        'Propose a rewrite of the user\'s currently selected text in the active draft. Use when the user wants the selected span replaced ("tighten this", "rewrite into bullets", "shorten"). The selection anchor is server-supplied — do not invent a selectionId.',
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        originalText: z
          .string()
          .min(1)
          .describe(
            "A copy of the selected text for review context. The server anchors the proposal to the attached selection span.",
          ),
        replacementText: z
          .string()
          .describe(
            "The new markdown text that replaces the selection. Preserve block markers such as '- ' for selected lists unless the user asked to change the structure.",
          ),
      }),
      execute: async (args) => {
        try {
          const proposal = await stampProposal(
            {
              summary: args.summary,
              operations: [
                {
                  op: "replace_selection",
                  selectionId: deps.attachedSelection!.selectionId,
                  originalText: deps.attachedSelection!.text,
                  replacementText: args.replacementText,
                },
              ],
            },
            { selectionId: deps.attachedSelection!.selectionId },
          );
          return queueProposal(proposal);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  if (deps.capabilities.canEditDocument && deps.hasActiveDocument) {
    tools.propose_replace_document_text = tool({
      description:
        "Propose replacing or removing an exact markdown span from the active draft, without requiring the user to highlight it first. Use for whole-document edits like deleting a named section, rewriting a paragraph by heading, or replacing a block you can copy exactly from the active draft context. The `originalText` must be copied exactly from the active draft and must appear only once; use an empty `replacementText` to delete it.",
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        originalText: z
          .string()
          .min(1)
          .describe(
            "Exact markdown span from the active draft to replace or remove. Include enough surrounding structure (for example the heading plus its section body) so it appears once.",
          ),
        replacementText: z
          .string()
          .describe(
            "Replacement markdown. Pass an empty string to delete the original span.",
          ),
      }),
      execute: async (args) => {
        try {
          const selectionId = documentTextSelectionId(args.originalText);
          const proposal = await stampProposal(
            {
              summary: args.summary,
              operations: [
                {
                  op: "replace_selection",
                  selectionId,
                  originalText: args.originalText,
                  replacementText: args.replacementText,
                },
              ],
            },
            { selectionId },
          );
          return queueProposal(proposal);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });

    tools.propose_insert_block = tool({
      description:
        "Propose inserting a new MDX block into the active draft (a new paragraph, list, callout, code sample, etc.). Use when the user wants something added — not a replacement of existing text.",
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        bodyMdx: z
          .string()
          .min(1)
          .describe("The MDX content to insert as a complete block."),
        afterSelectionId: z
          .string()
          .optional()
          .describe(
            "Optional selectionId of the block AFTER which the new block should be inserted. Omit to append.",
          ),
      }),
      execute: async (args) => {
        try {
          const proposal = await stampProposal({
            summary: args.summary,
            operations: [
              {
                op: "insert_block",
                bodyMdx: args.bodyMdx,
                ...(args.afterSelectionId
                  ? { afterSelectionId: args.afterSelectionId }
                  : {}),
              },
            ],
          });
          return queueProposal(proposal);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });

    tools.propose_update_frontmatter = tool({
      description:
        "Propose patching the active draft's frontmatter (title, description, tags, publishedAt, etc.). The `patch` is shallow-merged with the existing frontmatter at apply time.",
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        patch: z
          .string()
          .min(2)
          .describe(
            'JSON-encoded shallow-merge patch object. Example: `{"title":"New title","tags":["a","b"]}`. Include only fields you want to change. Pass this as a JSON STRING — do not pass a raw object.',
          ),
      }),
      execute: async (args) => {
        try {
          const patch = parseJsonObjectField(args.patch, "patch");
          const proposal = await stampProposal({
            summary: args.summary,
            operations: [
              {
                op: "update_frontmatter",
                patch,
              },
            ],
          });
          return queueProposal(proposal);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  if (deps.capabilities.canCreateDocument) {
    tools.propose_create_document = tool({
      description:
        "Propose creating a new draft document. Use when the user asks to draft, create, or write a new post/article/doc — not for edits to existing drafts.",
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        path: z
          .string()
          .min(1)
          .describe(
            "Filesystem-style path under the project's content tree (e.g. `blog/announcements/2026-05`). No leading slash, no file extension.",
          ),
        type: z
          .string()
          .min(1)
          .describe(
            "Content type id — must match a registered schema in the project (e.g. `blog`, `page`, `docs`). Derive from the path's leading segment when unsure: `blog/foo` → `blog`, `docs/x` → `docs`. If the path has no leading segment (top-level file), use `page`.",
          ),
        format: z
          .enum(["md", "mdx"])
          .describe(
            "`md` for plain Markdown, `mdx` when MDX components are used.",
          ),
        frontmatter: z
          .string()
          .min(2)
          .describe(
            'JSON-encoded frontmatter object. Example: `{"title":"A Short Poem","date":"2026-05-15","tags":["poetry"]}`. Pass this as a JSON STRING — do not pass a raw object. Include EVERY field the content type\'s schema marks as required (e.g. `title`) plus any optional fields you\'re confident about. DO NOT serialize the frontmatter as YAML inside the `body` field; that\'s what this field is for.',
          ),
        body: z
          .string()
          .describe(
            "Body content ONLY — the actual prose / Markdown / MDX. DO NOT prepend a `---` YAML frontmatter block here; frontmatter goes in the structured `frontmatter` field above. Start the body directly with the first paragraph, heading, or block.",
          ),
      }),
      execute: async (args) => {
        try {
          const frontmatter = parseJsonObjectField(
            args.frontmatter,
            "frontmatter",
          );
          const proposal = await stampProposal(
            {
              summary: args.summary,
              operations: [
                {
                  op: "create_document",
                  path: args.path,
                  format: args.format,
                  frontmatter,
                  body: args.body,
                },
              ],
            },
            undefined,
            // The orchestrator's envelope defaults to "page" when no
            // active document is attached — for a create the model
            // tells us the type via the tool input, so we stamp it
            // here. The validator checks that the type matches a
            // schema registered in the project.
            { type: args.type },
          );
          return queueProposal(proposal);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  if (
    deps.capabilities.canDeleteDocument &&
    deps.hasActiveDocument &&
    deps.activeDocumentPath
  ) {
    const activeDocumentPath = deps.activeDocumentPath;
    const hasPublished = deps.activeDocumentHasPublishedVersion;
    tools.propose_delete_document = tool({
      description:
        "Propose deleting the active draft. Use ONLY when the user explicitly asks to delete/remove/archive THIS draft. Never propose a delete the user didn't ask for. Documents with a published version cannot be deleted — the proposal will surface as invalid in that case.",
      inputSchema: z.object({
        summary: SUMMARY_FIELD,
        reason: z
          .string()
          .optional()
          .describe(
            'Brief justification shown to the user on the proposal card ("superseded by …", "out of date"). Optional.',
          ),
      }),
      execute: async (args) => {
        try {
          const proposal = await stampProposal({
            summary: args.summary,
            operations: [
              {
                op: "delete_document",
                path: activeDocumentPath,
                ...(args.reason ? { reason: args.reason } : {}),
              },
            ],
          });
          return queueProposal(proposal, {
            ...(hasPublished
              ? {
                  warning:
                    "The active document has a published version — the proposal will be rejected by apply unless the published version is unpublished first.",
                }
              : {}),
          });
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  for (const definition of deps.readTools ?? []) {
    if (definition.name !== "get_schema" && !deps.capabilities.canReadEntries)
      continue;
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input) => {
        try {
          return await definition.execute(
            z.record(z.string(), z.unknown()).parse(input),
          );
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  if (deps.getComponentReferenceBackend) {
    const backend = deps.getComponentReferenceBackend;
    tools.get_component_reference = tool({
      description:
        "Fetch sanitized rendered HTML and visible text for a registered MDX component as read-only design reference. Use this when the user asks to clone, imitate, restyle, make something similar to, or follow the aesthetic of an existing component. This tool does not edit content; combine it with a propose_* tool only after reading the reference.",
      inputSchema: z.object({
        componentName: z
          .string()
          .min(1)
          .describe(
            "Registered MDX component name to inspect, e.g. HomeHero or PricingTable.",
          ),
      }),
      execute: async (args) => {
        try {
          const reference = await backend({
            componentName: args.componentName,
          });
          if (!reference) {
            return {
              queued: false as const,
              error: `Component reference "${args.componentName}" was not supplied by this Studio host.`,
            };
          }
          return sanitizeComponentReference(reference);
        } catch (error) {
          return toolErrorResult(error);
        }
      },
    });
  }

  return tools;
}

function sanitizeComponentReference(
  reference: GetComponentReferenceResult,
): GetComponentReferenceResult {
  return {
    componentName: reference.componentName,
    source: reference.source,
    renderedHtml: sanitizeRenderedHtml(reference.renderedHtml),
    ...(reference.text ? { text: reference.text.slice(0, 5_000) } : {}),
    ...(reference.styleSummary
      ? { styleSummary: reference.styleSummary.slice(0, 5_000) }
      : {}),
  };
}

function sanitizeRenderedHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, "")
    .slice(0, 20_000);
}

function toolErrorResult(error: unknown): {
  queued: false;
  error: string;
} {
  const message =
    error instanceof Error ? error.message : "Failed to queue proposal.";
  return { queued: false, error: message };
}
