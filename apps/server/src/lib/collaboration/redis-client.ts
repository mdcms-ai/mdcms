import { Redis } from "ioredis";

import {
  createUnavailableCollaborationRedisDependency,
  type CollaborationRedisClient,
  type CollaborationRedisDependency,
} from "./redis-store.js";

export type ConnectableCollaborationRedisClient = CollaborationRedisClient & {
  connect(): Promise<void>;
  disconnect(reconnect?: boolean): void;
  quit?(): Promise<unknown>;
  on?(event: "error", listener: (error: Error) => void): unknown;
};

export type CreateCollaborationRedisDependencyOptions = {
  redisUrl?: string;
  connectTimeoutMs?: number;
  createClient?: (
    redisUrl: string,
    options: { connectTimeoutMs: number },
  ) => ConnectableCollaborationRedisClient;
};

const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 1_000;

function createIoredisClient(
  redisUrl: string,
  options: { connectTimeoutMs: number },
): ConnectableCollaborationRedisClient {
  const client = new Redis(redisUrl, {
    connectTimeout: options.connectTimeoutMs,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null,
  });

  client.on("error", () => {
    // Availability is represented by the dependency status; boot must not crash
    // because the Redis client emits after a failed connection attempt.
  });

  return client;
}

async function closeClient(
  client: ConnectableCollaborationRedisClient,
): Promise<void> {
  if (client.quit) {
    try {
      await client.quit();
      return;
    } catch {
      client.disconnect();
      return;
    }
  }

  client.disconnect();
}

export async function createCollaborationRedisDependency(
  options: CreateCollaborationRedisDependencyOptions,
): Promise<CollaborationRedisDependency> {
  const redisUrl = options.redisUrl?.trim();

  if (!redisUrl) {
    return createUnavailableCollaborationRedisDependency("missing_redis_url");
  }

  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_REDIS_CONNECT_TIMEOUT_MS;
  const createClient = options.createClient ?? createIoredisClient;
  let client: ConnectableCollaborationRedisClient | undefined;

  try {
    client = createClient(redisUrl, { connectTimeoutMs });
    await client.connect();
  } catch (error) {
    client?.disconnect();
    return createUnavailableCollaborationRedisDependency(
      "connection_failed",
      error,
    );
  }

  return {
    status: "available",
    client,
    close: () => closeClient(client),
  };
}
