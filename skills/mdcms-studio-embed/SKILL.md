---
name: mdcms-studio-embed
description: Use this skill when the user wants to embed the MDCMS Studio UI inside their own React/Next/Remix app, says things like "add the Studio to my app", "mount Studio at /admin", "give my editors a visual editor in the host app", "embed MDCMS editor", or similar. Gives the exact tested route files (server component with `prepareStudioConfig`, client component with `createStudioClientConfig` and `<Studio />`), how registered MDX components reach Studio, the `MDCMS_STUDIO_ALLOWED_ORIGINS` server setting, and how to verify sign-in and editing.
---

# MDCMS Studio Embed

Mount the MDCMS Studio UI inside the user's own host app so editors work alongside product code. The code in this skill is the tested setup; use it as written.

## When to use this skill

The user wants a Studio UI under their own domain (e.g. `app.example.com/admin/...`) instead of running Studio standalone. If they only need the API and use Studio at the server's own `/admin/studio` route, skip.

## Prerequisites

- A reachable MDCMS server and a working `mdcms.config.ts` (run **`mdcms-brownfield-init`** or **`mdcms-greenfield-init`** first).
- A React app, ideally Next.js App Router. Other frameworks work but need their own server/client split (see "Assumptions and limitations").
- A current `@mdcms/studio`: the code below imports `@mdcms/studio/client-config`. If that import does not resolve, update the package.

## Rule: prepare the config on the server with `prepareStudioConfig`

Studio only allows edits when it receives the **schema hash** of the project's schema. `prepareStudioConfig(config, { cwd })` from `@mdcms/studio/runtime` computes it on the server, where the full `mdcms.config.ts` (with its Zod schemas) is available. It also reads the props of each registered MDX component, so Studio can show a props form. `toSerializableStudioConfig` and `createStudioClientConfig` from `@mdcms/studio/client-config` carry both to the browser.

The schema hash is computed for the config's `environment`, which must be listed under `environments` in `mdcms.config.ts` (`mdcms init` writes `environments: { production: {} }` for you). Do not remove that entry.

Do **not** use `createStudioEmbedConfig` for an editing Studio, even if other docs or an older package README show it. It passes only `project`, `environment` and `serverUrl`, so Studio opens every document read-only with "Studio writes require a resolved schema for environment …".

## Steps

### 1. Install the Studio package in the host app

Use the project's package manager (look for `pnpm-lock.yaml`, `bun.lock`, `yarn.lock` or `package-lock.json`):

```bash
pnpm add @mdcms/studio
# or: npm install @mdcms/studio / bun add @mdcms/studio / yarn add @mdcms/studio
```

### 2. Add the catch-all route (Next.js App Router)

Create exactly these two files. Adjust only the relative imports of `mdcms.config` and `mdcms.components` if those files are not at the project root.

`app/admin/[[...path]]/page.tsx` (server component):

```tsx
import { toSerializableStudioConfig } from "@mdcms/studio/client-config";
import { prepareStudioConfig } from "@mdcms/studio/runtime";

import config from "../../../mdcms.config";
import { AdminStudioClient } from "./admin-studio-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  // Runs on the server, where the full config is available: computes the
  // schema hash that lets Studio write, and reads component props.
  const prepared = await prepareStudioConfig(config, { cwd: process.cwd() });

  return <AdminStudioClient config={toSerializableStudioConfig(prepared)} />;
}
```

`app/admin/[[...path]]/admin-studio-client.tsx` (client component):

```tsx
"use client";

import { useMemo } from "react";
import { Studio } from "@mdcms/studio";
import {
  createStudioClientConfig,
  type SerializableStudioConfig,
  type StudioComponentLoaderEntry,
} from "@mdcms/studio/client-config";

import { mdxComponents } from "../../../mdcms.components";

// Component loaders keyed by component name. Functions cannot be passed from
// a server component, so the client attaches them here.
const loaders: Record<string, StudioComponentLoaderEntry> = Object.fromEntries(
  mdxComponents.map((component) => [component.name, component.load]),
);

export function AdminStudioClient(props: { config: SerializableStudioConfig }) {
  // Build the config once per distinct value. The server sends a new props
  // object on every navigation inside /admin.
  const configKey = JSON.stringify(props.config);
  const config = useMemo(
    () =>
      createStudioClientConfig(
        JSON.parse(configKey) as SerializableStudioConfig,
        { loaders },
      ),
    [configKey],
  );

  return <Studio config={config} basePath="/admin" />;
}
```

`mdcms.components.ts` is the component list that `mdcms.config.ts` also uses (see **`mdcms-mdx-components`**). If the project registers no components yet, remove that import and use `const loaders: Record<string, StudioComponentLoaderEntry> = {};`.

Why it is split this way:

- `prepareStudioConfig` needs the full config (Zod schemas, component source files), so it runs on the server. `toSerializableStudioConfig` keeps only plain values: project, environment, server URL, locales, type names, the registered components with their extracted props, and the schema hash. Do not pass `prepared` itself to a client component.
- `createStudioClientConfig` adds what cannot cross the boundary: the `load` function of each component, looked up by component name. A `load` may return the component or its module (`() => import("./components/mdx/callout")`); Studio uses the module's default export, then the export named like the component. A loader entry can also be `{ load, loadPropsEditor }` for a component with a custom props editor. Components without a loader still appear in Studio, with a placeholder instead of a preview. For live preview, pass `previewUrlResolvers: { post: resolvePostPreviewUrl }` with the same functions as `resolvePreviewUrl` in the config.
- Build the client config once, as above (`useMemo` keyed by the serialized value, or at module scope). A new `config` object can make Studio reload its runtime and interrupt editing.
- `export const dynamic = "force-dynamic"` recomputes the hash on each request, so Studio picks up schema and component changes without a rebuild.
- `basePath` must match the route folder (`/admin` for `app/admin/[[...path]]`), and the folder name must be exactly `[[...path]]`.
- Studio brings its own chrome. Do not wrap the route in the site's navigation layout.

### 3. Allow the host app's origin on the MDCMS server

The server must list the host app's origin in `MDCMS_STUDIO_ALLOWED_ORIGINS`. Studio calls the server's API from the browser, and sign-in redirects the browser to the server and back to the host app; the server only accepts origins on this list:

```env
MDCMS_STUDIO_ALLOWED_ORIGINS=https://app.example.com,http://localhost:3000
```

Include every origin that embeds Studio (production, staging, the local dev port) and restart the server. If you cannot change the server's environment (for example a shared or hosted server), do not try to: tell the user which origin must be allowed and continue.

### 4. Verify sign-in and editing

1. Run the host app (`pnpm dev` or the framework equivalent) and open `http://localhost:3000/admin`.
2. Studio sends the browser to the MDCMS server's sign-in page. Sign in there; the browser returns to Studio's dashboard on the host app. No sign-in form is rendered by the host app itself.
3. Open a document. The editor must not show "Read-only". Edit some text and check that the top bar shows **Saved**.

If the editor is read-only, the page did not pass the schema hash: check that `page.tsx` calls `prepareStudioConfig`, that the config's `environment` is listed under `environments`, and that the client builds its config with `createStudioClientConfig`.

If the project registers MDX components, open a document, type `/` in the editor and check that each component is listed and previews with its real output.

### 5. Wire real-app live preview when requested

Live preview route mapping belongs on the content type as `resolvePreviewUrl`, not in frontmatter fields or hardcoded Studio routes. It is a function, so it does not reach the browser through `toSerializableStudioConfig`; put it in a small module that both the config and the Studio client component import:

```ts
// lib/preview-urls.ts
import type { MdcmsPreviewUrlResolver } from "@mdcms/cli";

export const resolvePostPreviewUrl: MdcmsPreviewUrlResolver = (document) => {
  const slug = document.frontmatter.slug;
  return typeof slug === "string" ? `/preview/post/${slug}` : undefined;
};
```

```ts
// mdcms.config.ts
const post = defineType("post", {
  directory: "content/posts",
  fields: {
    title: z.string().min(1),
    slug: z.string().min(1),
  },
  resolvePreviewUrl: resolvePostPreviewUrl,
});
```

```tsx
// app/admin/[[...path]]/admin-studio-client.tsx, inside useMemo
createStudioClientConfig(JSON.parse(configKey) as SerializableStudioConfig, {
  loaders,
  previewUrlResolvers: { post: resolvePostPreviewUrl },
});
```

If no resolver exists, Studio should show "Live preview not available" for that model. If a resolver returns a URL, Studio mints a short-lived `mdcms_preview_token` before loading the iframe. The host preview route should verify that token with `@mdcms/sdk` before using `draft: true` when unpublished content must remain private. After the framed preview page renders, send `window.parent.postMessage({ type: "mdcms:live-preview-ready" }, "*")`; Studio keeps the pane loading and then fails closed if that ready signal never arrives.

Set `MDCMS_PREVIEW_TOKEN_SECRET` on the MDCMS server and the host app to the same secret. The host route also needs a server-only API key with `content:read:draft`. Mark preview routes dynamic / no-store so draft renders do not reuse published caches.

## Common gotchas

- **Editor is read-only ("Studio writes require a resolved schema")**: the schema hash is missing. The page used `createStudioEmbedConfig`, built the config in a client component without `prepareStudioConfig`, or the config's `environment` is not listed under `environments`. Use the two files in step 2.
- **Registered components are missing from Studio**: the client config was built without the prepared `components` (for example by passing only `project`, `environment` and `serverUrl`). Pass `toSerializableStudioConfig(prepared)` and build the client config with `createStudioClientConfig`.
- **Component appears but shows a placeholder instead of a preview**: no loader for that name in the `loaders` map, or `load` resolves to something that is not a component. Names are case-sensitive.
- **Editor resets or inserts fail while editing**: the client component builds a new config on every render. Memoize it as in step 2.
- **Sign-in page says the link is not valid**: the host app's origin is not in `MDCMS_STUDIO_ALLOWED_ORIGINS` on the server (step 3).
- **Stale schema hash**: after a schema change Studio may reject writes until the page computes a new hash. `export const dynamic = "force-dynamic"` on the page avoids this; if you cache the prepared config, invalidate it after `mdcms schema sync` and when a component file changes.
- **Next.js layouts that add their own chrome**: Studio expects a minimal layout. Don't wrap Studio with site navigation; it has its own.
- **Preview route is public by accident**: `?preview=true` is only a mode flag. For private drafts, verify `mdcms_preview_token` or another server-side gate before fetching with `draft: true`.

## Related skills

- **`mdcms-self-host-setup`** — only if the user needs a server first.
- **`mdcms-mdx-components`**: registering components in `mdcms.components.ts`, which this skill's client component imports.
- **`mdcms-sdk-integration`** — Studio embed is independent of SDK fetching; they can both exist, or either one alone.

## Assumptions and limitations

- The code above is for Next.js App Router. React Router, Remix or Vite apps can embed Studio too: call `prepareStudioConfig` and `toSerializableStudioConfig` wherever server code runs (a loader or build step), send the result to the browser as JSON, and build the `<Studio />` config there with `createStudioClientConfig`.
- `prepareStudioConfig`, `toSerializableStudioConfig` and `createStudioClientConfig` are owned by `@mdcms/studio`. If its exports differ from this skill, follow the types in `node_modules/@mdcms/studio`, but keep the rule: the schema hash must come from `prepareStudioConfig` on the server.
- Does not cover SSO/OIDC provider configuration for Studio's login; that belongs with the MDCMS auth setup.
