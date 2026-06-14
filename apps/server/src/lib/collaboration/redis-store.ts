import { z } from "zod";

import {
  CollaborationPresenceUserSchema,
  type CollaborationPresenceUser,
} from "@mdcms/shared";

import { createCollaborationUnavailableError } from "./errors.js";

export const COLLABORATION_INACTIVE_CACHE_TTL_SECONDS = 30 * 60;
export const COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS = 30;
export const COLLABORATION_PRESENCE_TTL_SECONDS = 30;
const COLLABORATION_PRESENCE_SCAN_COUNT = 100;

export type CollaborationYjsMetadata = {
  draftRevision: number;
  bodyHash: string;
};

const CollaborationYjsMetadataSchema = z.object({
  draftRevision: z.number().int().nonnegative(),
  bodyHash: z.string().min(1),
});

export type CollaborationDraftHead = {
  draftRevision: number;
  bodyHash: string;
};

export type FreshCollaborationYjsState = {
  state: Uint8Array;
  metadata: CollaborationYjsMetadata;
};

type CollaborationPresenceRecordInput = CollaborationPresenceUser & {
  project: string;
  environment: string;
};

export type CollaborationRedisClient = {
  get(key: string): Promise<string | null>;
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: string | Buffer): Promise<unknown>;
  set(
    key: string,
    value: string | Buffer,
    mode: "EX",
    seconds: number,
  ): Promise<unknown>;
  set(
    key: string,
    value: string | Buffer,
    mode: "EX",
    seconds: number,
    condition: "NX",
  ): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  persist(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  scan?(
    cursor: string,
    matchKeyword: "MATCH",
    pattern: string,
    countKeyword: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
};

export type CollaborationRedisUnavailableReason =
  | "missing_redis_url"
  | "connection_failed";

export type AvailableCollaborationRedisDependency = {
  status: "available";
  client: CollaborationRedisClient;
  close?: () => Promise<void>;
};

export type UnavailableCollaborationRedisDependency = {
  status: "unavailable";
  reason: CollaborationRedisUnavailableReason;
  error?: unknown;
};

export type CollaborationRedisDependency =
  | AvailableCollaborationRedisDependency
  | UnavailableCollaborationRedisDependency;

export function buildCollaborationYjsStateKey(documentId: string): string {
  return `mdcms:collaboration:yjs:${documentId}`;
}

export function buildCollaborationYjsMetaKey(documentId: string): string {
  return `mdcms:collaboration:yjs-meta:${documentId}`;
}

export function buildCollaborationActiveKey(documentId: string): string {
  return `mdcms:collaboration:active:${documentId}`;
}

export function buildCollaborationPresenceKey(input: {
  project: string;
  environment: string;
  sessionId: string;
}): string {
  return `mdcms:collaboration:presence:${input.project}:${input.environment}:${input.sessionId}`;
}

export function createUnavailableCollaborationRedisDependency(
  reason: CollaborationRedisUnavailableReason,
  error?: unknown,
): UnavailableCollaborationRedisDependency {
  return {
    status: "unavailable",
    reason,
    error,
  };
}

function createUnavailableErrorDetails(
  dependency: UnavailableCollaborationRedisDependency,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    reason: dependency.reason,
  };

  if (dependency.error instanceof Error && dependency.error.message) {
    details.errorMessage = dependency.error.message;
  } else if (
    typeof dependency.error === "string" &&
    dependency.error.length > 0
  ) {
    details.errorMessage = dependency.error;
  }

  return details;
}

function requireCollaborationRedisClient(
  dependency: CollaborationRedisDependency,
): CollaborationRedisClient {
  if (dependency.status === "available") {
    return dependency.client;
  }

  throw createCollaborationUnavailableError(
    createUnavailableErrorDetails(dependency),
  );
}

function metadataMatchesDraftHead(
  metadata: CollaborationYjsMetadata | null,
  draftHead: CollaborationDraftHead,
): metadata is CollaborationYjsMetadata {
  return (
    metadata !== null &&
    metadata.draftRevision === draftHead.draftRevision &&
    metadata.bodyHash === draftHead.bodyHash
  );
}

function parseYjsMetadata(raw: string | null): CollaborationYjsMetadata | null {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CollaborationYjsMetadataSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function parsePresenceUser(
  raw: string | null,
): CollaborationPresenceUser | null {
  if (raw === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = CollaborationPresenceUserSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

const HEARTBEAT_ACTIVE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

const RELEASE_ACTIVE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const FINALIZE_INACTIVE_ROOM_SCRIPT = `
if redis.call("GET", KEYS[3]) == ARGV[1] then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2]))
  redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2]))
  return redis.call("DEL", KEYS[3])
end
return 0
`;

function redisBooleanResult(result: unknown): boolean {
  return result === 1 || result === "1";
}

export function createCollaborationRedisStore(
  dependency: CollaborationRedisDependency,
  options: {
    inactiveCacheTtlSeconds?: number;
    activeLockLeaseSeconds?: number;
  } = {},
) {
  const inactiveCacheTtlSeconds =
    options.inactiveCacheTtlSeconds ?? COLLABORATION_INACTIVE_CACHE_TTL_SECONDS;
  const activeLockLeaseSeconds =
    options.activeLockLeaseSeconds ?? COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS;

  return {
    async getYjsState(documentId: string): Promise<Uint8Array | null> {
      const buffer = await requireCollaborationRedisClient(
        dependency,
      ).getBuffer(buildCollaborationYjsStateKey(documentId));

      return buffer === null ? null : new Uint8Array(buffer);
    },

    async setYjsState(
      documentId: string,
      state: Uint8Array | Buffer,
    ): Promise<void> {
      await requireCollaborationRedisClient(dependency).set(
        buildCollaborationYjsStateKey(documentId),
        Buffer.from(state),
      );
    },

    async deleteYjsState(documentId: string): Promise<void> {
      await requireCollaborationRedisClient(dependency).del(
        buildCollaborationYjsStateKey(documentId),
      );
    },

    async getYjsMetadata(
      documentId: string,
    ): Promise<CollaborationYjsMetadata | null> {
      const raw = await requireCollaborationRedisClient(dependency).get(
        buildCollaborationYjsMetaKey(documentId),
      );

      return parseYjsMetadata(raw);
    },

    async setYjsMetadata(
      documentId: string,
      metadata: CollaborationYjsMetadata,
    ): Promise<void> {
      await requireCollaborationRedisClient(dependency).set(
        buildCollaborationYjsMetaKey(documentId),
        JSON.stringify(metadata),
      );
    },

    async deleteYjsMetadata(documentId: string): Promise<void> {
      await requireCollaborationRedisClient(dependency).del(
        buildCollaborationYjsMetaKey(documentId),
      );
    },

    async deleteYjsCache(documentId: string): Promise<void> {
      await requireCollaborationRedisClient(dependency).del(
        buildCollaborationYjsStateKey(documentId),
        buildCollaborationYjsMetaKey(documentId),
      );
    },

    async setPresence(record: CollaborationPresenceRecordInput): Promise<void> {
      const client = requireCollaborationRedisClient(dependency);
      const presenceRecord = CollaborationPresenceUserSchema.parse(record);

      await client.set(
        buildCollaborationPresenceKey({
          project: record.project,
          environment: record.environment,
          sessionId: record.sessionId,
        }),
        JSON.stringify(presenceRecord),
        "EX",
        COLLABORATION_PRESENCE_TTL_SECONDS,
      );
    },

    async deletePresence(input: {
      project: string;
      environment: string;
      sessionId: string;
    }): Promise<void> {
      await requireCollaborationRedisClient(dependency).del(
        buildCollaborationPresenceKey(input),
      );
    },

    async listPresence(input: {
      project: string;
      environment: string;
    }): Promise<CollaborationPresenceUser[]> {
      const client = requireCollaborationRedisClient(dependency);

      if (!client.scan) {
        throw new Error("Collaboration Redis client does not support SCAN.");
      }

      const pattern = buildCollaborationPresenceKey({
        ...input,
        sessionId: "*",
      });
      const records: CollaborationPresenceUser[] = [];
      let cursor = "0";

      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          COLLABORATION_PRESENCE_SCAN_COUNT,
        );
        cursor = nextCursor;

        const rawRecords = await Promise.all(
          keys.map((key) => client.get(key)),
        );

        for (const rawRecord of rawRecords) {
          const record = parsePresenceUser(rawRecord);

          if (record !== null) {
            records.push(record);
          }
        }
      } while (cursor !== "0");

      return records;
    },

    async getFreshYjsState(
      documentId: string,
      draftHead: CollaborationDraftHead,
    ): Promise<FreshCollaborationYjsState | null> {
      const client = requireCollaborationRedisClient(dependency);
      const [state, metadata] = await Promise.all([
        client
          .getBuffer(buildCollaborationYjsStateKey(documentId))
          .then((buffer) => (buffer === null ? null : new Uint8Array(buffer))),
        client
          .get(buildCollaborationYjsMetaKey(documentId))
          .then((raw) => parseYjsMetadata(raw)),
      ]);

      if (state === null || !metadataMatchesDraftHead(metadata, draftHead)) {
        return null;
      }

      return {
        state,
        metadata,
      };
    },

    async clearInactiveCacheTtl(documentId: string): Promise<void> {
      const client = requireCollaborationRedisClient(dependency);

      await client.persist(buildCollaborationYjsStateKey(documentId));
      await client.persist(buildCollaborationYjsMetaKey(documentId));
    },

    async expireInactiveCache(documentId: string): Promise<void> {
      const client = requireCollaborationRedisClient(dependency);

      await client.expire(
        buildCollaborationYjsStateKey(documentId),
        inactiveCacheTtlSeconds,
      );
      await client.expire(
        buildCollaborationYjsMetaKey(documentId),
        inactiveCacheTtlSeconds,
      );
    },

    async isActive(documentId: string): Promise<boolean> {
      const count = await requireCollaborationRedisClient(dependency).exists(
        buildCollaborationActiveKey(documentId),
      );

      return count > 0;
    },

    async acquireActiveLock(
      documentId: string,
      leaseValue: string,
    ): Promise<boolean> {
      const result = await requireCollaborationRedisClient(dependency).set(
        buildCollaborationActiveKey(documentId),
        leaseValue,
        "EX",
        activeLockLeaseSeconds,
        "NX",
      );

      return result === "OK";
    },

    async heartbeatActiveLock(
      documentId: string,
      leaseValue: string,
    ): Promise<boolean> {
      const result = await requireCollaborationRedisClient(dependency).eval(
        HEARTBEAT_ACTIVE_LOCK_SCRIPT,
        1,
        buildCollaborationActiveKey(documentId),
        leaseValue,
        String(activeLockLeaseSeconds),
      );

      return redisBooleanResult(result);
    },

    async releaseActiveLock(
      documentId: string,
      leaseValue: string,
    ): Promise<boolean> {
      const result = await requireCollaborationRedisClient(dependency).eval(
        RELEASE_ACTIVE_LOCK_SCRIPT,
        1,
        buildCollaborationActiveKey(documentId),
        leaseValue,
      );

      return redisBooleanResult(result);
    },

    async finalizeInactiveRoom(
      documentId: string,
      leaseValue: string,
    ): Promise<boolean> {
      const client = requireCollaborationRedisClient(dependency);

      const result = await client.eval(
        FINALIZE_INACTIVE_ROOM_SCRIPT,
        3,
        buildCollaborationYjsStateKey(documentId),
        buildCollaborationYjsMetaKey(documentId),
        buildCollaborationActiveKey(documentId),
        leaseValue,
        String(inactiveCacheTtlSeconds),
      );

      return redisBooleanResult(result);
    },
  };
}
