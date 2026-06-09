# Schema File Fields Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add first-class schema file fields that store media asset ids, validate assignments against project media metadata, expand to `MediaAsset` objects by default on content API reads, and render as Studio media picker controls.

**Architecture:** Model file fields as Zod strings with MDCMS metadata, parallel to reference fields. Keep raw ids as the persisted/write/local-file shape, then apply media expansion in the content API response layer unless callers request raw file fields. Studio property controls use the existing media library/upload APIs and store only selected asset ids in frontmatter.

**Tech Stack:** TypeScript 5.9, Zod 4, Bun test, Elysia-style route mounting, Drizzle/Postgres media metadata, React Studio runtime.

---

## Pre-Flight

Run from `/Users/karol/Desktop/mdcms`.

Use repo-local plan location `.ai/plans/` despite the generic superpowers template naming `docs/plans/`; `AGENTS.md` explicitly makes `.ai/plans/` canonical for this repository.

Do not stage or modify unrelated existing untracked files.

---

### Task 1: Specify The Contract

**Files:**
- Modify: `docs/specs/SPEC-004-schema-system-and-sync.md`
- Modify: `docs/specs/SPEC-003-content-storage-versioning-and-migrations.md`
- Modify: `docs/specs/SPEC-006-studio-runtime-and-ui.md`
- Modify: `docs/specs/SPEC-010-media-webhooks-search-and-integrations.md`

**Step 1: Update SPEC-004**

Add a `fieldTypes` section near the schema authoring examples.

Required contract points:

- Schema built-ins are imported through `fieldTypes`; `fieldTypes.reference()` is canonical and the previous top-level `reference()` helper is removed from the beta contract.
- `fieldTypes.image(options?)`, `fieldTypes.video(options?)`, and `fieldTypes.file(options?)` persist raw project-scoped `MediaAsset.id` strings.
- `FileFieldOptions` includes `accept?: string[]`, `required?: boolean`, and `default?: string`. `accept` values are MIME values or MIME wildcards only; image/video helpers set the broad preset family and custom `accept` narrows within that family.
- `fieldTypes.*({ required: false })` resolves to `required: false` and `nullable: true`; missing, `null`, and empty string are unset. `.optional()` without helper `required: false` makes missing values optional only, and `.nullable()` accepts `null` according to snapshot nullability.
- Helper defaults and Zod `.default()` values are raw `MediaAsset.id` strings and must agree when both are present. Applied defaults are validated for asset existence and MIME compatibility during content write validation.
- Serialized file field snapshots are `kind: "string"` snapshots with `file: { preset: "image" | "video" | "file", accept: string[] }`; `required`, `nullable`, and `default` stay on the field snapshot outside `file`.
- File-field write validation failures use `INVALID_INPUT` (`400`) with machine-readable details such as `{ field, mediaAssetId?, reason: "MEDIA_REQUIRED" | "MEDIA_NOT_FOUND" | "MEDIA_TYPE_MISMATCH", expectedMime?, actualMimeType? }`.

Replace all examples importing or calling top-level `reference` with `fieldTypes.reference`.

Replace the `Reference Field Identity` section opening sentence with:

```md
`fieldTypes.reference('Type')` fields store the target document's environment-local `document_id` string.
```

Add a new `File Field Identity` subsection covering raw id persistence, preset and `accept` validation, helper defaults, optional unset semantics, and the machine-readable `details.reason` values above.

**Step 2: Update SPEC-003**

Find the content API read/write contract section. Add the `fileFields` response-shape contract:

- `fileFields` accepts only `raw` or `expanded`; unsupported values fail with `INVALID_QUERY_PARAM` (`400`).
- Content endpoints that return documents expand schema file fields by default. `fileFields=raw` returns persisted media asset id strings and is required for authoring clients that round-trip frontmatter, including Studio editing and CLI pull/push.
- Raw mode preserves persisted unset representations. Expanded/default mode returns `MediaAsset | null`; optional unset file fields return `null` and do not add `resolveErrors` entries.
- File-field expansion failures put `null` in the field and a `FileFieldResolveError` at `resolveErrors["frontmatter.<field>"]` with `code` `MEDIA_NOT_FOUND` or `MEDIA_TYPE_MISMATCH`, `media.assetId`, `expectedMime`, and `actualMimeType` where available.
- `ContentDocumentResponse` and `ContentVersionDocumentResponse` carry the shaped frontmatter plus the unified `resolveErrors` union. Bulk response shaping applies only to succeeded `results[].document` values, with omitted `fileFields` using expanded mode.

**Step 3: Update SPEC-006**

Under the document editor/property behavior, add:

```md
Schema file fields render in the Properties panel as media picker controls. The control stores the selected media asset id in frontmatter, never a URL or Markdown string. It uses media read capability for browsing/replacing and media upload capability for upload-new. Images render thumbnails, videos render inline playback, and other files render a compact file placeholder.
```

Also specify that Studio document editing requests `fileFields=raw`, optional fields expose remove/clear behavior, required fields cannot be left unset, and file-specific validation messages are driven by machine-readable missing-asset and MIME-mismatch details.

Remove the media settings requirement:

```md
User-facing copy must state that MDCMS does not enforce a file-type allowlist...
```

Replace it with:

```md
The panel explains only the image byte-limit setting and infrastructure/proxy caveat. It must not display a general file-type allowlist disclaimer in the document editor or content canvas.
```

**Step 4: Update SPEC-010**

Add a short note in the media API section:

```md
Schema file fields use `MediaAsset` metadata for validation and expansion. Media upload remains unrestricted by schema; schema restrictions apply when assigning an existing or newly uploaded asset to a content field.
```

**Step 5: Validate docs format**

Run:

```bash
bun run format:check
```

Expected: either pass, or fail only with files touched in this task. If it fails on touched markdown, run `bun run format` and re-check.

**Step 6: Commit**

```bash
git add docs/specs/SPEC-004-schema-system-and-sync.md docs/specs/SPEC-003-content-storage-versioning-and-migrations.md docs/specs/SPEC-006-studio-runtime-and-ui.md docs/specs/SPEC-010-media-webhooks-search-and-integrations.md
git commit -m "docs(schema): specify file field types"
```

---

### Task 2: Add Shared Contract Tests For `fieldTypes`

**Files:**
- Modify: `packages/shared/src/lib/contracts/config.test.ts`
- Modify: `packages/shared/src/lib/contracts/schema.test.ts`
- Modify: `packages/shared/src/lib/contracts/schema.ts`

**Step 1: Write failing config tests**

In `config.test.ts`, update imports to use `fieldTypes` instead of `reference` and add:

```ts
test("fieldTypes create normalized reference and file metadata", () => {
  const article = defineType("Article", {
    directory: "content/articles",
    fields: {
      author: fieldTypes.reference("Author"),
      image: fieldTypes.image({ required: false }),
      video: fieldTypes.video({ accept: ["video/mp4"] }),
      download: fieldTypes.file({ accept: ["application/pdf", "audio/*"] }),
      optionalDownload: fieldTypes.file({
        accept: ["application/pdf"],
        required: false,
      }),
      defaultVideo: fieldTypes.video({
        default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
      }),
    },
  });

  const parsed = parseMdcmsConfig(
    defineConfig({
      project: "marketing-site",
      serverUrl: "http://localhost:4000",
      contentDirectories: ["content"],
      types: [article],
      environments: { production: {} },
    }),
  );

  assert.equal(parsed.types[0]?.referenceFields.author?.targetType, "Author");
});
```

Add invalid accept tests:

```ts
test("fieldTypes.file rejects category-like accept entries", () => {
  assert.throws(
    () => fieldTypes.file({ accept: ["image"] }),
    /valid MIME type or wildcard/i,
  );
});
```

Add preset compatibility tests:

- `fieldTypes.image({ accept: ["application/pdf"] })` is invalid schema config.
- `fieldTypes.video({ accept: ["image/png"] })` is invalid schema config.
- `fieldTypes.image({ accept: ["image/png", "image/jpeg"] })` is valid narrowing within the image preset.
- `fieldTypes.video({ accept: ["video/mp4"] })` is valid narrowing within the video preset.

Add helper option precedence/config tests:

- `fieldTypes.file({ required: false })` resolves to an optional nullable snapshot and write validation treats missing, `null`, and empty string as unset.
- `.optional()` around a file helper without `required: false` resolves to an optional snapshot, treats missing as optional, does not treat empty string as unset, and does not accept `null` unless `.nullable()` is also present.
- `.nullable()` around a file helper resolves to `nullable: true`.
- helper `default` and Zod `.default()` must agree when both are present.
- helper or Zod defaults on file helpers must be raw media asset id strings.

**Step 2: Write failing schema snapshot tests**

In `schema.test.ts`, update the stable snapshot test to include:

```ts
primaryImage: fieldTypes.image({ required: false }),
heroVideo: fieldTypes.video({ accept: ["video/mp4", "video/webm"] }),
attachment: fieldTypes.file({ accept: ["application/pdf"] }),
optionalAttachment: fieldTypes.file({
  accept: ["application/pdf"],
  required: false,
}),
defaultVideo: fieldTypes.video({
  default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
}),
```

Expected snapshot pieces:

```ts
primaryImage: {
  kind: "string",
  required: false,
  nullable: true,
  file: { preset: "image", accept: [] },
},
heroVideo: {
  kind: "string",
  required: true,
  nullable: false,
  file: { preset: "video", accept: ["video/mp4", "video/webm"] },
},
attachment: {
  kind: "string",
  required: true,
  nullable: false,
  file: { preset: "file", accept: ["application/pdf"] },
},
optionalAttachment: {
  kind: "string",
  required: false,
  nullable: true,
  file: { preset: "file", accept: ["application/pdf"] },
},
defaultVideo: {
  kind: "string",
  required: false,
  nullable: false,
  default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
  file: { preset: "video", accept: [] },
},
```

Add validation tests that `assertSchemaRegistrySyncPayload` rejects malformed `file` metadata once schema.ts exposes validation, including `file` metadata on non-string snapshots and malformed snapshot defaults for file fields.

**Step 3: Run failing tests**

```bash
bun test --cwd packages/shared ./src/lib/contracts/config.test.ts ./src/lib/contracts/schema.test.ts
```

Expected: fail because `fieldTypes` and `file` metadata do not exist.

Do not implement in this task.

---

### Task 3: Implement Shared `fieldTypes` And Schema Metadata

**Files:**
- Modify: `packages/shared/src/lib/contracts/config.ts`
- Modify: `packages/shared/src/lib/contracts/schema.ts`
- Modify: `packages/shared/src/index.ts` if needed
- Modify: `packages/shared/src/lib/contracts/config.test.ts`
- Modify: `packages/shared/src/lib/contracts/schema.test.ts`

**Step 1: Implement public types and helpers**

In `config.ts`, add:

```ts
const FILE_METADATA_KEY = "mdcms:file";

export type MdcmsFileFieldPreset = "image" | "video" | "file";

export type MdcmsFileFieldMetadata = {
  preset: MdcmsFileFieldPreset;
  accept: string[];
};

export type MdcmsFileFieldOptions = {
  accept?: readonly string[];
  required?: boolean;
  default?: string;
};
```

Create internal helpers:

```ts
function createReferenceField(targetType: string) {
  const normalizedTargetType = parseRequiredString(targetType, "targetType");
  return z.string().meta({
    [REFERENCE_METADATA_KEY]: { targetType: normalizedTargetType },
  });
}

function createFileField(
  preset: MdcmsFileFieldPreset,
  options: MdcmsFileFieldOptions = {},
) {
  const schema = z.string().meta({
    [FILE_METADATA_KEY]: {
      preset,
      accept: normalizeAccept(options.accept ?? []),
    },
  });
  const withDefault =
    options.default === undefined ? schema : schema.default(options.default);
  return options.required === false ? withDefault.optional().nullable() : withDefault;
}

export const fieldTypes = {
  reference: createReferenceField,
  image: (options?: MdcmsFileFieldOptions) => createFileField("image", options),
  video: (options?: MdcmsFileFieldOptions) => createFileField("video", options),
  file: (options?: MdcmsFileFieldOptions) => createFileField("file", options),
} as const;
```

Remove the exported top-level `reference()` function. If local internals need a name, keep it unexported as `createReferenceField`.

Implement `normalizeAccept`:

```ts
const MIME_ACCEPT_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;
```

Trim, lowercase, de-duplicate, sort, and reject invalid entries with `invalidConfig("accept", "...")`. For image/video helpers, reject custom `accept` entries outside the preset family as invalid schema config; valid entries narrow within the preset. Validate helper `default` as a raw media asset id string. Add wrapper precedence validation so helper `required: false` serializes to an optional nullable snapshot, `.optional()` can make helpers optional, `.nullable()` sets snapshot nullability, Zod `.default()` yields `required: false`, and helper/Zod defaults must agree when both are present.

**Step 2: Extend parsed metadata helpers**

Add `findFileMetadata` using the same stack-walk pattern as `findReferenceMetadata`. Only top-level `referenceFields` remains needed for current routing; do not add a parsed `fileFields` map unless tests require it.

**Step 3: Extend schema snapshot type**

In `schema.ts`, import `MdcmsFileFieldMetadata`. Add:

```ts
file?: MdcmsFileFieldMetadata;
```

to `SchemaRegistryFieldSnapshot`.

Keep `SchemaRegistryFieldSnapshot.file` limited to `{ preset, accept }`; resolved
`required`, `nullable`, and `default` metadata remains on the field snapshot
itself.

Implement `readDirectFileMetadata(schema)` next to `readDirectReferenceMetadata`.

Include `file` in `withFieldSnapshotBase(...)` extras and in all scalar/array/object/enum/literal branches where `reference` is currently included.

**Step 4: Validate snapshot payloads**

In `assertFieldSnapshot`, validate:

- `file` is an object when present.
- `file.preset` is `image`, `video`, or `file`.
- `file.accept` is an array of valid normalized MIME accept entries.
- `file` appears only on `kind: "string"` snapshots in synced payload validation.
- `default`, when present on a file field snapshot, is a raw media asset id string.

**Step 5: Run tests**

```bash
bun test --cwd packages/shared ./src/lib/contracts/config.test.ts ./src/lib/contracts/schema.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/shared/src/lib/contracts/config.ts packages/shared/src/lib/contracts/schema.ts packages/shared/src/lib/contracts/config.test.ts packages/shared/src/lib/contracts/schema.test.ts
git commit -m "feat(shared): add schema file field types"
```

---

### Task 4: Update CLI Authoring Surface And Examples

**Files:**
- Modify: `apps/cli/src/lib/init/generate-config.ts`
- Modify: `apps/cli/src/lib/init/generate-config.test.ts`
- Modify: `apps/cli/src/lib/init/infer-schema.ts`
- Modify: `apps/cli/src/lib/init/infer-schema.test.ts`
- Modify: `apps/cli/src/lib/init.ts`
- Modify: `apps/cli/src/lib/config.test.ts`
- Modify: `apps/cli/README.md`
- Modify: `apps/studio-example/mdcms.config.ts`
- Modify: `apps/studio-example/mdcms.config.test.ts`
- Modify: `skills/mdcms-content-editing/SKILL.md`
- Modify: `skills/mdcms-schema-refine/SKILL.md`

**Step 1: Write/update failing tests**

Update generate-config tests to expect:

```ts
import { defineConfig, defineType, fieldTypes } from "@mdcms/cli";
```

and:

```ts
author: fieldTypes.reference("author").optional()
```

Update infer-schema tests to expect the inferred zodType string:

```ts
fieldTypes.reference("author")
```

**Step 2: Run failing CLI tests**

```bash
bun test --cwd apps/cli ./src/lib/init/generate-config.test.ts ./src/lib/init/infer-schema.test.ts ./src/lib/config.test.ts
```

Expected: fail because generators still emit/import `reference`.

**Step 3: Implement generator updates**

In `generate-config.ts`:

- Change `hasReferences` to detect `fieldTypes.reference(`.
- Add `fieldTypes` to imports when references exist.
- Never import top-level `reference`.

In `infer-schema.ts`, emit:

```ts
zodType = `fieldTypes.reference("${key}")`;
```

In `init.ts`, update stand-in handling for reference zodType detection from `reference(` to `fieldTypes.reference(`.

**Step 4: Update examples and public skills**

Replace user-facing top-level reference examples with `fieldTypes.reference`.

Do not introduce file fields into the example config unless the test suite already has stable media ids available. Keep this task focused on the breaking reference API migration.

**Step 5: Run tests**

```bash
bun test --cwd apps/cli ./src/lib/init/generate-config.test.ts ./src/lib/init/infer-schema.test.ts ./src/lib/config.test.ts
bun test --cwd apps/studio-example ./mdcms.config.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add apps/cli/src/lib/init/generate-config.ts apps/cli/src/lib/init/generate-config.test.ts apps/cli/src/lib/init/infer-schema.ts apps/cli/src/lib/init/infer-schema.test.ts apps/cli/src/lib/init.ts apps/cli/src/lib/config.test.ts apps/cli/README.md apps/studio-example/mdcms.config.ts apps/studio-example/mdcms.config.test.ts skills/mdcms-content-editing/SKILL.md skills/mdcms-schema-refine/SKILL.md
git commit -m "refactor(cli): move references under fieldTypes"
```

---

### Task 5: Add Server Tests For File Field Write Validation

**Files:**
- Create: `apps/server/src/lib/content-api/media-field-validation.ts`
- Create or modify: `apps/server/src/lib/content-api/media-field-validation.test.ts`
- Modify: `apps/server/src/lib/content-api/database-store.test.ts`
- Modify: `apps/server/src/lib/content-api.test.ts`
- Modify: `apps/server/src/lib/content-api/types.ts`

**Step 1: Define test helper data**

Use media assets shaped like `MediaAsset`:

```ts
const imageAsset = {
  id: "07ebb057-eeab-4849-94e4-2162cb921c8e",
  project: "marketing-site",
  filename: "hero.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 100,
  url: "https://cdn.example.test/hero.jpg",
  uploadedBy: "user_1",
  uploadedAt: "2026-06-09T10:00:00.000Z",
};
```

**Step 2: Write unit tests for validation helper**

Cover:

- required file fields fail for missing, `null`, and empty string values after schema defaults/wrappers are resolved
- non-string present values fail
- blank strings fail for required file fields
- optional file fields with `required: false` treat missing, `null`, and empty string as unset and skip media lookup
- missing asset id fails with `INVALID_INPUT`
- helper default values are validated for asset existence and MIME compatibility when applied
- Zod `.default()` values on file helpers are validated for asset existence and MIME compatibility when applied
- `fieldTypes.image()` accepts `image/jpeg`
- `fieldTypes.image()` rejects `application/pdf`
- `fieldTypes.video({ accept: ["video/mp4"] })` accepts `video/mp4; charset=binary`
- exact accept matching is case-insensitive
- wildcard accept matching works
- failure details include `field: "frontmatter.primaryImage"`
- required failures include `details.reason: "MEDIA_REQUIRED"`
- missing asset failures include `details.reason: "MEDIA_NOT_FOUND"` and `details.mediaAssetId`
- MIME mismatch failures include `details.reason: "MEDIA_TYPE_MISMATCH"`, `details.expectedMime`, and `details.actualMimeType`

**Step 3: Write store integration tests**

Add a content create/update test using synced schema:

```ts
primaryImage: {
  kind: "string",
  required: true,
  nullable: false,
  file: { preset: "image", accept: [] },
}
```

Configure the store with a media lookup that returns the test asset. Verify:

- create succeeds with valid image id
- create fails when a required file field is missing, `null`, or an empty string
- create fails with non-image id
- update fails with missing media id
- optional file fields with `required: false` accept missing, `null`, and empty string values as unset, skip media lookup, and do not fail
- helper and Zod default ids are validated when they are applied to the write payload

**Step 4: Run failing tests**

```bash
bun test --cwd apps/server ./src/lib/content-api/media-field-validation.test.ts ./src/lib/content-api.test.ts
```

Expected: fail because helper and store wiring do not exist.

Do not implement in this task.

---

### Task 6: Implement Server File Field Write Validation

**Files:**
- Create: `apps/server/src/lib/content-api/media-field-validation.ts`
- Modify: `apps/server/src/lib/content-api/types.ts`
- Modify: `apps/server/src/lib/content-api/database-store.ts`
- Modify: `apps/server/src/lib/content-api/in-memory-store.ts`
- Modify: `apps/server/src/lib/runtime-with-modules.ts`
- Modify: `apps/server/src/lib/content-api-test-support.ts`
- Modify: tests from Task 5

**Step 1: Add lookup type**

In `types.ts`:

```ts
export type ContentMediaAssetLookup = (
  scope: ContentScope,
  id: string,
) => Promise<MediaAsset | undefined>;
```

Import `MediaAsset` from `@mdcms/shared`.

Add optional `lookupMediaAsset?: ContentMediaAssetLookup` to `CreateDatabaseContentStoreOptions` and `CreateInMemoryContentStoreOptions`.

**Step 2: Implement helper**

`media-field-validation.ts` exports:

```ts
export async function validateMediaFieldIdentities(input: {
  schema: SchemaRegistryTypeSnapshot;
  frontmatter: Record<string, unknown>;
  scope: ContentScope;
  lookupMediaAsset?: ContentMediaAssetLookup;
}): Promise<void>
```

It walks object/array fields recursively using the pattern from `reference-validation.ts`, but validates `field.file` entries.

Run validation on schema-normalized/default-applied frontmatter when that object
is available from the write path. If the write path only has raw frontmatter,
explicitly apply file helper required/default semantics before media lookup so
missing, `null`, and empty string required values fail and defaults are validated
after they are applied.

If schema contains file fields and no lookup is configured, throw:

```ts
new RuntimeError({
  code: "MEDIA_ASSET_LOOKUP_UNAVAILABLE",
  message: "Media asset lookup is unavailable for schema file field validation.",
  statusCode: 500,
  details: { field: fieldPath },
});
```

Validation failure helper:

```ts
type MediaFieldValidationReason =
  | "MEDIA_REQUIRED"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_TYPE_MISMATCH";

new RuntimeError({
  code: "INVALID_INPUT",
  message: `Field "${fieldPath}" must reference a media asset matching this file field.`,
  statusCode: 400,
  details: {
    field: fieldPath,
    mediaAssetId,
    reason,
    expectedMime,
    actualMimeType,
  },
});
```

**Step 3: Implement MIME matching helpers**

Export pure helpers for tests:

```ts
export function normalizeMimeType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

export function mediaAssetMatchesFileField(
  asset: Pick<MediaAsset, "mimeType">,
  file: MdcmsFileFieldMetadata,
): boolean
```

Preset checks run before `accept` checks.

**Step 4: Wire stores**

In create/update paths of both database and in-memory stores, call both:

```ts
await validateReferenceFieldIdentities(...);
await validateMediaFieldIdentities({
  schema,
  frontmatter,
  scope,
  lookupMediaAsset,
});
```

In runtime, create `mediaStore` before `contentStore`, then pass:

```ts
lookupMediaAsset: (scope, id) => mediaStore.getAsset(scope, id)
```

**Step 5: Run tests**

```bash
bun test --cwd apps/server ./src/lib/content-api/media-field-validation.test.ts ./src/lib/content-api.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add apps/server/src/lib/content-api/media-field-validation.ts apps/server/src/lib/content-api/media-field-validation.test.ts apps/server/src/lib/content-api/types.ts apps/server/src/lib/content-api/database-store.ts apps/server/src/lib/content-api/in-memory-store.ts apps/server/src/lib/runtime-with-modules.ts apps/server/src/lib/content-api-test-support.ts apps/server/src/lib/content-api.test.ts apps/server/src/lib/content-api/database-store.test.ts
git commit -m "feat(server): validate schema file field assets"
```

---

### Task 7: Add Server Tests For File Field Read Expansion And Raw Mode

**Files:**
- Create: `apps/server/src/lib/content-api/media-field-expansion.ts`
- Create: `apps/server/src/lib/content-api/media-field-expansion.test.ts`
- Modify: `apps/server/src/lib/content-api.test.ts`
- Modify: `packages/shared/src/lib/contracts/content-api.ts`
- Modify: `packages/shared/src/lib/contracts/content-api.test.ts`

**Step 1: Extend content resolve error test expectations**

In `content-api.ts`, plan a discriminated union:

```ts
export type ContentMediaResolveError = {
  code: "MEDIA_NOT_FOUND" | "MEDIA_TYPE_MISMATCH";
  message: string;
  media: {
    assetId: string;
    expectedMime?: string[];
    actualMimeType?: string;
  };
};
```

Then:

```ts
export type ContentResolveError =
  | ContentReferenceResolveError
  | ContentMediaResolveError;
```

Write tests against this shape.

**Step 2: Write expansion helper tests**

Cover:

- top-level image id expands to `MediaAsset`
- `fileFields=raw` leaves id string unchanged
- `fileFields=raw` preserves missing, `null`, and empty string representations for optional unset file fields
- expanded/default mode returns `null` for missing, `null`, and empty string optional unset file fields without adding `resolveErrors`
- missing asset becomes `null` and records `MEDIA_NOT_FOUND`
- wrong MIME becomes `null` and records `MEDIA_TYPE_MISMATCH`
- nested object file fields expand with path `frontmatter.hero.image`
- arrays can expand structurally even though Studio only edits single top-level fields
- unresolved reads do not mutate the original document object

**Step 3: Write route tests**

In `content-api.test.ts`, add route tests:

- `GET /api/v1/content/:id` expands by default.
- `GET /api/v1/content/:id?fileFields=raw` returns raw id.
- `GET /api/v1/content?type=Article` expands by default.
- Studio-style `draft=true&fileFields=raw` returns raw id.
- Invalid `fileFields=banana` returns `INVALID_QUERY_PARAM`.
- `POST /api/v1/content?fileFields=raw` returns raw file ids in the created document, and omitted `fileFields` expands by default.
- `PUT /api/v1/content/:id?fileFields=raw` returns raw file ids in the updated document, and omitted `fileFields` expands by default.
- `POST /api/v1/content/:id/duplicate` applies `fileFields` to the returned document.
- `POST /api/v1/content/:id/duplicate` requires `x-mdcms-schema-hash` and returns `SCHEMA_HASH_REQUIRED` when missing.
- `POST /api/v1/content/:id/duplicate` returns `SCHEMA_NOT_SYNCED` when the target scope has no synced schema.
- `POST /api/v1/content/:id/duplicate` returns `SCHEMA_HASH_MISMATCH` when the supplied hash does not match.
- `POST /api/v1/content/bulk` applies `fileFields` only to succeeded `results[].document` values.
- `POST /api/v1/content/bulk` with omitted `fileFields` expands succeeded `results[].document` values by default.
- At least one lifecycle or restore route that returns a document, such as publish or restore, applies `fileFields` to the returned document.

**Step 4: Run failing tests**

```bash
bun test --cwd apps/server ./src/lib/content-api/media-field-expansion.test.ts ./src/lib/content-api.test.ts
```

Expected: fail because expansion/raw mode does not exist.

Do not implement in this task.

---

### Task 8: Implement Content API File Field Expansion

**Files:**
- Create: `apps/server/src/lib/content-api/media-field-expansion.ts`
- Modify: `apps/server/src/lib/content-api/routes.ts`
- Modify: `apps/server/src/lib/content-api/types.ts`
- Modify: `packages/shared/src/lib/contracts/content-api.ts`
- Modify: tests from Task 7

**Step 1: Add query type**

In `ContentListQuery`, add:

```ts
fileFields?: string;
```

In routes, parse:

```ts
type FileFieldReadMode = "expanded" | "raw";
```

Accepted values:

- omitted: `expanded`
- `expanded`
- `raw`

Invalid values throw `INVALID_QUERY_PARAM`.

**Step 2: Implement expansion helper**

`applyMediaFieldExpansion(input)` takes:

```ts
{
  schema: SchemaRegistryTypeSnapshot | undefined;
  document: TDocument & { frontmatter: Record<string, unknown> };
  scope: ContentScope;
  lookupMediaAsset?: ContentMediaAssetLookup;
  mode: "expanded" | "raw";
}
```

Rules:

- If mode is raw, return document unchanged.
- Raw mode preserves persisted optional unset representations: missing fields stay missing, `null` stays `null`, and empty strings stay empty strings.
- If schema missing or no file fields, return document unchanged.
- If lookup missing and schema has file fields, fail closed with 500.
- Expanded/default mode returns `null` for missing, `null`, and empty string optional unset file fields and does not add `resolveErrors`.
- Clone `frontmatter` before modifications.
- Merge media resolve errors into existing `resolveErrors`.

**Step 3: Apply in routes**

Before returning documents from content endpoints, run:

1. `stripUnknownFrontmatterFields(...)`
2. `applyMediaFieldExpansion(...)`
3. `applyResolvePlan(...)` for explicit reference `resolve` paths

Use the same mode for list/get/version/write responses. Studio and CLI will pass `fileFields=raw`.

**Step 4: Wire media lookup into mount options**

Add `lookupMediaAsset?: ContentMediaAssetLookup` to `MountContentApiRoutesOptions`.

Pass it from `runtime-with-modules.ts`:

```ts
lookupMediaAsset: (scope, id) => mediaStore.getAsset(scope, id)
```

Update test support to accept fake lookup.

**Step 5: Run tests**

```bash
bun test --cwd apps/server ./src/lib/content-api/media-field-expansion.test.ts ./src/lib/content-api.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add apps/server/src/lib/content-api/media-field-expansion.ts apps/server/src/lib/content-api/media-field-expansion.test.ts apps/server/src/lib/content-api/routes.ts apps/server/src/lib/content-api/types.ts apps/server/src/lib/runtime-with-modules.ts apps/server/src/lib/content-api-test-support.ts apps/server/src/lib/content-api.test.ts packages/shared/src/lib/contracts/content-api.ts packages/shared/src/lib/contracts/content-api.test.ts
git commit -m "feat(server): expand schema file fields on reads"
```

---

### Task 9: Update CLI Pull/Push To Request Raw File Fields

**Files:**
- Modify: `apps/cli/src/lib/pull.ts`
- Modify: `apps/cli/src/lib/pull.test.ts`
- Modify: `apps/cli/src/lib/push.ts`
- Modify: `apps/cli/src/lib/validate.ts`
- Modify: `apps/cli/src/lib/validate.test.ts`

**Step 1: Write failing pull tests**

Find the content list/get request assertions. Add expectation that CLI read requests include:

```text
fileFields=raw
```

for pull/list operations that serialize frontmatter to local files.

Add a regression test where the mock server returns raw id:

```yaml
primaryImage: 07ebb057-eeab-4849-94e4-2162cb921c8e
```

and assert the pulled frontmatter remains the id string.

**Step 2: Write validation tests**

In `validate.test.ts`, add a schema field:

```ts
primaryImage: {
  kind: "string",
  required: true,
  nullable: false,
  file: { preset: "image", accept: [] },
}
```

Assert local id strings validate as strings and expanded objects fail as wrong kind.

**Step 3: Run failing CLI tests**

```bash
bun test --cwd apps/cli ./src/lib/pull.test.ts ./src/lib/validate.test.ts
```

Expected: fail because pull does not request raw file fields.

**Step 4: Implement raw query**

In every CLI content read used for local file serialization, add `fileFields=raw`.

Do not add raw mode to SDK read client defaults; SDK should receive expanded file fields by default.

**Step 5: Run tests**

```bash
bun test --cwd apps/cli ./src/lib/pull.test.ts ./src/lib/validate.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add apps/cli/src/lib/pull.ts apps/cli/src/lib/pull.test.ts apps/cli/src/lib/push.ts apps/cli/src/lib/validate.ts apps/cli/src/lib/validate.test.ts
git commit -m "fix(cli): pull raw schema file field ids"
```

---

### Task 10: Add Studio API Support For File Field Controls

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/lib/media-library-api.ts`
- Modify: `packages/studio/src/lib/runtime-ui/lib/media-library-api.test.ts`
- Modify: `packages/studio/src/lib/document-route-api.ts`
- Modify: `packages/studio/src/lib/document-route-api.test.ts`

**Step 1: Add failing media API tests**

Add tests for:

```ts
api.get("07ebb057-eeab-4849-94e4-2162cb921c8e")
```

expecting `GET /api/v1/media/:id` with project/environment headers.

**Step 2: Implement `get`**

In `StudioMediaLibraryApi`:

```ts
get: (id: string) => Promise<MediaAsset>;
```

Use `assertMediaAssetResponse`.

**Step 3: Add failing document route API tests**

Ensure Studio document read and save paths send `fileFields=raw` on:

- draft load
- save draft PUT response
- version restore response if it updates current editable document state

**Step 4: Implement raw query**

Update document route URL builders to append `fileFields=raw` for authoring document calls.

**Step 5: Run tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-library-api.test.ts ./src/lib/document-route-api.test.ts
```

Expected: pass.

**Step 6: Commit**

```bash
git add packages/studio/src/lib/runtime-ui/lib/media-library-api.ts packages/studio/src/lib/runtime-ui/lib/media-library-api.test.ts packages/studio/src/lib/document-route-api.ts packages/studio/src/lib/document-route-api.test.ts
git commit -m "feat(studio): request raw file fields for editing"
```

---

### Task 11: Add Studio File Field Descriptor Tests

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`

**Step 1: Write failing descriptor tests**

Add tests in `content-document-page.test.tsx` or existing state tests for schema field:

```ts
primaryImage: {
  kind: "string",
  required: false,
  nullable: true,
  file: { preset: "image", accept: [] },
}
```

Assert `getPropertyDescriptors` returns:

```ts
{
  status: "editable",
  control: {
    kind: "file",
    value: "07ebb057-eeab-4849-94e4-2162cb921c8e",
    preset: "image",
    accept: [],
    canUnset: true,
  },
}
```

Assert expanded object values are not accepted for editing state; Studio should have requested raw mode.

**Step 2: Run failing tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: fail because property controls do not include `file`.

**Step 3: Implement descriptor support**

Extend `ContentDocumentPropertyControl`:

```ts
| {
    kind: "file";
    value: string | undefined;
    preset: "image" | "video" | "file";
    accept: string[];
    canUnset: boolean;
  }
```

Add:

```ts
function canEditFileField(value: unknown): value is string | undefined | null
```

In `resolvePropertyDescriptor`, check `field.file` before generic string handling.

Update `describePropertyFieldType`:

```ts
if (field.file) return `file:${field.file.preset}`;
```

**Step 4: Run tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

**Step 5: Commit**

```bash
git add packages/studio/src/lib/runtime-ui/pages/content-document-page-state.ts packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx
git commit -m "feat(studio): recognize schema file properties"
```

---

### Task 12: Implement Studio File Field Picker UI

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`
- Optionally create: `packages/studio/src/lib/runtime-ui/components/editor/media-field-picker.tsx`
- Optionally create: `packages/studio/src/lib/runtime-ui/components/editor/media-field-picker.test.tsx`

**Step 1: Write failing render tests**

Render a ready document page with:

- schema file field `primaryImage`
- raw frontmatter id
- media read/upload capabilities true
- mock media API returning an image asset

Assert:

- property editor marker is `data-mdcms-property-editor="file"`
- image filename appears after asset load
- replace/select button appears when writable
- unset button appears for optional fields

Add permission tests:

- no media read: browse button disabled or unavailable message rendered
- no media upload: upload button hidden/disabled
- read-only document: no mutation buttons

**Step 2: Run failing tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: fail because no UI renders file controls.

**Step 3: Implement UI component**

Component props:

```ts
type MediaFieldControlProps = {
  fieldName: string;
  value: string | undefined;
  file: { preset: "image" | "video" | "file"; accept: string[] };
  canUnset: boolean;
  readOnly: boolean;
  canReadMedia: boolean;
  canUploadMedia: boolean;
  mediaLibraryApi: StudioMediaLibraryApi | null;
  mediaUploadApi: StudioMediaUploadApi | null;
  onChange: (value: string | undefined | null) => void;
};
```

Use `mediaLibraryApi.get(value)` to load the selected asset preview.

Use existing media preview conventions:

- image: `<img src={asset.url} alt="" />`
- video: `<video src={asset.url} controls preload="metadata" />`
- other: filename/MIME placeholder

**Step 4: Implement picker behavior**

Picker flow:

- Open popover/dialog from the field control.
- List assets with `category=image` for image preset, `category=video` for video preset, otherwise no category or derived category when accept is a single wildcard.
- Client-filter returned assets with `mediaAssetMatchesFileField` equivalent logic in Studio.
- Selecting an asset calls `onChange(asset.id)`.
- Upload uses existing upload API, then validates uploaded asset against field constraints before setting id. Invalid uploaded asset remains in the library but is not assigned.

Keep this component scoped; do not refactor the body editor picker unless needed.

**Step 5: Wire into `SidebarPropertiesTab`**

Add render branch:

```tsx
{descriptor.control.kind === "file" ? (
  <MediaFieldControl ... />
) : null}
```

Use existing `onFrontmatterFieldChange`.

**Step 6: Run tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

**Step 7: Commit**

```bash
git add packages/studio/src/lib/runtime-ui/pages/content-document-page.tsx packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx packages/studio/src/lib/runtime-ui/components/editor/media-field-picker.tsx packages/studio/src/lib/runtime-ui/components/editor/media-field-picker.test.tsx
git commit -m "feat(studio): edit schema file fields with media picker"
```

If the optional component files were not created, omit them from `git add`.

---

### Task 13: Remove Media Settings Allowlist Copy

**Files:**
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx`
- Modify: `packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx`

**Step 1: Write/update tests**

Change assertions that currently expect:

```text
No file-type allowlist
```

to assert it is absent:

```ts
assert.doesNotMatch(markup, /No file-type allowlist/i);
```

Add/keep an assertion for useful replacement copy:

```text
Infrastructure and proxy limits can still reject uploads before MDCMS sees them.
```

**Step 2: Implement copy removal**

In `settings-media-panel.tsx`, remove the sentence:

```tsx
No file-type allowlist is enforced. The configured limit applies only when ...
```

Replace with concise setting-specific text:

```tsx
This setting only controls the application-level byte cap for image uploads.
```

Keep the infrastructure/proxy caveat.

**Step 3: Run tests**

```bash
bun test --cwd packages/studio ./src/lib/runtime-ui/app/admin/settings-page.test.tsx ./src/lib/runtime-ui/pages/content-document-page.test.tsx
```

Expected: pass.

**Step 4: Commit**

```bash
git add packages/studio/src/lib/runtime-ui/app/admin/settings-media-panel.tsx packages/studio/src/lib/runtime-ui/app/admin/settings-page.test.tsx packages/studio/src/lib/runtime-ui/pages/content-document-page.test.tsx
git commit -m "fix(studio): remove media allowlist copy"
```

---

### Task 14: Update SDK And Studio Review Compatibility

**Files:**
- Modify: `packages/sdk/src/lib/sdk.test.ts`
- Modify: `packages/sdk/README.md`
- Inspect and modify as needed: `apps/studio-review/**`

**Step 1: SDK tests**

Add one SDK test showing default content reads do not request `fileFields=raw`.

Expected: SDK receives expanded frontmatter objects unchanged as part of `ContentDocumentResponse`.

**Step 2: SDK docs**

Add a short README note:

```md
Schema file fields are expanded to `MediaAsset` objects by default. Write-capable tooling uses raw mode internally; SDK reads keep the expanded read model.
```

**Step 3: Studio review app audit**

Run:

```bash
rg -n "ContentDocumentResponse|resolvedSchema|reference|frontmatter|media" apps/studio-review
```

If fixtures include schema snapshots or content documents, add file metadata examples or update reference imports as needed.

**Step 4: Run tests**

```bash
bun test --cwd packages/sdk ./src
```

If `apps/studio-review` has a package test target, run its relevant tests. If it has no tests or no relevant files, note that in the final verification.

**Step 5: Commit**

```bash
git add packages/sdk/src/lib/sdk.test.ts packages/sdk/README.md apps/studio-review
git commit -m "docs(sdk): document expanded schema file fields"
```

If `apps/studio-review` had no changes, omit it from `git add`.

---

### Task 15: Add Release Changeset

**Files:**
- Generated by `bun run changeset`

**Step 1: Run changeset CLI**

Because this touches published package source and manifests, run:

```bash
bun run changeset
```

Select changed packages:

- `@mdcms/shared`
- `@mdcms/cli`
- `@mdcms/studio`
- `@mdcms/sdk` if README or runtime types changed

Use a minor bump if the CLI/shared public API removal is treated as beta feature evolution; use major only if the current release policy requires it despite beta status.

Suggested summary:

```text
Add schema file field types under fieldTypes, move references to fieldTypes.reference, and expand file fields to media assets on reads.
```

**Step 2: Commit**

```bash
git add .changeset
git commit -m "chore: add schema file fields changeset"
```

Do not hand-write changeset files.

---

### Task 16: Final Verification

**Files:**
- No edits unless verification reveals failures.

**Step 1: Run targeted tests**

```bash
bun test --cwd packages/shared ./src/lib/contracts/config.test.ts ./src/lib/contracts/schema.test.ts ./src/lib/contracts/content-api.test.ts
bun test --cwd apps/server ./src/lib/content-api/media-field-validation.test.ts ./src/lib/content-api/media-field-expansion.test.ts ./src/lib/content-api.test.ts
bun test --cwd apps/cli ./src/lib/init/generate-config.test.ts ./src/lib/init/infer-schema.test.ts ./src/lib/pull.test.ts ./src/lib/validate.test.ts
bun test --cwd packages/studio ./src/lib/runtime-ui/lib/media-library-api.test.ts ./src/lib/document-route-api.test.ts ./src/lib/runtime-ui/pages/content-document-page.test.tsx ./src/lib/runtime-ui/app/admin/settings-page.test.tsx
bun test --cwd packages/sdk ./src
```

Expected: all pass.

**Step 2: Run workspace checks**

```bash
bun run format:check
bun run check
```

Expected: pass.

If either command fails due unrelated pre-existing files, capture exact output and run the narrowest relevant package checks instead. Do not modify unrelated files.

**Step 3: Inspect diff**

```bash
git status --short
git diff --stat main...HEAD
git diff --check
```

Expected:

- only intended tracked changes are staged/committed
- no whitespace errors
- unrelated untracked files remain untouched

**Step 4: Final commit if fixes were needed**

If verification required fixes:

```bash
git add <specific changed files>
git commit -m "fix(schema): stabilize file field integration"
```

Do not create an empty commit.

---

## Execution Notes

- Use `superpowers:test-driven-development` for implementation tasks that add behavior.
- Use `superpowers:systematic-debugging` if any new or existing test fails unexpectedly.
- Use `superpowers:verification-before-completion` before claiming the branch is complete.
- For independent implementation areas, use `superpowers:subagent-driven-development` and dispatch separate subagents for shared contracts, server, CLI, and Studio once Task 1 is complete.
