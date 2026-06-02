---
name: mdcms-studio-embed
description: Use this skill when the user wants to embed the MDCMS Studio UI inside their own React/Next/Remix app, says things like "add the Studio to my app", "mount Studio at /admin", "give my editors a visual editor in the host app", "embed MDCMS editor", or similar. Walks through installing `@mdcms/studio`, adding a catch-all route, wiring the prepared Studio config, setting `MDCMS_STUDIO_ALLOWED_ORIGINS` on the server, and verifying login.
---

# MDCMS Studio Embed

Mount the MDCMS Studio UI inside the user's own host app so editors work alongside product code. The canonical reference is `apps/studio-example` in the MDCMS repo — use it as the copy-from template for route structure, config preparation, and client bootstrap.

## When to use this skill

The user wants a Studio UI under their own domain (e.g. `app.example.com/admin/...`) instead of running Studio standalone. If they only need the API and use Studio at the server's own `/admin/studio` route, skip.

## Prerequisites

- A reachable MDCMS server and a working `mdcms.config.ts` (run **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** first).
- A React app, ideally Next.js App Router. Other frameworks work but the reference implementation is Next.
- Ability to set server-side env vars on the MDCMS backend (for `MDCMS_STUDIO_ALLOWED_ORIGINS`).

## Steps

### 1. Install the Studio package in the host app

```bash
npm install @mdcms/studio
# or: bun add @mdcms/studio
```

### 2. Add a catch-all route

Studio is a single page app embedded at a catch-all route. The reference uses `/admin/[[...path]]` so every Studio route is served from one Next page. Copy the pattern from `apps/studio-example/app/admin/[[...path]]` in the MDCMS repo:

```
app/
  admin/
    [[...path]]/
      page.tsx        # server component that prepares Studio config
      layout.tsx      # minimal layout (Studio brings its own chrome)
    admin-studio-client.tsx   # client wrapper that mounts <Studio />
    studio-config.ts          # prepareStudioConfig + client-serialized subset
```

The server component calls `prepareStudioConfig` from `@mdcms/studio/runtime` against the full `mdcms.config.ts`, extracts a client-safe subset (component metadata, schema hash, route metadata), and passes it to the client wrapper.

### 3. Wire the prepared config to `<Studio />`

The client wrapper uses the `<Studio />` component and the prepared config:

```tsx
"use client";
import { Studio } from "@mdcms/studio";
import type { MdcmsConfig } from "@mdcms/studio";

export function AdminStudioClient({ config }: { config: MdcmsConfig }) {
  return <Studio config={config} />;
}
```

Mirror the split the reference uses: the server component reads env + prepared config, the client wrapper renders Studio.

### 4. Set the host app env

The host app needs to know:

- The MDCMS server URL (so Studio's fetch calls resolve).
- Its own public URL (some flows need it for redirects).

Set these as either server env (Next: `process.env.MDCMS_SERVER_URL`) or `NEXT_PUBLIC_*` vars that are safe to expose to the browser, depending on where they're read. Follow the reference for the exact split — `apps/studio-example/lib/studio-example-studio-config.ts` shows a current, working pattern.

### 5. Allowlist the host app origin on the server

On the MDCMS server, update `.env` (or equivalent config) so the host app's origin is in the allowlist:

```env
MDCMS_STUDIO_ALLOWED_ORIGINS=https://app.example.com,http://localhost:3000
```

Without this, Studio's session/CSRF cookies won't be sent on cross-origin XHR requests and login will silently fail. Include every origin that embeds Studio (production, staging, localhost port).

Restart the server after updating the allowlist.

### 6. Verify login

1. Run the host app: `npm run dev` (or framework equivalent).
2. Open `http://localhost:3000/admin` (or whatever path the catch-all covers).
3. You should be redirected to the MDCMS login flow, and after logging in land on the Studio dashboard under the host app's URL.
4. Open a document. Edit a field. Save. Confirm the change appears in the MDCMS server when you run `mdcms pull` locally.

### 7. Wire real-app live preview when requested

Live preview route mapping belongs in `mdcms.config.ts` on the content type, not in frontmatter fields or hardcoded Studio routes:

```ts
const post = defineType("post", {
  directory: "content/posts",
  fields: {
    title: z.string().min(1),
    slug: z.string().min(1),
  },
  resolvePreviewUrl(document) {
    const slug = document.frontmatter.slug;
    return typeof slug === "string" ? `/preview/post/${slug}` : undefined;
  },
});
```

If no resolver exists, Studio should show "Live preview not available" for that model. If a resolver returns a URL, Studio mints a short-lived `mdcms_preview_token` before loading the iframe. The host preview route should verify that token with `@mdcms/sdk` before using `draft: true` when unpublished content must remain private.

Set `MDCMS_PREVIEW_TOKEN_SECRET` on the MDCMS server and the host app to the same secret. The host route also needs a server-only API key with `content:read:draft`. Mark preview routes dynamic / no-store so draft renders do not reuse published caches.

## Common gotchas

- **`127.0.0.1` vs `localhost`**: browser cookies treat them as different sites. Use `localhost` for local dev unless you have a specific reason to use `127.0.0.1` (and then add it to the allowlist).
- **Stale prepared config**: the prepared config includes a schema hash. After a schema change, redeploy the host app (or revalidate the server component that prepared the config) so the client carries the fresh hash. Otherwise Studio may reject writes.
- **Next.js layouts that add their own chrome**: Studio expects a minimal layout. The reference uses `apps/studio-example/app/admin/layout.tsx` which is mostly empty. Don't wrap Studio with site navigation — it has its own.
- **Auth cookie SameSite in dev**: if cookies aren't being sent on XHRs, check the server's cookie SameSite policy. The current contract is `SameSite=None` for Studio cookies, even on HTTP in local dev.
- **Preview route is public by accident**: `?preview=true` is only a mode flag. For private drafts, verify `mdcms_preview_token` or another server-side gate before fetching with `draft: true`.

## Related skills

- **`mdcms-self-host-setup`** — only if the user needs a server first.
- **`mdcms-mdx-components`** — if the content uses custom MDX components, those need to be registered so Studio can preview them.
- **`mdcms-sdk-integration`** — Studio embed is independent of SDK fetching; they can both exist, or either one alone.

## Assumptions and limitations

- Reference implementation is Next.js App Router. React Router, Remix, or Vite SPAs can embed Studio but need to adapt the server/client split themselves.
- `prepareStudioConfig` and the client `MdcmsConfig` shape are owned by `@mdcms/studio`; if the package surface changes, trust the source over this skill.
- Does not cover SSO/OIDC provider configuration for Studio's login — that belongs with the MDCMS auth setup.
- Copy the patterns from `apps/studio-example/app/admin/*` directly — file names, exports, and props evolve faster than this skill.
