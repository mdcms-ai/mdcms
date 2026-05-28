import { useCallback, useMemo, useRef, useState } from "react";
import { type ContentDocumentResponse } from "@mdcms/shared";

import type {
  StudioAiInlineAction,
  StudioAiProposal,
  StudioAiRouteApi,
} from "../../ai-route-api.js";
import {
  classifyInlineAiError,
  classifiedToTopLevelInlineAiState,
  inlineAiTransformResultToState,
  resolveInlineAiRequest,
} from "./inline-ai-state.js";

export type InlineAiSelection = {
  /**
   * Stable client-supplied id for the selection. The server stamps this
   * onto generated `replace_selection` operations. Re-using the same id
   * across `Try again` calls keeps the proposal anchored to the same
   * range.
   */
  id: string;
  text: string;
};

export type InlineAiTransformOptions = {
  documentId?: string;
  draftRevision?: number;
  schemaHash: string;
};

export type InlineAiTransformIntent = {
  action: StudioAiInlineAction;
  instruction?: string;
  /** Required when `action` is `change_tone`; ignored otherwise. */
  tone?: string;
};

export type InlineAiState =
  | { status: "idle" }
  | { status: "loading"; intent: InlineAiTransformIntent }
  | {
      status: "proposal";
      proposal: StudioAiProposal;
      intent: InlineAiTransformIntent;
    }
  | {
      status: "validation_invalid";
      proposal: StudioAiProposal;
      intent: InlineAiTransformIntent;
    }
  | { status: "empty"; intent: InlineAiTransformIntent }
  | { status: "applying"; proposal: StudioAiProposal }
  | {
      status: "applied";
      proposal: StudioAiProposal;
      document: ContentDocumentResponse;
    }
  | {
      status: "stale";
      proposal: StudioAiProposal;
      message: string;
    }
  | {
      status: "forbidden";
      message: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
    };

export type InlineAiAppliedSignal = {
  proposal: StudioAiProposal;
  document: ContentDocumentResponse;
};

export type UseInlineAiTransformInput = {
  api: StudioAiRouteApi;
  options: InlineAiTransformOptions;
  selection: InlineAiSelection | null;
  onApplied?: (signal: InlineAiAppliedSignal) => void;
};

export type UseInlineAiTransformResult = {
  state: InlineAiState;
  request: (intent: InlineAiTransformIntent) => Promise<void>;
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  reset: () => void;
};

/**
 * useInlineAiTransform manages the state machine for inline AI selection
 * transforms in Studio. The hook owns one in-flight request at a time;
 * a fresh `request()` call cancels the previous one via AbortController.
 */
export function useInlineAiTransform(
  input: UseInlineAiTransformInput,
): UseInlineAiTransformResult {
  const { api, options, selection, onApplied } = input;
  const [state, setState] = useState<InlineAiState>({ status: "idle" });
  const abortControllerRef = useRef<AbortController | null>(null);

  const request = useCallback(
    async (intent: InlineAiTransformIntent) => {
      const resolved = resolveInlineAiRequest({
        intent,
        selection,
        options: {
          documentId: options.documentId,
          draftRevision: options.draftRevision,
        },
      });

      if (resolved.kind === "blocked") {
        setState(resolved.state);
        return;
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setState({ status: "loading", intent });

      try {
        // react-doctor-disable-next-line react-doctor/async-defer-await -- stale inline transforms are discarded by the abort guard immediately after this await.
        const result = await api.inlineTransform({
          ...resolved.payload,
          action: intent.action,
          instruction: intent.instruction,
          tone: intent.tone,
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        setState(
          inlineAiTransformResultToState({
            intent,
            proposals: result.proposals,
          }),
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setState(
          classifiedToTopLevelInlineAiState(classifyInlineAiError(error)),
        );
      }
    },
    [api, options.documentId, options.draftRevision, selection],
  );

  const accept = useCallback(async () => {
    const current = state;

    if (current.status !== "proposal") {
      return;
    }

    const proposal = current.proposal;
    setState({ status: "applying", proposal });

    try {
      const result = await api.applyProposal({
        proposalId: proposal.proposalId,
        draftRevision: options.draftRevision,
        schemaHash: options.schemaHash,
      });
      setState({
        status: "applied",
        proposal: result.proposal,
        document: result.document,
      });

      onApplied?.({ proposal: result.proposal, document: result.document });
    } catch (error) {
      const classified = classifyInlineAiError(error);

      if (classified.kind === "stale") {
        setState({
          status: "stale",
          proposal,
          message: classified.message,
        });
        return;
      }

      setState(classifiedToTopLevelInlineAiState(classified));
    }
  }, [api, options.draftRevision, options.schemaHash, state, onApplied]);

  const reject = useCallback(async () => {
    const current = state;

    if (
      current.status !== "proposal" &&
      current.status !== "validation_invalid"
    ) {
      setState({ status: "idle" });
      return;
    }

    const proposal = current.proposal;
    setState({ status: "idle" });

    try {
      await api.rejectProposal({ proposalId: proposal.proposalId });
    } catch {
      // Reject failures are non-fatal — the local proposal is already
      // discarded; surfacing a stale-id error to the user is noisy.
    }
  }, [api, state]);

  const reset = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState({ status: "idle" });
  }, []);

  return useMemo(
    () => ({
      state,
      request,
      accept,
      reject,
      reset,
    }),
    [state, request, accept, reject, reset],
  );
}
