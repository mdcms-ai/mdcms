# Schema File Fields Design

## Context

MDCMS now has project-scoped media assets, a Studio media library, editor media insertion, and media upload APIs. Content schemas still have no first-class way to describe a frontmatter field whose value is a media asset. Developers currently model these fields as plain strings, which gives Studio no way to render a media picker and gives the server no way to validate asset existence or MIME constraints.

This design adds a built-in schema field type family for single media asset fields. The field stores a media asset id in persisted content and local Markdown frontmatter, while normal content API reads expand the id to the matching `MediaAsset` object by default.

## Goals

- Give developers an ergonomic built-in field API for media-backed file fields.
- Keep local Markdown files and write payloads simple: a file field value is a media asset id string.
- Validate file field writes against existing project media metadata.
- Let schema authors restrict file fields by preset and MIME accept patterns.
- Render file fields in Studio as media picker controls instead of raw text inputs.
- Move references into the same `fieldTypes` namespace and remove the old top-level `reference()` API as a beta breaking change.
- Remove the confusing media settings copy that described the absence of a file-type allowlist.

## Non-Goals

- No arrays, galleries, or multiple file selection for schema fields in this iteration.
- No new media metadata such as alt text, tags, folders, usage references, dimensions, or transformations.
- No schema-driven upload allowlist. Uploads remain unrestricted at the media API layer; file field validation applies when assigning an asset to a content field.
- No new media endpoint is required for validation; existing media metadata lookup is enough.
- No change to body editor Markdown image insertion behavior.

## Authoring API

Developers import `fieldTypes` from `@mdcms/cli` or `@mdcms/shared`:

```ts
import { defineConfig, defineType, fieldTypes } from "@mdcms/cli";
import { z } from "zod";

export default defineConfig({
  project: "marketing-site",
  serverUrl: "http://localhost:4000",
  types: [
    defineType("Article", {
      directory: "content/articles",
      fields: {
        title: z.string().min(1),
        author: fieldTypes.reference("Author"),
        primaryImage: fieldTypes.image().optional(),
        heroVideo: fieldTypes.video({
          accept: ["video/mp4", "video/webm"],
        }).optional(),
        attachment: fieldTypes.file({
          accept: ["application/pdf"],
        }).optional(),
      },
    }),
  ],
});
```

The supported helpers are:

- `fieldTypes.reference(targetType)` for document references.
- `fieldTypes.image(options?)` for assets whose MIME type starts with `image/`.
- `fieldTypes.video(options?)` for assets whose MIME type starts with `video/`.
- `fieldTypes.file(options?)` for any asset, optionally narrowed by `accept`.

`fieldTypes.audio()` is intentionally not included. Audio files are represented with `fieldTypes.file({ accept: ["audio/*"] })` when needed.

`accept` accepts only MIME strings or MIME wildcards such as `image/png`, `application/pdf`, or `video/*`. It does not accept category names. Empty strings, invalid MIME-like values, and category labels fail config parsing or schema serialization.

Top-level `reference()` is removed from public exports. This is a breaking beta change. Generated configs, docs, examples, and public skills must use `fieldTypes.reference()`.

## Schema Snapshot

File fields are represented as Zod strings with MDCMS metadata, matching the current reference-field pattern. The persisted value is a string, so optional, nullable, default, and string checks continue to compose through existing Zod wrappers where supported.

`SchemaRegistryFieldSnapshot` gains optional `file` metadata:

```ts
type SchemaRegistryFieldSnapshot = {
  kind: string;
  required: boolean;
  nullable: boolean;
  default?: JsonValue;
  reference?: { targetType: string };
  file?: {
    preset: "image" | "video" | "file";
    accept: string[];
  };
  checks?: JsonObject[];
  item?: SchemaRegistryFieldSnapshot;
  fields?: Record<string, SchemaRegistryFieldSnapshot>;
  options?: JsonValue[];
};
```

File metadata can appear on string fields. Arrays and objects can contain file fields structurally, but Studio only needs to edit top-level single-value file fields in this iteration.

## Write Validation

Content write validation treats file fields similarly to reference identity validation:

- Missing or `null` values follow the existing required/nullable/default rules.
- Present values must be non-empty strings.
- The value is a media asset id.
- The asset must exist in the routed project. Media remains project-scoped; the routed environment participates in auth/routing but not media ownership.
- `fieldTypes.image()` requires `mimeType` to start with `image/`.
- `fieldTypes.video()` requires `mimeType` to start with `video/`.
- `fieldTypes.file()` accepts any MIME type unless `accept` is provided.
- `accept` narrows the preset. Exact MIME values match case-insensitively after trimming MIME parameters; wildcard values match by prefix before `/`.

Failures use `INVALID_INPUT` (`400`) with `details.field = "frontmatter.<field>"` so Studio can attach errors to the property control.

## Read Model

Persisted content, local files, CLI pull/push, and write payloads use raw id strings. Normal content API reads expand file fields by default:

```json
{
  "frontmatter": {
    "primaryImage": {
      "id": "07ebb057-eeab-4849-94e4-2162cb921c8e",
      "project": "marketing-site",
      "filename": "Homepage.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 421888,
      "url": "http://localhost:9000/mdcms-media/...",
      "uploadedBy": "user_1",
      "uploadedAt": "2026-06-09T10:00:00.000Z"
    }
  }
}
```

Authoring clients can request raw file field mode. Raw mode returns the stored string id unchanged and is required for:

- Studio document editing routes, because draft persistence round-trips frontmatter.
- CLI pull/push workflows.
- Any future write-capable client.

If an expanded read cannot resolve an asset, the field value becomes `null` and `resolveErrors["frontmatter.<field>"]` records a deterministic media resolve error. The unresolved persisted id is not rewritten.

## Studio Behavior

Top-level file fields render as editable properties when the document is writable. The control:

- Shows the field label, required marker, field type, and validation errors consistently with other properties.
- Shows an inline asset preview when the selected id can be resolved from media metadata.
- Uses image thumbnail rendering for images, inline video playback for video assets, and a compact file placeholder for other MIME types.
- Opens a media picker filtered by the file field preset and `accept` constraints.
- Stores the selected asset id in draft frontmatter.
- Supports replace when `capabilities.media.read` is available.
- Supports upload when `capabilities.media.upload` is available.
- Supports unset when the schema field is optional or nullable.

If the user lacks media read permission, the control remains visible but cannot browse the library. If the user lacks media upload permission, the upload affordance is hidden or disabled. If the document is read-only or viewing a historical version, the control is read-only.

The picker should reuse the implemented library-first media selection direction. It must not insert Markdown and must not store a media URL in frontmatter.

## Spec Delta

- `SPEC-004` owns the `fieldTypes` authoring API, schema snapshot metadata, reference API migration, and file field persistence semantics.
- `SPEC-003` owns the content API read/write behavior: default expanded file fields plus explicit raw mode for authoring clients.
- `SPEC-006` owns the Studio file-field property control and the media settings copy removal.
- `SPEC-010` owns the media asset metadata contract used by validation and expansion.

## Testing Strategy

- Shared contract tests cover `fieldTypes` metadata, schema serialization, schema payload validation, hash stability, and top-level `reference()` removal.
- CLI tests cover generated config imports and raw file id preservation in local files.
- Server tests cover write validation, MIME accept matching, default expansion, raw mode, unresolved media errors, and no database mutation on unresolved reads.
- Studio tests cover property descriptor recognition, file picker rendering, permission gates, selecting/uploading assets, preview rendering, and saving raw ids.
- Existing media settings tests update to assert the allowlist copy is gone.

