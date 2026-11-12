---
name: mdcms-sdk-integration
description: Use this skill when the user wants to fetch MDCMS content from their React/Next/Remix app, says things like "render MDCMS content in my app", "replace my filesystem markdown with MDCMS", "use @mdcms/sdk to load posts", "SSR MDCMS content", "fetch drafts in preview mode", or similar. Covers both replacing an existing filesystem-based content layer (brownfield) and writing fresh fetching code (greenfield), plus drafts vs published, SSR patterns, and revalidation.
---

# MDCMS SDK Integration

Use `@mdcms/sdk` in the host app to fetch MDCMS content at build time or request time, replacing any filesystem-driven content layer, and supporting the draft/published split.

## When to use this skill

The user wants to consume MDCMS content programmatically from a host app — typically to render pages, build a blog index, or hydrate a CMS-driven section. Two sub-paths:

- **Brownfield (replace)** — the app currently imports markdown from the repo (`import about from "../content/about.md"`, `fs.readFile`, `remark`/`mdx-bundler`). Replace that with SDK calls.
- **Greenfield (write new)** — the app has no content-fetching code yet. Add it fresh.

Not for editing content (use Studio), not for schema changes (use `mdcms-schema-refine`), not for admin embedding (use `mdcms-studio-embed`).

## Prerequisites

- A running MDCMS server and content synced against a schema (via **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`**).
- A React-based host app with `mdcms.config.ts` at its root.
- An API key with `content:read` (add `content:read:draft` for drafts) that the host app reads at runtime from `MDCMS_API_KEY`. Never ship the API key to the browser.

## Steps

### 1. Install the SDK

Use the project's package manager. `server-only` makes the build fail if a client component imports the module that holds the API key:

```bash
pnpm add @mdcms/sdk server-only
# or: npm install / bun add / yarn add @mdcms/sdk server-only
```

### 2. Create the client

Build the client from `mdcms.config.ts`, which already holds `serverUrl`, `project` and `environment`. Read only the API key from the environment.

`lib/cms.ts`:

```ts
import "server-only";

import { createClient } from "@mdcms/sdk";
import { createMdcmsRenderer } from "@mdcms/sdk/react";

import config from "../mdcms.config";

const apiKey = process.env.MDCMS_API_KEY;

if (!apiKey) {
  throw new Error("MDCMS_API_KEY is not set.");
}

// Server URL, project and environment come from mdcms.config.ts; only the
// API key is a secret.
export const cms = createClient({
  serverUrl: config.serverUrl,
  project: config.project,
  environment: config.environment,
  apiKey,
});

// Renders document bodies with the components registered in mdcms.config.ts.
export const renderer = createMdcmsRenderer(config);
```

`mdcms.config.ts` imports `@mdcms/cli`, so keep `@mdcms/cli` installed wherever the app builds and runs.

If a deployment reads content from another environment than the config's default, pass `environment` per call (`cms.list("post", { environment: "staging" })`) or build a second client.

### 3. Know the document shape

`get` and `list` return `ContentDocumentResponse` documents. Import the type from `@mdcms/sdk`:

```ts
import type { ContentDocumentResponse } from "@mdcms/sdk";
```

The fields an app uses most:

| Field         | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `documentId`  | Stable id of this document (one locale variant). Use it for keys and `get({ id })`.     |
| `frontmatter` | All schema fields (`title`, `slug`, references, …) as `Record<string, unknown>`.        |
| `body`        | Markdown/MDX body. Render it with `renderer.render(document)`.                          |
| `type`        | Content type name.                                                                      |
| `path`        | Path of the document inside the project, for example `content/posts/hello-world`.       |
| `locale`      | Locale of this variant. Non-localized types use the reserved value `__mdcms_default__`. |
| `format`      | `"md"` or `"mdx"`; follows the body.                                                    |

There are no top-level `id`, `slug` or `title` fields: read them from `frontmatter`, and check their type because frontmatter values are `unknown`:

`lib/frontmatter.ts`:

```ts
import type { ContentDocumentResponse } from "@mdcms/sdk";

// Frontmatter values are typed as unknown; check them before rendering.
export function readString(
  document: ContentDocumentResponse,
  field: string,
): string | undefined {
  const value = document.frontmatter[field];
  return typeof value === "string" ? value : undefined;
}
```

### 4. Fetch content

`cms.get(type, input)` returns one document. `input` has either `id` or `slug`:

- `{ id }` fetches that document directly. The `type` argument is not checked against it. An unknown id (or, without `draft: true`, a document that was never published) throws `MdcmsApiError` with `statusCode` 404.
- `{ slug }` lists documents of `type` whose **`frontmatter.slug`** equals the value (after trimming), and returns the single match. It is not the document path, and the type needs a `slug` field. No match throws `MdcmsClientError` with code `NOT_FOUND`; more than one match throws code `AMBIGUOUS_RESULT`.

`cms.list(type, input)` returns `{ data, pagination }`: iterate `response.data` and use `response.pagination` (`total`, `limit`, `offset`, `hasMore`). The server returns 20 documents by default and at most 100 per call; page with `offset`.

**Locale.** `locale` is an exact filter on the stored locale of each document:

- Non-localized types store every document under `__mdcms_default__`. Omit `locale` for them. Passing `locale: "en"` matches nothing, so `get` by slug throws `NOT_FOUND` and `list` returns an empty page.
- Localized types store one document per locale. Pass the locale you want (`locale: "fr"`). Without it, `list` returns every locale variant, and `get` by slug throws `AMBIGUOUS_RESULT` when several locales share the slug.
- `get` by `id` ignores `locale`: an id already names one locale variant.

```ts
// Non-localized type: no locale
const post = await cms.get("post", { slug: "hello-world" });

// Localized type: pick the locale
const campaign = await cms.get("campaign", {
  slug: "spring-sale",
  locale: "fr",
});

// By id
const about = await cms.get("page", {
  id: "11111111-1111-4111-8111-111111111111",
});

// Newest posts first
const response = await cms.list("post", {
  limit: 20,
  sort: "createdAt",
  order: "desc",
});
```

**Render the body** with the renderer from `lib/cms.ts`. It compiles MDX when the body contains components and loads them through `config.components[].load` (see **`mdcms-mdx-components`**). It is server-only: do not import `@mdcms/sdk/react` from client components. MDX `import` and `export` lines are not supported; register components in `mdcms.config.ts` instead.

### 5. Draft vs published

By default the SDK returns **published** content. Preview/draft flows need an explicit opt-in:

```ts
const draft = await cms.get("page", { slug: "about", draft: true });
```

Patterns:

- **Production pages**: omit `draft` or pass `false`. Only published content ships; a document that was never published is not found.
- **Private preview routes** — gate `draft: true` behind `verifyMdcmsPreviewRequest()` or `cms.getPreviewDocumentFromRequest()`, a host session, or another server-side authorization check.
- **Public draft routes** — allowed when the project intentionally exposes drafts, for example on an internal network or low-sensitivity staging site. Make that decision explicit and do not present `?preview=true` as security.
- **In-development** — early in a project, drafts are often all you have. Pass `draft: true` everywhere until content is ready to publish.

First-class Studio live preview uses a short-lived `mdcms_preview_token`. Recommended private route:

```ts
export const dynamic = "force-dynamic";

const document = await cms.getPreviewDocumentFromRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});
```

For lower-level control:

```ts
import { verifyMdcmsPreviewRequest } from "@mdcms/sdk";

const preview = await verifyMdcmsPreviewRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});

if (preview.ok) {
  const document = await cms.get(preview.claims.type, {
    id: preview.claims.documentId,
    draft: true,
  });
}
```

Keep `MDCMS_API_KEY` / `MDCMS_PREVIEW_API_KEY` and `MDCMS_PREVIEW_TOKEN_SECRET` server-only. The preview API key needs `content:read:draft`. Preview responses should be uncached (`cache: "no-store"`, dynamic route rendering, and/or `Cache-Control: private, no-store`) so they do not reuse published ISR/static output.

When the route is used inside Studio live preview, send `window.parent.postMessage({ type: "mdcms:live-preview-ready" }, "*")` from client-side code after the draft page renders. Studio treats missing ready signals as preview failures and shows the fallback link instead of a blank iframe.

### 6. (Brownfield) replace the existing fetching

Typical before/after in a Next App Router page:

**Before**

```tsx
import fs from "node:fs/promises";
import path from "node:path";

const raw = await fs.readFile(
  path.join(process.cwd(), "content/pages/about.md"),
  "utf-8",
);
const about = parseMarkdown(raw);
```

**After**

```tsx
import { cms, renderer } from "@/lib/cms";

const about = await cms.get("page", { slug: "about" });
const body = await renderer.render(about);
```

`slug: "about"` matches `frontmatter.slug`, so the page type needs a `slug` field. If it has none, look the document up by `id`, or list the type and match `path`.

Delete the old markdown files from disk if they were imported into MDCMS (check `.gitignore` — `mdcms-brownfield-init` likely already added them), or keep them as a local cache if the app's build process benefits from that.

### 7. (Greenfield) add fresh fetching

A blog index and post page in Next.js App Router, using `lib/cms.ts` and `lib/frontmatter.ts` from steps 2 and 3. The `post` type here is not localized and has `title` and `slug` fields.

`app/blog/page.tsx`:

```tsx
import Link from "next/link";

import { cms } from "../../lib/cms";
import { readString } from "../../lib/frontmatter";

export default async function BlogIndex() {
  const { data: posts } = await cms.list("post", {
    limit: 50,
    sort: "createdAt",
    order: "desc",
  });

  return (
    <ul>
      {posts.map((post) => {
        const slug = readString(post, "slug");

        return slug ? (
          <li key={post.documentId}>
            <Link href={`/blog/${slug}`}>
              {readString(post, "title") ?? slug}
            </Link>
          </li>
        ) : null;
      })}
    </ul>
  );
}
```

`app/blog/[slug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { MdcmsClientError, type ContentDocumentResponse } from "@mdcms/sdk";

import { cms, renderer } from "../../../lib/cms";
import { readString } from "../../../lib/frontmatter";

async function getPost(slug: string): Promise<ContentDocumentResponse | null> {
  try {
    // Matches the post whose frontmatter `slug` equals this value.
    return await cms.get("post", { slug });
  } catch (error) {
    if (error instanceof MdcmsClientError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);

  if (!post) {
    notFound();
  }

  const body = await renderer.render(post);

  return (
    <article>
      <h1>{readString(post, "title")}</h1>
      {body}
    </article>
  );
}
```

### 8. Revalidation / caching

- **Next App Router** — `fetch` calls from the SDK inherit Next's default cache behavior. For frequently updating content, set `revalidate` on the route or tag-invalidate via `revalidateTag` on webhook. Follow Next's caching guide; the SDK does not override it.
- **Build-time static** — call the SDK inside `generateStaticParams`/`getStaticProps` (Pages Router). Content is frozen at build time; rebuild to pick up changes.
- **ISR + webhooks** — expose a revalidation endpoint in the host app; call it from an MDCMS webhook on publish. This is Post-MVP on the MDCMS side; design for it but gate behind a feature check.

## Common gotchas

- **API key leaks into the browser**: keep the client in a module that starts with `import "server-only";`. In Next, a `"use client"` file or a client component must not import `lib/cms.ts`.
- **Fields that do not exist**: documents have no `id`, `slug` or `title` at the top level. Use `documentId`, and read schema fields from `frontmatter`.
- **`get` needs `id` or `slug`, not `path`**: `slug` matches `frontmatter.slug`, not the document path. If you only have a path, call `list` with `path` (a prefix filter) and pick the exact match. Prefer `id` for stability across renames and slug changes.
- **`list` returns a paginated envelope** — iterate `response.data`, not `response` itself. The envelope also carries `response.pagination` for offset/total pagination.
- **Draft leaking to production** — if every page passes `draft: true`, unpublished content goes live. Route private preview behind a verified token/session, or document that the draft route is intentionally public.
- **Type vs type name** — `mdcms.config.ts` uses a string type name (`"post"`). The SDK call uses the same name; it is case-sensitive.
- **Empty results with `locale`**: `locale` filters on the stored locale. Documents of non-localized types are stored under `__mdcms_default__`, so `locale: "en"` finds nothing for them. Omit `locale` for non-localized types; pass it for localized ones.

## Related skills

- **`mdcms-mdx-components`** — if the content body is MDX with custom components, register them in `mdcms.config.ts` so Studio and `@mdcms/sdk/react` load the same components.
- **`mdcms-schema-refine`** — if the SDK types returned don't include a field the host needs.
- **`mdcms-content-sync-workflow`** — pair with this to understand when content is pushed vs pulled vs published.

## Assumptions and limitations

- `@mdcms/sdk` is the first-party client. If the codebase uses a hand-rolled `fetch` directly against the API, migrate to the SDK — contract stability lives there.
- Covers Next.js App Router as the reference target; adapt patterns for Pages Router, Remix, React Router, or a plain React SPA as needed.
- Does not cover custom resolvers or server-side data transformation pipelines — SDK reads return what the server returns; `@mdcms/sdk/react` only renders the returned body.
- Caching/revalidation examples use Next primitives; the SDK itself does not ship a cache layer.
