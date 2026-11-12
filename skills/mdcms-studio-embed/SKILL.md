---
name: mdcms-studio-embed
description: Use this skill when the user wants to embed the MDCMS Studio UI inside their own React/Next/Remix app, says things like "add the Studio to my app", "mount Studio at /admin", "give my editors a visual editor in the host app", "embed MDCMS editor", or similar. Gives the exact tested route files (server component with `prepareStudioConfig`, client component with `<Studio />`), the `MDCMS_STUDIO_ALLOWED_ORIGINS` server setting, and how to verify sign-in and editing.
---

# MDCMS Studio Embed

Mount the MDCMS Studio UI inside the user's own host app so editors work alongside product code. The code in this skill is the tested setup; use it as written.

## When to use this skill

The user wants a Studio UI under their own domain (e.g. `app.example.com/admin/...`) instead of running Studio standalone. If they only need the API and use Studio at the server's own `/admin/studio` route, skip.

## Prerequisites

- A reachable MDCMS server and a working `mdcms.config.ts` (run **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** first).
- A React app, ideally Next.js App Router. Other frameworks work but need their own server/client split (see "Assumptions and limitations").

## Rule: prepare the config on the server with `prepareStudioConfig`

Studio only allows edits when it receives the **schema hash** of the project's schema. `prepareStudioConfig(config, { cwd })` from `@mdcms/studio/runtime` computes it on the server, where the full `mdcms.config.ts` (with its Zod schemas) is available.

Do **not** use `createStudioEmbedConfig` for an editing Studio, even if other docs or an older package README show it. It passes only `project`, `environment` and `serverUrl`, so Studio opens every document read-only with "Studio writes require a resolved schema for environment …".

## Steps

### 1. Install the Studio package in the host app

Use the project's package manager (look for `pnpm-lock.yaml`, `bun.lock`, `yarn.lock` or `package-lock.json`):

```bash
pnpm add @mdcms/studio
# or: npm install @mdcms/studio / bun add @mdcms/studio / yarn add @mdcms/studio
```

### 2. Add the catch-all route (Next.js App Router)

Create exactly these two files. Adjust only the relative import of `mdcms.config` if the config is not at the project root.

`app/admin/[[...path]]/page.tsx` (server component):

```tsx
import { prepareStudioConfig } from "@mdcms/studio/runtime";

import config from "../../../mdcms.config";
import { AdminStudioClient } from "./admin-studio-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Runs on the server, where the full schema is available. The schema hash
  // it computes is what lets Studio write to the project.
  const prepared = await prepareStudioConfig(config, { cwd: process.cwd() });

  return (
    <AdminStudioClient
      project={prepared.project}
      environment={prepared.environment}
      serverUrl={prepared.serverUrl}
      schemaHash={prepared._schemaHash}
      documentRouteMetadata={prepared._documentRouteMetadata}
    />
  );
}
```

`app/admin/[[...path]]/admin-studio-client.tsx` (client component):

```tsx
"use client";

import { Studio, type MdcmsConfig } from "@mdcms/studio";

export function AdminStudioClient(props: {
  project: string;
  environment: string;
  serverUrl: string;
  schemaHash?: string;
  documentRouteMetadata?: MdcmsConfig["_documentRouteMetadata"];
}) {
  const config = {
    project: props.project,
    environment: props.environment,
    serverUrl: props.serverUrl,
    ...(props.schemaHash ? { _schemaHash: props.schemaHash } : {}),
    ...(props.documentRouteMetadata
      ? { _documentRouteMetadata: props.documentRouteMetadata }
      : {}),
  } as MdcmsConfig;

  return <Studio config={config} basePath="/admin" />;
}
```

Why it is split this way:

- Only plain values cross from the server component to the client component. The full config holds Zod schemas and functions, which cannot be passed to a client component, so do not pass `prepared` itself.
- `export const dynamic = "force-dynamic"` recomputes the hash on each request, so Studio picks up schema changes without a rebuild.
- `basePath` must match the route folder (`/admin` for `app/admin/[[...path]]`), and the folder name must be exactly `[[...path]]`.
- Studio brings its own chrome. Do not wrap the route in the site's navigation layout.

If `mdcms.config.ts` registers MDX `components`, Studio also needs their metadata for prop editors and previews; follow **`mdcms-mdx-components`** after this skill.

### 3. Allow the host app's origin on the MDCMS server

The server must list the host app's origin in `MDCMS_STUDIO_ALLOWED_ORIGINS`, because Studio calls the server from the browser and signs in through a redirect back to the host:

```env
MDCMS_STUDIO_ALLOWED_ORIGINS=https://app.example.com,http://localhost:3000
```

Include every origin that embeds Studio (production, staging, the local dev port) and restart the server. If you cannot change the server's environment (for example a shared or hosted server), do not try to: tell the user which origin must be allowed and continue.

### 4. Verify sign-in and editing

1. Run the host app (`pnpm dev` or the framework equivalent) and open `http://localhost:3000/admin`.
2. Studio sends the browser to the MDCMS server's sign-in page. Sign in there; the browser returns to Studio's dashboard on the host app. No sign-in form is rendered by the host app itself.
3. Open a document. The editor must not show "Read-only". Edit some text and check that the top bar shows **Saved**.

If the editor is read-only, the page did not pass the schema hash: check that `page.tsx` calls `prepareStudioConfig` and that `_schemaHash` reaches `<Studio />`.

### 5. Wire real-app live preview when requested

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

If no resolver exists, Studio should show "Live preview not available" for that model. If a resolver returns a URL, Studio mints a short-lived `mdcms_preview_token` before loading the iframe. The host preview route should verify that token with `@mdcms/sdk` before using `draft: true` when unpublished content must remain private. After the framed preview page renders, send `window.parent.postMessage({ type: "mdcms:live-preview-ready" }, "*")`; Studio keeps the pane loading and then fails closed if that ready signal never arrives.

Set `MDCMS_PREVIEW_TOKEN_SECRET` on the MDCMS server and the host app to the same secret. The host route also needs a server-only API key with `content:read:draft`. Mark preview routes dynamic / no-store so draft renders do not reuse published caches.

## Common gotchas

- **Editor is read-only ("Studio writes require a resolved schema")**: the schema hash is missing. The page used `createStudioEmbedConfig`, built the config in a client component, or dropped `_schemaHash` on the way to `<Studio />`. Use the two files in step 2.
- **Sign-in page says the link is not valid**: the host app's origin is not in `MDCMS_STUDIO_ALLOWED_ORIGINS` on the server (step 3).
- **Stale schema hash**: after a schema change Studio may reject writes until the page computes a new hash. `export const dynamic = "force-dynamic"` on the page avoids this; if you cache the prepared config, invalidate it after `mdcms schema sync`.
- **Next.js layouts that add their own chrome**: Studio expects a minimal layout. Don't wrap Studio with site navigation; it has its own.
- **Preview route is public by accident**: `?preview=true` is only a mode flag. For private drafts, verify `mdcms_preview_token` or another server-side gate before fetching with `draft: true`.

## Related skills

- **`mdcms-self-host-setup`** — only if the user needs a server first.
- **`mdcms-mdx-components`** — if the content uses custom MDX components, those need to be registered so Studio can preview them.
- **`mdcms-sdk-integration`** — Studio embed is independent of SDK fetching; they can both exist, or either one alone.

## Assumptions and limitations

- The code above is for Next.js App Router. React Router, Remix or Vite apps can embed Studio too: call `prepareStudioConfig` wherever server code runs (a loader or build step) and pass the same plain fields to `<Studio />` in the browser.
- `prepareStudioConfig` and the client `MdcmsConfig` shape are owned by `@mdcms/studio`. If its exports differ from this skill, follow the types in `node_modules/@mdcms/studio`, but keep the rule: the schema hash must come from `prepareStudioConfig` on the server.
- Does not cover SSO/OIDC provider configuration for Studio's login; that belongs with the MDCMS auth setup.
