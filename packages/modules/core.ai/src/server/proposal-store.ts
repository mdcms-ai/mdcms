import {
  RuntimeError,
  type AiProposal,
  type MdxComponentCatalog,
} from "@mdcms/shared";
import type { AiApplyResult } from "./apply.js";

export type AiProposalStatus = "pending" | "accepted" | "rejected" | "expired";

export type AiTrustedUndo = {
  documentId: string;
  postApplyDraftRevision: number;
  priorDraft?: AiApplyResult["priorDraft"];
};

export type AiProposalRecord = {
  proposal: AiProposal;
  status: AiProposalStatus;
  /** Actor that requested proposal creation. */
  createdByActorId: string;
  createdAt: string;
  /** Set when the proposal moves out of `pending`. */
  resolvedAt?: string;
  /** Actor that accepted or rejected the proposal. */
  resolvedByActorId?: string;
  mdxCatalog?: MdxComponentCatalog;
  undo?: { result: AiTrustedUndo; expiresAt: number };
};

export type AiProposalStoreClock = () => Date;

export type AiProposalStore = {
  insert(input: {
    proposal: AiProposal;
    actorId: string;
    mdxCatalog?: MdxComponentCatalog;
  }): AiProposalRecord;
  reserve(proposalId: string): () => void;
  saveUndo(proposalId: string, result: AiApplyResult): void;
  getUndo(proposalId: string): AiTrustedUndo;
  consumeUndo(proposalId: string): void;
  cleanup(): void;
  dispose(): void;
  /**
   * Return the current record after opportunistic retention cleanup.
   */
  peek(proposalId: string): AiProposalRecord | undefined;
  /**
   * Look up the record and return its current state. If the proposal's
   * `expiresAt` has elapsed and it is still pending, the record is
   * transitioned to `expired` before being returned.
   */
  observe(proposalId: string): AiProposalRecord | undefined;
  markAccepted(input: {
    proposalId: string;
    actorId: string;
  }): AiProposalRecord;
  markRejected(input: {
    proposalId: string;
    actorId: string;
  }): AiProposalRecord;
  /**
   * Iterate every stored record without filtering by status. Mostly
   * useful in tests; the store is not designed to be a long-lived
   * archive of resolved proposals.
   */
  list(): AiProposalRecord[];
};

export type CreateAiProposalStoreOptions = {
  clock?: AiProposalStoreClock;
  /** A host may choose a stricter bound than the default 1,000 records. */
  capacity?: number;
};

const TERMINAL_STATUSES: ReadonlySet<AiProposalStatus> = new Set([
  "accepted",
  "rejected",
  "expired",
]);

function proposalNotFound(proposalId: string): RuntimeError {
  return new RuntimeError({
    code: "NOT_FOUND",
    message: "AI proposal not found.",
    statusCode: 404,
    details: { proposalId },
  });
}

function proposalAlreadyResolved(record: AiProposalRecord): RuntimeError {
  if (record.status === "expired") {
    return new RuntimeError({
      code: "AI_PROPOSAL_EXPIRED",
      message: "AI proposal has expired.",
      statusCode: 410,
      details: {
        proposalId: record.proposal.proposalId,
        status: record.status,
      },
    });
  }

  return new RuntimeError({
    code: "AI_PROPOSAL_CONFLICT",
    message: "AI proposal has already been resolved.",
    statusCode: 409,
    details: {
      proposalId: record.proposal.proposalId,
      status: record.status,
    },
  });
}

function isExpiredAt(record: AiProposalRecord, now: Date): boolean {
  if (record.status !== "pending") {
    return false;
  }

  const expiresAt = Date.parse(record.proposal.expiresAt);

  if (Number.isNaN(expiresAt)) {
    return false;
  }

  return expiresAt <= now.getTime();
}

/**
 * In-memory proposal store used by the AI module's lifecycle service.
 *
 * Pending proposals and their terminal grace period are bounded by SPEC-014.
 * Reservations protect in-flight mutations; release performs overdue cleanup.
 * Runtime shutdown must dispose the store's unreferenced cleanup timer.
 */
export function createInMemoryAiProposalStore(
  options: CreateAiProposalStoreOptions = {},
): AiProposalStore {
  const clock = options.clock ?? (() => new Date());
  const records = new Map<string, AiProposalRecord>();
  const reservations = new Set<string>();
  const capacity = options.capacity ?? 1000;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000)
    throw new Error("Proposal capacity must be an integer between 1 and 1000.");
  const retentionMs = 10 * 60_000;
  let disposed = false;
  const cleanup = () => {
    const now = clock().getTime();
    for (const [id, record] of records) {
      if (reservations.has(id)) continue;
      if (record.undo && now >= record.undo.expiresAt) delete record.undo;
      const expiresAt = Date.parse(record.proposal.expiresAt);
      if (record.status === "pending" && expiresAt <= now) {
        record.status = "expired";
        record.resolvedAt = new Date(expiresAt).toISOString();
      }
      if (
        record.status !== "pending" &&
        record.resolvedAt &&
        Date.parse(record.resolvedAt) + retentionMs <= now
      ) {
        delete record.undo;
        records.delete(id);
      }
    }
  };
  const maintain = () => {
    if (disposed) throw new Error("Proposal store is disposed.");
    cleanup();
  };
  const cleanupTimer = setInterval(cleanup, 1000);
  cleanupTimer.unref();

  return {
    cleanup,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(cleanupTimer);
      for (const record of records.values()) delete record.undo;
      records.clear();
      reservations.clear();
    },
    reserve(proposalId) {
      maintain();
      if (reservations.has(proposalId))
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message: "Proposal operation is already in progress.",
          statusCode: 409,
        });
      reservations.add(proposalId);
      return () => {
        reservations.delete(proposalId);
        cleanup();
      };
    },
    saveUndo(proposalId, result) {
      maintain();
      const record = records.get(proposalId);
      if (!record) throw proposalNotFound(proposalId);
      if (record.status !== "accepted") throw proposalAlreadyResolved(record);
      record.undo = {
        result: {
          documentId: result.document.documentId,
          postApplyDraftRevision: result.document.draftRevision,
          ...(result.priorDraft
            ? { priorDraft: structuredClone(result.priorDraft) }
            : {}),
        },
        expiresAt: clock().getTime() + 6000,
      };
    },
    getUndo(proposalId) {
      maintain();
      const record = records.get(proposalId);
      if (!record) throw proposalNotFound(proposalId);
      if (!record.undo || clock().getTime() >= record.undo.expiresAt)
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message: "Undo is unavailable or expired.",
          statusCode: 409,
        });
      return structuredClone(record.undo.result);
    },
    consumeUndo(proposalId) {
      maintain();
      const record = records.get(proposalId);
      if (!record) throw proposalNotFound(proposalId);
      delete record.undo;
    },
    insert({ proposal, actorId, mdxCatalog }) {
      maintain();
      if (records.has(proposal.proposalId)) {
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message: "AI proposal id is already in use.",
          statusCode: 409,
          details: { proposalId: proposal.proposalId },
        });
      }

      if (records.size >= capacity) {
        throw new RuntimeError({
          code: "AI_RATE_LIMITED",
          message:
            "AI proposal capacity is full. Try again after existing proposals expire.",
          statusCode: 429,
        });
      }

      const record: AiProposalRecord = {
        proposal: structuredClone(proposal),
        ...(mdxCatalog ? { mdxCatalog: structuredClone(mdxCatalog) } : {}),
        status: "pending",
        createdByActorId: actorId,
        createdAt: clock().toISOString(),
      };
      records.set(proposal.proposalId, record);

      return record;
    },
    peek(proposalId) {
      maintain();
      return records.get(proposalId);
    },
    observe(proposalId) {
      maintain();
      const existing = records.get(proposalId);

      if (!existing) {
        return undefined;
      }

      if (isExpiredAt(existing, clock())) {
        const expired: AiProposalRecord = {
          ...existing,
          status: "expired",
          resolvedAt: existing.proposal.expiresAt,
        };
        records.set(proposalId, expired);
        return expired;
      }

      return existing;
    },
    markAccepted({ proposalId, actorId }) {
      maintain();
      const existing = records.get(proposalId);

      if (!existing) {
        throw proposalNotFound(proposalId);
      }

      const now = clock();

      if (!reservations.has(proposalId) && isExpiredAt(existing, now)) {
        const expired: AiProposalRecord = {
          ...existing,
          status: "expired",
          resolvedAt: now.toISOString(),
        };
        records.set(proposalId, expired);
        throw proposalAlreadyResolved(expired);
      }

      if (TERMINAL_STATUSES.has(existing.status)) {
        throw proposalAlreadyResolved(existing);
      }

      const accepted: AiProposalRecord = {
        ...existing,
        status: "accepted",
        resolvedAt: now.toISOString(),
        resolvedByActorId: actorId,
      };
      records.set(proposalId, accepted);
      return accepted;
    },
    markRejected({ proposalId, actorId }) {
      maintain();
      if (reservations.has(proposalId))
        throw new RuntimeError({
          code: "AI_PROPOSAL_CONFLICT",
          message: "Proposal operation is already in progress.",
          statusCode: 409,
        });
      const existing = records.get(proposalId);

      if (!existing) {
        throw proposalNotFound(proposalId);
      }

      const now = clock();

      if (isExpiredAt(existing, now)) {
        const expired: AiProposalRecord = {
          ...existing,
          status: "expired",
          resolvedAt: now.toISOString(),
        };
        records.set(proposalId, expired);
        throw proposalAlreadyResolved(expired);
      }

      if (TERMINAL_STATUSES.has(existing.status)) {
        throw proposalAlreadyResolved(existing);
      }

      const rejected: AiProposalRecord = {
        ...existing,
        status: "rejected",
        resolvedAt: now.toISOString(),
        resolvedByActorId: actorId,
      };
      records.set(proposalId, rejected);
      return rejected;
    },
    list() {
      cleanup();
      return Array.from(records.values());
    },
  };
}
