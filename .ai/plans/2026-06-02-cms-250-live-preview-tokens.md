# CMS-250 Live Preview Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private live-preview support through MDCMS-minted signed preview tokens, SDK verification helpers, Studio token loading, and host integration guidance.

**Architecture:** Keep route resolution in `mdcms.config.ts`, then let Studio mint a short-lived document-bound preview token before loading the host route. Put JWT/HMAC signing and verification in pure shared helpers so the server mints tokens and the SDK verifies them without duplicating crypto; keep host integrations one-line through `@mdcms/sdk`.

**Tech Stack:** Bun, TypeScript 5.9, Elysia route mounting, Web Crypto HMAC-SHA256, Zod 4, React Studio runtime, Next.js App Router example app.

---

## File Map

- Modify `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md` to add the preview-token endpoint contract.
- Modify `docs/specs/SPEC-006-studio-runtime-and-ui.md` to describe token minting in the live-preview iframe flow.
- Create `packages/shared/src/lib/contracts/preview-token.ts` for claim types, request/response contracts, signing, verification, and token URL helpers.
- Modify `packages/shared/src/index.ts` to export the preview-token contract.
- Modify `packages/shared/src/lib/contracts/content-api.ts` to export the endpoint request and response types beside the existing content API contracts.
- Add `packages/shared/src/lib/contracts/preview-token.test.ts` for token helper tests.
- Modify `apps/server/src/lib/content-api/types.ts` to accept preview-token route options.
- Modify `apps/server/src/lib/content-api/routes.ts` to mount `POST /api/v1/content/:documentId/preview-token`.
- Modify `apps/server/src/lib/runtime-with-modules.ts` to pass the preview-token secret from parsed env into content routes.
- Modify `apps/server/src/lib/env.ts` and `apps/server/src/lib/env.test.ts` to parse `MDCMS_PREVIEW_TOKEN_SECRET`.
- Add/modify tests in `apps/server/src/lib/content-api.test.ts` for endpoint authorization, missing secret, and claim payload.
- Modify `packages/sdk/src/lib/sdk.ts` to export `verifyMdcmsPreviewRequest`, preview result types, and `getPreviewDocumentFromRequest`.
- Modify `packages/sdk/src/index.ts` if needed so the new helpers are exported from `@mdcms/sdk`.
- Add SDK tests in `packages/sdk/src/lib/sdk.test.ts`.
- Modify `packages/studio/src/lib/runtime-ui/pages/document-preview-route.ts` to carry the document id and resolved href needed for token minting.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx` to mint preview tokens before iframe load/reload and append `mdcms_preview_token`.
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx` to cover token minting and refresh behavior.
- Modify `apps/studio-example/lib/preview-routing.ts`, `apps/studio-example/lib/preview-content.ts`, and preview route tests to use token verification for private preview.
- Modify `apps/studio-example/README.md` and add/update Studio docs under `apps/docs` for integration guidance.
- Modify `skills/mdcms-studio-embed/SKILL.md`, `skills/mdcms-sdk-integration/SKILL.md`, and `skills/mdcms-content-editing/SKILL.md`.
- Run `bun run changeset` when `bun run changeset:check` reports that the published package edits are not covered.

---

### Task 1: Canonical Spec Delta

**Files:**
- Modify `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`
- Modify `docs/specs/SPEC-006-studio-runtime-and-ui.md`

- [ ] **Step 1: Add SPEC-003 endpoint contract**

Add `POST /api/v1/content/:documentId/preview-token` to the content API endpoint table with:

```text
Auth: session_or_api_key
Scope: content:read:draft
Target routing: required project_environment
Body: optional { previewUrl?: string }
Success: 200 { data: { token: string, expiresAt: string } }
Errors: MISSING_TARGET_ROUTING (400), TARGET_ROUTING_MISMATCH (400), INVALID_INPUT (400), PREVIEW_TOKEN_UNAVAILABLE (503), UNAUTHORIZED (401), FORBIDDEN (403), NOT_FOUND (404)
```

- [ ] **Step 2: Add SPEC-006 Studio flow text**

In the real-app preview section, state that Studio requests a signed preview token after resolving the preview URL, appends it as `mdcms_preview_token`, and refresh repeats token minting after draft persistence.

- [ ] **Step 3: Run spec placeholder scan**

Run:

```bash
rg -n "CMS-250|this task|TBD|TODO" docs/specs/SPEC-003-content-storage-versioning-and-migrations.md docs/specs/SPEC-006-studio-runtime-and-ui.md
```

Expected: no task IDs or placeholders in spec content.

---

### Task 2: Shared Preview Token Helpers

**Files:**
- Create `packages/shared/src/lib/contracts/preview-token.ts`
- Create `packages/shared/src/lib/contracts/preview-token.test.ts`
- Modify `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing shared tests**

Add tests that:

```ts
test("signMdcmsPreviewToken and verifyMdcmsPreviewToken round-trip document claims", async () => {
  const token = await signMdcmsPreviewToken({
    secret: "test-preview-secret",
    claims: makeClaims({ documentId: "doc-1", draftRevision: 7 }),
    now: new Date("2026-06-02T10:00:00.000Z"),
    ttlSeconds: 300,
  });

  const result = await verifyMdcmsPreviewToken(token, {
    secret: "test-preview-secret",
    now: new Date("2026-06-02T10:01:00.000Z"),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.documentId, "doc-1");
    assert.equal(result.claims.draftRevision, 7);
  }
});
```

Also cover expired, malformed, wrong secret, wrong issuer, wrong audience, and `appendMdcmsPreviewTokenToUrl`.

- [ ] **Step 2: Run shared tests red**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/preview-token.test.ts
```

Expected: fails because helper module does not exist.

- [ ] **Step 3: Implement helper module**

Implement:

```ts
export const MDCMS_PREVIEW_TOKEN_QUERY_PARAM = "mdcms_preview_token";
export const MDCMS_PREVIEW_TOKEN_ISSUER = "mdcms";
export const MDCMS_PREVIEW_TOKEN_AUDIENCE = "mdcms-preview";

export type MdcmsPreviewTokenClaims = { ... };
export type MdcmsPreviewVerificationResult = ...;
export async function signMdcmsPreviewToken(input: SignInput): Promise<{ token: string; expiresAt: string }>;
export async function verifyMdcmsPreviewToken(token: string, input: VerifyInput): Promise<MdcmsPreviewVerificationResult>;
export function appendMdcmsPreviewTokenToUrl(href: string, token: string): string;
export function readMdcmsPreviewTokenFromUrl(url: URL): string | undefined;
```

Use Web Crypto HMAC SHA-256 with base64url encoding. Do not add a JWT dependency.

- [ ] **Step 4: Export helpers and run green**

Modify `packages/shared/src/index.ts`:

```ts
export * from "./lib/contracts/preview-token.js";
```

Run the shared test command again. Expected: pass.

---

### Task 3: Server Preview Token Endpoint

**Files:**
- Modify `apps/server/src/lib/env.ts`
- Modify `apps/server/src/lib/env.test.ts`
- Modify `apps/server/src/lib/content-api/types.ts`
- Modify `apps/server/src/lib/content-api/routes.ts`
- Modify `apps/server/src/lib/runtime-with-modules.ts`
- Modify `apps/server/src/lib/content-api.test.ts`

- [ ] **Step 1: Write failing env tests**

Add tests that `parseServerEnv` trims `MDCMS_PREVIEW_TOKEN_SECRET` when present and leaves it `undefined` when absent.

- [ ] **Step 2: Run env tests red**

Run:

```bash
bun test --cwd apps/server ./src/lib/env.test.ts
```

Expected: fails because parsed env has no preview token field.

- [ ] **Step 3: Parse preview token secret**

Add optional `MDCMS_PREVIEW_TOKEN_SECRET` using the existing non-empty-string style. Keep it optional so servers without private preview can still start.

- [ ] **Step 4: Write failing content API route tests**

Add tests that:

```ts
test("preview token endpoint signs document-bound draft preview token", async () => {
  const response = await handler(new Request(
    `http://localhost/api/v1/content/${documentId}/preview-token`,
    {
      method: "POST",
      headers: { ...scopeHeaders, authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ previewUrl: "/preview/post/hello?preview=true" }),
    },
  ));

  assert.equal(response.status, 200);
  const body = await response.json();
  const verified = await verifyMdcmsPreviewToken(body.data.token, {
    secret: "test-preview-secret",
  });
  assert.equal(verified.ok, true);
});
```

Also cover missing secret (`503 PREVIEW_TOKEN_UNAVAILABLE`) and path-scoped authorization after the draft document is loaded.

- [ ] **Step 5: Run content API tests red**

Run:

```bash
bun test --cwd apps/server ./src/lib/content-api.test.ts
```

Expected: preview-token route tests fail with 404 or missing route.

- [ ] **Step 6: Implement route options and route**

Add to `MountContentApiRoutesOptions`:

```ts
previewTokenSecret?: string;
previewTokenTtlSeconds?: number;
```

Mount `POST /api/v1/content/:documentId/preview-token` before generic write routes. The route should:

1. resolve `project` and `environment`;
2. require CSRF for session-authenticated browser POSTs using the existing route protection pattern;
3. authorize `content:read:draft`;
4. load `store.getById(scope, documentId, { draft: true })`;
5. reject missing/deleted documents with `NOT_FOUND`;
6. authorize again with `documentPath`;
7. parse optional `previewUrl`;
8. return `PREVIEW_TOKEN_UNAVAILABLE` if no secret is configured;
9. sign claims from the draft document.

- [ ] **Step 7: Wire runtime env**

In `runtime-with-modules.ts`, pass:

```ts
previewTokenSecret: env.MDCMS_PREVIEW_TOKEN_SECRET
```

to `mountContentApiRoutes`.

- [ ] **Step 8: Run server tests green**

Run:

```bash
bun test --cwd apps/server ./src/lib/env.test.ts ./src/lib/content-api.test.ts
```

Expected: pass.

---

### Task 4: SDK Preview Verification API

**Files:**
- Modify `packages/sdk/src/lib/sdk.ts`
- Modify `packages/sdk/src/index.ts`
- Modify `packages/sdk/src/lib/sdk.test.ts`

- [ ] **Step 1: Write failing SDK tests**

Add tests for:

```ts
const preview = await verifyMdcmsPreviewRequest(
  new Request("http://site.test/blog?mdcms_preview_token=<valid-token>"),
  { secret: "test-preview-secret" },
);
assert.equal(preview.ok, true);
```

Add a high-level helper test asserting `getPreviewDocumentFromRequest` verifies the request and sends:

```text
GET /api/v1/content/<documentId>?locale=en&draft=true
```

- [ ] **Step 2: Run SDK tests red**

Run:

```bash
bun test --cwd packages/sdk ./src/lib/sdk.test.ts
```

Expected: fails because helpers do not exist.

- [ ] **Step 3: Implement SDK helpers**

Export:

```ts
export async function verifyMdcmsPreviewRequest(request: Request | URL | string, options: VerifyOptions): Promise<MdcmsPreviewVerificationResult>;
```

Add client method:

```ts
getPreviewDocumentFromRequest: (
  request: Request | URL | string,
  options: VerifyOptions,
) => Promise<ContentDocumentResponse>;
```

The method verifies the token, then calls `get(claims.type, { id: claims.documentId, locale: claims.locale, draft: true, project: claims.project, environment: claims.environment })`.

- [ ] **Step 4: Run SDK tests green**

Run:

```bash
bun test --cwd packages/sdk ./src/lib/sdk.test.ts
```

Expected: pass.

---

### Task 5: Studio Token Minting Before Iframe Load

**Files:**
- Modify `packages/studio/src/lib/runtime-ui/pages/document-preview-route.ts`
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Modify `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

- [ ] **Step 1: Write failing Studio tests**

Add tests that:

- ready preview panes call `POST /api/v1/content/:documentId/preview-token`;
- the iframe `src` contains `mdcms_preview_token`;
- manual refresh saves unsaved draft changes before token minting;
- token failure shows unauthorized/unavailable preview state without navigating the iframe.

- [ ] **Step 2: Run Studio tests red**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: new token tests fail because current iframe URL uses raw resolved href.

- [ ] **Step 3: Implement token load state**

Use the existing runtime request helpers for authenticated Studio API calls. Add preview-token state near the preview pane state so the pane can show loading/error/ready. When route resolution returns a href, mint a token with:

```ts
POST /api/v1/content/${document.documentId}/preview-token
body: { previewUrl: resolvedHref }
```

Append the token with the shared URL helper before setting the iframe `src`.

- [ ] **Step 4: Preserve refresh ordering**

Ensure `onPreviewRefresh` persists unsaved draft changes, then causes token minting against the new persisted draft snapshot and only then reloads the iframe.

- [ ] **Step 5: Run Studio tests green**

Run:

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

---

### Task 6: Studio Example Private Preview Route

**Files:**
- Modify `apps/studio-example/lib/preview-routing.ts`
- Modify `apps/studio-example/lib/preview-content.ts`
- Modify `apps/studio-example/app/preview/post/[slug]/page.tsx`
- Modify `apps/studio-example/app/preview/page/[...path]/page.tsx`
- Modify preview route tests under `apps/studio-example/app/preview/**`
- Modify `apps/studio-example/README.md`

- [ ] **Step 1: Write failing example tests**

Update preview route tests so requests without `mdcms_preview_token` return an unavailable/unauthorized preview state, and valid tokens render draft content.

- [ ] **Step 2: Run example tests red**

Run:

```bash
bun test --cwd apps/studio-example ./app/preview
```

Expected: fail because the routes currently render drafts with only the demo API key.

- [ ] **Step 3: Implement verification in `preview-content.ts`**

Use:

```ts
const preview = await verifyMdcmsPreviewRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});
```

Then fetch `draft: true` only when `preview.ok`. Keep `cache: "no-store"` in the SDK fetch override.

- [ ] **Step 4: Run example tests green**

Run:

```bash
bun test --cwd apps/studio-example ./app/preview
```

Expected: pass.

---

### Task 7: Docs And Skills

**Files:**
- Modify `apps/docs` Studio/SDK guide files found by `rg -n "Studio|SDK|preview|draft" apps/docs`
- Modify `skills/mdcms-studio-embed/SKILL.md`
- Modify `skills/mdcms-sdk-integration/SKILL.md`
- Modify `skills/mdcms-content-editing/SKILL.md`

- [ ] **Step 1: Update host integration docs**

Document:

- `resolvePreviewUrl(document)` returns the preview-capable host route;
- `?preview=true` is only a mode flag;
- private previews should verify `mdcms_preview_token`;
- public draft preview routes are allowed when intentionally chosen;
- draft preview routes should avoid published-page caches.

- [ ] **Step 2: Update public skills**

Add the same guidance to the Studio embed and SDK skills. In the content editing skill, clarify that draft visibility depends on host route policy.

- [ ] **Step 3: Run docs/skills scan**

Run:

```bash
rg -n "never expose|preview=true.*authorization|draft: true" apps/docs skills
```

Expected: no absolute “never expose drafts” guidance; private-preview guidance is framed as best practice.

---

### Task 8: Changeset And Verification

**Files:**
- Modify `.changeset/*.md` through the Changesets CLI if needed.

- [ ] **Step 1: Check changeset coverage**

Run:

```bash
bun run changeset:check
```

Expected: pass when the existing changeset covers published package source changes. When it fails, run `bun run changeset` and select `@mdcms/shared`, `@mdcms/sdk`, and `@mdcms/studio` for the new public preview-token APIs.

- [ ] **Step 2: Focused tests**

Run:

```bash
bun test --cwd packages/shared ./src/lib/contracts/preview-token.test.ts
bun test --cwd packages/sdk ./src/lib/sdk.test.ts
bun test --cwd apps/server ./src/lib/env.test.ts ./src/lib/content-api.test.ts
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
bun test --cwd apps/studio-example ./app/preview
```

Expected: all pass.

- [ ] **Step 3: Required gates**

Run:

```bash
bun run format:check
bun run check
bun run unit
bun run integration
```

Expected: all pass.

- [ ] **Step 4: Commit and push**

Commit in focused chunks:

```bash
git add docs/specs packages/shared apps/server packages/sdk packages/studio apps/studio-example apps/docs skills .changeset
git commit -m "feat(studio): secure live preview routes"
git push
```

Expected: PR branch updates successfully.
