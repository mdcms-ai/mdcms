# CMS-109 Editor Media Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Studio document-editor media upload from toolbar, drag/drop, and paste, inserting returned URLs into Markdown.

**Architecture:** Keep backend contracts unchanged. Add a focused Studio media upload API helper, pure Markdown insertion helpers, narrow document-page capability/upload state, and editor wrapper wiring so all upload inputs share one pipeline.

**Tech Stack:** TypeScript, React, TipTap 3, Bun test, shared `@mdcms/shared` media contracts, existing Studio auth/request helpers.

---

## File Structure

- Modify `docs/specs/SPEC-006-studio-runtime-and-ui.md`: canonical Studio editor behavior for media insertion.
- Create `.ai/research/2026-06-05-cms-109-editor-media-upload-design.md`: design record.
- Create `packages/studio/src/lib/runtime-ui/lib/media-upload-api.ts`: Studio upload client for `POST /api/v1/media/upload`.
- Create `packages/studio/src/lib/runtime-ui/lib/media-upload-api.test.ts`: request/response/error tests.
- Create `packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.ts`: pure URL-to-Markdown formatting and parsed insert content helpers.
- Create `packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts`: pure helper tests.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`: derive `canUploadMedia`.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`: state/static render assertions.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`: instantiate upload API and pass media upload state to `TipTapEditor`.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`: toolbar file input, paste/drop collection, upload status/error rendering, Markdown insertion.
- Modify `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts`: editor interaction/static coverage.
- Add a changeset for `@mdcms/studio` with `bun run changeset`.

## Task 1: Media Upload API Helper

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/lib/media-upload-api.ts`
- Create: `packages/studio/src/lib/runtime-ui/lib/media-upload-api.test.ts`

- [x] **Step 1: Write failing API tests**

Add tests covering cookie upload, API-key upload, missing CSRF, route errors, and invalid responses:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { RuntimeError, type MediaAsset } from "@mdcms/shared";

import { createStudioMediaUploadApi } from "./media-upload-api.js";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

const asset: MediaAsset = {
  id: "asset-1",
  project: "test-project",
  filename: "hero.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  url: "https://cdn.example.com/hero.png",
  uploadedBy: "user-1",
  uploadedAt: "2026-06-05T12:00:00.000Z",
};

function createFile(name = "hero.png", type = "image/png") {
  return new File(["image-bytes"], name, { type });
}

function readHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function createApi(fetcher: typeof fetch, csrfToken: string | null = "csrf") {
  return createStudioMediaUploadApi(
    {
      project: "test-project",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    {
      auth: { mode: "cookie" },
      csrfToken,
      fetcher,
    },
  );
}

test("upload sends multipart file with target routing and csrf", async () => {
  const calls: FetchCall[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ data: asset }), { status: 200 });
  }) as typeof fetch;
  const result = await createApi(fetcher).upload(createFile());

  assert.deepEqual(result, asset);
  assert.equal(String(calls[0]?.input), "http://localhost:4000/api/v1/media/upload");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-project"), "test-project");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-environment"), "production");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), "csrf");
  assert.ok(calls[0]?.init?.body instanceof FormData);
  const uploadedFile = (calls[0]?.init?.body as FormData).get("file");
  assert.ok(uploadedFile instanceof File);
  assert.equal(uploadedFile.name, "hero.png");
  assert.equal(uploadedFile.type, "image/png");
});

test("upload allows token auth without csrf", async () => {
  const calls: FetchCall[] = [];
  const fetcher = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ data: asset }), { status: 200 });
  }) as typeof fetch;
  const api = createStudioMediaUploadApi(
    {
      project: "test-project",
      environment: "production",
      serverUrl: "http://localhost:4000",
    },
    { auth: { mode: "token", token: "mdcms_key_test" }, fetcher },
  );

  await api.upload(createFile());

  assert.equal(readHeader(calls[0]?.init, "authorization"), "Bearer mdcms_key_test");
  assert.equal(readHeader(calls[0]?.init, "x-mdcms-csrf-token"), null);
});

test("upload rejects missing csrf for cookie auth", async () => {
  await assert.rejects(
    () => createApi(fetch as typeof fetch, null).upload(createFile()),
    (error) => error instanceof RuntimeError && error.code === "CSRF_TOKEN_MISSING",
  );
});

test("upload surfaces route errors and invalid responses", async () => {
  const failed = createApi((async () =>
    new Response(
      JSON.stringify({
        code: "MEDIA_UPLOAD_TOO_LARGE",
        message: "Image upload exceeds limit.",
        details: { limitBytes: 10, sizeBytes: 20 },
      }),
      { status: 413 },
    )) as typeof fetch);

  await assert.rejects(
    () => failed.upload(createFile()),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_UPLOAD_TOO_LARGE" &&
      error.statusCode === 413,
  );

  const invalid = createApi((async () =>
    new Response(JSON.stringify({ data: { id: "missing-fields" } }), {
      status: 200,
    })) as typeof fetch);

  await assert.rejects(
    () => invalid.upload(createFile()),
    (error) =>
      error instanceof RuntimeError &&
      error.code === "MEDIA_UPLOAD_RESPONSE_INVALID",
  );
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-upload-api.test.ts
```

Expected: fails because `media-upload-api.ts` does not exist.

- [x] **Step 3: Implement the API helper**

Implement:

```ts
import {
  assertMediaAssetResponse,
  RuntimeError,
  type MediaAsset,
} from "@mdcms/shared";

import {
  applyStudioAuthToRequestInit,
  type StudioRuntimeAuth,
} from "../../request-auth.js";
import { resolveStudioRelativeUrl } from "../../url-resolution.js";

export type StudioMediaUploadApiConfig = {
  project: string;
  environment: string;
  serverUrl: string;
};

export type StudioMediaUploadApiOptions = {
  auth?: StudioRuntimeAuth;
  csrfToken?: string | null;
  fetcher?: typeof fetch;
};

export type StudioMediaUploadApi = {
  upload: (file: File) => Promise<MediaAsset>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function createScopedHeaders(
  config: StudioMediaUploadApiConfig,
  extra?: Record<string, string | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-mdcms-project": config.project,
    "x-mdcms-environment": config.environment,
  };

  for (const [name, value] of Object.entries(extra ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      headers[name] = value;
    }
  }

  return headers;
}

function requireMutationCsrfToken(
  options: StudioMediaUploadApiOptions,
): string | undefined {
  if (options.auth?.mode === "token") {
    return undefined;
  }

  const csrfToken = options.csrfToken?.trim();

  if (!csrfToken) {
    throw new RuntimeError({
      code: "CSRF_TOKEN_MISSING",
      message: "CSRF token is not available. You must be authenticated.",
      statusCode: 0,
    });
  }

  return csrfToken;
}

function toRouteFailureError(
  response: Response,
  payload: unknown,
): RuntimeError {
  const parsed = isRecord(payload) ? payload : {};
  const code =
    typeof parsed.code === "string" && parsed.code.trim().length > 0
      ? parsed.code
      : "MEDIA_UPLOAD_REQUEST_FAILED";
  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : "Media upload request failed.";

  return new RuntimeError({
    code,
    message,
    statusCode: response.status,
    details: { operation: "POST /api/v1/media/upload", payload },
  });
}

export function createStudioMediaUploadApi(
  config: StudioMediaUploadApiConfig,
  options: StudioMediaUploadApiOptions = {},
): StudioMediaUploadApi {
  const fetcher = options.fetcher ?? fetch;

  return {
    async upload(file) {
      const csrfToken = requireMutationCsrfToken(options);
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetcher(
        resolveStudioRelativeUrl("/api/v1/media/upload", config.serverUrl),
        applyStudioAuthToRequestInit(options.auth, {
          method: "POST",
          headers: createScopedHeaders(config, {
            "x-mdcms-csrf-token": csrfToken,
          }),
          body: formData,
        }),
      );
      const payload = await readResponsePayload(response);

      if (!response.ok) {
        throw toRouteFailureError(response, payload);
      }

      try {
        assertMediaAssetResponse(payload);
      } catch {
        throw new RuntimeError({
          code: "MEDIA_UPLOAD_RESPONSE_INVALID",
          message: "Media upload response is invalid.",
          statusCode: 500,
          details: { operation: "POST /api/v1/media/upload", payload },
        });
      }

      return payload.data;
    },
  };
}
```

- [x] **Step 4: Run tests to verify pass**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-upload-api.test.ts
```

Expected: all tests pass. Fix the `FormData` assertion if needed by reading the actual `file` entry rather than comparing constructors.

## Task 2: Markdown Insertion Helpers

**Files:**
- Create: `packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.ts`
- Create: `packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts`

- [x] **Step 1: Write failing pure tests**

Test image syntax, link syntax, bracket escaping, and batch joining:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MediaAsset } from "@mdcms/shared";

import {
  createMediaAssetsMarkdown,
  formatMediaAssetMarkdown,
} from "./media-markdown-insertion.js";

function asset(input: Partial<MediaAsset>): MediaAsset {
  return {
    id: "asset-1",
    project: "test-project",
    filename: "hero.png",
    mimeType: "image/png",
    sizeBytes: 1,
    url: "https://cdn.example.com/hero.png",
    uploadedBy: "user-1",
    uploadedAt: "2026-06-05T12:00:00.000Z",
    ...input,
  };
}

test("formatMediaAssetMarkdown inserts image syntax for image mime types", () => {
  assert.equal(
    formatMediaAssetMarkdown(asset({ filename: "Hero [draft].png" })),
    "![Hero \\[draft\\].png](https://cdn.example.com/hero.png)",
  );
});

test("formatMediaAssetMarkdown inserts link syntax for non-images", () => {
  assert.equal(
    formatMediaAssetMarkdown(
      asset({
        filename: "brief.pdf",
        mimeType: "application/pdf",
        url: "https://cdn.example.com/brief.pdf",
      }),
    ),
    "[brief.pdf](https://cdn.example.com/brief.pdf)",
  );
});

test("createMediaAssetsMarkdown joins multiple references with blank lines", () => {
  assert.equal(
    createMediaAssetsMarkdown([
      asset({ filename: "hero.png" }),
      asset({
        filename: "brief.pdf",
        mimeType: "application/pdf",
        url: "https://cdn.example.com/brief.pdf",
      }),
    ]),
    "![hero.png](https://cdn.example.com/hero.png)\\n\\n[brief.pdf](https://cdn.example.com/brief.pdf)",
  );
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts
```

Expected: fails because helper file does not exist.

- [x] **Step 3: Implement helpers**

Implement:

```ts
import type { JSONContent } from "@tiptap/core";
import type { MediaAsset } from "@mdcms/shared";

import { parseMarkdownToDocument } from "../../../markdown-pipeline.js";

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\\]\\\\])/g, "\\\\$1");
}

function resolveAssetLabel(asset: MediaAsset): string {
  const filename = asset.filename.trim();
  return escapeMarkdownLabel(filename.length > 0 ? filename : "media");
}

export function formatMediaAssetMarkdown(asset: MediaAsset): string {
  const label = resolveAssetLabel(asset);

  if (asset.mimeType.startsWith("image/")) {
    return `![${label}](${asset.url})`;
  }

  return `[${label}](${asset.url})`;
}

export function createMediaAssetsMarkdown(
  assets: readonly MediaAsset[],
): string {
  return assets.map(formatMediaAssetMarkdown).join("\\n\\n");
}

export function createMediaAssetsInsertContent(
  assets: readonly MediaAsset[],
): JSONContent[] {
  const document = parseMarkdownToDocument(createMediaAssetsMarkdown(assets));
  return document.content ?? [];
}
```

- [x] **Step 4: Run tests to verify pass**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts
```

Expected: all helper tests pass.

## Task 3: Capability State

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

- [x] **Step 1: Write failing state tests**

Add tests near existing `canWrite`/schema capability tests:

```ts
test("create ready state exposes media upload capability from schema state", async () => {
  const state = await loadReadyStateWithCapabilities({
    content: { write: true },
    media: { upload: true },
  });

  assert.equal(state.canWrite, true);
  assert.equal(state.canUploadMedia, true);
});

test("schema guard refresh revokes media upload capability", () => {
  const state = createReadyStateFixture({
    canWrite: true,
    canUploadMedia: true,
  });
  const next = applySchemaStateToReadyState({
    state,
    schemaState: createSchemaReadyStateFixture({
      capabilities: {
        ...createFullCapabilities(),
        media: { read: true, upload: false, delete: false },
      },
    }),
  });

  assert.equal(next.canUploadMedia, false);
});
```

Use existing fixture helpers in `content-document-page.test.tsx`; if names differ, mirror the local test style rather than introducing global fixtures.

- [x] **Step 2: Run focused tests to verify failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: fails because `canUploadMedia` is missing.

- [x] **Step 3: Implement state derivation**

Add to `ContentDocumentPageReadyState`:

```ts
canUploadMedia: boolean;
```

Add helper:

```ts
function resolveContentDocumentMediaUploadCapability(input: {
  schemaState?: StudioSchemaState;
}): boolean {
  const schemaState = input.schemaState;

  if (!schemaState || schemaState.status !== "ready") {
    return false;
  }

  return schemaState.capabilities.media.upload === true;
}
```

Set `canUploadMedia` in `createReadyState` and `applySchemaStateToReadyState` from that helper.

- [x] **Step 4: Run tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass after adjusting fixtures to include default `canUploadMedia: true` where needed.

## Task 4: Document Page Upload Controller

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Test: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

- [x] **Step 1: Add failing static render tests**

Assert that the editor receives enabled/disabled upload states through rendered copy:

```ts
test("ContentDocumentPageView enables media upload only with write and media capability", () => {
  const markup = renderContentDocumentPageView({
    state: createReadyStateFixture({
      canWrite: true,
      canUploadMedia: true,
    }),
  });

  assert.match(markup, /Upload media/);
  assert.doesNotMatch(markup, /Media upload unavailable/);
});

test("ContentDocumentPageView disables media upload without media capability", () => {
  const markup = renderContentDocumentPageView({
    state: createReadyStateFixture({
      canWrite: true,
      canUploadMedia: false,
    }),
  });

  assert.match(markup, /Upload media unavailable in this target/);
});
```

Use existing render helpers and exact copy from Task 5 once implemented.

- [x] **Step 2: Run focused page tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: fails because no media upload state is rendered.

- [x] **Step 3: Wire upload API state**

Import `createStudioMediaUploadApi`, derive `csrfToken` from the Studio session context already available to the admin tree, and build:

```ts
const mediaUpload = {
  canUpload:
    state.status === "ready" &&
    state.canWrite &&
    !state.viewingVersion &&
    state.canUploadMedia,
  isUploading: mediaUploadState.status === "uploading",
  errorMessage: mediaUploadState.errorMessage,
  uploadFiles: async (files: File[]) => {
    if (!mediaUploadApi) {
      throw new Error("Media upload API is unavailable.");
    }
    setMediaUploadState({ status: "uploading" });
    try {
      const assets = [];
      for (const file of files) {
        assets.push(await mediaUploadApi.upload(file));
      }
      setMediaUploadState({ status: "idle" });
      return assets;
    } catch (error) {
      const message = formatMediaUploadError(error);
      setMediaUploadState({ status: "error", errorMessage: message });
      throw error;
    }
  },
};
```

If the existing page does not expose session context here, pass `csrfToken` down from the admin layout or reuse the established hook/context used by CMS-107 (`useStudioSession`).

- [x] **Step 4: Run focused page tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: page tests pass.

## Task 5: TipTap Editor Upload UX

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts`

- [x] **Step 1: Write failing editor tests**

Add coverage for toolbar disabled copy and insertion helper invocation:

```ts
test("TipTapEditor renders media upload affordance and read-only unavailable copy", () => {
  const enabled = renderToStaticMarkup(
    <TipTapEditor
      initialContent="Hello"
      mediaUpload={{
        canUpload: true,
        isUploading: false,
        uploadFiles: async () => [],
      }}
    />,
  );
  assert.match(enabled, /Upload media/);
  assert.match(enabled, /No file-type allowlist/);

  const disabled = renderToStaticMarkup(
    <TipTapEditor
      initialContent="Hello"
      readOnly
      mediaUpload={{
        canUpload: false,
        isUploading: false,
        uploadFiles: async () => [],
        unavailableMessage: "Upload media unavailable in this target.",
      }}
    />,
  );
  assert.match(disabled, /Upload media unavailable in this target/);
});
```

If full `TipTapEditor` static rendering is not supported by the existing tests, extract a tiny `MediaUploadStatus` component from the editor and test that component directly.

- [x] **Step 2: Run editor tests to verify failure**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts
```

Expected: fails because the editor prop/UI is missing.

- [x] **Step 3: Implement editor prop and UI**

Add types:

```ts
export type TipTapEditorMediaUploadState = {
  canUpload: boolean;
  isUploading: boolean;
  errorMessage?: string;
  unavailableMessage?: string;
  uploadFiles: (files: File[]) => Promise<MediaAsset[]>;
};
```

Add a hidden file input ref, media status region, and image toolbar special case:

```tsx
const mediaInputRef = useRef<HTMLInputElement | null>(null);

const uploadMediaFiles = async (
  files: readonly File[],
  position?: number,
) => {
  if (!editor || isEditorReadOnly || !mediaUpload?.canUpload || files.length === 0) {
    return;
  }

  const assets = await mediaUpload.uploadFiles([...files]);
  const content = createMediaAssetsInsertContent(assets);
  const didInsert =
    typeof position === "number"
      ? editor.commands.insertContentAt(position, content)
      : editor.commands.insertContent(content);

  if (didInsert) {
    handleEditorUpdate(editor);
  }
};
```

Use `view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos` for drops. Collect files from `event.dataTransfer.files` and `event.clipboardData.files`.

Render:

```tsx
<input
  ref={mediaInputRef}
  type="file"
  multiple
  className="sr-only"
  aria-label="Upload media"
  onChange={(event) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void uploadMediaFiles(files);
  }}
/>
```

For the image toolbar item, call `mediaInputRef.current?.click()` instead of a TipTap formatting command.

Render status near the canvas:

```tsx
{mediaUpload?.isUploading ? (
  <div role="status" aria-live="polite">Uploading media...</div>
) : null}
{mediaUpload?.errorMessage ? (
  <div role="alert" aria-live="assertive">{mediaUpload.errorMessage}</div>
) : null}
<p className="sr-only">
  No file-type allowlist is enforced. Image upload limits apply only when the
  uploaded MIME type starts with image/.
</p>
```

- [x] **Step 4: Run editor tests**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts
```

Expected: pass.

## Task 6: Full Verification, Review, Changeset, Commit

**Files:**
- Add generated `.changeset/*.md`
- Commit all CMS-109 files

- [x] **Step 1: Run focused tests**

Run:

```bash
bun test --cwd packages/studio \
  ./src/lib/runtime-ui/lib/media-upload-api.test.ts \
  ./src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts \
  ./src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts \
  ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: all focused tests pass.

- [x] **Step 2: Run package typecheck**

Run:

```bash
bun nx run studio:typecheck
```

Expected: typecheck passes.

- [x] **Step 3: Run full gates**

Run:

```bash
bun run format:check
bun run check
git diff --check
```

Expected: all exit 0.

- [x] **Step 4: Create changeset**

Run:

```bash
bun run changeset
```

Select `@mdcms/studio`, patch bump, summary:

```text
Add Studio editor media upload insertion.
```

- [x] **Step 5: Request subagent review**

Dispatch two read-only subagents:

- Spec/acceptance reviewer: check CMS-109 acceptance against `SPEC-006` and `SPEC-010`.
- Code/accessibility reviewer: check upload UI states, role gating, draft integrity, and tests.

Fix blockers and rerun impacted tests plus the final gates.

- [x] **Step 6: Commit**

Run:

```bash
git add docs/specs/SPEC-006-studio-runtime-and-ui.md \
  .ai/research/2026-06-05-cms-109-editor-media-upload-design.md \
  .ai/plans/2026-06-05-cms-109-editor-media-upload.md \
  packages/studio/src/lib/runtime-ui/lib/media-upload-api.ts \
  packages/studio/src/lib/runtime-ui/lib/media-upload-api.test.ts \
  packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.ts \
  packages/studio/src/lib/runtime-ui/components/editor/media-markdown-insertion.test.ts \
  packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts \
  packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx \
  packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx \
  packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor.tsx \
  packages/studio/src/lib/runtime-ui/components/editor/tiptap-editor-lifecycle.test.ts \
  .changeset/<generated-file>.md
git commit -m "feat(studio): add editor media uploads"
```

Expected: focused CMS-109 commit on `feat/media-management`.

## Plan Self-Review

- Spec coverage: tasks cover upload inputs, endpoint request shape, image/link
  Markdown insertion, capability gating, primary/edge UI states, tests, and
  changeset.
- Placeholder scan: no TBD/TODO placeholders remain. The only generated path is
  the changeset filename, which cannot be known before `bun run changeset`.
- Type consistency: `canUploadMedia`, `StudioMediaUploadApi`, and
  `TipTapEditorMediaUploadState` are defined before use.
- Scope check: media library browse/search, tagging, asset replacement, and
  visual image node rendering stay out of this ticket.
