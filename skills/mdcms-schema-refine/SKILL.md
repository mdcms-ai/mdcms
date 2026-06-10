---
name: mdcms-schema-refine
description: Use when the user wants to add, edit, extend, or fix MDCMS content types, fields, or references — phrases like "add a new content type", "register a new type with MDCMS", "create a content model", "make me an author type", "add a tags field to posts", "add a new field to my CMS", "link blog posts to authors", "edit mdcms.config.ts", "the inferred schema is wrong", "the schema is missing X", "change the schema", or "author the content model". Triggers on any intent to evolve the content schema, including localizing a type or adding a `fieldTypes.reference()` between types.
---

# MDCMS Schema Refine

Edit `mdcms.config.ts` to shape the content model and push the change to the server. This is the skill for post-init schema work — whether that's correcting a brownfield-inferred schema, extending a greenfield scaffold, or evolving a mature project.

## When to use this skill

- After **`mdcms-brownfield-init`** when the inferred schema needs corrections or additions.
- After **`mdcms-greenfield-init`** when the scaffolded `post` type is not enough for the real content model.
- Any time the user asks to add/edit a type, add/edit a field, or link two types via a reference.

Not for importing content, embedding Studio, or editing individual documents — those are different skills.

## Prerequisites

- A working `mdcms.config.ts` and a reachable MDCMS server (run **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** first if not).
- The user must be logged in for the target `(server, project, environment)`. `mdcms schema sync` writes to the server and fails with `401`/`unauthorized` otherwise. If `mdcms status` prints an auth error, run `mdcms login` (interactive) or set `MDCMS_API_KEY` (non-interactive) before continuing — see **`mdcms-content-sync-workflow`** Step 0 for full guidance.
- Read the current config before editing so you understand the shape you're changing.

## Core concepts

- **Type** — a content kind (e.g. `post`, `page`, `author`). Declared via `defineType(name, { directory, fields, ... })`.
- **Field** — a Zod validator attached to a frontmatter key. Typical shapes: `z.string().min(1)`, `z.number().optional()`, `z.boolean().default(false)`, `z.array(z.string())`, `z.enum([...])`.
- **Reference** — `fieldTypes.reference("<target-type>")` makes a field point to a document of another type. References are resolved by the SDK and surfaced in Studio as pickers.
- **Localized type** — `localized: true` on `defineType` makes every document live in multiple locale variants grouped by a shared translation group id.
- **Environment-scoped fields** — `.env("staging")` chained onto a Zod validator makes a field only apply in that environment. Use sparingly.

## Steps

### 1. Read the current config

```bash
cat mdcms.config.ts
```

Make sure you understand:

- What types exist and which directories they map to.
- Whether each type is localized.
- What references already link types together.

### 2. Make the edit

Edit `mdcms.config.ts`. Common patterns:

**Add a new type**

```ts
import { defineType, fieldTypes } from "@mdcms/cli";
import { z } from "zod";

const author = defineType("author", {
  directory: "content/authors",
  fields: {
    name: z.string().min(1),
    bio: z.string().optional(),
  },
});
```

Then add the new type to the `types: [...]` array passed to `defineConfig(...)`.

**Add a field to an existing type**

```ts
const post = defineType("post", {
  directory: "content/posts",
  fields: {
    title: z.string().min(1),
    slug: z.string().min(1),
    publishedAt: z.string().datetime().optional(), // new
    tags: z.array(z.string()).default([]), // new
  },
});
```

**Cross-reference two types**

```ts
const post = defineType("post", {
  directory: "content/posts",
  fields: {
    title: z.string().min(1),
    author: fieldTypes.reference("author").optional(),
  },
});
```

`fieldTypes.reference("author")` means the frontmatter value is an author document id. Studio renders a picker; the SDK can resolve the reference to the full document.

**Make a type localized**

```ts
const campaign = defineType("campaign", {
  directory: "content/campaigns",
  localized: true,
  fields: {
    title: z.string().min(1),
    summary: z.string().min(1),
  },
});
```

Localized types require the `locales` config at the root of `defineConfig(...)` to list the supported locales and the default.

### 3. Preview the impact

```bash
npx mdcms status
```

This shows local content vs server state and whether the schema is in sync. After a config edit it will say the schema is drifted.

### 4. Sync the schema to the server

```bash
npx mdcms schema sync
```

The server validates the new schema and either accepts it or rejects the change with a clear error (for example if a required field is added but existing documents don't satisfy it).

If the change is rejected:

- Make the new field optional, or
- Give it a `.default(...)`, or
- Plan a content migration before rerunning.

### 5. Verify

```bash
npx mdcms status
```

Expected: `schema: in sync`. Existing documents are unchanged on disk; they just now validate against the new schema.

Open Studio and confirm the new type/field appears in the document editor.

### 6. Author content (optional)

If the refinement added a new type, author the first document by either:

- Creating the file on disk and running `mdcms push`, or
- Adding it via Studio directly.

If the refinement added a new field to an existing type, go update the affected documents (locally via editor + `mdcms push`, or in Studio).

## Gotchas

- **Removing a field** is a schema-breaking change from the documents' perspective. The CLI surfaces the conflict; plan a migration (populate a default, then remove). Don't just delete it and hope.
- **Adding a required field to an existing type** without a `.default(...)` will fail schema sync if documents don't already have that frontmatter key. Use `.optional()` or `.default(...)`.
- **Renaming a type** is not a rename — it's a delete + create. Use the migration flow or keep the old name.
- **Reference targets must exist** — `fieldTypes.reference("author")` requires an `author` type declared in the same config.
- **Studio-visible labels** come from the type name. Use readable names (`author`, `blogPost`) over cryptic ones.

## Related skills

- **`mdcms-brownfield-init`** / **`mdcms-greenfield-init`** produce the initial config this skill refines.
- **`mdcms-content-sync-workflow`** covers how `pull`/`push` interacts with schema changes.
- **`mdcms-mdx-components`** covers registering custom MDX components (not a schema edit, but a sibling config concern).

## Assumptions and limitations

- Schema validators are Zod. The MDCMS CLI currently ships `defineType`, `defineConfig`, and `fieldTypes` from `@mdcms/cli` — verify that import path if the repo's packaging has changed.
- This skill does not write content migrations. For shape-breaking changes (required field, rename), hand off to the user or an MDCMS migration skill when it exists.
- Every schema change is pushed server-side; make one coherent edit per sync rather than batching many unrelated changes.
