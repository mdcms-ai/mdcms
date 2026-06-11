import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createCollaborationRedisDependency,
  type ConnectableCollaborationRedisClient,
} from "./redis-client.js";

class FakeConnectableRedisClient
  implements ConnectableCollaborationRedisClient
{
  readonly failure: Error | undefined;
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(failure?: Error) {
    this.failure = failure;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;

    if (this.failure) {
      throw this.failure;
    }
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async getBuffer(): Promise<Buffer | null> {
    return null;
  }

  async set(): Promise<"OK"> {
    return "OK";
  }

  async del(): Promise<number> {
    return 0;
  }

  async expire(): Promise<number> {
    return 0;
  }

  async persist(): Promise<number> {
    return 0;
  }

  async exists(): Promise<number> {
    return 0;
  }
}

test("createCollaborationRedisDependency is unavailable when REDIS_URL is missing", async () => {
  const dependency = await createCollaborationRedisDependency({});

  assert.equal(dependency.status, "unavailable");
  assert.equal(dependency.reason, "missing_redis_url");
});

test("createCollaborationRedisDependency returns unavailable instead of throwing on initial connection failure", async () => {
  const client = new FakeConnectableRedisClient(
    new Error("connection refused"),
  );
  const dependency = await createCollaborationRedisDependency({
    redisUrl: "redis://localhost:6379/0",
    createClient: () => client,
  });

  assert.equal(dependency.status, "unavailable");
  assert.equal(dependency.reason, "connection_failed");
  assert.equal(client.connectCalls, 1);
  assert.equal(client.disconnectCalls, 1);
});

test("createCollaborationRedisDependency exposes an available client after connect", async () => {
  const client = new FakeConnectableRedisClient();
  const dependency = await createCollaborationRedisDependency({
    redisUrl: "redis://localhost:6379/0",
    createClient: () => client,
  });

  assert.equal(dependency.status, "available");

  if (dependency.status === "available") {
    assert.equal(dependency.client, client);
  }

  assert.equal(client.connectCalls, 1);
});
