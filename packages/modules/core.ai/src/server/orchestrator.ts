import { generateObject, generateText, stepCountIs, streamText } from "ai";
import {
  RuntimeError,
  type AiErrorCode,
  type AiProposal,
  type AiTaskKind,
  type MdxComponentCatalog,
} from "@mdcms/shared";

import {
  buildAuditRecord,
  type AiAuditRecord,
  type AiAuditTaskKind,
} from "./audit.js";
import {
  buildChatTools,
  CHAT_TOOL_PROMPT_TEMPLATE_ID,
  type ChatToolCapabilities,
} from "./chat-tools.js";
import { aiError, isAiErrorCode, mapProviderError } from "./errors.js";
import type { ProjectKnowledgeInput } from "./project-knowledge.js";
import {
  buildProposalsFromOutput,
  type AiProposalEnvelope,
  type AiProposalValidator,
} from "./proposal-builder.js";
import type { AiProvider, AiProviderUsage } from "./provider.js";
import {
  createMdxCatalogProposalValidator,
  createReplaceSelectionApplyabilityValidator,
} from "./validate-proposal.js";
import {
  AI_TASK_DEFINITIONS,
  buildChatSystemPrompt,
  buildChatUserPrompt,
  type AiTaskAdditionalContextDoc,
  type AiTaskConversationTurn,
  type AiTaskDefinition,
  type AiTaskInput,
  type AiTaskOutput,
} from "./tasks.js";

export const DEFAULT_PROPOSAL_TTL_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on the number of agentic steps the chat orchestrator
 * lets the model take in a single turn. Each text-reply, tool-call, and
 * tool-result counts as one step, so a "draft 5 posts" turn naturally
 * needs at least 5 (tool calls) + 1 (final text reply) = 6 — with some
 * headroom for the model to call `find_entries` ahead of references or
 * emit interstitial reasoning. 20 gives that headroom without letting a
 * runaway loop drain the provider budget.
 */
const DEFAULT_CHAT_STEP_LIMIT = 20;

export type AiOrchestratorClock = () => Date;
export type AiOrchestratorIdFactory = () => string;

export type AiOrchestratorDeps = {
  provider: AiProvider;
  clock?: AiOrchestratorClock;
  idFactory?: AiOrchestratorIdFactory;
  proposalTtlMs?: number;
  /**
   * Domain validator forwarded to the proposal builder. When omitted,
   * proposals receive a shape-only `{ status: "valid" }` validation
   * — callers shipping endpoints that mutate drafts MUST provide a
   * validator that checks MDX components, frontmatter, and any other
   * domain constraints required by SPEC-014.
   */
  proposalValidator?: AiProposalValidator;
};

export type AiOrchestrationInput = {
  taskKind: AiTaskKind;
  envelope: AiProposalEnvelope;
  input: AiTaskInput;
  /** Hard ceiling forwarded to the provider when supported. */
  maxOutputTokens?: number;
};

export type AiOrchestrationResult = {
  proposals: AiProposal[];
  audit: AiAuditRecord;
};

export type AiChatActiveDocument = {
  documentId: string;
  path: string;
  type: string;
  locale: string;
  draftRevision: number;
  body?: string;
  frontmatter?: Record<string, unknown>;
  hasPublishedVersion: boolean;
};

export type AiChatAttachedSelection = {
  selectionId: string;
  text: string;
};

export type AiChatInput = {
  /** The new user message for this turn. */
  message: string;
  /** Project + environment routing — required so proposals carry the right envelope. */
  project: string;
  environment: string;
  /** When the request has an active document attached, its identity + a few flags the tools need. */
  activeDocument?: AiChatActiveDocument;
  attachedSelection?: AiChatAttachedSelection;
  additionalContextDocs?: AiTaskAdditionalContextDoc[];
  conversationHistory?: AiTaskConversationTurn[];
  /** Capability gate — only tools the caller is allowed to invoke are exposed to the model. */
  capabilities: ChatToolCapabilities;
  /** Validator forwarded to the proposal builder used inside each tool's execute. */
  proposalValidator?: AiProposalValidator;
  /** Hard ceiling forwarded to the provider when supported. */
  maxOutputTokens?: number;
  /**
   * Project-scoped knowledge injected into the system prompt so the
   * model picks real content type ids, fills frontmatter against the
   * actual schema, and addresses the current user by name. Built per
   * turn by the route handler. Optional during the migration; once
   * the route handler always provides it (Task 5), this can become
   * required.
   */
  projectKnowledge?: Omit<ProjectKnowledgeInput, "project" | "environment">;
  /**
   * Active host-supplied MDX component catalog. Chat tools wrap the
   * configured proposal validator with this catalog so generated MDX
   * is rejected when it references unregistered components or invalid
   * props.
   */
  mdxCatalog?: MdxComponentCatalog;
  /**
   * Backends for the read-only chat tools (find_entries, get_entry).
   * The route handler wires these from the contentStore; when absent,
   * the tools are not registered (the model gracefully responds in
   * text). `canReadEntries` is derived from `findEntries` presence.
   */
  toolBackends?: {
    findEntries?: import("./chat-tools.js").ChatToolDeps["findEntriesBackend"];
    getEntry?: import("./chat-tools.js").ChatToolDeps["getEntryBackend"];
    getComponentReference?: import("./chat-tools.js").ChatToolDeps["getComponentReferenceBackend"];
  };
};

export type AiChatResult = {
  /** Concluding text reply the model emits after any tool calls. */
  text: string;
  /** Proposals collected from this turn's tool calls (zero or more). */
  proposals: AiProposal[];
  audit: AiAuditRecord;
};

export type AiChatProgressEvent = {
  type: "progress";
  phase:
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "tool-error"
    | "step-finished";
  message: string;
  toolCallId?: string;
  toolName?: string;
  status?: "started" | "completed" | "queued" | "rejected" | "failed";
  usage?: AiProviderUsage;
};

/**
 * Streaming event produced by `runChatStream`. The orchestrator yields
 * parsed events; the route handler is responsible for serialising them
 * to SSE on the wire.
 */
export type AiChatStreamEvent =
  | AiChatProgressEvent
  | { type: "text-delta"; text: string }
  | {
      type: "done";
      text: string;
      proposals: AiProposal[];
      audit: AiAuditRecord;
    }
  | {
      type: "error";
      code: AiErrorCode;
      message: string;
      audit: AiAuditRecord;
    };

export type AiOrchestrator = {
  readonly providerId: string;
  runTask(input: AiOrchestrationInput): Promise<AiOrchestrationResult>;
  /**
   * Tool-calling chat turn. The model gets a capability-gated toolset
   * (propose_edit_selection / insert_block / update_frontmatter /
   * create_document / delete_document) plus the user's message and
   * conversation history. It decides which tools, if any, to call —
   * each tool's `execute` builds and collects a server-stamped
   * `AiProposal`. The final text reply summarizes what was proposed
   * (or just answers, if no tool was needed).
   */
  runChat(input: AiChatInput): Promise<AiChatResult>;
  /**
   * Streaming variant of `runChat`. The async iterable yields text
   * deltas as the model produces them, then a final `done` event
   * carrying the assembled proposals + audit. Errors surface as a
   * single `error` event before the iterator closes.
   */
  runChatStream(input: AiChatInput): AsyncIterable<AiChatStreamEvent>;
};

export function createAiOrchestrator(deps: AiOrchestratorDeps): AiOrchestrator {
  const clock = deps.clock ?? (() => new Date());
  const idFactory = deps.idFactory ?? defaultIdFactory;
  const ttlMs = deps.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  const validator = deps.proposalValidator;

  return {
    providerId: deps.provider.id,
    async runTask(call) {
      const occurredAt = clock();
      const definition = resolveTaskDefinitionOrFail(
        call.taskKind,
        deps.provider.id,
        occurredAt,
      );
      const baseContext: ErrorAuditContext = {
        taskKind: definition.kind,
        providerId: deps.provider.id,
        promptTemplateId: definition.promptTemplateId,
        occurredAt,
      };

      const parsedInput = parseTaskInput(definition, call.input, baseContext);

      const generation = await generateForTask(
        deps.provider,
        definition,
        parsedInput,
        call.maxOutputTokens,
        baseContext,
      );

      const enrichedContext: ErrorAuditContext = {
        ...baseContext,
        model: generation.model,
        usage: generation.usage,
      };

      const proposals = await buildProposals(
        definition,
        generation.output,
        deps.provider.id,
        generation.model,
        call.envelope,
        parsedInput,
        idFactory,
        clock,
        ttlMs,
        validator,
        enrichedContext,
      );

      const audit = buildAuditRecord({
        taskKind: definition.kind,
        providerId: deps.provider.id,
        model: generation.model,
        promptTemplateId: definition.promptTemplateId,
        occurredAt,
        outcome: "succeeded",
        validation: aggregateValidation(proposals),
        proposals,
        usage: generation.usage,
      });

      return { proposals, audit };
    },
    async runChat(call) {
      const setup = prepareChatRun(
        call,
        deps,
        clock,
        idFactory,
        ttlMs,
        validator,
      );
      if ("failure" in setup) throw setup.failure;
      const { collected, tools, system, prompt, languageModel, baseContext } =
        setup;

      try {
        const result = await generateText({
          model: languageModel,
          system,
          prompt,
          tools,
          stopWhen: stepCountIs(DEFAULT_CHAT_STEP_LIMIT),
          maxOutputTokens: call.maxOutputTokens,
        });
        const usage = normalizeUsage(result.usage);
        logChatDiagnostics({
          path: "runChat",
          modelId: languageModel.modelId,
          finishReason: result.finishReason,
          steps: result.steps,
          totalUsage: usage,
          proposalCount: collected.length,
        });
        const audit = buildAuditRecord({
          ...baseContext,
          model: languageModel.modelId,
          outcome: "succeeded",
          validation: aggregateValidation(collected),
          proposals: collected,
          ...(usage ? { usage } : {}),
        });
        return { text: result.text.trim(), proposals: collected, audit };
      } catch (error) {
        throw chatErrorToFailure(error, languageModel.modelId, baseContext);
      }
    },
    async *runChatStream(call) {
      const setup = prepareChatRun(
        call,
        deps,
        clock,
        idFactory,
        ttlMs,
        validator,
      );
      if ("failure" in setup) {
        // Emit the AI_DISABLED (or other gate) condition as a single
        // error event so the client surfaces it uniformly with any
        // mid-stream provider failure.
        const audit = setup.failure.audit;
        yield {
          type: "error",
          code: setup.failure.cause.code as AiErrorCode,
          message: setup.failure.cause.message,
          audit,
        };
        return;
      }
      const { collected, tools, system, prompt, languageModel, baseContext } =
        setup;
      let accumulatedText = "";
      try {
        const result = streamText({
          model: languageModel,
          system,
          prompt,
          tools,
          stopWhen: stepCountIs(DEFAULT_CHAT_STEP_LIMIT),
          maxOutputTokens: call.maxOutputTokens,
        });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            accumulatedText += part.text;
            yield { type: "text-delta", text: part.text };
          } else if (part.type === "start-step") {
            yield {
              type: "progress",
              phase: "thinking",
              status: "started",
              message: "Thinking through the request",
            };
          } else if (part.type === "tool-call") {
            yield {
              type: "progress",
              phase: "tool-call",
              status: "started",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              message: progressMessageForToolCall(part.toolName),
            };
          } else if (part.type === "tool-result") {
            yield progressEventForToolResult({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            });
          } else if (part.type === "tool-error") {
            yield {
              type: "progress",
              phase: "tool-error",
              status: "failed",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              message: `${toolLabel(part.toolName)} failed`,
            };
          } else if (part.type === "error") {
            throw part.error;
          } else if (part.type === "finish-step") {
            const stepUsage = normalizeUsage(part.usage);
            yield {
              type: "progress",
              phase: "step-finished",
              status: "completed",
              message:
                part.finishReason === "tool-calls"
                  ? "Tool results returned to the model"
                  : "Model step finished",
              ...(stepUsage ? { usage: stepUsage } : {}),
            };
          }
        }
        const usage = normalizeUsage(await result.usage);
        logChatDiagnostics({
          path: "runChatStream",
          modelId: languageModel.modelId,
          finishReason: await result.finishReason,
          steps: await result.steps,
          totalUsage: usage,
          proposalCount: collected.length,
        });
        const audit = buildAuditRecord({
          ...baseContext,
          model: languageModel.modelId,
          outcome: "succeeded",
          validation: aggregateValidation(collected),
          proposals: collected,
          ...(usage ? { usage } : {}),
        });
        yield {
          type: "done",
          text: accumulatedText.trim(),
          proposals: collected,
          audit,
        };
      } catch (error) {
        const failure = chatErrorToFailure(
          error,
          languageModel.modelId,
          baseContext,
        );
        yield {
          type: "error",
          code: failure.cause.code as AiErrorCode,
          message: failure.cause.message,
          audit: failure.audit,
        };
      }
    },
  };
}

/**
 * Shared chat-turn setup used by both `runChat` and `runChatStream`.
 * Returns either the prepared call materials or a `{ failure }` shape
 * the caller surfaces (throw vs. emit) according to its protocol.
 */
type ChatRunSetup = {
  collected: AiProposal[];
  tools: ReturnType<typeof buildChatTools>;
  system: string;
  prompt: string;
  languageModel: NonNullable<AiProvider["languageModel"]>;
  baseContext: ErrorAuditContext;
};

function prepareChatRun(
  call: AiChatInput,
  deps: AiOrchestratorDeps,
  clock: AiOrchestratorClock,
  idFactory: AiOrchestratorIdFactory,
  ttlMs: number,
  validator: AiProposalValidator | undefined,
): ChatRunSetup | { failure: OrchestratorFailure } {
  const occurredAt = clock();
  const baseContext: ErrorAuditContext = {
    taskKind: "chat",
    providerId: deps.provider.id,
    promptTemplateId: CHAT_TOOL_PROMPT_TEMPLATE_ID,
    occurredAt,
  };

  if (deps.provider.languageModel === null) {
    return {
      failure: new OrchestratorFailure(
        aiError(
          "AI_DISABLED",
          "AI provider is not configured for this deployment.",
        ),
        buildAuditRecord({
          ...baseContext,
          outcome: "provider_error",
          validation: { status: "valid" },
          errorCode: "AI_DISABLED",
          errorMessage: "AI provider is not configured for this deployment.",
        }),
      ),
    };
  }

  const languageModel = deps.provider.languageModel;
  const collected: AiProposal[] = [];
  const envelope: AiProposalEnvelope = {
    project: call.project,
    environment: call.environment,
    type: call.activeDocument?.type ?? "page",
    locale: call.activeDocument?.locale ?? "en",
    ...(call.activeDocument?.documentId
      ? { documentId: call.activeDocument.documentId }
      : {}),
    ...(call.activeDocument?.draftRevision !== undefined
      ? { baseDraftRevision: call.activeDocument.draftRevision }
      : {}),
  };

  const baseValidator = call.proposalValidator ?? validator;
  const bodyAwareValidator =
    typeof call.activeDocument?.body === "string"
      ? createReplaceSelectionApplyabilityValidator({
          ...(baseValidator ? { validator: baseValidator } : {}),
          body: call.activeDocument.body,
        })
      : baseValidator;
  const effectiveValidator = call.mdxCatalog
    ? createMdxCatalogProposalValidator({
        ...(bodyAwareValidator ? { validator: bodyAwareValidator } : {}),
        catalog: call.mdxCatalog,
      })
    : bodyAwareValidator;

  const tools = buildChatTools({
    envelope,
    ...(call.attachedSelection
      ? {
          attachedSelection: {
            selectionId: call.attachedSelection.selectionId,
            text: call.attachedSelection.text,
          },
        }
      : {}),
    hasActiveDocument: !!call.activeDocument,
    ...(call.activeDocument?.path
      ? { activeDocumentPath: call.activeDocument.path }
      : {}),
    activeDocumentHasPublishedVersion:
      call.activeDocument?.hasPublishedVersion ?? false,
    providerId: deps.provider.id,
    model: languageModel.modelId,
    clock,
    idFactory,
    ttlMs,
    ...(effectiveValidator ? { validator: effectiveValidator } : {}),
    capabilities: {
      ...call.capabilities,
      canReadEntries: Boolean(call.toolBackends?.findEntries),
    },
    collected,
    registeredTypeIds: (call.projectKnowledge?.registeredTypes ?? []).map(
      (t) => t.type,
    ),
    supportedLocales: call.projectKnowledge?.supportedLocales ?? [],
    ...(call.toolBackends?.findEntries
      ? { findEntriesBackend: call.toolBackends.findEntries }
      : {}),
    ...(call.toolBackends?.getEntry
      ? { getEntryBackend: call.toolBackends.getEntry }
      : {}),
    ...(call.toolBackends?.getComponentReference
      ? {
          getComponentReferenceBackend: call.toolBackends.getComponentReference,
        }
      : {}),
  });

  const projectKnowledge: ProjectKnowledgeInput = {
    project: call.project,
    environment: call.environment,
    registeredTypes: call.projectKnowledge?.registeredTypes ?? [],
    supportedLocales: call.projectKnowledge?.supportedLocales ?? [],
    ...(call.projectKnowledge?.currentUser
      ? { currentUser: call.projectKnowledge.currentUser }
      : {}),
    ...(call.mdxCatalog ? { mdxCatalog: call.mdxCatalog } : {}),
  };

  const system = buildChatSystemPrompt({
    hasActiveDocument: !!call.activeDocument,
    hasAttachedSelection: !!call.attachedSelection,
    capabilities: call.capabilities,
    registeredToolNames: Object.keys(tools),
    projectKnowledge,
  });
  const prompt = buildChatUserPrompt({
    message: call.message,
    locale: call.activeDocument?.locale ?? "en",
    activeDocument: call.activeDocument
      ? {
          path: call.activeDocument.path,
          type: call.activeDocument.type,
          locale: call.activeDocument.locale,
          ...(call.activeDocument.body
            ? { body: call.activeDocument.body }
            : {}),
          ...(call.activeDocument.frontmatter
            ? { frontmatter: call.activeDocument.frontmatter }
            : {}),
        }
      : undefined,
    additionalContextDocs: call.additionalContextDocs,
    conversationHistory: call.conversationHistory,
    attachedSelection: call.attachedSelection,
  });

  return { collected, tools, system, prompt, languageModel, baseContext };
}

function chatErrorToFailure(
  error: unknown,
  modelId: string,
  baseContext: ErrorAuditContext,
): OrchestratorFailure {
  const mapped = mapProviderError(error);
  const outcome: "invalid_output" | "provider_error" =
    mapped.code === "AI_OUTPUT_INVALID" ? "invalid_output" : "provider_error";
  return new OrchestratorFailure(
    mapped,
    buildAuditRecord({
      ...baseContext,
      model: modelId,
      outcome,
      validation:
        outcome === "invalid_output"
          ? {
              status: "invalid",
              errors: [{ code: mapped.code, message: mapped.message }],
            }
          : { status: "valid" },
      errorCode: isAiErrorCode(mapped.code)
        ? (mapped.code as AiErrorCode)
        : "AI_PROVIDER_UNAVAILABLE",
      errorMessage: mapped.message,
    }),
  );
}

function resolveTaskDefinitionOrFail(
  taskKind: AiTaskKind,
  providerId: string,
  occurredAt: Date,
): AiTaskDefinition {
  const definition = AI_TASK_DEFINITIONS[taskKind];

  if (definition) {
    return definition;
  }

  const message = `AI task "${taskKind}" is not supported.`;

  throw new OrchestratorFailure(
    aiError("AI_UNSUPPORTED_TASK", message, { taskKind }),
    buildAuditRecord({
      taskKind,
      providerId,
      promptTemplateId: `unknown:${taskKind}`,
      occurredAt,
      outcome: "provider_error",
      validation: { status: "valid" },
      errorCode: "AI_UNSUPPORTED_TASK",
      errorMessage: message,
    }),
  );
}

function parseTaskInput(
  definition: AiTaskDefinition,
  raw: AiTaskInput,
  context: ErrorAuditContext,
): AiTaskInput {
  const parsed = definition.inputSchema.safeParse(raw);

  if (parsed.success) {
    return parsed.data;
  }

  const [first] = parsed.error.issues;
  throw new OrchestratorFailure(
    aiError(
      "AI_OUTPUT_INVALID",
      first?.message ?? "Invalid task input.",
      {
        path: first?.path?.join(".") || undefined,
        issues: parsed.error.issues,
      },
      400,
    ),
    buildAuditRecord({
      ...context,
      outcome: "invalid_output",
      validation: {
        status: "invalid",
        errors: [
          {
            code: "AI_OUTPUT_INVALID",
            message: first?.message ?? "Invalid task input.",
          },
        ],
      },
      errorCode: "AI_OUTPUT_INVALID",
      errorMessage: first?.message ?? "Invalid task input.",
    }),
  );
}

type ErrorAuditContext = {
  taskKind: AiAuditTaskKind;
  providerId: string;
  promptTemplateId: string;
  occurredAt: Date;
  model?: string;
  usage?: AiProviderUsage;
};

type GenerationResult = {
  output: AiTaskOutput;
  model: string;
  usage?: AiProviderUsage;
};

async function generateForTask(
  provider: AiProvider,
  definition: AiTaskDefinition,
  input: AiTaskInput,
  maxOutputTokens: number | undefined,
  context: ErrorAuditContext,
): Promise<GenerationResult> {
  if (provider.languageModel === null) {
    throw new OrchestratorFailure(
      aiError(
        "AI_DISABLED",
        "AI provider is not configured for this deployment.",
      ),
      buildAuditRecord({
        ...context,
        outcome: "provider_error",
        validation: { status: "valid" },
        errorCode: "AI_DISABLED",
        errorMessage: "AI provider is not configured for this deployment.",
      }),
    );
  }

  try {
    const result = await generateObject({
      model: provider.languageModel,
      schema: definition.outputSchema,
      schemaName: `Ai${pascalCase(definition.kind)}Output`,
      system: definition.system,
      prompt: definition.buildUserPrompt(input),
      maxOutputTokens,
    });

    return {
      output: result.object as AiTaskOutput,
      model: provider.languageModel.modelId,
      usage: normalizeUsage(result.usage),
    };
  } catch (error) {
    const mapped = mapProviderError(error);
    const outcome: "invalid_output" | "provider_error" =
      mapped.code === "AI_OUTPUT_INVALID" ? "invalid_output" : "provider_error";

    throw new OrchestratorFailure(
      mapped,
      buildAuditRecord({
        ...context,
        model: provider.languageModel.modelId,
        outcome,
        validation:
          outcome === "invalid_output"
            ? {
                status: "invalid",
                errors: [{ code: mapped.code, message: mapped.message }],
              }
            : { status: "valid" },
        errorCode: isAiErrorCode(mapped.code)
          ? (mapped.code as AiErrorCode)
          : "AI_PROVIDER_UNAVAILABLE",
        errorMessage: mapped.message,
      }),
    );
  }
}

async function buildProposals(
  definition: AiTaskDefinition,
  output: AiTaskOutput,
  providerId: string,
  model: string,
  envelope: AiProposalEnvelope,
  taskInput: AiTaskInput,
  idFactory: AiOrchestratorIdFactory,
  clock: AiOrchestratorClock,
  ttlMs: number,
  validator: AiProposalValidator | undefined,
  context: ErrorAuditContext,
): Promise<AiProposal[]> {
  try {
    const bodyAwareValidator =
      typeof taskInput.documentBody === "string"
        ? createReplaceSelectionApplyabilityValidator({
            ...(validator ? { validator } : {}),
            body: taskInput.documentBody,
          })
        : validator;

    return await buildProposalsFromOutput(
      {
        taskKind: definition.kind,
        promptTemplateId: definition.promptTemplateId,
        providerId,
        model,
        envelope,
        output,
        anchors: taskInput.selectionId
          ? { selectionId: taskInput.selectionId }
          : undefined,
      },
      { clock, idFactory, ttlMs, validator: bodyAwareValidator },
    );
  } catch (error) {
    if (
      error instanceof RuntimeError &&
      isAiErrorCode(error.code) &&
      error.code === "AI_OUTPUT_INVALID"
    ) {
      throw new OrchestratorFailure(
        error,
        buildAuditRecord({
          ...context,
          outcome: "invalid_output",
          validation: {
            status: "invalid",
            errors: [{ code: "AI_OUTPUT_INVALID", message: error.message }],
          },
          errorCode: "AI_OUTPUT_INVALID",
          errorMessage: error.message,
        }),
      );
    }

    throw error;
  }
}

function toolLabel(toolName: string): string {
  switch (toolName) {
    case "propose_edit_selection":
      return "Edit selected text";
    case "propose_replace_document_text":
      return "Prepare replacement";
    case "propose_insert_block":
      return "Insert block";
    case "propose_update_frontmatter":
      return "Update frontmatter";
    case "propose_create_document":
      return "Create draft";
    case "propose_delete_document":
      return "Delete draft";
    case "find_entries":
      return "Search documents";
    case "get_entry":
      return "Read document";
    case "get_component_reference":
      return "Read component reference";
    default:
      return toolName;
  }
}

function progressMessageForToolCall(toolName: string): string {
  return `${toolLabel(toolName)} tool started`;
}

function progressEventForToolResult(input: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): AiChatProgressEvent {
  const output =
    input.output && typeof input.output === "object"
      ? (input.output as Record<string, unknown>)
      : {};

  if (output.rejected === true) {
    return {
      type: "progress",
      phase: "tool-result",
      status: "rejected",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      message:
        output.retryable === true
          ? "Proposal failed validation; retrying once"
          : "Proposal failed validation after retry",
    };
  }

  if (output.queued === true) {
    return {
      type: "progress",
      phase: "tool-result",
      status: "queued",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      message: "Proposal queued for review",
    };
  }

  if (typeof output.error === "string") {
    return {
      type: "progress",
      phase: "tool-result",
      status: "failed",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      message: `${toolLabel(input.toolName)} returned an error`,
    };
  }

  return {
    type: "progress",
    phase: "tool-result",
    status: "completed",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    message: `${toolLabel(input.toolName)} completed`,
  };
}

/**
 * Map AI SDK's LanguageModelUsage shape onto our internal AiProviderUsage,
 * dropping undefined fields so audit records stay tidy.
 */
function normalizeUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): AiProviderUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const result: AiProviderUsage = {};

  if (typeof usage.inputTokens === "number") {
    result.inputTokens = usage.inputTokens;
  }

  if (typeof usage.outputTokens === "number") {
    result.outputTokens = usage.outputTokens;
  }

  if (typeof usage.totalTokens === "number") {
    result.totalTokens = usage.totalTokens;
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * When multiple proposals come back from a single orchestration call,
 * the audit record's `validation` field collapses them into one
 * representative state. Any invalid proposal poisons the audit record
 * so downstream sinks can flag the call without scanning per-proposal
 * fields.
 */
function aggregateValidation(
  proposals: readonly AiProposal[],
): AiAuditRecord["validation"] {
  const aggregatedErrors: { code: string; message: string; path?: string }[] =
    [];

  for (const proposal of proposals) {
    if (proposal.validation.status === "invalid") {
      aggregatedErrors.push(...proposal.validation.errors);
    }
  }

  if (aggregatedErrors.length === 0) {
    return { status: "valid" };
  }

  return { status: "invalid", errors: aggregatedErrors };
}

function pascalCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .map((segment) =>
      segment.length === 0 ? "" : segment[0].toUpperCase() + segment.slice(1),
    )
    .join("");
}

/**
 * Per-turn diagnostic log: dumps the AI SDK's `finishReason`, per-step
 * tool calls + token usage, and total usage so operators can see why
 * a chat turn produced N proposals (e.g. `finishReason: "length"` →
 * hit `maxOutputTokens`; `finishReason: "stop"` → model decided it
 * was done). Written via `console.log` because the orchestrator
 * doesn't take a logger dep — the host server pipes stdout through
 * its structured logger.
 */
function logChatDiagnostics(input: {
  path: "runChat" | "runChatStream";
  modelId: string;
  finishReason: unknown;
  steps: unknown;
  totalUsage: AiProviderUsage | undefined;
  proposalCount: number;
}): void {
  const stepsArr = Array.isArray(input.steps)
    ? (input.steps as Array<Record<string, unknown>>)
    : [];
  const stepSummary = stepsArr.map((step, idx) => {
    const text = typeof step.text === "string" ? step.text : "";
    const toolCalls = Array.isArray(step.toolCalls)
      ? (step.toolCalls as Array<Record<string, unknown>>)
      : [];
    const usage = step.usage as Record<string, unknown> | undefined;
    return {
      idx,
      finishReason: step.finishReason,
      textLength: text.length,
      textPreview: text.length > 0 ? text.slice(0, 80) : undefined,
      toolCallNames: toolCalls
        .map((c) => (typeof c.toolName === "string" ? c.toolName : "(unknown)"))
        .filter((name): name is string => Boolean(name)),
      usage: usage
        ? {
            input: usage.inputTokens,
            output: usage.outputTokens,
            total: usage.totalTokens,
          }
        : undefined,
    };
  });
  // eslint-disable-next-line no-console
  console.log("[ai.chat.diagnostic]", {
    path: input.path,
    model: input.modelId,
    finishReason: input.finishReason,
    proposalCount: input.proposalCount,
    stepCount: stepsArr.length,
    totalUsage: input.totalUsage,
    steps: stepSummary,
  });
}

/**
 * OrchestratorFailure pairs the public RuntimeError with the audit
 * record describing the failure. The orchestrator throws it; callers
 * that catch the error can read the audit record via
 * `getOrchestratorFailureAudit()` to record the outcome.
 */
export class OrchestratorFailure extends Error {
  override readonly cause: RuntimeError;
  readonly audit: AiAuditRecord;

  constructor(cause: RuntimeError, audit: AiAuditRecord) {
    super(cause.message);
    this.name = "OrchestratorFailure";
    this.cause = cause;
    this.audit = audit;
  }
}

export function getOrchestratorFailureAudit(
  error: unknown,
): AiAuditRecord | undefined {
  return error instanceof OrchestratorFailure ? error.audit : undefined;
}

export function getOrchestratorFailureRuntimeError(
  error: unknown,
): RuntimeError | undefined {
  return error instanceof OrchestratorFailure ? error.cause : undefined;
}

let nextProposalCounter = 0;

function defaultIdFactory(): string {
  nextProposalCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);

  return `prop_${Date.now().toString(36)}_${nextProposalCounter}_${random}`;
}
