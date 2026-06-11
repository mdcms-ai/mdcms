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
    condition?: "NX";
    args?: string[];
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
    condition?: "NX",
  ): Promise<"OK" | null> {
    this.calls.push({ method: "set", key, value, seconds, condition });
    assert.equal(mode === undefined || mode === "EX", true);
    assert.equal(condition === undefined || condition === "NX", true);

    if (condition === "NX" && this.values.has(key)) {
      return null;
    }

    this.values.set(key, Buffer.isBuffer(value) ? Buffer.from(value) : value);
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

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<number> {
    const keys = args.slice(0, numberOfKeys);
    const scriptArgs = args.slice(numberOfKeys);
    const leaseValue = scriptArgs[0];
    const seconds = scriptArgs[1];
    const activeKey = numberOfKeys === 3 ? keys[2] : keys[0];

    if (typeof activeKey !== "string" || typeof leaseValue !== "string") {
      throw new Error("Invalid fake Redis eval invocation.");
    }

    const call: (typeof this.calls)[number] = {
      method: "eval",
      args: [leaseValue],
    };

    if (numberOfKeys === 1) {
      call.key = activeKey;
    } else {
      call.keys = keys;
    }

    if (seconds !== undefined) {
      call.seconds = Number(seconds);
    }

    this.calls.push(call);
    assert.equal(numberOfKeys === 1 || numberOfKeys === 3, true);

    if (this.values.get(activeKey) !== leaseValue) {
      return 0;
    }

    if (numberOfKeys === 3 && script.includes("KEYS[3]")) {
      assert.equal(typeof seconds, "string");
      this.values.delete(activeKey);
      return 1;
    }

    if (script.includes("EXPIRE")) {
      assert.equal(typeof seconds, "string");
      return 1;
    }

    if (script.includes("DEL")) {
      this.values.delete(activeKey);
      return 1;
    }

    throw new Error("Unsupported fake Redis eval script.");
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

test("active collaboration lock acquire heartbeat isActive and release are owner guarded", async () => {
  const documentId = "45c51e1f-8649-4c03-ac54-0e949a71e5f8";
  const { client, store } = createStore();
  const activeKey = buildCollaborationActiveKey(documentId);

  assert.equal(await store.acquireActiveLock(documentId, "room-1"), true);
  assert.equal(await store.acquireActiveLock(documentId, "room-2"), false);
  assert.equal(client.values.get(activeKey), "room-1");
  assert.equal(await store.isActive(documentId), true);

  assert.equal(await store.heartbeatActiveLock(documentId, "room-2"), false);
  assert.equal(client.values.get(activeKey), "room-1");
  assert.equal(await store.heartbeatActiveLock(documentId, "room-1"), true);

  assert.equal(await store.releaseActiveLock(documentId, "room-2"), false);
  assert.equal(client.values.get(activeKey), "room-1");
  assert.equal(await store.releaseActiveLock(documentId, "room-1"), true);
  assert.equal(await store.isActive(documentId), false);

  assert.deepEqual(client.calls, [
    {
      method: "set",
      key: activeKey,
      value: "room-1",
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
      condition: "NX",
    },
    {
      method: "set",
      key: activeKey,
      value: "room-2",
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
      condition: "NX",
    },
    {
      method: "exists",
      key: activeKey,
    },
    {
      method: "eval",
      key: activeKey,
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
      args: ["room-2"],
    },
    {
      method: "eval",
      key: activeKey,
      seconds: COLLABORATION_ACTIVE_LOCK_LEASE_SECONDS,
      args: ["room-1"],
    },
    {
      method: "eval",
      key: activeKey,
      args: ["room-2"],
    },
    {
      method: "eval",
      key: activeKey,
      args: ["room-1"],
    },
    {
      method: "exists",
      key: activeKey,
    },
  ]);
});

test("final cleanup expires state and metadata then releases the active lock", async () => {
  const documentId = "d615b389-fdd1-45ba-b1dd-05a2bdac3814";
  const { client, store } = createStore();
  await store.acquireActiveLock(documentId, "room-1");
  client.calls.length = 0;

  assert.equal(await store.finalizeInactiveRoom(documentId, "room-1"), true);

  assert.deepEqual(client.calls, [
    {
      method: "eval",
      keys: [
        buildCollaborationYjsStateKey(documentId),
        buildCollaborationYjsMetaKey(documentId),
        buildCollaborationActiveKey(documentId),
      ],
      args: ["room-1"],
      seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
    },
  ]);
});

test("final cleanup does not expire cache or release the active lock for non-owners", async () => {
  const documentId = "d615b389-fdd1-45ba-b1dd-05a2bdac3814";
  const { client, store } = createStore();
  const activeKey = buildCollaborationActiveKey(documentId);
  await store.acquireActiveLock(documentId, "room-1");
  client.calls.length = 0;

  assert.equal(await store.finalizeInactiveRoom(documentId, "room-2"), false);
  assert.equal(client.values.get(activeKey), "room-1");
  assert.deepEqual(client.calls, [
    {
      method: "eval",
      keys: [
        buildCollaborationYjsStateKey(documentId),
        buildCollaborationYjsMetaKey(documentId),
        activeKey,
      ],
      args: ["room-2"],
      seconds: COLLABORATION_INACTIVE_CACHE_TTL_SECONDS,
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

test("unavailable Redis dependency omits raw non-serializable error objects", async () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const store = createCollaborationRedisStore(
    createUnavailableCollaborationRedisDependency(
      "connection_failed",
      circular,
    ),
  );

  await assert.rejects(
    () => store.isActive("9a967d50-39e6-43a2-baf9-4982335d61d3"),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "COLLABORATION_UNAVAILABLE" &&
      error.statusCode === 503 &&
      error.details?.reason === "connection_failed" &&
      !("error" in error.details) &&
      !("errorMessage" in error.details),
  );
});

test("unavailable Redis dependency reports stable error messages for Error and string failures", async () => {
  for (const failure of [new Error("connection refused"), "socket closed"]) {
    const store = createCollaborationRedisStore(
      createUnavailableCollaborationRedisDependency(
        "connection_failed",
        failure,
      ),
    );

    await assert.rejects(
      () => store.isActive("9a967d50-39e6-43a2-baf9-4982335d61d3"),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "COLLABORATION_UNAVAILABLE" &&
        error.statusCode === 503 &&
        error.details?.reason === "connection_failed" &&
        error.details?.errorMessage ===
          (failure instanceof Error ? failure.message : failure),
    );
  }
});
