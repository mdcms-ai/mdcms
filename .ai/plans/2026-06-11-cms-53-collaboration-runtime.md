# CMS-53 Collaboration Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the in-process Hocuspocus collaboration WebSocket runtime with Redis-backed ephemeral Yjs state and final last-disconnect draft auto-save.

**Architecture:** Keep PostgreSQL as the canonical Markdown/MDX source and Redis as the only Yjs binary cache. Reuse the existing collaboration auth guard for session-only handshake and write revalidation, reuse `@mdcms/studio` headless Markdown/TipTap serialization for server-side conversion, and wire Hocuspocus into the existing Bun server through `crossws/adapters/bun`.

**Tech Stack:** Bun, Elysia, TypeScript, Hocuspocus v4, Yjs, Redis/ioredis, TipTap 3, `@mdcms/studio` markdown pipeline, Bun test.

---

## Scope Notes

- Do not implement this plan until the user explicitly asks to proceed.
- Jira setup is already done for `CMS-53`: assigned user matches and status is `In Progress`; the CMS board has no active sprint.
- Spec delta: no product-contract spec change is required. Existing specs cover the endpoint, session-only auth, routing context, `4401`/`4403`, Redis-ephemeral Yjs state, and PostgreSQL as canonical Markdown/MDX. This implementation should add operator-facing Redis notes where configuration is introduced.
- Because this touches published `@mdcms/studio` source and `package.json`, create a changeset with `bun run changeset` during implementation. Do not hand-write `.changeset/*.md`.
- Existing unrelated untracked files are present in this workspace. Use an isolated worktree or a focused branch and avoid staging unrelated files.

## File Structure

- Modify: `apps/server/package.json`
  - Add server runtime dependencies: `@hocuspocus/server`, `@hocuspocus/transformer`, `crossws`, `ioredis`, `yjs`.
  - Add `@hocuspocus/provider` only if the WebSocket integration test uses it directly.
- Modify: `bun.lock`
  - Updated by Bun when dependencies are installed.
- Modify: `apps/server/src/lib/env.ts`
  - Parse and expose optional `REDIS_URL`.
- Modify: `apps/server/src/lib/env.test.ts`
  - Cover `REDIS_URL` parsing and invalid URL rejection.
- Create: `packages/studio/src/lib/headless-editor.ts`
  - Export the headless editor extension factory for server-side Yjs conversion.
- Create: `packages/studio/src/lib/headless-editor.test.ts`
  - Prove the exported headless boundary round-trips Markdown/MDX using the same pipeline.
- Modify: `packages/studio/package.json`
  - Add `./headless-editor` conditional export.
- Create: `apps/server/src/lib/collaboration/yjs-markdown-conversion.ts`
  - Convert Markdown/MDX draft body to a Yjs update and convert a Yjs update back to Markdown/MDX.
- Create: `apps/server/src/lib/collaboration/yjs-markdown-conversion.test.ts`
  - Cover headings, plain paragraphs, and MDX wrapper components.
- Create: `apps/server/src/lib/collaboration/redis-yjs-store.ts`
  - Own Redis key naming, binary reads/writes, and 30-minute TTL application.
- Create: `apps/server/src/lib/collaboration/redis-yjs-store.test.ts`
  - Test key shape, binary preservation, and TTL seconds.
- Create: `apps/server/src/lib/collaboration/document-hooks.ts`
  - Own `onLoadDocument`, `onStoreDocument`, and last-disconnect final-save behavior independent of Hocuspocus plumbing.
- Create: `apps/server/src/lib/collaboration/document-hooks.test.ts`
  - Test Redis cache hit/miss, DB fallback, Redis-only store, final auto-save, TTL, and write revalidation.
- Create: `apps/server/src/lib/collaboration/runtime.ts`
  - Build Hocuspocus + crossws runtime and expose Bun `websocket` and `handleUpgrade`.
- Create: `apps/server/src/lib/collaboration/runtime.test.ts`
  - Test upgrade routing and close-code mapping with injectable fakes where possible.
- Create: `apps/server/src/lib/collaboration/runtime.integration.test.ts`
  - Exercise two clients against the same room and verify sync/final-save/TTL behavior.
- Modify: `apps/server/src/lib/collaboration-auth.ts`
  - Keep the existing auth guard, but make route mounting compatible with a real WebSocket runtime; keep HTTP GET returning `426` for non-upgrade requests.
- Modify: `apps/server/src/lib/collaboration-auth.test.ts`
  - Update the route test if the response shape changes, while preserving existing auth semantics.
- Modify: `apps/server/src/lib/runtime-with-modules.ts`
  - Create the collaboration runtime from the existing `authService`, `contentStore`, parsed env, and logger.
  - Return it alongside the request handler.
- Modify: `apps/server/src/bin/http-server.ts`
  - Add Bun WebSocket upgrade handling for `/api/v1/collaboration`.
- Modify: `docs/specs/SPEC-011-local-development-and-operations.md`
  - Document that collaboration uses `REDIS_URL` for the ephemeral Yjs cache and that the cache TTL is 30 minutes after the last disconnect.
- Modify: `.env.example`
  - Keep or clarify `REDIS_URL=redis://redis:6379`.

---

### Task 1: Add Redis env parsing and collaboration dependencies

**Files:**
- Modify: `apps/server/src/lib/env.test.ts`
- Modify: `apps/server/src/lib/env.ts`
- Modify: `apps/server/package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Write the failing env tests**

Add these tests to `apps/server/src/lib/env.test.ts` near the other parse tests:

```ts
test("parseServerEnv parses REDIS_URL as a normalized absolute URL", () => {
  const env = parseServerEnv({
    REDIS_URL: " redis://localhost:6379/0 ",
  } as NodeJS.ProcessEnv);

  assert.equal(env.REDIS_URL, "redis://localhost:6379/0");
});

test("parseServerEnv leaves REDIS_URL undefined when absent", () => {
  const env = parseServerEnv({} as NodeJS.ProcessEnv);

  assert.equal(env.REDIS_URL, undefined);
});

test("parseServerEnv rejects invalid REDIS_URL values", () => {
  assert.throws(
    () =>
      parseServerEnv({
        REDIS_URL: "not redis",
      } as NodeJS.ProcessEnv),
    (error: unknown) =>
      error instanceof RuntimeError &&
      error.code === "INVALID_ENV" &&
      error.details?.key === "REDIS_URL",
  );
});
```

- [ ] **Step 2: Run the env test to verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/env.test.ts
```

Expected: FAIL because `ServerEnv` does not expose `REDIS_URL` yet.

- [ ] **Step 3: Implement minimal env parsing**

In `apps/server/src/lib/env.ts`, add `REDIS_URL?: string` to `ServerEnv`, add a Redis URL parser, and include it in `parseServerEnv`:

```ts
function createRedisInvalidEnvError(
  key: string,
  value: unknown,
  message: string,
): RuntimeError {
  return new RuntimeError({
    code: "INVALID_ENV",
    message,
    details: { key, value },
  });
}

function parseRedisUrl(rawValue: string | undefined): string | undefined {
  const value = parseOptionalTrimmedEnvString(rawValue);
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw createRedisInvalidEnvError(
      "REDIS_URL",
      rawValue,
      "REDIS_URL must be a redis:// or rediss:// URL.",
    );
  }
}
```

Then wire:

```ts
const redisUrl = parseRedisUrl(rawEnv.REDIS_URL);

return extendEnv(core, () => ({
  // existing fields
  REDIS_URL: redisUrl,
}));
```

- [ ] **Step 4: Add dependencies**

Run:

```bash
bun add --cwd apps/server @hocuspocus/server@^4 @hocuspocus/transformer@^4 crossws ioredis yjs
```

If the integration test needs Hocuspocus client helpers, also run:

```bash
bun add --cwd apps/server -d @hocuspocus/provider@^4
```

Expected: `apps/server/package.json` and `bun.lock` update.

- [ ] **Step 5: Run env test to verify it passes**

Run:

```bash
bun test --cwd apps/server ./src/lib/env.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/env.ts apps/server/src/lib/env.test.ts apps/server/package.json bun.lock
git commit -m "feat(server): add collaboration redis config"
```

---

### Task 2: Export Studio headless editor extensions for server conversion

**Files:**
- Create: `packages/studio/src/lib/headless-editor.ts`
- Create: `packages/studio/src/lib/headless-editor.test.ts`
- Modify: `packages/studio/package.json`

- [ ] **Step 1: Write the failing headless export test**

Create `packages/studio/src/lib/headless-editor.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";
import { Editor } from "@tiptap/core";

import { createHeadlessEditorExtensions } from "./headless-editor.js";
import {
  extractMarkdownFromEditor,
  parseMarkdownToDocument,
} from "./markdown-pipeline.js";

test("createHeadlessEditorExtensions supports server-side markdown serialization", () => {
  const editor = new Editor({
    content: parseMarkdownToDocument("# Launch Notes"),
    contentType: "json",
    extensions: createHeadlessEditorExtensions(),
  });

  try {
    assert.match(extractMarkdownFromEditor(editor), /# Launch Notes/);
  } finally {
    editor.destroy();
  }
});

test("createHeadlessEditorExtensions keeps MDX component serialization available", () => {
  const editor = new Editor({
    content: parseMarkdownToDocument(
      ['<Callout type="warning">', "Body", "</Callout>"].join("\n"),
    ),
    contentType: "json",
    extensions: createHeadlessEditorExtensions(),
  });

  try {
    const markdown = extractMarkdownFromEditor(editor);
    assert.match(markdown, /<Callout type="warning">/);
    assert.match(markdown, /Body/);
    assert.match(markdown, /<\/Callout>/);
  } finally {
    editor.destroy();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd packages/studio ./src/lib/headless-editor.test.ts
```

Expected: FAIL because `headless-editor.ts` does not exist.

- [ ] **Step 3: Implement the headless export**

Create `packages/studio/src/lib/headless-editor.ts`:

```ts
import type { Extensions } from "@tiptap/core";

import { createEditorExtensions } from "./editor-extensions.js";

/**
 * Headless editor extensions used by server-side collaboration conversion.
 * Keep this boundary aligned with the Studio editor so Markdown/MDX
 * round-trips do not fork between browser editing and WebSocket persistence.
 */
export function createHeadlessEditorExtensions(): Extensions {
  return createEditorExtensions();
}
```

Add a package subpath export to `packages/studio/package.json`:

```json
"./headless-editor": {
  "@mdcms/source": "./src/lib/headless-editor.ts",
  "bun": "./src/lib/headless-editor.ts",
  "types": "./dist/lib/headless-editor.d.ts",
  "import": "./dist/lib/headless-editor.js",
  "default": "./dist/lib/headless-editor.js"
}
```

Place it near `./markdown-pipeline`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test --cwd packages/studio ./src/lib/headless-editor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/lib/headless-editor.ts packages/studio/src/lib/headless-editor.test.ts packages/studio/package.json
git commit -m "feat(studio): expose headless editor extensions"
```

---

### Task 3: Add Markdown/MDX <-> Yjs conversion

**Files:**
- Create: `apps/server/src/lib/collaboration/yjs-markdown-conversion.ts`
- Create: `apps/server/src/lib/collaboration/yjs-markdown-conversion.test.ts`

- [ ] **Step 1: Write the failing conversion tests**

Create `apps/server/src/lib/collaboration/yjs-markdown-conversion.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  markdownToYjsUpdate,
  yjsUpdateToMarkdown,
} from "./yjs-markdown-conversion.js";

test("markdownToYjsUpdate converts markdown before clients join", () => {
  const update = markdownToYjsUpdate("# Launch Notes");

  assert.ok(update instanceof Uint8Array);
  assert.ok(update.byteLength > 0);
});

test("Yjs conversion round-trips plain markdown through the Studio pipeline", () => {
  const update = markdownToYjsUpdate("# Launch Notes\n\nShip collaboration.");

  const markdown = yjsUpdateToMarkdown(update);

  assert.match(markdown, /# Launch Notes/);
  assert.match(markdown, /Ship collaboration\./);
});

test("Yjs conversion round-trips MDX wrapper components", () => {
  const source = ['<Callout type="warning">', "Body", "</Callout>"].join("\n");

  const markdown = yjsUpdateToMarkdown(markdownToYjsUpdate(source));

  assert.match(markdown, /<Callout type="warning">/);
  assert.match(markdown, /Body/);
  assert.match(markdown, /<\/Callout>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/yjs-markdown-conversion.test.ts
```

Expected: FAIL because the conversion module does not exist.

- [ ] **Step 3: Implement minimal conversion**

Create `apps/server/src/lib/collaboration/yjs-markdown-conversion.ts`:

```ts
import { TiptapTransformer } from "@hocuspocus/transformer";
import { createHeadlessEditorExtensions } from "@mdcms/studio/headless-editor";
import {
  parseMarkdownToDocument,
  serializeDocumentToMarkdown,
} from "@mdcms/studio/markdown-pipeline";
import type { JSONContent } from "@tiptap/core";
import * as Y from "yjs";

const COLLABORATION_FIELD_NAME = "default";

function createYDocFromUpdate(update: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, update);
  return document;
}

export function encodeYDocState(document: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(document);
}

export function markdownToYjsUpdate(markdown: string): Uint8Array {
  const prosemirrorJson = parseMarkdownToDocument(markdown);
  const document = TiptapTransformer.toYdoc(
    prosemirrorJson,
    COLLABORATION_FIELD_NAME,
    createHeadlessEditorExtensions(),
  );

  return encodeYDocState(document);
}

export function yjsUpdateToMarkdown(update: Uint8Array): string {
  const document = createYDocFromUpdate(update);
  const prosemirrorJson = TiptapTransformer.fromYdoc(
    document,
    COLLABORATION_FIELD_NAME,
  ) as JSONContent;

  return serializeDocumentToMarkdown(prosemirrorJson);
}
```

If the installed `@hocuspocus/transformer` types show a slightly different `fromYdoc` signature, adjust this file against the type definition and keep the tests above unchanged.

- [ ] **Step 4: Run conversion tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/yjs-markdown-conversion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/collaboration/yjs-markdown-conversion.ts apps/server/src/lib/collaboration/yjs-markdown-conversion.test.ts
git commit -m "feat(server): add collaboration yjs markdown conversion"
```

---

### Task 4: Add Redis Yjs binary store

**Files:**
- Create: `apps/server/src/lib/collaboration/redis-yjs-store.ts`
- Create: `apps/server/src/lib/collaboration/redis-yjs-store.test.ts`

- [ ] **Step 1: Write the failing Redis store tests**

Create `apps/server/src/lib/collaboration/redis-yjs-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  COLLABORATION_YJS_TTL_SECONDS,
  createRedisYjsStateStore,
} from "./redis-yjs-store.js";

class FakeRedisClient {
  values = new Map<string, Buffer>();
  expirations = new Map<string, number>();

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: Buffer): Promise<"OK"> {
    this.values.set(key, Buffer.from(value));
    return "OK";
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expirations.set(key, seconds);
    return 1;
  }
}

test("Redis Yjs store uses yjs document keys", async () => {
  const redis = new FakeRedisClient();
  const store = createRedisYjsStateStore(redis);

  await store.store("doc-1", new Uint8Array([1, 2, 3]));

  assert.deepEqual(redis.values.get("yjs:doc-1"), Buffer.from([1, 2, 3]));
});

test("Redis Yjs store preserves binary data on load", async () => {
  const redis = new FakeRedisClient();
  redis.values.set("yjs:doc-1", Buffer.from([4, 5, 6]));
  const store = createRedisYjsStateStore(redis);

  const loaded = await store.load("doc-1");

  assert.deepEqual(loaded, new Uint8Array([4, 5, 6]));
});

test("Redis Yjs store applies the last-disconnect TTL", async () => {
  const redis = new FakeRedisClient();
  const store = createRedisYjsStateStore(redis);

  await store.expireAfterLastDisconnect("doc-1");

  assert.equal(
    redis.expirations.get("yjs:doc-1"),
    COLLABORATION_YJS_TTL_SECONDS,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-yjs-store.test.ts
```

Expected: FAIL because the Redis store module does not exist.

- [ ] **Step 3: Implement the Redis store**

Create `apps/server/src/lib/collaboration/redis-yjs-store.ts`:

```ts
export const COLLABORATION_YJS_TTL_SECONDS = 30 * 60;

export type RedisYjsClient = {
  getBuffer: (key: string) => Promise<Buffer | null>;
  set: (key: string, value: Buffer) => Promise<unknown>;
  expire: (key: string, seconds: number) => Promise<unknown>;
};

export type RedisYjsStateStore = {
  load: (documentId: string) => Promise<Uint8Array | undefined>;
  store: (documentId: string, update: Uint8Array) => Promise<void>;
  expireAfterLastDisconnect: (documentId: string) => Promise<void>;
};

export function collaborationYjsRedisKey(documentId: string): string {
  return `yjs:${documentId}`;
}

export function createRedisYjsStateStore(
  client: RedisYjsClient,
): RedisYjsStateStore {
  return {
    async load(documentId) {
      const buffer = await client.getBuffer(collaborationYjsRedisKey(documentId));
      return buffer ? new Uint8Array(buffer) : undefined;
    },
    async store(documentId, update) {
      await client.set(collaborationYjsRedisKey(documentId), Buffer.from(update));
    },
    async expireAfterLastDisconnect(documentId) {
      await client.expire(
        collaborationYjsRedisKey(documentId),
        COLLABORATION_YJS_TTL_SECONDS,
      );
    },
  };
}
```

- [ ] **Step 4: Run Redis store tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/redis-yjs-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/collaboration/redis-yjs-store.ts apps/server/src/lib/collaboration/redis-yjs-store.test.ts
git commit -m "feat(server): add collaboration redis yjs store"
```

---

### Task 5: Add collaboration document load/store/final-save hooks

**Files:**
- Create: `apps/server/src/lib/collaboration/document-hooks.ts`
- Create: `apps/server/src/lib/collaboration/document-hooks.test.ts`

- [ ] **Step 1: Write failing hook tests**

Create `apps/server/src/lib/collaboration/document-hooks.test.ts` with focused fakes:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";
import * as Y from "yjs";

import {
  createCollaborationDocumentHooks,
  type CollaborationHookContext,
} from "./document-hooks.js";
import { markdownToYjsUpdate } from "./yjs-markdown-conversion.js";

const context: CollaborationHookContext = {
  request: new Request("http://localhost/api/v1/collaboration"),
  userId: "editor-1",
  sessionId: "session-1",
  project: "marketing",
  environment: "staging",
  documentId: "11111111-1111-4111-8111-111111111111",
  documentPath: "blog/post-1",
  role: "editor",
};

function ydocFromMarkdown(markdown: string): Y.Doc {
  const document = new Y.Doc();
  Y.applyUpdate(document, markdownToYjsUpdate(markdown));
  return document;
}

test("onLoadDocument returns cached Redis Yjs state without reading PostgreSQL", async () => {
  let dbReads = 0;
  const cached = markdownToYjsUpdate("# Cached");
  const hooks = createCollaborationDocumentHooks({
    yjsStore: {
      load: async () => cached,
      store: async () => undefined,
      expireAfterLastDisconnect: async () => undefined,
    },
    contentStore: {
      getById: async () => {
        dbReads += 1;
        return undefined;
      },
      update: async () => {
        throw new Error("unexpected update");
      },
    },
    revalidateWrite: async () => ({ ok: true }),
  });

  const update = await hooks.loadDocument(context);

  assert.deepEqual(update, cached);
  assert.equal(dbReads, 0);
});

test("onLoadDocument builds Yjs state from PostgreSQL draft body on Redis miss", async () => {
  const stored: Uint8Array[] = [];
  const hooks = createCollaborationDocumentHooks({
    yjsStore: {
      load: async () => undefined,
      store: async (_documentId, update) => stored.push(update),
      expireAfterLastDisconnect: async () => undefined,
    },
    contentStore: {
      getById: async () => ({
        documentId: context.documentId,
        body: "# From DB",
        path: context.documentPath,
        isDeleted: false,
      }),
      update: async () => {
        throw new Error("unexpected update");
      },
    },
    revalidateWrite: async () => ({ ok: true }),
  });

  const update = await hooks.loadDocument(context);

  assert.equal(stored.length, 1);
  assert.ok(update.byteLength > 0);
});

test("onStoreDocument writes Yjs binary only to Redis", async () => {
  let redisWrites = 0;
  let dbWrites = 0;
  const hooks = createCollaborationDocumentHooks({
    yjsStore: {
      load: async () => undefined,
      store: async () => {
        redisWrites += 1;
      },
      expireAfterLastDisconnect: async () => undefined,
    },
    contentStore: {
      getById: async () => undefined,
      update: async () => {
        dbWrites += 1;
        throw new Error("unexpected update");
      },
    },
    revalidateWrite: async () => ({ ok: true }),
  });

  await hooks.storeDocument({
    context,
    document: ydocFromMarkdown("# Changed"),
  });

  assert.equal(redisWrites, 1);
  assert.equal(dbWrites, 0);
});

test("last collaborator disconnect triggers final save and Redis TTL", async () => {
  let ttlApplied = false;
  const updates: Array<{ body?: string; updatedBy?: string }> = [];
  const hooks = createCollaborationDocumentHooks({
    yjsStore: {
      load: async () => undefined,
      store: async () => undefined,
      expireAfterLastDisconnect: async () => {
        ttlApplied = true;
      },
    },
    contentStore: {
      getById: async () => undefined,
      update: async (_scope, _documentId, payload) => {
        updates.push(payload);
        return {} as never;
      },
    },
    revalidateWrite: async () => ({ ok: true }),
  });

  await hooks.disconnectDocument({
    context,
    clientsCount: 0,
    document: ydocFromMarkdown("# Final body"),
  });

  assert.equal(ttlApplied, true);
  assert.equal(updates.length, 1);
  assert.match(updates[0]?.body ?? "", /# Final body/);
  assert.equal(updates[0]?.updatedBy, "editor-1");
});

test("last disconnect skips final save when collaborators remain", async () => {
  let dbWrites = 0;
  let ttlWrites = 0;
  const hooks = createCollaborationDocumentHooks({
    yjsStore: {
      load: async () => undefined,
      store: async () => undefined,
      expireAfterLastDisconnect: async () => {
        ttlWrites += 1;
      },
    },
    contentStore: {
      getById: async () => undefined,
      update: async () => {
        dbWrites += 1;
        return {} as never;
      },
    },
    revalidateWrite: async () => ({ ok: true }),
  });

  await hooks.disconnectDocument({
    context,
    clientsCount: 1,
    document: ydocFromMarkdown("# Still open"),
  });

  assert.equal(dbWrites, 0);
  assert.equal(ttlWrites, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/document-hooks.test.ts
```

Expected: FAIL because the hook module does not exist.

- [ ] **Step 3: Implement the hook service**

Create `apps/server/src/lib/collaboration/document-hooks.ts` with these exported shapes:

```ts
import { RuntimeError } from "@mdcms/shared";
import type * as Y from "yjs";

import type { ContentStore } from "../content-api/types.js";
import type { CollaborationCloseCode } from "../collaboration-auth.js";
import type { RedisYjsStateStore } from "./redis-yjs-store.js";
import {
  encodeYDocState,
  markdownToYjsUpdate,
  yjsUpdateToMarkdown,
} from "./yjs-markdown-conversion.js";

export type CollaborationHookContext = {
  request: Request;
  userId: string;
  sessionId: string;
  project: string;
  environment: string;
  documentId: string;
  documentPath: string;
  role: string;
};

export type CollaborationWriteRevalidator = (
  request: Request,
  context: CollaborationHookContext,
) => Promise<{ ok: true } | { ok: false; closeCode: CollaborationCloseCode }>;

export function createCollaborationDocumentHooks(options: {
  yjsStore: RedisYjsStateStore;
  contentStore: Pick<ContentStore, "getById" | "update">;
  revalidateWrite: CollaborationWriteRevalidator;
}) {
  async function revalidate(context: CollaborationHookContext): Promise<void> {
    const result = await options.revalidateWrite(context.request, context);
    if (!result.ok) {
      throw new RuntimeError({
        code:
          result.closeCode === 4401
            ? "UNAUTHORIZED"
            : "COLLABORATION_FORBIDDEN",
        message: "Collaboration write access is no longer valid.",
        statusCode: result.closeCode === 4401 ? 401 : 403,
        details: { closeCode: result.closeCode },
      });
    }
  }

  return {
    async loadDocument(context: CollaborationHookContext): Promise<Uint8Array> {
      const cached = await options.yjsStore.load(context.documentId);
      if (cached) return cached;

      const document = await options.contentStore.getById(
        { project: context.project, environment: context.environment },
        context.documentId,
        { draft: true },
      );

      if (!document || document.isDeleted) {
        throw new RuntimeError({
          code: "NOT_FOUND",
          message: "Collaboration target document not found.",
          statusCode: 404,
          details: { documentId: context.documentId },
        });
      }

      const update = markdownToYjsUpdate(document.body);
      await options.yjsStore.store(context.documentId, update);
      return update;
    },

    async storeDocument(input: {
      context: CollaborationHookContext;
      document: Y.Doc;
    }): Promise<void> {
      await revalidate(input.context);
      await options.yjsStore.store(
        input.context.documentId,
        encodeYDocState(input.document),
      );
    },

    async disconnectDocument(input: {
      context: CollaborationHookContext;
      clientsCount: number;
      document: Y.Doc;
    }): Promise<void> {
      if (input.clientsCount > 0) return;

      await revalidate(input.context);
      const update = encodeYDocState(input.document);
      await options.yjsStore.store(input.context.documentId, update);
      await options.contentStore.update(
        { project: input.context.project, environment: input.context.environment },
        input.context.documentId,
        {
          body: yjsUpdateToMarkdown(update),
          updatedBy: input.context.userId,
        },
      );
      await options.yjsStore.expireAfterLastDisconnect(input.context.documentId);
    },
  };
}
```

- [ ] **Step 4: Run hook tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/document-hooks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/collaboration/document-hooks.ts apps/server/src/lib/collaboration/document-hooks.test.ts
git commit -m "feat(server): add collaboration document hooks"
```

---

### Task 6: Build Hocuspocus runtime and Bun WebSocket bridge

**Files:**
- Create: `apps/server/src/lib/collaboration/runtime.ts`
- Create: `apps/server/src/lib/collaboration/runtime.test.ts`
- Modify: `apps/server/src/lib/collaboration-auth.ts`
- Modify: `apps/server/src/lib/collaboration-auth.test.ts`

- [ ] **Step 1: Write failing runtime unit tests**

Create `apps/server/src/lib/collaboration/runtime.test.ts` with tests for pure routing helpers and close-code conversion:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  createCollaborationCloseEvent,
  isCollaborationUpgradeRequest,
} from "./runtime.js";

test("isCollaborationUpgradeRequest matches only collaboration websocket upgrades", () => {
  assert.equal(
    isCollaborationUpgradeRequest(
      new Request("http://localhost/api/v1/collaboration", {
        headers: { upgrade: "websocket" },
      }),
    ),
    true,
  );
  assert.equal(
    isCollaborationUpgradeRequest(
      new Request("http://localhost/api/v1/content", {
        headers: { upgrade: "websocket" },
      }),
    ),
    false,
  );
  assert.equal(
    isCollaborationUpgradeRequest(
      new Request("http://localhost/api/v1/collaboration"),
    ),
    false,
  );
});

test("createCollaborationCloseEvent preserves deterministic close codes", () => {
  assert.deepEqual(createCollaborationCloseEvent(4401), {
    code: 4401,
    reason: "Collaboration authorization failed.",
  });
  assert.deepEqual(createCollaborationCloseEvent(4403), {
    code: 4403,
    reason: "Collaboration authorization failed.",
  });
});
```

Update `apps/server/src/lib/collaboration-auth.test.ts` only if the non-upgrade route response changes. Preserve the existing expectation that a successfully authorized plain HTTP GET returns `426`.

- [ ] **Step 2: Run runtime tests to verify they fail**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts ./src/lib/collaboration-auth.test.ts
```

Expected: FAIL because `runtime.ts` does not exist.

- [ ] **Step 3: Implement runtime module**

Create `apps/server/src/lib/collaboration/runtime.ts`:

```ts
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import crossws from "crossws/adapters/bun";

import type {
  CollaborationCloseCode,
  CollaborationSessionContext,
} from "../collaboration-auth.js";
import type { Logger } from "@mdcms/shared";
import type { CollaborationHookContext } from "./document-hooks.js";

export function isCollaborationUpgradeRequest(request: Request): boolean {
  return (
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    new URL(request.url).pathname === "/api/v1/collaboration"
  );
}

export function createCollaborationCloseEvent(code: CollaborationCloseCode): {
  code: CollaborationCloseCode;
  reason: string;
} {
  return {
    code,
    reason: "Collaboration authorization failed.",
  };
}

function toHookContext(
  request: Request,
  context: CollaborationSessionContext,
): CollaborationHookContext {
  return {
    ...context,
    request,
  };
}
```

Then add `createCollaborationRuntime`:

```ts
export function createCollaborationRuntime(options: {
  logger: Logger;
  authorizeHandshake: (
    request: Request,
  ) => Promise<
    | { ok: true; context: CollaborationSessionContext }
    | { ok: false; closeCode: CollaborationCloseCode; message: string }
  >;
  hooks: ReturnType<
    typeof import("./document-hooks.js").createCollaborationDocumentHooks
  >;
}) {
  const hocuspocus = new Hocuspocus({
    async onAuthenticate(data) {
      const result = await options.authorizeHandshake(data.request);
      if (!result.ok) {
        throw createCollaborationCloseEvent(result.closeCode);
      }
      return toHookContext(data.request, result.context);
    },
    async beforeHandleMessage(data) {
      const context = data.context as CollaborationHookContext;
      await options.hooks.storeDocument({
        context,
        document: data.document,
      });
    },
    async onLoadDocument(data) {
      return options.hooks.loadDocument(data.context as CollaborationHookContext);
    },
    async onStoreDocument(data) {
      await options.hooks.storeDocument({
        context: data.lastContext as CollaborationHookContext,
        document: data.document,
      });
    },
    async onDisconnect(data) {
      await options.hooks.disconnectDocument({
        context: data.context as CollaborationHookContext,
        clientsCount: data.clientsCount,
        document: data.document,
      });
    },
  });

  const ws = crossws({
    hooks: {
      open(peer) {
        const wsLike: WebSocketLike = {
          get readyState() {
            return peer.websocket.readyState ?? 3;
          },
          send(data) {
            peer.send(data);
          },
          close(code?: number, reason?: string) {
            peer.close(code, reason);
          },
        };
        const clientConnection = hocuspocus.handleConnection(
          wsLike,
          peer.request as Request,
        );
        (peer as unknown as { _hocuspocus?: typeof clientConnection })
          ._hocuspocus = clientConnection;
      },
      message(peer, message) {
        (peer as unknown as { _hocuspocus?: { handleMessage: (message: Uint8Array) => void } })
          ._hocuspocus?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (peer as unknown as { _hocuspocus?: { handleClose: (event: { code: number; reason: string }) => void } })
          ._hocuspocus?.handleClose({
            code: event.code,
            reason: event.reason,
          });
      },
      error(peer, error) {
        options.logger.error("collaboration.websocket_error", {
          peerId: peer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
  });

  return {
    websocket: ws.websocket,
    handleUpgrade: ws.handleUpgrade,
    async destroy() {
      await hocuspocus.destroy();
    },
  };
}
```

If Hocuspocus types require a narrower `CloseEvent` import from `@hocuspocus/common`, import that type and keep `createCollaborationCloseEvent` returning the same object shape tested above.

- [ ] **Step 4: Run runtime tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts ./src/lib/collaboration-auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/collaboration/runtime.ts apps/server/src/lib/collaboration/runtime.test.ts apps/server/src/lib/collaboration-auth.ts apps/server/src/lib/collaboration-auth.test.ts
git commit -m "feat(server): add collaboration websocket runtime"
```

---

### Task 7: Wire runtime creation into server startup

**Files:**
- Modify: `apps/server/src/lib/runtime-with-modules.ts`
- Modify: `apps/server/src/bin/http-server.ts`
- Modify: `apps/server/src/lib/runtime-with-modules.test.ts`

- [ ] **Step 1: Write failing runtime-with-modules tests**

Add tests to `apps/server/src/lib/runtime-with-modules.test.ts`:

```ts
test("createRuntimeCollaborationServices is disabled without REDIS_URL", () => {
  assert.equal(createRuntimeCollaborationServices({}), undefined);
});

test("createRuntimeCollaborationServices creates services when REDIS_URL is configured", () => {
  const services = createRuntimeCollaborationServices({
    REDIS_URL: "redis://localhost:6379",
  });

  assert.ok(services);
  assert.equal(typeof services.yjsStore.load, "function");
  void services.redis.disconnect();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun test --cwd apps/server ./src/lib/runtime-with-modules.test.ts
```

Expected: FAIL because `createRuntimeCollaborationServices` does not exist.

- [ ] **Step 3: Implement runtime service factory**

In `apps/server/src/lib/runtime-with-modules.ts`, add:

```ts
import Redis from "ioredis";
import {
  createRedisYjsStateStore,
  type RedisYjsStateStore,
} from "./collaboration/redis-yjs-store.js";
import {
  createCollaborationDocumentHooks,
} from "./collaboration/document-hooks.js";
import {
  createCollaborationRuntime,
  type CollaborationRuntime,
} from "./collaboration/runtime.js";
```

Add a small factory:

```ts
export type RuntimeCollaborationServicesEnv = {
  REDIS_URL?: string;
};

export function createRuntimeCollaborationServices(
  env: RuntimeCollaborationServicesEnv,
): { redis: Redis; yjsStore: RedisYjsStateStore } | undefined {
  if (!env.REDIS_URL) return undefined;

  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  return {
    redis,
    yjsStore: createRedisYjsStateStore(redis),
  };
}
```

Extend `ServerRequestHandlerWithModulesResult`:

```ts
collaborationRuntime?: CollaborationRuntime;
```

When building the runtime, create auth guard once and pass `guard.authorizeHandshake` plus `guard.revalidateWrite` into hooks. Keep `mountCollaborationRoutes` for plain HTTP non-upgrade responses.

- [ ] **Step 4: Wire Bun upgrade handling**

In `apps/server/src/bin/http-server.ts`, update the Bun runtime type:

```ts
type BunRuntime = {
  serve: (options: {
    port: number;
    fetch: (
      request: Request,
      server: unknown,
    ) => Response | Promise<Response>;
    websocket?: unknown;
    idleTimeout?: number;
  }) => BunServer;
};
```

Use the returned collaboration runtime:

```ts
const { handler, collaborationRuntime } =
  await prepareServerRequestHandlerWithModules({ env: process.env });

const server = Bun.serve({
  port: env.PORT,
  websocket: collaborationRuntime?.websocket,
  fetch(request, bunServer) {
    if (
      collaborationRuntime &&
      isCollaborationUpgradeRequest(request)
    ) {
      return collaborationRuntime.handleUpgrade(request, bunServer);
    }
    return handler(request);
  },
  idleTimeout: 255,
});
```

Import `isCollaborationUpgradeRequest` from `../lib/collaboration/runtime.js`.

During shutdown:

```ts
await collaborationRuntime?.destroy();
server.stop(true);
```

- [ ] **Step 5: Run server startup unit tests**

Run:

```bash
bun test --cwd apps/server ./src/lib/runtime-with-modules.test.ts ./src/lib/collaboration/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lib/runtime-with-modules.ts apps/server/src/lib/runtime-with-modules.test.ts apps/server/src/bin/http-server.ts
git commit -m "feat(server): wire collaboration runtime into startup"
```

---

### Task 8: Add WebSocket integration coverage

**Files:**
- Create: `apps/server/src/lib/collaboration/runtime.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create a test that starts a real Bun server with the collaboration runtime and injected fake content/Redis dependencies. The test should:

- Start one runtime on a random local port.
- Connect two Hocuspocus clients to the same `documentId`.
- Verify both receive the same server-loaded Yjs document.
- Apply a Yjs update from client A and verify client B receives it.
- Disconnect both clients.
- Verify content store `update` is called once after the last disconnect.
- Verify Redis TTL is set to `1800`.

Skeleton:

```ts
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

import { createCollaborationRuntime } from "./runtime.js";
import { createCollaborationDocumentHooks } from "./document-hooks.js";
import { COLLABORATION_YJS_TTL_SECONDS } from "./redis-yjs-store.js";
import {
  markdownToYjsUpdate,
  yjsUpdateToMarkdown,
} from "./yjs-markdown-conversion.js";

// Use local waitFor helper with timeout; do not add a new test utility package.
```

The assertions should prove:

```ts
assert.match(yjsUpdateToMarkdown(Y.encodeStateAsUpdate(docB)), /Updated from A/);
assert.equal(contentUpdates.length, 1);
assert.match(contentUpdates[0]?.body ?? "", /Updated from A/);
assert.equal(expirations.get(documentId), COLLABORATION_YJS_TTL_SECONDS);
```

- [ ] **Step 2: Run integration test to verify it fails**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.integration.test.ts
```

Expected: FAIL until runtime wiring and test server details are complete.

- [ ] **Step 3: Implement test server support only as needed**

Keep helpers inside `runtime.integration.test.ts` unless they are generally useful. Use injected fakes for:

- `authorizeHandshake`: always returns the same session context for test requests.
- `revalidateWrite`: returns `{ ok: true }`.
- `yjsStore`: in-memory map plus expiration map.
- `contentStore`: in-memory document load and update capture.

Do not hit a real Redis instance in this integration test. The Redis-specific behavior is already unit-tested in Task 4; this test should exercise WebSocket/Hocuspocus lifecycle behavior deterministically.

- [ ] **Step 4: Run integration test**

Run:

```bash
bun test --cwd apps/server ./src/lib/collaboration/runtime.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/collaboration/runtime.integration.test.ts
git commit -m "test(server): cover collaboration websocket lifecycle"
```

---

### Task 9: Document operator workflow and create changeset

**Files:**
- Modify: `docs/specs/SPEC-011-local-development-and-operations.md`
- Modify: `.env.example`
- Generated by CLI: `.changeset/*.md`

- [ ] **Step 1: Update ops documentation**

In `docs/specs/SPEC-011-local-development-and-operations.md`, add a standalone paragraph in the Redis/local stack section:

```md
`REDIS_URL` is required when the collaboration WebSocket runtime is enabled. Collaboration stores only ephemeral Yjs binary state in Redis under `yjs:{documentId}` keys. The server writes the final draft body back to PostgreSQL when the last collaborator disconnects, then sets the Redis Yjs key TTL to 30 minutes.
```

Keep the spec standalone. Do not mention `CMS-53`.

- [ ] **Step 2: Clarify env example if needed**

If `.env.example` currently has only `REDIS_URL=redis://redis:6379`, keep that value and add an adjacent comment only if comments already fit the file style. If the file is intentionally bare key/value lines, leave it unchanged.

- [ ] **Step 3: Run changeset CLI**

Run:

```bash
bun run changeset
```

Use a patch changeset for `@mdcms/studio` because the plan adds a public `./headless-editor` subpath export. Do not manually create or edit the generated `.changeset/*.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/SPEC-011-local-development-and-operations.md .env.example .changeset
git commit -m "docs(server): document collaboration redis cache"
```

---

### Task 10: Final verification

**Files:**
- All files changed by Tasks 1-9.

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/headless-editor.test.ts
bun test --cwd apps/server ./src/lib/env.test.ts ./src/lib/collaboration-auth.test.ts ./src/lib/collaboration
```

Expected: PASS.

- [ ] **Step 2: Run package-level tests for touched packages**

Run:

```bash
bun test --cwd packages/studio ./src
bun test --cwd apps/server ./src
```

Expected: PASS.

- [ ] **Step 3: Run workspace checks**

Run:

```bash
bun run format:check
bun run check
```

Expected: PASS.

- [ ] **Step 4: Review changed files for scope**

Run:

```bash
git status --short
git diff --stat
git diff -- apps/server packages/studio docs/specs .env.example
```

Expected:

- Only CMS-53 files are modified.
- No unrelated `.ai/plans` backlog, `.mdcms`, local content, or transcript files are staged.
- No Yjs binary state or Redis data is written to PostgreSQL schema/migrations.

- [ ] **Step 5: Final commit if any verification fixes were needed**

```bash
git add apps/server packages/studio docs/specs .env.example bun.lock .changeset
git commit -m "feat(server): add collaboration websocket cache runtime"
```

---

## Self-Review

- Spec coverage: SPEC-007 covers collaboration endpoint, Hocuspocus in-process runtime, session auth, explicit routing, write revalidation, and Redis-ephemeral Yjs state. SPEC-003 covers auto-save to the mutable `documents` row without version rows. SPEC-005 covers session-only WebSocket auth and query routing. SPEC-011 documentation is updated for operator Redis workflow.
- Acceptance criteria mapping:
  - Boot path and Redis cache behavior: Tasks 4, 6, 7, 8.
  - Markdown-to-Yjs in `onLoadDocument`: Tasks 3, 5.
  - Yjs binary only in Redis, never PostgreSQL: Tasks 4, 5 tests.
  - Last disconnect final save and 30-minute TTL: Tasks 4, 5, 8.
  - Foundational reusable behavior: Tasks 3-7 split conversion/store/hooks/runtime.
  - Public contract/operator docs: Task 9.
- Placeholder scan: no implementation step depends on unspecified files or unnamed tests.
- Risk to revisit during implementation: confirm the installed `@hocuspocus/transformer` `fromYdoc` TypeScript signature and adjust only the conversion implementation, keeping tests stable.

---

## Grill Session Addendum — Required Updates Before Execution

This addendum supersedes conflicting details in the original task list above. Implementers must follow this section when the old plan references a Studio-owned headless export, generic Redis keys, or future-only collaboration spec language.

### Spec Delta Required

- Promote the implemented transport/cache subset in `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` from future-target wording to active contract wording. Keep presence and periodic/debounced PostgreSQL autosave deferred.
- Update `docs/specs/SPEC-007-editor-mdx-and-collaboration.md` and `docs/adrs/ADR-001-backend-framework-bun-elysia.md` from `ws` polyfill wording to Hocuspocus via a Bun-compatible `crossws` bridge.
- Add active collaboration lock behavior to `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md` and `docs/specs/SPEC-007-editor-mdx-and-collaboration.md`.
- Add `cms push` locked-document behavior to `docs/specs/SPEC-008-cli-and-sdk.md`: locked documents fail per-document with reason `collaboration_active`; other documents continue.
- Add Redis/operator notes to `docs/specs/SPEC-011-local-development-and-operations.md`.
- Do not put task IDs or issue-tracker references inside specs.

### Package Boundary Update

- Replace Task 2's `packages/studio/src/lib/headless-editor.ts` approach with a new published package: `packages/editor-core`.
- Package name: `@mdcms/editor-core`.
- Ownership: reusable, non-React editor schema and conversion primitives only.
- Export Markdown parse/serialize, core TipTap schema/extensions, MDX/image nodes, and round-trip helpers from `@mdcms/editor-core`.
- Keep Studio-only decoration/interaction plugins in `@mdcms/studio`; do not move blur selection preservation or empty-paragraph hint into editor core.
- `@mdcms/studio/markdown-pipeline` remains as a compatibility wrapper around `@mdcms/editor-core`.
- `apps/server` must import editor conversion code from `@mdcms/editor-core`, never from `@mdcms/studio`.
- Create changesets for `@mdcms/editor-core` and `@mdcms/studio`.

### Redis Keys And Lifecycle

- Yjs state key: `mdcms:collaboration:yjs:{documentId}`.
- Yjs metadata key: `mdcms:collaboration:yjs-meta:{documentId}`.
- Active-room lock key: `mdcms:collaboration:active:{documentId}`.
- Metadata must include the source `draftRevision` and a body hash for the database draft used to create or last save the Yjs state.
- `onLoadDocument` may use a Redis Yjs cache hit only when metadata still matches the current PostgreSQL draft head. Otherwise rebuild Yjs state from PostgreSQL and replace Redis state/metadata.
- Clear the Yjs state/meta TTL when a room becomes active; apply the 30-minute TTL only after the last collaborator disconnects.
- Keep the active-room key separate from the Yjs cache key. The Yjs cache intentionally lives for 30 minutes after disconnect and must not be treated as an active edit lock.
- Maintain the active-room key as a heartbeat lease while clients are connected. Delete it after last-disconnect cleanup.

### Runtime And Persistence Semantics

- If `REDIS_URL` is missing or Redis cannot initialize, the server still boots. Collaboration upgrade requests fail before upgrade with HTTP `503` and JSON code `COLLABORATION_UNAVAILABLE`.
- Hocuspocus must set explicit persistence debounce values: `debounce: 2000`, `maxDebounce: 10000`.
- Use `beforeHandleMessage` for pre-apply write revalidation so revoked sessions or lost permissions cannot mutate the in-memory Yjs room.
- Also revalidate `onStoreDocument` as the spec-required write-path backstop before persisting Yjs state to Redis.
- Do not use `beforeHandleMessage` to persist Redis Yjs state; it runs before the inbound update is applied.
- `onStoreDocument` persists only Yjs binary state and metadata to Redis. It must never write Yjs binary to PostgreSQL.
- If Markdown/MDX parsing fails during `onLoadDocument`, fail room opening deterministically and do not create Redis Yjs state.
- Last-disconnect save:
  - serialize the current Y.Doc to Markdown;
  - fetch the current PostgreSQL draft head;
  - skip the DB update when serialized Markdown equals the current draft body;
  - attribute `updatedBy` to the last actual writer, not the last disconnecting user;
  - call the content update path with `expectedDraftRevision` from the room load/save metadata;
  - emit the existing `content.updated` lifecycle/webhook event when a final save changes the draft;
  - fail closed on stale revision instead of overwriting newer database content;
  - set the Yjs state/meta TTL to 30 minutes and delete the active lock.

### Active Collaboration Lock

- Existing-document mutations must fail while `mdcms:collaboration:active:{documentId}` exists:
  - update, move, restore, restore-version, publish/unpublish, delete;
  - bulk equivalents;
  - AI/module draft writes that use the server content-store surface.
- New document creation and all reads remain allowed.
- Error contract: HTTP `409`, code `DOCUMENT_COLLABORATION_ACTIVE`, details `{ documentId }`.
- `cms push` treats `DOCUMENT_COLLABORATION_ACTIVE` as a per-document failure with reason code `collaboration_active`, continues other documents, and tells the user to wait for the active Studio collaboration session to close.

### Documentation And Vocabulary

- Update `.ai/LANGUAGE.md` with collaboration terms instead of creating a root `CONTEXT.md`.
- Candidate terms: `Collaboration socket`, `Document room`, `Yjs state`, and `Active collaboration lock`.
- Update operator docs with the namespaced Redis keys and the distinction between the active-room lock and the 30-minute inactive Yjs cache.

### Test Plan Revisions

- Replace Studio headless-export tests with `@mdcms/editor-core` package tests and Studio compatibility wrapper tests.
- Add Redis metadata and active-lock tests: key shape, binary preservation, TTL clearing on active load, 30-minute TTL on last disconnect, heartbeat lease refresh, stale metadata rejection.
- Add hook tests for:
  - cache hit only when metadata matches current DB draft;
  - DB rebuild when metadata is stale;
  - parse/load failure does not create Redis state;
  - pre-apply write revalidation closes unauthorized writers;
  - `onStoreDocument` revalidation and Redis-only persistence;
  - no-op final disconnect does not increment `draftRevision`;
  - final save uses last writer and emits `content.updated`;
  - stale final-save revision fails closed.
- Add content API/module/CLI tests for `DOCUMENT_COLLABORATION_ACTIVE` and `collaboration_active`.
