import assert from "node:assert/strict";
import { test } from "bun:test";

import { RuntimeError } from "@mdcms/shared";

import {
  COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
  COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
  buildCollaborationActiveKey,
  buildCollaborationYjsMetaKey,
  buildCollaborationYjsStateKey,
  createCollaborationRedisStore,
  createUnavailableCollaborationRedisDependency,
  type CollaborationRedisClient,
} from "./redis-store.js";

class FakeRedisClient implements CollaborationRedisClient {
  readonly values = new Map<string, Buffer | string>();
  readonly calls: Array<{
    method: string;
    key?: string;
    keys?: string[];
    seconds?: number;
    value?: Buffer | string;
  }> = [];

  async get(key: string): Promise<string | null> {
    this.calls.push({ method: "get", key });
    const value = this.values.get(key);

    if (value === undefined) {
      return null;
    }

    return Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    this.calls.push({ method: "getBuffer", key });
    const value = this.values.get(key);

    if (value === undefined) {
      return null;
    }

    return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
  }

  async set(
    key: string,
    value: Buffer | string,
    mode?: "EX",
    seconds?: number,
  ): Promise<"OK"> {
    this.calls.push({ method: "set", key, value, seconds });
    this.values.set(key, Buffer.isBuffer(value) ? Buffer.from(value) : value);
    assert.equal(mode === undefined || mode === "EX", true);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.calls.push({ method: "del", keys });
    let deleted = 0;

    for (const key of keys) {
      if (this.values.delete(key)) {
        deleted += 1;
      }
    }

    return deleted;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.calls.push({ method: "expire", key, seconds });
    return this.values.has(key) ? 1 : 0;
  }

  async persist(key: string): Promise<number> {
    this.calls.push({ method: "persist", key });
    return this.values.has(key) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    this.calls.push({ method: "exists", key });
    return this.values.has(key) ? 1 : 0;
  }
}

function createStore(): {
  client: FakeRedisClient;
  store: ReturnType<typeof createCollaborationRedisStore>;
} {
  const client = new FakeRedisClient();
  return {
    client,
    store: createCollaborationRedisStore({
      status: "available",
      client,
    }),
  };
}

test("collaboration Redis key builders match the documented key shape", () => {
  const documentId = "5ad76d8b-4de0-48e7-9370-8f5d2df3b1d1";

  assert.equal(
    buildCollaborationYjsStateKey(documentId),
    "mdcms:collaboration:yjs:5ad76d8b-4de0-48e7-9370-8f5d2df3b1d1",
  );
  assert.equal(
    buildCollaborationYjsMetaKey(documentId),
    "mdcms:collaboration:yjs-meta:5ad76d8b-4de0-48e7-9370-8f5d2df3b1d1",
  );
  assert.equal(
    buildCollaborationActiveKey(documentId),
    "mdcms:collaboration:active:5ad76d8b-4de0-48e7-9370-8f5d2df3b1d1",
  );
});

test("state and metadata round trip through Redis without changing binary bytes", async () => {
  const documentId = "3c4c9a4d-5232-43ff-9caf-86d339c37a92";
  const { client, store } = createStore();
  const state = new Uint8Array([0, 255, 1, 128, 65, 0]);

  await store.setYjsState(documentId, state);
  await store.setYjsMetadata(documentId, {
    draftRevision: 17,
    bodyHash: "sha256:body",
  });

  assert.deepEqual(await store.getYjsState(documentId), state);
  assert.deepEqual(await store.getYjsMetadata(documentId), {
    draftRevision: 17,
    bodyHash: "sha256:body",
  });
  assert.deepEqual(
    client.values.get(buildCollaborationYjsStateKey(documentId)),
    Buffer.from(state),
  );
});

test("state and metadata delete uses both cache keys", async () => {
  const documentId = "74079a3b-5056-46bd-b610-483a8f5a9cfe";
  const { client, store } = createStore();

  await store.setYjsState(documentId, new Uint8Array([1, 2, 3]));
  await store.setYjsMetadata(documentId, {
    draftRevision: 2,
    bodyHash: "hash",
  });

  await store.deleteYjsState(documentId);
  await store.deleteYjsMetadata(documentId);

  assert.equal(
    client.values.has(buildCollaborationYjsStateKey(documentId)),
    false,
  );
  assert.equal(
    client.values.has(buildCollaborationYjsMetaKey(documentId)),
    false,
  );
});

test("fresh cached state is returned only when metadata matches current draft head", async () => {
  const documentId = "d7729005-a0ff-4f99-852d-55b32fb8e2d2";
  const { store } = createStore();
  const state = new Uint8Array([5, 4, 3]);

  await store.setYjsState(documentId, state);
  await store.setYjsMetadata(documentId, {
    draftRevision: 9,
    bodyHash: "sha256:fresh",
  });

  assert.deepEqual(
    await store.getFreshYjsState(documentId, {
      draftRevision: 9,
      bodyHash: "sha256:fresh",
    }),
    {
      state,
      metadata: {
        draftRevision: 9,
        bodyHash: "sha256:fresh",
      },
    },
  );
  assert.equal(
    await store.getFreshYjsState(documentId, {
      draftRevision: 10,
      bodyHash: "sha256:fresh",
    }),
    null,
  );
  assert.equal(
    await store.getFreshYjsState(documentId, {
      draftRevision: 9,
      bodyHash: "sha256:stale",
    }),
    null,
  );
});

test("active-room lifecycle clears inactive TTLs then expires cache after final cleanup", async () => {
  const documentId = "aa7bb3be-6fd7-4e3f-a81f-cf2616b3667c";
  const { client, store } = createStore();

  await store.clearInactiveCacheTtl(documentId);
  await store.expireInactiveCache(documentId);

  assert.deepEqual(
    client.calls.filter(
      (call) => call.method === "persist" || call.method === "expire",
    ),
    [
      {
        method: "persist",
        key: buildCollaborationYjsStateKey(documentId),
      },
      {
        method: "persist",
        key: buildCollaborationYjsMetaKey(documentId),
      },
      {
        method: "expire",
        key: buildCollaborationYjsStateKey(documentId),
        seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
      },
      {
        method: "expire",
        key: buildCollaborationYjsMetaKey(documentId),
        seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
      },
    ],
  );
});

test("active collaboration lock acquire heartbeat isActive and release use the active key", async () => {
  const documentId = "45c51e1f-8649-4c03-ac54-0e949a71e5f8";
  const { client, store } = createStore();

  await store.acquireActiveLock(documentId, "room-1");
  assert.equal(await store.isActive(documentId), true);
  await store.heartbeatActiveLock(documentId, "room-1");
  await store.releaseActiveLock(documentId);
  assert.equal(await store.isActive(documentId), false);

  assert.deepEqual(client.calls, [
    {
      method: "set",
      key: buildCollaborationActiveKey(documentId),
      value: "room-1",
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
    },
    {
      method: "exists",
      key: buildCollaborationActiveKey(documentId),
    },
    {
      method: "set",
      key: buildCollaborationActiveKey(documentId),
      value: "room-1",
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
    },
    {
      method: "del",
      keys: [buildCollaborationActiveKey(documentId)],
    },
    {
      method: "exists",
      key: buildCollaborationActiveKey(documentId),
    },
  ]);
});

test("final cleanup expires state and metadata then releases the active lock", async () => {
  const documentId = "d615b389-fdd1-45ba-b1dd-05a2bdac3814";
  const { client, store } = createStore();

  await store.finalizeInactiveRoom(documentId);

  assert.deepEqual(client.calls, [
    {
      method: "expire",
      key: buildCollaborationYjsStateKey(documentId),
      seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
    },
    {
      method: "expire",
      key: buildCollaborationYjsMetaKey(documentId),
      seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
    },
    {
      method: "del",
      keys: [buildCollaborationActiveKey(documentId)],
    },
  ]);
});

test("unavailable Redis dependency throws future HTTP-compatible collaboration error", async () => {
  const store = createCollaborationRedisStore(
    createUnavailableCollaborationRedisDependency("missing_redis_url"),
  );

  await assert.rejects(
    () => store.isActive("9a967d50-39e6-43a2-baf9-4982335d61d3"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_UNAVAILABLE" &&
      error.statusCode === 503 &&
      error.details?.reason === "missing_redis_url",
  );
});
