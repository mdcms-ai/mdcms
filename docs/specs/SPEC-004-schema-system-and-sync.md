---
status: live
canonical: true
created: 2026-03-11
last_updated: 2026-03-31
---

# SPEC-004 Schema System and Sync

This is the live canonical document under `docs/`.

## Schema System

### Schema Definition (Code-First)

Developers define content types in `mdcms.config.ts` using Standard Schema with Zod as the primary validation library. The schema is the developer's main touchpoint with MDCMS. The `project` field in `defineConfig` is required. Localization is configurable per type and does not need to be enabled globally for every project.

```typescript
// mdcms.config.ts
import { defineConfig, defineType, fieldTypes } from "@mdcms/cli";
import { z } from "zod";

export default defineConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",

  contentDirectories: ["content/blog", "content/pages"],

  // Optional. Required if any type sets localized: true.
  locales: {
    default: "en-US",
    supported: ["en-US", "fr", "de"],
    aliases: {
      en_us: "en-US",
      EN: "en-US",
      fr_FR: "fr",
    },
  },

  types: [
    defineType("BlogPost", {
      directory: "content/blog",
      localized: true,
      fields: {
        title: z.string().min(1).max(200),
        slug: z.string().regex(/^[a-z0-9-]+$/),
        excerpt: z.string().max(500).optional(),
        author: fieldTypes.reference("Author"),
        tags: z.array(z.string()).default([]),
        coverImage: z.string().url().optional(),
        publishedAt: z.date().optional(),
      },
    }),

    defineType("Author", {
      directory: "content/authors",
      // Optional. Defaults to false (single-locale/non-localized type).
      localized: false,
      fields: {
        name: z.string(),
        email: z.string().email(),
        bio: z.string().optional(),
        avatar: z.string().url().optional(),
      },
    }),

    defineType("Page", {
      directory: "content/pages",
      fields: {
        title: z.string(),
        description: z.string().optional(),
        order: z.number().int().default(0),
      },
    }),
  ],

  components: [
    {
      name: "Chart",
      importPath: "@/components/mdx/Chart",
      // Props are auto-extracted from TypeScript definitions
    },
    {
      name: "Callout",
      importPath: "@/components/mdx/Callout",
    },
  ],
});
```

**Field type built-ins:**

Schema built-ins are imported through `fieldTypes`:

- `fieldTypes.reference(targetType)` stores an environment-local document id string.
- `fieldTypes.image(options?)` stores a media asset id string and requires `mimeType` to start with `image/`.
- `fieldTypes.video(options?)` stores a media asset id string and requires `mimeType` to start with `video/`.
- `fieldTypes.file(options?)` stores a media asset id string and accepts any media asset unless narrowed by `options.accept`.

`fieldTypes.image()`, `fieldTypes.video()`, and `fieldTypes.file()` accept helper options:

```typescript
type FileFieldOptions = {
  accept?: string[];
  required?: boolean;
  default?: string;
};
```

- `accept` is an array of MIME values or MIME wildcards such as `image/png`, `video/*`, or `application/pdf`. It never accepts category labels. `fieldTypes.image()` and `fieldTypes.video()` already set the broad `image/*` or `video/*` preset, and custom `accept` entries further narrow within that family. Incompatible entries such as `fieldTypes.image({ accept: ["application/pdf"] })` are invalid schema config.
- `required` defaults to `true`. Required file fields fail write-time validation when the field is missing, `null`, or an empty string. `required: false` treats missing, `null`, or empty string values as unset; non-empty values still validate as media asset ids.
- `default` is a raw `MediaAsset.id` string applied as the schema default. It is never a URL and never a `MediaAsset` object, and the resulting value must satisfy the helper preset and `accept` narrowing.

```typescript
fields: {
  heroImage: fieldTypes.image({
    accept: ["image/png", "image/jpeg"],
  }),
  productSheet: fieldTypes.file({
    accept: ["application/pdf"],
    required: false,
  }),
  launchVideo: fieldTypes.video({
    accept: ["video/mp4"],
    default: "6f6a8a6e-8d5b-4d5d-a4df-1b2a3c4d5e6f",
  }),
}
```

`fieldTypes.reference()` is the canonical reference helper. The previous top-level `reference()` helper is removed in this beta contract rather than retained as an alias or deprecation path.

**Localization config contract:**

- `locales` is optional in `defineConfig`.
- If present, `locales` has shape:

```typescript
type LocaleConfig = {
  default: string;
  supported: string[];
  aliases?: Record<string, string>;
};
```

- Locale tags use BCP 47 syntax (for example, `en`, `en-US`, `pt-BR`, `zh-Hant-TW`).
- Canonical normalization is applied before comparison and persistence: trim whitespace, convert `_` to `-`, then normalize casing to canonical BCP 47 form.
- `defineType(..., { localized?: boolean })` controls localization per type. Default is `localized: false`.
- If any type has `localized: true`, explicit `locales` config is required.
- `locales.default` must be included in `locales.supported`.
- `locales.supported` must not include the reserved token `__mdcms_default__`.
- `locales.aliases` keys and values are normalized and validated as locale tags; each alias value must resolve to an entry in `locales.supported`.
- If `locales` is omitted, MDCMS runs in implicit single-locale mode: effective supported locales are `[ "__mdcms_default__" ]`, and effective default locale is `__mdcms_default__`.

### Schema Sync (Explicit Actions → Server)

Schema is code-first and `mdcms.config.ts` is the source of truth. The Studio has no manual schema editor and cannot author schema changes.

Schema updates are persisted to the backend schema registry only through explicit sync actions that upload the local config snapshot:

- `cms schema sync` uploads the current schema snapshot and resolved per-environment schemas.
- Studio may trigger the same sync operation as a developer convenience action (for example, a "Sync Schema" button in Settings) for privileged users (Owner/Admin). It only forwards the local `mdcms.config.ts` snapshot; it does not create or edit schema definitions in the UI.
- `cms migrate` is used only when existing content must be transformed/backfilled to satisfy schema changes.
- CI/CD pipelines should run `cms schema sync` before deploy-time writes.
- The backend does not read `mdcms.config.ts` from the host app repo at request time. Sync publishes the config-derived backend state needed for schema and environment operations.

**Registry model:**

- The schema registry stores the latest synced state per `(project, environment)`.
- The read surface is type-centric: `GET /schema` returns one entry per content type for the target environment.
- The server persists:
  - one environment-level sync record containing `schemaHash`, `rawConfigSnapshot`, and `syncedAt`
  - one project-level environment topology snapshot derived from `rawConfigSnapshot`, containing the latest synced environment names and `extends` graph for the project
  - derived per-type registry entries for the target environment

**Snapshot fidelity limitation:**

- Registry payloads are descriptive JSON snapshots, not executable validator objects.
- They are suitable for hash comparison, mismatch detection, read-only schema display, and future introspection.
- They are not a lossless representation of arbitrary Zod or Standard Schema runtime behavior.
- Unsupported or unserializable validator features fail closed with `INVALID_INPUT` during schema sync.

### Schema UI Sync

The CMS UI displays the current schema in a read-only view. Non-developer users (content editors, managers) can see the content structure but cannot modify it directly. Schema changes are always code-first.

Future consideration: Allow non-dev users to propose schema changes that generate pull requests or config updates.

### Per-Environment Schema Overlays

Environments can have different schemas. The config file uses a **base schema + overlay** pattern: a base schema shared by all environments, with explicit per-environment extensions.

**Design principles:**

- The base schema defines the production-ready fields
- Environment overlays can **add** fields, **modify** field validators, or **omit** fields
- Field-level `.env()` annotations provide sugar for the common "add-only" case
- The config file is the single source of truth for all environment schemas — no separate files per environment
- The config file is also the source of truth for valid environment names and `extends` inheritance chains used by runtime environment management APIs

**Example:**

```typescript
// mdcms.config.ts
import { defineConfig, defineType, fieldTypes } from "@mdcms/cli";
import { z } from "zod";

const blogPost = defineType("BlogPost", {
  directory: "content/blog",
  fields: {
    title: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    author: fieldTypes.reference("Author"),
    tags: z.array(z.string()).default([]),
    // Field-level sugar: this field only exists in staging and preview
    featured: z.boolean().default(false).env("staging", "preview"),
    // This field only exists in preview
    abTestVariant: z.enum(["control", "a", "b"]).optional().env("preview"),
  },
});

export default defineConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",
  types: [blogPost],

  environments: {
    production: {
      // No overrides — uses the base schema (fields without .env() annotations)
    },
    staging: {
      types: {
        // Explicit overlay for complex modifications (alternative to .env() sugar)
        BlogPost: blogPost.extend({
          modify: {
            // In staging, tags are required (stricter validation for testing)
            tags: z.array(z.string()).min(1),
          },
        }),
      },
    },
    preview: {
      // preview inherits staging's overrides and adds more
      extends: "staging",
    },
  },
});
```

**How `.env()` sugar works internally:** The config resolver expands `.env('staging', 'preview')` into overlay `add` blocks for those environments. It's equivalent to writing explicit `extend({ add: { ... } })` blocks but more concise for the common case of gating a field to specific environments.

**Overlay operations:**

| Operation | Use Case                                                   | Example                                                    |
| --------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `add`     | New field in specific environments                         | `extend({ add: { featured: z.boolean() } })`               |
| `modify`  | Change validation rules per environment                    | `extend({ modify: { tags: z.array(z.string()).min(1) } })` |
| `omit`    | Remove a field from specific environments                  | `extend({ omit: ['legacyField'] })`                        |
| `.env()`  | Sugar for `add` — field only exists in listed environments | `z.boolean().env('staging')`                               |

**Environment inheritance:** Environments can extend other environments via `extends`, creating a chain (e.g., `production → staging → preview`). Each level only specifies its incremental changes.

**Runtime environment provisioning:** The environments API provisions and removes project-local database rows for environments, but it does not author schema topology. Runtime environment records must correspond to names defined in the latest synced project environment topology snapshot derived from `mdcms.config.ts`. The backend does not require direct filesystem access to the host app repo at request time; request-time validation uses the most recent successful sync state.

**Validation per environment:** When content is read or written, the server validates against the **target environment's resolved schema**. Fields that exist in one environment but not another are silently stripped from API responses (Zod's default `strip` behavior). Data is preserved in the database — it's just invisible at the API layer for environments whose schema doesn't include that field.

**Studio UI:** Environment-specific fields are visually marked in the editor (e.g., a "staging only" badge). This prevents editor confusion when a field is visible in staging but not in production.

**Schema promotion workflow:**

1. Add a field with `.env('staging')` — test it in staging
2. When ready, remove the `.env()` annotation — the field is now in the base schema (all environments)
3. Run `cms migrate` to backfill the field in production content

### Schema Sync Behavior Per Environment

Inspired by Payload CMS's dev/prod split:

- **All environments:** Schema writes are explicit via `cms schema sync` (and `cms migrate` when data backfill is required). Studio can only run an explicit user-triggered sync action that sends the same schema snapshot payload.
- **Mismatch behavior:** If Studio's local config hash differs from the server schema hash, Studio shows a banner ("Schema changes detected, run `cms schema sync`"), switches to read-only mode, and blocks content writes until schemas match.
- **Content write gate:** `POST /api/v1/content` and `PUT /api/v1/content/:documentId` require the `x-mdcms-schema-hash` header. Missing or blank values fail with `SCHEMA_HASH_REQUIRED` (`400`), a missing target sync record fails with `SCHEMA_NOT_SYNCED` (`409`), and a non-matching client/server hash fails with `SCHEMA_HASH_MISMATCH` (`409`).

This ensures schemas only change through deliberate, reviewable actions.

### Local Schema State File

`cms schema sync` persists a local schema state file after each successful sync. This file is the canonical source of `x-mdcms-schema-hash` for all CLI and SDK write operations (see ADR-006).

**Location:** `.mdcms/schema/<project>.<environment>.json`

```json
{
  "schemaHash": "<hash>",
  "syncedAt": "<ISO 8601>",
  "serverUrl": "<url>"
}
```

- Written atomically using the write-temp-then-rename pattern.
- One file per `(project, environment)` tuple.
- `.gitignore`d — local to each developer's machine, not a shared artifact.
- The file is written by `cms schema sync` and by `cms push` when its bundled preflight performs a sync (interactive prompt acceptance or `--sync-schema` flag in non-interactive mode, see SPEC-008 and ADR-006). Both paths use the same `performSchemaSync` helper with identical atomic-write semantics, so file invariants are preserved regardless of the entry point.
- Write clients (`cms push`, future SDK write methods) read the `schemaHash` value from this file and send it as the `x-mdcms-schema-hash` header. If the file does not exist, `cms push` applies the same interactive/non-interactive sync flow used for schema drift (see SPEC-008): in TTY mode it prompts to sync; in non-interactive mode it fails closed unless `--sync-schema` is supplied. A successful sync creates the file before any content writes proceed.

### Reference Field Identity

`fieldTypes.reference('Type')` fields store the target document's environment-local `document_id` string. The persisted value is a plain UUID string, not a `{$ref, type}` object; target type metadata remains schema-owned through `fieldTypes.reference('Type')`. Write-time reference validation failures continue to use `INVALID_INPUT` (`400`); `resolve` remains read-time only.

- Reference resolution is always scoped to the explicit `(project, environment)` request target.
- Clone/promote operations remap references using `translation_group_id + locale`.
- If a reference cannot be remapped, the clone/promote operation fails atomically.

### File Field Identity

`fieldTypes.image()`, `fieldTypes.video()`, and `fieldTypes.file()` fields store a project-scoped media asset id string. The persisted value is never a URL and never a full media object. Write-time validation verifies that the media asset exists in the routed project and that its MIME type satisfies the field preset and `accept` narrowing. Validation failures use `INVALID_INPUT` (`400`) with `details.field` pointing at the frontmatter path.

---

## Project and Environment Management Endpoints

### `GET /api/v1/projects`

- **Auth**: Bearer token, scope `projects:read`
- **Response**: `{ "data": [{ "id": "uuid", "slug": "my-blog", "name": "my-blog", "environmentCount": 3, "createdAt": "ISO8601" }] }`
- Returns projects accessible to the authenticated user.

### `POST /api/v1/projects`

- **Auth**: Bearer token, scope `projects:write`
- **Body**: `{ "name": "awesome-docs" }`
- Slug auto-generated from name. Creates default "production" environment.
- **Response**: `{ "data": { "id": "uuid", "slug": "awesome-docs", "name": "awesome-docs", "environments": [{ "id": "uuid", "name": "production" }] } }`

### `GET /api/v1/projects/:slug/environments`

- **Auth**: Bearer token, scope `projects:read`
- **Response**: `{ "data": [{ "id": "uuid", "name": "production" }, { "id": "uuid", "name": "staging" }] }`

### `POST /api/v1/projects/:slug/environments`

- **Auth**: Bearer token, scope `projects:write`
- **Body**: `{ "name": "development" }`
- **Response**: `{ "data": { "id": "uuid", "name": "development" } }`

## Schema Endpoints

| Method | Endpoint        | Description                                                                                                 |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET`  | `/schema`       | Get all registered content types                                                                            |
| `GET`  | `/schema/:type` | Get schema definition for a specific type                                                                   |
| `PUT`  | `/schema`       | Sync schema snapshot from CLI/CI or explicit Studio sync action (internal; no manual Studio schema editing) |

## Schema Registry Endpoints

All `/api/v1/schema*` endpoints require explicit target routing for `project` and `environment`.

`SchemaRegistryEntry`:

```ts
type SchemaRegistryEntry = {
  type: string;
  directory: string;
  localized: boolean;
  schemaHash: string;
  syncedAt: string;
  resolvedSchema: Record<string, unknown>;
};
```

Notes:

- `schemaHash` and `syncedAt` are repeated on each entry for the target environment.
- `rawConfigSnapshot` is stored with the environment-level sync record and is not returned by `GET` endpoints.
- The latest successful `PUT /api/v1/schema` also refreshes the project-level environment topology snapshot derived from `rawConfigSnapshot`.
- `resolvedSchema` is a descriptive JSON snapshot for the type, not an executable validator.

| Method | Path                   | Auth Mode          | Required Scope | Target Routing                  | Request                                                   | Success                                                                                                  | Deterministic Errors                                                                                                                                                     |
| ------ | ---------------------- | ------------------ | -------------- | ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/v1/schema`       | session_or_api_key | `schema:read`  | required: `project_environment` | explicit routing only                                     | `200` `{ data: { types: SchemaRegistryEntry[], schemaHash: string \| null, syncedAt: string \| null } }` | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`)                                                         |
| GET    | `/api/v1/schema/:type` | session_or_api_key | `schema:read`  | required: `project_environment` | path `type`                                               | `200` `{ data: SchemaRegistryEntry }`                                                                    | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`), `NOT_FOUND` (`404`)                                    |
| PUT    | `/api/v1/schema`       | session_or_api_key | `schema:write` | required: `project_environment` | JSON: `{ rawConfigSnapshot, resolvedSchema, schemaHash }` | `200` `{ data: { schemaHash, syncedAt, affectedTypes } }`                                                | `MISSING_TARGET_ROUTING` (`400`), `TARGET_ROUTING_MISMATCH` (`400`), `INVALID_INPUT` (`400`), `SCHEMA_INCOMPATIBLE` (`409`), `UNAUTHORIZED` (`401`), `FORBIDDEN` (`403`) |

`GET /api/v1/schema` returns `{ types, schemaHash, syncedAt }` where `schemaHash` and `syncedAt` are `null` when the scope has never been synced. `types` is always an array (possibly empty). Read clients use `types`; write clients (e.g. `cms push` schema preflight) use `schemaHash` to detect drift before content writes.

Error split:

- `INVALID_INPUT` (`400`) means the schema sync payload is malformed or cannot be represented in the registry's descriptive JSON model.
- `SCHEMA_INCOMPATIBLE` (`409`) means the payload is valid and serializable, but applying it would conflict with existing content and requires migration before sync can succeed.

Examples of `INVALID_INPUT`:

- unsupported or unserializable validator features such as `.refine()`, `.superRefine()`, `transform`, `preprocess`, arbitrary functions, or non-JSON values
- malformed `resolvedSchema` or `rawConfigSnapshot` payloads

Examples of `SCHEMA_INCOMPATIBLE`:

- removing a type that still has documents in the target environment
- changing localization mode in a way that conflicts with existing documents
- removing a supported locale that still has documents
- introducing a new required field for a type with existing documents
- clearly breaking coarse field-kind changes that would invalidate existing content
