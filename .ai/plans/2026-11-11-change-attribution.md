# Change Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every content change records the real user from authentication and the client it came through, and Studio shows both in version history and document info.

**Architecture:** A shared `ContentChangeOrigin` contract in `@mdcms/shared`. The server derives a `ContentWriteAttribution` (`{ actorId, origin }`) from the authorized request and passes it as a required argument to every content store write, so no write path can fall back to a placeholder actor silently. The store persists the actor and origin; responses, webhooks and Studio read them back.

**Tech Stack:** Bun, TypeScript (strict, nodenext), Zod 4, Drizzle ORM + Postgres 16, Elysia, React (Studio), TanStack Query.

**Design:** `.ai/research/2026-11-11-mcp-and-shared-tools-design.md`, section "Sub-project 1: change attribution".

---

## Conventions for every task

- Work in the worktree on branch `feat/cli-mcp-server`.
- Run commands from the repository root unless a step says otherwise.
- Commit as the configured Git author. No co-author or generated-by lines. No em dashes anywhere.
- Commit messages and comments describe current behavior and why, for readers who have not seen this plan.
- `bun run format` before each commit; `bun run format:check` must pass.
- Database tests (`testWithDatabase`) skip when Postgres is not reachable. Before Task 3, start infrastructure: `docker compose up -d postgres redis minio minio-init mailhog` and export `DATABASE_URL=postgresql://mdcms:mdcms@localhost:5432/mdcms`. Check `apps/server/src/lib/content-api-test-support.ts` (`dbEnv`) for the exact variables the tests read.

## File map

| File | Responsibility |
| --- | --- |
| `packages/shared/src/lib/contracts/content-change-origin.ts` (new) | Origin contract, schema, header name, declared-client parsing, display label |
| `packages/shared/src/lib/contracts/content-change-origin.test.ts` (new) | Tests for the above |
| `packages/shared/src/lib/contracts/content-api.ts` | Optional origin fields on document and version responses |
| `packages/shared/src/lib/contracts/webhooks.ts` | Optional `origin` on content webhook payloads |
| `packages/shared/src/index.ts` | Export the new module |
| `docs/specs/SPEC-003-…`, `SPEC-005-…`, `SPEC-007-…`, `SPEC-010-…`, `SPEC-014-…` | Spec deltas |
| `apps/server/src/lib/db/schema.ts` + new migration in `apps/server/drizzle/` | Column types and origin columns |
| `apps/server/src/lib/db/schema.contract.test.ts` | Column assertions |
| `apps/server/src/lib/content-api/attribution.ts` (new) | Attribution from an authorized request; system attribution |
| `apps/server/src/lib/content-api/attribution.test.ts` (new) | Tests for the above |
| `apps/server/src/lib/content-api/types.ts` | Store write signatures take attribution |
| `apps/server/src/lib/content-api/responses.ts` | Row mappers include origins |
| `apps/server/src/lib/content-api/database-store.ts` | Persist actor and origin |
| `apps/server/src/lib/content-api/in-memory-store.ts` | Same, in memory |
| `apps/server/src/lib/content-api/lifecycle-events.ts` | Committer hands attribution to the mutation |
| `apps/server/src/lib/content-api/routes.ts` | Every write passes attribution; users map on single GET and versions |
| `apps/server/src/lib/collaboration/runtime.ts` | Collaboration writes use the writer's real id |
| `apps/server/src/lib/webhooks/dispatcher.ts` | Webhook `origin` |
| `packages/modules/core.ai/src/server/apply.ts`, `routes.ts` | Assistant apply and undo pass attribution |
| `apps/server/src/lib/runtime-with-modules.ts` | Host wiring for the Assistant's attribution |
| `apps/server/src/bin/demo-seed-api-key.ts` | Seed uses system attribution |
| `apps/cli/src/lib/client-header.ts` (new) + `framework.ts` | CLI sends `X-MDCMS-Client: cli/<version>` |
| `packages/studio/src/lib/document-route-api.ts` | Parse origins and user maps |
| `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`, `content-document-page.tsx` | History author and channel; Info tab last edit |
| `apps/docs/api-reference/*.mdx`, `.ai/LANGUAGE.md`, `.ai/memory/*` | Documentation |

---

### Task 1: Spec deltas

Spec-first: the owning specs change before code.

**Files:**
- Modify: `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`
- Modify: `docs/specs/SPEC-005-auth-authorization-and-request-routing.md`
- Modify: `docs/specs/SPEC-007-*.md` (collaboration spec; find with `ls docs/specs | grep 007`)
- Modify: `docs/specs/SPEC-010-*.md` (webhooks)
- Modify: `docs/specs/SPEC-014-ai-assisted-studio-editing.md`

- [ ] **Step 1: SPEC-003 table definitions.** In the `documents` table block change `created_by UUID NOT NULL` and `updated_by UUID NOT NULL` to `TEXT NOT NULL` with the same comments, and add after each:

```sql
    created_origin  JSONB,                   -- Change origin of the creating write (see "Change Attribution")
    updated_origin  JSONB,                   -- Change origin of the last write (see "Change Attribution")
```

In the `document_versions` block change `published_by UUID NOT NULL` to `TEXT NOT NULL` and add `published_origin JSONB, -- Change origin of the publish`.

- [ ] **Step 2: SPEC-003 new section "Change Attribution"**, placed before "Version History":

```markdown
### Change Attribution

Every content write records an actor and a change origin. The server derives
both from the authenticated request; request bodies cannot set them.

- Actor: the session user for session requests, and the user who created the
  API key for API-key requests.
- Change origin (`ContentChangeOrigin`):

| Field           | Values                                        | Meaning                                                                                   |
| --------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `channel`       | `studio`, `studio_ai`, `mcp`, `api`, `system` | How the change reached the server. Set by the server.                                     |
| `credential`    | `session`, `api_key`, `oauth`, `system`       | The credential that authorized the change. Set by the server.                             |
| `apiKeyId`      | string                                        | Present when `credential` is `api_key`.                                                   |
| `oauthClientId` | string                                        | Present when `credential` is `oauth`.                                                     |
| `declared`      | string, 1 to 120 printable ASCII characters   | Client name and version reported by the client. Informational; not verified by the server. |

- `channel` is `studio` for session requests to the content API and for
  collaboration autosave and publish, `studio_ai` for applying and undoing
  Studio AI proposals, `mcp` for tool calls through the MCP endpoint, `api` for
  other API-key requests, and `system` for server-internal writes such as
  seeding.
- `declared` comes from the `X-MDCMS-Client` request header (SPEC-005). A
  missing, empty, longer than 120 characters, or non-printable value is
  ignored; the request still succeeds.
- Where it is stored: `documents.created_by` / `created_origin` on create,
  `documents.updated_by` / `updated_origin` on every write, and
  `document_versions.published_by` / `published_origin` on publish and on
  version restore with `targetStatus=published`.
- Rows written before attribution existed keep their stored actor and have no
  origin. Clients show them as unknown.
- Legacy actor fields in request bodies (`createdBy`, `updatedBy`, `actorId`)
  are accepted for compatibility and ignored.
```

- [ ] **Step 3: SPEC-003 response contracts.** Add to `ContentDocumentResponse`:

```ts
  createdOrigin?: ContentChangeOrigin;
  updatedOrigin?: ContentChangeOrigin;
```

and to the version summary response type:

```ts
  publishedOrigin?: ContentChangeOrigin;
```

- [ ] **Step 4: SPEC-003 user summary sidecar.** In "User Summary Sidecar", state that the sidecar is returned by the content list, by `GET /api/v1/content/:documentId`, and by `GET /api/v1/content/:documentId/versions` (keys: `createdBy`/`updatedBy` for documents, `publishedBy` for versions), and that it is best-effort and omitted when lookup fails.

- [ ] **Step 5: SPEC-003 payload notes.** Where the create payload lists "optional actor fields", where publish lists `{ changeSummary?, actorId? }`, unpublish `{ actorId? }`, bulk `actorId`, and version restore `actorId`: mark them "accepted and ignored; see Change Attribution". In the endpoint table rows for publish, unpublish and version restore, replace `actorId?` with `actorId?` (ignored). In "Duplication", keep the rule that the actor comes from the authenticated request and add that the origin does too. In "Version History", keep "Who made the change (`published_by`)" and add "and through which channel (`published_origin`)".

- [ ] **Step 6: SPEC-005.** Add a subsection under request headers / routing:

```markdown
### Client Identification Header

Clients may send `X-MDCMS-Client: <name>/<version>` (for example
`cli/0.4.0`) on any request. The value is recorded as the `declared` part of
the change origin for content writes (SPEC-003 "Change Attribution"). It is
informational, never used for authorization, and ignored when it is empty,
longer than 120 characters, or contains characters outside printable ASCII.
The MDCMS CLI sends it on every request to the configured server.
```

Also add to the CORS allowed request headers list, if SPEC-005 enumerates them, `X-MDCMS-Client`. Add a sentence in the API key section: "Content writes made with an API key are attributed to the key's creator, with the key id in the change origin."

- [ ] **Step 7: SPEC-007.** In the autosave and publish sections, state that collaboration writes record the writer's user id as the actor with change origin `{ channel: "studio", credential: "session" }`.

- [ ] **Step 8: SPEC-010.** In the content webhook payload definition add `origin?: ContentChangeOrigin` with: "The change origin of the write that caused the event (SPEC-003 'Change Attribution'). Absent for documents last written before attribution existed."

- [ ] **Step 9: SPEC-014.** In "Apply rules" add: "Applying and undoing a proposal through the apply endpoints records the accepting user as the actor with change origin `{ channel: "studio_ai", credential: <caller credential> }`." In the collaboration section add: "A proposal applied in the browser while a collaboration room is open reaches the server as a collaborative edit and is recorded with channel `studio`."

- [ ] **Step 10: Check and commit**

Run: `bun run format && bun run format:check`
Expected: `All matched files use Prettier code style!`

```bash
git add docs/specs
git commit -m "docs(specs): specify change attribution and the client header"
```

---

### Task 2: Shared origin contract

**Files:**
- Create: `packages/shared/src/lib/contracts/content-change-origin.ts`
- Create: `packages/shared/src/lib/contracts/content-change-origin.test.ts`
- Modify: `packages/shared/src/lib/contracts/content-api.ts`
- Modify: `packages/shared/src/lib/contracts/webhooks.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test** `packages/shared/src/lib/contracts/content-change-origin.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  DECLARED_CLIENT_MAX_LENGTH,
  formatContentChangeOrigin,
  parseContentChangeOrigin,
  parseDeclaredClient,
} from "./content-change-origin.js";

test("parseDeclaredClient trims and accepts printable ASCII", () => {
  assert.equal(parseDeclaredClient("  cli/0.4.0 "), "cli/0.4.0");
  assert.equal(parseDeclaredClient("claude-code 1.2"), "claude-code 1.2");
});

test("parseDeclaredClient ignores missing, empty, long and non-printable values", () => {
  assert.equal(parseDeclaredClient(null), undefined);
  assert.equal(parseDeclaredClient(undefined), undefined);
  assert.equal(parseDeclaredClient("   "), undefined);
  assert.equal(
    parseDeclaredClient("x".repeat(DECLARED_CLIENT_MAX_LENGTH + 1)),
    undefined,
  );
  assert.equal(parseDeclaredClient("cli\u0007"), undefined);
  assert.equal(parseDeclaredClient("klient/1 ż"), undefined);
});

test("parseContentChangeOrigin accepts a valid origin and rejects others", () => {
  assert.deepEqual(
    parseContentChangeOrigin({
      channel: "api",
      credential: "api_key",
      apiKeyId: "key-1",
      declared: "cli/0.4.0",
    }),
    {
      channel: "api",
      credential: "api_key",
      apiKeyId: "key-1",
      declared: "cli/0.4.0",
    },
  );
  assert.equal(parseContentChangeOrigin(null), undefined);
  assert.equal(
    parseContentChangeOrigin({ channel: "fax", credential: "session" }),
    undefined,
  );
});

test("formatContentChangeOrigin labels channels and appends the declared name", () => {
  assert.equal(
    formatContentChangeOrigin({ channel: "studio", credential: "session" }),
    "Studio",
  );
  assert.equal(
    formatContentChangeOrigin({ channel: "studio_ai", credential: "session" }),
    "Studio AI",
  );
  assert.equal(
    formatContentChangeOrigin({
      channel: "mcp",
      credential: "oauth",
      oauthClientId: "client-1",
      declared: "claude-code 1.2",
    }),
    "MCP (claude-code 1.2)",
  );
  assert.equal(
    formatContentChangeOrigin({ channel: "system", credential: "system" }),
    "System",
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --cwd packages/shared ./src/lib/contracts/content-change-origin.test.ts`
Expected: FAIL, cannot find module `./content-change-origin.js`.

- [ ] **Step 3: Implement** `packages/shared/src/lib/contracts/content-change-origin.ts`:

```ts
import { z } from "zod";

/** Request header a client uses to report its name and version. */
export const MDCMS_CLIENT_HEADER = "x-mdcms-client";

export const DECLARED_CLIENT_MAX_LENGTH = 120;

export const CONTENT_CHANGE_CHANNELS = [
  "studio",
  "studio_ai",
  "mcp",
  "api",
  "system",
] as const;

export type ContentChangeChannel = (typeof CONTENT_CHANGE_CHANNELS)[number];

export const CONTENT_CHANGE_CREDENTIALS = [
  "session",
  "api_key",
  "oauth",
  "system",
] as const;

export type ContentChangeCredential =
  (typeof CONTENT_CHANGE_CREDENTIALS)[number];

export const ContentChangeOriginSchema = z.object({
  channel: z.enum(CONTENT_CHANGE_CHANNELS),
  credential: z.enum(CONTENT_CHANGE_CREDENTIALS),
  apiKeyId: z.string().min(1).optional(),
  oauthClientId: z.string().min(1).optional(),
  declared: z.string().min(1).max(DECLARED_CLIENT_MAX_LENGTH).optional(),
});

/**
 * How a content change reached the server. `channel` and `credential` are
 * set by the server; `declared` is whatever the client reported about
 * itself and is shown as reported, never trusted.
 */
export type ContentChangeOrigin = z.infer<typeof ContentChangeOriginSchema>;

/** The actor and origin a content write is recorded with. */
export type ContentWriteAttribution = {
  actorId: string;
  origin: ContentChangeOrigin;
};

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/**
 * Normalizes a client-reported name. Invalid values are dropped rather than
 * rejected so a malformed header never fails the request it rides on.
 */
export function parseDeclaredClient(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  if (
    trimmed.length === 0 ||
    trimmed.length > DECLARED_CLIENT_MAX_LENGTH ||
    !PRINTABLE_ASCII.test(trimmed)
  ) {
    return undefined;
  }

  return trimmed;
}

export function parseContentChangeOrigin(
  value: unknown,
): ContentChangeOrigin | undefined {
  const parsed = ContentChangeOriginSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

const CHANNEL_LABELS: Record<ContentChangeChannel, string> = {
  studio: "Studio",
  studio_ai: "Studio AI",
  mcp: "MCP",
  api: "API",
  system: "System",
};

export function formatContentChangeOrigin(origin: ContentChangeOrigin): string {
  const label = CHANNEL_LABELS[origin.channel];

  return origin.declared ? `${label} (${origin.declared})` : label;
}
```

- [ ] **Step 4: Export it.** In `packages/shared/src/index.ts`, next to the `content-api.js` export, add:

```ts
export * from "./lib/contracts/content-change-origin.js";
```

- [ ] **Step 5: Optional fields on responses.** In `packages/shared/src/lib/contracts/content-api.ts` add at the top:

```ts
import type { ContentChangeOrigin } from "./content-change-origin.js";
```

In `ContentDocumentResponse`, after `createdBy: string;` add `createdOrigin?: ContentChangeOrigin;`, and after `updatedBy: string;` add `updatedOrigin?: ContentChangeOrigin;`. In `ContentVersionSummaryResponse`, after `publishedBy: string;` add `publishedOrigin?: ContentChangeOrigin;`.

In `packages/shared/src/lib/contracts/webhooks.ts` import the type the same way and add to `WebhookContentPayload` after `user`:

```ts
  /** Change origin of the write that caused the event, when recorded. */
  origin?: ContentChangeOrigin;
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `bun test --cwd packages/shared ./src/lib/contracts/content-change-origin.test.ts && bunx nx run shared:typecheck`
Expected: 4 pass; typecheck succeeds. If the Nx project is named differently, use `bun run typecheck`.

- [ ] **Step 7: Changeset.** `@mdcms/shared` is published. Run `bun run changeset`, select `@mdcms/shared`, choose `minor`, summary: `Add the ContentChangeOrigin contract, the X-MDCMS-Client header name, and optional origin fields on document, version and webhook payloads.` When scripting it, follow `.ai/memory/lessons.md` (give the pty a size and a kill watchdog).

- [ ] **Step 8: Commit**

```bash
bun run format
git add packages/shared .changeset
git commit -m "feat(shared): add the content change origin contract"
```

---

### Task 3: Database columns and migration

**Files:**
- Modify: `apps/server/src/lib/db/schema.ts` (documents ~L422-466, documentVersions ~L376-400)
- Create: `apps/server/drizzle/0017_<generated>.sql` and `apps/server/drizzle/meta/0017_snapshot.json` (generated)
- Modify: `apps/server/drizzle/meta/_journal.json` (generated)
- Modify: `apps/server/src/lib/db/schema.contract.test.ts`

- [ ] **Step 1: Write the failing contract assertions.** In `schema.contract.test.ts`, add `"created_origin"` after `"created_by"` and `"updated_origin"` after `"updated_by"` in the `public.documents` required column list, and `"published_origin"` after `"published_by"` in `public.document_versions`. Then add a test at the end of the file:

```ts
test("actor columns store text user ids", () => {
  const { snapshot } = readLatestArtifacts();
  const documentsTable = snapshot.tables["public.documents"];
  const documentVersionsTable = snapshot.tables["public.document_versions"];

  assert.equal(documentsTable?.columns.created_by?.type, "text");
  assert.equal(documentsTable?.columns.updated_by?.type, "text");
  assert.equal(documentVersionsTable?.columns.published_by?.type, "text");
  assert.equal(documentsTable?.columns.created_origin?.type, "jsonb");
  assert.equal(documentsTable?.columns.updated_origin?.type, "jsonb");
  assert.equal(documentVersionsTable?.columns.published_origin?.type, "jsonb");
});
```

Check how existing tests in the file read column metadata (`table.columns[name]`) and match its property names exactly; adjust `.type` if the snapshot uses a different key.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --cwd apps/server ./src/lib/db/schema.contract.test.ts`
Expected: FAIL on the missing origin columns and the `uuid` type.

- [ ] **Step 3: Change the schema.** In `documents`:

```ts
    createdBy: text().notNull(),
    createdOrigin: jsonb(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedBy: text().notNull(),
    updatedOrigin: jsonb(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
```

In `documentVersions`:

```ts
    publishedBy: text().notNull(),
    publishedOrigin: jsonb(),
    publishedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
```

- [ ] **Step 4: Generate the migration**

Run: `bun run --cwd apps/server db:generate`
Expected: a new `apps/server/drizzle/0017_*.sql`, `meta/0017_snapshot.json`, and a journal entry. Open the SQL. It must contain, in some order:

```sql
ALTER TABLE "document_versions" ALTER COLUMN "published_by" SET DATA TYPE text;
ALTER TABLE "documents" ALTER COLUMN "created_by" SET DATA TYPE text;
ALTER TABLE "documents" ALTER COLUMN "updated_by" SET DATA TYPE text;
ALTER TABLE "document_versions" ADD COLUMN "published_origin" jsonb;
ALTER TABLE "documents" ADD COLUMN "created_origin" jsonb;
ALTER TABLE "documents" ADD COLUMN "updated_origin" jsonb;
```

and nothing else. If drizzle-kit emits anything unrelated, stop and investigate the schema drift instead of committing it.

- [ ] **Step 5: Apply and verify against Postgres**

Run: `bun run --cwd apps/server db:migrate && bun test --cwd apps/server ./src/lib/db/schema.contract.test.ts`
Expected: migrations applied; contract tests pass. Then check existing values survived:

Run: `docker compose exec postgres psql -U mdcms -d mdcms -c "select data_type from information_schema.columns where table_name='documents' and column_name='created_by'"`
Expected: `text`.

- [ ] **Step 6: Commit**

```bash
bun run format
git add apps/server/src/lib/db apps/server/drizzle
git commit -m "feat(server): store content actors as user ids with a change origin"
```

---

### Task 4: Server attribution helper

**Files:**
- Create: `apps/server/src/lib/content-api/attribution.ts`
- Create: `apps/server/src/lib/content-api/attribution.test.ts`

- [ ] **Step 1: Write the failing test** `attribution.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import type { AuthorizedRequest } from "../auth.js";
import {
  attributionFromAuthorizedRequest,
  systemAttribution,
} from "./attribution.js";
import { DEFAULT_ACTOR } from "./types.js";

const sessionAuthorization = {
  mode: "session",
  principal: {
    type: "session",
    session: {
      id: "session-1",
      userId: "user-ada",
      email: "ada@example.com",
      issuedAt: "2026-11-11T00:00:00.000Z",
      expiresAt: "2026-11-12T00:00:00.000Z",
    },
  },
} satisfies AuthorizedRequest;

const apiKeyAuthorization = {
  mode: "api_key",
  principal: {
    type: "api_key",
    keyId: "key-1",
    createdByUserId: "user-grace",
    createdByUserEmail: "grace@example.com",
    keyPrefix: "mdcms_key_ab",
    label: "cli:site/production",
    scopes: ["content:write"],
    contextAllowlist: [{ project: "site", environment: "production" }],
  },
} satisfies AuthorizedRequest;

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/content", { headers });
}

test("session requests are attributed to the session user through Studio", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request(),
      authorization: sessionAuthorization,
    }),
    {
      actorId: "user-ada",
      origin: { channel: "studio", credential: "session" },
    },
  );
});

test("API key requests are attributed to the key creator with the key id", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request({ "x-mdcms-client": "cli/0.4.0" }),
      authorization: apiKeyAuthorization,
    }),
    {
      actorId: "user-grace",
      origin: {
        channel: "api",
        credential: "api_key",
        apiKeyId: "key-1",
        declared: "cli/0.4.0",
      },
    },
  );
});

test("an explicit channel and declared name override the defaults", () => {
  assert.deepEqual(
    attributionFromAuthorizedRequest({
      request: request({ "x-mdcms-client": "ignored/1.0" }),
      authorization: sessionAuthorization,
      channel: "studio_ai",
      declared: "assistant",
    }),
    {
      actorId: "user-ada",
      origin: {
        channel: "studio_ai",
        credential: "session",
        declared: "assistant",
      },
    },
  );
});

test("an invalid declared header is dropped", () => {
  const attribution = attributionFromAuthorizedRequest({
    request: request({ "x-mdcms-client": "x".repeat(200) }),
    authorization: apiKeyAuthorization,
  });

  assert.equal(attribution.origin.declared, undefined);
});

test("system attribution uses the placeholder actor by default", () => {
  assert.deepEqual(systemAttribution(), {
    actorId: DEFAULT_ACTOR,
    origin: { channel: "system", credential: "system" },
  });
  assert.equal(systemAttribution("user-seed").actorId, "user-seed");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test --cwd apps/server ./src/lib/content-api/attribution.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `attribution.ts`:

```ts
import {
  MDCMS_CLIENT_HEADER,
  parseDeclaredClient,
  type ContentChangeChannel,
  type ContentWriteAttribution,
} from "@mdcms/shared";

import type { AuthorizedRequest } from "../auth.js";
import { DEFAULT_ACTOR } from "./types.js";

/**
 * Derives who made a content change and how it reached the server. The
 * actor always comes from the authenticated principal; request bodies cannot
 * influence it. `channel` defaults to `studio` for sessions and `api` for API
 * keys; callers that know better (the Assistant, the MCP endpoint) pass it.
 */
export function attributionFromAuthorizedRequest(input: {
  request: Request;
  authorization: AuthorizedRequest;
  channel?: ContentChangeChannel;
  declared?: string;
}): ContentWriteAttribution {
  const declared = parseDeclaredClient(
    input.declared ?? input.request.headers.get(MDCMS_CLIENT_HEADER),
  );
  const declaredField = declared ? { declared } : {};
  const { principal } = input.authorization;

  if (principal.type === "session") {
    return {
      actorId: principal.session.userId,
      origin: {
        channel: input.channel ?? "studio",
        credential: "session",
        ...declaredField,
      },
    };
  }

  return {
    actorId: principal.createdByUserId,
    origin: {
      channel: input.channel ?? "api",
      credential: "api_key",
      apiKeyId: principal.keyId,
      ...declaredField,
    },
  };
}

/** Attribution for writes the server makes on its own, such as seeding. */
export function systemAttribution(
  actorId: string = DEFAULT_ACTOR,
): ContentWriteAttribution {
  return { actorId, origin: { channel: "system", credential: "system" } };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test --cwd apps/server ./src/lib/content-api/attribution.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
bun run format
git add apps/server/src/lib/content-api/attribution.ts apps/server/src/lib/content-api/attribution.test.ts
git commit -m "feat(server): derive content write attribution from the request"
```

---

### Task 5: Store signatures, persistence and mappers

The store write methods take attribution as a required argument. This task changes types, both store implementations, the mappers, and every test call site, then proves the stored values.

**Files:**
- Modify: `apps/server/src/lib/content-api/types.ts`
- Modify: `apps/server/src/lib/content-api/responses.ts`
- Modify: `apps/server/src/lib/content-api/database-store.ts`
- Modify: `apps/server/src/lib/content-api/in-memory-store.ts`
- Modify: `apps/server/src/lib/content-api-test-support.ts`
- Modify (call sites only): `apps/server/src/lib/content-api.test.ts`, `content-api/database-store.test.ts`, `content-api.integration.test.ts`, `runtime-with-modules.test.ts`, `webhooks-api.integration.test.ts`, `environments-api.config.test.ts`

- [ ] **Step 1: Types.** In `types.ts`:
  - Import `ContentChangeOrigin` and `ContentWriteAttribution` from `@mdcms/shared` (add to the existing import).
  - Replace `ContentWriteOperationOptions` with:

```ts
export type ContentAttributionOptions = {
  attribution: ContentWriteAttribution;
};

export type ContentWriteOperationOptions = ContentAttributionOptions & {
  // HTTP content writes pass the header-derived schema hash once the route
  // gate succeeds; direct store callers may omit it.
  expectedSchemaHash?: string;
  expectedDraftRevision?: number;
};
```

  - Remove `createdBy?` and `updatedBy?` from `ContentWritePayload`.
  - Remove `actorId?: unknown` from `ContentPublishPayload`.
  - Add `publishedOrigin?: ContentChangeOrigin;` to `ContentPublishedSnapshot` after `publishedBy`.
  - In `ContentStore`, change the write signatures to:

```ts
  create: (
    scope: ContentScope,
    payload: ContentWritePayload,
    options: ContentWriteOperationOptions,
  ) => Promise<ContentDocument>;
  update: (
    scope: ContentScope,
    documentId: string,
    payload: ContentWritePayload,
    options: ContentWriteOperationOptions,
  ) => Promise<ContentDocument>;
  softDelete: (
    scope: ContentScope,
    documentId: string,
    options: ContentAttributionOptions,
  ) => Promise<ContentDocument>;
  restore: (
    scope: ContentScope,
    documentId: string,
    options: ContentAttributionOptions,
  ) => Promise<ContentDocument>;
  restoreVersion: (
    scope: ContentScope,
    documentId: string,
    version: number,
    input: {
      targetStatus: RestoreTargetStatus;
      changeSummary?: string;
      attribution: ContentWriteAttribution;
    },
  ) => Promise<ContentDocument>;
  publish: (
    scope: ContentScope,
    documentId: string,
    input: {
      changeSummary?: string;
      attribution: ContentWriteAttribution;
    },
  ) => Promise<ContentDocument>;
  unpublish: (
    scope: ContentScope,
    documentId: string,
    input: {
      attribution: ContentWriteAttribution;
    },
  ) => Promise<ContentDocument>;
```

- [ ] **Step 2: Mappers.** In `responses.ts` import `parseContentChangeOrigin` from `@mdcms/shared` and add near the top:

```ts
function originField<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, ContentChangeOrigin>> {
  const origin = parseContentChangeOrigin(value);

  return origin ? ({ [key]: origin } as Record<K, ContentChangeOrigin>) : {};
}
```

(import the `ContentChangeOrigin` type too). Then:
  - `toDocumentResponse`: after `createdBy: document.createdBy,` add `...(document.createdOrigin ? { createdOrigin: document.createdOrigin } : {}),` and after `updatedBy: document.updatedBy,` add `...(document.updatedOrigin ? { updatedOrigin: document.updatedOrigin } : {}),`.
  - `toVersionSummaryResponse`: after `publishedBy` add `...(document.publishedOrigin ? { publishedOrigin: document.publishedOrigin } : {}),`.
  - `toContentDocument`: after `createdBy: row.createdBy,` add `...originField("createdOrigin", row.createdOrigin),`; after `updatedBy: row.updatedBy,` add `...originField("updatedOrigin", row.updatedOrigin),`.
  - `toContentVersionDocument`: after `publishedBy: row.publishedBy,` add `...originField("publishedOrigin", row.publishedOrigin),`.

- [ ] **Step 3: Database store.** In `database-store.ts`:
  - `insertPublishedVersionRow` input: replace `actorId: string;` with `attribution: ContentWriteAttribution;` and set `publishedBy: input.attribution.actorId, publishedOrigin: input.attribution.origin,`.
  - `resolvePublishedSnapshot`: after `createdBy: headRow.createdBy,` add `...originField("createdOrigin", headRow.createdOrigin),` and after `updatedBy: headRow.updatedBy,` add `...originField("updatedOrigin", headRow.updatedOrigin),` (export `originField` from `responses.ts` and import it here).
  - `create(scope, payload, options)`: delete `const actor = payload.createdBy?.trim() || DEFAULT_ACTOR;` and in the insert use:

```ts
              createdBy: options.attribution.actorId,
              createdOrigin: options.attribution.origin,
              updatedBy: options.attribution.actorId,
              updatedOrigin: options.attribution.origin,
```

  - `update(..., options)`: replace `updatedBy: payload.updatedBy?.trim() || DEFAULT_ACTOR,` with `updatedBy: options.attribution.actorId, updatedOrigin: options.attribution.origin,`.
  - `softDelete(scope, documentId, options)` and `restore(scope, documentId, options)`: replace `updatedBy: DEFAULT_ACTOR,` with the same two fields from `options.attribution`.
  - `restoreVersion`, `publish`, `unpublish`: delete `const actorId = input.actorId?.trim() || DEFAULT_ACTOR;`; pass `attribution: input.attribution` to `insertPublishedVersionRow`; set `updatedBy: input.attribution.actorId, updatedOrigin: input.attribution.origin,` on the documents update.
  - Remove the `DEFAULT_ACTOR` import if it is now unused.

- [ ] **Step 4: In-memory store.** In `in-memory-store.ts` mirror Step 3:
  - `create`: `createdBy`/`updatedBy` from `options.attribution.actorId`, plus `createdOrigin`/`updatedOrigin` from `options.attribution.origin`. Change the parameter from `_options?` to `options`.
  - `update`, `softDelete`, `restore`: `updatedBy` and `updatedOrigin` from the attribution argument.
  - `restoreVersion`, `publish`, `unpublish`: snapshots get `publishedBy: input.attribution.actorId, publishedOrigin: input.attribution.origin`; documents get `updatedBy`/`updatedOrigin`.
  - The published-view builder near L195 that sets `updatedBy: snapshot.publishedBy` also sets `...(snapshot.publishedOrigin ? { updatedOrigin: snapshot.publishedOrigin } : {})`, and `toVersionSummary` adds `...(snapshot.publishedOrigin ? { publishedOrigin: snapshot.publishedOrigin } : {})`.
  - Remove `DEFAULT_ACTOR` from the imports if unused.

- [ ] **Step 5: Test helper.** In `content-api-test-support.ts` add:

```ts
export const testAttribution = {
  actorId: "user-1",
  origin: { channel: "studio", credential: "session" },
} satisfies ContentWriteAttribution;
```

(import the type from `@mdcms/shared`; `user-1` matches `authorizedTestRequest`).

- [ ] **Step 6: Update test call sites.** Run `bunx nx run server:typecheck` (or `bun run typecheck`) and fix every reported store call in the test files listed above:
  - `store.create(scope, payload)` and `store.create(scope, payload, { expectedSchemaHash })` → add `attribution: testAttribution` to the options object (create one when absent).
  - `store.update(scope, id, payload, opts?)` → same.
  - `store.softDelete(scope, id)` / `store.restore(scope, id)` → add `{ attribution: testAttribution }`.
  - `store.publish(scope, id, { changeSummary, actorId })` → replace `actorId` with `attribution: testAttribution` (keep `changeSummary`).
  - `store.unpublish(scope, id, { actorId })` and `restoreVersion(..., { targetStatus, actorId })` → same replacement.
  - Payload literals that set `createdBy` or `updatedBy` → remove those keys. Where such a test asserted the stored actor equals a payload value, change it to expect `testAttribution.actorId` (the payload no longer controls it).

Expected after this step: typecheck passes for `apps/server`.

- [ ] **Step 7: Write the persistence test.** Append to `apps/server/src/lib/content-api/database-store.test.ts`:

```ts
testWithDatabase(
  "database content store records actor and origin on writes and publishes",
  async () => {
    const dbConnection = createDatabaseConnection({ env: dbEnv });
    const scope = {
      project: `db-attribution-${stableFixtureName(randomUUID())}`,
      environment: "production",
    };
    const creator = {
      actorId: "user-creator",
      origin: { channel: "studio", credential: "session" },
    } satisfies ContentWriteAttribution;
    const agent = {
      actorId: "user-agent-owner",
      origin: {
        channel: "api",
        credential: "api_key",
        apiKeyId: "key-1",
        declared: "cli/0.4.0",
      },
    } satisfies ContentWriteAttribution;

    try {
      const { schemaHash } = await seedSchemaRegistryScope(dbConnection.db, {
        scope,
        entries: [
          {
            type: "Note",
            directory: "content/notes",
            localized: false,
            fields: {},
          },
        ],
      });
      const store = createDatabaseContentStore({ db: dbConnection.db });

      const created = await store.create(
        scope,
        {
          type: "Note",
          path: "content/notes/attribution",
          locale: "en",
          format: "md",
          frontmatter: {},
          body: "first",
        },
        { expectedSchemaHash: schemaHash, attribution: creator },
      );
      assert.equal(created.createdBy, "user-creator");
      assert.deepEqual(created.createdOrigin, creator.origin);

      const updated = await store.update(
        scope,
        created.documentId,
        { body: "second" },
        { expectedSchemaHash: schemaHash, attribution: agent },
      );
      assert.equal(updated.createdBy, "user-creator");
      assert.equal(updated.updatedBy, "user-agent-owner");
      assert.deepEqual(updated.updatedOrigin, agent.origin);

      await store.publish(scope, created.documentId, {
        changeSummary: "First publish",
        attribution: agent,
      });
      const versions = await store.listVersions(scope, created.documentId, {});
      assert.equal(versions.rows[0]?.publishedBy, "user-agent-owner");
      assert.deepEqual(versions.rows[0]?.publishedOrigin, agent.origin);
    } finally {
      await dbConnection.close();
    }
  },
);
```

Copy the `seedSchemaRegistryScope` entry shape from the existing test at the top of this file if `fields: {}` or the property names differ; the type `Note` must exist in the seeded schema. Add the `ContentWriteAttribution` import from `@mdcms/shared`.

- [ ] **Step 8: Run the server tests**

Run: `bun test --cwd apps/server ./src/lib/content-api ./src/lib/content-api.test.ts`
Expected: the new test passes (or is skipped only if Postgres is down; it must not be skipped in this plan, so start Postgres first). All previously passing tests still pass.

- [ ] **Step 9: Commit**

```bash
bun run format
git add apps/server/src/lib
git commit -m "feat(server): require attribution on every content store write"
```

---

### Task 6: Routes pass attribution; users map on single document and versions

**Files:**
- Modify: `apps/server/src/lib/content-api/lifecycle-events.ts`
- Modify: `apps/server/src/lib/content-api/routes.ts`
- Test: `apps/server/src/lib/content-api.test.ts`

- [ ] **Step 1: Write failing route tests.** Append to `content-api.test.ts`. The test handler (`createHandler`) authorizes every request as `authorizedTestRequest` (session user `user-1`), so the actor must be `user-1` whatever the body says:

```ts
test("content writes record the authenticated user and ignore body actor fields", async () => {
  const handler = createHandler();
  const createResponse = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        ...createCms28BlogPostPayload("attribution-route"),
        createdBy: "someone-else",
        updatedBy: "someone-else",
      }),
    }),
  );
  assert.equal(createResponse.status, 200);
  const created = (await createResponse.json()).data;
  assert.equal(created.createdBy, "user-1");
  assert.equal(created.updatedBy, "user-1");
  assert.deepEqual(created.createdOrigin, {
    channel: "studio",
    credential: "session",
  });

  const publishResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}/publish`,
      {
        method: "POST",
        headers: { ...scopeHeaders, "content-type": "application/json" },
        body: JSON.stringify({ actorId: "someone-else" }),
      },
    ),
  );
  assert.equal(publishResponse.status, 200);

  const versionsResponse = await handler(
    new Request(
      `http://localhost/api/v1/content/${created.documentId}/versions`,
      { headers: scopeHeaders },
    ),
  );
  const versions = await versionsResponse.json();
  assert.equal(versions.data[0].publishedBy, "user-1");
  assert.deepEqual(versions.data[0].publishedOrigin, {
    channel: "studio",
    credential: "session",
  });
});

test("the declared client header is recorded on writes", async () => {
  const handler = createHandler();
  const response = await handler(
    new Request("http://localhost/api/v1/content", {
      method: "POST",
      headers: {
        ...scopeHeaders,
        "content-type": "application/json",
        "x-mdcms-client": "cli/0.4.0",
      },
      body: JSON.stringify(createCms28BlogPostPayload("attribution-declared")),
    }),
  );
  const created = (await response.json()).data;
  assert.equal(created.createdOrigin.declared, "cli/0.4.0");
});
```

Check `createCms28BlogPostPayload`'s signature in `content-api-test-support.ts` and adapt the argument. Then add a users-map test using a handler with `resolveUsers`: extend `createHandler` options with `resolveUsers?: MountContentApiRoutesOptions["resolveUsers"]` passed through to `mountContentApiRoutes`, and assert:

```ts
test("single document and version responses include a users map", async () => {
  const handler = createHandler({
    resolveUsers: async (ids) =>
      Object.fromEntries(
        ids.map((id) => [id, { name: "Ada Lovelace", email: "ada@example.com" }]),
      ),
  });
  const created = (
    await (
      await handler(
        new Request("http://localhost/api/v1/content", {
          method: "POST",
          headers: { ...scopeHeaders, "content-type": "application/json" },
          body: JSON.stringify(createCms28BlogPostPayload("attribution-users")),
        }),
      )
    ).json()
  ).data;
  await handler(
    new Request(`http://localhost/api/v1/content/${created.documentId}/publish`, {
      method: "POST",
      headers: { ...scopeHeaders, "content-type": "application/json" },
      body: "{}",
    }),
  );

  const single = await (
    await handler(
      new Request(
        `http://localhost/api/v1/content/${created.documentId}?draft=true`,
        { headers: scopeHeaders },
      ),
    )
  ).json();
  assert.deepEqual(single.users, {
    "user-1": { name: "Ada Lovelace", email: "ada@example.com" },
  });

  const versions = await (
    await handler(
      new Request(
        `http://localhost/api/v1/content/${created.documentId}/versions`,
        { headers: scopeHeaders },
      ),
    )
  ).json();
  assert.deepEqual(versions.users, {
    "user-1": { name: "Ada Lovelace", email: "ada@example.com" },
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test --cwd apps/server ./src/lib/content-api.test.ts -t "attribution|declared client|users map"`
Expected: FAIL (typecheck is already green from Task 5, so failures are behavioral: actor is not `user-1`, origin missing, users missing).

- [ ] **Step 3: Committer hands attribution to the mutation.** Replace `lifecycle-events.ts` committer types and functions:

```ts
import type { ContentWriteAttribution } from "@mdcms/shared";

import { actorFromAuthorizedRequest, type AuthorizedRequest } from "../auth.js";
import { attributionFromAuthorizedRequest } from "./attribution.js";
// ...existing type imports...

export type ContentLifecycleMutationCommitter = (
  event: ContentLifecycleEvent,
  scope: ContentScope,
  request: Request,
  authorization: AuthorizedRequest,
  mutate: (attribution: ContentWriteAttribution) => Promise<ContentDocument>,
) => Promise<ContentDocument>;
```

`commitContentMutationWithLifecycleEvent` gains `request: Request` and computes:

```ts
  const attribution = attributionFromAuthorizedRequest({
    request: input.request,
    authorization: input.authorization,
  });
  const document = await input.mutate(attribution);
```

and `createContentLifecycleMutationCommitter` forwards `request`. Keep `emitContentLifecycleEvent` unchanged.

- [ ] **Step 4: Route call sites.** In `routes.ts`, update every `commitMutation(` call to pass `request` as the third argument and to use the attribution parameter:
  - Create (~L1166): `commitMutation("content.created", scope, request, authorization, (attribution) => options.store.create(scope, payload, { expectedSchemaHash: schemaHash, attribution }))`.
  - Bulk publish/unpublish (~L1257-1276): `(attribution) => options.store.publish(scope, documentId, { changeSummary: payload.changeSummary, attribution })` and `unpublish(scope, documentId, { attribution })`. Delete the `actorId: payload.actorId` lines.
  - Bulk delete (~L1278): `(attribution) => options.store.softDelete(scope, documentId, { attribution })`.
  - Bulk move (~L1285-1290): add `attribution` to the update options.
  - PUT (~L1430): add `attribution` to the update options.
  - Restore (~L1508): `(attribution) => options.store.restore(scope, params.documentId, { attribution })`.
  - Version restore (~L1603): delete `const actorId = parseOptionalString(payload.actorId, "actorId");` and pass `attribution` instead of `actorId`.
  - Publish (~L1689) and unpublish (~L1764): same as version restore.
  - Duplicate (~L1848): add `attribution` to the create options.
  - Delete (~L1951): `softDelete(scope, params.documentId, { attribution })`.

  Keep the bulk input validation for `actorId` as it is (it still rejects `actorId` on delete and move), because SPEC-003 keeps accepting it on publish and unpublish for compatibility.

- [ ] **Step 5: Users map helper.** Extract the list route's enrichment (~L776-790) into a function in `routes.ts`:

```ts
async function attachUsers(
  response: Record<string, unknown>,
  userIds: string[],
): Promise<void> {
  if (!options.resolveUsers || userIds.length === 0) {
    return;
  }

  try {
    response.users = await options.resolveUsers([...new Set(userIds)]);
  } catch {
    // User enrichment is best-effort; a lookup failure must not break the
    // response it decorates.
  }
}
```

Define it inside `mountContentApiRoutes` so it closes over `options`. Use it in the list route (replacing the inline block), in `GET /api/v1/content/:documentId` (ids: `[data.createdBy, data.updatedBy]`, attached to the returned envelope object before returning it), and in the versions route:

```ts
        const response = toPaginatedResponse(versions, (version) =>
          toVersionSummaryResponse(version),
        );
        await attachUsers(
          response as unknown as Record<string, unknown>,
          response.data.map((version) => version.publishedBy),
        );
        return response;
```

- [ ] **Step 6: Run the route tests**

Run: `bun test --cwd apps/server ./src/lib/content-api.test.ts`
Expected: all pass, including the three new tests.

- [ ] **Step 7: Commit**

```bash
bun run format
git add apps/server/src/lib/content-api apps/server/src/lib/content-api.test.ts apps/server/src/lib/content-api-test-support.ts
git commit -m "feat(server): attribute content route writes to the authenticated user"
```

---

### Task 7: Collaboration writes use the writer's id

**Files:**
- Modify: `apps/server/src/lib/collaboration/runtime.ts` (~L47, L684-688, L966-975, L1071-1078)
- Test: `apps/server/src/lib/collaboration/runtime.test.ts`

- [ ] **Step 1: Update the failing expectations.** In `runtime.test.ts`, find assertions that expect `DEFAULT_ACTOR` for autosave or publish (for example near L1185; search `DEFAULT_ACTOR`). Change them to expect the writer's user id from the test fixture and add an origin assertion on the same document:

```ts
assert.equal(updated.updatedBy, writerUserId);
assert.deepEqual(updated.updatedOrigin, {
  channel: "studio",
  credential: "session",
});
```

Use the variable name the test already uses for the writer id. If no test covers a non-UUID user id, add one that autosaves as `user_abc123` (better-auth's id format) and asserts `updatedBy === "user_abc123"`.

- [ ] **Step 2: Run to verify failure**

Run: `bun test --cwd apps/server ./src/lib/collaboration/runtime.test.ts`
Expected: FAIL on the changed assertions.

- [ ] **Step 3: Implement.** In `runtime.ts`:
  - Delete `POSTGRES_UUID_PATTERN` and `toContentStoreActorId`.
  - Add:

```ts
function collaborationAttribution(userId: string): ContentWriteAttribution {
  return {
    actorId: userId,
    origin: { channel: "studio", credential: "session" },
  };
}
```

  - Autosave: remove `updatedBy` from the payload and pass `{ expectedDraftRevision, attribution: collaborationAttribution(input.writer.userId) }`.
  - Publish: `{ changeSummary: input.changeSummary, attribution: collaborationAttribution(context.userId) }`.
  - Import `ContentWriteAttribution` from `@mdcms/shared`; drop the `DEFAULT_ACTOR` import if unused.

- [ ] **Step 4: Run tests**

Run: `bun test --cwd apps/server ./src/lib/collaboration`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
bun run format
git add apps/server/src/lib/collaboration
git commit -m "fix(server): record the collaboration writer as the content actor"
```

---

### Task 8: Webhook origin

**Files:**
- Modify: `apps/server/src/lib/webhooks/dispatcher.ts`
- Test: the dispatcher's existing test file (find with `ls apps/server/src/lib/webhooks/*.test.ts`)

- [ ] **Step 1: Failing test.** In the dispatcher test, add a case that emits a content event for a document with `updatedOrigin: { channel: "api", credential: "api_key", apiKeyId: "key-1" }` and asserts the enqueued payload has `origin` deep-equal to it; and a case without `updatedOrigin` asserting `"origin" in payload` is false. Reuse the file's existing fake delivery queue setup.

- [ ] **Step 2: Run to verify failure.** Run: `bun test --cwd apps/server ./src/lib/webhooks`. Expected: FAIL on `origin`.

- [ ] **Step 3: Implement.** In `emitContentEvent`'s payload, after `user: userPayload(input.actor),` add:

```ts
          ...(input.document.updatedOrigin
            ? { origin: input.document.updatedOrigin }
            : {}),
```

Every content write sets `updatedOrigin`, so the document passed to the event carries the origin of the write that caused it.

- [ ] **Step 4: Run tests.** Run: `bun test --cwd apps/server ./src/lib/webhooks`. Expected: pass.

- [ ] **Step 5: Commit**

```bash
bun run format
git add apps/server/src/lib/webhooks
git commit -m "feat(server): include the change origin in content webhooks"
```

---

### Task 9: Assistant apply and undo pass attribution

**Files:**
- Modify: `packages/modules/core.ai/src/server/apply.ts`
- Modify: `packages/modules/core.ai/src/server/routes.ts` (`AiAuthorizer` ~L118, apply ~L770-800, undo ~L1010-1030)
- Modify: `apps/server/src/lib/runtime-with-modules.ts` (~L176-220 guarded store, ~L620-690 deps)
- Tests: `packages/modules/core.ai/src/server/apply.test.ts`, `routes.test.ts` (names may differ; find with `ls packages/modules/core.ai/src/server/*.test.ts`), `apps/server/src/lib/runtime-with-modules.test.ts`

- [ ] **Step 1: Types.** In `apply.ts`:
  - Import `ContentWriteAttribution` from `@mdcms/shared`.
  - Remove `updatedBy?` and `createdBy?` from `AiApplyWritePayload`.
  - `AiApplyContentStore.update` options: `{ expectedSchemaHash: string; expectedDraftRevision?: number; attribution: ContentWriteAttribution }`. `create` options: `{ expectedSchemaHash: string; attribution: ContentWriteAttribution }`. `softDelete(scope, documentId, options: { attribution: ContentWriteAttribution })`, `restore?(scope, documentId, options: { attribution: ContentWriteAttribution })`.
  - `AiApplyInput`: replace the `actorId` doc comment and field with:

```ts
  /** Authenticated caller, used for the audit record. */
  actorId: string;
  /** Actor and origin the document write is recorded with. */
  attribution: ContentWriteAttribution;
```

  Do the same for `AiUndoInput`.
  - Pass `attribution: input.attribution` in every `store.create`, `store.update`, `store.softDelete` and `store.restore` call in `applyAiProposal` and `applyAiProposalUndo`, and delete the comments about falling through to `DEFAULT_ACTOR` and the `void input.actorId` line.

- [ ] **Step 2: Authorizer result.** In `routes.ts` change the `AiAuthorizer` return type to `Promise<{ actorId: string; attribution: ContentWriteAttribution }>`, and pass `attribution: aiAuth.attribution` into `applyAiProposal({...})` and `applyAiProposalUndo({...})`.

- [ ] **Step 3: Failing test.** In the apply tests, add: applying an `update_frontmatter` proposal with `attribution: { actorId: "user-ada", origin: { channel: "studio_ai", credential: "session" } }` calls the fake store's `update` with options containing that attribution (record the options in the fake). Add the same for `create_document` and for undo of `delete_document` (restore). Update existing fakes of `authorize` in the core.ai route tests to return `{ actorId, attribution }`.

- [ ] **Step 4: Run to verify the new tests fail, then typecheck**

Run: `bun test --cwd packages/modules ./core.ai`
Expected: the new assertions fail before Step 5's wiring is complete only if Step 1 was skipped; after Steps 1-2 they pass. Run `bun run typecheck` and fix remaining test fakes.

- [ ] **Step 5: Host wiring.** In `runtime-with-modules.ts`:
  - The guarded store wrapper forwards the new options: `softDelete: async (scope, documentId, opts) => { ...; const document = await store.softDelete(scope, documentId, opts); ... }` and the same for `restore`; `create`/`update` already forward `opts`.
  - The `aiModuleDeps.contentStore` adapter forwards `opts` for `softDelete` and `restore` to `contentStore.softDelete(scope, documentId, opts)` / `contentStore.restore(scope, documentId, opts)`.
  - The `authorize` dep returns attribution:

```ts
    authorize: async (request, requirement) => {
      const authorized = await authService.authorizeRequest(
        request,
        requirement,
      );
      const actorId =
        authorized.principal.type === "session"
          ? authorized.principal.session.userId
          : authorized.principal.keyId;
      return {
        actorId,
        attribution: attributionFromAuthorizedRequest({
          request,
          authorization: authorized,
          channel: "studio_ai",
        }),
      };
    },
```

  (import `attributionFromAuthorizedRequest` from `./content-api/attribution.js`). The audit `actorId` keeps its current meaning; only document attribution changes.

- [ ] **Step 6: Wiring test.** In `runtime-with-modules.test.ts`, find the test that exercises AI apply through the host (search `ai/proposals`), and assert the stored document's `updatedBy` is the session user and `updatedOrigin.channel` is `studio_ai`. If no such end-to-end test exists, add one using the existing in-memory AI provider fixtures in that file.

- [ ] **Step 7: Run tests**

Run: `bun test --cwd packages/modules ./core.ai && bun test --cwd apps/server ./src/lib/runtime-with-modules.test.ts`
Expected: pass.

- [ ] **Step 8: Commit**

```bash
bun run format
git add packages/modules apps/server/src/lib/runtime-with-modules.ts apps/server/src/lib/runtime-with-modules.test.ts
git commit -m "feat(ai): attribute applied Assistant proposals to the accepting user"
```

---

### Task 10: Seed and remaining callers

**Files:**
- Modify: `apps/server/src/bin/demo-seed-api-key.ts` (~L487-560)

- [ ] **Step 1: Implement.** Import `systemAttribution` from `../lib/content-api/attribution.js`. Create `const attribution = systemAttribution(input.actorId);` at the top of the seeding function. Remove `updatedBy`/`createdBy` from the payloads; add `{ attribution }` (merged with any existing options) to `store.update` and `store.create`; replace `actorId: input.actorId` with `attribution` in `store.publish`.

- [ ] **Step 2: Typecheck the workspace**

Run: `bun run typecheck`
Expected: success. Any remaining error is a store caller this plan missed; fix it with the same pattern (derive attribution from the authorized request in request handlers, `systemAttribution()` in server-internal code) and note it in the commit message.

- [ ] **Step 3: Run the seed against the dev database**

Run: `MDCMS_DEMO_ENVIRONMENT=staging bun run --cwd apps/server demo:seed`
Expected: `[demo-seed] ensured demo login user ...`.

- [ ] **Step 4: Commit**

```bash
bun run format
git add apps/server/src/bin
git commit -m "chore(server): attribute seeded content to the system channel"
```

---

### Task 11: CLI sends its client name

**Files:**
- Create: `apps/cli/src/lib/client-header.ts`
- Create: `apps/cli/src/lib/client-header.test.ts`
- Modify: `apps/cli/src/lib/framework.ts` (~L600-615)

- [ ] **Step 1: Failing test** `client-header.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "bun:test";

import { withMdcmsClientHeader } from "./client-header.js";

function recordingFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return new Response("{}");
  }) as typeof fetch;
  return { fetcher, calls };
}

test("adds the client header to requests for the configured server", async () => {
  const { fetcher, calls } = recordingFetch();
  const wrapped = withMdcmsClientHeader(
    fetcher,
    "https://cms.example.com",
    "cli/0.4.0",
  );

  await wrapped("https://cms.example.com/api/v1/content", {
    headers: { authorization: "Bearer k" },
  });

  assert.equal(calls[0]?.headers.get("x-mdcms-client"), "cli/0.4.0");
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer k");
});

test("leaves other origins and explicit values alone", async () => {
  const { fetcher, calls } = recordingFetch();
  const wrapped = withMdcmsClientHeader(
    fetcher,
    "https://cms.example.com",
    "cli/0.4.0",
  );

  await wrapped("https://registry.npmjs.org/mdcms");
  await wrapped("https://cms.example.com/api/v1/schema", {
    headers: { "x-mdcms-client": "custom/1" },
  });

  assert.equal(calls[0]?.headers.get("x-mdcms-client"), null);
  assert.equal(calls[1]?.headers.get("x-mdcms-client"), "custom/1");
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test --cwd apps/cli ./src/lib/client-header.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement** `client-header.ts`:

```ts
import { MDCMS_CLIENT_HEADER } from "@mdcms/shared";

/**
 * Reports the CLI name and version to the configured MDCMS server so the
 * server can show which client made a change. Requests to other origins are
 * passed through unchanged.
 */
export function withMdcmsClientHeader(
  fetcher: typeof fetch,
  serverUrl: string,
  client: string,
): typeof fetch {
  const serverOrigin = new URL(serverUrl).origin;

  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    let origin: string;

    try {
      origin = new URL(url).origin;
    } catch {
      return fetcher(input, init);
    }

    if (origin !== serverOrigin) {
      return fetcher(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    if (!headers.has(MDCMS_CLIENT_HEADER)) {
      headers.set(MDCMS_CLIENT_HEADER, client);
    }

    return fetcher(input, { ...init, headers });
  };

  return Object.assign(wrapped, { preconnect: fetcher.preconnect }) as typeof fetch;
}
```

If `fetcher.preconnect` does not exist on the runtime's `typeof fetch`, drop the `Object.assign` and cast `wrapped as typeof fetch`.

- [ ] **Step 4: Wire it.** In `framework.ts`, where the command context is built with `serverUrl: resolved.serverUrl` and `fetcher,` (~L600-615), replace `fetcher,` with:

```ts
      fetcher: resolved.serverUrl
        ? withMdcmsClientHeader(
            fetcher,
            resolved.serverUrl,
            `cli/${options.version ?? "0.0.0"}`,
          )
        : fetcher,
```

Import `withMdcmsClientHeader`. Check whether other contexts are built in `framework.ts` (for example for `login` or `init` before config resolution) and apply the same wrapping wherever a server URL is known.

- [ ] **Step 5: Run CLI tests.** Run: `bun test --cwd apps/cli ./src`. Expected: all pass. If an existing test asserts an exact header set, update it to expect `x-mdcms-client` as well.

- [ ] **Step 6: Changeset.** Run `bun run changeset`, select `@mdcms/cli`, `patch`, summary: `Send the X-MDCMS-Client header so the server records changes made with the CLI.`

- [ ] **Step 7: Commit**

```bash
bun run format
git add apps/cli .changeset
git commit -m "feat(cli): report the CLI name and version to the server"
```

---

### Task 12: Studio shows authors and channels

**Files:**
- Modify: `packages/studio/src/lib/document-route-api.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Tests: `packages/studio/src/lib/document-route-api.test.ts` (find the existing test file name), `runtime-ui/pages/content-document-page.test.tsx`

- [ ] **Step 1: Route API parsing.** In `document-route-api.ts`:
  - Import `parseContentChangeOrigin` and `type ContentUserSummary` from `@mdcms/shared`.
  - Add a helper:

```ts
function readUsersMap(
  payload: unknown,
): Record<string, ContentUserSummary> | undefined {
  if (!isRecord(payload) || !isRecord(payload.users)) {
    return undefined;
  }

  const users: Record<string, ContentUserSummary> = {};

  for (const [id, value] of Object.entries(payload.users)) {
    if (isRecord(value) && isString(value.name) && isString(value.email)) {
      users[id] = { name: value.name, email: value.email };
    }
  }

  return users;
}
```

  - In `validateContentDocumentResponseData` and `validateContentVersionSummaryResponseData`, after validation, normalize origin fields: replace each of `createdOrigin`, `updatedOrigin`, `publishedOrigin` with `parseContentChangeOrigin(value)` and delete the key when that returns `undefined`, so an unrecognized origin from a newer server never fails the page.
  - Change `listVersions` to return `ApiPaginatedEnvelope<ContentVersionSummaryResponse> & { users?: Record<string, ContentUserSummary> }`, setting `users: readUsersMap(payload)` when defined. Update the method type in `StudioDocumentRouteApi` accordingly.
  - Change `loadDraft` to return `ContentDocumentResponse & { users?: Record<string, ContentUserSummary> }` the same way (users read from the top-level response payload).

- [ ] **Step 2: Route API tests.** Add tests: `listVersions` returns `users` and keeps a valid `publishedOrigin`; an unknown origin shape (`{ channel: "fax" }`) is dropped rather than throwing; `loadDraft` returns `users` and `updatedOrigin`. Use the file's existing fake fetcher pattern.

- [ ] **Step 3: History state.** In `content-document-page-state.ts`:
  - Add `users?: Record<string, ContentUserSummary>;` to the `ready` variant of `ContentDocumentVersionHistoryState`.
  - `createVersionHistoryState(versions, users?)` puts `users` on the ready state.
  - Both call sites (~L1155, ~L1467) pass `versionHistoryResponse.users` / `response.users`.

- [ ] **Step 4: History tab rendering.** In `SidebarHistoryTab`, after the change-summary paragraph and before the relative time, render:

```tsx
                <p
                  className="mt-0.5 text-xs text-foreground-muted"
                  data-mdcms-version-author
                  title={
                    version.publishedOrigin?.declared
                      ? "Client name as reported by the client"
                      : undefined
                  }
                >
                  {formatVersionAuthor(version, versionHistory)}
                </p>
```

with a module-level helper:

```tsx
function formatVersionAuthor(
  version: ContentVersionSummaryResponse,
  history: ContentDocumentVersionHistoryState,
): string {
  const users = history.status === "ready" ? history.users : undefined;
  const name = users?.[version.publishedBy]?.name ?? "Unknown";

  return version.publishedOrigin
    ? `${name} · ${formatContentChangeOrigin(version.publishedOrigin)}`
    : name;
}
```

Import `formatContentChangeOrigin` from `@mdcms/shared`.

- [ ] **Step 5: Info tab last edit.** Add an optional prop to `SidebarInfoTab`:

```tsx
export type ContentDocumentLastEdit = {
  name?: string;
  origin?: ContentChangeOrigin;
};

export function SidebarInfoTab(props: {
  state: ContentDocumentPageReadyState;
  lastEdit?: ContentDocumentLastEdit;
}) {
```

and after the `updatedAt` row render, when `props.lastEdit` is set:

```tsx
        {props.lastEdit ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-foreground-muted">updatedBy</span>
            <span
              className="truncate text-right text-foreground"
              data-mdcms-last-edit
            >
              {props.lastEdit.name ?? "Unknown"}
              {props.lastEdit.origin
                ? ` · ${formatContentChangeOrigin(props.lastEdit.origin)}`
                : ""}
            </span>
          </div>
        ) : null}
```

Thread `lastEdit` from the page view props through `ContentDocumentPageSidebar` to `SidebarInfoTab` (add `lastEdit?: ContentDocumentLastEdit` to both props types and pass it in the `SidebarInfoTab` render at ~L1553).

- [ ] **Step 6: Fetch the last edit in the page controller.** In the controller hook that returns `ContentDocumentPageViewProps` (~L3085, it already has `queryClient`, `apiConfig`, `mountInfo`), add:

```tsx
  const readyDocument =
    state.status === "ready" ? state.document : undefined;
  const lastEditQuery = useQuery({
    queryKey: [
      "mdcms-document-last-edit",
      mountInfo.project,
      mountInfo.environment,
      readyDocument?.documentId,
      readyDocument?.updatedAt,
    ],
    enabled: Boolean(readyDocument && documentRouteApi),
    staleTime: 10_000,
    queryFn: async () => {
      const document = await documentRouteApi!.loadDraft({
        type: typeId,
        documentId: readyDocument!.documentId,
        locale: state.status === "ready" ? state.locale : undefined,
      });

      return {
        name: document.users?.[document.updatedBy]?.name,
        origin: document.updatedOrigin,
      } satisfies ContentDocumentLastEdit;
    },
  });
```

Use the controller's existing route API instance (the one created with `createContentDocumentRouteApi` near ~L3510) for `documentRouteApi`, and the controller's actual names for `state`, `typeId` and locale; read them before editing. Return `lastEdit: lastEditQuery.data` in the view props. Import `useQuery` from `@tanstack/react-query`.

- [ ] **Step 7: Rendering tests.** In `content-document-page.test.tsx`:

```tsx
test("SidebarInfoTab shows who last edited the document and through which client", () => {
  const markup = renderToStaticMarkup(
    createElement(SidebarInfoTab, {
      state: createReadyState(),
      lastEdit: {
        name: "Ada Lovelace",
        origin: { channel: "mcp", credential: "oauth", declared: "claude-code 1.2" },
      },
    }),
  );

  assert.match(markup, /Ada Lovelace · MCP \(claude-code 1\.2\)/);
});
```

Use the ready-state factory the file already uses (see the helper around L137). Add a History tab test that renders a ready history state with `users: { "user-1": { name: "Ada Lovelace", email: "a@x" } }` and a version with `publishedBy: "user-1"` and `publishedOrigin: { channel: "studio", credential: "session" }`, asserting `Ada Lovelace · Studio`; and one without users asserting `Unknown`.

- [ ] **Step 8: Run Studio tests**

Run: `bun test --cwd packages/studio ./src`
Expected: all pass except the known `createDocumentEditor loads markdown into a real TipTap document` failure, which also fails on unmodified `main` on this machine and passes in CI. Report it, do not change it.

- [ ] **Step 9: Changeset.** `document-route-api.ts` is a published source of `@mdcms/studio`. Run `bun run changeset`, select `@mdcms/studio`, `minor`, summary: `Show who published each version and through which client in document history, and who last edited the document in document info.`

- [ ] **Step 10: Commit**

```bash
bun run format
git add packages/studio .changeset
git commit -m "feat(studio): show authors and change origins in document history"
```

---

### Task 13: Documentation and team memory

**Files:**
- Modify: `apps/docs/api-reference/content.mdx`, `apps/docs/api-reference/media-and-webhooks.mdx`, `apps/docs/api-reference/authentication.mdx` (or `overview.mdx`, wherever request headers are listed)
- Modify: `.ai/LANGUAGE.md`, `.ai/memory/architecture.md` or `.ai/memory/topics/auth-flow.md`
- Modify: `.ai/research/2026-11-11-mcp-and-shared-tools-design.md`

- [ ] **Step 1: API reference.**
  - `content.mdx`: in document and version response examples, replace the uuid-looking `publishedBy`/`createdBy`/`updatedBy` values with a user id such as `"user_8f2k1"`, add `"publishedOrigin": { "channel": "studio", "credential": "session" }` to one version example and `"updatedOrigin"` to one document example, and add a short "Change attribution" section linking the fields to the actor rule (server-derived; body actor fields ignored). Document the `users` map on single document and versions responses.
  - `media-and-webhooks.mdx`: add `"origin": { "channel": "api", "credential": "api_key", "apiKeyId": "..." }` to the content webhook example and one sentence describing it.
  - Headers page: document `X-MDCMS-Client`.

- [ ] **Step 2: Vocabulary.** In `.ai/LANGUAGE.md` add entries: **Change origin**: how a content change reached the server (channel, credential, optional declared client name). **Declared client**: the client name and version a client reports in `X-MDCMS-Client`; informational only. Follow the file's existing entry format.

- [ ] **Step 3: Memory.** In `.ai/memory/topics/auth-flow.md` (or `architecture.md` if invariants live there), add the invariant: "Content actors come from the authenticated principal through `attributionFromAuthorizedRequest`; store writes require a `ContentWriteAttribution`; request body actor fields are ignored."

- [ ] **Step 4: Design doc corrections.** In the design document's sub-project 1 section: the SDK does not send `X-MDCMS-Client` (it only reads); `declared` is printable ASCII; the users map is also returned by the single document `GET`; webhook `origin` is taken from the document's `updatedOrigin`.

- [ ] **Step 5: Commit**

```bash
bun run format
git add apps/docs .ai
git commit -m "docs: document change attribution and the client header"
```

---

### Task 14: Verification

- [ ] **Step 1: Repository gates**

Run: `bun run format:check && bun run check && bun run unit`
Expected: format clean; build and typecheck succeed; unit tests pass except the known local TipTap test, which must be reported with its output.

- [ ] **Step 2: Integration gate**

Run: `bun run integration`
Expected: compose health and migration checks pass, including the new migration on a fresh database.

- [ ] **Step 3: End-to-end check in the running app.** Start the dev stack (infrastructure in Docker, `bun run dev` natively, demo data seeded). Then:
  1. Sign in to Studio as `demo@mdcms.local`, edit and publish a post. History shows `Demo User · Studio`; Info shows `updatedBy Demo User · Studio`.
  2. Create an API key in Studio Settings with `content:write` and `content:publish`, then `curl` a `PUT` to that post with `X-MDCMS-Client: curl-check/1` and a body containing `"updatedBy":"someone-else"`, and publish it. Studio shows `Demo User · API (curl-check/1)` for the new version and in Info. The stored actor is the key creator, not `someone-else`.
  3. Run `mdcms push` from a scratch project against the same server. Info shows `API (cli/<version>)`.
  4. Configure a webhook to a local receiver (for example `bunx http-echo-server` or a 10-line `Bun.serve`) and confirm the payload carries `origin`.

  Record what was checked and what was not in the PR description.

- [ ] **Step 4: Update the initiative.** In `.ai/memory/initiatives/2026-11-11-mcp-server.md` add under Key decisions: "Sub-project 1 (change attribution) is implemented; see the commits on the MCP branch."

```bash
bun run format
git add .ai/memory/initiatives
git commit -m "docs(ai): record change attribution as implemented"
```
