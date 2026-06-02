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
- A React-based host app.
- An API key that the host app can read at runtime. For server-side rendering, this is an env var (`MDCMS_API_KEY`). Never ship the API key to the browser.

## Steps

### 1. Install the SDK

```bash
npm install @mdcms/sdk
# or: bun add @mdcms/sdk
```

### 2. Create a client

In a server-only module (for Next: a file without `"use client"`, ideally under `lib/`):

```ts
import { createClient } from "@mdcms/sdk";

export const cms = createClient({
  serverUrl: process.env.MDCMS_SERVER_URL!,
  project: process.env.MDCMS_PROJECT!,
  environment: process.env.MDCMS_ENVIRONMENT!,
  apiKey: process.env.MDCMS_API_KEY!,
});
```

Keep the import path server-only. If the app leaks it into a client bundle, the API key ships to users.

### 3. Fetch content

The SDK exposes two read methods: `cms.get(type, input)` and `cms.list(type, input)`. Both accept `locale`, optional per-call `project`/`environment` overrides, and an optional `resolve` array for reference expansion.

**Fetch a single document by id or slug**

`get` requires either `id` (preferred — stable across renames) or `slug`. There is no `path` parameter on the SDK.

```ts
// By id (preferred when you already have it)
const about = await cms.get("page", { id: "doc_01HY…", locale: "en" });

// By slug (convenient for marketing/blog routes)
const post = await cms.get("post", { slug: "hello-world", locale: "en" });
```

`get` returns the document directly (unwrapped from the `{ data }` envelope).

**List documents of a type**

```ts
const response = await cms.list("post", {
  locale: "en",
  limit: 20,
  sort: "createdAt",
  order: "desc",
});

// response has shape { data: Document[], pagination: {...} }
for (const post of response.data) {
  // ...
}
```

`list` returns the full paginated envelope — iterate `response.data`, and use `response.pagination` for offset/total/hasMore.

Document return values include the frontmatter fields as declared in `mdcms.config.ts` plus the body. Use them directly in React, or use `@mdcms/sdk/react` to render the body on the server from the same config component registrations:

```tsx
import { createMdcmsRenderer } from "@mdcms/sdk/react";
import config from "../mdcms.config";

const renderer = createMdcmsRenderer(config);

export default async function AboutPage() {
  const about = await cms.get("page", { slug: "about", locale: "en" });
  const body = await renderer.render(about);

  return (
    <article>
      <h1>{about.title}</h1>
      {body}
    </article>
  );
}
```

The renderer is server-only. Do not import `@mdcms/sdk/react` from client components or browser bundles. MDX `import` and `export` syntax is not supported; register components in `mdcms.config.ts` and provide `load` functions there.

### 4. Draft vs published

By default the SDK returns **published** content. Preview/draft flows need an explicit opt-in:

```ts
const draft = await cms.get("page", {
  slug: "about",
  locale: "en",
  draft: true,
});
```

Patterns:

- **Production pages** — omit `draft` or pass `false`. Only published content ships.
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
const preview = await verifyMdcmsPreviewRequest(request, {
  secret: process.env.MDCMS_PREVIEW_TOKEN_SECRET!,
});

if (preview.ok) {
  const document = await cms.get(preview.claims.type, {
    id: preview.claims.documentId,
    locale: preview.claims.locale,
    draft: true,
  });
}
```

Keep `MDCMS_API_KEY` / `MDCMS_PREVIEW_API_KEY` and `MDCMS_PREVIEW_TOKEN_SECRET` server-only. The preview API key needs `content:read:draft`. Preview responses should be uncached (`cache: "no-store"`, dynamic route rendering, and/or `Cache-Control: private, no-store`) so they do not reuse published ISR/static output.

When the route is used inside Studio live preview, send `window.parent.postMessage({ type: "mdcms:live-preview-ready" }, "*")` from client-side code after the draft page renders. Studio treats missing ready signals as preview failures and shows the fallback link instead of a blank iframe.

### 5. (Brownfield) replace the existing fetching

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
import { cms } from "@/lib/cms";

const about = await cms.get("page", { slug: "about", locale: "en" });
```

Delete the old markdown files from disk if they were imported into MDCMS (check `.gitignore` — `mdcms-brownfield-init` likely already added them), or keep them as a local cache if the app's build process benefits from that.

### 6. (Greenfield) add fresh fetching

Generate the route tree from MDCMS. Example for a blog index + detail in Next:

```tsx
// app/blog/page.tsx
import { cms } from "@/lib/cms";
export default async function BlogIndex() {
  const response = await cms.list("post", { locale: "en", limit: 50 });
  return (
    <ul>
      {response.data.map((p) => (
        <li key={p.id}>
          <a href={`/blog/${p.slug}`}>{p.title}</a>
        </li>
      ))}
    </ul>
  );
}

// app/blog/[slug]/page.tsx
export default async function PostPage({ params }) {
  const post = await cms.get("post", {
    slug: params.slug,
    locale: "en",
  });
  return <article>{/* ... */}</article>;
}
```

### 7. Revalidation / caching

- **Next App Router** — `fetch` calls from the SDK inherit Next's default cache behavior. For frequently updating content, set `revalidate` on the route or tag-invalidate via `revalidateTag` on webhook. Follow Next's caching guide; the SDK does not override it.
- **Build-time static** — call the SDK inside `generateStaticParams`/`getStaticProps` (Pages Router). Content is frozen at build time; rebuild to pick up changes.
- **ISR + webhooks** — expose a revalidation endpoint in the host app; call it from an MDCMS webhook on publish. This is Post-MVP on the MDCMS side; design for it but gate behind a feature check.

## Common gotchas

- **API key leaks into the browser** — always import the SDK in server-only modules. In Next, a `"use client"` file or a client component must not import `@/lib/cms`.
- **`get` needs `id` or `slug`, not `path`** — the SDK does not take a document path. If you only have the local filesystem path, either look up the slug from frontmatter or issue a `list` with a filter. Prefer `id` for stability across rename/slug changes.
- **`list` returns a paginated envelope** — iterate `response.data`, not `response` itself. The envelope also carries `response.pagination` for offset/total pagination.
- **Draft leaking to production** — if every page passes `draft: true`, unpublished content goes live. Route private preview behind a verified token/session, or document that the draft route is intentionally public.
- **Type vs type name** — `mdcms.config.ts` uses a string type name (`"post"`). The SDK call uses the same name; it is case-sensitive.
- **Locale-aware fetches** — the SDK takes `locale` as an explicit argument on every `get`/`list` call. Pass it even for non-localized types so the caller stays explicit.

## Related skills

- **`mdcms-mdx-components`** — if the content body is MDX with custom components, register them in `mdcms.config.ts` so Studio and `@mdcms/sdk/react` load the same components.
- **`mdcms-schema-refine`** — if the SDK types returned don't include a field the host needs.
- **`mdcms-content-sync-workflow`** — pair with this to understand when content is pushed vs pulled vs published.

## Assumptions and limitations

- `@mdcms/sdk` is the first-party client. If the codebase uses a hand-rolled `fetch` directly against the API, migrate to the SDK — contract stability lives there.
- Covers Next.js App Router as the reference target; adapt patterns for Pages Router, Remix, React Router, or a plain React SPA as needed.
- Does not cover custom resolvers or server-side data transformation pipelines — SDK reads return what the server returns; `@mdcms/sdk/react` only renders the returned body.
- Caching/revalidation examples use Next primitives; the SDK itself does not ship a cache layer.
