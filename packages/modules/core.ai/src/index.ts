import type { MdcmsModulePackage } from "@mdcms/shared";

import { coreAiManifest } from "./manifest.js";
import { coreAiServerSurface } from "./server/index.js";

export const coreAiModule: MdcmsModulePackage<
  unknown,
  Record<string, unknown>
> = {
  manifest: coreAiManifest,
  server: coreAiServerSurface,
};

export {
  createAiOrchestrator,
  DEFAULT_PROPOSAL_TTL_MS,
  getOrchestratorFailureAudit,
  getOrchestratorFailureRuntimeError,
  OrchestratorFailure,
  type AiOrchestrationInput,
  type AiOrchestrationResult,
  type AiOrchestrator,
  type AiOrchestratorDeps,
} from "./server/orchestrator.js";
export {
  createAiOrchestratorFromEnv,
  type CoreAiServerDeps,
  type CreateAiOrchestratorFromEnvDeps,
} from "./server/index.js";
export {
  applyAiProposal,
  applyAiProposalUndo,
  type AiApplyContentDocument,
  type AiApplyContentScope,
  type AiApplyContentStore,
  type AiApplyInput,
  type AiApplyPriorDraft,
  type AiApplyResult,
  type AiApplyWritePayload,
  type AiUndoInput,
  type AiUndoResult,
} from "./server/apply.js";
export {
  createInMemoryAiProposalStore,
  type AiProposalRecord,
  type AiProposalStatus,
  type AiProposalStore,
  type AiProposalStoreClock,
  type CreateAiProposalStoreOptions,
} from "./server/proposal-store.js";
export {
  mountAiRoutes,
  type AiAuditEmitter,
  type AiAuthorizer,
  type AiContentStore,
  type AiContextResolver,
  type AiCsrfProtector,
  type AiSchemaHashLookup,
  type InlineTransformAction,
  type InlineTransformRequestBody,
  type MountAiRoutesOptions,
  type ProposalApplyRequestBody,
  type ProposalUndoRequestBody,
} from "./server/routes.js";
export { aiError, isAiErrorCode, mapProviderError } from "./server/errors.js";
export {
  buildProposalsFromOutput,
  type AiProposalAnchors,
  type AiProposalBuilderDeps,
  type AiProposalCandidate,
  type AiProposalEnvelope,
  type AiProposalValidator,
  type BuildProposalsInput,
} from "./server/proposal-builder.js";
export {
  buildAuditRecord,
  type AiAuditOutcome,
  type AiAuditRecord,
  type BuildAuditRecordInput,
} from "./server/audit.js";
export {
  AI_TASK_DEFINITIONS,
  getAiTaskDefinition,
  SUPPORTED_AI_TASK_KINDS,
  type AiTaskDefinition,
  type AiTaskInput,
  type AiTaskOutput,
} from "./server/tasks.js";
export {
  AI_MODEL_ENV_KEY,
  AI_PROVIDER_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  GROQ_API_KEY_ENV_KEY,
  GROQ_BASE_URL_ENV_KEY,
  resolveAiProvider,
} from "./server/providers/factory.js";
export {
  ANTHROPIC_PROVIDER_DEFAULT_MODEL,
  ANTHROPIC_PROVIDER_ID,
  createAnthropicAiProvider,
  type AnthropicProviderOptions,
} from "./server/providers/anthropic.js";
export {
  createNullAiProvider,
  NULL_PROVIDER_ID,
} from "./server/providers/null.js";
export {
  createEchoAiProvider,
  ECHO_PROVIDER_DEFAULT_MODEL,
  ECHO_PROVIDER_ID,
  type EchoAiProviderOptions,
} from "./server/providers/echo.js";
export {
  createGroqAiProvider,
  GROQ_PROVIDER_DEFAULT_MODEL,
  GROQ_PROVIDER_ID,
  type GroqProviderOptions,
} from "./server/providers/groq.js";
export type {
  AiProvider,
  AiProviderEnv,
  AiProviderFactoryDeps,
  AiProviderUsage,
} from "./server/provider.js";
export {
  createSchemaAwareProposalValidator,
  type SchemaLookup as AiProposalSchemaLookup,
} from "./server/validate-proposal.js";
export {
  renderProjectKnowledgeBlock,
  type ProjectKnowledgeInput,
} from "./server/project-knowledge.js";
